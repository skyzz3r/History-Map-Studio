// De-facto control vs surviving de-jure claim.
//
// OHM models wartime occupation as two overlapping features at the SAME
// admin_level, neither of them tagged `disputed`. Measured at Lviv on
// 1942-01-01: `Deutsches Reich` (-2692712) and `Soviet Union` (-2851156) both
// cover the point, both admin_level 2. Stacking two translucent fills there
// destroys the border you actually want to see, and picking becomes a coin
// flip. (For contrast: every OHM relation tagged `disputed` — all 32 — is dead
// by 1942. This is not disputed tagging, it is honest modelling of occupation.)
//
// Two things have to be decided, and each needs its own evidence:
//
//  * DO they overlap? Answered by hit-testing sample points, not by geometry.
//    Tiles clip polygons to the viewport, so at zoom 6 both features are cut
//    down to roughly the screen rectangle and any "is A's anchor inside B"
//    test says yes in both directions. A rendered hit test is exact and cannot
//    be fooled by clipping — and it gets enclaves right for free, because OHM
//    cuts a hole for San Marino, so a point there never returns Italy.
//
//  * WHICH is the claim? The bigger polity. Clipped area cannot answer that
//    either, so the caller supplies a GLOBAL size (Overpass bounding boxes,
//    which src/ohm.ts already caches). A bbox is a terrible containment test
//    but a fine relative-size one: the Soviet Union's dwarfs the Reich's.

/**
 * Rough size of a bounding box, in square degrees.
 *
 * The wrap check is not defensive padding — it is the whole reason this is a
 * function. The Soviet Union's box runs minlon 20.9 to maxlon -169.0 across the
 * antimeridian, so a plain subtraction gives −8882 against the Deutsches
 * Reich's 208. That made the USSR "smaller", and the occupier got hatched while
 * the claim drew solid: exactly backwards.
 */
export function bboxArea(
  b: { minlon: number; maxlon: number; minlat: number; maxlat: number } | undefined,
): number {
  if (!b) return 0;
  const lon = b.maxlon < b.minlon ? b.maxlon + 360 - b.minlon : b.maxlon - b.minlon;
  return lon * Math.abs(b.maxlat - b.minlat);
}

/** The distinct features hit-tested at one screen point. */
export type Sample = { id: unknown; level: number }[];

/**
 * Sampled hits -> the ids to draw as de-jure claims.
 *
 * At each point, same-level features beyond the smallest are claims. An id with
 * no known size scores 0, so an unmeasured polity stays solid rather than being
 * hatched on a guess.
 */
export function claimsFrom(
  samples: Sample[],
  areaOf: (id: unknown) => number,
): unknown[] {
  const claims = new Map<string, unknown>();

  for (const hits of samples) {
    const byLevel = new Map<number, { id: unknown; area: number }[]>();
    for (const h of hits) {
      const list = byLevel.get(h.level) ?? [];
      if (!list.some((e) => String(e.id) === String(h.id)))
        list.push({ id: h.id, area: areaOf(h.id) || 0 });
      byLevel.set(h.level, list);
    }
    for (const list of byLevel.values()) {
      if (list.length < 2) continue;
      let keep = list[0];
      for (const e of list) if (e.area < keep.area) keep = e;
      for (const e of list)
        if (e !== keep) claims.set(String(e.id), e.id);
    }
  }
  return [...claims.values()];
}

/** Ids that share a sample point with another feature at their own level. */
export function overlappingIds(samples: Sample[]): unknown[] {
  const out = new Map<string, unknown>();
  for (const hits of samples) {
    const seen = new Map<number, Set<string>>();
    for (const h of hits) {
      const s = seen.get(h.level) ?? new Set<string>();
      s.add(String(h.id));
      seen.set(h.level, s);
    }
    for (const [lvl, s] of seen) {
      if (s.size < 2) continue;
      for (const h of hits) if (h.level === lvl) out.set(String(h.id), h.id);
    }
  }
  return [...out.values()];
}
