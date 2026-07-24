// Polygon anchor maths, shared by the browser and the CI tile pipeline.
//
// Both need the identical answer: scripts/prepare.mjs bakes one label point per
// feature into the tiles, and src/labels.ts computes the same thing at runtime
// for the GeoJSON sources that have no such layer. Two copies of this would
// drift and put a label in two different places depending on the source.

export type Ring = number[][];

/** Signed shoelace area. The sign encodes winding, so callers take |A|. */
export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

export function centroid(r: Ring): [number, number] {
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

/** Ray casting. Needed because a centroid can fall outside a concave country. */
export function inside(pt: number[], ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
    )
      hit = !hit;
  }
  return hit;
}

/**
 * A point guaranteed to be INSIDE the ring.
 *
 * Centroid when it lands inside — the common case, and the best-looking. When
 * it does not (crescents, horseshoes, anything wrapping a bay) fall back to the
 * midpoint of the widest interior span on the centroid's latitude. Full
 * polylabel would pick a marginally nicer spot for 5x the code.
 * ponytail: swap in polylabel only if some real polity looks visibly wrong.
 */
export function pointOnSurface(ring: Ring): [number, number] {
  const c = centroid(ring);
  if (inside(c, ring)) return c;

  const y = c[1];
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y) xs.push(xi + ((xj - xi) * (y - yi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let best: number | null = null;
  let span = -1;
  // After sorting, interior spans are the even-indexed pairs.
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1] - xs[i];
    if (w > span) [span, best] = [w, (xs[i] + xs[i + 1]) / 2];
  }
  return best === null ? c : [best, y];
}

/** Outer rings of a Polygon or MultiPolygon; [] for anything else. */
export function outerRings(g: any): Ring[] {
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates.slice(0, 1);
  if (g.type === "MultiPolygon") return g.coordinates.map((p: Ring[]) => p[0]);
  return [];
}

/**
 * One anchor per FEATURE, on its largest ring — not one per part.
 *
 * Largest, not averaged: averaging Alaska with the mainland drops the USA's
 * label in the Pacific. Largest also means France labels its mainland and
 * Corsica gets no separate label, which is the agreed behaviour.
 */
export function labelPoint(
  geometry: any,
): { at: [number, number]; area: number } | null {
  let best: Ring | null = null;
  let bestArea = -1;
  for (const r of outerRings(geometry)) {
    if (!r || r.length < 4) continue;
    const a = Math.abs(ringArea(r));
    if (a > bestArea) [bestArea, best] = [a, r];
  }
  if (!best) return null;
  return { at: pointOnSurface(best), area: bestArea };
}
