import { useEffect, useRef, useState } from "react";
import { exportPng, map, startRecording } from "../map.ts";
import { canRenderOffline, renderSequence } from "../video.ts";
import { applyIndex, getIndex } from "../scrub.ts";
import { duration, play, type Camera, type Key } from "../keyframes.ts";
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
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [width, setWidth] = useState(1920);
  // Clear wipes every keyframe with no confirm; stash them so an accidental
  // Clear is one click to undo before the offer times out.
  const [cleared, setCleared] = useState<Key[] | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => stop.current?.(), []);
  const offline = canRenderOffline();

  const tick = (cam: Camera) => {
    map.jumpTo({
      center: [cam.lng, cam.lat],
      zoom: cam.zoom,
      pitch: cam.pitch,
      bearing: cam.bearing,
    });
    applyIndex(Math.min(cam.index, max), true); // time-travel is keyframed too
  };

  /**
   * Offline render: every frame waits for the map to actually be loaded before
   * it is encoded, so the file is identical on a fast connection and a throttled
   * one. This is the good path — `recordLive` only exists for browsers without
   * WebCodecs.
   */
  const render = async () => {
    if (keys.length < 2 || recording) return;
    setRecording(true);
    abort.current = new AbortController();
    try {
      const n = await renderSequence({
        keys,
        width,
        maxIndex: max,
        signal: abort.current.signal,
        onProgress: (d, t) => setProgress(`${d}/${t}`),
      });
      setProgress(`${n} frames`);
    } catch (e) {
      console.error(e);
      setProgress("Render failed — see console for details");
    } finally {
      setRecording(false);
      abort.current = null;
      setTimeout(() => setProgress(null), 4000);
    }
  };

  // Real-time capture. Records whatever is on screen, so a tile that loads late
  // lands in the file as a stutter — kept only where WebCodecs is missing.
  const recordLive = () => {
    if (keys.length < 2 || recording) return;
    setRecording(true);
    const finish = startRecording();
    setPlaying(true);
    stop.current = play(keys, tick, () => {
      setPlaying(false);
      finish().then(() => setRecording(false));
    });
  };

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
    stop.current = play(keys, tick, () => setPlaying(false));
  };

  return (
    <div className="absolute inset-x-0 bottom-28 mx-6 rounded-xl border border-neutral-800 bg-neutral-900/95 p-3 backdrop-blur">
      {/* Two jobs live in this bar — composing the fly-through (capture, preview,
          clear) and getting a file out (still, video). Labelling and dividing
          them stops the seven controls reading as one undifferentiated row. */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Compose
          </span>
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
            onClick={() => {
              if (!keys.length) return;
              setCleared(keys);
              setKeys([]);
              setTimeout(() => setCleared(null), 6000);
            }}
            disabled={!keys.length || recording}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-400 disabled:opacity-30 hover:bg-neutral-800"
          >
            Clear
          </button>
          {cleared && (
            <button
              onClick={() => {
                setKeys(cleared);
                setCleared(null);
              }}
              className="rounded-lg bg-amber-500/20 px-2.5 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-500/30"
            >
              Undo clear
            </button>
          )}
        </div>

        <div className="h-6 w-px shrink-0 bg-neutral-800" />

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Export
          </span>
          <button
            onClick={() => exportPng()}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
          >
            Export 4K PNG
          </button>
          <select
            value={width}
            onChange={(e) => setWidth(+e.target.value)}
            aria-label="Video resolution"
            disabled={recording}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200"
          >
            <option value={1280}>720p</option>
            <option value={1920}>1080p</option>
            <option value={2560}>1440p</option>
            <option value={3840}>4K</option>
          </select>
          <button
            onClick={offline ? render : recordLive}
            disabled={keys.length < 2 || recording || playing}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm text-red-300 disabled:opacity-30"
            title={
              offline
                ? "Renders frame by frame, waiting for every tile — output does not depend on connection speed"
                : "This browser lacks WebCodecs; falls back to real-time capture, which can stutter"
            }
          >
            {recording
              ? `Rendering… ${progress ?? ""}`
              : offline
                ? "Render video"
                : "Record video (live)"}
          </button>
          {recording && (
            <button
              onClick={() => abort.current?.abort()}
              className="rounded-lg px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800"
            >
              Cancel
            </button>
          )}
        </div>

        <span className="ml-auto font-mono text-xs text-neutral-500">
          {progress && !recording ? `${progress} · ` : ""}
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
