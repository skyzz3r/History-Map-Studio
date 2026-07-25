// Territory hierarchy.
//
// The problem: Germany and its provinces render on top of each other and
// hit-test together, so picking the smallest feature under the cursor always
// selected a province and the country itself was unreachable.
//
// The complication: OHM tiles carry `admin_level` but NO parent->child link.
// There is no "children of Germany" to look up. Containment has to be derived,
// and MapLibre filters cannot test geometry — so instead we resolve the child
// ids ONCE per drill-down (using bounds Overpass already returns alongside the
// wikidata tag) and filter to that explicit id list.

import { inside, labelPoint, outerRings, type Ring } from "./geo.ts";

export type Level = { osmId: number; name: string; adminLevel: number };

export type FocusState = {
  /** Root -> current. Empty means "countries only". */
  trail: Level[];
  /** Deepest admin_level currently drawn. */
  maxLevel: number;
  /** osm_ids allowed below level 2, or null for "no restriction". */
  allow: number[] | null;
};

/**
 * The level that represents "this polity's subdivisions".
 *
 * NOT the shallowest deeper level. Drilling into Prussia found exactly one
 * admin_level 3 feature (Neutral Moresnet, a tiny condominium) alongside its
 * dozen real level-4 provinces — taking the shallowest showed Moresnet alone
 * and hid every province. The tier with the most members is the subdivisions.
 *
 * `counts` is admin_level -> how many children carry it.
 */
export const nextLevel = (from: number, counts: Map<number, number>): number => {
  let best = from;
  let most = 0;
  for (const [lvl, n] of counts) {
    if (lvl <= from) continue;
    if (n > most || (n === most && lvl < best)) [most, best] = [n, lvl];
  }
  return best;
};

export const initialFocus = (): FocusState => ({
  trail: [],
  maxLevel: 2,
  allow: null,
});

/**
 * The layer filter for the current focus, combined with the date filter by the
 * caller. `allow` is an explicit id list rather than a geometric test because
 * MapLibre style expressions cannot ask "is this inside that polygon".
 *
 * `allow: []` and `allow: null` are NOT the same thing and the difference was a
 * real bug. `[]` means "children resolved, none of them qualify" and hides every
 * subdivision; `null` means "no restriction" and, paired with an opened
 * maxLevel, put every province on Earth on screen and under the cursor. Callers
 * must never substitute null for an empty result.
 */
export function focusFilter(f: FocusState): any {
  const base: any = ["<=", ["coalesce", ["get", "admin_level"], 99], f.maxLevel];
  if (f.allow === null || f.allow === undefined) return base;
  return [
    "all",
    base,
    [
      "any",
      // Countries stay visible so the focused polity keeps its context.
      ["<=", ["coalesce", ["get", "admin_level"], 99], 2],
      ["in", ["get", "osm_id"], ["literal", f.allow]],
    ],
  ];
}

/**
 * Union of the allow-list with newly-resolved ids.
 *
 * childIds only sees the VIEWPORT, so drilling into a country that does not fit
 * on screen resolved a partial set and panning east showed nothing — the rest of
 * its provinces were excluded forever. Merging each pass fixes that without ever
 * widening past the parent, since every pass still tests containment.
 */
export const mergeAllow = (prev: number[] | null, found: number[]): number[] =>
  prev ? [...new Set([...prev, ...found])] : [...new Set(found)];

export type Bounds = {
  minlat: number;
  minlon: number;
  maxlat: number;
  maxlon: number;
};

/**
 * The point used to test a child against its supposed parent.
 *
 * labelPoint, not an average of the coordinates. Averaging is what put
 * `Rakouské Slezsko` — an AUSTRIAN crownland — in the Kingdom of Prussia's
 * subdivisions: it has two lobes, and the mean of their vertices lands north of
 * both, inside Prussian Silesia. labelPoint returns a pole of inaccessibility on
 * the largest ring, which is guaranteed to be inside the child itself.
 */
const centreOf = (geom: any): [number, number] | null =>
  labelPoint(geom)?.at ?? null;

export const inBounds = (pt: [number, number], b: Bounds) =>
  pt[0] >= b.minlon && pt[0] <= b.maxlon && pt[1] >= b.minlat && pt[1] <= b.maxlat;

/**
 * Which rendered features are children of the focused one.
 *
 * Real point-in-polygon, not a bounding box. The bbox was tried first, since
 * Overpass hands it over for free — but Prussia's box reaches 55.9°N, so
 * drilling into Prussia listed Holbæk, Randers, Aarhus and other DANISH amts
 * among its provinces. A country's box routinely swallows its neighbours.
 *
 * The parent arrives as several tile-clipped pieces, so test against the union:
 * a child counts if its centre falls inside ANY piece.
 *
 * `feats` must come from querySourceFeatures, NOT queryRenderedFeatures. The
 * rendered set is already narrowed by the focus filter, so at maxLevel 2 the
 * subdivisions we are trying to discover are exactly the features that have been
 * filtered out — discovery could never succeed and the drill silently found
 * nothing. Source features ignore layer filters, so the date filter has to be
 * passed to querySourceFeatures by the caller instead.
 */
export function childIds(
  feats: { properties?: any; geometry?: any }[],
  parentId: number,
  level: number,
): { ids: number[]; counts: Map<number, number> } {
  const none = { ids: [], counts: new Map<number, number>() };

  const parent: Ring[] = [];
  for (const f of feats)
    if (Number(f.properties?.osm_id) === parentId)
      parent.push(...outerRings(f.geometry));
  if (!parent.length) return none;

  const ids = new Set<number>();
  const counts = new Map<number, number>();
  for (const f of feats) {
    const al = Number(f.properties?.admin_level);
    if (!Number.isFinite(al) || al <= level) continue;
    const c = centreOf(f.geometry);
    if (!c || !parent.some((r) => inside(c, r))) continue;
    const id = Number(f.properties?.osm_id);
    // Tile clipping means one province arrives as several features; count
    // distinct ids, or a fragmented province outvotes a whole tier.
    if (!ids.has(id)) counts.set(al, (counts.get(al) ?? 0) + 1);
    ids.add(id);
  }
  return { ids: [...ids], counts };
}
