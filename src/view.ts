// What the map SHOWS, as opposed to what data it holds.
//
// Three small stores that the sidebar, the Studio scene picker and the search
// box all read. Kept pure and free of maplibre so they can be asserted in node:
// each one only builds a value (a filter expression, a layout expression, a
// ranked list) and hands it to map.ts to apply.

// ---------------------------------------------------------------------------
// Display options — the right sidebar's toggles
// ---------------------------------------------------------------------------

export type Projection = "mercator" | "globe";

export type Display = {
  /** Territory colour fill. Off leaves the border lines and labels alone. */
  fill: boolean;
  /** Label parts, each independently switchable. */
  labelName: boolean;
  labelDates: boolean;
  labelFlag: boolean;
  projection: Projection;
};

export const DEFAULT_DISPLAY: Display = {
  fill: true,
  labelName: true,
  labelDates: true,
  labelFlag: true,
  projection: "mercator",
};

const DISPLAY_STORE = "display:v1";

export function savedDisplay(): Display {
  try {
    const v = JSON.parse(localStorage.getItem(DISPLAY_STORE) ?? "null");
    return v && typeof v === "object"
      ? { ...DEFAULT_DISPLAY, ...v, projection: v.projection === "globe" ? "globe" : "mercator" }
      : { ...DEFAULT_DISPLAY };
  } catch {
    return { ...DEFAULT_DISPLAY };
  }
}

export const saveDisplay = (d: Display) =>
  localStorage.setItem(DISPLAY_STORE, JSON.stringify(d));

/**
 * The `text-field` for the shared label layer.
 *
 * Built here rather than inline in map.ts because "name off AND dates off" must
 * produce an EMPTY string, not the literal "\n" that naively concatenating the
 * two parts leaves behind — an empty label still reserves collision space and
 * pushed neighbouring names off the map.
 */
export function labelTextExpr(
  d: Pick<Display, "labelName" | "labelDates">,
  yearOf: (prop: string, fallback: string) => unknown,
): unknown {
  const name: any = ["coalesce", ["get", "name:en"], ["get", "name"], ""];
  const dates: any = [
    "concat",
    yearOf("start_date", "?"),
    "–",
    yearOf("end_date", "present"),
  ];
  if (!d.labelName && !d.labelDates) return "";
  if (!d.labelDates) return ["format", name, {}];
  if (!d.labelName)
    return ["format", dates, { "font-scale": 0.9, "text-color": "#9ca3af" }];
  return [
    "format",
    name,
    {},
    "\n",
    {},
    dates,
    { "font-scale": 0.72, "text-color": "#9ca3af" },
  ];
}

// ---------------------------------------------------------------------------
// Studio scene — which polities are in the shot
// ---------------------------------------------------------------------------

/**
 * `mode` is the starting point and `ids` are the EXCEPTIONS to it, so both
 * "everything except these three" and "only these three" cost the same and
 * flipping the base toggle never loses the picks made under the other one.
 */
export type Scene = { mode: "all" | "none"; ids: string[] };

export const emptyScene = (): Scene => ({ mode: "all", ids: [] });

export const inScene = (s: Scene, id: string | number): boolean =>
  s.mode === "all" ? !s.ids.includes(String(id)) : s.ids.includes(String(id));

/** Add or remove one polity, whichever the current membership makes it. */
export function toggleScene(s: Scene, id: string | number): Scene {
  const key = String(id);
  return s.ids.includes(key)
    ? { ...s, ids: s.ids.filter((x) => x !== key) }
    : { ...s, ids: [...s.ids, key] };
}

/** Switch the base without discarding the exception list's meaning: the same
 *  visible set is preserved by inverting which ids are named. */
export const setSceneMode = (s: Scene, mode: "all" | "none"): Scene =>
  s.mode === mode ? s : { mode, ids: [] };

/**
 * The layer clause, or null for "no restriction" — which is what an untouched
 * `all` scene is, and returning a filter for it would needlessly re-evaluate
 * every feature on every timeline tick.
 */
export function sceneFilter(s: Scene): unknown | null {
  if (!s.ids.length) return s.mode === "all" ? null : ["==", ["literal", 1], 0];
  // Tile ids are numbers; a string never matches ["in", ["get","osm_id"]].
  const lit = s.ids.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== "" ? n : v;
  });
  const member: any = ["in", ["get", "osm_id"], ["literal", lit]];
  return s.mode === "all" ? ["!", member] : member;
}

// ---------------------------------------------------------------------------
// Search ranking
// ---------------------------------------------------------------------------

export type Hit = { id: string | number; name: string; level: number };

/**
 * Rank name matches for the search box.
 *
 * Prefix beats substring, and a shallower admin_level beats a deeper one, so
 * typing "fra" offers France before Franconia and Franconia before some
 * commune called Francheville. Diacritics are folded, or "Wurttemberg" would
 * never find "Württemberg".
 */
export function rankMatches(query: string, items: Hit[], limit = 8): Hit[] {
  const q = fold(query);
  if (!q) return [];
  const seen = new Set<string>();
  const scored: { h: Hit; score: number }[] = [];
  for (const h of items) {
    const n = fold(h.name);
    if (!n) continue;
    const at = n.indexOf(q);
    if (at < 0) continue;
    const key = String(h.id);
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ h, score: (n === q ? 0 : at === 0 ? 1 : 2) * 100 + h.level });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.h.name.length - b.h.name.length,
  );
  return scored.slice(0, limit).map((s) => s.h);
}

/**
 * Letters NFD cannot help with.
 *
 * NFD splits an accented letter into base + combining mark, which the
 * \p{Diacritic} strip then removes — but ß, ø, ł, đ, æ and œ are separate
 * letters, not accented ones, so they survive it unchanged. On a map of
 * historical Europe that is not an edge case: typing "preussisch" found
 * nothing at all, because every Prussian district is spelled "Preußisch".
 */
const LETTERS: Record<string, string> = {
  ß: "ss",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  æ: "ae",
  œ: "oe",
};

// \p{Diacritic} rather than a literal combining-mark range, so this source file
// stays pure ASCII and cannot be mangled by an editor that normalises Unicode.
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[ßøłđðþæœ]/g, (c) => LETTERS[c])
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
