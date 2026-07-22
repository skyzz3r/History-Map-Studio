// OHM tag lookup by osm_id.
//
// The hosted vector tiles carry name/dates/admin_level but NOT `wikidata`, even
// though 3475 of OHM's 3880 admin_level=2 relations have that tag. Overpass
// gives it back, keyed by the osm_id already in the tile, so a click resolves to
// an exact Q-id instead of guessing from a name string. That guess was the whole
// reason clicking Prussia returned the region and not the kingdom.
//
// Running scripts/build-tiles.sh with `-y wikidata` would bake the tag into the
// tiles and make this file unnecessary.

const OVERPASS = "https://overpass-api.openhistoricalmap.org/api/interpreter";

export type Tags = Record<string, string>;

// null means "asked, nothing there" — cached so we never ask twice.
const cache = new Map<number, Tags | null>();

export const cachedTags = (osmId: number) => cache.get(osmId);

/**
 * Tile osm_id -> Overpass element ref. Relations are negative in the tiles and
 * positive in the API; ways keep their sign.
 */
function ref(osmId: number): { type: "relation" | "way"; id: number } {
  return osmId < 0
    ? { type: "relation", id: -osmId }
    : { type: "way", id: osmId };
}

const osmIdOf = (el: { type?: string; id?: number }) =>
  el.type === "relation" ? -(el.id ?? 0) : (el.id ?? 0);

/** Overpass response -> tags keyed by the SAME osm_id the tiles use. */
export function parseOverpass(body: unknown): Map<number, Tags> {
  const out = new Map<number, Tags>();
  for (const el of (body as any)?.elements ?? []) {
    if (!el?.id || !el.tags) continue;
    out.set(osmIdOf(el), el.tags as Tags);
  }
  return out;
}

/** "Q165154" from an OHM tag set, or undefined. Ignores malformed values. */
export function qidOf(tags: Tags | null | undefined): string | undefined {
  const v = tags?.wikidata;
  return v && /^Q\d+$/.test(v) ? v : undefined;
}

/** "en:Kingdom of Sardinia" -> the article title. Non-English links are skipped. */
export function enTitleOf(tags: Tags | null | undefined): string | undefined {
  const v = tags?.wikipedia;
  return v?.startsWith("en:") ? v.slice(3) : undefined;
}

/**
 * Tags for many features in ONE request. Already-cached ids cost nothing, so
 * callers can pass a whole viewport without filtering first.
 */
export async function fetchTags(osmIds: number[]): Promise<void> {
  const want = [...new Set(osmIds)].filter((id) => id && !cache.has(id));
  if (!want.length) return;

  const rels = want.filter((id) => id < 0).map((id) => ref(id).id);
  const ways = want.filter((id) => id > 0).map((id) => ref(id).id);
  const q =
    "[out:json][timeout:30];(" +
    (rels.length ? `rel(id:${rels.join(",")});` : "") +
    (ways.length ? `way(id:${ways.join(",")});` : "") +
    ");out tags;";

  try {
    const r = await fetch(OVERPASS, {
      method: "POST",
      body: new URLSearchParams({ data: q }),
    });
    if (!r.ok) throw new Error(`overpass ${r.status}`);
    const found = parseOverpass(await r.json());
    // Cache the misses too, or a feature Overpass has no tags for is re-fetched
    // on every single idle.
    for (const id of want) cache.set(id, found.get(id) ?? null);
  } catch (e) {
    console.warn("overpass lookup failed", e);
  }
}
