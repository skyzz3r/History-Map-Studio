// GeoJSONSeq filter between `osmium export` and `tippecanoe`.
//
// Does four things, each of which fixes something the hosted OHM tiles get
// wrong for this app:
//
//  1. Drops ~300 name_* / alt_name:* / official_name:* fields per feature.
//     Measured on a real z6 tile: localisations are 78% of all attribute bytes,
//     and they are why a z3 tile is 4.7 MB and the app needed a zoom-5 gate.
//  2. Converts start_date/end_date to decimal-year NUMBERS, because MapLibre
//     expressions cannot compare "1942-05-12" mathematically.
//  3. Keeps `wikidata`/`wikipedia`, so a click resolves an entity with no
//     Overpass round trip.
//  4. Emits ONE label point per feature, from the unclipped source geometry.
//     Tile clipping is what put a French flag in both Lyon and Paris: each tile
//     clips France and labels its own piece. A point cannot be clipped, so this
//     is the permanent fix, at every zoom.
//
// Reads GeoJSONSeq on stdin, writes GeoJSONSeq on stdout. Streams line by line —
// nothing is accumulated, so memory is flat regardless of planet size.
//
// Usage: osmium export -f geojsonseq ... | node scripts/prepare.mjs > out.geojsonseq

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
// Shared with src/labels.ts so a label never lands in two different places
// depending on which source drew it. Needs --experimental-strip-types.
import { labelPoint } from "../src/geo.ts";

// Absent start = "always existed", absent end = "still exists". A null would
// lose every numeric comparison and silently erase the feature instead.
const NO_START = -99999;
const NO_END = 99999;

const KEEP = new Set([
  "name",
  "name:en",
  "admin_level",
  "boundary",
  "type",
  "start_date",
  "end_date",
  "wikidata",
  "wikipedia",
  "disputed",
  "disputed_by",
  "maritime",
  // Occupation / de-facto control. Drives the ohm-occupation layer's colouring.
  "occupant",
  "controlled_by",
  "claimed_by",
  "military",
  "border_type",
]);

/** Everything the extract pulls in that is NOT an administrative boundary. */
const OVERLAY = new Set(["political", "military"]);

const CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * OHM dates: "1942", "1942-05", "1942-05-12", or "-0218" for BC. Mirrors
 * src/dates.ts — kept as a copy because this runs in CI with no bundler.
 */
export function toDecimalYear(iso) {
  if (!iso) return null;
  const m = /^(-?\d+)(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(String(iso).trim());
  if (!m) return null;
  const year = parseInt(m[1], 10);
  if (!Number.isFinite(year)) return null;
  const month = m[2] ? parseInt(m[2], 10) : 1;
  const day = m[3] ? parseInt(m[3], 10) : 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return year;
  const doy = CUMULATIVE[month - 1] + day + (month > 2 && isLeap(year) ? 1 : 0);
  return year + (doy - 1) / (isLeap(year) ? 366 : 365);
}

/**
 * Feature -> the signed osm_id the app uses, or null.
 *
 * The whole app numbers relations NEGATIVE — src/ohm.ts maps that back to an
 * Overpass `rel(id:...)`, and hover, drill-down bounds and every Wikidata
 * lookup key on it.
 *
 * The sign CANNOT come from an "r" prefix. `osmium export --attributes=id,type`
 * writes `@id` as a plain positive number and puts the object class in a
 * separate `@type`, which is `"relation"` for an area assembled from a
 * multipolygon or boundary relation. Reading a prefix that is never there made
 * every relation positive, which would have silently broken every one of those
 * lookups in tiles that otherwise looked perfectly fine.
 *
 * The prefixed form is still accepted, since other osmium subcommands emit it.
 */
export function osmIdOf(f) {
  const p = f?.properties ?? {};
  const raw = String(f?.id ?? p["@id"] ?? p.id ?? "");
  if (!raw) return null;
  const num = parseInt(raw.replace(/^[a-z]/i, ""), 10);
  if (!Number.isFinite(num)) return null;
  const isRelation =
    p["@type"] === "relation" || p.type === "relation" || /^r/i.test(raw);
  return isRelation ? -Math.abs(num) : Math.abs(num);
}

// --- transform ------------------------------------------------------------

/**
 * One input feature -> the features to emit. Returns [] for anything without
 * usable geometry so bad input cannot poison a tile.
 */
/**
 * Round every coordinate to 6 decimal places, in place.
 *
 * ~11 cm at the equator — far finer than any historical border is actually
 * known, and finer than tippecanoe's own tile grid resolves at z12.
 *
 * This is the single biggest lever on build time. osmium writes full float
 * precision, so a vertex is "-73.98765432109876" — 19 bytes where 10 will do.
 * The unrounded stream was 9023 MB for 203,705 features, and tippecanoe spent
 * two and a half hours in "Reordering geometry" without finishing. The cost is
 * driven by bytes, not by feature count.
 */
function round6(c) {
  if (typeof c[0] === "number") {
    c[0] = Math.round(c[0] * 1e6) / 1e6;
    c[1] = Math.round(c[1] * 1e6) / 1e6;
    if (c.length > 2) c.length = 2; // elevation is dead weight in a boundary
    return;
  }
  for (const x of c) round6(x);
}

export function transform(f) {
  const p = f?.properties;
  if (!p || !f.geometry) return [];
  if (f.geometry.coordinates) round6(f.geometry.coordinates);

  const props = {};
  for (const k of Object.keys(p)) if (KEEP.has(k)) props[k] = p[k];
  if (!props.name && !props["name:en"]) return [];

  props.start_num = toDecimalYear(p.start_date) ?? NO_START;
  props.end_num = toDecimalYear(p.end_date) ?? NO_END;
  props.admin_level = Number(props.admin_level) || 0;

  // Occupation zones, DMZs and political districts carry no admin_level, and 0
  // reads as "shallower than a country" to the hierarchy filter — which would
  // pin them on screen at every focus level. Stamp them as country-level and
  // flag them so the overlay layer can select them with a numeric compare.
  if (
    OVERLAY.has(p.boundary) ||
    p.military === "occupation_zone" ||
    p.border_type === "demilitarized_zone"
  ) {
    props.overlay = 1;
    if (!props.admin_level) props.admin_level = 2;
  }

  const osmId = osmIdOf(f);
  if (osmId !== null) props.osm_id = osmId;

  const out = [
    { type: "Feature", geometry: f.geometry, properties: props,
      tippecanoe: { layer: "boundaries" } },
  ];

  const lp = labelPoint(f.geometry);
  if (lp) {
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: lp.at },
      // area drives symbol-sort-key, so the biggest polity wins a collision.
      properties: { ...props, area: Math.round(lp.area * 1e6) },
      // Label points must survive to z0; that is the whole point of the layer.
      tippecanoe: { layer: "labels", minzoom: 0 },
    });
  }
  return out;
}

// --- main -----------------------------------------------------------------

// pathToFileURL, not a template string: on Windows argv[1] is "C:\...\x.mjs"
// while import.meta.url is "file:///C:/.../x.mjs", so a naive compare is always
// false and the script silently reads nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let read = 0;
  let wrote = 0;
  let bad = 0;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    // RFC 8142 record separator; osmium emits it and JSON.parse chokes on it.
    const s = line.replace(/^\x1e/, "").trim();
    if (!s) continue;
    read++;
    let f;
    try {
      f = JSON.parse(s);
    } catch {
      bad++;
      continue;
    }
    for (const o of transform(f)) {
      process.stdout.write(JSON.stringify(o) + "\n");
      wrote++;
    }
  }
  process.stderr.write(
    `prepare: read ${read}, wrote ${wrote} (boundaries + label points)` +
      (bad ? `, skipped ${bad} unparseable\n` : "\n"),
  );
}
