import { useEffect, useRef, useState } from "react";
import {
  armPlace,
  disarmPlace,
  exportPng,
  getAnnotLayer,
  map,
  setAnnotLayer,
  setScene,
  startRecording,
  type Picked,
} from "../map.ts";
import { canRenderOffline, renderSequence } from "../video.ts";
import { applyIndex, getIndex } from "../scrub.ts";
import { duration, play, type Camera, type Key } from "../keyframes.ts";
import { formatYear, yearAt } from "../borders.ts";
import {
  FONTS,
  addAnnot,
  annotsFor,
  isHidden,
  onAnnotsChange,
  readPicture,
  removeAnnot,
  setLayerHidden,
  swapLayers,
  updateAnnot,
  type Annot,
  type AnnotKind,
  type AnnotLayer,
} from "../annot.ts";
import { setSceneMode, toggleScene, type Scene } from "../view.ts";

/**
 * Studio: choose what is in the shot, annotate it, and get a file out.
 *
 * Two layers, exactly one live at a time, because the two outputs want
 * different annotations — a still can carry a dense caption that a moving
 * fly-through cannot. The layer also decides what Export means: the photo layer
 * makes images, the video layer makes video, and neither offers the other.
 */
export default function StudioPanel({
  keys,
  setKeys,
  max,
  scene,
  onScene,
  picked,
  placeAt,
}: {
  keys: Key[];
  setKeys: (k: Key[]) => void;
  max: number;
  scene: Scene;
  onScene: (s: Scene) => void;
  /** Whatever the map last clicked, for prefilling a region card. */
  picked: Picked | null;
  /** Where that click landed. */
  placeAt: [number, number] | null;
}) {
  const [layer, setLayer] = useState<AnnotLayer>(getAnnotLayer);
  const [sel, setSel] = useState<string | null>(null);
  const [, bump] = useState(0);
  useEffect(() => onAnnotsChange(() => bump((n) => n + 1)), []);

  const mine = annotsFor(layer);
  const active = mine.find((a) => a.id === sel) ?? null;

  const switchLayer = (l: AnnotLayer) => {
    setLayer(l);
    setAnnotLayer(l);
    setSel(null);
  };

  const centre = (): [number, number] => {
    const c = map.getCenter();
    return [c.lng, c.lat];
  };

  const add = (kind: AnnotKind) => {
    const at = kind === "region" && placeAt ? placeAt : centre();
    const a = addAnnot(layer, kind, at);
    if (kind === "region" && picked)
      updateAnnot(a.id, {
        text: picked.name,
        sub: [picked.startDate, picked.endDate].filter(Boolean).join(" – "),
      });
    setSel(a.id);
  };

  return (
    <section
      aria-label="Studio"
      className="panel pointer-events-auto flex max-h-full w-80 flex-col gap-3 overflow-y-auto p-3 text-sm"
    >
      <Layers active={layer} onActivate={switchLayer} />

      <ScenePicker scene={scene} onScene={onScene} picked={picked} />

      <Annotations
        layer={layer}
        list={mine}
        active={active}
        onSelect={setSel}
        onAdd={add}
      />

      {layer === "photo" ? (
        <PhotoExport />
      ) : (
        <VideoExport keys={keys} setKeys={setKeys} max={max} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const HOLD_MS = 450;

/**
 * The two export layers, as a layers panel rather than a pair of tabs.
 *
 * Three separate things live on one row and they are deliberately distinct
 * controls, because they answer different questions:
 *
 *   * the eye — is this layer DRAWN? Both can be, so a caption composed for the
 *     still can stay on screen while the fly-through is built beside it.
 *   * the name — is this the ACTIVE layer? That decides what a new annotation
 *     belongs to, and whether Export produces a PNG or an MP4.
 *   * press and hold — EXCHANGE the two layers. It is its own inverse, which is
 *     what makes it safe to put on a gesture: hold again and everything is back.
 */
function Layers({
  active,
  onActivate,
}: {
  active: AnnotLayer;
  onActivate: (l: AnnotLayer) => void;
}) {
  const [held, setHeld] = useState<AnnotLayer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const [, bump] = useState(0);
  useEffect(() => onAnnotsChange(() => bump((n) => n + 1)), []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = (l: AnnotLayer) => {
    fired.current = false;
    setHeld(l);
    timer.current = setTimeout(() => {
      fired.current = true;
      setHeld(null);
      swapLayers();
    }, HOLD_MS);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    setHeld(null);
  };
  /**
   * Activation lives on `click`, not on pointerup, so the row still works for a
   * keyboard, a screen reader, or anything else that dispatches a plain click —
   * pointer events only fire for an actual pointer. The hold is layered on top:
   * if it already swapped, the click that follows the release is swallowed.
   */
  const activate = (l: AnnotLayer) => {
    cancel();
    if (fired.current) {
      fired.current = false;
      return;
    }
    onActivate(l);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        Layers
      </span>
      {(["photo", "video"] as const).map((l) => {
        const off = isHidden(l);
        const count = annotsFor(l).length;
        return (
          <div key={l} className="flex items-center gap-1">
            <button
              onClick={() => setLayerHidden(l, !off)}
              aria-pressed={!off}
              aria-label={`${off ? "Show" : "Hide"} the ${l} layer`}
              title={`${off ? "Show" : "Hide"} the ${l} layer`}
              className={`shrink-0 rounded px-1.5 py-1 text-xs ${
                off ? "text-neutral-600 hover:text-neutral-300" : "text-neutral-200"
              }`}
            >
              {off ? "◌" : "◉"}
            </button>
            <button
              onPointerDown={() => start(l)}
              onPointerUp={cancel}
              onPointerLeave={cancel}
              onClick={() => activate(l)}
              aria-pressed={active === l}
              title={
                l === "photo"
                  ? "Stills — Export makes a PNG. Hold to swap the two layers."
                  : "Fly-throughs — Export makes an MP4. Hold to swap the two layers."
              }
              className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm capitalize transition-colors ${
                held === l
                  ? "bg-amber-500 text-neutral-900"
                  : active === l
                    ? "bg-neutral-100 font-medium text-neutral-900"
                    : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              } ${off ? "line-through opacity-60" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{l}</span>
              <span className="shrink-0 font-mono text-[10px] opacity-70">{count}</span>
            </button>
          </div>
        );
      })}
      <p className="text-[10px] leading-snug text-neutral-500">
        Click a layer to work on it · hold to swap the two · the dot hides one.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display selection
// ---------------------------------------------------------------------------

function ScenePicker({
  scene,
  onScene,
  picked,
}: {
  scene: Scene;
  onScene: (s: Scene) => void;
  picked: Picked | null;
}) {
  const apply = (s: Scene) => {
    onScene(s);
    setScene(s);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-neutral-800 pt-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        In the shot
      </span>
      {/* Start from everything or from nothing, then click territories on the
          map to add or remove them. Both directions matter: "the world minus
          three" and "only these three" are each a one-click start. */}
      <div className="flex gap-1">
        {(["all", "none"] as const).map((m) => (
          <button
            key={m}
            onClick={() => apply(setSceneMode(scene, m))}
            aria-pressed={scene.mode === m}
            className={`flex-1 rounded-md px-2 py-1 text-xs ${
              scene.mode === m
                ? "bg-neutral-100 font-medium text-neutral-900"
                : "bg-neutral-800 text-neutral-300"
            }`}
          >
            {m === "all" ? "Everything" : "Nothing"}
          </button>
        ))}
        <button
          onClick={() => apply({ ...scene, ids: [] })}
          disabled={!scene.ids.length}
          className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
        >
          Reset
        </button>
      </div>
      <p className="text-[11px] leading-snug text-neutral-400">
        {scene.ids.length === 0
          ? scene.mode === "all"
            ? "Everything is in. Click a territory to take it out."
            : "Nothing is in. Click a territory to put it in."
          : `${scene.ids.length} ${scene.mode === "all" ? "removed" : "added"} · click a territory to change it`}
        {picked && <span className="block text-neutral-500">Last click: {picked.name}</span>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

function Annotations({
  layer,
  list,
  active,
  onSelect,
  onAdd,
}: {
  layer: AnnotLayer;
  list: Annot[];
  active: Annot | null;
  onSelect: (id: string | null) => void;
  onAdd: (kind: AnnotKind) => void;
}) {
  const [placing, setPlacing] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Leaving the panel with a click still armed would swallow the next map click
  // somewhere else entirely.
  useEffect(() => () => disarmPlace(), []);

  const set = (patch: Partial<Annot>) => active && updateAnnot(active.id, patch);

  return (
    <div className="flex flex-col gap-1.5 border-t border-neutral-800 pt-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        Annotations · {layer} layer
      </span>
      <div className="flex flex-wrap gap-1">
        <button onClick={() => onAdd("text")} className="rounded-md bg-neutral-800 px-2 py-1 text-xs">
          + Label
        </button>
        <button onClick={() => onAdd("character")} className="rounded-md bg-neutral-800 px-2 py-1 text-xs">
          + Character
        </button>
        <button onClick={() => onAdd("region")} className="rounded-md bg-neutral-800 px-2 py-1 text-xs">
          + Region card
        </button>
      </div>

      {list.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-1">
              <button
                onClick={() => onSelect(active?.id === a.id ? null : a.id)}
                aria-pressed={active?.id === a.id}
                className={`min-w-0 flex-1 truncate rounded px-2 py-0.5 text-left text-xs ${
                  active?.id === a.id ? "bg-neutral-100/10 text-neutral-100" : "text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                {a.kind === "text" ? "🏷" : a.kind === "character" ? "👤" : "▤"} {a.text || "(empty)"}
              </button>
              <button
                onClick={() => {
                  removeAnnot(a.id);
                  if (active?.id === a.id) onSelect(null);
                }}
                aria-label={`Delete ${a.text}`}
                className="shrink-0 rounded px-1 text-xs text-red-300 hover:bg-neutral-800"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {active && (
        <div className="flex flex-col gap-1.5 rounded border border-neutral-800 p-2">
          <input
            value={active.text}
            onChange={(e) => set({ text: e.target.value })}
            aria-label="Label text"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
          />
          {active.kind !== "text" && (
            <input
              value={active.sub ?? ""}
              onChange={(e) => set({ sub: e.target.value })}
              placeholder="Second line"
              aria-label="Second line"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
            />
          )}

          <div className="flex items-center gap-1.5">
            <select
              value={active.font}
              onChange={(e) => set({ font: e.target.value })}
              aria-label="Font"
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-xs text-neutral-200"
            >
              {FONTS.map((f) => (
                <option key={f.label} value={f.css}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={8}
              max={96}
              value={active.size}
              onChange={(e) => set({ size: Number(e.target.value) || 8 })}
              aria-label="Font size"
              className="w-14 rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-xs text-neutral-200"
            />
            <input
              type="color"
              value={active.color}
              onChange={(e) => set({ color: e.target.value })}
              aria-label="Colour"
              className="h-7 w-8 rounded border border-neutral-700 bg-neutral-900"
            />
          </div>

          <label className="flex items-center gap-2 text-[11px] text-neutral-400">
            Opacity
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={active.opacity}
              onChange={(e) => set({ opacity: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-neutral-100"
            />
            <span className="w-8 text-right font-mono">{active.opacity.toFixed(2)}</span>
          </label>

          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => {
                if (placing) {
                  disarmPlace();
                  return setPlacing(false);
                }
                setPlacing(true);
                armPlace((at) => {
                  set({ at });
                  setPlacing(false);
                });
              }}
              className={`rounded-md px-2 py-1 text-xs ${
                placing ? "bg-amber-500 text-neutral-900" : "bg-neutral-800"
              }`}
            >
              {placing ? "Click the map…" : "Place"}
            </button>
            {active.kind === "character" && (
              <>
                <button
                  onClick={() => file.current?.click()}
                  className="rounded-md bg-neutral-800 px-2 py-1 text-xs"
                >
                  {active.image ? "Change picture" : "Add picture"}
                </button>
                <input
                  ref={file}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    try {
                      set({ image: await readPicture(f) });
                    } catch (err) {
                      console.error(err);
                      alert("That file could not be read as an image.");
                    }
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export — photo
// ---------------------------------------------------------------------------

const WIDTHS = [
  { w: 1280, label: "720p" },
  { w: 1920, label: "1080p" },
  { w: 2560, label: "1440p" },
  { w: 3840, label: "4K" },
];

function PhotoExport() {
  const [width, setWidth] = useState(3840);
  return (
    <div className="flex flex-col gap-1.5 border-t border-neutral-800 pt-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">Export still</span>
      <div className="flex gap-1.5">
        <select
          value={width}
          onChange={(e) => setWidth(+e.target.value)}
          aria-label="Image width"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        >
          {WIDTHS.map((o) => (
            <option key={o.w} value={o.w}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => exportPng(width)}
          className="flex-1 rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900"
        >
          Export PNG
        </button>
      </div>
      <p className="text-[11px] leading-snug text-neutral-400">
        Captures exactly what is on screen, at the chosen width.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export — video
// ---------------------------------------------------------------------------

function VideoExport({
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
    <div className="flex flex-col gap-1.5 border-t border-neutral-800 pt-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        Fly-through · {keys.length} keys · {duration(keys).toFixed(1)}s
      </span>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => {
            const c = map.getCenter();
            setKeys([
              ...keys,
              {
                t: keys.length * 3, // 3s between keys
                lng: c.lng,
                lat: c.lat,
                zoom: map.getZoom(),
                pitch: map.getPitch(),
                bearing: map.getBearing(),
                index: getIndex(),
              },
            ]);
          }}
          className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-900"
        >
          Capture camera
        </button>
        <button
          onClick={run}
          disabled={keys.length < 2}
          className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs disabled:opacity-30"
        >
          {playing ? "Stop" : "Preview"}
        </button>
        <button
          onClick={() => {
            if (!keys.length) return;
            setCleared(keys);
            setKeys([]);
            setTimeout(() => setCleared(null), 6000);
          }}
          disabled={!keys.length || recording}
          className="rounded-md px-2.5 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
        >
          Clear
        </button>
        {cleared && (
          <button
            onClick={() => {
              setKeys(cleared);
              setCleared(null);
            }}
            className="rounded-md bg-amber-500/20 px-2 py-1 text-xs font-medium text-amber-200"
          >
            Undo clear
          </button>
        )}
      </div>

      {keys.length > 0 && (
        <ol className="flex gap-1 overflow-x-auto pb-1">
          {keys.map((k, i) => (
            <li
              key={i}
              className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
            >
              <span className="text-neutral-200">{k.t}s</span> ·{" "}
              {formatYear(Math.round(yearAt(k.index)))} · z{k.zoom.toFixed(1)}
            </li>
          ))}
        </ol>
      )}

      <div className="flex gap-1.5">
        <select
          value={width}
          onChange={(e) => setWidth(+e.target.value)}
          aria-label="Video resolution"
          disabled={recording}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        >
          {WIDTHS.map((o) => (
            <option key={o.w} value={o.w}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          onClick={offline ? render : recordLive}
          disabled={keys.length < 2 || recording || playing}
          className="flex-1 rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-30"
          title={
            offline
              ? "Renders frame by frame, waiting for every tile — output does not depend on connection speed"
              : "This browser lacks WebCodecs; falls back to real-time capture, which can stutter"
          }
        >
          {recording ? `Rendering… ${progress ?? ""}` : offline ? "Render MP4" : "Record MP4 (live)"}
        </button>
        {recording && (
          <button
            onClick={() => abort.current?.abort()}
            className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          >
            Cancel
          </button>
        )}
      </div>
      {keys.length < 2 && (
        <p className="text-[11px] leading-snug text-neutral-400">
          Move the map, press Capture camera, move again, capture again. Two
          keys is a shot.
        </p>
      )}
      {progress && !recording && (
        <p className="text-[11px] text-neutral-400">{progress}</p>
      )}
    </div>
  );
}
