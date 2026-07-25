// The only test. Covers the three functions where a subtle bug would be silent:
// bearing wrap-around, Wikidata's signed year format, and keyframe bracketing.
// Run: npm test
import assert from "node:assert/strict";
import { lerpBearing, sampleCamera, type Key } from "./keyframes.ts";
import { activeAt, wdYear } from "./wikidata.ts";
import { enTitleOf, parseBounds, parseOverpass, qidOf } from "./ohm.ts";
import { toDecimalYear, toInputDate } from "./dates.ts";
import {
  featureArea,
  inside,
  insideGeometry,
  labelPoint,
  pointOnSurface,
} from "./geo.ts";
import { buildLabelPoints } from "./labels.ts";
import { bboxArea, claimsFrom, overlappingIds, type Sample } from "./claims.ts";
import { childIds, focusFilter, inBounds, mergeAllow, nextLevel } from "./focus.ts";
import { normaliseCShapes, normaliseHB } from "./sources.ts";

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

// --- focus: countries stay visible, deeper levels are gated ---
assert.deepEqual(focusFilter({ trail: [], maxLevel: 2, allow: null }),
  ["<=", ["coalesce", ["get", "admin_level"], 99], 2]);
// With an allow-list, level<=2 still passes so the parent keeps its context.
const gated: any = focusFilter({ trail: [], maxLevel: 4, allow: [7, 8] });
assert.equal(gated[0], "all");
assert.deepEqual(gated[2][2], ["in", ["get", "osm_id"], ["literal", [7, 8]]]);

// The subdivisions tier is the one with the MOST members, not the shallowest.
// Drilling into Prussia really did find a single admin_level 3 feature (Neutral
// Moresnet) beside a dozen level-4 provinces; taking the shallowest showed
// Moresnet alone and hid every province.
assert.equal(nextLevel(2, new Map([[3, 1], [4, 12]])), 4, "12 provinces beat 1 oddity");
assert.equal(nextLevel(2, new Map([[4, 5], [6, 40]])), 6, "deeper tier can win");
assert.equal(nextLevel(2, new Map([[2, 90]])), 2, "nothing deeper -> stay put");
assert.equal(nextLevel(2, new Map()), 2, "no children -> stay put");
// Ties go to the shallower tier, which is the more useful default.
assert.equal(nextLevel(2, new Map([[4, 7], [6, 7]])), 4);

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
const openNull = JSON.stringify(focusFilter({ trail: [], maxLevel: 4, allow: null }));
const openEmpty = JSON.stringify(focusFilter({ trail: [], maxLevel: 4, allow: [] }));
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

console.log("ok");
