// The border datasets, behind one interface.
//
// No single open dataset covers all of history: OHM has 68,911 dated boundaries
// for 1600-1899 but 350 before 1000 AD, while Historical-Basemaps reaches
// 123000 BC at the cost of 4-vertex countries. So they are LAYERABLE, not
// exclusive — enable several and compare. The first enabled source that has a
// feature under the cursor owns hover and click, so facts still come from one
// place.

import type { Map as MLMap } from "maplibre-gl";
import { toDecimalYear } from "./dates.ts";
import { COUNTRY_LEVEL } from "./focus.ts";

/** Absent start = always existed; absent end = still exists. Never null: a null
 *  loses every numeric comparison and would silently erase the feature. */
export const NO_START = -99999;
export const NO_END = 99999;

/** The one date filter every source uses. Pure GPU — no refetch on scrub. */
export const dateFilter = (dec: number): any => [
  "all",
  ["<=", ["coalesce", ["get", "start_num"], ["get", "start_decdate"], NO_START], dec],
  [">=", ["coalesce", ["get", "end_num"], ["get", "end_decdate"], NO_END], dec],
];

/**
 * ONE hover and selection response for every dataset.
 *
 * Each source keeps its own colour — that is useful identity — but the way it
 * reacts to the pointer is now identical. It used to differ per source: OHM
 * lifted from a zoom-interpolated 0.10-0.12 to 0.35, Historical-Basemaps from
 * 0.22 to 0.4, CShapes from 0.16 to 0.4. Switching dataset therefore changed how
 * the map *felt*, and nothing at all marked the polity you had actually clicked.
 */
export const fillOpacity = (base = 0.12): any => [
  "case",
  ["boolean", ["feature-state", "selected"], false], 0.5,
  ["boolean", ["feature-state", "hover"], false], 0.32,
  base,
];

/** Country borders heavier than internal ones, selection heavier than both. */
export const lineWidth = (): any => {
  const country: any = ["<=", ["coalesce", ["get", "admin_level"], 9], COUNTRY_LEVEL];
  const selected: any = ["boolean", ["feature-state", "selected"], false];
  return [
    "interpolate", ["linear"], ["zoom"],
    2, ["case", selected, 2.2, country, 0.7, 0.3],
    10, ["case", selected, 4, country, 2.4, 1],
  ];
};

export type Source = {
  id: string;
  label: string;
  /** Shown in the picker. Licence terms live here. */
  note?: string;
  /** Non-commercial or otherwise restrictive — off by default, warns on enable. */
  restricted?: boolean;
  /**
   * A cosmetic overlay rather than a dataset: stacks on top of whichever border
   * dataset is chosen instead of replacing it, and never owns hover or click.
   */
  overlay?: boolean;
  /** Layer that owns hover/click, or "" for reference-only sources. */
  pickLayer: string;
  /** All hit-testable layers, highest priority first. Defaults to [pickLayer]. */
  pickLayers?: string[];
  /**
   * Layer holding the de-jure claims split out of pickLayer.
   *
   * Overlap detection MUST hit-test pickLayer and this one together. Sampling
   * pickLayer alone is self-defeating: the moment a feature is classified as a
   * claim it leaves that layer, the next pass sees no overlap, and the
   * classification flips back and forth forever.
   */
  claimLayer?: string;
  /** Layer whose features become labels. Falls back to pickLayer. */
  labelLayer?: string;
  /** Every layer this source owns, for date filtering and teardown. */
  layers: string[];
  attach(map: MLMap, beforeId?: string): Promise<void> | void;
  /** Only for sources that must swap data rather than filter it. */
  setDate?(map: MLMap, dec: number): void;
};

// ---------------------------------------------------------------------------
// OpenHistoricalMap
// ---------------------------------------------------------------------------

const OHM_HOSTED = "https://vtiles.openhistoricalmap.org/boundaries/{z}/{x}/{y}";
// Optional-chained: import.meta.env only exists under Vite, and selftest.ts
// imports this module in plain node.
const BASE = (import.meta as any).env?.BASE_URL ?? "/";
const OHM_LOCAL = `${BASE}basemaps/world-historical.pmtiles`;
// Off-Pages PMTiles archive (Cloudflare R2 or similar). R2 has no 100 MB
// per-file cap, so it can hold a higher-maxzoom build than public/basemaps.
// Set VITE_OHM_R2_URL at build time to the object's public URL; empty = unused,
// and detectOhm falls back to the local file, then to the gated hosted tiles.
// The bucket must send CORS (Access-Control-Allow-Origin for the site) and
// honour Range requests — see docs/R2-SETUP.md.
const OHM_R2 = ((import.meta as any).env?.VITE_OHM_R2_URL ?? "").trim();

/**
 * Hosted tiles are gated to zoom 5+ because they ship ~300 name_* fields per
 * feature with no per-zoom simplification: a z3 tile is 4.7 MB and times out.
 * Our own build strips those and simplifies, so it has no gate at all.
 */
export type OhmTiles = {
  local: boolean;
  minzoom: number;
  spec: { url: string } | { tiles: string[] };
};

/**
 * KILL SWITCH for the self-hosted archive. Set false while the published
 * tileset is not trustworthy.
 *
 * TRUE. A local pipeline run (osmium + tippecanoe on the 2026-07-27 planet)
 * produced world-historical.pmtiles: maxzoom 6, 80 MB, and the z0 world tile
 * carries 52,876 boundaries — verified by decoding it, not by trusting a size.
 * That removes the zoom-5 gate (detectOhm reports minzoom 0 for the local set).
 *
 * maxzoom stops at 6 because higher rungs overflow the GitHub Pages 100 MB cap,
 * not because they empty low zooms (they do not — z10 also carried ~52,800 at
 * z0). Measured: z10=837, z8=209, z7=124, z6=80 MB. More high-zoom detail than
 * z6 gives needs off-Pages hosting (Cloudflare R2), not a pipeline change.
 *
 * The file lives in public/basemaps/ for local dev and on the orphan `tiles`
 * branch for production; deploy.yml checks that branch out at build time.
 */
const USE_LOCAL_TILES = true;

let ohmTiles: OhmTiles | null = null;

/** Detected once. Lets the app work before the CI tile build has ever run. */
export async function detectOhm(): Promise<OhmTiles> {
  if (ohmTiles) return ohmTiles;
  if (USE_LOCAL_TILES) {
    // Prefer the off-Pages archive (higher maxzoom) when configured, then the
    // bundled file. Each is probed so a bad URL or blocked CORS quietly falls
    // through to the next candidate instead of blanking the map.
    for (const url of [OHM_R2, OHM_LOCAL]) {
      if (!url) continue;
      try {
        const r = await fetch(url, { method: "HEAD" });
        // A missing file on GitHub Pages returns the 404 page as 200 text/html,
        // so trust the content type, not the status.
        const ok =
          r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
        if (ok) {
          ohmTiles = {
            local: true,
            minzoom: 0,
            spec: { url: `pmtiles://${new URL(url, location.href).href}` },
          };
          return ohmTiles;
        }
      } catch {
        // offline, missing, or CORS-blocked — try the next candidate
      }
    }
  }
  ohmTiles = { local: false, minzoom: 5, spec: { tiles: [OHM_HOSTED] } };
  return ohmTiles;
}

export const ohmIsLocal = () => ohmTiles?.local ?? false;
export const ohmMinZoom = () => ohmTiles?.minzoom ?? 5;

/** Registered by map.ts before the layers are added. See ensureHatch(). */
export const HATCH = "hatch";

/**
 * Occupation-zone fill, atlas style.
 *
 * `occupant` is the OSM/OHM tag for who actually holds the ground;
 * `controlled_by` is the older synonym still in use. Anything unrecognised gets
 * neutral grey rather than vanishing.
 *
 * Honest scope: OHM currently has ZERO features tagged
 * `military=occupation_zone` or `border_type=demilitarized_zone`, 3 tagged
 * `boundary=military` and 14 `boundary=political` — so this renders almost
 * nothing today, and nothing at all for Vichy France 1942. It is wired and
 * correct; the data has to catch up.
 */
export const OCCUPANT_COLOR: any = [
  "match",
  ["coalesce", ["get", "occupant"], ["get", "controlled_by"], ""],
  ["Germany", "Deutsches Reich", "German Reich"], "#dc2626",
  ["Italy", "Regno d'Italia"], "#16a34a",
  ["Soviet Union", "USSR"], "#b91c1c",
  ["United Kingdom", "Britain"], "#2563eb",
  ["United States", "USA"], "#0891b2",
  ["France", "Free Zone", "Vichy France"], "#7c3aed",
  ["Japan"], "#db2777",
  "#9ca3af",
];

const ohm: Source = {
  id: "ohm",
  label: "OpenHistoricalMap",
  note: "ODbL. Day-level dates, strongest from 1600 on.",
  pickLayer: "ohm-fill",
  // Order matters: this is also the hover/click priority. The de-facto polity
  // must win the click, and the de-jure claim beneath it stays reachable from
  // the side sheet's "Also here" list.
  pickLayers: ["ohm-occupation", "ohm-fill", "ohm-claim"],
  claimLayer: "ohm-claim",
  // No labelLayer. A pre-computed one-point-per-polity layer WAS built into our
  // tiles, and tippecanoe's --drop-densest-as-needed threw it away to fit the
  // tile budget — measured at exactly one label per tile at every zoom, which
  // is worse than useless because the app preferred it over the working path.
  // Labels are deduped client-side from the rendered polygons, the same code
  // that already runs against OHM's hosted tiles.
  layers: ["ohm-fill", "ohm-line", "ohm-claim", "ohm-claim-line", "ohm-occupation"],

  async attach(map, beforeId) {
    const t = await detectOhm();
    map.addSource("hist-ohm", {
      type: "vector",
      ...t.spec,
      minzoom: t.minzoom,
      // Only for the HOSTED tiles, which really are z5-12. Our own archive
      // reports its own range, and the build steps that range DOWN when the
      // output will not fit under the Pages 100 MB cap — hardcoding 12 over the
      // top of it would ask for tiles the file does not contain, and the
      // borders would simply vanish above the real maximum instead of
      // overzooming the last level it has.
      ...(t.local ? {} : { maxzoom: 12 }),
      // These tiles carry no feature ids, so feature-state hover has nothing to
      // key on without this. osm_id is unique per feature (verified 980/980)
      // and stable across tiles, so a country split across two tiles highlights
      // as one shape.
      promoteId: "osm_id",
      attribution: "© OpenHistoricalMap",
    } as never);

    map.addLayer(
      {
        id: "ohm-fill",
        type: "fill",
        source: "hist-ohm",
        "source-layer": "boundaries",
        paint: {
          "fill-color": [
            "case",
            ["has", "disputed_by"], "#d97706",
            // Empires and unions read as one warm shape at the world view.
            ["<=", ["coalesce", ["get", "admin_level"], 9], 1], "#a78bfa",
            ["==", ["get", "admin_level"], COUNTRY_LEVEL], "#e5e7eb",
            "#94a3b8",
          ],
          "fill-opacity": fillOpacity(),
        },
      },
      beforeId,
    );

    map.addLayer(
      {
        id: "ohm-line",
        type: "line",
        source: "hist-ohm",
        "source-layer": "boundaries",
        paint: {
          "line-color": [
            "case",
            ["has", "disputed_by"], "#f59e0b",
            ["<=", ["coalesce", ["get", "admin_level"], 9], 1], "#c4b5fd",
            ["==", ["get", "admin_level"], COUNTRY_LEVEL], "#f8fafc",
            "#cbd5e1",
          ],
          "line-width": lineWidth(),
          "line-opacity": 0.9,
        },
      },
      beforeId,
    );

    // The de-jure claim. Same source, complementary filter (map.ts owns both):
    // no solid fill, a diagonal hatch instead, so where the Soviet Union still
    // claimed German-occupied Lviv in 1942 you can read the de-facto border
    // underneath rather than two translucent greys fighting.
    map.addLayer(
      {
        id: "ohm-claim",
        type: "fill",
        source: "hist-ohm",
        "source-layer": "boundaries",
        paint: { "fill-pattern": HATCH, "fill-opacity": 0.5 },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: "ohm-claim-line",
        type: "line",
        source: "hist-ohm",
        "source-layer": "boundaries",
        paint: {
          "line-color": "#fbbf24",
          "line-width": 1.2,
          "line-dasharray": [3, 2],
          "line-opacity": 0.8,
        },
      },
      beforeId,
    );

    // Occupation zones / DMZs / political districts. Coloured by who holds the
    // ground, atlas-style. Our own tiles stamp `overlay`; the hosted ones do not,
    // so on hosted tiles this layer is simply always empty.
    map.addLayer(
      {
        id: "ohm-occupation",
        type: "fill",
        source: "hist-ohm",
        "source-layer": "boundaries",
        paint: {
          "fill-color": OCCUPANT_COLOR,
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false], 0.6,
            0.45,
          ],
          "fill-outline-color": "#0f172a",
        },
      },
      beforeId,
    );

  },
};

// ---------------------------------------------------------------------------
// Historical-Basemaps
// ---------------------------------------------------------------------------

/**
 * Historical-Basemaps snapshots carry NAME and nothing else — no dates, no
 * admin_level, no ids. Every feature is a sovereign polity of its snapshot year,
 * so stamp the fields the shared filters need.
 *
 * Without admin_level the hierarchy filter (`admin_level <= 2`) rejected the lot
 * and the source rendered completely empty.
 */
export function normaliseHB(fc: any): any {
  let n = 0;
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? (f.properties = {});
    p.name ??= p.NAME || p.SUBJECTO || p.PARTOF;
    p.admin_level = 2;
    // No stable id in this dataset; index is stable within one snapshot, which
    // is all hover and label dedup need.
    p.osm_id ??= `hb-${n}`;
    n++;
  }
  return fc;
}

const hb: Source = {
  id: "hb",
  label: "Historical-Basemaps",
  note: "GPL-3.0. 123000 BC to 2010 — the only source with ancient coverage. Coarse: some countries are 4 vertices.",
  pickLayer: "hb-fill",
  layers: ["hb-fill", "hb-line"],

  attach(map, beforeId) {
    // BELOW OHM, not above it. These layers used to be inserted before
    // "hist-label", which put 4-vertex coarse borders on top of precise ones and
    // made the real border unreadable wherever both sources had coverage.
    if (map.getLayer("ohm-fill")) beforeId = "ohm-fill";
    map.addSource("hist-hb", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      attribution: "© Historical-Basemaps",
    });
    map.addLayer(
      {
        id: "hb-fill",
        type: "fill",
        source: "hist-hb",
        paint: { "fill-color": "#64748b", "fill-opacity": fillOpacity() },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: "hb-line",
        type: "line",
        source: "hist-hb",
        paint: {
          "line-color": "#cbd5e1",
          "line-width": lineWidth(),
          "line-opacity": 0.9,
        },
      },
      beforeId,
    );
  },
};

// ---------------------------------------------------------------------------
// CShapes 2.0
// ---------------------------------------------------------------------------

const CSHAPES = "https://icr.ethz.ch/data/cshapes/CShapes-2.0.geojson";
// The parsed 26 MB, kept so a basemap change can refill the source. Holding only
// a "loaded" flag meant setStyle wiped the data and the re-attach skipped the
// fetch, leaving CShapes silently blank.
let cshapesData: any = null;
let cshapesFetch: Promise<any> | null = null;

/**
 * CShapes dates arrive as separate year/month/day fields. Normalising them to
 * the same start_num/end_num the rest of the app uses means the date filter,
 * the labels and the hover code need no CShapes-specific branch.
 */
export function normaliseCShapes(fc: any): any {
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? (f.properties = {});
    p.start_num =
      toDecimalYear(`${p.gwsyear}-${p.gwsmonth}-${p.gwsday}`) ?? NO_START;
    p.end_num = toDecimalYear(`${p.gweyear}-${p.gwemonth}-${p.gweday}`) ?? NO_END;
    p.name = p.cntry_name;
    p.admin_level = 2;
    // gwcode is unique per country-period, so it can stand in for osm_id and
    // feed the same hover/label dedup path.
    p.osm_id = Number(p.gwcode) || 0;
  }
  return fc;
}

const cshapes: Source = {
  id: "cshapes",
  label: "CShapes 2.0",
  note: "CC BY-NC-SA 4.0 — NON-COMMERCIAL only, and ShareAlike applies to derivative work. 1886-2019.",
  restricted: true,
  pickLayer: "cs-fill",
  layers: ["cs-fill", "cs-line"],

  async attach(map, beforeId) {
    map.addSource("hist-cs", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      promoteId: "osm_id",
      attribution: "© CShapes 2.0 (CC BY-NC-SA)",
    });
    map.addLayer(
      {
        id: "cs-fill",
        type: "fill",
        source: "hist-cs",
        paint: { "fill-color": "#0ea5e9", "fill-opacity": fillOpacity() },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: "cs-line",
        type: "line",
        source: "hist-cs",
        paint: {
          "line-color": "#7dd3fc",
          "line-width": lineWidth(),
          "line-opacity": 0.9,
        },
      },
      beforeId,
    );

    // 26 MB, fetched once and then filtered on the GPU like every other source.
    // The in-flight promise is shared so a fast re-attach cannot start a second
    // download of it.
    try {
      if (!cshapesData) {
        cshapesFetch ??= fetch(CSHAPES)
          .then((r) => r.json())
          .then(normaliseCShapes);
        cshapesData = await cshapesFetch;
      }
      (map.getSource("hist-cs") as any)?.setData(cshapesData);
    } catch (e) {
      cshapesFetch = null;
      console.error("CShapes load failed", e);
    }
  },
};

// ---------------------------------------------------------------------------
// Present day
// ---------------------------------------------------------------------------

/**
 * Source Cooperative's mirror of the Protomaps planet. NOT build.protomaps.com,
 * whose bucket only sends CORS for localhost origins — it works in dev and fails
 * silently the moment the site is deployed.
 */
export const BASEMAP_TILES =
  "pmtiles://https://data.source.coop/protomaps/openstreetmap/v4.pmtiles";

/**
 * Salt-water `kind` values in the Protomaps v4 `water` layer, used by the
 * coastline clip (see map.ts). Verified against @protomaps/basemaps: it labels
 * exactly {ocean, sea, bay, strait, fjord} as salt water and keeps lakes/rivers
 * separate — so masking these strips the sea spill but leaves inland borders
 * like the Great Lakes US–Canada line drawn. MUST NOT include "lake"/"river".
 */
export const OCEAN_KINDS = ["ocean", "sea", "bay", "strait", "fjord"];

/**
 * Today's borders as a tracing-paper reference over the historical ones.
 *
 * This used to be "stop stripping the basemap's own boundary layers", which had
 * two faults. It was INVISIBLE — the basemap draws them as a dark hairline meant
 * to sit under labels, and our translucent fills went straight over the top. And
 * it only existed on the Protomaps basemaps: on `None` or OHM Historical there
 * were no such layers to un-strip, so the toggle did nothing at all.
 *
 * Now it owns a source and two layers of its own, so it looks the same over
 * every basemap. Cosmetic by contract: `pickLayer` is "" and `overlay` is true,
 * so `pickable()` never includes it and no territory here is clickable.
 */
const today: Source = {
  id: "today",
  label: "Present day (reference)",
  note: "Cosmetic overlay. Today's borders on top of the era you are viewing — not clickable.",
  overlay: true,
  pickLayer: "",
  layers: ["today-line", "today-line-sub"],

  attach(map, beforeId) {
    if (!map.getSource("hist-today"))
      map.addSource("hist-today", {
        type: "vector",
        url: BASEMAP_TILES,
        attribution: "© OpenStreetMap, Protomaps",
      } as never);

    // Internal borders first, so country lines draw over them.
    map.addLayer(
      {
        id: "today-line-sub",
        type: "line",
        source: "hist-today",
        "source-layer": "boundaries",
        filter: [">", ["get", "kind_detail"], 2],
        paint: {
          "line-color": "#22d3ee",
          "line-width": 0.6,
          "line-opacity": 0.35,
          "line-dasharray": [2, 3],
        },
      },
      beforeId,
    );
    // kind_detail <= 2 is the country tier in the Protomaps v4 schema.
    map.addLayer(
      {
        id: "today-line",
        type: "line",
        source: "hist-today",
        "source-layer": "boundaries",
        filter: ["<=", ["get", "kind_detail"], 2],
        paint: {
          "line-color": "#22d3ee",
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.9, 10, 2],
          "line-opacity": 0.75,
          "line-dasharray": [3, 2],
        },
      },
      beforeId,
    );
  },
};

export const SOURCES: Source[] = [ohm, hb, cshapes, today];

/** The mutually exclusive border datasets — everything that is not an overlay. */
export const isOverlay = (id: string) =>
  !!SOURCES.find((s) => s.id === id)?.overlay;

const STORE = "sources";
// OHM only. Two disagreeing sets of borders painted over each other everywhere
// both had coverage, which is also why the picker is now single-choice.
const DEFAULT = ["ohm"];

/**
 * Enforce "exactly one border dataset, plus any cosmetic overlays".
 *
 * Layering two datasets was the old design and it was a mistake: OHM and
 * Historical-Basemaps disagree about the same borders, so wherever both had
 * coverage the map drew two contradictory sets of lines and the pick order
 * decided which one your click got. The last dataset in the list wins, which
 * makes "the one just clicked" the survivor.
 *
 * Also migrates a multi-dataset selection saved by the old build.
 */
export function normaliseSources(ids: string[]): string[] {
  const known = ids.filter((id) => SOURCES.some((s) => s.id === id));
  const datasets = known.filter((id) => !isOverlay(id));
  const overlays = [...new Set(known.filter(isOverlay))];
  const pick = datasets.length ? datasets[datasets.length - 1] : DEFAULT[0];
  return [pick, ...overlays];
}

export function savedSources(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null");
    return normaliseSources(Array.isArray(v) && v.length ? v : DEFAULT);
  } catch {
    return DEFAULT;
  }
}

export const saveSources = (ids: string[]) =>
  localStorage.setItem(STORE, JSON.stringify(ids));
