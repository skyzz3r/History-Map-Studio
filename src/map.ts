import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, TextLayer } from "deck.gl";
import { hueFor, labelsFor, type Label } from "./borders.ts";

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

// OpenHistoricalMap. Every feature carries its own start/end date, so we can
// render the true state on a given DAY instead of dissolving between snapshots.
// Point this at a self-hosted pmtiles:// URL if scripts/build-tiles.sh is run —
// nothing else changes.
const OHM_TILES = "https://vtiles.openhistoricalmap.org/boundaries/{z}/{x}/{y}";

// OHM's hosted tiles expose start_decdate/end_decdate; our own pipeline emits
// start_num/end_num. coalesce covers both so the source can be swapped freely.
// The sentinels matter: a boundary with no start has always existed and one
// with no end still exists, whereas null loses every numeric comparison and
// would silently erase the feature.
const dateFilter = (dec: number): any => [
  "all",
  ["<=", ["coalesce", ["get", "start_decdate"], ["get", "start_num"], -99999], dec],
  [">=", ["coalesce", ["get", "end_decdate"], ["get", "end_num"], 99999], dec],
];

const OHM_LAYERS = ["ohm-fill", "ohm-line"];

/** Show the boundaries valid on `dec`. Pure GPU filter — no data refetch. */
export function setOhmDate(dec: number) {
  if (!map?.getLayer("ohm-line")) return;
  const f = dateFilter(dec);
  for (const id of OHM_LAYERS) map.setFilter(id, f);
}

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
    // Without this the place layers ask for icons that do not exist and MapLibre
    // logs "Image townspot could not be loaded" on every tile.
    sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/dark",
    sources: {
      protomaps: {
        type: "vector",
        url: BASEMAP,
        attribution: "© OpenStreetMap, Protomaps",
      },
      // minzoom 5 is not cosmetic. OHM's hosted tiles carry ~40 name_*
      // localisations per feature with no per-zoom simplification, so a z3 tile
      // is 2.8-4 MB and times out; z6 is 175 KB and lands in ~100ms. Below z5
      // the coarse Historical-Basemaps fills carry the view instead.
      // Running scripts/build-tiles.sh drops those fields and would let this go
      // to 0.
      ohm: {
        type: "vector",
        tiles: [OHM_TILES],
        minzoom: 5,
        maxzoom: 12,
        attribution: "© OpenHistoricalMap",
      },
    },
    layers: [
      ...layers("protomaps", namedFlavor("dark"), { lang: "en" }).filter(
        (l) => !CLUTTER.test(l.id),
      ),
      // Starts filtered to nothing; setOhmDate supplies the real filter once a
      // date is set. admin_level 2 is national, 4 regional, higher is local.
      {
        id: "ohm-fill",
        type: "fill",
        source: "ohm",
        "source-layer": "boundaries",
        filter: dateFilter(-1e9),
        paint: {
          "fill-color": [
            "case",
            ["has", "disputed_by"], "#d97706",
            ["==", ["get", "admin_level"], 2], "#e5e7eb",
            "#94a3b8",
          ],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.04, 8, 0.1],
        },
      },
      {
        id: "ohm-line",
        type: "line",
        source: "ohm",
        "source-layer": "boundaries",
        filter: dateFilter(-1e9),
        paint: {
          "line-color": [
            "case",
            ["has", "disputed_by"], "#f59e0b",
            ["==", ["get", "admin_level"], 2], "#f8fafc",
            "#cbd5e1",
          ],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            3, ["case", ["==", ["get", "admin_level"], 2], 1.1, 0.4],
            10, ["case", ["==", ["get", "admin_level"], 2], 2.4, 1],
          ],
          "line-opacity": 0.9,
        },
      },
    ],
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

  // Which labels are worth drawing depends on zoom, so rebuild on zoom, not just
  // on scrub. Cheap: the snapshot data is unchanged, deck reuses its buffers.
  map.on("zoomend", () => last && setBorders(last.index, last.data));

  new ResizeObserver(() => map.resize()).observe(container);
  return map;
}

let last: { index: number; data: unknown } | null = null;

/**
 * Exactly ONE snapshot, fully opaque.
 *
 * This used to draw two snapshots crossfading by an interpolation factor, which
 * meant 1492 and 1500 were on screen simultaneously at partial opacity —
 * borders ghosting through each other for years at a time, showing a state that
 * never existed. Snapping to the nearest snapshot shows a real historical map;
 * genuinely dated boundaries come from the OHM layers above.
 */
export function setBorders(index: number, data: unknown) {
  last = { index, data };
  const built = [border(index, data), names(index, data)];

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

// Layer id is keyed to the snapshot, so re-running this for the same era reuses
// deck's tessellated buffers instead of rebuilding them.
function border(index: number, data: unknown) {
  return new GeoJsonLayer({
    id: `borders-${index}`,
    data: data as never,
    // Under OHM's crisp dated lines: this is the coarse always-available base.
    beforeId: "ohm-fill",
    pickable: true,
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

const labelCache = new Map<number, Label[]>();

/**
 * Always-on country names. Anything whose on-screen footprint is under ~40px gets
 * dropped, which is what keeps 254 labels from becoming a smear at world zoom and
 * reveals the small polities as you go in.
 */
function names(index: number, data: unknown) {
  let all = labelCache.get(index);
  if (!all) labelCache.set(index, (all = labelsFor(data)));

  // A ring's area is in square degrees; degrees-per-pixel falls off as 2^zoom.
  // Roughly: how many pixels wide is this country right now?
  const perPx = 360 / (512 * Math.pow(2, map.getZoom()));
  const visible = all.filter((l) => Math.sqrt(l.area) / perPx > 70);

  return new TextLayer<Label>({
    id: `names-${index}`,
    data: visible,
    getPosition: (l) => l.at,
    getText: (l) => l.name,
    getSize: 13,
    getColor: [255, 255, 255, 240],
    outlineColor: [0, 0, 0, 255],
    outlineWidth: 3,
    fontSettings: { sdf: true },
    getTextAnchor: "middle",
    getAlignmentBaseline: "center",
    // No maxWidth: deck.gl measures it in PIXELS, not ems, so a small number
    // wraps every label into an unreadable sliver.
  });
}

function download(blob: Blob, ext: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `historical-map-${Date.now()}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * PNG at `width` px across (default 4K), by temporarily raising the device pixel
 * ratio so the GL drawing buffer itself is that big — scaling the small canvas up
 * afterwards would just be a blurry upscale.
 */
export function exportPng(width = 3840) {
  const canvas = map.getCanvas();
  const before = map.getPixelRatio();
  map.setPixelRatio(width / canvas.clientWidth);
  map.once("render", () => {
    canvas.toBlob((b) => {
      if (b) download(b, "png");
      map.setPixelRatio(before);
    });
  });
  map.triggerRepaint();
}

/**
 * Records the live canvas. MediaRecorder emits real MP4/H.264 in current Chrome,
 * so there is no ffmpeg.wasm here; browsers without it fall back to WebM, which
 * every video editor still reads.
 */
export function startRecording(fps = 30) {
  const mime =
    [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

  const stream = map.getCanvas().captureStream(fps);
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 16e6,
  });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();

  return () =>
    new Promise<string>((done) => {
      rec.onstop = () => {
        const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
        download(new Blob(chunks, { type: mime }), ext);
        stream.getTracks().forEach((t) => t.stop());
        done(ext);
      };
      rec.stop();
    });
}
