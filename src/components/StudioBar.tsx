import { useEffect, useRef, useState } from "react";
import { exportPng, map } from "../map.ts";
import { applyIndex, getIndex } from "../scrub.ts";
import { duration, play, type Key } from "../keyframes.ts";
import { formatYear, yearAt } from "../borders.ts";

export default function StudioBar({
  keys,
  setKeys,
  max,
}: {
  keys: Key[];
  setKeys: (k: Key[]) => void;
  max: number;
}) {
  const [playing, setPlaying] = useState(false);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const capture = () => {
    const c = map.getCenter();
    setKeys([
      ...keys,
      {
        t: keys.length * 3, // 3s between keys; drag-to-retime is the next feature
        lng: c.lng,
        lat: c.lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        index: getIndex(),
      },
    ]);
  };

  const run = () => {
    if (playing) {
      stop.current?.();
      return setPlaying(false);
    }
    if (keys.length < 2) return;
    setPlaying(true);
    stop.current = play(
      keys,
      (cam) => {
        map.jumpTo({
          center: [cam.lng, cam.lat],
          zoom: cam.zoom,
          pitch: cam.pitch,
          bearing: cam.bearing,
        });
        applyIndex(Math.min(cam.index, max), true); // time-travel is keyframed too
      },
      () => setPlaying(false),
    );
  };

  return (
    <div className="absolute inset-x-0 bottom-28 mx-6 rounded-xl border border-neutral-800 bg-neutral-900/95 p-3 backdrop-blur">
      <div className="flex items-center gap-2">
        <button
          onClick={capture}
          className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900"
        >
          Capture camera
        </button>
        <button
          onClick={run}
          disabled={keys.length < 2}
          className="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm disabled:opacity-30"
        >
          {playing ? "Stop" : "Play sequence"}
        </button>
        <button
          onClick={exportPng}
          className="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
        >
          Export PNG
        </button>
        <button
          onClick={() => setKeys([])}
          disabled={!keys.length}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-400 disabled:opacity-30 hover:bg-neutral-800"
        >
          Clear
        </button>
        <span className="ml-auto font-mono text-xs text-neutral-500">
          {keys.length} keys · {duration(keys).toFixed(1)}s
        </span>
      </div>

      {keys.length > 0 && (
        <ol className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {keys.map((k, i) => (
            <li
              key={i}
              className="shrink-0 rounded-lg border border-neutral-700 px-2.5 py-1.5 font-mono text-xs text-neutral-400"
            >
              <span className="text-neutral-200">{k.t}s</span> ·{" "}
              {formatYear(yearAt(k.index))} · z{k.zoom.toFixed(1)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
