// GeoJSONSeq filter: adds numeric start_num / end_num so MapLibre can compare
// dates on the GPU. Reads stdin, writes stdout, one feature per line.
//
// Sentinels, not nulls: a feature with no start date has always existed, one
// with no end date still exists. null fails every numeric comparison, which
// would silently hide the feature instead of always showing it.
import { createInterface } from "node:readline";
import { toDecimalYear } from "../src/dates.ts";

const NEVER_STARTED = -99999;
const NEVER_ENDED = 99999;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let kept = 0;
let dated = 0;

for await (const line of rl) {
  if (!line.trim()) continue;
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    continue; // one bad line must not kill a multi-hour build
  }
  const p = (f.properties ??= {});
  const s = toDecimalYear(p.start_date);
  const e = toDecimalYear(p.end_date);
  p.start_num = s ?? NEVER_STARTED;
  p.end_num = e ?? NEVER_ENDED;
  if (s !== null || e !== null) dated++;
  kept++;
  process.stdout.write(JSON.stringify(f) + "\n");
}

process.stderr.write(`   ${kept} features, ${dated} with dates\n`);
