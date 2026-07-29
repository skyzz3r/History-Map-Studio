// The only test. Covers the three functions where a subtle bug would be silent:
// bearing wrap-around, Wikidata's signed year format, and keyframe bracketing.
// Run: npm test
import assert from "node:assert/strict";
import { lerpBearing, sampleCamera, type Key } from "./keyframes.ts";
import { activeAt, wdYear, wikiTitle } from "./wikidata.ts";
import { enTitleOf, parseBounds, parseOverpass, qidOf } from "./ohm.ts";
import { toDecimalYear, toInputDate } from "./dates.ts";
import {
  featureArea,
  inside,
  insideGeometry,
  labelPoint,
  pointOnSurface,
  simplify,
} from "./geo.ts";
import { buildLabelPoints } from "./labels.ts";
import { bboxArea, claimsFrom, overlappingIds, type Sample } from "./claims.ts";
import {
  childIds,
  coveredIds,
  focusFilter,
  inBounds,
  initialFocus,
  mergeAllow,
  nextLevel,
  tipLevel,
  type FocusState,
} from "./focus.ts";
import {
  normaliseCShapes,
  normaliseHB,
  normaliseSources,
  OCEAN_KINDS,
} from "./sources.ts";
import {
  changesDisplay,
  excludedIdsOf,
  importEdits,
  sanitise,
  withDates,
  yearNum,
} from "./edits.ts";
import { closeRing } from "./draw.ts";
import {
  emptyScene,
  inScene,
  labelTextExpr,
  rankMatches,
  sceneFilter,
  setSceneMode,
  toggleScene,
} from "./view.ts";
import {
  bboxOf,
  boxesOverlap,
  distinctIds,
  nearBox,
  stripGeometry,
  stripTargets,
} from "./strip.ts";
import {
  FAN_CAP,
  hierTree,
  layout,
  leafCount,
  polar,
  radialLink,
  ribbonPath,
  wedgePath,
} from "./hier.ts";
import { annotFeatures, newAnnot, wrapLines } from "./annot.ts";
import { normaliseCustom } from "./sources.ts";
import { niceStep } from "./borders.ts";
import { parseWhen } from "./dates.ts";
// The tile pipeline is plain .mjs so CI can run it with no bundler; it has no
// types. Tested here anyway — its id signing is the one thing that can produce
// tiles that look perfectly healthy and resolve nothing.
// @ts-expect-error untyped .mjs
import { osmIdOf } from "../scripts/prepare.mjs";

// --- lerpBearing: must take the short way round ---
assert.equal(lerpBearing(0, 90, 0.5), 45);
assert.equal(lerpBearing(350, 10, 0.5), 360, "350->10 goes forward through 0");
assert.equal(lerpBearing(10, 350, 0.5), 0, "10->350 goes backward through 0");
assert.equal(lerpBearing(0, 180, 0.5), -90, "exact opposite picks one side");
assert.equal(lerpBearing(45, 45, 0.7), 45);

// --- wdYear: the leading sign means you cannot split on the first "-" ---
assert.equal(wdYear("+1756-08-29T00:00:00Z"), 1756);
assert.equal(wdYear("-0044-03-15T00:00:00Z"), -44, "44 BC, not NaN");
assert.equal(wdYear("+2026-01-01T00:00:00Z"), 2026);
assert.equal(wdYear(undefined), null);
assert.equal(wdYear("garbage"), null);

// --- activeAt: a dated property that misses the year must yield NOTHING ---
const t = (y: number) => ({
  value: { content: { time: `+${String(y).padStart(4, "0")}-01-01T00:00:00Z` } },
});
const claim = (id: string, start?: number, end?: number) => ({
  value: { content: id },
  qualifiers: [
    ...(start === undefined ? [] : [{ property: { id: "P580" }, ...t(start) }]),
    ...(end === undefined ? [] : [{ property: { id: "P582" }, ...t(end) }]),
  ],
});
const presidents = [claim("deGaulle", 1959, 1969), claim("macron", 2017)];

const idOf = (s: ReturnType<typeof activeAt>) => s[0]?.value?.content;

assert.equal(idOf(activeAt(presidents, 1960)), "deGaulle");
assert.equal(idOf(activeAt(presidents, 2020)), "macron");
assert.deepEqual(activeAt(presidents, 1800), [], "year before ALL claims -> nobody, not claims[0]");
assert.deepEqual(activeAt(presidents, 1975), [], "gap between claims -> nobody");
assert.deepEqual(activeAt(undefined, 1900), []);
assert.deepEqual(activeAt([], 1900), []);
// a property with no dates at all still answers, since it is the only data there is
assert.equal(activeAt([claim("undated")], 1900).length, 1);

// --- sampleCamera: clamps outside, interpolates inside, survives one key ---
const k = (t: number, lng: number): Key => ({
  t, lng, lat: 0, zoom: 3, pitch: 0, bearing: 0, index: t,
});
const keys = [k(0, 0), k(2, 100), k(4, 200)];

assert.equal(sampleCamera([], 1), null);
assert.equal(sampleCamera([k(0, 5)], 99)?.lng, 5, "single key clamps");
assert.equal(sampleCamera(keys, -5)?.lng, 0, "before start clamps");
assert.equal(sampleCamera(keys, 99)?.lng, 200, "after end clamps");
assert.equal(sampleCamera(keys, 1)?.lng, 50, "midpoint of eased segment is linear");
assert.equal(sampleCamera(keys, 3)?.lng, 150, "picks the SECOND segment, not the first");
assert.ok(sampleCamera(keys, 0.5)!.lng < 25, "ease-in starts slow");

// unsorted input must not break bracketing
assert.equal(sampleCamera([k(4, 200), k(0, 0), k(2, 100)], 3)?.lng, 150);

// --- ohm: Overpass -> tiles. The sign flip is the part that silently breaks ---
// Tiles number relations NEGATIVE and the API numbers them positive, so a
// mismatch here means every lookup misses and every click falls back to a name
// search — the exact bug this replaced.
const overpass = {
  elements: [
    { type: "relation", id: 2850626, tags: { name: "Regno di Sardegna", wikidata: "Q165154", wikipedia: "en:Kingdom of Sardinia" } },
    { type: "way", id: 4242, tags: { name: "A way" } },
    { type: "relation", id: 99, tags: { name: "No links" } },
    { type: "count", id: 0, tags: { total: "3" } }, // out count emits this
  ],
};
const tags = parseOverpass(overpass);
assert.ok(tags.has(-2850626), "relation keyed by the NEGATIVE tile osm_id");
assert.equal(tags.get(-2850626)!.wikidata, "Q165154");
assert.ok(tags.has(4242), "ways keep their positive id");
assert.equal(tags.size, 3, "the id:0 count element is dropped");
assert.deepEqual(parseOverpass({}), new Map());
assert.deepEqual(parseOverpass(undefined), new Map());

// A bad wikidata value must yield nothing rather than a request for /entities/junk
assert.equal(qidOf(tags.get(-2850626)), "Q165154");
assert.equal(qidOf(tags.get(99)), undefined, "absent tag -> undefined");
assert.equal(qidOf({ wikidata: "P31" }), undefined, "P-id is not an item");
assert.equal(qidOf({ wikidata: "Kingdom of Sardinia" }), undefined);
assert.equal(qidOf(null), undefined);

// Only the English sitelink is usable; a de: link would 404 on en.wikipedia.
assert.equal(enTitleOf(tags.get(-2850626)), "Kingdom of Sardinia");
assert.equal(enTitleOf({ wikipedia: "de:Königreich Sardinien" }), undefined);
assert.equal(enTitleOf(tags.get(99)), undefined);

// --- dates: the whole app's time axis, and the pipeline's GPU filter input ---
// Year only, and month/day precision.
assert.equal(toDecimalYear("1942"), 1942);
assert.equal(toDecimalYear(undefined), null);
assert.equal(toDecimalYear("not a date"), null);
// 12 May is day 132 of a non-leap year, so the fraction is 131/365.
assert.ok(Math.abs(toDecimalYear("1942-05-12")! - (1942 + 131 / 365)) < 1e-9);
assert.equal(toDecimalYear("1942-01-01"), 1942, "1 Jan is exactly the year");
assert.ok(toDecimalYear("1942-12-31")! < 1943, "31 Dec stays inside its year");

// BC: the leading minus must survive, and time must still increase.
assert.equal(toDecimalYear("-0044-01-01"), -44, "44 BC");
assert.ok(
  toDecimalYear("-0044-12-31")! > toDecimalYear("-0044-01-01")!,
  "December 44 BC is LATER than January 44 BC",
);
assert.ok(toDecimalYear("-0044-01-01")! < toDecimalYear("0001-01-01")!);

// Leap years shift day-of-year past February.
assert.ok(toDecimalYear("2000-03-01")! !== toDecimalYear("1900-03-01")!);

// Round-trip through the inverse, including a leap day.
for (const iso of ["1942-05-12", "1600-01-01", "2020-02-29", "1789-07-14"]) {
  const back = toInputDate(toDecimalYear(iso)!);
  assert.equal(back, iso, `round-trip ${iso} -> ${back}`);
}

// <input type="date"> cannot express BC, so callers must get null and disable it.
assert.equal(toInputDate(-44), null, "BC has no native date input value");
assert.equal(toInputDate(1942 + 131 / 365), "1942-05-12");

// Sentinels used by the pipeline must order correctly against real dates.
assert.ok(-99999 < toDecimalYear("-3000")!, "no-start sentinel precedes everything");
assert.ok(99999 > toDecimalYear("2026")!, "no-end sentinel follows everything");

// --- geo: the label anchor must be INSIDE, and on the biggest landmass ---
const box = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
];

// A USA-shaped feature: small Alaska box far west, large mainland box east.
// Averaging the two would drop the label in the Pacific between them.
const usa = {
  type: "MultiPolygon",
  coordinates: [[box(-160, 60, -150, 70)], [box(-100, 30, -80, 45)]],
};
const usaLabel = labelPoint(usa)!;
assert.ok(usaLabel.at[0] > -100 && usaLabel.at[0] < -80, "lng on the mainland");
assert.ok(usaLabel.at[1] > 30 && usaLabel.at[1] < 45, "lat on the mainland");
assert.equal(Math.round(usaLabel.area), 300, "area of the larger 20x15 box");

// A C-shape: its centroid falls in the notch, OUTSIDE the polygon. The anchor
// must not, or a label lands in the sea beside the country it names.
const cShape = [
  [0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10], [0, 0],
];
assert.ok(!inside([6, 5], cShape), "the notch really is outside");
assert.ok(inside(pointOnSurface(cShape), cShape), "anchor lands inside the C");
assert.equal(labelPoint(null), null);
assert.equal(labelPoint({ type: "LineString", coordinates: [] }), null);

// --- labels: ONE point per polity, whatever the tiles do ---
// The Lyon/Paris bug: tile clipping hands us France as several pieces. Same
// osm_id must collapse to a single label, on the largest piece.
const clipped = [
  { properties: { osm_id: -1, name: "France", area: 999 },
    geometry: { type: "Polygon", coordinates: [box(0, 40, 2, 42)] } },   // small
  { properties: { osm_id: -1, name: "France", area: 999 },
    geometry: { type: "Polygon", coordinates: [box(2, 44, 8, 50)] } },   // large
  { properties: { osm_id: -2, name: "Iberia", area: 500 },
    geometry: { type: "Polygon", coordinates: [box(-9, 36, -1, 43)] } },
] as any;
const built = buildLabelPoints(clipped);
assert.equal(built.features.length, 2, "France collapses to ONE label");
const fr = built.features.find((f) => f.properties.name === "France")!;
assert.ok(fr.geometry.coordinates[0] > 2, "label sits on the LARGER piece");
assert.equal(fr.properties.area, 999, "keeps the global area for sort-key");

// A precomputed point from our own pipeline always beats a clipped polygon.
const mixed = [
  { properties: { osm_id: -1, name: "France", area: 999 },
    geometry: { type: "Polygon", coordinates: [box(2, 44, 8, 50)] } },
  { properties: { osm_id: -1, name: "France", area: 999 },
    geometry: { type: "Point", coordinates: [2.5, 46.5] } },
] as any;
const m1 = buildLabelPoints(mixed).features;
assert.equal(m1.length, 1);
assert.deepEqual(m1[0].geometry.coordinates, [2.5, 46.5], "pipeline point wins");
// ...regardless of the order they arrive in.
assert.deepEqual(
  buildLabelPoints([mixed[1], mixed[0]] as any).features[0].geometry.coordinates,
  [2.5, 46.5],
  "and wins when it arrives first too",
);
assert.deepEqual(buildLabelPoints([] as any).features, []);
// Nameless features must not produce a blank label.
assert.deepEqual(
  buildLabelPoints([{ properties: { osm_id: -9 },
    geometry: { type: "Point", coordinates: [0, 0] } }] as any).features,
  [],
);

// focusFilter's admitted set is asserted further down, by evaluating the
// expression against real feature properties instead of matching its shape.
// The shape assertions that used to live here broke on every internal change
// while proving nothing about which features actually draw.

// The subdivisions tier is the SHALLOWEST one with more than a single member.
// Prussia has one admin_level 3 feature (Neutral Moresnet) beside a dozen
// level-4 provinces, so a plain "shallowest" showed Moresnet alone.
assert.equal(nextLevel(2, new Map([[3, 1], [4, 12]])), 4, "12 provinces beat 1 oddity");
// ...but "most members" is wrong too, and this is the case that proved it on the
// live map: France resolved 189 level-8 communes instead of its 13 régions.
assert.equal(
  nextLevel(2, new Map([[4, 13], [6, 96], [8, 189]])),
  4,
  "régions are France's subdivisions; communes are not",
);
assert.equal(nextLevel(2, new Map([[4, 5], [6, 40]])), 4, "shallowest real tier wins");
assert.equal(nextLevel(2, new Map([[2, 90]])), 2, "nothing deeper -> stay put");
assert.equal(nextLevel(2, new Map()), 2, "no children -> stay put");
assert.equal(nextLevel(2, new Map([[4, 7], [6, 7]])), 4);
// Every candidate tier is a singleton: fall back to the shallowest rather than
// resolving nothing at all.
assert.equal(nextLevel(2, new Map([[5, 1], [7, 1]])), 5);

// Why childIds does point-in-polygon and NOT a bounding box. Prussia's real
// bbox (47.6-55.9N, 5.9-22.9E) contains southern Denmark, and the first version
// of this genuinely listed Holbæk and Randers as Prussian provinces.
const prussiaBox = { minlat: 47.6, minlon: 5.87, maxlat: 55.9, maxlon: 22.89 };
const holbaek: [number, number] = [11.7, 55.7]; // a Danish amt
assert.ok(inBounds(holbaek, prussiaBox), "a bbox test WOULD wrongly include it");
// An L-shaped Prussia that stops short of Denmark: the polygon test rejects it.
const prussia = [
  [5.9, 47.6], [22.9, 47.6], [22.9, 55.9], [14, 55.9], [14, 53], [5.9, 53], [5.9, 47.6],
];
assert.ok(!inside(holbaek, prussia), "point-in-polygon correctly excludes it");
assert.ok(inside([13, 52.5], prussia), "Berlin is still inside");

// The same case end to end. Brandenburg is inside Prussia, Holbæk is not, and a
// second Prussian piece (tiles clip the parent) must not double-count a tier.
const child = (id: number, al: number, r: number[][]) => ({
  properties: { osm_id: id, admin_level: al },
  geometry: { type: "Polygon", coordinates: [r] },
});
const kids = childIds(
  [
    { properties: { osm_id: -100, admin_level: 2 },
      geometry: { type: "Polygon", coordinates: [prussia] } },
    child(-201, 4, box(12, 52, 14, 53)), // Brandenburg
    child(-202, 4, box(8, 50, 10, 52)), // Westfalen
    child(-202, 4, box(10, 50, 11, 51)), // a clipped second piece of the same
    child(-300, 4, box(11.5, 55.5, 12, 55.9)), // Holbæk, inside the BBOX only
  ],
  -100,
  2,
);
assert.deepEqual(kids.ids.sort(), [-202, -201].sort(), "no Danish amts");
assert.equal(kids.counts.get(4), 2, "a clipped province must not vote twice");
assert.equal(nextLevel(2, kids.counts), 4);
// The parent must be found: with no parent geometry there are no children.
assert.deepEqual(childIds([child(-201, 4, box(12, 52, 14, 53))], -100, 2).ids, []);

// A two-lobed child OUTSIDE the parent must stay out. Averaging its vertices
// lands between the lobes — inside Prussia — which is exactly how Austrian
// Silesia ended up listed as a Prussian province.
const austrianSilesia = {
  properties: { osm_id: -400, admin_level: 4 },
  geometry: {
    type: "MultiPolygon",
    coordinates: [[box(17, 49.5, 18.5, 50)], [box(18.5, 49.5, 19.5, 50)]],
  },
};
const wideParent = {
  properties: { osm_id: -100, admin_level: 2 },
  geometry: { type: "Polygon", coordinates: [box(5, 50.5, 22, 55)] },
};
assert.ok(
  !childIds([wideParent, austrianSilesia], -100, 2).ids.includes(-400),
  "a child entirely south of the parent is never its subdivision",
);

// --- overpass bounds: same call as the tags, same negative-id convention ---
const withBb = {
  elements: [
    { type: "relation", id: 2694606, tags: { name: "Preussen" },
      bounds: { minlat: 47.6, minlon: 5.8, maxlat: 55.8, maxlon: 22.8 } },
    { type: "relation", id: 5, tags: { name: "No bounds" } },
  ],
};
const bb = parseBounds(withBb);
assert.ok(bb.has(-2694606), "bounds keyed by the NEGATIVE tile osm_id");
assert.equal(bb.size, 1, "elements without bounds are skipped");
assert.equal(parseOverpass(withBb).size, 2, "tags still parse alongside");

// --- CShapes: its own date columns must become the shared start_num/end_num ---
const cs = normaliseCShapes({
  features: [
    { properties: { cntry_name: "France", gwcode: 220,
        gwsyear: 1886, gwsmonth: 1, gwsday: 1,
        gweyear: 2019, gwemonth: 12, gweday: 31 } },
    { properties: { cntry_name: "Nowhere", gwcode: 999 } },
  ],
});
const [f1, f2] = cs.features.map((f: any) => f.properties);
assert.equal(f1.start_num, 1886);
assert.ok(f1.end_num > 2019 && f1.end_num < 2020);
assert.equal(f1.name, "France");
assert.equal(f1.osm_id, 220, "gwcode stands in for osm_id");
assert.equal(f1.admin_level, 2);
// Missing dates must become sentinels, never null: a null loses every numeric
// comparison and the feature would silently vanish instead of always showing.
assert.equal(f2.start_num, -99999);
assert.equal(f2.end_num, 99999);

// --- Historical-Basemaps carries NAME and nothing else ---
// Without a stamped admin_level the hierarchy filter (admin_level <= 2) matched
// nothing and the whole source rendered blank.
const hb = normaliseHB({
  features: [
    { properties: { NAME: "Gaul" } },
    { properties: { NAME: "Roma", SUBJECTO: "Roma" } },
  ],
});
const hp = hb.features.map((f: any) => f.properties);
assert.equal(hp[0].admin_level, 2, "stamped, else the focus filter hides it");
assert.equal(hp[0].name, "Gaul", "NAME -> name for the shared label code");
assert.notEqual(hp[0].osm_id, hp[1].osm_id, "ids must differ, or labels collapse");
assert.deepEqual(normaliseHB({ features: [] }).features, []);
assert.doesNotThrow(() => normaliseHB(undefined));

// One label per polity must still hold for Historical-Basemaps, whose distinct
// ids are strings rather than numbers.
const hbLabels = buildLabelPoints([
  { properties: { osm_id: "hb-0", name: "Gaul" },
    geometry: { type: "Polygon", coordinates: [box(0, 44, 6, 50)] } },
  { properties: { osm_id: "hb-0", name: "Gaul" },
    geometry: { type: "Polygon", coordinates: [box(6, 44, 8, 46)] } },
  { properties: { osm_id: "hb-1", name: "Roma" },
    geometry: { type: "Polygon", coordinates: [box(10, 40, 16, 46)] } },
] as any);
assert.equal(hbLabels.features.length, 2, "string ids dedupe too");

// --- allow: [] and allow: null are NOT the same filter ---
// Getting this wrong put every province on Earth on screen: an opened maxLevel
// with no restriction. `[]` means "resolved, nothing qualifies".
//
// The trail is what makes an allow-list meaningful — with an empty trail you are
// at the world view, which has no parent to be inside of.
const drilled = {
  trail: [{ osmId: -100, name: "Prussia", adminLevel: 2 }],
  maxLevel: 4,
  children: [],
  resolved: true,
};
const openNull = JSON.stringify(focusFilter({ ...drilled, allow: null }));
const openEmpty = JSON.stringify(focusFilter({ ...drilled, allow: [] }));
assert.notEqual(openNull, openEmpty, "empty allow must restrict, null must not");
assert.ok(openEmpty.includes('"literal"'), "empty allow still emits an id test");

// --- claim detection ---
// The real Lviv 1942 case: Deutsches Reich (-2692712) and Soviet Union
// (-2851156) hit-test at the same point, same admin_level. The bigger polity is
// the surviving de-jure claim, so it hatches and the occupier stays solid.
const REICH = -2692712;
const USSR = -2851156;
const sizeOf = (id: unknown) => (id === USSR ? 6000 : id === REICH ? 400 : 0);
const lviv: Sample[] = [
  [
    { id: USSR, level: 2 },
    { id: REICH, level: 2 },
  ],
];
assert.deepEqual(claimsFrom(lviv, sizeOf), [USSR], "the bigger one is the claim");

// The USSR's real bounding box wraps the antimeridian (minlon 20.9, maxlon
// -169.0). A plain subtraction scores it -8882 against the Reich's 208, which
// made the occupier the "bigger" one and hatched exactly the wrong country.
const realUSSR = { minlon: 20.8851163, maxlon: -168.9769333, minlat: 35.129093, maxlat: 81.90836 };
const realReich = { minlon: 5.7356987, maxlon: 26.4435113, minlat: 45.837241, maxlat: 55.8975803 };
assert.ok(bboxArea(realUSSR) > 0, "a wrapped box has positive area");
assert.ok(bboxArea(realUSSR) > bboxArea(realReich), "the USSR is the bigger polity");
assert.equal(bboxArea(undefined), 0, "unknown size never wins a comparison");
assert.deepEqual(overlappingIds(lviv).sort(), [USSR, REICH].sort());

// A point with one feature is not an overlap, however many points there are.
assert.deepEqual(claimsFrom([[{ id: 1, level: 2 }]], sizeOf), []);
assert.deepEqual(overlappingIds([[{ id: 1, level: 2 }]]), []);

// Different levels never pair: a province inside its country is just hierarchy.
assert.deepEqual(
  claimsFrom([[{ id: 1, level: 2 }, { id: 2, level: 4 }]], sizeOf),
  [],
  "a province does not make its country a claim",
);

// An unmeasured polity scores 0 and therefore stays SOLID — never hatch on a
// guess when Overpass has not answered yet.
assert.deepEqual(
  claimsFrom([[{ id: 7, level: 2 }, { id: 8, level: 2 }]], () => 0),
  [8],
  "ties keep the first as de-facto, only one is hatched",
);

// --- insideGeometry honours holes ---
// Not used by claim detection any more (tile clipping defeats geometry there),
// but enclave-vs-containment still matters wherever anchors are tested.
const big = box(20, 48, 32, 58);
const small = box(23, 49, 26, 52);
const poly = (r: number[][], holes: number[][][] = []) => ({
  type: "Polygon" as const,
  coordinates: [r, ...holes],
});
assert.equal(insideGeometry([24.5, 50], poly(big)), true);
assert.equal(insideGeometry([24.5, 50], poly(big, [small])), false, "in the hole");
assert.equal(insideGeometry([21, 49], poly(big, [small])), true, "outside the hole");

// --- featureArea: the property topmost() used to read does not exist ---
assert.ok(featureArea(poly(big)) > featureArea(poly(small)), "real area, not props");
assert.equal(featureArea({ type: "Point", coordinates: [0, 0] }), 0);

// --- mergeAllow: panning widens, never resets ---
assert.deepEqual(mergeAllow([1, 2], [2, 3]).sort(), [1, 2, 3]);
assert.deepEqual(mergeAllow(null, [4, 4]), [4]);
assert.deepEqual(mergeAllow([1], []), [1], "an empty pass must not clear the list");

// --- simplify: the pipeline's only defence against 8.3 GB of coastline ---
// A straight run of collinear points must collapse to its endpoints...
const straight = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
assert.deepEqual(simplify(straight, 1e-4), [[0, 0], [5, 0]], "collinear collapses");
// ...but a real deviation above the tolerance must survive.
const bumpy = [[0, 0], [1, 0], [2, 1], [3, 0], [4, 0]];
assert.ok(
  simplify(bumpy, 0.1).some((p) => p[1] === 1),
  "a deviation larger than the tolerance is kept",
);
// `bumpy` is an open line, not a closed ring, so collapsing to its two
// endpoints is correct. The 4-position floor applies only to closed rings —
// applying it to lines is what made simplify() hand back the full input.
assert.equal(simplify(bumpy, 5).length, 2, "an open line may collapse to 2");
// A closed ring's first and last positions coincide, which makes the
// anchor-to-anchor segment degenerate; distance must not become NaN and throw
// the whole ring away.
const ring = [...box(0, 0, 1, 1)];
assert.ok(simplify(ring, 1e-9).length >= 4, "closed rings survive");
assert.deepEqual(simplify([[0, 0], [1, 1]], 0.5), [[0, 0], [1, 1]], "too short to touch");
// The output must stay a valid ring rather than degenerate into a line.
assert.ok(simplify(ring, 100).length >= 4, "never returns fewer than 4 positions");

// --- the tile pipeline's id signing ---
// Relations MUST come out negative: src/ohm.ts turns a negative osm_id into an
// Overpass rel() lookup, and hover, drill-down bounds and every Wikidata card
// key on it. `osmium export --attributes=id,type` writes @id as a plain
// POSITIVE number with the class in @type, so a prefix check finds nothing and
// silently produces tiles that look fine and resolve nothing.
assert.equal(
  osmIdOf({ properties: { "@id": 2851156, "@type": "relation" } }),
  -2851156,
  "osmium's @type is the only signal that this is a relation",
);
assert.equal(osmIdOf({ properties: { "@id": 4242, "@type": "way" } }), 4242);
// The prefixed form other osmium subcommands emit must still work.
assert.equal(osmIdOf({ id: "r2851156", properties: {} }), -2851156);
assert.equal(osmIdOf({ id: "w4242", properties: {} }), 4242);
// A boundary relation carries the OSM tag type=boundary; that must not be read
// as the object class and flip a way negative.
assert.equal(osmIdOf({ properties: { "@id": 7, "@type": "way", type: "boundary" } }), 7);
assert.equal(osmIdOf({ properties: {} }), null);
assert.equal(osmIdOf({ properties: { "@id": "junk" } }), null);

// --- the hierarchy filter, actually evaluated -------------------------------
//
// focusFilter returns a MapLibre expression, and asserting on its SHAPE proves
// nothing about what it admits. This evaluates the subset it uses against real
// feature properties, so every case below is the question the GPU asks.

type Props = Record<string, unknown>;

function evalExpr(e: unknown, p: Props): any {
  if (!Array.isArray(e)) return e;
  const [op, ...a] = e as [string, ...unknown[]];
  const v = (x: unknown) => evalExpr(x, p);
  switch (op) {
    case "all": return a.every((x) => v(x) === true);
    case "any": return a.some((x) => v(x) === true);
    case "!": return v(a[0]) !== true;
    case "get": return p[a[0] as string];
    case "literal": return a[0];
    case "coalesce": {
      for (const x of a) {
        const r = v(x);
        if (r !== undefined && r !== null) return r;
      }
      return undefined;
    }
    case "in": return (v(a[1]) as unknown[]).includes(v(a[0]));
    case "<=": return Number(v(a[0])) <= Number(v(a[1]));
    case ">=": return Number(v(a[0])) >= Number(v(a[1]));
    case "==": return v(a[0]) === v(a[1]);
    default: throw new Error(`unhandled op in test evaluator: ${op}`);
  }
}
const admits = (f: FocusState, p: Props, covered: number[] = []) =>
  evalExpr(focusFilter(f, covered), p) === true;

const EMPIRE = { admin_level: 1, osm_id: -1 };
const MEMBER = { admin_level: 2, osm_id: -2 };
const LONER = { admin_level: 2, osm_id: -3 };
const PROVINCE = { admin_level: 4, osm_id: -4 };
// A real one, from OHM: way 198568873, maritime=yes, type=boundary, no
// admin_level at all. prepare.mjs used to coerce that to 0.
const NM_LINE = { admin_level: 0, osm_id: 198568873, name: "6nm line - Greece" };
const NM_UNTAGGED = { osm_id: 198304712, name: "3nm line - Ryukyu Islands" };

const world = initialFocus();
assert.equal(admits(world, EMPIRE), true, "world view shows empires");
assert.equal(admits(world, LONER), true, "world view shows independent countries");
assert.equal(admits(world, PROVINCE), false, "world view stops at countries");
// The reported artifacts. Both forms must be rejected by the same clause.
assert.equal(admits(world, NM_LINE), false, "12nm-style limit lines are not polities");
assert.equal(admits(world, NM_UNTAGGED), false, "a missing admin_level is not level 0");

// An empire stands in for its members, so the world view is not a soup.
assert.equal(admits(world, MEMBER, [-2]), false, "covered member hides at world view");
assert.equal(admits(world, EMPIRE, [-2]), true, "the empire itself still draws");
assert.equal(admits(world, LONER, [-2]), true, "an uncovered country is untouched");

// Drilling into the empire must bring exactly those members back — and NOT
// every country on Earth, which is what a hardcoded "al <= 2" context did.
const inEmpire: FocusState = {
  trail: [{ osmId: -1, name: "British Empire", adminLevel: 1 }],
  maxLevel: 2,
  allow: [-2],
  children: [],
  resolved: true,
};
assert.equal(admits(inEmpire, MEMBER, [-2]), true, "drill reveals the member");
assert.equal(admits(inEmpire, LONER), false, "a country outside the empire stays out");
assert.equal(admits(inEmpire, EMPIRE), true, "sibling empires remain as context");
assert.equal(admits(inEmpire, NM_LINE), false, "artifacts stay out at every depth");

// Drilling into a country keeps other countries visible for context, but only
// its own provinces.
const inCountry: FocusState = {
  trail: [{ osmId: -2, name: "Prussia", adminLevel: 2 }],
  maxLevel: 4,
  allow: [-4],
  children: [],
  resolved: true,
};
assert.equal(admits(inCountry, PROVINCE), true, "its own province shows");
assert.equal(admits(inCountry, LONER), true, "neighbouring countries stay as context");
assert.equal(
  admits(inCountry, { admin_level: 4, osm_id: -99 }),
  false,
  "a province of some other country must never appear",
);
assert.equal(tipLevel(inCountry), 2);
assert.equal(tipLevel(world), 1, "the world view's tier is the supranational one");

// allow: [] still means "resolved, nothing qualified", not "no restriction".
assert.equal(
  admits({ ...inCountry, allow: [] }, PROVINCE),
  false,
  "an empty allow-list hides every subdivision",
);

// --- coveredIds: real point-in-polygon, not a bounding box ------------------
const sq = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Polygon",
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});
const cov = coveredIds([
  { properties: EMPIRE, geometry: sq(0, 0, 10, 10) },
  { properties: MEMBER, geometry: sq(1, 1, 3, 3) },
  { properties: LONER, geometry: sq(20, 20, 22, 22) },
  { properties: PROVINCE, geometry: sq(1, 1, 2, 2) },
]);
assert.deepEqual(cov, [-2], "only level-2 polities inside a level-1 one are covered");
assert.deepEqual(
  coveredIds([{ properties: MEMBER, geometry: sq(1, 1, 3, 3) }]),
  [],
  "no empire on screen means nothing is covered",
);

// An enclave inside the union's outer ring but NOT a member: the union's
// polygon has a hole there. Measured on live tiles first — testing the outer
// ring alone reported Switzerland, Liechtenstein and Andorra as covered by the
// European Union, which would have erased three countries from the map.
const NEUTRAL = { admin_level: 2, osm_id: -7 };
const holed = {
  type: "Polygon",
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]], // hole: the neutral state
  ],
};
assert.deepEqual(
  coveredIds([
    { properties: EMPIRE, geometry: holed },
    { properties: MEMBER, geometry: sq(1, 1, 3, 3) },
    { properties: NEUTRAL, geometry: sq(4.2, 4.2, 5.8, 5.8) },
  ]),
  [-2],
  "a country in the union's hole is not covered by it",
);
// And the same rule when drilling in: the enclave is not a member state.
assert.deepEqual(
  childIds(
    [
      { properties: EMPIRE, geometry: holed },
      { properties: MEMBER, geometry: sq(1, 1, 3, 3) },
      { properties: NEUTRAL, geometry: sq(4.2, 4.2, 5.8, 5.8) },
    ],
    -1,
    1,
  ).ids,
  [-2],
  "drilling into the union lists members, not enclaves",
);

// The paint guard: the reported "France empty with no fill". Geometry (on
// tile-clipped source features) can put a country inside an empire while the
// RENDERED empire has a hole there, so hiding the country paints nothing back.
// A candidate is only trusted as covered when an empire fill is proven to draw
// over its centre.
{
  const feats = [
    { properties: EMPIRE, geometry: sq(0, 0, 10, 10) },
    { properties: MEMBER, geometry: sq(1, 1, 3, 3) }, // centre ~ (2,2)
  ];
  assert.deepEqual(
    coveredIds(feats, undefined, () => true),
    [-2],
    "covered when an empire fill is painted over it",
  );
  assert.deepEqual(
    coveredIds(feats, undefined, () => false),
    [],
    "no empire fill behind it -> stays drawn, never an empty hole (France)",
  );
  // Selective: only the country an empire actually paints over is hidden.
  const MEMBER2 = { admin_level: 2, osm_id: -8 };
  assert.deepEqual(
    coveredIds(
      [...feats, { properties: MEMBER2, geometry: sq(6, 6, 8, 8) }], // centre ~ (7,7)
      undefined,
      (c) => c[0] < 5, // an empire fill is drawn on the left half only
    ),
    [-2],
    "the unpainted candidate survives; only the painted one hides",
  );
}

// --- one dataset at a time -------------------------------------------------
assert.deepEqual(normaliseSources(["ohm"]), ["ohm"]);
assert.deepEqual(
  normaliseSources(["ohm", "hb"]),
  ["hb"],
  "two datasets collapse to the last, which is the one just clicked",
);
assert.deepEqual(
  normaliseSources(["ohm", "today"]),
  ["ohm", "today"],
  "an overlay is not a dataset and must survive alongside one",
);
assert.deepEqual(
  normaliseSources(["today"]),
  ["ohm", "today"],
  "an overlay alone still needs a dataset under it",
);
assert.deepEqual(normaliseSources(["nonsense"]), ["ohm"], "unknown ids drop out");

// --- coastline clip masks salt water only ----------------------------------
// The Great-Lakes-preserving invariant: masking these hides the sea spill but
// leaves inland borders. If "lake" or "river" ever creep in, the US–Canada
// Great Lakes border silently vanishes.
assert.ok(OCEAN_KINDS.includes("bay"), "Hudson Bay must be masked");
assert.ok(!OCEAN_KINDS.includes("lake"), "lakes stay: keeps the Great Lakes border");
assert.ok(!OCEAN_KINDS.includes("river"), "rivers stay drawn");

// --- edits: the patch layer -------------------------------------------------
// These run in node, where localStorage does not exist, so the store is exercised
// through the pure helpers it is built from.
assert.equal(yearNum(undefined, -99999), -99999, "absent date keeps the sentinel");
assert.equal(Math.floor(yearNum("1815-06-18", 0)), 1815);
assert.equal(Math.floor(yearNum("-0218-01-01", 0)), -218, "BC years stay negative");
assert.equal(yearNum("garbage", 42), 42, "unparseable falls back, never NaN");
{
  // The numeric pair is what dateFilter compares, so an edit that sets only the
  // string would show the new date and change nothing on the map.
  const p = withDates({ osm_id: 1, start_date: "1500", end_date: "1806-08-06" });
  assert.equal(Math.floor(p.end_num!), 1806, "end_date must drive end_num");
  assert.equal(Math.floor(p.start_num!), 1500, "start_date must drive start_num");
  // A field the patch never mentions is not fabricated — the date filter's own
  // coalesce fallback supplies the open-ended sentinel instead.
  assert.equal("start_num" in withDates({ osm_id: 1, end_date: "1806" }), false);
}
{
  // A file that parses but is not an edits document must be refused, not
  // allowed to wipe the user's work with an empty object.
  assert.equal(importEdits("not json"), null);
  assert.equal(importEdits("[1,2,3]"), null, "an array is not an edits doc");
  assert.equal(importEdits("{}"), null, "empty object is a wrong file, not 'no edits'");
  const doc = sanitise({
    ohm: { overrides: { "-123": { props: { name: "X" } } }, added: [] },
    junk: "nope",
    hb: { overrides: {}, added: [{ type: "Feature", geometry: {}, properties: {} }] },
  });
  assert.deepEqual(Object.keys(doc).sort(), ["hb", "ohm"], "malformed buckets drop");
  assert.equal(doc.hb.added.length, 1);
}

{
  // Regression: a drawn region's id is a STRING ("edit-ohm-1"). The pick path
  // used to coerce every id with Number(), so the edit was filed under the key
  // "NaN" — the form showed the change and the map never moved. Found by driving
  // the live editor, not by any unit test, so it gets one now.
  const feats = [
    { properties: { osm_id: "edit-ohm-1", admin_level: 2, name: "Drawn" },
      geometry: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] } },
  ];
  // Parent given as a string id must still match its child.
  const r = childIds(feats, "root-1", 1, new Map([["edit-ohm-1", "root-1"]]));
  assert.deepEqual(r.ids, ["edit-ohm-1"], "string ids survive as themselves");
  assert.equal(r.nodes[0].name, "Drawn");
}

{
  // Regression: an edit must never make a region vanish. The original is hidden
  // only when there is a replacement to draw, so a props edit with no geometry
  // snapshot leaves the original rendering rather than excluding it into
  // nothing. Reported live as "made Portugal a child of the empire and it wiped
  // it off the map".
  const doc = sanitise({
    ohm: {
      overrides: {
        "-1": { props: { name: "no geometry captured" } },
        "-2": { props: { name: "ok" }, geometry: { type: "Polygon", coordinates: [] } },
        "-3": { deleted: true },
      },
      added: [],
    },
  });
  const ex = excludedIdsOf(doc, "ohm");
  assert.ok(!ex.includes(-1), "no geometry -> original stays visible, never hidden into nothing");
  assert.ok(ex.includes(-2), "an edit WITH geometry hides the original it replaces");
  assert.ok(ex.includes(-3), "a delete always hides");
}

// --- draw: a ring must be an area and must close ---------------------------
assert.equal(closeRing([[0, 0], [1, 1]] as any), null, "two points is not an area");
{
  const r = closeRing([[0, 0], [1, 0], [1, 1]] as any)!;
  assert.equal(r.length, 4, "the closing point is appended");
  assert.deepEqual(r[0], r[r.length - 1], "ring closes where it started");
  // Already closed input must not gain a duplicate point.
  const already = closeRing([[0, 0], [1, 0], [1, 1], [0, 0]] as any)!;
  assert.equal(already.length, 4);
}

// --- parent overrides beat geometry ----------------------------------------
{
  const sq = (x: number, y: number, w: number) => ({
    type: "Polygon",
    coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]],
  });
  const feats = [
    { properties: { osm_id: -1, admin_level: 1, name: "Union" }, geometry: sq(0, 0, 10) },
    // Inside the union geometrically, but assigned elsewhere by the user.
    { properties: { osm_id: 2, admin_level: 2, name: "Not a member" }, geometry: sq(1, 1, 2) },
    // Outside it, but the user says it belongs — a detached colony.
    { properties: { osm_id: 3, admin_level: 2, name: "Colony" }, geometry: sq(50, 50, 2) },
    // Inside AND assigned to it — a metropole the empire's fill covers.
    { properties: { osm_id: 4, admin_level: 2, name: "Metropole" }, geometry: sq(6, 6, 2) },
  ];
  const parents = new Map([["2", "-999"], ["3", "-1"], ["4", "-1"]]);
  const r = childIds(feats, -1, 1, parents);
  assert.deepEqual(r.ids.sort(), [3, 4], "explicit parent wins over containment, both ways");
  const cov = coveredIds(feats, parents);
  assert.ok(!cov.includes(2), "a country assigned away is not covered by the union");
  // Covering hides the child under the empire's fill. A detached colony has no
  // fill over it, so hiding it paints nothing back — the reported wipe. It must
  // stay drawn; only a child the empire actually covers is hidden.
  assert.ok(!cov.includes(3), "an assigned colony OUTSIDE the empire is not hidden");
  assert.ok(cov.includes(4), "an assigned member the empire's fill covers is hidden");
}

// --- a parent assignment is metadata, not a visible edit -------------------
{
  // Assigning a parent regroups the hierarchy but changes nothing on screen, so
  // it must NOT promote the region to an amber edit copy: the original OHM
  // polygon has to keep rendering (which is what makes it read as part of its
  // empire). Only a display change — name, dates, level — promotes.
  assert.equal(changesDisplay({ parent: -1 }), false, "parent alone is not a display change");
  assert.equal(changesDisplay({ name: "X" }), true, "a rename is");
  assert.equal(changesDisplay({ start_date: "1500" }), true, "a date is");
  const doc = sanitise({
    ohm: {
      overrides: {
        "-10": { props: { parent: -1 }, geometry: { type: "Polygon", coordinates: [] } },
        "-11": { props: { name: "Renamed", parent: -1 }, geometry: { type: "Polygon", coordinates: [] } },
      },
      added: [],
    },
  });
  const ex = excludedIdsOf(doc, "ohm");
  assert.ok(!ex.includes(-10), "parent-only edit leaves the original visible");
  assert.ok(ex.includes(-11), "a rename still hides the original for its amber copy");
  // withDates must not fabricate date numbers for a parent-only patch.
  assert.equal("start_num" in withDates({ osm_id: 1, parent: -1 }), false, "no date, no start_num");
}

// --- childIds hands the diagram real names ---------------------------------
const named = childIds(
  [
    { properties: { osm_id: -2, admin_level: 2 }, geometry: sq(0, 0, 10, 10) },
    { properties: { osm_id: -4, admin_level: 4, name: "Brandenburg" }, geometry: sq(1, 1, 2, 2) },
    { properties: { osm_id: -5, admin_level: 4, "name:en": "Silesia" }, geometry: sq(3, 3, 4, 4) },
    // No admin_level: an artifact must not be counted as a whole tier.
    { properties: { osm_id: 1, name: "12nm line - Prussia" }, geometry: sq(5, 5, 6, 6) },
  ],
  -2,
  2,
);
assert.deepEqual(named.ids, [-4, -5]);
assert.deepEqual(
  named.nodes.map((n) => n.name),
  ["Brandenburg", "Silesia"],
  "name:en wins where present, and the diagram gets real labels",
);
assert.equal(named.counts.get(4), 2);
assert.equal(named.counts.size, 1, "the maritime line formed no tier of its own");

// ===========================================================================
// The redesign: view options, the Studio scene, search, the strip, the
// hierarchy diagrams, annotations, and the new date box.
// ===========================================================================

// --- labelTextExpr: "neither part" must be EMPTY, not a bare newline --------
const yr = (p: string, f: string) => ["yr", p, f];
const both = labelTextExpr({ labelName: true, labelDates: true }, yr) as any[];
assert.equal(both[0], "format");
assert.ok(
  JSON.stringify(both).includes("\\n"),
  "name and dates are two lines",
);
assert.deepEqual(
  labelTextExpr({ labelName: false, labelDates: false }, yr),
  "",
  "both off collapses to an empty string, not a newline that still collides",
);
assert.ok(
  !JSON.stringify(labelTextExpr({ labelName: true, labelDates: false }, yr)).includes("yr"),
  "dates off drops the date expression entirely",
);
assert.ok(
  !JSON.stringify(labelTextExpr({ labelName: false, labelDates: true }, yr)).includes("name:en"),
  "name off drops the name expression entirely",
);

// --- Scene: the exception list, and the filter it produces ------------------
const s0 = emptyScene();
assert.equal(sceneFilter(s0), null, "an untouched 'everything' needs no filter");
assert.equal(inScene(s0, 42), true);

const s1 = toggleScene(s0, 42);
assert.deepEqual(s1.ids, ["42"]);
assert.equal(inScene(s1, 42), false, "'everything' + an id means that id is OUT");
assert.deepEqual(toggleScene(s1, 42).ids, [], "toggling again puts it back");
const sf1 = sceneFilter(s1) as any[];
assert.equal(sf1[0], "!", "under 'everything' the named ids are excluded");
assert.deepEqual(sf1[1][2][1], [42], "ids go in numeric so they match tile osm_id");

const s2 = toggleScene(setSceneMode(s0, "none"), "hb-3");
assert.equal(inScene(s2, "hb-3"), true, "'nothing' + an id means that id is IN");
assert.equal(inScene(s2, 42), false);
assert.equal((sceneFilter(s2) as any[])[0], "in", "under 'nothing' the named ids are the whole set");
assert.deepEqual((sceneFilter(s2) as any[])[2][1], ["hb-3"], "a non-numeric id stays a string");
// "Nothing, and nothing named yet" must hide everything — returning null there
// would silently mean "show the world" the moment you pressed Nothing.
assert.notEqual(sceneFilter(setSceneMode(s0, "none")), null);
assert.deepEqual(setSceneMode(s1, "all"), s1, "re-picking the current base is a no-op");

// --- rankMatches -----------------------------------------------------------
const places = [
  { id: 1, name: "Francheville", level: 8 },
  { id: 2, name: "France", level: 2 },
  { id: 3, name: "Franconia", level: 3 },
  { id: 4, name: "Kingdom of France", level: 2 },
  { id: 5, name: "Württemberg", level: 3 },
  { id: 2, name: "France (duplicate id)", level: 2 },
];
assert.deepEqual(
  rankMatches("fran", places).map((h) => h.name),
  ["France", "Franconia", "Francheville", "Kingdom of France"],
  "prefix beats substring, then shallower level, then shorter name",
);
assert.deepEqual(
  rankMatches("wurttemberg", places).map((h) => h.id),
  [5],
  "diacritics are folded, so an ASCII query finds Württemberg",
);
assert.deepEqual(
  rankMatches("preussisch", [{ id: 9, name: "Preußisch Eylau", level: 6 }]).map((h) => h.id),
  [9],
  "eszett folds to ss — NFD alone leaves it, and every Prussian district is spelled with one",
);
assert.deepEqual(
  rankMatches("kobenhavn", [{ id: 9, name: "København", level: 4 }]).map((h) => h.id),
  [9],
  "slashed o folds too; it is a letter, not an accent",
);
assert.equal(rankMatches("", places).length, 0, "an empty query matches nothing");
assert.equal(rankMatches("fran", places, 2).length, 2, "the limit is honoured");
assert.equal(
  rankMatches("france", places).filter((h) => h.id === 2).length,
  1,
  "one entry per id, however many tile pieces carried the name",
);

// --- stripTargets: which regions a new border is carved out of --------------
const lvl = (id: number, l: number, box: [number, number, number, number]) => ({
  properties: { osm_id: id, admin_level: l },
  geometry: sq(box[0], box[1], box[2], box[3]),
});
const nbrs = [
  lvl(100, 1, [0, 0, 100, 100]), // the parent empire
  lvl(101, 1, [200, 200, 300, 300]), // a RIVAL empire, elsewhere
  lvl(200, 2, [10, 10, 20, 20]), // a neighbouring country
  lvl(300, 3, [11, 11, 12, 12]), // a province inside that country
  lvl(400, 2, [30, 30, 40, 40]), // the region being drawn/edited
];
const carve = stripTargets(nbrs, 2, 100, 400).map((f) => f.properties.osm_id);
assert.deepEqual(
  carve.sort((a, b) => a - b),
  [101, 200],
  "same level and rival empires are stripped; the parent, its ancestors and deeper subdivisions are not",
);
assert.ok(!carve.includes(100), "the chosen parent is never stripped");
assert.ok(!carve.includes(300), "a subdivision inside the new region is kept, not carved out");
assert.ok(!carve.includes(400), "a region is never stripped from itself");
assert.deepEqual(
  stripTargets(nbrs, 2).map((f) => f.properties.osm_id).sort((a, b) => a - b),
  [100, 101, 200, 400],
  "with no parent named, every same-or-higher region qualifies",
);
// The ancestor rule is geometric: an empire that CONTAINS the parent contains
// the new region too, so stripping it would delete the whole shape.
const nested = [
  lvl(1, 1, [0, 0, 100, 100]), // grandparent empire
  lvl(2, 2, [10, 10, 50, 50]), // the parent country, inside it
  lvl(3, 3, [60, 60, 70, 70]), // an unrelated region at the new level
];
assert.deepEqual(
  stripTargets(nested, 3, 2).map((f) => f.properties.osm_id),
  [3],
  "the parent's own ancestors are spared, or the new region is carved to nothing",
);

// --- stripGeometry ---------------------------------------------------------
const drawn = sq(0, 0, 10, 10);
assert.equal(
  featureArea(stripGeometry(drawn, [])),
  100,
  "nothing to strip returns the shape untouched",
);
const cut = stripGeometry(drawn, [{ properties: {}, geometry: sq(5, -1, 11, 11) }]);
assert.equal(featureArea(cut), 50, "half the square is carved away");
assert.equal(
  stripGeometry(drawn, [{ properties: {}, geometry: sq(-1, -1, 11, 11) }]),
  null,
  "an entirely claimed area yields null, not an empty polygon that renders as nothing",
);
// Two disjoint bites make a MultiPolygon, which the overlay must still accept.
const split = stripGeometry(drawn, [
  { properties: {}, geometry: sq(4, -1, 6, 11) },
]) as any;
assert.equal(split.type, "MultiPolygon");
assert.equal(featureArea(split), 80);
assert.equal(distinctIds([lvl(1, 2, [0, 0, 1, 1]), lvl(1, 2, [2, 2, 3, 3])]), 1,
  "tile pieces of one region count once");

// --- hierTree + layout -----------------------------------------------------
const focusAt: FocusState = {
  trail: [
    { osmId: 1, name: "British Empire", adminLevel: 1 },
    { osmId: 2, name: "India", adminLevel: 2 },
  ],
  maxLevel: 4,
  allow: [],
  children: [
    { osmId: 10, name: "Bengal", adminLevel: 3 },
    { osmId: 11, name: "Madras", adminLevel: 3 },
    { osmId: 12, name: "Bombay", adminLevel: 3 },
  ],
  resolved: true,
};
const tree = hierTree(focusAt);
assert.equal(tree.name, "World");
assert.equal(tree.children[0].name, "British Empire");
assert.equal(tree.children[0].children[0].name, "India");
assert.equal(tree.children[0].children[0].kind, "tip");
assert.equal(tree.children[0].children[0].children.length, 3);
assert.equal(leafCount(tree, new Set()), 3);
assert.equal(leafCount(tree, new Set(["world"])), 1, "collapsing the root leaves one leaf");
assert.equal(
  hierTree({ ...focusAt, children: Array.from({ length: 40 }, (_, i) => ({ osmId: i, name: `p${i}`, adminLevel: 3 })) })
    .children[0].children[0].children.length,
  FAN_CAP,
  "the fan is capped so a 40-way sunburst is not a grey disc",
);

const lay = layout(tree);
assert.equal(lay.maxDepth, 3);
assert.deepEqual([lay.rows[0].a0, lay.rows[0].a1], [0, 1], "the root spans everything");
const leaves = lay.rows.filter((r) => !r.node.children.length);
assert.equal(leaves.length, 3);
// Siblings must partition their parent exactly, or the three diagrams disagree
// about how wide the same node is.
assert.equal(leaves[0].a0, 0);
assert.ok(Math.abs(leaves[2].a1 - 1) < 1e-9);
for (let i = 1; i < leaves.length; i++)
  assert.ok(Math.abs(leaves[i].a0 - leaves[i - 1].a1) < 1e-9, "no gap between siblings");
assert.equal(layout(tree, new Set(["world"])).rows.length, 1, "a collapsed root hides its branch");

// --- SVG path maths --------------------------------------------------------
const [px, py] = polar(0, 0, 10, 0);
assert.ok(Math.abs(px) < 1e-9 && Math.abs(py + 10) < 1e-9, "0 turns is 12 o'clock");
const [qx, qy] = polar(0, 0, 10, 0.25);
assert.ok(Math.abs(qx - 10) < 1e-9 && Math.abs(qy) < 1e-9, "a quarter turn is clockwise to 3 o'clock");
// The large-arc flag is why a lone child fills its ring instead of drawing as a
// sliver of the circle it in fact owns entirely.
assert.match(wedgePath(0, 0, 5, 10, 0, 1), / 1 1 /, "a full ring uses the large-arc flag");
assert.match(wedgePath(0, 0, 5, 10, 0, 0.25), / 0 1 /, "a quarter does not");
assert.ok(wedgePath(0, 0, 0, 10, 0, 0.5).includes("L0 0"), "an inner radius of 0 closes through the centre");
assert.ok(ribbonPath(0, 10, 0, 5, 2, 7).startsWith("M0 0"), "a ribbon starts at the parent edge");
assert.ok(radialLink(0, 0, 0, 0, 10, 0.5).startsWith("M0 0"), "a link starts at the parent node");

// --- parseWhen: one box that can express BC ---------------------------------
assert.equal(parseWhen("1815"), 1815);
assert.equal(parseWhen("44 BC"), -44);
assert.equal(parseWhen("44bce"), -44);
assert.equal(parseWhen("AD 800"), 800);
assert.equal(parseWhen("-0044"), -44, "the ISO signed form works too");
assert.ok(Math.abs(parseWhen("1815-06-18")! - 1815.4602739726) < 1e-6);
assert.equal(parseWhen(""), null);
assert.equal(parseWhen("Waterloo"), null);
assert.equal(parseWhen("12 apples"), null, "a number with trailing junk is not a year");

// --- niceStep: labels land on years a person would name ---------------------
assert.equal(niceStep(80), 10);
assert.equal(niceStep(40), 5);
assert.equal(niceStep(8), 1);
assert.equal(niceStep(2), 1, "never below a year — the data has no finer structure");
assert.equal(niceStep(800), 100);
assert.equal(niceStep(2000), 500, "the 1/2/5 ladder rounds up, so 2000 years steps by 500");

// --- annotations -----------------------------------------------------------
assert.deepEqual(wrapLines("one two three four", 9), ["one two", "three", "four"]);
assert.deepEqual(wrapLines("", 10), [""], "an empty caption is one empty line, not zero");
assert.deepEqual(
  wrapLines("Constantinopolitan", 5),
  ["Constantinopolitan"],
  "a word longer than the limit is never chopped in half",
);
const anns = [
  { ...newAnnot("photo", "text", [1, 2], 1) },
  { ...newAnnot("video", "character", [3, 4], 2) },
];
const fc = annotFeatures(anns, ["photo"]);
assert.equal(fc.features.length, 1, "each layer draws only its own annotations");
assert.deepEqual(fc.features[0].geometry.coordinates, [1, 2]);
assert.equal(fc.features[0].properties.id, "an-1");
assert.equal(annotFeatures(anns, ["video"]).features[0].properties.id, "an-2");
assert.equal(
  annotFeatures(anns, ["photo", "video"]).features.length,
  2,
  "both layers visible draws both — visibility is separate from which one is active",
);
assert.equal(annotFeatures(anns, []).features.length, 0, "hiding both draws nothing");

// --- normaliseCustom: a pasted dataset must not render empty ----------------
const custom = normaliseCustom(
  {
    features: [
      { properties: { NAME: "Ruritania", start_date: "1500", end_date: "1600" } },
      { properties: { name: "Syldavia", admin_level: 4 } },
      { properties: {} },
    ],
  },
  "src-1",
);
assert.equal(custom.features[0].properties.name, "Ruritania", "NAME is picked up");
assert.equal(custom.features[0].properties.admin_level, 2, "a missing level defaults to country");
assert.equal(custom.features[1].properties.admin_level, 4, "an existing level is preserved");
assert.equal(custom.features[0].properties.start_num, 1500);
assert.equal(custom.features[0].properties.end_num, 1600);
assert.equal(custom.features[1].properties.start_num, -99999, "no date means 'always existed'");
assert.equal(custom.features[2].properties.osm_id, "src-1-2", "ids are stamped so hover and labels dedupe");

// ===========================================================================
// Ocean stripping, layer visibility, and the editor's fact fields
// ===========================================================================

// --- bbox prefilter: what makes ocean stripping affordable ------------------
assert.deepEqual(bboxOf(sq(1, 2, 5, 9)), [1, 2, 5, 9]);
assert.equal(bboxOf({ type: "Point", coordinates: [0, 0] }), null);
assert.ok(boxesOverlap([0, 0, 2, 2], [1, 1, 3, 3]));
assert.ok(boxesOverlap([0, 0, 2, 2], [2, 2, 4, 4]), "touching counts as overlapping");
assert.ok(!boxesOverlap([0, 0, 1, 1], [2, 2, 3, 3]));
const far = { properties: { osm_id: "sea-far" }, geometry: sq(500, 500, 510, 510) };
const near = { properties: { osm_id: "sea-near" }, geometry: sq(4, 4, 20, 20) };
assert.deepEqual(
  nearBox([far, near], [0, 0, 10, 10]).map((f) => f.properties.osm_id),
  ["sea-near"],
  "a Pacific polygon is dropped before the clipper ever sees it",
);
assert.equal(nearBox([far, near], null).length, 2, "no bbox means no prefilter");

// The sea carves like any other target — the strip does not care what a
// polygon represents, which is why oceans needed no second code path.
const coastal = stripGeometry(sq(0, 0, 10, 10), [
  { properties: { osm_id: "sea-1" }, geometry: sq(6, -1, 11, 11) },
]);
assert.equal(featureArea(coastal), 60, "the drawn box now stops at the coastline");
assert.equal(
  featureArea(stripGeometry(sq(0, 0, 10, 10), [far])),
  100,
  "an ocean polygon nowhere near the shape changes nothing",
);

// --- annotation layer visibility -------------------------------------------
const two = [newAnnot("photo", "text", [0, 0], 1), newAnnot("video", "text", [1, 1], 2)];
assert.equal(annotFeatures(two, ["photo"]).features.length, 1);
assert.equal(annotFeatures(two, ["photo", "video"]).features.length, 2);
assert.equal(annotFeatures(two, []).features.length, 0);

// --- wikiTitle: every form people actually paste ----------------------------
assert.equal(wikiTitle("Kingdom of Bavaria"), "Kingdom of Bavaria");
assert.equal(wikiTitle("en:Kingdom of Bavaria"), "Kingdom of Bavaria");
assert.equal(
  wikiTitle("https://en.wikipedia.org/wiki/Kingdom_of_Bavaria"),
  "Kingdom of Bavaria",
  "a pasted URL is decoded and de-underscored",
);
assert.equal(
  wikiTitle("https://de.wikipedia.org/wiki/K%C3%B6nigreich_Bayern"),
  "Königreich Bayern",
  "percent-encoding survives",
);
assert.equal(
  wikiTitle("en.wikipedia.org/wiki/France#History"),
  "France",
  "a fragment is not part of the title",
);
assert.equal(wikiTitle("   "), "");

// --- metaFor / flagOverrides: facts must NOT promote a region ---------------
// The whole point: correcting a leader leaves the original polygon rendering.
assert.equal(
  changesDisplay({ leader: "Ludwig I", flag: "data:image/png;base64,x" }),
  false,
  "facts are not display keys, so no amber overlay copy is made",
);
assert.deepEqual(
  excludedIdsOf(
    { ohm: { overrides: { "7": { props: { leader: "Ludwig I" } } }, added: [] } },
    "ohm",
  ),
  [],
  "and the original is never hidden — a fact edit must be invisible on the map",
);

console.log("ok");
