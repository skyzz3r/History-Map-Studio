import { useEffect, useRef, useState } from "react";
import { loadIndex, yearAt } from "./borders.ts";
import { initMap, type Picked } from "./map.ts";
import { applyIndex, getIndex } from "./scrub.ts";
import { lookup, lookupByQid, type Info } from "./wikidata.ts";
import { cachedTags, enTitleOf, fetchTags, qidOf } from "./ohm.ts";
import type { Key } from "./keyframes.ts";
import Timeline from "./components/Timeline.tsx";
import SideSheet from "./components/SideSheet.tsx";
import StudioBar from "./components/StudioBar.tsx";
import MapControls from "./components/MapControls.tsx";

export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [studio, setStudio] = useState(false);
  const [keys, setKeys] = useState<Key[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snaps = await loadIndex();
        if (cancelled) return;
        setCount(snaps.length);
        await initMap(container.current!, setPicked);
        if (cancelled) return;
        applyIndex(snaps.length - 1, true); // open on the present day
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      await fetchTags([picked.osmId]);
      if (stale) return;
      const tags = cachedTags(picked.osmId);
      const qid = qidOf(tags);
      const i = qid
        ? await lookupByQid(qid, year, picked.name, enTitleOf(tags))
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
        {error && (
          <span className="pointer-events-auto rounded-lg bg-red-950/90 px-3 py-1.5 text-sm text-red-200">
            {error}
          </span>
        )}
        <div className="ml-auto">
          <MapControls />
        </div>
      </header>

      {studio && <StudioBar keys={keys} setKeys={setKeys} max={count - 1} />}

      <Timeline max={count - 1} />

      {picked && (
        <SideSheet picked={picked} info={info} onClose={() => setPicked(null)} />
      )}
    </div>
  );
}
