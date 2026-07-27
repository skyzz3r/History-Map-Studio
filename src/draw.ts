// A polygon tool, in about a hundred lines.
//
// No draw dependency: mapbox-gl-draw does not support MapLibre 5 without a fork,
// and everything needed here is click-to-place vertices over a GeoJSON source
// the map already knows how to render. Reshaping existing polygons is
// deliberately absent — the editor changes a region's FACTS (dates, level,
// parent) and can add or remove whole regions, which is what was asked for.

import type { Map as MLMap, MapMouseEvent } from "maplibre-gl";

export type Ring = [number, number][];

const SRC = "hist-draw";
const FILL = "draw-fill";
const LINE = "draw-line";
const DOTS = "draw-dots";

/**
 * Close a click sequence into a GeoJSON linear ring.
 *
 * Fewer than three points is not an area, and GeoJSON requires the ring to end
 * where it starts — a polygon that omits that closing point renders as a
 * triangle with a missing side in some engines and is rejected outright by
 * others.
 */
export function closeRing(pts: Ring): Ring | null {
  if (pts.length < 3) return null;
  const [f] = pts;
  const l = pts[pts.length - 1];
  return f[0] === l[0] && f[1] === l[1] ? [...pts] : [...pts, [f[0], f[1]]];
}

type Session = { cancel: () => void };

let current: Session | null = null;

/** Only one draw at a time; starting another cancels the first. */
export const drawing = () => !!current;
export const cancelDraw = () => current?.cancel();

/**
 * Click to place vertices. Enter or double-click closes, Backspace removes the
 * last point, Escape cancels. Resolves with a GeoJSON Polygon, or null.
 */
export function startPolygon(map: MLMap): Promise<any | null> {
  current?.cancel();

  return new Promise((resolve) => {
    const pts: Ring = [];
    let hover: [number, number] | null = null;

    ensureLayers(map);
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    // Or the first double-click to close would also zoom the map out from under
    // the shape being drawn.
    const hadDouble = map.doubleClickZoom.isEnabled();
    map.doubleClickZoom.disable();

    const paint = () => {
      // The rubber band: the ring as drawn so far, plus the cursor, so the edge
      // about to be committed is visible before the click.
      const live = hover ? [...pts, hover] : pts;
      const feats: any[] = [];
      if (live.length >= 2)
        feats.push({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: live },
        });
      if (live.length >= 3)
        feats.push({
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [[...live, live[0]]] },
        });
      for (const p of pts)
        feats.push({
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: p },
        });
      (map.getSource(SRC) as any)?.setData({
        type: "FeatureCollection",
        features: feats,
      });
    };

    const finish = (result: any | null) => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      map.off("dblclick", onDbl);
      document.removeEventListener("keydown", onKey);
      (map.getSource(SRC) as any)?.setData({
        type: "FeatureCollection",
        features: [],
      });
      map.getCanvas().style.cursor = prevCursor;
      if (hadDouble) map.doubleClickZoom.enable();
      current = null;
      resolve(result);
    };

    const close = () => {
      const ring = closeRing(pts);
      finish(ring ? { type: "Polygon", coordinates: [ring] } : null);
    };

    const onClick = (e: MapMouseEvent) => {
      pts.push([e.lngLat.lng, e.lngLat.lat]);
      paint();
    };
    const onMove = (e: MapMouseEvent) => {
      hover = [e.lngLat.lng, e.lngLat.lat];
      if (pts.length) paint();
    };
    const onDbl = (e: MapMouseEvent) => {
      e.preventDefault();
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return finish(null);
      if (e.key === "Enter") return close();
      if (e.key === "Backspace") {
        e.preventDefault();
        pts.pop();
        paint();
      }
    };

    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("dblclick", onDbl);
    document.addEventListener("keydown", onKey);
    current = { cancel: () => finish(null) };
  });
}

/** The scratch source and its three layers. Re-added after any setStyle. */
function ensureLayers(map: MLMap) {
  if (!map.getSource(SRC))
    map.addSource(SRC, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

  if (!map.getLayer(FILL))
    map.addLayer({
      id: FILL,
      type: "fill",
      source: SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#f59e0b", "fill-opacity": 0.25 },
    });
  if (!map.getLayer(LINE))
    map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#f59e0b", "line-width": 2, "line-dasharray": [2, 1] },
    });
  if (!map.getLayer(DOTS))
    map.addLayer({
      id: DOTS,
      type: "circle",
      source: SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 4,
        "circle-color": "#fbbf24",
        "circle-stroke-color": "#0a0a0a",
        "circle-stroke-width": 1.5,
      },
    });
}
