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

import type { Map as MLMap } from "maplibre-gl";
import { inside, outerRings, type Ring } from "./geo.ts";

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
 */
export function focusFilter(f: FocusState): any {
  const base: any = ["<=", ["coalesce", ["get", "admin_level"], 99], f.maxLevel];
  if (!f.allow) return base;
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

export type Bounds = {
  minlat: number;
  minlon: number;
  maxlat: number;
  maxlon: number;
};

/** Centre of a rendered feature, used to test containment against the parent. */
function centreOf(geom: any): [number, number] | null {
  let n = 0;
  let x = 0;
  let y = 0;
  const walk = (c: any) => {
    if (typeof c?.[0] === "number") {
      x += c[0];
      y += c[1];
      n++;
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geom?.coordinates);
  return n ? [x / n, y / n] : null;
}

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
 */
export function childIds(
  map: MLMap,
  layer: string,
  parentId: number,
  level: number,
): { ids: number[]; counts: Map<number, number> } {
  const none = { ids: [], counts: new Map<number, number>() };
  if (!map.getLayer(layer)) return none;
  const feats = map.queryRenderedFeatures({ layers: [layer] });

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
