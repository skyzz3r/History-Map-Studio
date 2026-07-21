// No SPARQL, no server proxy. Historical-Basemaps features carry no Wikidata IDs
// (only NAME/SUBJECTO/PARTOF), so we resolve by name, then read the entity JSON and
// filter claim qualifiers client-side. That is less code than the equivalent SPARQL
// qualifier query AND it makes the cache key year-independent: one entity blob
// answers every year.

const WD = "https://www.wikidata.org/w/api.php";
const ENTITY = "https://www.wikidata.org/wiki/Special:EntityData";
const WP = "https://en.wikipedia.org/api/rest_v1/page/summary";

export type Info = {
  name: string;
  qid?: string;
  flag?: string;
  arms?: string;
  leader?: string;
  population?: string;
  summary?: string;
  url?: string;
};

type Snak = {
  mainsnak?: { datavalue?: { value: unknown } };
  qualifiers?: Record<string, { datavalue?: { value: { time?: string } } }[]>;
};

/**
 * Wikidata times look like "+1756-08-29T00:00:00Z" or "-0044-03-15T00:00:00Z".
 * The leading sign means you cannot split on the first "-", so skip index 0.
 */
export function wdYear(time: string | undefined): number | null {
  if (!time) return null;
  const end = time.indexOf("-", 1);
  const n = parseInt(time.slice(0, end < 0 ? time.length : end), 10);
  return Number.isFinite(n) ? n : null;
}

function qualYear(c: Snak, prop: string): number | null {
  return wdYear(c.qualifiers?.[prop]?.[0]?.datavalue?.value?.time);
}

/**
 * Claims whose P580..P582 window contains `year`.
 *
 * If the property has dated claims but none cover `year`, the answer is NOTHING —
 * never the first claim in the list. France's P35 list starts in 1848, so falling
 * back to claims[0] would caption the year 1800 with the current president.
 * Undated claims are returned only when the property has no dated claims at all.
 */
export function activeAt(claims: Snak[] | undefined, year: number): Snak[] {
  if (!claims?.length) return [];
  const dated = claims.filter(
    (c) => qualYear(c, "P580") !== null || qualYear(c, "P582") !== null,
  );
  if (!dated.length) return claims; // undated claim is the only answer available
  return dated.filter((c) => {
    const s = qualYear(c, "P580");
    const e = qualYear(c, "P582");
    return (s === null || s <= year) && (e === null || e >= year);
  });
}

const commons = (file: unknown, w: number) =>
  typeof file === "string"
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${w}`
    : undefined;

const cache = new Map<string, unknown>();

async function json(url: string): Promise<any> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  const j = await r.json();
  cache.set(url, j);
  return j;
}

/** Name + year -> entity card. Never throws; falls back to just the name. */
export async function lookup(name: string, year: number): Promise<Info> {
  try {
    // ponytail: first search hit wins. Map names are ambiguous ("Prussia" resolves to
    // the region Q38872, not the Kingdom Q27306 which actually has the leader data).
    // Disambiguating properly means fetching several candidates and scoring them —
    // do that only if wrong entities become a real complaint.
    const search = await json(
      `${WD}?action=wbsearchentities&search=${encodeURIComponent(name)}` +
        `&language=en&format=json&limit=1&origin=*`,
    );
    const qid: string | undefined = search.search?.[0]?.id;
    if (!qid) return { name };

    const data = await json(`${ENTITY}/${qid}.json`);
    const e = data.entities?.[qid];
    const claims: Record<string, Snak[]> = e?.claims ?? {};

    const flagFile = activeAt(claims.P41, year)[0]?.mainsnak?.datavalue?.value;
    const armsFile = activeAt(claims.P94, year)[0]?.mainsnak?.datavalue?.value;

    // Polities are inconsistent about which property holds "the ruler": the Kingdom
    // of Prussia uses P35 (head of state), the Roman Empire only has P6 (head of
    // government), and the UK populates both. Try P35, fall back to P6.
    const leaderClaim =
      activeAt(claims.P35, year)[0] ?? activeAt(claims.P6, year)[0];
    const leaderId = (leaderClaim?.mainsnak?.datavalue?.value as { id?: string })
      ?.id;

    const popClaim = closestByYear(claims.P1082, year);
    const popAmount = (popClaim?.mainsnak?.datavalue?.value as { amount?: string })
      ?.amount;

    const title: string | undefined = e?.sitelinks?.enwiki?.title;

    const [leader, wiki] = await Promise.all([
      leaderId ? label(leaderId) : undefined,
      title ? summary(title) : undefined,
    ]);

    return {
      name: e?.labels?.en?.value ?? name,
      qid,
      flag: commons(flagFile, 240),
      arms: commons(armsFile, 160),
      leader,
      population: popAmount
        ? Number(popAmount.replace("+", "")).toLocaleString()
        : undefined,
      summary: wiki?.extract,
      url: wiki?.url,
    };
  } catch {
    return { name }; // ancient/obscure polities routinely miss; caller shows raw props
  }
}

/** Population claims are stamped with P585 (point in time), not a range. */
function closestByYear(claims: Snak[] | undefined, year: number) {
  if (!claims?.length) return undefined;
  return claims
    .map((c) => ({ c, y: qualYear(c, "P585") }))
    .sort((a, b) => Math.abs((a.y ?? 9e9) - year) - Math.abs((b.y ?? 9e9) - year))[0]?.c;
}

async function label(qid: string): Promise<string | undefined> {
  try {
    const j = await json(
      `${WD}?action=wbgetentities&ids=${qid}&props=labels&languages=en&format=json&origin=*`,
    );
    return j.entities?.[qid]?.labels?.en?.value;
  } catch {
    return undefined;
  }
}

async function summary(title: string) {
  try {
    const j = await json(`${WP}/${encodeURIComponent(title)}`);
    return { extract: j.extract as string, url: j.content_urls?.desktop?.page as string };
  } catch {
    return undefined;
  }
}
