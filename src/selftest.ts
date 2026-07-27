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
import { normaliseCShapes, normaliseHB, normaliseSources } from "./sources.ts";
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

console.log("ok");
