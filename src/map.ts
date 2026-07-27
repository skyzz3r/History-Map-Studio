import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import {
  cachedBounds,
  cachedTags,
  fetchTags,
  qidOf,
  type Bounds,
} from "./ohm.ts";
import { flagFileFor, normFile, thumbUrls } from "./wikidata.ts";
import {
  BASEMAP_TILES,
  HATCH,
  OCEAN_KINDS,
  SOURCES,
  dateFilter,
  detectOhm,
  fillOpacity,
  lineWidth,
  ohmIsLocal,
  ohmMinZoom,
  normaliseHB,
  normaliseSources,
  saveSources,
  savedSources,
  type Source,
} from "./sources.ts";
import { buildLabelPoints } from "./labels.ts";
import { bboxArea, claimsFrom, overlappingIds, type Sample } from "./claims.ts";
import { featureArea } from "./geo.ts";
import {
  childIds,
  COUNTRY_LEVEL,
  coveredIds,
  focusFilter,
  initialFocus,
  mergeAllow,
  nextLevel,
  type FocusState,
  type Level,
} from "./focus.ts";
import {
  addFeature,
  editFeatures,
  excludedIds,
  loadEdits,
  newEditId,
  onEditsChange,
  parentOverrides,
  setOverride,
  touchEdits,
  type EditFeature,
  type EditProps,
} from "./edits.ts";
import { startPolygon } from "./draw.ts";

// ~135 GB, but range requests mean we only ever pull the bytes for visible tiles.
const BASEMAP = BASEMAP_TILES;

// The basemap is a backdrop for historical borders, so drop everything modern:
// roads, buildings, POIs, and — critically — present-day country boundaries and
// labels, which would contradict whatever era is on screen.
//
// These are stripped UNCONDITIONALLY now. The `today` source used to work by
// un-stripping them, which made it invisible (they are a dark hairline drawn to
// sit under labels, and our fills cover them) and confined it to the Protomaps
// basemaps. It draws its own cyan layers instead — see sources.ts.
const CLUTTER =
  /^(roads|buildings|pois|address|landuse_(urban|hospital|industrial|school|aerodrome|runway|pier|zoo|pedestrian))/;
const PRESENT_DAY = /^(boundaries|places_country|places_region)/;

const GLYPHS =
  "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";

// Coastline clip. OHM boundary polygons include territorial waters, so a
// country's fill and border line spill ~200 nm offshore (worst on Canada). The
// clip paints the sea back over the top, below labels, so the visible edge of
// every territory becomes the coastline. OCEAN_KINDS (salt water only, so lake
// borders like the Great Lakes survive) lives in sources.ts, node-testable.
const CLIP_STORE = "clip";
export const savedClip = () => localStorage.getItem(CLIP_STORE) === "1";
let clip = savedClip();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export let map: maplibregl.Map;

let currentDate = -1e9;
let enabled: string[] = [];
let focus: FocusState = initialFocus();
let onFocusChange: ((f: FocusState) => void) | null = null;
/** osm_ids currently judged de-jure claims. Recomputed on the label pass. */
let claims: unknown[] = [];
/**
 * Countries standing inside a level-1 empire or union at the world view, which
 * that empire now draws in place of. Recomputed on the same debounced pass.
 */
let covered: number[] = [];

export const getFocus = () => focus;
export const bindFocusChange = (fn: (f: FocusState) => void) => {
  onFocusChange = fn;
};

export type Picked = {
  /**
   * NOT always a number. OHM ids are numeric, but Historical-Basemaps features
   * carry "hb-3" and regions the user drew carry "edit-ohm-1". Coercing those to
   * Number gave NaN, and an edit saved against a NaN id was filed under the key
   * "NaN" — the form showed the change and the map never moved.
   */
  osmId: number | string;
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
 * Layer-specific clauses on top of date + focus.
 *
 * The three OHM fill layers read the SAME source and partition it between them,
 * so each needs the complement of the others or a claim would draw twice.
 */
function extraClause(layerId: string): any[] | null {
  const isOverlay: any = ["==", ["coalesce", ["get", "overlay"], 0], 1];
  const isClaim: any = ["in", ["get", "osm_id"], ["literal", claims]];
  switch (layerId) {
    case "ohm-occupation":
      return [isOverlay];
    case "ohm-fill":
    case "ohm-line":
      return [["!", isOverlay], ["!", isClaim]];
    case "ohm-claim":
    case "ohm-claim-line":
      return [["!", isOverlay], isClaim];
    default:
      return null;
  }
}

/**
 * Every filterable layer gets date AND focus. Pure GPU — no refetch.
 *
 * No isStyleLoaded() guard: that returns false while tiles are still streaming,
 * and an early return here left a just-attached source permanently unfiltered —
 * CShapes rendered all of 1886-2019 at once. getLayer below is the real guard.
 */
/**
 * The clause that hides originals the user has edited or deleted.
 *
 * Applied to the DATASET layers only. An edited region is drawn by the edits
 * overlay instead, so without this both would render — the correction sitting
 * on top of the thing it corrects.
 */
function excludeClause(): any[] {
  const ids = excludedIds(editSourceId());
  return ids.length
    ? [["!", ["in", ["get", "osm_id"], ["literal", ids]]]]
    : [];
}

/** The dataset edits belong to: the active border source, never an overlay. */
function editSourceId(): string {
  return enabled.find((id) => !SOURCES.find((s) => s.id === id)?.overlay) ?? "ohm";
}

function applyFilters() {
  if (!map) return;
  const date = dateFilter(currentDate);
  const f = focusFilter(focus, covered);
  const hide = excludeClause();
  for (const s of active()) {
    // A cosmetic overlay carries no dates and no hierarchy; it keeps the filter
    // its own attach() set, and filtering it here would blank it.
    if (s.overlay) continue;
    for (const id of s.layers) {
      if (!map.getLayer(id)) continue;
      map.setFilter(id, [
        "all",
        date,
        f,
        ...hide,
        ...(extraClause(id) ?? []),
      ] as never);
    }
  }
  // The edits overlay carries the same dates and hierarchy as any dataset, but
  // never the exclusion — it IS the replacement.
  //
  // And never the world-view de-duplication while editing. `covered` hides a
  // country that an empire stands in for, and saying "this region belongs to
  // that empire" puts the region straight into that set: assigning the Kingdom
  // of Portugal to the Portuguese Empire excluded it from the dataset layer AND
  // hid it here, so a parent edit looked exactly like a delete. An edit must
  // always be visible to the person making it.
  const fEdits = editMode ? focusFilter(focus, []) : f;
  for (const id of EDIT_LAYERS)
    if (map.getLayer(id)) map.setFilter(id, ["all", date, fEdits] as never);
  if (map.getLayer("hist-label")) map.setFilter("hist-label", ["all", date, f]);
}

const EDIT_LAYERS = ["edit-fill", "edit-line"];

/** Push the current source's edits into the overlay. */
function refreshEdits() {
  const src = map?.getSource("hist-edits") as maplibregl.GeoJSONSource | undefined;
  src?.setData(editFeatures(editSourceId()) as never);
}

/**
 * The overlay every edit is drawn from. Amber, so a corrected or invented
 * border never passes for source data.
 */
function addEditLayers() {
  if (!map.getSource("hist-edits"))
    map.addSource("hist-edits", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      promoteId: "osm_id",
    });

  if (!map.getLayer("edit-fill"))
    map.addLayer(
      {
        id: "edit-fill",
        type: "fill",
        source: "hist-edits",
        paint: { "fill-color": "#f59e0b", "fill-opacity": fillOpacity(0.2) },
      },
      map.getLayer("hist-label") ? "hist-label" : undefined,
    );
  if (!map.getLayer("edit-line"))
    map.addLayer(
      {
        id: "edit-line",
        type: "line",
        source: "hist-edits",
        paint: {
          "line-color": "#fbbf24",
          "line-width": lineWidth(),
          "line-opacity": 0.95,
        },
      },
      map.getLayer("hist-label") ? "hist-label" : undefined,
    );
  refreshEdits();
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
    (l) => !CLUTTER.test(l.id) && !PRESENT_DAY.test(l.id),
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
    ensureHatch();
    for (const s of active()) {
      if (s.layers.some((l) => map.getLayer(l))) continue;
      await s.attach(map);
    }
    if (coarse) setCoarse(coarse);
    addLabelLayer();
    // After the labels so both anchor beneath them, and inside the styledata
    // re-attach path so they survive every basemap swap — setStyle drops every
    // source and layer we own.
    addEditLayers();
    if (clip) ensureClipMask();
    applyFilters();
    queueLabels();
  } finally {
    attaching = false;
  }
}

/**
 * The coastline clip: an opaque sea fill drawn over the border layers, below the
 * labels, so each territory's over-water spill is hidden and the visible border
 * follows the coast. Own source (BASEMAP_TILES), so it works on every basemap —
 * including None/OHM, which have no Protomaps water layer of their own.
 *
 * Two accepted costs while on: the basemap's ocean name labels are covered, and
 * the coast shown is the modern OSM one, not the era's (a reclaimed Zuiderzee or
 * a full Aral Sea reads as present-day).
 */
function ensureClipMask() {
  if (!map.getSource("hist-ocean"))
    map.addSource("hist-ocean", {
      type: "vector",
      url: BASEMAP_TILES,
      attribution: "© OpenStreetMap, Protomaps",
    } as never);

  if (map.getLayer("ocean-mask")) return;
  // Seamless where the basemap draws water; a dark sea elsewhere (None/OHM).
  const c = map.getLayer("water") && map.getPaintProperty("water", "fill-color");
  map.addLayer(
    {
      id: "ocean-mask",
      type: "fill",
      source: "hist-ocean",
      "source-layer": "water",
      filter: ["all", ["==", "$type", "Polygon"], ["in", "kind", ...OCEAN_KINDS]],
      paint: {
        "fill-color": (typeof c === "string" ? c : "#0b1220") as never,
        "fill-opacity": 1,
      },
    },
    // Above every border layer (all added before hist-label), below the labels.
    map.getLayer("hist-label") ? "hist-label" : undefined,
  );
}

/** Toggle the coastline clip. Self-contained, like setGlobe. */
export function setClip(on: boolean) {
  clip = on;
  localStorage.setItem(CLIP_STORE, on ? "1" : "0");
  if (!map) return;
  if (on) ensureClipMask();
  else if (map.getLayer("ocean-mask")) map.removeLayer("ocean-mask");
}

/**
 * The diagonal hatch the de-jure claim layer is filled with.
 *
 * Drawn rather than shipped: it is 16 lines of canvas against another network
 * asset to host, cache-bust and 404. setStyle drops every registered image, so
 * this is re-run from addHistoryLayers rather than once at startup.
 */
function ensureHatch() {
  if (map.hasImage(HATCH)) return;
  const n = 16;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d");
  if (!g) return;
  g.strokeStyle = "#fbbf24";
  g.lineWidth = 2.5;
  g.beginPath();
  // Three strokes, offset by ±n, so the diagonal is continuous when tiled.
  for (const d of [-n, 0, n]) {
    g.moveTo(d, n);
    g.lineTo(d + n, 0);
  }
  g.stroke();
  map.addImage(HATCH, g.getImageData(0, 0, n, n) as never, { pixelRatio: 2 });
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

/**
 * Switch the border dataset (and any cosmetic overlay) at runtime.
 *
 * No setStyle any more: `today` owns real layers now, so nothing here needs the
 * whole style rebuilt, and a rebuild was itself a source of the "dataset does
 * not load" reports — it tore every layer down and relied on the styledata
 * listener to race them back.
 */
export async function setSources(ids: string[]) {
  enabled = normaliseSources(ids);
  saveSources(enabled);

  for (const s of SOURCES) {
    if (enabled.includes(s.id)) continue;
    for (const l of s.layers) if (map.getLayer(l)) map.removeLayer(l);
    // Drop the source too, so re-enabling rebuilds it from scratch instead of
    // adopting a stale one. Layers must go first or MapLibre refuses.
    if (SRC_ID[s.id] && map.getSource(SRC_ID[s.id])) map.removeSource(SRC_ID[s.id]);
  }

  for (const s of SOURCES) {
    if (!enabled.includes(s.id)) continue;
    if (s.layers.length && s.layers.every((l) => map.getLayer(l))) continue;
    await s.attach(map, map.getLayer("hist-label") ? "hist-label" : undefined);
  }

  // Refill the datasets that hold their data in a GeoJSON source rather than
  // fetching it themselves. THIS is why Historical-Basemaps came up blank when
  // it was enabled after another dataset: attach() creates an empty source, and
  // the snapshot only arrives on the next timeline move — so the map stayed
  // empty until you happened to drag the slider.
  if (coarse) setCoarse(coarse);

  // Edits are namespaced per dataset, so switching dataset changes which set is
  // live: the overlay must be refilled and anything reading it told to re-read.
  refreshEdits();
  touchEdits();
  // The selection belongs to the dataset it was made on. Keeping it would let a
  // Save write one source's feature id into another's edit set.
  onEditPick?.(null);
  parentPick = null;

  applyFilters();
  queueLabels();
}


export async function initMap(
  container: HTMLDivElement,
  onPick: (p: Picked | null, others: Picked[]) => void,
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
  // Dev-only handle so the map can be driven and asserted against from a console
  // or an automated browser session. Stripped from production by the guard.
  if ((import.meta as any).env?.DEV) (window as any).__map = map;
  return map;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

/**
 * An id as a number, or null when it is not one.
 *
 * Only OHM ids are numeric. Overpass, Wikidata bounds and the flag lookups are
 * all keyed by real osm ids, so they must be skipped rather than called with
 * NaN — which is what "hb-3" and a drawn region's "edit-ohm-1" become.
 */
const numericId = (id: number | string): number | null => {
  const n = Number(id);
  return Number.isFinite(n) && String(id).trim() !== "" ? n : null;
};

const stateRef = (source: string, sourceLayer: string | undefined, id: string | number) =>
  sourceLayer ? { source, sourceLayer, id } : { source, id };

const SRC_OF: Record<string, [string, string | undefined]> = {
  "ohm-fill": ["hist-ohm", "boundaries"],
  "ohm-claim": ["hist-ohm", "boundaries"],
  "ohm-occupation": ["hist-ohm", "boundaries"],
  "hb-fill": ["hist-hb", undefined],
  "cs-fill": ["hist-cs", undefined],
  "edit-fill": ["hist-edits", undefined],
};

/** Source id owned by each dataset, so disabling one can remove it cleanly. */
const SRC_ID: Record<string, string> = {
  ohm: "hist-ohm",
  hb: "hist-hb",
  cshapes: "hist-cs",
  today: "hist-today",
};

/**
 * The clicked polity, highlighted on the map.
 *
 * Previously nothing marked it at all: the side sheet opened and the map looked
 * identical, so "which one did I just select" had no answer — and it read as the
 * datasets behaving differently, since each had its own hover lift and none had
 * a selected state. `selected` is one feature-state, and every source's paint
 * reads it through the shared helpers in sources.ts.
 */
let picked: { layer: string; id: string | number } | null = null;

function setSelected(hit: Hit | null) {
  if (picked) {
    const [src, sl] = SRC_OF[picked.layer] ?? [];
    if (src) map.setFeatureState(stateRef(src, sl, picked.id), { selected: false });
  }
  picked = null;
  if (!hit || hit.f.id === undefined) return;
  const [src, sl] = SRC_OF[hit.layer] ?? [];
  if (!src) return;
  picked = { layer: hit.layer, id: hit.f.id };
  map.setFeatureState(stateRef(src, sl, hit.f.id), { selected: true });
}

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

export type Hit = {
  layer: string;
  source: Source;
  f: maplibregl.MapGeoJSONFeature;
};

/**
 * Everything under the cursor, best first, from the highest-priority enabled
 * source that has anything.
 *
 * This used to sort on `f.properties.area` — a property that only ever exists on
 * LABEL POINTS, never on boundary polygons. So every comparison was
 * `Infinity - Infinity`, "smallest wins" silently degraded to "whatever the
 * renderer happened to return first", and that one bug produced two of the
 * reported symptoms: a drilled-into parent still stealing its children's clicks,
 * and hovering an occupied region selecting the country around it.
 *
 * Ranking, in order:
 *  1. Not an ancestor you already drilled through. Those stay drawn for context
 *     but must stop being clickable, or the parent masks its own subdivisions.
 *  2. Deepest admin_level — the innermost polity is what the pointer is on.
 *  3. Not a de-jure claim, so the de-facto holder wins an overlap.
 *  4. Smallest real area, computed from the rendered geometry.
 */
function hitsAt(point: maplibregl.PointLike): Hit[] {
  const ancestors = new Set(focus.trail.map((t) => String(t.osmId)));
  const isClaim = new Set(claims.map(String));

  // Edits win the click. They are drawn over the dataset and are what the user
  // most recently asserted is true, so a corrected region must be the thing you
  // select and re-edit rather than the original showing through.
  if (map.getLayer("edit-fill")) {
    const raw = map.queryRenderedFeatures(point, { layers: ["edit-fill"] });
    if (raw.length) {
      const s = pickable()[0] ?? active().find((x) => !x.overlay);
      const seen = new Map<string, Hit>();
      for (const f of raw) {
        const id = String(f.properties?.osm_id ?? "");
        if (!seen.has(id) && s)
          seen.set(id, { layer: "edit-fill", source: s, f });
      }
      if (seen.size) return [...seen.values()];
    }
  }

  for (const s of pickable()) {
    const layers = (s.pickLayers ?? [s.pickLayer]).filter((l) => map.getLayer(l));
    const raw = layers.length
      ? map.queryRenderedFeatures(point, { layers })
      : [];
    if (!raw.length) continue;

    // One entry per polity: tile clipping delivers the same feature several
    // times and the side sheet must not list it twice.
    const seen = new Map<string, { h: Hit; level: number; claim: boolean; area: number }>();
    for (const f of raw) {
      const id = String(f.properties?.osm_id ?? "");
      if (seen.has(id)) continue;
      const layer = layers.find((l) => l === f.layer?.id) ?? layers[0];
      seen.set(id, {
        h: { layer, source: s, f },
        level: Number(f.properties?.admin_level) || 0,
        claim: isClaim.has(id),
        area: featureArea(f.geometry),
      });
    }

    let list = [...seen.entries()];
    // Only drop ancestors while something else remains — otherwise drilling into
    // a country with no mapped subdivisions would make it unclickable.
    const withoutAncestors = list.filter(([id]) => !ancestors.has(id));
    if (withoutAncestors.length) list = withoutAncestors;

    list.sort(
      ([, a], [, b]) =>
        b.level - a.level ||
        Number(a.claim) - Number(b.claim) ||
        a.area - b.area,
    );
    return list.map(([, v]) => v.h);
  }
  return [];
}

const topmost = (point: maplibregl.PointLike): Hit | null =>
  hitsAt(point)[0] ?? null;

function toPicked(p: Record<string, any>): Picked {
  return {
    // Numeric when it can be, the raw value otherwise — see Picked.osmId.
    osmId: Number.isFinite(Number(p.osm_id)) ? Number(p.osm_id) : String(p.osm_id),
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

function bindClick(onPick: (p: Picked | null, others: Picked[]) => void) {
  map.on("click", (e) => {
    // The whole stack, not only the winner. Where two polities genuinely
    // overlap — a de-facto occupier and the de-jure claimant it displaced —
    // the loser was previously unreachable by any click at all.
    const hits = hitsAt(e.point).filter((h) => h.f.properties);

    // "Pick parent" consumes exactly one click and must not also change the
    // selection, or choosing a parent would navigate away from the child whose
    // form is open.
    if (parentPick) {
      const fn = parentPick;
      parentPick = null;
      if (hits[0]) fn(toPicked(hits[0].f.properties!));
      return;
    }

    if (editMode) {
      setSelected(hits[0] ?? null);
      onEditPick?.(hits[0] ? toPicked(hits[0].f.properties!) : null);
      return;
    }

    setSelected(hits[0] ?? null);
    const stack = hits.map((h) => toPicked(h.f.properties!));
    // Clicking away from every polity is a deselect, and a deselect returns to
    // the top of the hierarchy rather than stranding you inside a drill-down
    // whose subject is no longer selected.
    if (!stack.length && focus.trail.length) drillOut(0);
    onPick(stack[0] ?? null, stack.slice(1));
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
 * Frame a polity's global bounds.
 *
 * The wrap fix is load-bearing. The Soviet Union's Overpass box runs minlon 20.9
 * to maxlon -169.0 across the antimeridian; handing that to fitBounds as-is is
 * an inverted extent, so the camera flew off to nowhere, NOTHING rendered, and
 * the drill-down then resolved zero children — it looked like a hierarchy bug.
 */
function fitTo(b: Bounds | undefined | false) {
  if (!b) return;
  const maxlon = b.maxlon < b.minlon ? b.maxlon + 360 : b.maxlon;
  const { width, height } = map.getCanvas().getBoundingClientRect();
  const cam = map.cameraForBounds([b.minlon, b.minlat, maxlon, b.maxlat], {
    // Fixed padding eats a short window alive: 60px each side of a 275px canvas
    // leaves 155px to fit a country into.
    padding: Math.min(60, Math.min(width, height) / 8),
  });
  if (!cam) return;
  // Never fit BELOW the source's minzoom. Framing a large country in a short
  // window landed at z3 against zoom-5-gated tiles: nothing loaded, so the
  // drill-down resolved no children and looked broken for reasons that had
  // nothing to do with the hierarchy.
  map.easeTo({
    ...cam,
    zoom: Math.max(cam.zoom ?? 0, ohmMinZoom()),
    duration: 700,
  });
}

/**
 * Focus a polity and reveal the level below it.
 *
 * Bounds come from Overpass, which returns them alongside the wikidata tag we
 * already ask for — the tiles only carry clipped geometry, so a feature's true
 * extent is not otherwise knowable.
 */
export async function drillInto(p: Picked): Promise<boolean> {
  // Idempotent for the double-click that delivers two events, but NOT a blanket
  // "same id" bail: the side sheet's button hits this same path, and refusing it
  // whenever the polity was already the tip is why that button looked dead after
  // a double-click on the same country.
  const tip = focus.trail[focus.trail.length - 1];
  const alreadyResolved = tip?.osmId === p.osmId && focus.allow !== null;
  if (alreadyResolved) return focus.allow!.length > 0;

  const level = p.adminLevel ?? 2;
  // A Historical-Basemaps feature has a non-numeric osm_id, so this is a no-op
  // for it and cachedBounds stays empty — handled below rather than bailing.
  const nid = numericId(p.osmId);
  if (nid !== null) await fetchTags([nid]);
  fitTo(nid === null ? undefined : cachedBounds(nid));

  if (tip?.osmId !== p.osmId) {
    focus = {
      trail: [...focus.trail, { osmId: p.osmId, name: p.name, adminLevel: level }],
      // Provisional, and paired with an EMPTY allow-list, never null: opening
      // maxLevel with no restriction is what put every province on Earth on
      // screen and let you select regions outside the parent.
      maxLevel: level + 2,
      allow: [],
      children: [],
      resolved: false,
    };
    applyFilters();
    notify();
  }

  // No bounds is not a reason to give up — resolve children from the current
  // view instead. It is the only path a source without Overpass ids ever gets.
  return resolveChildren(p.osmId, level);
}

/** Pop back to `index` in the trail; 0 returns to the world view. */
export function drillOut(index: number) {
  const trail = focus.trail.slice(0, Math.max(0, index));
  const last = trail[trail.length - 1];
  focus = {
    trail,
    maxLevel: last ? last.adminLevel + 2 : initialFocus().maxLevel,
    // Same rule as drillInto: an open maxLevel always carries a restriction.
    allow: last ? [] : null,
    children: [],
    resolved: !last,
  };
  applyFilters();
  queueLabels();
  notify();

  const lastNid = last ? numericId(last.osmId) : null;
  fitTo(lastNid === null ? undefined : cachedBounds(lastNid));
  // Re-resolve this level's children; the refreshOverlaps pass only widens an
  // existing list, and popping back starts from an empty one.
  if (last) void resolveChildren(last.osmId, last.adminLevel);
}

/**
 * Back to the world view and clear the selection highlight.
 *
 * Deselecting has to land here rather than one level up: the trail's whole
 * purpose is to describe the selected territory, so with nothing selected there
 * is no trail to be partway along.
 */
export function resetFocus() {
  setSelected(null);
  if (focus.trail.length) drillOut(0);
}

/**
 * Wait for the new view, then narrow the focus to the subdivisions that are
 * genuinely inside the parent. Returns whether any were found — the side sheet
 * uses that to disable its button instead of appearing to do nothing.
 */
async function resolveChildren(
  osmId: number | string,
  level: number,
): Promise<boolean> {
  await whenIdle();
  const r = childrenOf(osmId, level);
  if (!r) return false;
  focus = {
    ...focus,
    maxLevel: r.level,
    allow: r.ids,
    children: r.nodes.filter((n) => n.adminLevel === r.level),
    resolved: true,
  };
  applyFilters();
  queueLabels();
  notify();
  return r.ids.length > 0;
}

/**
 * Subdivisions of `osmId` among the currently LOADED TILES.
 *
 * Reads the source, not the rendered layers. The focus filter is what hides
 * subdivisions, so asking the rendered set which subdivisions exist could only
 * ever answer "none" — the drill resolved an empty list every time and looked
 * like it did nothing. Source features skip layer filters, so the date filter is
 * handed to querySourceFeatures directly.
 */
function childrenOf(
  osmId: number | string,
  level: number,
): { ids: (number | string)[]; level: number; nodes: Level[] } | null {
  const feats = sourceFeatures();
  if (!feats) return null;
  const { ids, counts, nodes } = childIds(
    feats,
    osmId,
    level,
    parentOverrides(currentSourceId()),
  );
  return { ids, level: nextLevel(level, counts), nodes };
}

/** Every feature of the active dataset alive at the current date, unfiltered by
 *  the focus — the set both child discovery and empire containment read. */
function sourceFeatures(): maplibregl.GeoJSONFeature[] | null {
  const s = pickable()[0];
  if (!s) return null;
  const [srcId, sourceLayer] = SRC_OF[s.pickLayer] ?? [];
  if (!srcId || !map.getSource(srcId)) return null;
  const base = map.querySourceFeatures(srcId, {
    sourceLayer,
    filter: dateFilter(currentDate),
  });
  // Edited and added regions have to take part in the hierarchy too, or a
  // region the user just created could never be drilled into or found as a
  // child. The excluded originals are dropped so an edit is not counted twice.
  if (!map.getSource("hist-edits")) return base;
  const hidden = new Set(excludedIds(currentSourceId()).map(String));
  const mine = map.querySourceFeatures("hist-edits", {
    filter: dateFilter(currentDate),
  });
  if (!mine.length && !hidden.size) return base;
  return [
    ...base.filter((f) => !hidden.has(String(f.properties?.osm_id))),
    ...mine,
  ];
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
    void refreshOverlaps();
    rebuildLabels();
    labelsPending = 0;
    void loadFlags();
  }, 250);
}

/**
 * Which polities on screen are de-jure claims.
 *
 * The grid is hit-tested rather than reasoned about geometrically because tiles
 * clip polygons to the viewport: at zoom 6 both the Reich and the Soviet Union
 * are cut down to roughly the screen rectangle, so every geometric test agrees
 * they contain each other. A rendered hit test is immune to that.
 *
 * Sizes come from Overpass bounding boxes, fetched only for ids that actually
 * share a point with a same-level neighbour — normally zero, a handful during a
 * partition — and cached by src/ohm.ts, so most passes make no request at all.
 */
async function computeClaims(layers: string[]): Promise<unknown[]> {
  const { width: w, height: h } = map.getCanvas().getBoundingClientRect();
  const samples: Sample[] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 4; j++) {
      const pt: [number, number] = [
        w * (0.1 + (0.8 * i) / 5),
        h * (0.1 + (0.8 * j) / 3),
      ];
      const seen = new Map<string, { id: unknown; level: number }>();
      for (const f of map.queryRenderedFeatures(pt, { layers })) {
        const id = f.properties?.osm_id;
        if (id === undefined || id === null) continue;
        seen.set(String(id), { id, level: Number(f.properties?.admin_level) || 0 });
      }
      if (seen.size > 1) samples.push([...seen.values()]);
    }
  }
  if (!samples.length) return [];

  const ids = overlappingIds(samples).filter((v) => Number.isFinite(Number(v)));
  await fetchTags(ids.map(Number));
  const areaOf = (id: unknown) => bboxArea(cachedBounds(Number(id)));
  return claimsFrom(samples, areaOf);
}

/**
 * Recompute the two things that depend on what is currently on screen: which
 * features are de-jure claims, and which subdivisions belong to the focused
 * polity.
 *
 * Both piggyback on the existing debounced pass rather than adding listeners.
 * The allow-list is UNIONED because queryRenderedFeatures only sees the
 * viewport: drilling into a country too big to fit resolved a partial set, and
 * panning to the rest of it used to show nothing at all.
 */
async function refreshOverlaps() {
  const s = pickable()[0];
  if (!s || !map.getLayer(s.pickLayer)) return;

  const next = await computeClaims(
    [s.pickLayer, s.claimLayer].filter((l): l is string => !!l && !!map.getLayer(l)),
  );
  const changed =
    next.length !== claims.length ||
    next.some((v, i) => String(v) !== String(claims[i]));
  if (changed) claims = next;

  // Panning loads new tiles, so a country too big to fit on screen keeps
  // resolving the rest of its subdivisions instead of being stuck with whatever
  // happened to be loaded at drill time.
  let widened = false;
  const tip = focus.trail[focus.trail.length - 1];
  if (tip && focus.allow) {
    const r = childrenOf(tip.osmId, tip.adminLevel);
    const merged = r ? mergeAllow(focus.allow, r.ids) : focus.allow;
    const level = Math.max(focus.maxLevel, r?.level ?? 0);
    if (merged.length !== focus.allow.length || level !== focus.maxLevel) {
      focus = {
        ...focus,
        allow: merged,
        maxLevel: level,
        children: r ? r.nodes.filter((n) => n.adminLevel === level) : focus.children,
        resolved: true,
      };
      widened = true;
      notify();
    }
  }

  // At the world view, work out which countries an empire or union is standing
  // in for. Only there: drilling into the British Empire must bring its members
  // back, and the cost is a point-in-polygon per country per pass.
  let recovered = false;
  if (!focus.trail.length) {
    const next = coveredIds(
      sourceFeatures() ?? [],
      parentOverrides(currentSourceId()),
    );
    if (next.length !== covered.length || next.some((v, i) => v !== covered[i])) {
      covered = next;
      recovered = true;
    }
  } else if (covered.length) {
    covered = [];
    recovered = true;
  }

  if (changed || widened || recovered) applyFilters();
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

  // The claim layer too, or a hatched polity loses its name — the one case
  // where you most need to be told which two countries are involved.
  // The edits overlay too, or a region the user added or renamed has no name on
  // the map — the one label they are most certain about.
  const layers = [s?.claimLayer, "edit-fill"].filter(
    (l): l is string => !!l && !!map.getLayer(l) && l !== layer,
  );
  src.setData(
    buildLabelPoints(map.queryRenderedFeatures({ layers: [layer, ...layers] })) as never,
  );
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

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** Which dataset edits are being written against. */
export const currentSourceId = () => editSourceId();

let editMode = false;
let onEditPick: ((p: Picked | null) => void) | null = null;
/** Armed by "Pick parent": the next click reports a polity instead of selecting. */
let parentPick: ((p: Picked) => void) | null = null;

export function setEditMode(on: boolean, pick?: (p: Picked | null) => void) {
  editMode = on;
  onEditPick = on ? (pick ?? null) : null;
  if (!on) parentPick = null;
  // The overlay is filtered differently in edit mode (it ignores the world-view
  // de-duplication), so the filters have to be rebuilt on the way in AND out.
  if (map) applyFilters();
}

export const armParentPick = (fn: (p: Picked) => void) => {
  parentPick = fn;
};
export const disarmParentPick = () => {
  parentPick = null;
};

/**
 * Geometry for a feature the user is about to edit.
 *
 * Merged across every piece the source currently holds: tiles clip a country
 * into several features, and promoting only the piece under the cursor would
 * silently amputate the rest of it. Multi-piece results become a MultiPolygon.
 *
 * ponytail: what is LOADED, not what exists — an edit made while zoomed far out
 * can snapshot clipped geometry. Upgrade path is Overpass `out geom` per id.
 */
export function geometryOf(osmId: string | number): unknown | null {
  const s = pickable()[0];
  if (!s) return null;
  const [srcId, sourceLayer] = SRC_OF[s.pickLayer] ?? [];
  if (!srcId || !map.getSource(srcId)) return null;
  const want = String(osmId);
  const polys: unknown[] = [];
  for (const f of map.querySourceFeatures(srcId, { sourceLayer })) {
    if (String(f.properties?.osm_id) !== want) continue;
    const g: any = f.geometry;
    if (g?.type === "Polygon") polys.push(g.coordinates);
    else if (g?.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  if (!polys.length) return null;
  return polys.length === 1
    ? { type: "Polygon", coordinates: polys[0] }
    : { type: "MultiPolygon", coordinates: polys };
}

/**
 * Save a property patch, snapshotting geometry so the overlay can draw it.
 *
 * Returns false when no geometry could be captured — the edit is still stored,
 * but the original keeps rendering unedited until it is saved again with the
 * feature on screen. Reported rather than silent: this used to leave the region
 * excluded from its dataset and absent from the overlay, i.e. gone.
 */
export function saveEdit(
  osmId: string | number,
  props: Partial<EditProps>,
): boolean {
  const src = currentSourceId();
  const geom = geometryOf(osmId);
  setOverride(src, osmId, props, geom ?? undefined);
  // An added region carries its own geometry and never needs a snapshot.
  const added = loadEdits()[src]?.added.some(
    (f) => String(f.properties.osm_id) === String(osmId),
  );
  return !!added || !!geom || !!loadEdits()[src]?.overrides[String(osmId)]?.geometry;
}

/**
 * Draw a new region, then hand it back for the form to fill in.
 *
 * Returns the synthetic id, or null when the draw was cancelled. The feature is
 * stored immediately so a half-filled region is still visible and editable
 * rather than being lost if the panel closes.
 */
export async function drawRegion(): Promise<string | null> {
  const geometry = await startPolygon(map);
  if (!geometry) return null;
  const src = currentSourceId();
  const doc = loadEdits()[src];
  const id = newEditId(src, (doc?.added.length ?? 0) + 1);
  const feat: EditFeature = {
    type: "Feature",
    geometry,
    properties: {
      osm_id: id,
      name: "New region",
      admin_level: COUNTRY_LEVEL,
    },
  };
  addFeature(src, feat);
  return id;
}

// Re-render whenever the edit set changes, from anywhere.
onEditsChange(() => {
  if (!map) return;
  refreshEdits();
  applyFilters();
  queueLabels();
});

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
