// Deterministic video export.
//
// The old path handed the live canvas to MediaRecorder, which samples in real
// time: any tile, label or flag that arrived late was recorded mid-load, and a
// slow machine produced a stuttering file. Nothing about the *content* differed
// — only how lucky the timing was.
//
// This renders offline instead. Each frame waits for the map to be genuinely
// ready, then is encoded with an EXPLICIT timestamp, so wall-clock time stops
// mattering. A frame that takes two seconds to settle costs two seconds of
// export and still occupies exactly 1/fps in the file. The output is identical
// on a fast machine and a throttled one.

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { download, labelsSettled, map, whenIdle } from "./map.ts";
import { applyIndex, settle } from "./scrub.ts";
import { duration, sampleCamera, type Key } from "./keyframes.ts";

export const canRenderOffline = () =>
  typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";

/** H.264 level must cover the frame size or configure() throws. */
function codecFor(width: number, height: number): string {
  const mb = Math.ceil(width / 16) * Math.ceil(height / 16);
  if (mb > 8192) return "avc1.640033"; // High 5.1 — 4K
  if (mb > 3600) return "avc1.640029"; // High 4.1 — 1440p
  return "avc1.640028"; // High 4.0 — 1080p
}

/**
 * Resolve when the map has nothing left to do.
 *
 * `idle` alone is not enough: our label rebuild and flag fetches are debounced
 * and run *after* it, so a frame captured on the first idle can be missing every
 * country name. Wait for both, and re-check, because loading flags dirties the
 * map and triggers another render pass.
 */
async function settled(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await whenIdle(Math.max(0, deadline - Date.now()));
    if (labelsSettled() && map.areTilesLoaded()) return;
    await sleep(120);
    // A permanently missing tile must not hang the export; better a frame that
    // is one tile short than a render that never finishes.
    if (Date.now() > deadline) {
      console.warn("frame did not settle within", timeoutMs, "ms");
      return;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RenderOpts = {
  keys: Key[];
  fps?: number;
  /** Target width in px; height follows the canvas aspect. 3840 = 4K. */
  width?: number;
  maxIndex: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

/**
 * Render the keyframe sequence to an MP4 and download it.
 * Returns the frame count actually written.
 */
export async function renderSequence({
  keys,
  fps = 30,
  width,
  maxIndex,
  onProgress,
  signal,
}: RenderOpts): Promise<number> {
  if (keys.length < 2) throw new Error("need at least two keyframes");
  if (!canRenderOffline()) throw new Error("WebCodecs unavailable");

  const canvas = map.getCanvas();
  const beforeRatio = map.getPixelRatio();
  // Same trick as the 4K PNG export: raise the drawing buffer itself rather
  // than upscaling a small canvas afterwards.
  if (width) map.setPixelRatio(width / canvas.clientWidth);
  await sleep(0);

  // H.264 requires even dimensions.
  const w = Math.floor(canvas.width / 2) * 2;
  const h = Math.floor(canvas.height / 2) * 2;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: w, height: h },
    fastStart: "in-memory",
  });

  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e),
  });
  encoder.configure({
    codec: codecFor(w, h),
    width: w,
    height: h,
    framerate: fps,
    bitrate: Math.min(60e6, Math.round(w * h * fps * 0.12)),
    // mp4-muxer needs length-prefixed AVCC, not Annex-B.
    avc: { format: "avc" },
  });

  const total = Math.max(1, Math.round(duration(keys) * fps));
  let written = 0;

  try {
    for (let i = 0; i < total && !signal?.aborted; i++) {
      const cam = sampleCamera(keys, i / fps);
      if (!cam) break;

      map.jumpTo({
        center: [cam.lng, cam.lat],
        zoom: cam.zoom,
        pitch: cam.pitch,
        bearing: cam.bearing,
      });
      applyIndex(Math.min(cam.index, maxIndex), true);
      settle(); // push the exact date to the GPU filter, unthrottled

      await settled();
      if (encodeError) throw encodeError;

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      // A keyframe every 2s keeps the file seekable in editors.
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      written++;
      onProgress?.(written, total);

      // Bound the queue, or a long sequence balloons memory.
      while (encoder.encodeQueueSize > 8) await sleep(10);
    }

    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    download(new Blob([target.buffer], { type: "video/mp4" }), "mp4");
    return written;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    map.setPixelRatio(beforeRatio);
  }
}
