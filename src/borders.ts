// Historical-Basemaps: discrete year snapshots, no start/end dates on features.
// So "time" is an index into the snapshot list, not a linear year axis. Scrubbing
// between index 12 and 13 crossfades world_1492 -> world_1500.
// Bonus: this makes the slider spend its travel where the data is dense instead of
// burning 99% of it on prehistory (the range is -123000..2010).

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

/** Interpolated calendar year for the slider position, for display only. */
export function yearAt(index: number): number {
  if (!snapshots.length) return 0;
  const { a, b, t } = bracket(index);
  return Math.round(snapshots[a].year + (snapshots[b].year - snapshots[a].year) * t);
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

export type Label = { name: string; at: [number, number]; area: number };

/**
 * One label anchor per feature, for the always-on name layer.
 *
 * Anchors go on the feature's LARGEST ring, not the average of all its points —
 * averaging drops the USA's label in the Pacific between Alaska and Florida.
 * Area comes from the shoelace formula, which is signed, so take |A|; a zero-area
 * ring (a degenerate 4-point country, and this dataset has them) falls back to the
 * first vertex rather than dividing by zero.
 */
export function labelsFor(data: unknown): Label[] {
  const out: Label[] = [];
  for (const f of (data as any)?.features ?? []) {
    const name = f?.properties?.NAME;
    if (!name || !f.geometry) continue;
    const rings: number[][][] =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates[0]]
        : f.geometry.type === "MultiPolygon"
          ? f.geometry.coordinates.map((p: number[][][]) => p[0])
          : [];
    let best: number[][] | null = null;
    let bestArea = -1;
    for (const r of rings) {
      const a = Math.abs(ringArea(r));
      if (a > bestArea) [best, bestArea] = [r, a];
    }
    if (best) out.push({ name, at: centroid(best), area: bestArea });
  }
  return out;
}

function ringArea(r: number[][]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

function centroid(r: number[][]): [number, number] {
  const a = ringArea(r);
  if (!a) return [r[0][0], r[0][1]];
  let x = 0;
  let y = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const cross = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    x += (r[j][0] + r[i][0]) * cross;
    y += (r[j][1] + r[i][1]) * cross;
  }
  return [x / (6 * a), y / (6 * a)];
}

/** Stable colour per polity so an empire keeps its hue across snapshots. */
export function hueFor(name: string): [number, number, number] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const deg = Math.abs(h) % 360;
  return hslToRgb(deg, 0.55, 0.55);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}
