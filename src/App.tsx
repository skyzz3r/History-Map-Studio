import { useEffect, useRef, useState } from "react";
import { loadIndex, yearAt } from "./borders.ts";
import {
  bindFocusChange,
  drillInto,
  drillOut,
  getFocus,
  initMap,
  resetFocus,
  setEditMode,
  type Picked,
} from "./map.ts";
import { applyIndex, getIndex } from "./scrub.ts";
import { lookup, lookupByQid, type Info } from "./wikidata.ts";
import { cachedTags, enTitleOf, fetchTags, qidOf } from "./ohm.ts";
import { initialFocus, type FocusState } from "./focus.ts";
import type { Key } from "./keyframes.ts";
import Timeline from "./components/Timeline.tsx";
import SideSheet from "./components/SideSheet.tsx";
import StudioBar from "./components/StudioBar.tsx";
import MapControls from "./components/MapControls.tsx";
import HierarchyPanel from "./components/HierarchyPanel.tsx";
import EditorPanel from "./components/EditorPanel.tsx";

export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  // Everything else under the same click, so an overlapped polity stays reachable.
  const [others, setOthers] = useState<Picked[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const [studio, setStudio] = useState(false);
  const [keys, setKeys] = useState<Key[]>([]);
  const [focus, setFocus] = useState<FocusState>(initialFocus);
  const [tree, setTree] = useState(true);
  const [editor, setEditor] = useState(false);
  /** What the editor is editing. Separate from `picked`, which drives the side
   *  sheet — in edit mode a click means "edit this", not "tell me about this". */
  const [editing, setEditing] = useState<Picked | null>(null);

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
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Edit mode reroutes clicks in map.ts: they select a region for editing
  // instead of opening the side sheet. Leaving it clears both, so an old
  // selection cannot be silently saved against.
  useEffect(() => {
    setEditMode(editor, setEditing);
    if (!editor) setEditing(null);
    else {
      setPicked(null);
      setOthers([]);
    }
  }, [editor]);

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
      if (!stale) setInfo(i);
    })();
    return () => {
      stale = true;
    };
  }, [picked]);

  return (
    <div className="relative h-dvh w-dvw overflow-hidden bg-neutral-950 text-neutral-100">
      {/* Sized by #map in index.css, not Tailwind — see the comment there. */}
      <div ref={container} id="map" />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 p-4">
        <h1 className="pointer-events-auto rounded-lg bg-neutral-900/80 px-3 py-1.5 text-sm font-medium tracking-tight backdrop-blur">
          Interactive History Map
        </h1>
        <button
          onClick={() => setStudio((s) => !s)}
          className="pointer-events-auto rounded-lg bg-neutral-900/80 px-3 py-1.5 text-sm backdrop-blur hover:bg-neutral-800"
        >
          {studio ? "Exploration" : "Studio"}
        </button>
        <button
          onClick={() => setEditor((e) => !e)}
          aria-pressed={editor}
          className={`pointer-events-auto rounded-lg px-3 py-1.5 text-sm backdrop-blur ${
            editor
              ? "bg-amber-500 font-medium text-neutral-900"
              : "bg-neutral-900/80 hover:bg-neutral-800"
          }`}
        >
          {editor ? "Editing" : "Edit borders"}
        </button>
        {error && (
          <span className="pointer-events-auto rounded-lg bg-red-950/90 px-3 py-1.5 text-sm text-red-200">
            {error}
          </span>
        )}
        {/* The breadcrumb lived here and was deleted: the hierarchy panel shows
            the same spine, with the tiers named and the children listed, and two
            controls carrying the same aria-label was its own bug. */}
        {!tree && (
          <button
            onClick={() => setTree(true)}
            className="pointer-events-auto rounded-lg bg-neutral-900/80 px-3 py-1.5 text-sm backdrop-blur hover:bg-neutral-800"
          >
            Hierarchy
          </button>
        )}
        <div className="ml-auto">
          <MapControls />
        </div>
      </header>

      {tree && (
        <div className="absolute left-4 top-20 z-10">
          <HierarchyPanel
            focus={focus}
            onJump={drillOut}
            onDrill={(n) =>
              void drillInto({
                osmId: n.osmId,
                name: n.name,
                adminLevel: n.adminLevel,
              })
            }
            onClose={() => setTree(false)}
          />
        </div>
      )}

      {editor && (
        <div className="absolute right-4 top-20 z-10">
          <EditorPanel picked={editing} onClose={() => setEditor(false)} />
        </div>
      )}

      {studio && <StudioBar keys={keys} setKeys={setKeys} max={count - 1} />}

      <Timeline max={count - 1} />

      {picked && !editor && (
        <SideSheet
          picked={picked}
          info={info}
          others={others}
          // Swapping to an overlapped polity keeps the rest of the stack
          // available, with the one you just left put back in it.
          onSelect={(p) => {
            setOthers([picked, ...others.filter((o) => o.osmId !== p.osmId)]);
            setPicked(p);
          }}
          onClose={deselect}
        />
      )}
    </div>
  );
}
