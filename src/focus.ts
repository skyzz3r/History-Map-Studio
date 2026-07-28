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

import { insideGeometry, labelPoint } from "./geo.ts";

/** `osmId` is not always numeric — see Picked.osmId in map.ts. */
export type Level = { osmId: number | string; name: string; adminLevel: number };

/**
 * The top of the hierarchy: supranational unions and colonial empires.
 *
 * Measured, not assumed — OHM really does model these at admin_level 1:
 * 807 relations carry it, including `European Union`, `British Empire`,
 * `English Empire` and `Confédération de Sénégambie`. Countries are level 2.
 *
 * This is what stops the world view being a soup: at 1900 the British Empire is
 * ONE polygon rather than it plus fifty member polygons drawn over each other.
 */
export const ROOT_LEVEL = 1;
export const COUNTRY_LEVEL = 2;

/**
 * Below this there is no polity, only artifacts.
 *
 * OHM's maritime limit ways — `12nm line - Turkey`, `3.2nm line - Russia`,
 * `6nm line - Greece` — carry `maritime=yes` and `type=boundary` but NO
 * admin_level (checked live: 39 of 40 have no `boundary` tag either). The
 * pipeline coerces a missing admin_level to 0, which passed every `<= maxLevel`
 * test and let them scribble across the oceans and steal labels.
 */
export const MIN_REAL_LEVEL = 1;

export type FocusState = {
  /** Root -> current. Empty means the world view. */
  trail: Level[];
  /** Deepest admin_level currently drawn. */
  maxLevel: number;
  /** osm_ids allowed below the tip's level, or null for "no restriction". */
  allow: (number | string)[] | null;
  /** Subdivisions of the tip, for the hierarchy diagram. Presentational only. */
  children: Level[];
  /**
   * Whether child resolution has finished for the current tip.
   *
   * Without it an empty `children` is ambiguous, and the panel announced "No
   * subdivisions recorded here" during the second or two between drilling into
   * the European Union and its 32 member states resolving — stating as fact the
   * opposite of what was about to appear.
   */
  resolved: boolean;
};

/**
 * The level that represents "this polity's subdivisions".
 *
 * The SHALLOWEST tier that is actually a tier — meaning it has more than one
 * member. Both halves of that rule come from a real failure:
 *
 *  - Plain "shallowest" broke on Prussia, which has exactly one admin_level 3
 *    feature (Neutral Moresnet, a tiny condominium) beside a dozen level-4
 *    provinces. It showed Moresnet alone and hid every province.
 *  - "Most members", which replaced it, broke on France: drilling in resolved
 *    189 level-8 COMMUNES (Bois-Grenier, Premesques, Ennetières-en-Weppes…)
 *    instead of its régions, because communes always outnumber régions. That is
 *    the same zone-soup complaint one tier further down, and it was caught by
 *    driving the live map rather than by any unit test.
 *
 * A tier of one is an oddity; the shallowest real tier is the subdivisions.
 *
 * `counts` is admin_level -> how many distinct children carry it.
 */
export const nextLevel = (from: number, counts: Map<number, number>): number => {
  const deeper = [...counts.entries()]
    .filter(([lvl]) => lvl > from)
    .sort((a, b) => a[0] - b[0]);
  if (!deeper.length) return from;
  return (deeper.find(([, n]) => n >= 2) ?? deeper[0])[0];
};

export const initialFocus = (): FocusState => ({
  trail: [],
  maxLevel: COUNTRY_LEVEL,
  allow: null,
  children: [],
  // The world view resolves nothing, so it is never "still looking".
  resolved: true,
});

/** The level whose siblings stay on screen as context. */
export const tipLevel = (f: FocusState): number =>
  f.trail[f.trail.length - 1]?.adminLevel ?? ROOT_LEVEL;

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
 *
 * `covered` is the world view's de-duplication: level-2 polities that sit inside
 * a level-1 empire or union, which that empire now stands in for. It applies
 * ONLY at the world view — drilling into the British Empire has to reveal
 * exactly those members again.
 */
export function focusFilter(
  f: FocusState,
  covered: (number | string)[] = [],
): any {
  const al: any = ["coalesce", ["get", "admin_level"], 0];
  // A real polity, not a maritime limit line. See MIN_REAL_LEVEL.
  const clauses: any[] = [
    [">=", al, MIN_REAL_LEVEL],
    ["<=", al, f.maxLevel],
  ];

  if (!f.trail.length) {
    if (covered.length)
      clauses.push([
        "any",
        ["<=", al, ROOT_LEVEL],
        ["!", ["in", ["get", "osm_id"], ["literal", covered]]],
      ]);
    return ["all", ...clauses];
  }

  if (f.allow === null || f.allow === undefined) return ["all", ...clauses];
  clauses.push([
    "any",
    // Siblings of the focused polity stay visible so it keeps its context.
    // This tracks the TIP's level rather than a hardcoded 2: drilling into an
    // empire must show other empires, not every country on Earth.
    ["<=", al, tipLevel(f)],
    ["in", ["get", "osm_id"], ["literal", f.allow]],
  ]);
  return ["all", ...clauses];
}

/**
 * Level-2 polities lying inside a level-1 union or empire.
 *
 * The world view hides these, so the British Empire draws as one shape instead
 * of one shape plus every colony inside it. Containment is a real
 * point-in-polygon on the child's label point — a bounding box would swallow
 * neighbours, exactly as it did when drilling into Prussia listed Danish amts.
 */
export function coveredIds(
  feats: { properties?: any; geometry?: any }[],
  /** child -> parent from user edits; see childIds. */
  parents?: Map<string, string>,
  /**
   * "Is an empire fill actually painted at this point on the rendered map?"
   * The geometry test below runs on TILE-CLIPPED source geometry: a tile piece
   * of an empire's outer ring can span a country whose hole lives in another
   * tile, so the country tests "inside" and loses its fill — while the RENDERED
   * empire keeps the hole and paints nothing there. That is the reported empty
   * France: covered by geometry, but no empire fill behind it. This predicate is
   * the truth of what the GPU actually drew; a candidate only counts as covered
   * when an empire really paints over it, so a hidden country is never a hole.
   * Omitted (node/tests) → geometry decides alone, the prior behaviour.
   */
  paints?: (centre: [number, number]) => boolean,
): number[] {
  const roots: any[] = [];
  const rootIds = new Set<string>();
  // Geometry per root, so an assigned child can be tested against ITS OWN empire
  // rather than any empire on screen.
  const rootGeom = new Map<string, any[]>();
  for (const f of feats)
    if (Number(f.properties?.admin_level) === ROOT_LEVEL && f.geometry) {
      roots.push(f.geometry);
      const rid = String(f.properties?.osm_id);
      rootIds.add(rid);
      (rootGeom.get(rid) ?? rootGeom.set(rid, []).get(rid)!).push(f.geometry);
    }
  if (!roots.length) return [];

  // Candidates first (geometry), then the paint guard, so a country is only
  // hidden when something is proven to draw over it.
  const cand: { id: number; centre: [number, number] }[] = [];
  for (const f of feats) {
    if (Number(f.properties?.admin_level) !== COUNTRY_LEVEL) continue;
    // An explicit parent settles WHICH empire, but not whether that empire
    // visually stands in for the child. Covering means "the empire's fill
    // already paints this ground, so hide the child underneath it." That only
    // holds where the empire polygon actually reaches the child: São Tomé and
    // mainland Portugal sit inside the Portuguese Empire, so they hide and the
    // empire shows through. A detached colony like the State of Brazil sits
    // OUTSIDE it — hiding that one paints nothing back, so it must stay drawn.
    // (Assigning it here was the reported "it wiped the region off".)
    const assigned = parents?.get(String(f.properties?.osm_id));
    if (assigned !== undefined) {
      if (!rootIds.has(assigned)) continue; // assigned below empire level: never covered
      const c = centreOf(f.geometry);
      const gs = rootGeom.get(assigned) ?? [];
      const id0 = Number(f.properties?.osm_id);
      if (c && gs.some((g) => insideGeometry(c, g)) && Number.isFinite(id0))
        cand.push({ id: id0, centre: c });
      continue;
    }
    const c = centreOf(f.geometry);
    // insideGeometry, NOT inside(outerRings): a union's polygon has HOLES where
    // non-members sit. Measured on live tiles, the outer-ring test reported
    // Switzerland, Liechtenstein and Andorra as covered by the European Union;
    // being hole-aware drops that to two.
    //
    // Andorra and Liechtenstein survive because OHM's EU relation genuinely has
    // no hole cut for either microstate, so no geometric test can tell they are
    // not members. They stay one drill-down away rather than being unreachable,
    // and fixing it properly means membership data this dataset does not carry.
    if (!c || !roots.some((g) => insideGeometry(c, g))) continue;
    const id = Number(f.properties?.osm_id);
    if (Number.isFinite(id)) cand.push({ id, centre: c });
  }

  const kept = paints ? cand.filter((x) => paints(x.centre)) : cand;
  return [...new Set(kept.map((x) => x.id))];
}

/**
 * Union of the allow-list with newly-resolved ids.
 *
 * childIds only sees the VIEWPORT, so drilling into a country that does not fit
 * on screen resolved a partial set and panning east showed nothing — the rest of
 * its provinces were excluded forever. Merging each pass fixes that without ever
 * widening past the parent, since every pass still tests containment.
 */
export const mergeAllow = (
  prev: (number | string)[] | null,
  found: (number | string)[],
): (number | string)[] =>
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
  parentId: number | string,
  level: number,
  /**
   * child osm_id -> parent osm_id, from user edits. An explicit parent BEATS
   * geometry: the map cannot tell that Andorra is not in the European Union
   * (OHM's relation has no hole for it), so saying so has to win outright.
   */
  parents?: Map<string, string>,
): { ids: (number | string)[]; counts: Map<number, number>; nodes: Level[] } {
  const none = { ids: [], counts: new Map<number, number>(), nodes: [] };

  // Hole-aware, same reason as coveredIds: drilling into the European Union
  // must not claim Switzerland as a member state.
  // Compared as strings: an added region's id is "edit-ohm-1" and a
  // Historical-Basemaps one is "hb-3", neither of which survives Number().
  const parent: any[] = [];
  for (const f of feats)
    if (String(f.properties?.osm_id) === String(parentId) && f.geometry)
      parent.push(f.geometry);
  // An explicit child list stands alone: the parent may be an added region with
  // no geometry among these features at all.
  const claimed = parents?.size
    ? new Set(
        [...parents.entries()]
          .filter(([, p]) => p === String(parentId))
          .map(([c]) => c),
      )
    : null;
  if (!parent.length && !claimed?.size) return none;

  const ids = new Set<number | string>();
  const counts = new Map<number, number>();
  const nodes: Level[] = [];
  for (const f of feats) {
    const al = Number(f.properties?.admin_level);
    // Artifacts have no admin_level; without this floor they counted as a tier
    // and could win nextLevel outright.
    if (!Number.isFinite(al) || al < MIN_REAL_LEVEL || al <= level) continue;
    const key = String(f.properties?.osm_id);
    const assigned = parents?.get(key);
    // Assigned elsewhere: it belongs to another parent and must not also show
    // up here, however its geometry falls.
    if (assigned !== undefined && assigned !== String(parentId)) continue;
    if (assigned === undefined) {
      const c = centreOf(f.geometry);
      if (!c || !parent.some((g) => insideGeometry(c, g))) continue;
    }
    const raw = f.properties?.osm_id;
    // Numeric where it can be, so the allow-list filter still matches the
    // numbers in the tiles; raw otherwise, for "hb-3" and drawn regions.
    const id = Number.isFinite(Number(raw)) ? Number(raw) : String(raw);
    // Tile clipping means one province arrives as several features; count
    // distinct ids, or a fragmented province outvotes a whole tier.
    if (!ids.has(id)) {
      counts.set(al, (counts.get(al) ?? 0) + 1);
      nodes.push({
        osmId: id,
        name: f.properties?.["name:en"] || f.properties?.name || "Unnamed",
        adminLevel: al,
      });
    }
    ids.add(id);
  }
  return { ids: [...ids], counts, nodes };
}
