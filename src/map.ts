import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { cachedTags, fetchTags, qidOf } from "./ohm.ts";
import { flagFileFor, normFile, thumbUrls } from "./wikidata.ts";

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

const GLYPHS =
  "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";

// OpenHistoricalMap. Every feature carries its own start/end date, so we can
// render the true state on a given DAY instead of dissolving between snapshots.
// Point this at a self-hosted pmtiles:// URL if scripts/build-tiles.sh is run —
// nothing else in this file changes.
const OHM_TILES = "https://vtiles.openhistoricalmap.org/boundaries/{z}/{x}/{y}";

// Below this the hosted tiles are unusable: measured 4.7 MB at z3 versus 1.3 MB
// at z5, because OHM ships ~300 name_* localisations per feature (78% of the
// attribute bytes) with no per-zoom simplification. The coarse underlay covers
// the world view instead. Running the pipeline strips those fields and this
// could go to 0.
const OHM_MINZOOM = 5;

// ---------------------------------------------------------------------------
// Date filtering — pure GPU, no refetch
// ---------------------------------------------------------------------------

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

const OHM_LAYERS = ["ohm-fill", "ohm-line", "ohm-label"];

let currentDate = -1e9;

/** Show the boundaries valid on `dec`. Pure GPU filter — no data refetch. */
export function setOhmDate(dec: number) {
  currentDate = dec;
  if (!map?.getLayer("ohm-line")) return;
  const f = dateFilter(dec);
  for (const id of OHM_LAYERS) map.setFilter(id, f);
}

// ---------------------------------------------------------------------------
// Label text
// ---------------------------------------------------------------------------

/**
 * Year out of an OHM date string, for the line under each country name.
 *
 * Two cases the data really contains that a naive slice(0,4) gets wrong: 47 of
 * 980 features in a sample tile have no end_date at all, and 25 have BC starts
 * written as "-0218" — where the first four characters are "-021".
 */
const yearOf = (prop: string, fallback: string): any => [
  "case",
  ["!", ["has", prop]],
  fallback,
  ["==", ["slice", ["get", prop], 0, 1], "-"],
  // Round-trip through a number to drop OHM's zero padding: "-0218" would
  // otherwise read "0218 BC".
  ["concat", ["to-string", ["to-number", ["slice", ["get", prop], 1, 5], 0]], " BC"],
  ["slice", ["get", prop], 0, 4],
];

const labelText: any = [
  "format",
  ["coalesce", ["get", "name:en"], ["get", "name"], ""],
  {},
  "\n",
  {},
  ["concat", yearOf("start_date", "?"), "–", yearOf("end_date", "present")],
  { "font-scale": 0.72, "text-color": "#9ca3af" },
];

// ---------------------------------------------------------------------------
// Basemaps
// ---------------------------------------------------------------------------

export type Basemap = { id: string; label: string; style: () => unknown };

const protomaps = (flavor: "dark" | "light"): StyleSpecification => ({
  version: 8,
  glyphs: GLYPHS,
  // Without a sprite the place layers ask for icons that do not exist and
  // MapLibre logs "Image townspot could not be loaded" on every tile.
  sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavor}`,
  sources: {
    protomaps: {
      type: "vector",
      url: BASEMAP,
      attribution: "© OpenStreetMap, Protomaps",
    },
  },
  layers: layers("protomaps", namedFlavor(flavor), { lang: "en" }).filter(
    (l) => !CLUTTER.test(l.id),
  ),
});

const blank = (): StyleSpecification => ({
  version: 8,
  glyphs: GLYPHS,
  sources: {},
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0a0a0a" } },
  ],
});

// OHM publishes this style with glyphs and sprite pointing at
// https://localhost:8888/, which 404s for everyone but its own maintainers.
// Rewrite both to the paths the assets are actually served from.
const OHM_STYLE =
  "https://openhistoricalmap.github.io/map-styles/historical/historical.json";

async function ohmHistorical(): Promise<StyleSpecification> {
  const s = (await (await fetch(OHM_STYLE)).json()) as StyleSpecification;
  s.glyphs =
    "https://openhistoricalmap.github.io/map-styles/fonts/{fontstack}/{range}.pbf";
  s.sprite =
    "https://openhistoricalmap.github.io/map-styles/historical/historical_spritesheet";
  return s;
}

export const BASEMAPS: Basemap[] = [
  { id: "dark", label: "Protomaps Dark", style: () => protomaps("dark") },
  { id: "light", label: "Protomaps Light", style: () => protomaps("light") },
  { id: "ohm", label: "OHM Historical", style: ohmHistorical },
  { id: "none", label: "None", style: blank },
];

const STORE = "basemap";
export const savedBasemap = () => localStorage.getItem(STORE) ?? "dark";

/**
 * Swap the backdrop. `choice` is a BASEMAPS id or any style URL — a MapTiler
 * `https://api.maptiler.com/maps/<style>/style.json?key=…` pastes straight in.
 */
export async function setBasemap(choice: string) {
  localStorage.setItem(STORE, choice);
  const preset = BASEMAPS.find((b) => b.id === choice);
  // setStyle wipes every source and layer, ours included. The persistent
  // styledata listener installed in initMap puts them back — NOT a `once` here,
  // because styledata can fire while the outgoing style is still torn down, and
  // that first event would be consumed by a no-op.
  map.setStyle((preset ? await preset.style() : choice) as StyleSpecification);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export let map: maplibregl.Map;

export type Picked = {
  osmId: number;
  name: string;
  adminLevel?: number;
  startDate?: string;
  endDate?: string;
};

let coarse: unknown = null;

/**
 * Our sources and layers, on top of whatever basemap is loaded. Called at init
 * and again after every setStyle.
 */
function addHistoryLayers() {
  // Guard on OUR OWN layer, never on a source name. OHM's Historical style
  // ships a source called "ohm" of its own, so a getSource("ohm") check saw
  // theirs, returned early, and our layers never came back after that switch.
  // Hence the "hist-" prefixes below too.
  if (map.getLayer("ohm-fill")) return;

  // Historical-Basemaps: a BACKDROP ONLY, and only below OHM's minzoom so the
  // world view is not blank. It is deliberately absent from OHM_LAYERS, has no
  // label layer, and is never queried — every fact this app reports comes from
  // OHM. Its polygons are as coarse as 4 vertices per country, which is exactly
  // what made hover and click untrustworthy when deck.gl drew them.
  map.addSource("hist-coarse", {
    type: "geojson",
    data: (coarse ?? { type: "FeatureCollection", features: [] }) as never,
  });
  map.addLayer({
    id: "coarse-fill",
    type: "fill",
    source: "hist-coarse",
    maxzoom: OHM_MINZOOM,
    paint: {
      "fill-color": "#64748b",
      "fill-outline-color": "#94a3b8",
      "fill-opacity": [
        "interpolate", ["linear"], ["zoom"],
        OHM_MINZOOM - 1, 0.35,
        OHM_MINZOOM, 0,
      ],
    },
  });

  map.addSource("hist-ohm", {
    type: "vector",
    tiles: [OHM_TILES],
    minzoom: OHM_MINZOOM,
    maxzoom: 12,
    // These tiles carry no feature ids, so feature-state hover would have
    // nothing to key on without this. osm_id is unique per feature (verified
    // 980/980) and stable across tile boundaries, so a country split across two
    // tiles highlights as one shape.
    promoteId: "osm_id",
    attribution: "© OpenHistoricalMap",
  });

  const f = dateFilter(currentDate);

  map.addLayer({
    id: "ohm-fill",
    type: "fill",
    source: "hist-ohm",
    "source-layer": "boundaries",
    filter: f,
    paint: {
      "fill-color": [
        "case",
        ["has", "disputed_by"], "#d97706",
        ["==", ["get", "admin_level"], 2], "#e5e7eb",
        "#94a3b8",
      ],
      // The zoom interpolate MUST be outermost: MapLibre rejects a ["zoom"]
      // nested inside anything else. So the hover branch is repeated per stop
      // rather than wrapping the curve.
      "fill-opacity": [
        "interpolate", ["linear"], ["zoom"],
        5, ["case", ["boolean", ["feature-state", "hover"], false], 0.35, 0.06],
        10, ["case", ["boolean", ["feature-state", "hover"], false], 0.35, 0.12],
      ],
    },
  });

  map.addLayer({
    id: "ohm-line",
    type: "line",
    source: "hist-ohm",
    "source-layer": "boundaries",
    filter: f,
    paint: {
      "line-color": [
        "case",
        ["has", "disputed_by"], "#f59e0b",
        ["==", ["get", "admin_level"], 2], "#f8fafc",
        "#cbd5e1",
      ],
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        5, ["case", ["==", ["get", "admin_level"], 2], 1.1, 0.4],
        10, ["case", ["==", ["get", "admin_level"], 2], 2.4, 1],
      ],
      "line-opacity": 0.9,
    },
  });

  map.addLayer({
    id: "ohm-label",
    type: "symbol",
    source: "hist-ohm",
    "source-layer": "boundaries",
    filter: f,
    minzoom: OHM_MINZOOM,
    layout: {
      // "point" placement puts one label at MapLibre's pole of inaccessibility —
      // always inside the polygon, unlike a centroid, which lands offshore for
      // anything crescent-shaped.
      "symbol-placement": "point",
      "text-field": labelText,
      // Noto Sans Bold is NOT in the Protomaps glyph set; it 404s. Medium is.
      "text-font": ["Noto Sans Medium"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 10, 15],
      "text-line-height": 1.15,
      "text-padding": 4,
      // The readability fix. Collisions resolve automatically instead of every
      // name drawing over every other one, and the biggest polity wins because
      // sort-key is ascending.
      "text-allow-overlap": false,
      "icon-allow-overlap": false,
      "symbol-sort-key": ["-", 0, ["coalesce", ["get", "area"], 0]],
      // Flags are registered lazily as "flag:<name>"; ["image"] resolves to null
      // when one is missing, so the label silently degrades to text-only.
      "icon-image": ["image", ["concat", "flag:", ["get", "name"]]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 10, 0.85],
      // Flag sits above the block; the text hangs off the icon's bottom edge.
      "icon-anchor": "bottom",
      "text-anchor": "top",
      "text-offset": [0, 0.35],
      "icon-optional": true,
    },
    paint: {
      "text-color": "#f8fafc",
      // A real SDF halo, which is what makes these legible over any basemap.
      "text-halo-color": "rgba(10,10,10,0.9)",
      "text-halo-width": 1.6,
      "text-halo-blur": 0.4,
    },
  });
}

export async function initMap(
  container: HTMLDivElement,
  onPick: (p: Picked | null) => void,
): Promise<maplibregl.Map> {
  maplibregl.addProtocol("pmtiles", new Protocol().tile);

  map = new maplibregl.Map({
    container,
    style: protomaps("dark"),
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
  addHistoryLayers();
  // Re-add after every setStyle, for as long as the map lives. addHistoryLayers
  // returns immediately when the layers are already there, so the repeats that
  // styledata fires per tile batch cost nothing.
  map.on("styledata", addHistoryLayers);

  bindHover();
  bindClick(onPick);
  // NOT "idle": it never fires while tiles keep streaming, so flags never
  // loaded. moveend covers panning, sourcedata covers the first tiles arriving
  // and every date change, and the debounce collapses the burst of both.
  map.on("moveend", queueFlags);
  map.on("sourcedata", queueFlags);
  queueFlags();

  const saved = savedBasemap();
  if (saved !== "dark") setBasemap(saved);

  new ResizeObserver(() => map.resize()).observe(container);
  return map;
}

// ---------------------------------------------------------------------------
// Interaction — OHM only. The coarse layer is never queried.
// ---------------------------------------------------------------------------

const state = (id: string | number) => ({
  source: "hist-ohm",
  sourceLayer: "boundaries",
  id,
});

function bindHover() {
  let hot: string | number | undefined;
  const clear = () => {
    if (hot !== undefined) map.setFeatureState(state(hot), { hover: false });
    hot = undefined;
  };

  map.on("mousemove", "ohm-fill", (e) => {
    const f = smallest(e.features);
    if (!f || f.id === hot) return;
    clear();
    hot = f.id;
    if (hot !== undefined) map.setFeatureState(state(hot), { hover: true });
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", "ohm-fill", () => {
    clear();
    map.getCanvas().style.cursor = "";
  });
}

/**
 * Smallest by area. Boundaries nest — a click inside a province hits the
 * province, its country and any empire above it — and the innermost one is what
 * the pointer is actually on.
 */
function smallest(features?: maplibregl.MapGeoJSONFeature[]) {
  if (!features?.length) return undefined;
  return [...features].sort(
    (a, b) =>
      Number(a.properties?.area ?? Infinity) -
      Number(b.properties?.area ?? Infinity),
  )[0];
}

function bindClick(onPick: (p: Picked | null) => void) {
  map.on("click", (e) => {
    const p = smallest(
      map.queryRenderedFeatures(e.point, { layers: ["ohm-fill"] }),
    )?.properties;
    if (!p) return onPick(null);
    onPick({
      osmId: Number(p.osm_id),
      name: p["name:en"] || p.name || "Unnamed",
      adminLevel: Number(p.admin_level) || undefined,
      startDate: p.start_date || undefined,
      endDate: p.end_date || undefined,
    });
  });
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

// ponytail: 30 per idle, national boundaries only. Beyond that you get
// text-only labels until you pan. Raise the cap only if that reads as a bug.
const FLAG_CAP = 30;
const asked = new Set<string>();

// sourcedata fires per tile, so coalesce the burst into one pass.
let flagTimer: ReturnType<typeof setTimeout> | undefined;
function queueFlags() {
  clearTimeout(flagTimer);
  flagTimer = setTimeout(() => void loadFlags(), 400);
}

/**
 * Resolve flags for the countries currently on screen, in three batched hops:
 * one Overpass call maps every osm_id to its `wikidata` tag, one Wikidata fetch
 * per Q-id gives the flag filename, and one Commons call turns all of those
 * filenames into CORS-readable thumbnail URLs.
 */
async function loadFlags() {
  if (!map.getLayer("ohm-label")) return;
  const feats = map
    .queryRenderedFeatures({ layers: ["ohm-label"] })
    .filter(
      (f) =>
        Number(f.properties?.admin_level) === 2 &&
        f.properties?.name &&
        !asked.has(f.properties.name),
    )
    .slice(0, FLAG_CAP);
  if (!feats.length) return;

  for (const f of feats) asked.add(f.properties!.name);
  await fetchTags(feats.map((f) => Number(f.properties?.osm_id)));

  // name -> flag filename, for the ones that have both a Q-id and a P41.
  const wanted = new Map<string, string>();
  await Promise.all(
    feats.map(async (f) => {
      const name = f.properties!.name as string;
      const qid = qidOf(cachedTags(Number(f.properties?.osm_id)));
      if (!qid || map.hasImage(`flag:${name}`)) return;
      const file = await flagFileFor(qid, currentDate);
      if (file) wanted.set(name, normFile(file));
    }),
  );
  if (!wanted.size) return;

  const urls = await thumbUrls([...new Set(wanted.values())]);
  await Promise.all(
    [...wanted].map(async ([name, file]) => {
      const url = urls.get(file);
      const key = `flag:${name}`;
      if (!url || map.hasImage(key)) return;
      try {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        if (!map.hasImage(key)) map.addImage(key, bitmap);
      } catch {
        // A polity with no usable flag is normal. It stays text-only, and
        // `asked` means we never look again.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Coarse underlay, projection, export
// ---------------------------------------------------------------------------

/** Swap the sub-zoom-5 backdrop. Visual only — nothing reads these features. */
export function setCoarse(data: unknown) {
  coarse = data;
  (map?.getSource("hist-coarse") as maplibregl.GeoJSONSource | undefined)?.setData(
    data as never,
  );
}

/** Globe or flat. MapLibre 5 only — and only safe now that deck.gl is gone. */
export function setGlobe(on: boolean) {
  map.setProjection({ type: on ? "globe" : "mercator" });
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
