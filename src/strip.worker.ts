/// <reference lib="webworker" />
//
// The boolean difference, off the main thread.
//
// Nothing here decides anything — WHICH regions get subtracted is still decided
// in strip.ts on the main thread, because that needs the tile features and the
// hierarchy. This side only runs the clipper, which is the part that blocks:
// polygon-clipping is O(n log n) in segment count and a drawn country against
// the ocean set is millions of segments.

import { stripGeometry, type Feat } from "./strip.ts";

export type StripRequest = { id: number; drawn: unknown; targets: Feat[] };
export type StripReply =
  | { id: number; geometry: unknown }
  | { id: number; error: string };

self.onmessage = (e: MessageEvent<StripRequest>) => {
  const { id, drawn, targets } = e.data;
  try {
    self.postMessage({ id, geometry: stripGeometry(drawn, targets) } satisfies StripReply);
  } catch (err) {
    // stripGeometry already swallows the clipper's own throws; anything reaching
    // here is a worker-level failure and must not leave the caller hanging.
    self.postMessage({ id, error: String(err) } satisfies StripReply);
  }
};
