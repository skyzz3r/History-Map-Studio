import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer } from "deck.gl";
import { hueFor } from "./borders.ts";

// Source Cooperative's mirror of the Protomaps planet, NOT build.protomaps.com.
// The build bucket only sends access-control-allow-origin for localhost origins, so
// it works in dev and silently fails the moment the site is deployed. This mirror
// sends `*`, and its URL is stable rather than dated. ~135GB, but range requests
// mean we only ever pull the bytes for visible tiles.
const BASEMAP =
  "pmtiles://https://data.source.coop/protomaps/openstreetmap/v4.pmtiles";

// The basemap is a backdrop for historical borders, so drop everything modern:
// roads, buildings, POIs, and — critically — present-day country boundaries and
// labels, which would contradict whatever era is on screen.
const CLUTTER =
  /^(roads|buildings|pois|address|boundaries|places_country|places_region|landuse_(urban|hospital|industrial|school|aerodrome|runway|pier|zoo|pedestrian))/;

export let map: maplibregl.Map;
let overlay: MapboxOverlay | null = null;

export type Picked = { name: string; subjectTo?: string; partOf?: string };

export async function initMap(
  container: HTMLDivElement,
  onPick: (p: Picked | null) => void,
): Promise<maplibregl.Map> {
  maplibregl.addProtocol("pmtiles", new Protocol().tile);

  const style: StyleSpecification = {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources: {
      protomaps: {
        type: "vector",
        url: BASEMAP,
        attribution: "© OpenStreetMap, Protomaps",
      },
    },
    layers: layers("protomaps", namedFlavor("dark"), { lang: "en" }).filter(
      (l) => !CLUTTER.test(l.id),
    ),
  };

  map = new maplibregl.Map({
    container,
    style,
    center: [12, 42],
    zoom: 3,
    // WebGL context creation attributes — preserveDrawingBuffer CANNOT be toggled at
    // runtime, so it is on permanently. Cost is one framebuffer copy; the alternative
    // is destroying and rebuilding the map every time someone exports a PNG.
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  });

  // Without this, a bad style or tile URL fails completely silently.
  map.on("error", (e) => console.error("maplibre:", e.error?.message ?? e));

  await map.once("load");

  map.on("click", (e) => {
    if (!overlay) return;
    const info = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 5 });
    const p = info?.object?.properties;
    onPick(p ? { name: p.NAME, subjectTo: p.SUBJECTO, partOf: p.PARTOF } : null);
  });

  new ResizeObserver(() => map.resize()).observe(container);
  return map;
}

/** Two stacked snapshots crossfading by `t`. Called at scrub rate — must stay cheap. */
export function setBorders(
  a: { index: number; data: unknown } | null,
  b: { index: number; data: unknown } | null,
  t: number,
) {
  const built = [
    a && border(a.index, a.data, 1 - t, t < 0.5),
    b && b.index !== a?.index ? border(b.index, b.data, t, t >= 0.5) : null,
  ].filter(Boolean);
  if (!built.length) return;

  // interleaved:true renders deck into MapLibre's own canvas, so PNG export is a
  // single toDataURL with no compositing step. But an interleaved overlay added
  // with `layers: []` never wires up its render pass — later setProps calls draw
  // nothing. So the overlay is created on the first real layer set, not at init.
  if (!overlay) {
    overlay = new MapboxOverlay({ interleaved: true, layers: built });
    map.addControl(overlay);
  } else {
    overlay.setProps({ layers: built });
  }
}

// Layer id is keyed to the snapshot, so scrubbing within a pair only changes
// `opacity` — deck reuses the tessellated buffers instead of rebuilding them.
function border(index: number, data: unknown, opacity: number, pickable: boolean) {
  return new GeoJsonLayer({
    id: `borders-${index}`,
    data: data as never,
    opacity,
    pickable,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 90],
    filled: true,
    stroked: true,
    // Optional chaining matters: GeoJSON permits `properties: null`, and one bad
    // feature in an accessor takes down the whole layer.
    getFillColor: (f: any) => [
      ...hueFor(f.properties?.SUBJECTO || f.properties?.NAME || ""),
      140,
    ],
    getLineColor: [235, 235, 245, 120],
    lineWidthMinPixels: 0.7,
  });
}

export function exportPng() {
  map.once("render", () => {
    map.getCanvas().toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `historical-map-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  });
  map.triggerRepaint();
}
