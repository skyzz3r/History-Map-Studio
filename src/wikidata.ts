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

/** Name + year -> entity card. Never throws; falls back to just the name. */
export async function lookup(name: string, year: number): Promise<Info> {
  try {
    // ponytail: first search hit wins. Map names are ambiguous ("Prussia" resolves
    // to the region Q38872, not the Kingdom Q27306 that has the leader data).
    // Scoring several candidates costs a fetch each — do it only if it bites.
    const search = await json(
      `${WD}?action=wbsearchentities&search=${encodeURIComponent(name)}` +
        `&language=en&format=json&limit=1&origin=*`,
    );
    const hit = search.search?.[0];
    const qid: string | undefined = hit?.id;
    if (!qid) return { name };

    // One round trip for everything, including an optimistic guess at the
    // Wikipedia title (it equals the label often enough to skip a hop).
    const [flag, arms, p35, p6, pop, link, guess] = await Promise.all([
      stmts(qid, "P41"),
      stmts(qid, "P94"),
      stmts(qid, "P35"),
      stmts(qid, "P6"),
      stmts(qid, "P1082"),
      soft(`${REST}/${qid}/sitelinks/enwiki`),
      summary(hit.label ?? name),
    ]);

    // Polities disagree about which property holds "the ruler": the Kingdom of
    // Prussia uses P35 (head of state), the Roman Empire only has P6 (head of
    // government), and the UK populates both. Try P35, fall back to P6.
    const ruler = activeAt(p35, year)[0] ?? activeAt(p6, year)[0];
    const rulerId = ruler?.value?.content;

    const amount = (closestByYear(pop, year)?.value?.content as { amount?: string })
      ?.amount;

    const title: string | undefined = link?.title;
    const wiki =
      guess ?? (title && title !== hit.label ? await summary(title) : undefined);

    return {
      name: hit.label ?? name,
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
