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

export type Source = {
  id: string;
  label: string;
  /** Shown in the picker. Licence terms live here. */
  note?: string;
  /** Non-commercial or otherwise restrictive — off by default, warns on enable. */
  restricted?: boolean;
  /** Layer that owns hover/click, or "" for reference-only sources. */
  pickLayer: string;
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

let ohmTiles: OhmTiles | null = null;

/** Detected once. Lets the app work before the CI tile build has ever run. */
export async function detectOhm(): Promise<OhmTiles> {
  if (ohmTiles) return ohmTiles;
  try {
    const r = await fetch(OHM_LOCAL, { method: "HEAD" });
    // A missing file on GitHub Pages returns the 404 page as 200 text/html, so
    // trust the content type, not the status.
    const ok = r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
    if (ok) {
      ohmTiles = {
        local: true,
        minzoom: 0,
        spec: { url: `pmtiles://${new URL(OHM_LOCAL, location.href).href}` },
      };
      return ohmTiles;
    }
  } catch {
    // offline or blocked — fall through to the hosted tiles
  }
  ohmTiles = { local: false, minzoom: 5, spec: { tiles: [OHM_HOSTED] } };
  return ohmTiles;
}

export const ohmIsLocal = () => ohmTiles?.local ?? false;
export const ohmMinZoom = () => ohmTiles?.minzoom ?? 5;

const ohm: Source = {
  id: "ohm",
  label: "OpenHistoricalMap",
  note: "ODbL. Day-level dates, strongest from 1600 on.",
  pickLayer: "ohm-fill",
  // Our own build ships a pre-computed one-point-per-polity layer; the hosted
  // tiles have no such layer, so labels fall back to deduping the polygons.
  labelLayer: "ohm-labelsrc",
  layers: ["ohm-fill", "ohm-line", "ohm-labelsrc"],

  async attach(map, beforeId) {
    const t = await detectOhm();
    map.addSource("hist-ohm", {
      type: "vector",
      ...t.spec,
      minzoom: t.minzoom,
      maxzoom: 12,
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
            ["==", ["get", "admin_level"], 2], "#e5e7eb",
            "#94a3b8",
          ],
          // The zoom interpolate MUST be outermost: MapLibre rejects a ["zoom"]
          // nested inside anything else, and silently drops the whole layer.
          "fill-opacity": [
            "interpolate", ["linear"], ["zoom"],
            2, ["case", ["boolean", ["feature-state", "hover"], false], 0.35, 0.1],
            10, ["case", ["boolean", ["feature-state", "hover"], false], 0.35, 0.12],
          ],
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
            ["==", ["get", "admin_level"], 2], "#f8fafc",
            "#cbd5e1",
          ],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            2, ["case", ["==", ["get", "admin_level"], 2], 0.6, 0.2],
            10, ["case", ["==", ["get", "admin_level"], 2], 2.4, 1],
          ],
          "line-opacity": 0.9,
        },
      },
      beforeId,
    );

    // Invisible: it exists only so queryRenderedFeatures can read the label
    // points our pipeline computed from unclipped geometry. The visible symbols
    // are drawn from a GeoJSON source in labels.ts, because a tiled source
    // cannot avoid labelling France once per tile.
    if (t.local) {
      map.addLayer(
        {
          id: "ohm-labelsrc",
          type: "circle",
          source: "hist-ohm",
          "source-layer": "labels",
          paint: { "circle-radius": 0, "circle-opacity": 0 },
        },
        beforeId,
      );
    }
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
        paint: {
          "fill-color": "#64748b",
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false], 0.4,
            0.22,
          ],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: "hb-line",
        type: "line",
        source: "hist-hb",
        paint: { "line-color": "#cbd5e1", "line-width": 0.6, "line-opacity": 0.7 },
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
        paint: {
          "fill-color": "#0ea5e9",
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false], 0.4,
            0.16,
          ],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: "cs-line",
        type: "line",
        source: "hist-cs",
        paint: { "line-color": "#7dd3fc", "line-width": 0.9, "line-opacity": 0.85 },
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
 * Costs nothing: boundaries_country / boundaries / places_country are already
 * inside the Protomaps tiles the basemap downloads. The CLUTTER regex in map.ts
 * normally discards them, since present-day borders contradict whatever era is
 * on screen. Enabling this source just stops discarding them.
 */
const today: Source = {
  id: "today",
  label: "Present day (reference)",
  note: "From the basemap tiles already loaded. No date filtering — always today.",
  pickLayer: "",
  layers: [],
  attach() {},
};

export const SOURCES: Source[] = [ohm, hb, cshapes, today];

const STORE = "sources";
const DEFAULT = ["ohm", "hb"];

export function savedSources(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null");
    return Array.isArray(v) && v.length ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export const saveSources = (ids: string[]) =>
  localStorage.setItem(STORE, JSON.stringify(ids));
