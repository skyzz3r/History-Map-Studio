// The only test. Covers the three functions where a subtle bug would be silent:
// bearing wrap-around, Wikidata's signed year format, and keyframe bracketing.
// Run: npm test
import assert from "node:assert/strict";
import { lerpBearing, sampleCamera, type Key } from "./keyframes.ts";
import { activeAt, wdYear } from "./wikidata.ts";

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
const claim = (id: string, start?: number, end?: number) => ({
  mainsnak: { datavalue: { value: { id } } },
  qualifiers: {
    ...(start !== undefined && {
      P580: [{ datavalue: { value: { time: `+${String(start).padStart(4, "0")}-01-01T00:00:00Z` } } }],
    }),
    ...(end !== undefined && {
      P582: [{ datavalue: { value: { time: `+${String(end).padStart(4, "0")}-01-01T00:00:00Z` } } }],
    }),
  },
});
const presidents = [claim("deGaulle", 1959, 1969), claim("macron", 2017)];

const idOf = (claims: ReturnType<typeof activeAt>) =>
  (claims[0]?.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id;

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

console.log("ok");
