import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { cachedBounds, cachedTags, fetchTags, qidOf } from "./ohm.ts";
import { flagFileFor, normFile, thumbUrls } from "./wikidata.ts";
import {
  SOURCES,
  dateFilter,
  detectOhm,
  ohmIsLocal,
  ohmMinZoom,
  normaliseHB,
  saveSources,
  savedSources,
  type Source,
} from "./sources.ts";
import { buildLabelPoints } from "./labels.ts";
import {
  childIds,
  focusFilter,
  initialFocus,
  nextLevel,
  type FocusState,
} from "./focus.ts";

// Source Cooperative's mirror of the Protomaps planet, NOT build.protomaps.com.
// The build bucket only sends access-control-allow-origin for localhost origins, so
// it works in dev and silently fails the moment the site is deployed. This mirror
// sends `*`, and its URL is stable rather than dated. ~135GB, but range requests
// mean we only ever pull the bytes for visible tiles.
const BASEMAP =
  "pmtiles://https://data.source.coop/protomaps/openstreetmap/v4.pmtiles";

// The basemap is a backdrop for historical borders, so drop everything modern:
// roads, buildings, POIs, and — critically — present-day country boundaries and
// labels, which would contradict whatever era is on screen. The `today` source
// re-enables the boundary half of this on demand.
const CLUTTER =
  /^(roads|buildings|pois|address|landuse_(urban|hospital|industrial|school|aerodrome|runway|pier|zoo|pedestrian))/;
const PRESENT_DAY = /^(boundaries|places_country|places_region)/;

const GLYPHS =
  "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export let map: maplibregl.Map;

let currentDate = -1e9;
let enabled: string[] = [];
let focus: FocusState = initialFocus();
let onFocusChange: ((f: FocusState) => void) | null = null;

export const getFocus = () => focus;
export const bindFocusChange = (fn: (f: FocusState) => void) => {
  onFocusChange = fn;
};

export type Picked = {
  osmId: number;
  name: string;
  adminLevel?: number;
  startDate?: string;
  endDate?: string;
  qid?: string;
  wikipedia?: string;
};

const active = () => SOURCES.filter((s) => enabled.includes(s.id));
/** Sources that own hover/click, in priority order. */
const pickable = () =>
  active().filter((s) => s.pickLayer && map.getLayer(s.pickLayer));

// ---------------------------------------------------------------------------
// Date + focus -> layer filters
// ---------------------------------------------------------------------------

/**
 * Every filterable layer gets date AND focus. Pure GPU — no refetch.
 *
 * No isStyleLoaded() guard: that returns false while tiles are still streaming,
 * and an early return here left a just-attached source permanently unfiltered —
 * CShapes rendered all of 1886-2019 at once. getLayer below is the real guard.
 */
function applyFilters() {
  if (!map) return;
  const date = dateFilter(currentDate);
  const f = focusFilter(focus);
  for (const s of active()) {
    for (const id of s.layers) {
      if (!map.getLayer(id)) continue;
      // The present-day source has no dates and no hierarchy; it is a reference
      // overlay, so filtering it would blank it.
      map.setFilter(id, s.id === "today" ? null : ["all", date, f]);
    }
  }
  if (map.getLayer("hist-label")) map.setFilter("hist-label", ["all", date, f]);
}

export function setOhmDate(dec: number) {
  currentDate = dec;
  applyFilters();
  queueLabels();
}

// ---------------------------------------------------------------------------
// Label text
// ---------------------------------------------------------------------------

/**
 * Year out of a date string, for the line under each country name.
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
  // Round-trip through a number to drop the zero padding, else "0218 BC".
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

const baseLayers = (flavor: "dark" | "light") =>
  layers("protomaps", namedFlavor(flavor), { lang: "en" }).filter(
    (l) => !CLUTTER.test(l.id) && !(PRESENT_DAY.test(l.id) && !enabled.includes("today")),
  );

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
  layers: baseLayers(flavor),
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
// Our layers
// ---------------------------------------------------------------------------

let coarse: unknown = null;
let attaching = false;

/**
 * Attach every enabled source plus the shared label layer, on top of whatever
 * basemap is loaded. Runs at init and again after every setStyle.
 */
async function addHistoryLayers() {
  // Guard on OUR OWN layer, never on a source name: OHM's Historical basemap
  // style ships a source called "ohm" of its own, so a getSource("ohm") check
  // saw theirs and our layers never came back after that switch. Hence the
  // "hist-" prefixes on every source id below.
  if (attaching || map.getLayer("hist-label")) return;
  attaching = true;
  try {
    for (const s of active()) {
      if (s.layers.some((l) => map.getLayer(l))) continue;
      await s.attach(map);
    }
    if (coarse) setCoarse(coarse);
    addLabelLayer();
    applyFilters();
    queueLabels();
  } finally {
    attaching = false;
  }
}

/**
 * The visible labels, drawn from a plain GeoJSON source.
 *
 * Deliberately NOT bound to a vector source. Tiles clip France into pieces and
 * every piece gets its own label — a flag near Lyon and another near Paris. A
 * GeoJSON source is never tiled, so one polity can only ever produce one symbol.
 */
function addLabelLayer() {
  if (!map.getSource("hist-labels"))
    map.addSource("hist-labels", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

  if (map.getLayer("hist-label")) return;
  map.addLayer({
    id: "hist-label",
    type: "symbol",
    source: "hist-labels",
    layout: {
      "text-field": labelText,
      // Noto Sans Bold is NOT in the Protomaps glyph set; it 404s. Medium is.
      "text-font": ["Noto Sans Medium"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 10, 15],
      "text-line-height": 1.15,
      "text-padding": 4,
      // Collisions resolve automatically instead of every name drawing over
      // every other one, and the biggest polity wins because sort-key ascends.
      "text-allow-overlap": false,
      "icon-allow-overlap": false,
      "symbol-sort-key": ["-", 0, ["coalesce", ["get", "area"], 0]],
      // Flags are registered lazily as "flag:<osm_id>"; ["image"] resolves to
      // null when one is missing, so the label degrades to text-only.
      "icon-image": ["image", ["concat", "flag:", ["get", "osm_id"]]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.4, 10, 0.85],
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

/** Enable/disable sources at runtime. Rebuilds the style when needed. */
export async function setSources(ids: string[]) {
  const hadToday = enabled.includes("today");
  enabled = ids;
  saveSources(ids);

  for (const s of SOURCES) {
    if (ids.includes(s.id)) continue;
    for (const l of s.layers) if (map.getLayer(l)) map.removeLayer(l);
  }
  // The present-day source is basemap layers we normally strip, so toggling it
  // means rebuilding the style rather than adding a layer.
  if (hadToday !== ids.includes("today")) return setBasemap(savedBasemap());

  for (const s of SOURCES) {
    if (!ids.includes(s.id)) continue;
    if (s.layers.length && s.layers.some((l) => map.getLayer(l))) continue;
    await s.attach(map, "hist-label");
  }
  applyFilters();
  queueLabels();
}


export async function initMap(
  container: HTMLDivElement,
  onPick: (p: Picked | null) => void,
): Promise<maplibregl.Map> {
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  enabled = savedSources();
  await detectOhm();

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

  // Double-click means "drill into this territory", not "zoom". Leaving the
  // native handler on made it zoom first, so by the time the drill read the
  // cursor it was over a city district rather than the country.
  map.doubleClickZoom.disable();

  // Without this, a bad style or tile URL fails completely silently.
  map.on("error", (e) => console.error("maplibre:", e.error?.message ?? e));

  await map.once("load");
  await addHistoryLayers();
  // Re-add after every setStyle, for as long as the map lives. The function
  // returns immediately when the layers are already there, so the repeats that
  // styledata fires per tile batch cost nothing.
  map.on("styledata", () => void addHistoryLayers());

  bindHover();
  bindClick(onPick);
  map.on("moveend", queueLabels);
  // Must exclude our own label source. rebuildLabels() calls setData on it,
  // which fires sourcedata, which re-queued the rebuild — a loop that never
  // settled, burning CPU and making every video frame wait out its timeout.
  map.on("sourcedata", (e) => {
    if (e.sourceId !== "hist-labels") queueLabels();
  });

  const saved = savedBasemap();
  if (saved !== "dark") setBasemap(saved);

  new ResizeObserver(() => map.resize()).observe(container);
  return map;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

const stateRef = (source: string, sourceLayer: string | undefined, id: string | number) =>
  sourceLayer ? { source, sourceLayer, id } : { source, id };

const SRC_OF: Record<string, [string, string | undefined]> = {
  "ohm-fill": ["hist-ohm", "boundaries"],
  "hb-fill": ["hist-hb", undefined],
  "cs-fill": ["hist-cs", undefined],
};

function bindHover() {
  let hot: { layer: string; id: string | number } | null = null;
  const clear = () => {
    if (hot) {
      const [src, sl] = SRC_OF[hot.layer] ?? [];
      if (src) map.setFeatureState(stateRef(src, sl, hot.id), { hover: false });
    }
    hot = null;
  };

  map.on("mousemove", (e) => {
    const hit = topmost(e.point);
    if (!hit || hit.f.id === undefined) {
      clear();
      map.getCanvas().style.cursor = "";
      return;
    }
    if (hot && hot.id === hit.f.id && hot.layer === hit.layer) return;
    clear();
    const [src, sl] = SRC_OF[hit.layer] ?? [];
    if (src) {
      hot = { layer: hit.layer, id: hit.f.id };
      map.setFeatureState(stateRef(src, sl, hit.f.id), { hover: true });
    }
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseout", clear);
}

/**
 * The feature under the cursor, from the highest-priority enabled source that
 * has one. Within a source, the smallest by area — boundaries nest, and the
 * innermost is what the pointer is on. Focus keeps the deeper levels hidden
 * until you drill in, so this no longer steals the country's click.
 */
function topmost(point: maplibregl.PointLike) {
  for (const s of pickable()) {
    const hits = map.queryRenderedFeatures(point, { layers: [s.pickLayer] });
    if (!hits.length) continue;
    const f = [...hits].sort(
      (a, b) =>
        Number(a.properties?.area ?? Infinity) -
        Number(b.properties?.area ?? Infinity),
    )[0];
    return { layer: s.pickLayer, source: s, f };
  }
  return null;
}

function toPicked(p: Record<string, any>): Picked {
  return {
    osmId: Number(p.osm_id),
    name: p["name:en"] || p.name || "Unnamed",
    adminLevel: Number(p.admin_level) || undefined,
    startDate: p.start_date || undefined,
    endDate: p.end_date || undefined,
    // Our own tiles carry these, so a click needs no Overpass round trip.
    qid: typeof p.wikidata === "string" ? p.wikidata : undefined,
    wikipedia: typeof p.wikipedia === "string" ? p.wikipedia : undefined,
  };
}

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === "Escape" && focus.trail.length) drillOut(focus.trail.length - 1);
};

function bindClick(onPick: (p: Picked | null) => void) {
  map.on("click", (e) => {
    const hit = topmost(e.point);
    onPick(hit?.f.properties ? toPicked(hit.f.properties) : null);
  });

  map.on("dblclick", (e) => {
    const hit = topmost(e.point);
    if (!hit?.f.properties) return;
    void drillInto(toPicked(hit.f.properties));
  });

  // Named + removed first: initMap re-runs under HMR, and an anonymous listener
  // would accumulate one Escape handler per edit.
  document.removeEventListener("keydown", onKeyDown);
  document.addEventListener("keydown", onKeyDown);
}

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

const notify = () => onFocusChange?.({ ...focus, trail: [...focus.trail] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the camera has stopped AND the tiles for the new view have arrived.
 *
 * `once("idle")` alone is not enough and caused a real bug: fitBounds animates
 * for 700ms, idle fired while the old view was still up, so childIds found none
 * of the parent's polygons, the allow-list came back empty, and every
 * neighbouring country's provinces stayed on screen.
 */
export async function whenIdle(timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (map.isMoving() || map.isZooming() || map.isEasing()) {
      await Promise.race([map.once("moveend"), sleep(200)]);
      continue;
    }
    if (!map.loaded() || !map.areTilesLoaded()) {
      await Promise.race([map.once("idle"), sleep(200)]);
      continue;
    }
    return;
  }
}

/**
 * Focus a polity and reveal the level below it.
 *
 * Bounds come from Overpass, which returns them alongside the wikidata tag we
 * already ask for — the tiles only carry clipped geometry, so a feature's true
 * extent is not otherwise knowable.
 */
export async function drillInto(p: Picked) {
  // Idempotent: a double-click can deliver two events, and the SideSheet button
  // hits the same path, so re-focusing the current polity must not stack a
  // second identical crumb on the trail.
  const tip = focus.trail[focus.trail.length - 1];
  if (tip?.osmId === p.osmId) return;
  const level = p.adminLevel ?? 2;
  await fetchTags([p.osmId]);
  const b = cachedBounds(p.osmId);
  if (b) {
    map.fitBounds([b.minlon, b.minlat, b.maxlon, b.maxlat], {
      padding: 60,
      duration: 700,
    });
  }

  focus = {
    trail: [...focus.trail, { osmId: p.osmId, name: p.name, adminLevel: level }],
    // Provisional: opened one notch so children can be found, then narrowed to
    // the level that actually exists here once tiles for the new view land.
    maxLevel: level + 2,
    allow: null,
  };
  applyFilters();
  notify();

  if (!b) return;
  await whenIdle();
  const src = pickable()[0];
  if (!src) return;
  const { ids, counts } = childIds(map, src.pickLayer, p.osmId, level);
  focus = {
    ...focus,
    maxLevel: nextLevel(level, counts),
    allow: ids.length ? ids : null,
  };
  applyFilters();
  queueLabels();
  notify();
}

/** Pop back to `index` in the trail; -1 returns to the country view. */
export function drillOut(index: number) {
  const trail = focus.trail.slice(0, Math.max(0, index));
  const level = trail.length ? trail[trail.length - 1].adminLevel : 2;
  focus = { trail, maxLevel: trail.length ? level + 2 : 2, allow: null };
  applyFilters();
  queueLabels();
  notify();
  const last = trail[trail.length - 1];
  const b = last && cachedBounds(last.osmId);
  if (b)
    map.fitBounds([b.minlon, b.minlat, b.maxlon, b.maxlat], {
      padding: 60,
      duration: 700,
    });
}

// ---------------------------------------------------------------------------
// Labels + flags
// ---------------------------------------------------------------------------

let labelTimer: ReturnType<typeof setTimeout> | undefined;
let labelsPending = 0;

/** sourcedata fires per tile, so coalesce the burst into one pass. */
function queueLabels() {
  clearTimeout(labelTimer);
  labelsPending++;
  labelTimer = setTimeout(() => {
    rebuildLabels();
    labelsPending = 0;
    void loadFlags();
  }, 250);
}

/** True when nothing is queued — the video renderer waits on this. */
export const labelsSettled = () => labelsPending === 0 && flagsInFlight === 0;

function rebuildLabels() {
  const src = map?.getSource?.("hist-labels") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;

  // Prefer the pipeline's precomputed points: they come from unclipped geometry,
  // so they are exact rather than "largest piece currently on screen".
  const s = pickable()[0];
  const layer =
    s && s.labelLayer && map.getLayer(s.labelLayer) ? s.labelLayer : s?.pickLayer;
  if (!layer) return src.setData({ type: "FeatureCollection", features: [] });

  src.setData(buildLabelPoints(map.queryRenderedFeatures({ layers: [layer] })) as never);
}

// ponytail: 30 flags per pass, national boundaries only. Beyond that you get
// text-only labels until you pan. Raise the cap only if that reads as a bug.
const FLAG_CAP = 30;
const asked = new Set<number>();
let flagsInFlight = 0;

/**
 * Flags for the countries on screen, in three batched hops: one Overpass call
 * maps osm_ids to wikidata tags (skipped entirely when our own tiles already
 * carry them), one Wikidata fetch per Q-id for the filename, and one Commons
 * call turning all of those into CORS-readable thumbnail URLs.
 */
async function loadFlags() {
  if (!map.getLayer("hist-label")) return;
  const feats = map
    .queryRenderedFeatures({ layers: ["hist-label"] })
    .filter(
      (f) =>
        Number(f.properties?.admin_level) === 2 &&
        f.properties?.osm_id &&
        !asked.has(Number(f.properties.osm_id)),
    )
    .slice(0, FLAG_CAP);
  if (!feats.length) return;

  flagsInFlight++;
  try {
    for (const f of feats) asked.add(Number(f.properties!.osm_id));
    // Our tiles bake in `wikidata`; the hosted ones do not, hence the fallback.
    const missing = feats
      .filter((f) => !f.properties?.wikidata)
      .map((f) => Number(f.properties?.osm_id));
    if (missing.length) await fetchTags(missing);

    const wanted = new Map<number, string>();
    await Promise.all(
      feats.map(async (f) => {
        const id = Number(f.properties?.osm_id);
        const qid =
          (f.properties?.wikidata as string) || qidOf(cachedTags(id)) || "";
        if (!/^Q\d+$/.test(qid) || map.hasImage(`flag:${id}`)) return;
        const file = await flagFileFor(qid, currentDate);
        if (file) wanted.set(id, normFile(file));
      }),
    );
    if (!wanted.size) return;

    const urls = await thumbUrls([...new Set(wanted.values())]);
    await Promise.all(
      [...wanted].map(async ([id, file]) => {
        const url = urls.get(file);
        const key = `flag:${id}`;
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
  } finally {
    flagsInFlight--;
  }
}

// ---------------------------------------------------------------------------
// Historical-Basemaps data, projection, export
// ---------------------------------------------------------------------------

/** Swap the Historical-Basemaps snapshot. Visual+pickable, but coarse. */
export function setCoarse(data: unknown) {
  // Stamp name/admin_level/osm_id: this dataset carries none of them, and the
  // shared date and hierarchy filters need all three.
  coarse = normaliseHB(data);
  (map?.getSource("hist-hb") as maplibregl.GeoJSONSource | undefined)?.setData(
    coarse as never,
  );
  queueLabels();
}

/** Globe or flat. MapLibre 5 only — and only safe now that deck.gl is gone. */
export function setGlobe(on: boolean) {
  map.setProjection({ type: on ? "globe" : "mercator" });
}

export { ohmIsLocal, ohmMinZoom };

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

export { download };

/**
 * Records the live canvas in real time. Kept only as the fallback for browsers
 * without WebCodecs — it samples whatever is on screen, so a tile that arrives
 * late is recorded as a stutter. src/video.ts is the good path.
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
