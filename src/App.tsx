import { useCallback, useEffect, useRef, useState } from "react";
import { loadIndex, yearAt } from "./borders.ts";
import {
  bindFocusChange,
  currentSourceId,
  getFocus,
  getScene,
  initMap,
  resetFocus,
  resizeMap,
  setEditMode,
  setScene,
  setSceneActive,
  setScenePick,
  type Picked,
} from "./map.ts";
import { applyIndex, getIndex } from "./scrub.ts";
import { lookup, lookupByQid, type Info } from "./wikidata.ts";
import { cachedTags, enTitleOf, fetchTags, qidOf } from "./ohm.ts";
import { initialFocus, type FocusState } from "./focus.ts";
import { hydrateEdits, metaFor, onEditsChange } from "./edits.ts";
import { hydrateAnnots } from "./annot.ts";
import { toggleScene, type Scene } from "./view.ts";
import type { Key } from "./keyframes.ts";
import Timeline from "./components/Timeline.tsx";
import TopBar, { type Mode } from "./components/TopBar.tsx";
import DockLayout, { useDock, type PanelId, type Rect } from "./components/Dock.tsx";
import { HierarchyTab, LayersPanel } from "./components/ViewPanels.tsx";
import DetailCard from "./components/DetailCard.tsx";
import Legend from "./components/Legend.tsx";
import SettingsPanel from "./components/SettingsPanel.tsx";
import StudioPanel from "./components/StudioPanel.tsx";
import EditorPanel from "./components/EditorPanel.tsx";

/**
 * The screen is tiled, not layered.
 *
 * Every panel is a tile in a docking workspace the user can resize, tab
 * together and close — including the map, which used to be the immovable
 * background everything else floated over. The one thing that did not move is
 * the map ELEMENT: it is created here, once, and merely repositioned to
 * wherever its tile currently is (see Dock.tsx). Putting it inside the layout
 * tree would remount a GL context on every drag.
 */
export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  // Everything else under the same click, so an overlapped polity stays reachable.
  const [others, setOthers] = useState<Picked[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const [mode, setMode] = useState<Mode>("explore");
  const [settings, setSettings] = useState(false);
  const [keys, setKeys] = useState<Key[]>([]);
  const [focus, setFocus] = useState<FocusState>(initialFocus);
  const [scene, setSceneState] = useState<Scene>(getScene);
  /** What the editor is editing. Separate from `picked`, which drives the
   *  detail card — in edit mode a click means "edit this", not "tell me about
   *  this". */
  const [editing, setEditing] = useState<Picked | null>(null);
  /** Bumped on any edit, so the detail card re-reads the user's corrections
   *  the moment they are saved instead of on the next click. */
  const [editRev, setEditRev] = useState(0);
  useEffect(() => onEditsChange(() => setEditRev((n) => n + 1)), []);
  /** The last Studio click, so a region card can be prefilled and anchored. */
  const [studioPick, setStudioPick] = useState<{
    p: Picked | null;
    at: [number, number] | null;
  }>({ p: null, at: null });

  const dock = useDock();
  const [mapRect, setMapRect] = useState<Rect | null>(null);
  /** The same box in workspace coordinates, for the overlays that belong to the
   *  map rather than to the page — the legend follows the map tile now. */
  const [mapBox, setMapBox] = useState<Rect | null>(null);
  // Stable, or MapHole tears down and re-observes on every App render.
  const onMapRect = useCallback((r: Rect | null) => setMapRect(r), []);

  /** Clearing the selection returns to the top of the hierarchy. */
  const deselect = () => {
    setPicked(null);
    setOthers([]);
    resetFocus();
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Both documents are read before the map is built, because every
        // synchronous reader below them (excludedIds, editFeatures, the
        // annotation compositor) assumes a complete document. See store.ts.
        const [snaps] = await Promise.all([loadIndex(), hydrateEdits(), hydrateAnnots()]);
        if (cancelled) return;
        setCount(snaps.length);
        bindFocusChange(setFocus);
        await initMap(container.current!, (p, rest) => {
          setPicked(p);
          setOthers(rest);
        });
        if (cancelled) return;
        setFocus(getFocus());
        applyIndex(snaps.length - 1, true); // open on the present day
      } catch (e) {
        console.error(e);
        setError("Couldn’t load the map data. Check your connection and reload.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Glue the map element to its tile. Hidden rather than unmounted when the
  // tile is gone: closing the Map panel must cost nothing to undo.
  useEffect(() => {
    const el = container.current;
    const host = area.current;
    if (!el || !host) return;
    if (!mapRect) {
      el.style.visibility = "hidden";
      setMapBox(null);
      return;
    }
    const h = host.getBoundingClientRect();
    const box = {
      left: Math.round(mapRect.left - h.left),
      top: Math.round(mapRect.top - h.top),
      width: Math.round(mapRect.width),
      height: Math.round(mapRect.height),
    };
    el.style.visibility = "visible";
    el.style.inset = "auto";
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    setMapBox(box);
    resizeMap();
  }, [mapRect]);

  // Each mode reroutes what a click MEANS, in map.ts. Leaving a mode clears
  // whatever it had armed, so an old selection cannot be silently acted on.
  useEffect(() => {
    const editing = mode === "edit";
    const studio = mode === "studio";
    setEditMode(editing, setEditing);
    setSceneActive(studio);
    setScenePick(
      studio
        ? (p, at) => {
            setStudioPick({ p, at });
            // A click on empty ocean is a deselect, not a scene change.
            if (p) setSceneState((s) => commitScene(toggleScene(s, p.osmId)));
          }
        : null,
    );
    if (!editing) setEditing(null);
    if (!studio) setStudioPick({ p: null, at: null });
    if (editing || studio) {
      setPicked(null);
      setOthers([]);
    }
    // The mode's own panel comes forward with it, and leaves with it. This is
    // the one place a mode and a tile are tied together: everything else in the
    // Window menu is the user's to open and close.
    if (editing) dock.show("edit");
    else dock.hide("edit");
    if (studio) dock.show("studio");
    else dock.hide("studio");
  }, [mode]);

  /**
   * Closing a tile means what leaving by the front door means.
   *
   * The panels lost their own ✕ when they became tiles — the tab has one, and
   * two on a card read as a bug. But the tab's ✕ only removed the panel: mode
   * stayed "edit" with no editor on screen, and a selection stayed selected
   * with nothing showing it. This is the other half of that button.
   *
   * Keyed on the CLOSE TRANSITION, not on "is it open": panels are absent for a
   * frame while they are being opened, and reacting to that would undo the mode
   * change that opened them.
   */
  const wasOpen = useRef<PanelId[]>([]);
  useEffect(() => {
    const closed = (id: PanelId) => wasOpen.current.includes(id) && !dock.isOpen(id);
    if (closed("edit") && mode === "edit") setMode("explore");
    if (closed("studio") && mode === "studio") setMode("explore");
    if (closed("details")) deselect();
    wasOpen.current = dock.open;
  }, [dock.open]);

  // Entity lookup is keyed to the polygon AND the year on screen when it was
  // clicked. The clicked OHM feature has a `wikidata` tag ~90% of the time, so
  // ask Overpass for it and resolve the exact Q-id; searching by name is only
  // the fallback, and searching by name is what used to return the wrong
  // country and the wrong century.
  useEffect(() => {
    setInfo(null);
    if (!picked?.name) return;
    let stale = false;
    (async () => {
      const year = yearAt(getIndex());
      // Our own tiles bake the wikidata tag in, so this costs nothing. Only the
      // hosted tiles, which drop it, need the Overpass round trip.
      let qid = picked.qid;
      let title = picked.wikipedia?.startsWith("en:")
        ? picked.wikipedia.slice(3)
        : undefined;
      // Only real OSM ids reach Overpass. A drawn region ("edit-ohm-1") or a
      // Historical-Basemaps feature ("hb-3") has nothing to look up, and asking
      // with NaN returned a confusing empty result rather than skipping.
      const nid = Number(picked.osmId);
      if (!qid && Number.isFinite(nid) && nid) {
        await fetchTags([nid]);
        if (stale) return;
        const tags = cachedTags(nid);
        qid = qidOf(tags);
        title = enTitleOf(tags);
      }
      const i = qid
        ? await lookupByQid(qid, year, picked.name, title)
        : await lookup(picked.name, year);
      // The user's own corrections win over whatever Wikidata returned. This is
      // the whole point of the editor's flag/arms/leader/population fields:
      // Wikidata is often right about the modern successor state and wrong
      // about the polity that actually existed in the year on screen.
      if (!stale) setInfo({ ...i, ...metaFor(currentSourceId(), picked.osmId) });
    })();
    return () => {
      stale = true;
    };
  }, [picked, editRev]);

  // A selection is only worth a panel when there is something selected, so the
  // Details tile comes forward on a click rather than sitting empty all session.
  useEffect(() => {
    if (picked && mode === "explore") dock.show("details");
  }, [picked]);

  const render = (id: PanelId) => {
    switch (id) {
      case "timeline":
        return <Timeline max={count - 1} />;
      case "layers":
        return <LayersPanel />;
      case "hierarchy":
        return <HierarchyTab focus={focus} />;
      // Each panel scrolls itself (`.panel` keeps max-h-full + overflow-y-auto),
      // so the tile wrapper is a plain full-height box. Padding lives on the
      // panel too — putting it here as well double-padded every one of them.
      case "details":
        return (
          <div className="h-full">
            {picked ? (
              <DetailCard
                picked={picked}
                info={info}
                others={others}
                // Swapping to an overlapped polity keeps the rest of the stack
                // available, with the one you just left put back in it.
                onSelect={(p) => {
                  setOthers([picked, ...others.filter((o) => o.osmId !== p.osmId)]);
                  setPicked(p);
                }}
                onShowHierarchy={() => dock.show("hierarchy")}
              />
            ) : (
              <p className="p-3 text-xs leading-snug text-neutral-500">
                Click a territory on the map to see who it was, when it existed
                and what it belonged to.
              </p>
            )}
          </div>
        );
      case "studio":
        return (
          <div className="h-full">
            <StudioPanel
              keys={keys}
              setKeys={setKeys}
              max={count - 1}
              scene={scene}
              onScene={setSceneState}
              picked={studioPick.p}
              placeAt={studioPick.at}
            />
          </div>
        );
      case "edit":
        return (
          <div className="h-full">
            <EditorPanel picked={editing} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className="flex h-dvh w-dvw flex-col overflow-hidden bg-neutral-950 text-neutral-100"
      // The map has its own tile now, so MapLibre's scale bar and attribution
      // sit inside it and need no clearance from the timeline or the sidebar.
      // index.css still reads these, so they are set to zero rather than removed.
      style={{ "--rail": "0px", "--tl": "0px" } as React.CSSProperties}
    >
      <TopBar
        mode={mode}
        onMode={setMode}
        onSettings={() => setSettings(true)}
        onPicked={(p) => {
          setPicked(p);
          setOthers([]);
        }}
        error={error}
        dock={dock}
      />

      <div ref={area} className="relative min-h-0 flex-1">
        {/* Mounted once, for the life of the session. Sized by the effect
            above, never by the layout engine. */}
        <div ref={container} id="map" />
        <div className="workspace absolute inset-0">
          <DockLayout dock={dock} render={render} onMapRect={onMapRect} />
        </div>
        {/* Anchored to the map tile, not the window: the legend explains the
            map's colours, so it must not drift over the hierarchy panel when
            the map is squeezed into a corner. */}
        {mode === "explore" && mapBox && (
          <div className="pointer-events-none absolute" style={mapBox}>
            <Legend />
          </div>
        )}
      </div>

      {settings && <SettingsPanel onClose={() => setSettings(false)} />}
    </div>
  );
}

/** Push a scene change to the map as well as to React. Written as a helper so
 *  the functional setState above stays a pure updater with one side effect in
 *  an obvious place. */
function commitScene(s: Scene): Scene {
  setScene(s);
  return s;
}
