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
  savedCustomSources,
  saveSources,
  savedSources,
  syncCustomSources,
  type Source,
} from "./sources.ts";
import {
  emptyScene,
  labelTextExpr,
  rankMatches,
  savedDisplay,
  saveDisplay,
  sceneFilter,
  type Display,
  type Hit as SearchHit,
  type Scene,
} from "./view.ts";
import {
  annotFeatures,
  cardCanvas,
  loadAnnots,
  onAnnotsChange,
  primeImages,
  visibleLayers,
  type AnnotLayer,
} from "./annot.ts";
import { distinctIds, stripGeometry, stripTargets } from "./strip.ts";
import { buildLabelPoints } from "./labels.ts";
import { bboxArea, claimsFrom, overlappingIds, type Sample } from "./claims.ts";
import { featureArea, labelPoint } from "./geo.ts";
import {
  childIds,
  COUNTRY_LEVEL,
  coveredIds,
  focusFilter,
  initialFocus,
  mergeAllow,
  nextLevel,
  ROOT_LEVEL,
  type FocusState,
  type Level,
} from "./focus.ts";
import {
  addFeature,
  changesDisplay,
  editFeatures,
  excludedIds,
  flagOverrides,
  loadEdits,
  newEditId,
  onEditsChange,
  parentOverrides,
  setAddedGeometry,
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
/** Sidebar view options — fill, label parts, projection. */
let display: Display = savedDisplay();
/** Studio's shot list. Only enforced while Studio is the active mode. */
let scene: Scene = emptyScene();
let sceneOn = false;
/** Which Studio layer's annotations are live. Exactly one at a time. */
let annotLayer: AnnotLayer = "photo";

export const getDisplay = () => display;
export const getScene = () => scene;
export const getAnnotLayer = () => annotLayer;

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
  // The edits overlay carries the same dates as any dataset, but never the
  // exclusion — it IS the replacement.
  //
  // And in edit mode, no hierarchy filter at all. An edit must always be
  // visible to the person making it, and two separate parts of the focus filter
  // were hiding one:
  //
  //  * `covered`: saying "this region belongs to that empire" puts it straight
  //    into the de-duplicated set, so a parent edit looked exactly like a
  //    delete.
  //  * `maxLevel`: the world view draws to level 2, so a region drawn at level
  //    3 or deeper vanished the instant it was saved — you drew it, the editor
  //    reported success, and the map showed nothing.
  const fEdits = editMode ? null : f;
  for (const id of EDIT_LAYERS)
    if (map.getLayer(id))
      map.setFilter(id, ["all", date, ...(fEdits ? [fEdits] : [])] as never);

  // The shot list is the ONE thing labels are filtered on rather than masked:
  // a symbol layer is not something you click, so nothing is lost by removing
  // it outright, and a name floating over ground that is not in the shot is
  // exactly what the picker is for.
  const sc = sceneOn ? sceneFilter(scene) : null;
  // Same exemption as the overlay above, for the same reason: a region drawn at
  // a level below the current view would otherwise be an unnamed amber blob.
  const named: any = editMode ? ["any", f, isEditFeature()] : f;
  if (map.getLayer("hist-label"))
    map.setFilter("hist-label", ["all", date, named, ...(sc ? [sc] : [])] as never);
}

/** "Is this one of the user's own features?", as a filter clause. An explicit
 *  id list rather than a prefix test, because an EDITED original keeps the
 *  dataset's numeric id and only an added region carries an "edit-…" one. */
function isEditFeature(): unknown {
  const ids = editFeatures(editSourceId()).features.map((f) => f.properties.osm_id);
  return ids.length
    ? ["in", ["get", "osm_id"], ["literal", ids]]
    : ["==", ["literal", 1], 0];
}

// ---------------------------------------------------------------------------
// Display options
// ---------------------------------------------------------------------------

/** The fill-opacity each layer uses when fills are ON. Only the three that
 *  differ from the shared default need an entry. */
const FILL_OPACITY: Record<string, unknown> = {
  "ohm-claim": 0.5,
  "ohm-occupation": [
    "case",
    ["boolean", ["feature-state", "hover"], false], 0.6,
    0.45,
  ],
  "edit-fill": fillOpacity(0.2),
};

/** Line opacity each layer uses when it is in the shot. */
const LINE_OPACITY: Record<string, number> = {
  "ohm-claim-line": 0.8,
  "edit-line": 0.95,
};

/**
 * Territory fill and line opacity: the colour-fill toggle and the Studio shot
 * list, which both come down to "how visible is this layer".
 *
 * Zero opacity rather than a filter or a layer removal, and that is the whole
 * point. The fills are what hover and click hit-test against, and MapLibre
 * still returns features from a fill layer at opacity 0. Filtering the shot
 * list out — the first version — meant that under "Nothing" there was no
 * polygon left anywhere to click, so nothing could ever be added back IN. A
 * mask keeps every territory selectable while showing only the chosen ones.
 */
function applyPaint() {
  const sc = sceneOn ? sceneFilter(scene) : null;
  const mask = (on: unknown) => (sc ? ["case", sc, on, 0] : on);
  const ids = [...active().flatMap((s) => s.layers), ...EDIT_LAYERS];
  for (const id of ids) {
    const l = map.getLayer(id);
    if (!l) continue;
    // Cosmetic overlays are not territories and take no part in the shot list.
    if (id.startsWith("today-")) continue;
    if (l.type === "fill")
      map.setPaintProperty(
        id,
        "fill-opacity",
        mask(display.fill ? (FILL_OPACITY[id] ?? fillOpacity()) : 0) as never,
      );
    else if (l.type === "line")
      map.setPaintProperty(
        id,
        "line-opacity",
        mask(LINE_OPACITY[id] ?? 0.9) as never,
      );
  }
}

const FLAG_IMAGE: unknown = ["image", ["concat", "flag:", ["get", "osm_id"]]];

function applyLabels() {
  if (!map.getLayer("hist-label")) return;
  map.setLayoutProperty("hist-label", "text-field", labelTextExpr(display, yearOf) as never);
  map.setLayoutProperty(
    "hist-label",
    "icon-image",
    (display.labelFlag ? FLAG_IMAGE : null) as never,
  );
}

/** Apply and persist the sidebar's view options. */
export function setDisplay(next: Display) {
  const projectionChanged = next.projection !== display.projection;
  display = next;
  saveDisplay(display);
  if (!map) return;
  applyPaint();
  applyLabels();
  if (projectionChanged) map.setProjection({ type: display.projection });
}

/** Replace the Studio shot list. */
export function setScene(next: Scene) {
  scene = next;
  applyPaint();
  applyFilters();
}

/** Whether the shot list is enforced — Studio on, every other mode off. */
export function setSceneActive(on: boolean) {
  sceneOn = on;
  if (!map) return;
  applyPaint();
  applyFilters();
}

const EDIT_LAYERS = ["edit-fill", "edit-line"];

/** Push the current source's edits into the overlay. */
function refreshEdits() {
  const src = map?.getSource("hist-edits") as maplibregl.GeoJSONSource | undefined;
  src?.setData(editFeatures(editSourceId()) as never);
}

/** Ids currently flagged `member`, so the flag can be cleared when an edit goes. */
let memberFlags: (string | number)[] = [];

/**
 * Paint every region assigned to an EMPIRE (a level-1 parent) in the empire's
 * colour by flagging it `member` — the paint expressions in sources.ts read that
 * feature-state. A tile filter cannot look up "does this belong to that", so the
 * membership has to be pushed onto the features here, and re-pushed whenever the
 * edits change or new tiles arrive (feature-state itself survives tile loads).
 * Only level-1 parents qualify: assigning a province to a country must not turn
 * it violet, which is the empire hue.
 */
function applyMemberState() {
  if (!map?.getSource("hist-ohm")) return;
  const set = (id: string | number, on: boolean) => {
    map.setFeatureState(
      { source: "hist-ohm", sourceLayer: "boundaries", id },
      { member: on },
    );
    if (map.getSource("hist-edits"))
      map.setFeatureState({ source: "hist-edits", id }, { member: on });
  };
  for (const id of memberFlags) set(id, false);
  memberFlags = [];

  const parents = parentOverrides(currentSourceId());
  if (!parents.size) return;
  const roots = new Set<string>();
  for (const f of map.querySourceFeatures("hist-ohm", { sourceLayer: "boundaries" }))
    if (Number(f.properties?.admin_level) === ROOT_LEVEL)
      roots.add(String(f.properties?.osm_id));

  for (const [child, parent] of parents) {
    if (!roots.has(parent)) continue;
    const n = Number(child);
    const id = Number.isFinite(n) && child.trim() !== "" ? n : child;
    set(id, true);
    memberFlags.push(id);
  }
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

// ---------------------------------------------------------------------------
// Studio annotations
// ---------------------------------------------------------------------------

/**
 * Captions and cards, composited to images and drawn as map symbols.
 *
 * On top of everything, and deliberately outside every filter: an annotation is
 * the user's own writing, so it must not disappear because the polity under it
 * fell out of the date range.
 */
function addAnnotLayer() {
  if (!map.getSource("hist-annot"))
    map.addSource("hist-annot", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  if (map.getLayer("annot")) return;
  map.addLayer({
    id: "annot",
    type: "symbol",
    source: "hist-annot",
    layout: {
      "icon-image": ["image", ["concat", "annot:", ["get", "id"]]],
      // Annotations are placed by hand, so they must never be dropped or
      // shuffled by the collision solver the way generated labels are.
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-anchor": "center",
    },
  });
}

let annotRefresh: Promise<void> | null = null;

/**
 * Re-composite every annotation on the active layer and push the points.
 *
 * remove-then-add rather than updateImage: a card's pixel size changes the
 * moment its text or font size does, and updateImage requires the replacement
 * to be exactly the same dimensions.
 */
export function refreshAnnots(): Promise<void> {
  if (!map?.getSource("hist-annot")) return Promise.resolve();
  // Serialised: primeImages awaits decodes, and two overlapping passes would
  // both remove and re-add the same image key.
  annotRefresh = (annotRefresh ?? Promise.resolve()).then(async () => {
    // Every VISIBLE layer draws, not only the active one. Active decides what
    // you are editing and which kind of file Export produces; visibility is a
    // separate switch, so a caption composed on the photo layer can stay on
    // screen while the fly-through is built beside it.
    const shown = visibleLayers();
    const mine = loadAnnots().filter((a) => shown.includes(a.layer));
    await primeImages(mine);
    for (const a of mine) {
      const c = cardCanvas(a);
      const g = c?.getContext("2d");
      if (!c || !g) continue;
      const key = `annot:${a.id}`;
      if (map.hasImage(key)) map.removeImage(key);
      map.addImage(key, g.getImageData(0, 0, c.width, c.height) as never, {
        pixelRatio: 2,
      });
    }
    (map.getSource("hist-annot") as maplibregl.GeoJSONSource | undefined)?.setData(
      annotFeatures(loadAnnots(), shown) as never,
    );
  });
  return annotRefresh;
}

/** Switch between the photo and video annotation layers. */
export function setAnnotLayer(layer: AnnotLayer) {
  annotLayer = layer;
  void refreshAnnots();
}

/** Armed by "Place": the next map click reports where, instead of selecting. */
let placePick: ((at: [number, number]) => void) | null = null;
export const armPlace = (fn: (at: [number, number]) => void) => {
  placePick = fn;
};
export const disarmPlace = () => {
  placePick = null;
};

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

// The text is now assembled by labelTextExpr in view.ts, because which PARTS
// are shown (name, dates) is a sidebar toggle and "neither" has to collapse to
// an empty string rather than a lone newline.

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

// ---- Named custom basemaps -------------------------------------------------
// A pasted style URL used to live in the single `basemap` slot, anonymous and
// one-at-a-time. These persist a NAMED list beside it (same JSON-array shape as
// savedSources), so a MapTiler style can be saved once and picked again next
// session. `basemap` still holds the active choice — now possibly a custom id.

export type CustomBasemap = { id: string; label: string; url: string };
const CUSTOM_STORE = "basemaps:custom";

export function savedCustomBasemaps(): CustomBasemap[] {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_STORE) ?? "[]");
    return Array.isArray(v)
      ? v.filter(
          (b) => b && typeof b.id === "string" && typeof b.url === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** Save (or re-label) a style URL and return its entry. Same URL is reused
 *  rather than duplicated, so re-saving is idempotent. */
export function saveCustomBasemap(label: string, url: string): CustomBasemap {
  const list = savedCustomBasemaps();
  const existing = list.find((b) => b.url === url);
  if (existing) {
    if (label && label !== existing.label) {
      existing.label = label;
      localStorage.setItem(CUSTOM_STORE, JSON.stringify(list));
    }
    return existing;
  }
  const n =
    list.reduce((m, b) => Math.max(m, Number(b.id.slice(7)) || 0), 0) + 1;
  const entry = { id: `custom-${n}`, label: label || `Custom ${n}`, url };
  localStorage.setItem(CUSTOM_STORE, JSON.stringify([...list, entry]));
  return entry;
}

export function removeCustomBasemap(id: string) {
  localStorage.setItem(
    CUSTOM_STORE,
    JSON.stringify(savedCustomBasemaps().filter((b) => b.id !== id)),
  );
}

/**
 * Swap the backdrop. `choice` is a BASEMAPS id, a saved custom id, or any style
 * URL — a MapTiler `https://api.maptiler.com/maps/<style>/style.json?key=…`
 * pastes straight in.
 */
export async function setBasemap(choice: string) {
  localStorage.setItem(STORE, choice);
  const preset = BASEMAPS.find((b) => b.id === choice);
  const custom = savedCustomBasemaps().find((b) => b.id === choice);
  // setStyle wipes every source and layer, ours included. The persistent
  // styledata listener installed in initMap puts them back — NOT a `once` here,
  // because styledata can fire while the outgoing style is still torn down, and
  // that first event would be consumed by a no-op.
  const style = preset ? await preset.style() : (custom?.url ?? choice);
  map.setStyle(style as StyleSpecification);
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
    // Last, so captions and cards sit above every border layer and every label.
    addAnnotLayer();
    if (clip) ensureClipMask();
    applyMemberState();
    applyPaint();
    applyLabels();
    applyFilters();
    queueLabels();
    void refreshAnnots();
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
function ensureOceanSource() {
  if (!map.getSource("hist-ocean"))
    map.addSource("hist-ocean", {
      type: "vector",
      url: BASEMAP_TILES,
      attribution: "© OpenStreetMap, Protomaps",
    } as never);
}

/**
 * Keep the sea tiles loaded so the border strip can carve them out.
 *
 * A source with no layer referencing it fetches nothing, so querySourceFeatures
 * would return an empty list and "strip oceans" would silently do nothing. An
 * invisible fill is what makes the tiles arrive. Nothing is added when the
 * coastline clip is already on — its mask loads the same tiles.
 */
export function setStripOceans(on: boolean) {
  if (!map) return;
  if (!on || clip) {
    if (map.getLayer("ocean-probe")) map.removeLayer("ocean-probe");
    return;
  }
  ensureOceanSource();
  if (map.getLayer("ocean-probe")) return;
  map.addLayer(
    {
      id: "ocean-probe",
      type: "fill",
      source: "hist-ocean",
      "source-layer": "water",
      paint: { "fill-opacity": 0 },
    },
    map.getLayer("hist-label") ? "hist-label" : undefined,
  );
}

/**
 * Salt water to carve out of a drawn region.
 *
 * queryRenderedFeatures, NOT querySourceFeatures, and the difference is the
 * whole feature working. The source keeps parent tiles cached, so asking it for
 * water hands back the z2 ocean as well as the z6 one — and the z2 coastline is
 * simplified far enough inland that stripping against it deleted the LAND too
 * (measured: a box half in the Adriatic came back 0.004 deg², all of Abruzzo
 * gone). The rendered set is only the tiles actually being drawn at this zoom,
 * which is the coastline the user can see.
 *
 * Lakes and rivers are excluded by OCEAN_KINDS, the same rule the coastline
 * clip uses, so a Great-Lakes border is never treated as sea.
 */
function oceanFeatures(): { properties: any; geometry: any }[] {
  const layer = ["ocean-mask", "ocean-probe"].find((l) => map.getLayer(l));
  if (!layer) return [];
  return map
    .queryRenderedFeatures({ layers: [layer] })
    .filter((f) => OCEAN_KINDS.includes(String(f.properties?.kind)))
    .map((f, i) => ({ properties: { osm_id: `sea-${i}` }, geometry: f.geometry }));
}

function ensureClipMask() {
  ensureOceanSource();

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
      "text-field": labelTextExpr(display, yearOf) as never,
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
      "icon-image": (display.labelFlag ? FLAG_IMAGE : null) as never,
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
    const sid = srcIdOf(s.id);
    if (map.getSource(sid)) map.removeSource(sid);
  }

  // A user-added dataset that has just been DELETED is no longer in SOURCES, so
  // the loop above cannot find its layers to take down — they stayed attached
  // and kept drawing a dataset the settings panel said was gone. Sweep those by
  // source id instead of by registration.
  const live = new Set(
    SOURCES.filter((s) => enabled.includes(s.id)).map((s) => srcIdOf(s.id)),
  );
  const orphan = (sid: unknown) =>
    typeof sid === "string" && sid.startsWith("hist-src-") && !live.has(sid);
  for (const l of map.getStyle().layers)
    if (orphan((l as { source?: unknown }).source)) map.removeLayer(l.id);
  for (const sid of Object.keys(map.getStyle().sources))
    if (orphan(sid)) map.removeSource(sid);

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
  // Before savedSources(): normaliseSources drops any id it does not recognise,
  // so a user-added dataset saved as the active one would silently revert to
  // OHM on every reload if its Source did not exist yet.
  syncCustomSources();
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

  // The bottom-left scale bar. MapLibre ships one that already tracks zoom and
  // latitude, so there is nothing here to compute or keep in sync.
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

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

  if (display.projection !== "mercator")
    map.setProjection({ type: display.projection });

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

/** MapLibre source behind a layer, for the built-ins and for user-added
 *  datasets alike — those name their layers "<sourceId>-fill" / "-line". */
function srcOf(layer: string): [string, string | undefined] | [] {
  const hit = SRC_OF[layer];
  if (hit) return hit;
  const sid = layer.replace(/-(fill|line)$/, "");
  const c = savedCustomSources().find((x) => x.id === sid);
  if (!c) return [];
  return [
    `hist-${sid}`,
    c.kind === "vector" ? (c.sourceLayer ?? "boundaries") : undefined,
  ];
}

const srcIdOf = (id: string) => SRC_ID[id] ?? `hist-${id}`;

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
let pickedGroup: (string | number)[] = [];

/**
 * The regions the user assigned to `parentId`, so an empire and its members
 * light up as one. A detached colony like the State of Brazil is a separate
 * polygon from the Portuguese Empire — geometry alone can never join them — so
 * the parent edit is the only thing that says they belong together, and this is
 * what makes selecting the empire show its true extent.
 */
function membersOf(parentId: string | number): (string | number)[] {
  const pid = String(parentId);
  const out: (string | number)[] = [];
  for (const [child, parent] of parentOverrides(currentSourceId())) {
    if (parent !== pid) continue;
    const n = Number(child);
    out.push(Number.isFinite(n) && child.trim() !== "" ? n : child);
  }
  return out;
}

/**
 * Is an empire/union fill actually rendered at this lng/lat? The covered-country
 * test in focus.ts uses tile-clipped geometry and can mark a country as covered
 * where the rendered empire in fact has a hole (the reported empty France), so
 * coveredIds only trusts a candidate once this confirms the GPU drew an empire
 * over it — a hidden country is then never an unpainted hole. queryRenderedFeatures
 * reads the composited frame, so it is meaningful only after the view has settled,
 * which is exactly when refreshOverlaps runs.
 */
function empireFillAt(centre: [number, number]): boolean {
  if (!map?.getLayer("ohm-fill")) return false;
  const p = map.project(centre);
  return map
    .queryRenderedFeatures(p, { layers: ["ohm-fill"] })
    .some((f) => Number(f.properties?.admin_level) <= ROOT_LEVEL);
}

/** osm_ids of the empires/unions in the loaded tiles, so membership can be
 *  gated on a REAL level-1 parent rather than any assigned id. */
function rootEmpireIds(): Set<string> {
  const out = new Set<string>();
  if (!map?.getSource("hist-ohm")) return out;
  for (const f of map.querySourceFeatures("hist-ohm", { sourceLayer: "boundaries" }))
    if (Number(f.properties?.admin_level) === ROOT_LEVEL)
      out.add(String(f.properties?.osm_id));
  return out;
}

/**
 * The empire a region was assigned to, or null. At the world view a member acts
 * AS its empire: hovering it animates the whole empire territory, and clicking
 * it opens the empire. Only a level-1 parent counts — assigning a province to a
 * country does not make the province stand in for the country.
 */
function parentEmpireOf(id: string | number): string | null {
  const parent = parentOverrides(currentSourceId()).get(String(id));
  if (parent === undefined) return null;
  return rootEmpireIds().has(parent) ? parent : null;
}

const asId = (id: string): string | number => {
  const n = Number(id);
  return Number.isFinite(n) && id.trim() !== "" ? n : id;
};

/** The whole territory to light up for `id`: the empire it belongs to (or is)
 *  plus every member. Empty when `id` is a plain polity with no empire ties. */
function highlightGroup(id: string | number): (string | number)[] {
  const empire = parentEmpireOf(id);
  if (empire !== null) return [asId(empire), ...membersOf(empire)];
  const mine = membersOf(id);
  return mine.length ? [id, ...mine] : [];
}

/** A Picked for an empire by id, from the loaded tiles. Falls back to a bare
 *  record so a click still opens something even if the empire is off-tile. */
function empirePicked(empireId: string): Picked {
  if (map.getSource("hist-ohm"))
    for (const f of map.querySourceFeatures("hist-ohm", { sourceLayer: "boundaries" }))
      if (String(f.properties?.osm_id) === empireId && f.properties)
        return toPicked(f.properties);
  return { osmId: asId(empireId), name: "Empire", adminLevel: ROOT_LEVEL };
}

/**
 * Set hover/selected on a group across BOTH dataset sources: a member is drawn
 * natively from hist-ohm when the edit is parent-only, or from the hist-edits
 * overlay when it also has a display edit. Writing to a source where the id is
 * absent is a harmless no-op.
 */
function setGroupState(
  ids: (string | number)[],
  key: "selected" | "hover",
  on: boolean,
) {
  for (const id of ids) {
    if (map.getSource("hist-ohm"))
      map.setFeatureState(
        { source: "hist-ohm", sourceLayer: "boundaries", id },
        { [key]: on },
      );
    if (map.getSource("hist-edits"))
      map.setFeatureState({ source: "hist-edits", id }, { [key]: on });
  }
}

function setSelected(hit: Hit | null) {
  if (picked) {
    const [src, sl] = srcOf(picked.layer);
    if (src) map.setFeatureState(stateRef(src, sl, picked.id), { selected: false });
  }
  if (pickedGroup.length) setGroupState(pickedGroup, "selected", false);
  pickedGroup = [];
  picked = null;
  if (!hit || hit.f.id === undefined) return;
  const [src, sl] = srcOf(hit.layer);
  if (!src) return;
  picked = { layer: hit.layer, id: hit.f.id };
  map.setFeatureState(stateRef(src, sl, hit.f.id), { selected: true });
  pickedGroup = highlightGroup(hit.f.id);
  if (pickedGroup.length) setGroupState(pickedGroup, "selected", true);
}

/** Select an empire by id (its whole territory), for a click that landed on one
 *  of its detached members at the world view. */
function selectEmpire(empireId: string) {
  setSelected({ layer: "ohm-fill", source: null as never, f: { id: asId(empireId) } as never });
}

function bindHover() {
  let hot: { layer: string; id: string | number } | null = null;
  let hotGroup: (string | number)[] = [];
  const clear = () => {
    if (hot) {
      const [src, sl] = srcOf(hot.layer);
      if (src) map.setFeatureState(stateRef(src, sl, hot.id), { hover: false });
    }
    if (hotGroup.length) setGroupState(hotGroup, "hover", false);
    hotGroup = [];
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
    const [src, sl] = srcOf(hit.layer);
    if (src) {
      hot = { layer: hit.layer, id: hit.f.id };
      map.setFeatureState(stateRef(src, sl, hit.f.id), { hover: true });
      // Hovering an empire OR one of its members animates the whole territory.
      hotGroup = highlightGroup(hit.f.id);
      if (hotGroup.length) setGroupState(hotGroup, "hover", true);
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

  // Drilled in, only the focused polity's own subtree is selectable. Everything
  // else — sibling empires, unrelated countries — stays drawn for context but is
  // LOCKED: inside the British Empire you must not be able to click into the
  // French Colonial Empire, which is no child of it. The allow-list is exactly
  // that subtree (see focus.ts); at the world view there is no restriction.
  const restrict =
    !editMode && focus.trail.length
      ? new Set((focus.allow ?? []).map(String))
      : null;
  const selectable = (id: string) => !restrict || restrict.has(id);

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
        if (!seen.has(id) && selectable(id) && s)
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
    // Lock to the focused subtree when drilled in.
    list = list.filter(([id]) => selectable(id));

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
    // Placing an annotation consumes the click outright: it is about a spot on
    // the map, not about whatever polity happens to be under it.
    if (placePick) {
      const fn = placePick;
      placePick = null;
      return fn([e.lngLat.lng, e.lngLat.lat]);
    }

    // The whole stack, not only the winner. Where two polities genuinely
    // overlap — a de-facto occupier and the de-jure claimant it displaced —
    // the loser was previously unreachable by any click at all.
    const hits = hitsAt(e.point).filter((h) => h.f.properties);

    // Studio: a click is "put this in the shot" / "take it out". The selection
    // highlight still moves, so it is obvious which one just changed.
    if (scenePick) {
      setSelected(hits[0] ?? null);
      return scenePick(hits[0] ? toPicked(hits[0].f.properties!) : null, [
        e.lngLat.lng,
        e.lngLat.lat,
      ]);
    }

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

    // At the world view, clicking a member opens its EMPIRE, not the member —
    // the member is the empire's territory, so the empire is what you meant.
    const empire =
      hits[0]?.f.id !== undefined && !focus.trail.length
        ? parentEmpireOf(hits[0].f.id)
        : null;
    if (empire !== null) {
      selectEmpire(empire);
      return onPick(empirePicked(empire), []);
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
    // Double-clicking a member drills into its empire, same logic as the single
    // click: the member stands in for the empire at the world view.
    const empire =
      hit.f.id !== undefined && !focus.trail.length
        ? parentEmpireOf(hit.f.id)
        : null;
    void drillInto(empire !== null ? empirePicked(empire) : toPicked(hit.f.properties));
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
  const [srcId, sourceLayer] = srcOf(s.pickLayer);
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
      empireFillAt,
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
  // Tiles for an empire (or its detached member) can arrive after the edit was
  // made, so re-flag membership once the current view has settled.
  applyMemberState();
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
/**
 * Flags the USER supplied, registered under the same `flag:<osm_id>` key the
 * label layer already reads.
 *
 * Registered before the Wikidata pass and marked `asked`, so a corrected flag is
 * never quietly replaced by whatever Commons happens to hold. Keyed on the URL
 * so re-running this is free until the picture actually changes.
 */
const flagUrlOf = new Map<string, string>();

async function applyFlagOverrides() {
  if (!map?.getLayer("hist-label")) return;
  for (const [id, url] of flagOverrides(currentSourceId())) {
    const key = `flag:${id}`;
    if (flagUrlOf.get(key) === url) continue;
    flagUrlOf.set(key, url);
    const n = Number(id);
    if (Number.isFinite(n)) asked.add(n); // keep the Wikidata pass off it
    try {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      if (map.hasImage(key)) map.removeImage(key);
      map.addImage(key, bitmap);
    } catch {
      // A remote URL that blocks CORS cannot become a map icon (a Commons
      // Special:FilePath link is the usual case — its 302 sends no headers).
      // The detail card still shows it; the map falls back to text-only.
      flagUrlOf.delete(key);
    }
  }
}

async function loadFlags() {
  if (!map.getLayer("hist-label")) return;
  await applyFlagOverrides();
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

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Name search over the active dataset.
 *
 * ponytail: searches the tiles currently LOADED, which at the world view is
 * every country and at a city zoom is only what is on screen. Upgrade path is
 * an OHM Nominatim call; the offline answer is good enough that adding a
 * network round trip to every keystroke would be the worse trade.
 */
export function searchPolities(q: string, limit = 8): SearchHit[] {
  const feats = sourceFeatures() ?? [];
  const items: SearchHit[] = [];
  for (const f of feats) {
    const p = f.properties ?? {};
    const name = String(p["name:en"] || p.name || "");
    if (!name || p.osm_id === undefined) continue;
    items.push({
      id: p.osm_id,
      name,
      level: Number(p.admin_level) || 9,
    });
  }
  return rankMatches(q, items, limit);
}

/**
 * Frame a polity by id and select it. Returns what to show in the detail card,
 * or null when it is no longer in the loaded tiles (the timeline moved past it).
 */
export async function gotoPolity(id: string | number): Promise<Picked | null> {
  const want = String(id);
  const feats = (sourceFeatures() ?? []).filter(
    (f) => String(f.properties?.osm_id) === want,
  );
  if (!feats.length) return null;

  // Overpass bounds frame the WHOLE polity; the loaded tiles only know the part
  // that happens to be on screen, so they are the fallback rather than the plan.
  const nid = numericId(id);
  if (nid !== null) await fetchTags([nid]);
  const b = nid === null ? undefined : cachedBounds(nid);
  if (b) fitTo(b);
  else {
    const at = feats.map((f) => labelPointOf(f.geometry)).find(Boolean);
    if (at) map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 4), duration: 700 });
  }

  const props = feats[0].properties!;
  setSelected({ layer: pickable()[0]?.pickLayer ?? "ohm-fill", source: null as never, f: feats[0] as never });
  return toPicked(props);
}

const labelPointOf = (g: unknown): [number, number] | null =>
  (g ? (labelPoint(g) ?? null)?.at ?? null : null);

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** Which dataset edits are being written against. */
export const currentSourceId = () => editSourceId();

let editMode = false;
let onEditPick: ((p: Picked | null) => void) | null = null;
/** Armed by "Pick parent": the next click reports a polity instead of selecting. */
let parentPick: ((p: Picked) => void) | null = null;
/** Set while Studio is open: a click adds to or removes from the shot list.
 *  Carries the clicked point too, so a card can be anchored where you clicked. */
type ScenePick = (p: Picked | null, at: [number, number]) => void;
let scenePick: ScenePick | null = null;

export function setScenePick(fn: ScenePick | null) {
  scenePick = fn;
}

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
  const [srcId, sourceLayer] = srcOf(s.pickLayer);
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
  // A parent-only edit leaves the original polygon on screen, so there is
  // nothing to snapshot and nothing to warn about — it always applies.
  if (!changesDisplay(props)) {
    setOverride(src, osmId, props);
    return true;
  }
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
export type DrawOpts = {
  /** Hierarchy level chosen BEFORE drawing — it decides what gets stripped. */
  level: number;
  /** The polity this one sits inside, if any. Never stripped from the result. */
  parent?: string | number;
  /** Carve existing territory out of the drawn shape. */
  strip: boolean;
  /** Carve the sea out too, so the result stops at the coastline. */
  oceans?: boolean;
};

/**
 * Everything a drawn shape is carved against: neighbouring territory, and
 * optionally the sea.
 *
 * The wait guards the sea only. Water tiles are fetched the moment the option
 * is armed, so a draw that starts immediately after can find MapLibre still
 * showing parent tiles as placeholders — and a low-zoom coastline is simplified
 * far enough inland to swallow whole provinces. Waiting costs nothing once the
 * tiles are in, which after a few clicks they normally are.
 */
async function stripSet(
  level: number,
  parent?: string | number,
  oceans?: boolean,
  self?: string | number,
) {
  if (oceans) await whenIdle();
  const land = stripTargets(sourceFeatures() ?? [], level, parent, self);
  return oceans ? [...land, ...oceanFeatures()] : land;
}

export type DrawResult =
  /** Saved. `stripped` is how many existing regions were carved out. */
  | { id: string; stripped: number }
  /** The drawn area was entirely claimed already; nothing was saved. */
  | { id: null; stripped: number; empty: true };

export async function drawRegion(opts: DrawOpts): Promise<DrawResult | null> {
  const raw = await startPolygon(map);
  if (!raw) return null;

  let geometry: unknown = raw;
  let stripped = 0;
  if (opts.strip) {
    const targets = await stripSet(opts.level, opts.parent, opts.oceans);
    // Sea polygons are not "regions" and must not be counted as such — the
    // editor reports how many existing STATES were carved out.
    stripped = distinctIds(targets.filter((f) => !String(f.properties?.osm_id).startsWith("sea-")));
    const cut = stripGeometry(raw, targets);
    // Nothing left means every square metre drawn already belongs to somebody.
    // Saying so beats saving an empty geometry, which renders as nothing and is
    // indistinguishable from the editor silently failing.
    if (!cut) return { id: null, stripped, empty: true };
    geometry = cut;
  }

  const src = currentSourceId();
  const doc = loadEdits()[src];
  const id = newEditId(src, (doc?.added.length ?? 0) + 1);
  const feat: EditFeature = {
    type: "Feature",
    geometry,
    properties: {
      osm_id: id,
      name: "New region",
      admin_level: opts.level || COUNTRY_LEVEL,
      ...(opts.parent === undefined ? {} : { parent: opts.parent }),
    },
  };
  addFeature(src, feat);
  return { id, stripped };
}

/**
 * Re-run the strip on a region the user already drew — for switching the option
 * on after the fact, or re-applying it once the neighbours it should be carved
 * against have actually loaded.
 *
 * Returns how many regions were carved out, or null when the id is not one of
 * the user's own regions or nothing would be left of it.
 */
export async function restripRegion(
  osmId: string | number,
  level: number,
  parent?: string | number,
  oceans?: boolean,
): Promise<number | null> {
  const src = currentSourceId();
  const feat = loadEdits()[src]?.added.find(
    (f) => String(f.properties.osm_id) === String(osmId),
  );
  if (!feat?.geometry) return null;
  const targets = await stripSet(level, parent, oceans, osmId);
  const cut = stripGeometry(feat.geometry, targets);
  if (!cut) return null;
  setAddedGeometry(src, osmId, cut);
  return distinctIds(targets.filter((f) => !String(f.properties?.osm_id).startsWith("sea-")));
}

// Re-composite whenever an annotation is added, edited or removed.
onAnnotsChange(() => void refreshAnnots());

// Re-render whenever the edit set changes, from anywhere.
onEditsChange(() => {
  if (!map) return;
  refreshEdits();
  applyMemberState();
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
