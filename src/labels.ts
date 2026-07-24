// One label per polity, from whatever is on screen.
//
// The bug this exists to kill: France was labelled twice, once near Lyon and
// once near Paris. Nothing was wrong with the data. Vector tiles CLIP polygons
// at tile edges, so France arrives as several pieces and MapLibre labels each
// piece where it sits. Measured on a real tile: zero duplicate osm_ids inside
// one tile, has_label = 0 on all 980 features, and OHM's own centroids layer is
// worse still (Imperium Romanum appears 12 times in a single tile).
//
// The fix is to stop labelling a tiled source at all. Group the rendered pieces
// back together by osm_id, pick one anchor each, and hand the result to a plain
// GeoJSON source — which is never tiled, so it cannot duplicate anything.

import type { MapGeoJSONFeature } from "maplibre-gl";
import { labelPoint } from "./geo.ts";

export type LabelFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
};

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/**
 * Rendered features -> one point per polity.
 *
 * Accepts both shapes deliberately. Our own tiles ship a `labels` layer of
 * ready-made points (computed from unclipped geometry, so they are exact);
 * everything else supplies clipped polygons and gets the largest visible piece.
 * Same call site either way.
 */
export function buildLabelPoints(features: MapGeoJSONFeature[]): {
  type: "FeatureCollection";
  features: LabelFeature[];
} {
  // osm_id -> the best candidate seen so far.
  const best = new Map<string, { area: number; f: LabelFeature }>();

  for (const f of features) {
    const p = f.properties ?? {};
    const key = String(p.osm_id ?? p.name ?? "");
    if (!key || key === "undefined") continue;
    if (!p.name && !p["name:en"]) continue;

    let at: [number, number];
    // `rank` picks between pieces of the SAME polity; `area` is what
    // symbol-sort-key uses to rank DIFFERENT polities against each other.
    let rank: number;
    let area = Number(p.area) || 0;

    if (f.geometry?.type === "Point") {
      // Already one-per-polity, computed from unclipped geometry in the tile
      // pipeline. Always beats anything derived from a clipped polygon.
      at = (f.geometry as any).coordinates;
      rank = Infinity;
    } else {
      const lp = labelPoint(f.geometry);
      if (!lp) continue;
      at = lp.at;
      rank = lp.area;
      // Only fall back to the clipped area when the source carries no global
      // one; otherwise a country would be ranked by how much of it happens to
      // be on screen, and labels would reshuffle on every pan.
      if (!area) area = lp.area;
    }

    const prev = best.get(key);
    if (prev && prev.area >= rank) continue;

    best.set(key, {
      area: rank,
      f: {
        type: "Feature",
        geometry: { type: "Point", coordinates: at },
        properties: { ...p, area },
      },
    });
  }

  return { type: "FeatureCollection", features: [...best.values()].map((b) => b.f) };
}

export const emptyLabels = () => EMPTY;
