// "Strip existing states out of the region I just drew."
//
// Drawing a new polity by hand always overlapped its neighbours: you cannot
// trace a coastline and a dozen land borders by clicking, so the honest way to
// draw the Kingdom of Italy is to enclose the whole peninsula and then subtract
// whatever is already claimed. That subtraction is what this file does.
//
// WHICH regions get subtracted is the part that keeps the data clean, and it is
// not "everything on screen":
//
//   * SAME level — a country must not overlap another country.
//   * HIGHER in the hierarchy (a SMALLER admin_level) and NOT an ancestor — a
//     new country must not eat into a rival empire, but must be free to sit
//     inside its own parent empire, which is the whole point of naming a parent.
//   * DEEPER (a larger admin_level) is never subtracted. A country is supposed
//     to contain its own provinces; carving them out would leave a lace doily.
//
// The ancestor test is geometric rather than a lookup, because OHM tiles carry
// no parent->child link (see focus.ts): a higher-level region that CONTAINS the
// chosen parent is an ancestor of the new region too, so it is spared.

import polygonClipping from "polygon-clipping";
import { insideGeometry, labelPoint, polygons } from "./geo.ts";
import { MIN_REAL_LEVEL } from "./focus.ts";

export type Feat = { properties?: any; geometry?: any };

export type Box = [number, number, number, number];

/** Extent of a Polygon/MultiPolygon, or null when it has no rings. */
export function bboxOf(geom: any): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polygons(geom))
    for (const [x, y] of rings[0] ?? []) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

export const boxesOverlap = (a: Box, b: Box) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * Drop candidates whose extent cannot touch the drawn shape.
 *
 * Cheap, and it stopped being optional once oceans joined the target list: a
 * world view holds every ocean polygon on the planet, and handing all of them
 * to an exact boolean clipper to carve out one country-sized box is minutes of
 * work to reach the same answer.
 */
export function nearBox(feats: Feat[], box: Box | null): Feat[] {
  if (!box) return feats;
  return feats.filter((f) => {
    const b = bboxOf(f.geometry);
    return b ? boxesOverlap(box, b) : false;
  });
}

/**
 * The regions a newly drawn polity at `level` must be carved out of.
 *
 * `parentId` may be undefined — a top-level region has no parent to spare, so
 * every same-or-higher region qualifies.
 */
export function stripTargets(
  feats: Feat[],
  level: number,
  parentId?: string | number,
  /** The region being edited, so re-stripping never subtracts it from itself. */
  selfId?: string | number,
): Feat[] {
  const pid = parentId === undefined ? null : String(parentId);
  const sid = selfId === undefined ? null : String(selfId);

  // The parent's anchor point, for the ancestor test below. Taken from the
  // parent's own geometry when it is on screen; without it (an added region,
  // or one panned out of view) no candidate can be proven an ancestor and the
  // level rule stands alone.
  let parentPt: [number, number] | null = null;
  if (pid !== null)
    for (const f of feats)
      if (String(f.properties?.osm_id) === pid && f.geometry) {
        parentPt = labelPoint(f.geometry)?.at ?? null;
        if (parentPt) break;
      }

  const out: Feat[] = [];
  const seen = new Set<string>();
  for (const f of feats) {
    const id = String(f.properties?.osm_id ?? "");
    if (!id || id === "undefined" || id === pid || id === sid) continue;
    const al = Number(f.properties?.admin_level);
    if (!Number.isFinite(al) || al < MIN_REAL_LEVEL || al > level) continue;
    if (!polygons(f.geometry).length) continue;
    // An ancestor of the parent is an ancestor of the new region. Subtracting
    // it would carve the new region away entirely — the reported "strip deleted
    // my whole shape" when a country was drawn inside an empire.
    if (al < level && parentPt && insideGeometry(parentPt, f.geometry)) continue;
    // Tile clipping delivers one region as several features; all pieces are
    // kept (they subtract as a set) but the id is only reported once.
    if (!seen.has(id)) seen.add(id);
    out.push(f);
  }
  return out;
}

/** How many distinct regions `stripTargets` returned — for the editor's count. */
export const distinctIds = (feats: Feat[]): number =>
  new Set(feats.map((f) => String(f.properties?.osm_id))).size;

/**
 * `drawn` minus every target, as a Polygon or MultiPolygon.
 *
 * Returns null when nothing survives — the drawn area was entirely claimed
 * already. The caller reports that rather than saving an empty geometry, which
 * would render as nothing and read exactly like a silent failure.
 *
 * ponytail: subtracts what the tiles currently HOLD, so a target that is
 * off-screen at draw time is not subtracted. Same ceiling as geometryOf() in
 * map.ts; upgrade path is an Overpass `out geom` per candidate id.
 */
export function stripGeometry(drawn: any, targets: Feat[]): any | null {
  const subject = polygons(drawn);
  if (!subject.length) return null;
  const clips = nearBox(targets, bboxOf(drawn)).flatMap((f) => polygons(f.geometry));
  if (!clips.length) return drawn;

  let result: any;
  try {
    result = polygonClipping.difference(subject as never, clips as never);
  } catch (e) {
    // polygon-clipping throws on a few self-intersecting inputs. A failed strip
    // must leave the drawn shape intact rather than lose the user's work.
    console.warn("strip failed, keeping the drawn shape", e);
    return drawn;
  }
  if (!result?.length) return null;
  return result.length === 1
    ? { type: "Polygon", coordinates: result[0] }
    : { type: "MultiPolygon", coordinates: result };
}
