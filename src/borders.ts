// Historical-Basemaps: discrete year snapshots, no start/end dates on features.
//
// Demoted to a BACKDROP. OpenHistoricalMap draws the borders you actually
// interact with, but its hosted tiles cannot serve below zoom 5, so these coarse
// snapshots are all that stands between you and a blank world view. Nothing here
// is ever hovered, clicked, or labelled — the polygons are as crude as 4 vertices
// per country and must not be the source of any claim.
//
// It still owns the time AXIS: "time" is an index into the snapshot list, which
// makes the slider spend its travel where the data is dense instead of burning
// 99% of it on prehistory (the range is -123000..2010).

const REPO =
  "https://raw.githubusercontent.com/aourednik/historical-basemaps/master";

export type Snapshot = { year: number; filename: string };

let snapshots: Snapshot[] = [];

export async function loadIndex(): Promise<Snapshot[]> {
  const r = await fetch(`${REPO}/index.json`);
  if (!r.ok) throw new Error(`index.json ${r.status}`);
  const j = (await r.json()) as { years: Snapshot[] };
  snapshots = j.years
    .map((y) => ({ year: y.year, filename: y.filename }))
    .sort((a, b) => a.year - b.year);
  return snapshots;
}

export const getSnapshots = () => snapshots;

/** Slider index (float) -> the two bracketing snapshots and the 0..1 blend. */
export function bracket(index: number, n = snapshots.length) {
  const i = Math.max(0, Math.min(n - 1, index));
  const a = Math.floor(i);
  const b = Math.min(n - 1, a + 1);
  return { a, b, t: i - a };
}

/**
 * Decimal year for a slider position. NOT rounded — the fraction is what gives
 * day-level precision, and it feeds the OHM date filter directly.
 *
 * The slider axis is piecewise-linear through the snapshot years rather than
 * linear in time, so it spends its travel where the data is instead of burning
 * 99% of the track on prehistory.
 */
export function yearAt(index: number): number {
  if (!snapshots.length) return 0;
  const { a, b, t } = bracket(index);
  return snapshots[a].year + (snapshots[b].year - snapshots[a].year) * t;
}

/** Nearest snapshot to a slider position. No blending — one era, or the other. */
export function nearestIndex(index: number): number {
  const { a, b, t } = bracket(index);
  return t < 0.5 ? a : b;
}

/** Inverse of yearAt: calendar year -> slider index. Lets you jump to an exact year. */
export function indexForYear(year: number): number {
  const last = snapshots.length - 1;
  if (last < 0) return 0;
  if (year <= snapshots[0].year) return 0;
  if (year >= snapshots[last].year) return last;
  let i = 0;
  while (i < last - 1 && snapshots[i + 1].year <= year) i++;
  const a = snapshots[i].year;
  const b = snapshots[i + 1].year;
  return i + (year - a) / (b - a);
}

export function formatYear(y: number): string {
  return y < 0 ? `${Math.abs(y).toLocaleString()} BC` : `AD ${y}`;
}

// ponytail: plain Map + FIFO evict. An LRU only matters if you thrash >12 eras,
// which one hand on a slider does not do.
const cache = new Map<number, unknown>();
const MAX = 12;

/** Cached snapshot or undefined — lets the scrub path stay synchronous on a hit. */
export const peek = (i: number) => cache.get(i);

export async function getSnapshot(i: number): Promise<unknown> {
  const hit = cache.get(i);
  if (hit) return hit;
  const snap = snapshots[i];
  if (!snap) throw new Error(`no snapshot at index ${i}`);
  const r = await fetch(`${REPO}/geojson/${snap.filename}`);
  if (!r.ok) throw new Error(`${snap.filename} ${r.status}`);
  const data = await r.json();
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(i, data);
  return data;
}

// Deleted with deck.gl: labelsFor / hueFor and their shoelace-centroid and
// HSL helpers. Labels now come from OHM via a MapLibre symbol layer, whose
// pole-of-inaccessibility placement and collision handling beat both.
