// User edits to the border datasets.
//
// The datasets are read-only in different ways: OHM arrives as vector PMTiles
// whose properties and geometry cannot be mutated at all, while HB and CShapes
// are GeoJSON we happen to hold in memory. MapLibre filters can only test tile
// properties and zoom — there is no hook for "look this id up in a map" — so an
// edit cannot be expressed as a paint or filter trick over the original data.
//
// So edits are a PATCH LAYER, built from two mechanisms that work the same for
// every source:
//
//   1. excludedIds()  — ids filtered OUT of the dataset's own layers.
//   2. editFeatures() — a plain GeoJSON overlay carrying the replacements.
//
// Editing an existing region is therefore a PROMOTE: snapshot its geometry,
// exclude the original by id, and draw the edited copy from the overlay. Adding
// is the same thing without an original. Deleting is exclusion alone.
//
// Edits are namespaced by source id: correcting OHM must not put phantom shapes
// on Historical-Basemaps, which disagrees with it about nearly every border.

import { NO_END, NO_START } from "./sources.ts";

export type EditProps = {
  osm_id: string | number;
  name?: string;
  admin_level?: number;
  start_date?: string;
  end_date?: string;
  start_num?: number;
  end_num?: number;
  /** osm_id of the polity this one belongs to. Overrides geometric containment. */
  parent?: string | number;
  [k: string]: unknown;
};

export type EditFeature = {
  type: "Feature";
  geometry: unknown;
  properties: EditProps;
};

export type Override = {
  /** Property changes layered over the original. */
  props?: Partial<EditProps>;
  /** Hidden entirely. */
  deleted?: boolean;
  /** Geometry snapshotted at promote time, so the overlay can draw it. */
  geometry?: unknown;
};

export type SourceEdits = {
  overrides: Record<string, Override>;
  added: EditFeature[];
};

export type EditsDoc = Record<string, SourceEdits>;

const STORE = "edits:v1";

const emptySource = (): SourceEdits => ({ overrides: {}, added: [] });

let doc: EditsDoc = {};
let loaded = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Anything shaped wrong is discarded rather than thrown: a corrupt or
 * half-written entry must not take the whole map down on load, and the editor
 * is the only way back to a good state.
 */
export function sanitise(raw: unknown): EditsDoc {
  const out: EditsDoc = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [src, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Partial<SourceEdits>;
    const overrides: Record<string, Override> = {};
    for (const [id, o] of Object.entries(s.overrides ?? {})) {
      if (o && typeof o === "object") overrides[id] = o as Override;
    }
    const added = (Array.isArray(s.added) ? s.added : []).filter(
      (f): f is EditFeature =>
        !!f && typeof f === "object" && !!(f as EditFeature).geometry,
    );
    out[src] = { overrides, added };
  }
  return out;
}

export function loadEdits(): EditsDoc {
  if (loaded) return doc;
  loaded = true;
  try {
    doc = sanitise(JSON.parse(localStorage.getItem(STORE) ?? "null"));
  } catch {
    doc = {};
  }
  return doc;
}

const listeners = new Set<() => void>();

/** Subscribe to any change. Returns the unsubscribe. */
export function onEditsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Announce that the edit set now READS differently without anything being
 * written — which is what switching border dataset does, since edits are
 * namespaced by source. Without this the overlay kept drawing the previous
 * dataset's corrections over the new one, and the editor kept naming the old
 * source in its header.
 */
export const touchEdits = () => {
  for (const fn of listeners) fn();
};

function commit() {
  try {
    localStorage.setItem(STORE, JSON.stringify(doc));
  } catch (e) {
    // A full quota must not silently drop the edit from the screen too — the
    // in-memory doc stays authoritative and the user still sees their work.
    console.warn("could not persist edits", e);
  }
  for (const fn of listeners) fn();
}

const bucket = (src: string): SourceEdits => {
  loadEdits();
  return (doc[src] ??= emptySource());
};

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

/**
 * Merge a property patch onto a feature.
 *
 * `geometry` is stored the first time so the overlay has something to draw:
 * the original is excluded from its own layer the moment an override exists,
 * and without a snapshot the region would simply vanish on save.
 */
export function setOverride(
  src: string,
  id: string | number,
  patch: Partial<EditProps>,
  geometry?: unknown,
) {
  const b = bucket(src);
  const key = String(id);
  // An added feature is edited in place — it has no original to exclude, and
  // routing it through overrides would exclude the id from a layer it is not in
  // and then draw it twice.
  const made = b.added.find((f) => String(f.properties.osm_id) === key);
  if (made) {
    made.properties = withDates({ ...made.properties, ...patch });
    return commit();
  }
  const prev = b.overrides[key] ?? {};
  b.overrides[key] = {
    ...prev,
    props: withDates({ ...prev.props, ...patch } as EditProps),
    geometry: prev.geometry ?? geometry,
  };
  commit();
}

export function deleteFeature(src: string, id: string | number) {
  const b = bucket(src);
  const key = String(id);
  const before = b.added.length;
  // Deleting something the user added removes it outright; there is no original
  // underneath to keep hiding.
  b.added = b.added.filter((f) => String(f.properties.osm_id) !== key);
  if (b.added.length !== before) return commit();
  b.overrides[key] = { ...(b.overrides[key] ?? {}), deleted: true };
  commit();
}

/** Undo a delete, and any property edits with it. */
export function restore(src: string, id: string | number) {
  const b = bucket(src);
  delete b.overrides[String(id)];
  commit();
}

export function addFeature(src: string, feat: EditFeature) {
  const b = bucket(src);
  b.added.push({ ...feat, properties: withDates(feat.properties) });
  commit();
}

export function clearSource(src: string) {
  loadEdits();
  delete doc[src];
  commit();
}

/** A stable, obviously-synthetic id, so an added region never collides with a
 *  real osm_id (which are numeric) and is recognisable in exports. */
export const newEditId = (src: string, n: number) => `edit-${src}-${n}`;

export const countEdits = (src: string) => {
  const b = loadEdits()[src];
  if (!b) return 0;
  return Object.keys(b.overrides).length + b.added.length;
};

// ---------------------------------------------------------------------------
// Date normalisation
// ---------------------------------------------------------------------------

/**
 * Keep start_num/end_num in step with the date strings.
 *
 * The whole app filters on the numeric pair (see dateFilter in sources.ts), so
 * an edit that set only `end_date` would display the new date in the sheet and
 * change nothing on the map — the exact "my edit did nothing" bug this avoids.
 */
export function withDates(p: EditProps): EditProps {
  const out = { ...p };
  // Only when the edit actually touches a date. A parent-only patch must stay a
  // parent-only patch: injecting start_num/end_num would make it look like a
  // display edit (see PROMOTE below) and promote a region that never changed.
  if ("start_date" in out) out.start_num = yearNum(out.start_date, NO_START);
  if ("end_date" in out) out.end_num = yearNum(out.end_date, NO_END);
  return out;
}

/**
 * Fields whose edit is VISIBLE and so needs the promote dance (hide the
 * original, draw an amber copy). `parent` is deliberately not among them: it
 * regroups a region in the hierarchy without changing how it looks, so a
 * parent-only edit leaves the original OHM polygon on screen exactly as it was —
 * which is what makes an assigned colony read as part of its empire (like New
 * Spain) instead of turning amber or, worse, vanishing.
 */
const DISPLAY_KEYS = [
  "name",
  "admin_level",
  "start_date",
  "end_date",
  "start_num",
  "end_num",
];
export const changesDisplay = (props?: Partial<EditProps>): boolean =>
  !!props && DISPLAY_KEYS.some((k) => k in props);

/** "1815-06-18" -> 1815.46. Absent or unparseable falls back to the sentinel. */
export function yearNum(date: string | undefined, fallback: number): number {
  if (!date) return fallback;
  // Leading "-" is a BC year, so the year is parsed off the signed prefix
  // rather than by splitting on every dash.
  const m = /^(-?\d{1,6})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(date.trim());
  if (!m) return fallback;
  const y = Number(m[1]);
  if (!Number.isFinite(y)) return fallback;
  const mo = Number(m[2] ?? 1);
  const d = Number(m[3] ?? 1);
  return y + ((mo - 1) * 30.4 + (d - 1)) / 365;
}

// ---------------------------------------------------------------------------
// Selectors — what rendering reads
// ---------------------------------------------------------------------------

/**
 * Ids the dataset's own layers must stop drawing: deleted ones, and edited ones
 * that the overlay now draws instead. Both cases would otherwise show the
 * unedited original underneath the replacement.
 */
export const excludedIds = (src: string): (string | number)[] =>
  excludedIdsOf(loadEdits(), src);

/** The pure half, so the "never hide into nothing" rule can be tested. */
export function excludedIdsOf(doc: EditsDoc, src: string): (string | number)[] {
  const b = doc[src];
  if (!b) return [];
  const out: (string | number)[] = [];
  for (const [id, o] of Object.entries(b.overrides)) {
    // A property edit hides the original ONLY when there is a VISIBLE change and
    // a replacement to draw. Without the geometry snapshot the feature would be
    // excluded here and absent from the overlay — it would simply vanish. And a
    // parent-only edit changes nothing visible, so the original must keep
    // rendering rather than being swapped for an identical amber copy.
    if (!o.deleted && !(changesDisplay(o.props) && o.geometry)) continue;
    // Tile ids are numbers; a string would never match ["in", ["get","osm_id"]].
    const n = Number(id);
    out.push(Number.isFinite(n) && id.trim() !== "" ? n : id);
  }
  return out;
}

/** Ids hidden outright, for the editor's "Deleted" list. */
export function deletedIds(src: string): string[] {
  const b = loadEdits()[src];
  return Object.entries(b?.overrides ?? {})
    .filter(([, o]) => o.deleted)
    .map(([id]) => id);
}

/** The overlay: everything the user added, plus edited copies of originals. */
export function editFeatures(src: string): {
  type: "FeatureCollection";
  features: EditFeature[];
} {
  const b = loadEdits()[src];
  const features: EditFeature[] = [];
  for (const f of b?.added ?? []) features.push(f);
  for (const [id, o] of Object.entries(b?.overrides ?? {})) {
    if (o.deleted || !changesDisplay(o.props) || !o.geometry) continue;
    const n = Number(id);
    features.push({
      type: "Feature",
      geometry: o.geometry,
      properties: withDates({
        ...o.props,
        osm_id: Number.isFinite(n) && id.trim() !== "" ? n : id,
      } as EditProps),
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * child osm_id -> parent osm_id, from every edit that names one.
 *
 * This is what lets the user say "this region belongs to that empire" when the
 * geometry does not say so — OHM's European Union relation, for instance, has
 * no hole cut for Andorra, so containment alone can never get it right.
 */
export function parentOverrides(src: string): Map<string, string> {
  const b = loadEdits()[src];
  const out = new Map<string, string>();
  const put = (child: unknown, parent: unknown) => {
    if (child === undefined || parent === undefined || parent === "") return;
    out.set(String(child), String(parent));
  };
  for (const [id, o] of Object.entries(b?.overrides ?? {}))
    put(id, o.props?.parent);
  for (const f of b?.added ?? []) put(f.properties.osm_id, f.properties.parent);
  return out;
}

// ---------------------------------------------------------------------------
// Export / import — the only way edits leave this browser
// ---------------------------------------------------------------------------

export const exportEdits = (): string => JSON.stringify(loadEdits(), null, 2);

/**
 * Replace the whole document from a file. Returns how many sources came in, or
 * null when the payload is not an edits document at all — the caller reports
 * that rather than silently wiping the user's work with an empty object.
 */
export function importEdits(json: string): number | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clean = sanitise(raw);
  // An object that parses but holds no recognisable source bucket is a wrong
  // file, not an empty edit set.
  if (!Object.keys(clean).length) return null;
  loadEdits();
  doc = clean;
  commit();
  return Object.keys(clean).length;
}
