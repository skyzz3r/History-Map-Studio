import { useEffect, useRef, useState } from "react";
import { loadIndex, yearAt } from "./borders.ts";
import {
  bindFocusChange,
  currentSourceId,
  drillInto,
  drillOut,
  getFocus,
  getScene,
  initMap,
  resetFocus,
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
import { metaFor, onEditsChange } from "./edits.ts";
import { toggleScene, type Scene } from "./view.ts";
import type { Key } from "./keyframes.ts";
import Timeline from "./components/Timeline.tsx";
import TopBar, { type Mode } from "./components/TopBar.tsx";
import RightRail from "./components/RightRail.tsx";
import DetailCard from "./components/DetailCard.tsx";
import Legend from "./components/Legend.tsx";
import SettingsPanel from "./components/SettingsPanel.tsx";
import StudioPanel from "./components/StudioPanel.tsx";
import EditorPanel from "./components/EditorPanel.tsx";

/**
 * The screen is divided, not layered.
 *
 * Every panel owns an edge and nothing floats over anything else: the top bar
 * spans the width, the sidebar is a docked column on the right, the mode panel
 * is a card on the left, and the timeline runs along the bottom between them.
 * Two CSS variables carry the two variable widths — `--rail` for the sidebar
 * and `--tl` for the timeline — so the legend, the scale bar and the
 * attribution can all be laid out against them instead of guessing.
 */
export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  // Everything else under the same click, so an overlapped polity stays reachable.
  const [others, setOthers] = useState<Picked[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const [mode, setMode] = useState<Mode>("explore");
  const [railOpen, setRailOpen] = useState(true);
  /** The sidebar's hierarchy disclosure, held here so the detail card's
   *  "Show hierarchy" can open it as well as the header inside the rail. */
  const [hierOpen, setHierOpen] = useState(true);
  const [tlShrunk, setTlShrunk] = useState(false);
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
        const snaps = await loadIndex();
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
  }, [mode]);

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

  return (
    <div
      className="relative h-dvh w-dvw overflow-hidden bg-neutral-950 text-neutral-100"
      style={
        {
          "--rail": railOpen ? "18rem" : "0rem",
          "--tl": tlShrunk ? "2.5rem" : "7rem",
        } as React.CSSProperties
      }
    >
      {/* Sized by #map in index.css, not Tailwind — see the comment there. */}
      <div ref={container} id="map" />

      <TopBar
        mode={mode}
        onMode={setMode}
        onSettings={() => setSettings(true)}
        onPicked={(p) => {
          setPicked(p);
          setOthers([]);
        }}
        error={error}
      />

      <RightRail
        open={railOpen}
        onOpen={setRailOpen}
        hierOpen={hierOpen}
        onHierOpen={setHierOpen}
        focus={focus}
      />

      {/* One card on the left, whatever the mode. Bounded top and bottom so it
          can never grow under the top bar or the timeline. */}
      <div
        className="pointer-events-none absolute left-3 top-16 z-10 flex items-start"
        // Stops above the scale bar, which shares this corner. 0.75rem cleared
        // the timeline but ran straight through the scale.
        style={{ bottom: "calc(var(--tl) + 2.25rem)" }}
      >
        {mode === "explore" && picked && (
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
            onShowHierarchy={() => {
              setRailOpen(true);
              setHierOpen(true);
            }}
            onClose={deselect}
          />
        )}
        {mode === "studio" && (
          <StudioPanel
            keys={keys}
            setKeys={setKeys}
            max={count - 1}
            scene={scene}
            onScene={setSceneState}
            picked={studioPick.p}
            placeAt={studioPick.at}
          />
        )}
        {mode === "edit" && (
          <EditorPanel picked={editing} onClose={() => setMode("explore")} />
        )}
      </div>

      {mode === "explore" && <Legend />}

      <Timeline max={count - 1} shrunk={tlShrunk} onShrink={setTlShrunk} />

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
