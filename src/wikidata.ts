// Historical-Basemaps features carry no Wikidata IDs (only NAME/SUBJECTO/PARTOF),
// so we resolve by name, then read claims and filter their date qualifiers here.
//
// Speed: this used to GET Special:EntityData/<Q>.json, which is the WHOLE entity —
// 1.2 MB for France, and every byte of it parsed on the main thread. The Wikibase
// REST API serves one property at a time (~6-8 KB each), so we ask for exactly the
// five we render, in parallel. Same data, ~20x less of it.

const WD = "https://www.wikidata.org/w/api.php";
const REST = "https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items";
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

/** A REST statement. `value.content` is a filename, a Q-id, or {amount}. */
export type Stmt = {
  value?: { type?: string; content?: unknown };
  qualifiers?: {
    property?: { id?: string };
    value?: { content?: { time?: string } };
  }[];
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

function qualYear(s: Stmt, prop: string): number | null {
  return wdYear(
    s.qualifiers?.find((q) => q.property?.id === prop)?.value?.content?.time,
  );
}

/**
 * Statements whose P580..P582 window contains `year`.
 *
 * If the property has dated statements but none cover `year`, the answer is
 * NOTHING — never the first one in the list. France's P35 list starts in 1848, so
 * falling back to [0] would caption the year 1800 with the current president.
 * Undated statements are returned only when there are no dated ones at all.
 */
export function activeAt(stmts: Stmt[] | undefined, year: number): Stmt[] {
  if (!stmts?.length) return [];
  const dated = stmts.filter(
    (s) => qualYear(s, "P580") !== null || qualYear(s, "P582") !== null,
  );
  if (!dated.length) return stmts; // undated is the only answer available
  return dated.filter((s) => {
    const from = qualYear(s, "P580");
    const to = qualYear(s, "P582");
    return (from === null || from <= year) && (to === null || to >= year);
  });
}

/** Population is stamped with P585 (a point in time), not a range. */
export function closestByYear(stmts: Stmt[] | undefined, year: number) {
  if (!stmts?.length) return undefined;
  return stmts
    .map((s) => ({ s, y: qualYear(s, "P585") }))
    .sort((a, b) => Math.abs((a.y ?? 9e9) - year) - Math.abs((b.y ?? 9e9) - year))[0]
    ?.s;
}

const commons = (file: unknown, w: number) =>
  typeof file === "string"
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${w}`
    : undefined;

const cache = new Map<string, unknown>();

async function json(url: string): Promise<any> {
  if (cache.has(url)) return cache.get(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  const j = await r.json();
  cache.set(url, j);
  return j;
}

const soft = (url: string) => json(url).catch(() => undefined);
const stmts = (qid: string, p: string): Promise<Stmt[]> =>
  soft(`${REST}/${qid}/statements?property=${p}`).then((j) => j?.[p] ?? []);

/**
 * Known Q-id + year -> entity card. This is the accurate path: the id comes from
 * the clicked feature's own `wikidata` tag, so there is no name-matching step to
 * get wrong. `fallbackName` is only used if Wikidata has no English label.
 */
export async function lookupByQid(
  qid: string,
  year: number,
  fallbackName: string,
  enTitle?: string,
): Promise<Info> {
  try {
    const [flag, arms, p35, p6, pop, link, name] = await Promise.all([
      stmts(qid, "P41"),
      stmts(qid, "P94"),
      stmts(qid, "P35"),
      stmts(qid, "P6"),
      stmts(qid, "P1082"),
      enTitle ? undefined : soft(`${REST}/${qid}/sitelinks/enwiki`),
      label(qid),
    ]);

    // Polities disagree about which property holds "the ruler": the Kingdom of
    // Prussia uses P35 (head of state), the Roman Empire only has P6 (head of
    // government), and the UK populates both. Try P35, fall back to P6.
    const rulerId = (activeAt(p35, year)[0] ?? activeAt(p6, year)[0])?.value
      ?.content;

    const amount = (closestByYear(pop, year)?.value?.content as { amount?: string })
      ?.amount;

    // The OHM `wikipedia` tag beats the sitelink when present: it is the article
    // a human chose for this exact polity.
    const title = enTitle ?? link?.title;
    const wiki = title ? await summary(title) : undefined;

    return {
      name: name ?? fallbackName,
      qid,
      flag: commons(activeAt(flag, year)[0]?.value?.content, 240),
      arms: commons(activeAt(arms, year)[0]?.value?.content, 160),
      leader: typeof rulerId === "string" ? await label(rulerId) : undefined,
      population: amount
        ? Number(amount.replace("+", "")).toLocaleString()
        : undefined,
      summary: wiki?.extract,
      url: wiki?.url,
    };
  } catch {
    return { name: fallbackName };
  }
}

/** P41 flag FILENAME valid at `year` — "Flag of Bremen.svg" — or undefined. */
export async function flagFileFor(
  qid: string,
  year: number,
): Promise<string | undefined> {
  const f = activeAt(await stmts(qid, "P41"), year)[0]?.value?.content;
  return typeof f === "string" ? f : undefined;
}

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/** Commons treats "_" and " " as the same character in a filename. */
export const normFile = (f: string) => f.replace(/_/g, " ");

/**
 * Commons filenames -> thumbnail URLs, many files in ONE request.
 *
 * `commons()` above is fine for an <img src>, but NOT for map icons: that URL is
 * a 302 to upload.wikimedia.org, and only the final hop carries
 * access-control-allow-origin, so a fetch/createImageBitmap on it is blocked
 * before it ever redirects. The API hands back the upload.wikimedia.org URL
 * directly, which is CORS-open and readable.
 */
export async function thumbUrls(
  files: string[],
  width = 64,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!files.length) return out;
  // The API caps titles at 50 per call.
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const titles = batch.map((f) => `File:${f}`).join("|");
    const j = await soft(
      `${COMMONS_API}?action=query&format=json&origin=*&prop=imageinfo` +
        `&iiprop=url&iiurlwidth=${width}&titles=${encodeURIComponent(titles)}`,
    );
    for (const p of Object.values(j?.query?.pages ?? {}) as any[]) {
      const url = p?.imageinfo?.[0]?.thumburl;
      // The API normalises underscores to spaces in the title it echoes back,
      // so key on the normalised form and let callers do the same.
      if (url) out.set(normFile(String(p.title).replace(/^File:/, "")), url);
    }
  }
  return out;
}

/**
 * Name + year -> entity card. The FALLBACK path, for the ~10% of OHM features
 * with no `wikidata` tag. Never throws; falls back to just the name.
 */
export async function lookup(name: string, year: number): Promise<Info> {
  try {
    // ponytail: first search hit wins. Map names are ambiguous ("Prussia" resolves
    // to the region Q38872, not the Kingdom Q27306 that has the leader data), which
    // is exactly why lookupByQid exists and this is only the fallback.
    const search = await json(
      `${WD}?action=wbsearchentities&search=${encodeURIComponent(name)}` +
        `&language=en&format=json&limit=1&origin=*`,
    );
    const qid: string | undefined = search.search?.[0]?.id;
    if (!qid) return { name };
    return await lookupByQid(qid, year, name);
  } catch {
    return { name }; // ancient/obscure polities routinely miss; caller shows raw props
  }
}

async function label(qid: string): Promise<string | undefined> {
  const v = await soft(`${REST}/${qid}/labels/en`);
  return typeof v === "string" ? v : undefined;
}

async function summary(title: string) {
  const j = await soft(`${WP}/${encodeURIComponent(title)}`);
  return j?.extract
    ? { extract: j.extract as string, url: j.content_urls?.desktop?.page as string }
    : undefined;
}
