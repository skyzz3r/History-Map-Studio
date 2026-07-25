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

/** Polygons as [outer, ...holes] lists; [] for anything that is not areal. */
export function polygons(g: any): Ring[][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}

/**
 * Point-in-geometry that RESPECTS HOLES.
 *
 * `inside(pt, outerRing)` is not enough here, and getting that wrong is not
 * cosmetic: San Marino's anchor sits inside Italy's outer ring, so an
 * outer-ring-only test reads every enclave as "one country covering another"
 * and would hatch Italy. OHM cuts a hole for the enclave, so honouring holes
 * separates a genuine enclave from a genuine overlapping claim.
 */
export function insideGeometry(pt: number[], g: any): boolean {
  for (const rings of polygons(g)) {
    if (!rings.length || !inside(pt, rings[0])) continue;
    if (rings.slice(1).some((h) => inside(pt, h))) continue; // in a hole
    return true;
  }
  return false;
}

/**
 * Douglas-Peucker, in degrees, iterative so a 100k-vertex coastline cannot
 * blow the stack.
 *
 * Why the tile pipeline needs this at all: the OHM planet's boundary subset
 * exports to 8.3 GB of GeoJSON for 203,705 features — about 1900 vertices each,
 * because historical borders follow coastlines at full OSM resolution.
 * tippecanoe then spends hours reordering that; measured, it reached 3% of the
 * reorder in two and a half hours. Its own per-zoom simplification happens
 * AFTER the reorder, so it cannot help with the cost of getting there.
 *
 * A tolerance below half a pixel at the target maxzoom is invisible: at z10 one
 * pixel is ~1.37e-3 degrees, so 5e-4 is roughly a third of a pixel.
 */
export function simplify(ring: Ring, tol: number): Ring {
  if (ring.length < 3) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const [ax, ay] = ring[lo];
    const [bx, by] = ring[hi];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let far = -1;
    let best = tol;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = ring[i];
      // Degenerate segment (a closed ring's endpoints coincide): fall back to
      // straight distance from the anchor, or every vertex collapses to one.
      const d = len
        ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len
        : Math.hypot(px - ax, py - ay);
      if (d > best) [best, far] = [d, i];
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([lo, far], [far, hi]);
  }

  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);

  // A CLOSED ring needs 4 positions to still be a ring, so hand back the
  // original rather than emit a polygon tippecanoe would reject. An open line
  // is perfectly valid with 2, and applying the ring rule to it returned the
  // full unsimplified input — which is the whole thing this exists to avoid.
  const closed =
    ring.length > 3 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const floor = closed ? 4 : 2;
  return out.length >= floor ? out : ring;
}

/** Total |area| of a feature's outer rings. Used to rank nested picks. */
export function featureArea(g: any): number {
  let a = 0;
  for (const r of outerRings(g)) if (r?.length >= 4) a += Math.abs(ringArea(r));
  return a;
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
