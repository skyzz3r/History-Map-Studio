// The only test. Covers the three functions where a subtle bug would be silent:
// bearing wrap-around, Wikidata's signed year format, and keyframe bracketing.
// Run: npm test
import assert from "node:assert/strict";
import { lerpBearing, sampleCamera, type Key } from "./keyframes.ts";
import { activeAt, wdYear } from "./wikidata.ts";
import { enTitleOf, parseOverpass, qidOf } from "./ohm.ts";
import { toDecimalYear, toInputDate } from "./dates.ts";

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

console.log("ok");
