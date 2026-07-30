import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  armParentPick,
  currentSourceId,
  disarmParentPick,
  download,
  drawRegion,
  restripRegion,
  saveEdit,
  setStripOceans,
  type Picked,
} from "../map.ts";
import {
  clearSource,
  countEdits,
  deleteFeature,
  deletedIds,
  exportEdits,
  importEdits,
  loadEdits,
  META_KEYS,
  onEditsChange,
  restore,
  type EditProps,
} from "../edits.ts";
import { SOURCES } from "../sources.ts";
import { canUseFiles, openProject, saveProject } from "../store.ts";
import { readPicture } from "../annot.ts";
import { getIndex } from "../scrub.ts";
import { yearAt } from "../borders.ts";
import {
  flagFileFor,
  lookupByQid,
  normFile,
  qidForTitle,
  thumbUrls,
  wikiTitle,
} from "../wikidata.ts";
import { tierName } from "./HierarchyPanel.tsx";

/**
 * The border editor.
 *
 * Edits are a patch layer over a read-only dataset (see edits.ts), namespaced by
 * source — so the panel always says WHICH dataset it is correcting, and switching
 * datasets swaps the whole edit set rather than carrying corrections onto a
 * source that disagrees about every border.
 */
export default function EditorPanel({
  picked,
  onClose,
}: {
  /** Whatever the map last selected in edit mode. */
  picked: Picked | null;
  /** Omitted when docked: the tab's own ✕ closes it, and leaving edit mode is
   *  what the mode buttons are for. */
  onClose?: () => void;
}) {
  const src = currentSourceId();
  const label = SOURCES.find((s) => s.id === src)?.label ?? src;

  const [form, setForm] = useState<Partial<EditProps>>({});
  const [parent, setParent] = useState<{ id?: string; name?: string }>({});
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<{ msg: string; undo?: () => void } | null>(
    null,
  );
  const [, bump] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  // Any change from anywhere re-renders: an edit saved on the map, and also a
  // dataset switch, which changes WHICH edit set this panel is showing.
  useEffect(() => onEditsChange(() => bump((n) => n + 1)), []);


  // Prefill from the clicked feature MERGED with any edit already saved for it,
  // so re-opening a region shows what you last typed, not the original.
  useEffect(() => {
    disarmParentPick();
    setPicking(false);
    if (!picked) return setForm({});
    const saved = loadEdits()[src]?.overrides[String(picked.osmId)]?.props;
    const added = loadEdits()[src]?.added.find(
      (f) => String(f.properties.osm_id) === String(picked.osmId),
    )?.properties;
    const base: Partial<EditProps> = {
      name: picked.name,
      admin_level: picked.adminLevel,
      start_date: picked.startDate,
      end_date: picked.endDate,
    };
    const merged = { ...base, ...added, ...saved };
    setForm(merged);
    setParent({ id: merged.parent === undefined ? undefined : String(merged.parent) });
  }, [picked, src]);

  // A plain note self-clears fast; a note with an Undo lingers so the recovery
  // is actually reachable before it disappears.
  const flash = (msg: string, undo?: () => void) => {
    setNote({ msg, undo });
    setTimeout(() => setNote(null), undo ? 6000 : 2500);
  };

  const set = (k: keyof EditProps, v: unknown) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    if (!picked) return;
    // Whether any VISIBLE field changed decides everything. If one did, send the
    // full display snapshot so the amber overlay copy renders complete (name AND
    // both dates AND level), not just the one field that changed. If none did, a
    // parent pick reaches the store as a parent-only patch — so the region stays
    // its native self on the map (part of its empire) instead of turning amber.
    const orig: Partial<EditProps> = {
      name: picked.name,
      admin_level: picked.adminLevel,
      start_date: picked.startDate,
      end_date: picked.endDate,
    };
    const keys = ["name", "admin_level", "start_date", "end_date"] as const;
    const displayChanged = keys.some(
      (k) => form[k] !== undefined && form[k] !== orig[k],
    );
    const parentId =
      parent.id === undefined || parent.id === "" ? undefined : parent.id;
    // The metadata fields ride along either way. They are not DISPLAY_KEYS, so
    // they never promote the region into the amber overlay — a corrected leader
    // must not repaint a border.
    const meta: Partial<EditProps> = {};
    for (const k of META_KEYS) if (form[k] !== undefined) meta[k] = form[k];
    const patch: Partial<EditProps> = displayChanged
      ? { ...orig, ...form, parent: parentId, ...meta }
      : { parent: parentId, ...meta };
    const ok = saveEdit(picked.osmId, patch);
    // Geometry is snapshotted from the loaded tiles, so an edit made with the
    // region off screen has nothing to redraw. Say so instead of appearing to
    // save and changing nothing.
    flash(ok ? "Saved" : "Saved, but zoom to the region and save again to apply");
  };

  const deleted = deletedIds(src);
  const total = countEdits(src);

  return (
    <section
      aria-label="Border editor"
      // max-h-full, like the other two mode panels. Without it the Facts
      // section made this taller than the window and it ran under the timeline.
      className="panel pointer-events-auto flex max-h-full w-80 flex-col gap-3 overflow-y-auto p-3 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-xs uppercase tracking-wide text-neutral-500">
            Editor
          </h2>
          {/* Which dataset is being corrected is not a detail: the same click
              means a different thing on each one. */}
          <p className="text-neutral-200">{label}</p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close editor"
            className="rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            ✕
          </button>
        )}
      </div>

      <NewRegion flash={flash} />

      <div className="flex flex-wrap gap-1.5">
        {/* Save writes back to the file the user chose, in place, with no
            second dialog and no trip through the Downloads folder — that is the
            whole difference between a web page and a document editor. Browsers
            without the picker (Firefox, Safari) fall through to the download
            that has always worked. */}
        <button
          onClick={async () => {
            if (!canUseFiles()) {
              download(new Blob([exportEdits()], { type: "application/json" }), "json");
              return flash("Exported");
            }
            try {
              const name = await saveProject(exportEdits(), "history-map-edits.json");
              if (name) flash(`Saved to ${name}`);
            } catch (e) {
              console.error(e);
              flash("Could not save — nothing was written");
            }
          }}
          disabled={!total}
          className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs disabled:opacity-40"
        >
          {canUseFiles() ? "Save" : "Export"}
        </button>
        <button
          onClick={async () => {
            if (!canUseFiles()) return file.current?.click();
            try {
              const text = await openProject();
              if (text === null) return;
              const n = importEdits(text);
              flash(n === null ? "Not an edits file" : `Opened ${n} source(s)`);
            } catch (e) {
              console.error(e);
              flash("Could not open that file");
            }
          }}
          className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs"
        >
          {canUseFiles() ? "Open" : "Import"}
        </button>
        <button
          onClick={() => {
            if (!total) return;
            if (confirm(`Discard all ${total} edit(s) to ${label}?`))
              clearSource(src);
          }}
          disabled={!total}
          className="rounded-md px-2.5 py-1 text-xs text-red-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          Clear
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // so re-picking the same file fires again
            if (!f) return;
            const n = importEdits(await f.text());
            flash(n === null ? "Not an edits file" : `Imported ${n} source(s)`);
          }}
        />
      </div>

      {note && (
        <p className="flex items-center gap-2 text-xs text-amber-300">
          <span className="min-w-0 flex-1">{note.msg}</span>
          {note.undo && (
            <button
              onClick={() => {
                note.undo!();
                setNote(null);
              }}
              className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 font-medium text-amber-200 hover:bg-amber-500/30"
            >
              Undo
            </button>
          )}
        </p>
      )}

      {!picked ? (
        <p className="text-xs leading-snug text-neutral-500">
          Click a region on the map to edit its dates, level or parent. Use the
          timeline to pick the moment you are correcting.
        </p>
      ) : (
        <div className="flex flex-col gap-2 border-t border-neutral-800 pt-2">
          <Field label="Name">
            <input
              value={String(form.name ?? "")}
              onChange={(e) => set("name", e.target.value)}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            />
          </Field>

          {/* Dates drive the whole timeline filter, so they are the edit that
              most often matters — a country that outlived its record, or one
              that should already be gone. */}
          {/* flex-wrap: a pair of fields that will not fit side by side stacks
          instead of squeezing both into something unreadable. */}
      <div className="flex flex-wrap gap-2">
            <Field label="Start">
              <input
                type="date"
                value={dateValue(form.start_date)}
                onChange={(e) => set("start_date", e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              />
            </Field>
            <Field label="End">
              <input
                type="date"
                value={dateValue(form.end_date)}
                onChange={(e) => set("end_date", e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              />
            </Field>
          </div>

          <Field label="Level">
            <select
              value={String(form.admin_level ?? 2)}
              onChange={(e) => set("admin_level", Number(e.target.value))}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((l) => (
                <option key={l} value={l}>
                  {l} · {tierName(l)}
                </option>
              ))}
            </select>
          </Field>

          {/* The explicit parent beats geometry, which is the point: OHM's EU
              relation has no hole for Andorra, so no containment test can ever
              work out that it is not a member. */}
          <Field label="Belongs to">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-neutral-300">
                {parent.name ?? parent.id ?? "— none —"}
              </span>
              <button
                onClick={() => {
                  if (picking) {
                    disarmParentPick();
                    return setPicking(false);
                  }
                  setPicking(true);
                  flash("Click the region it belongs to");
                  armParentPick((p) => {
                    setParent({ id: String(p.osmId), name: p.name });
                    setPicking(false);
                    flash(`Parent: ${p.name}`);
                  });
                }}
                className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                  picking ? "bg-amber-500 text-neutral-900" : "bg-neutral-800"
                }`}
              >
                {picking ? "Click map…" : "Pick"}
              </button>
              {parent.id !== undefined && (
                <button
                  onClick={() => setParent({})}
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800"
                >
                  ✕
                </button>
              )}
            </div>
          </Field>

          <Facts form={form} set={set} flash={flash} />

          <div className="mt-1 flex gap-1.5">
            <button
              onClick={save}
              className="flex-1 rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-900"
            >
              Save
            </button>
            <button
              onClick={() => {
                restore(src, picked.osmId);
                flash("Reverted");
              }}
              className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs"
            >
              Revert
            </button>
            <button
              onClick={() => {
                const id = picked.osmId;
                deleteFeature(src, id);
                flash("Deleted", () => restore(src, id));
              }}
              className="rounded-md px-2.5 py-1 text-xs text-red-300 hover:bg-neutral-800"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {deleted.length > 0 && (
        <div className="border-t border-neutral-800 pt-2">
          <p className="text-[11px] uppercase tracking-wide text-neutral-500">
            Deleted ({deleted.length})
          </p>
          <ul className="mt-1 max-h-32 overflow-y-auto">
            {deleted.map((id) => (
              <li key={id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">
                  {id}
                </span>
                <button
                  onClick={() => restore(src, id)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] leading-snug text-neutral-400">
        {total} edit(s) to {label} · saved in this browser. Export to keep or
        move them.
      </p>
    </section>
  );
}

/**
 * The facts a region carries that are not its shape or its dates.
 *
 * Wikidata gets these wrong more often than it gets the borders wrong, because
 * a Q-id usually describes the modern successor state: ask it who led "France"
 * in 1812 and the answer depends entirely on which of several French entities
 * the tile happens to point at. Pasting the right article and pressing Fill in
 * resolves that once, and anything still wrong is then typed over.
 */
function Facts({
  form,
  set,
  flash,
}: {
  form: Partial<EditProps>;
  set: (k: keyof EditProps, v: unknown) => void;
  flash: (msg: string, undo?: () => void) => void;
}) {
  const [busy, setBusy] = useState(false);
  const flagFile = useRef<HTMLInputElement>(null);
  const armsFile = useRef<HTMLInputElement>(null);

  const str = (k: keyof EditProps) => String(form[k] ?? "");

  /**
   * Resolve the pasted article to a Q-id and fill everything it knows.
   *
   * The flag is deliberately re-resolved to a CORS-open Commons thumbnail
   * rather than kept as the Special:FilePath URL the card uses: that URL is a
   * 302 with no access-control header, so it can be an <img> but can never be
   * fetched into a map icon — and the map icon is the visible half of "set the
   * flag picture".
   */
  const fill = async () => {
    const title = wikiTitle(str("wikipedia"));
    if (!title) return flash("Paste a Wikipedia page or URL first");
    setBusy(true);
    try {
      const qid = await qidForTitle(title);
      if (!qid) return flash(`No Wikidata item for “${title}”`);
      const year = yearAt(getIndex());
      const info = await lookupByQid(qid, year, str("name"), title);
      if (!str("name") && info.name) set("name", info.name);
      if (info.leader) set("leader", info.leader);
      if (info.population) set("population", info.population);
      if (info.arms) set("arms", info.arms);
      const file = await flagFileFor(qid, year);
      const url = file ? (await thumbUrls([normFile(file)], 256)).get(normFile(file)) : undefined;
      if (url ?? info.flag) set("flag", url ?? info.flag);
      flash(`Filled from ${title} — review, then Save`);
    } catch (e) {
      console.error(e);
      flash("Could not reach Wikipedia — check the connection");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (
    input: HTMLInputElement | null,
    key: "flag" | "arms",
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // so re-picking the same file fires again
    if (!f) return;
    try {
      // Downscaled to a data URL: these live in localStorage beside the edit,
      // and a 4 MB phone photo would blow the quota with one region.
      set(key, await readPicture(f, 256));
      flash("Picture set — Save to keep it");
    } catch {
      flash("That file could not be read as an image");
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-800 pt-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        Facts
      </span>

      <Field label="Wikipedia page">
        <div className="flex items-center gap-1">
          <input
            value={str("wikipedia")}
            onChange={(e) => set("wikipedia", e.target.value)}
            placeholder="Kingdom of Bavaria"
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
          />
          <button
            onClick={() => void fill()}
            disabled={busy || !str("wikipedia").trim()}
            title="Look the page up on Wikidata and fill in leader, population, flag and arms"
            className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs disabled:opacity-40"
          >
            {busy ? "…" : "Fill in"}
          </button>
        </div>
      </Field>

      {/* flex-wrap: a pair of fields that will not fit side by side stacks
          instead of squeezing both into something unreadable. */}
      <div className="flex flex-wrap gap-2">
        <Field label="Leader">
          <input
            value={str("leader")}
            onChange={(e) => set("leader", e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
          />
        </Field>
        <Field label="Population">
          <input
            value={str("population")}
            onChange={(e) => set("population", e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
          />
        </Field>
      </div>

      <div className="flex gap-3">
        {(["flag", "arms"] as const).map((k) => (
          <div key={k} className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">
              {k === "flag" ? "Flag" : "Coat of arms"}
            </span>
            {str(k) ? (
              <img
                src={str(k)}
                alt=""
                className="h-10 self-start rounded border border-neutral-700 object-contain"
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
            ) : (
              <span className="text-[11px] text-neutral-500">— none —</span>
            )}
            <div className="flex gap-1">
              <button
                onClick={() => (k === "flag" ? flagFile : armsFile).current?.click()}
                className="rounded bg-neutral-800 px-2 py-0.5 text-xs"
              >
                {str(k) ? "Change" : "Set"}
              </button>
              {str(k) && (
                <button
                  onClick={() => set(k, "")}
                  className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800"
                >
                  Clear
                </button>
              )}
            </div>
            <input
              ref={k === "flag" ? flagFile : armsFile}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void pick(null, k, e)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Drawing a new region, with the hierarchy decided BEFORE the first click.
 *
 * The order is the point. Which regions get carved out of a new border depends
 * on its level and its parent (see strip.ts), so both have to be settled before
 * the shape exists — asking afterwards would mean re-deriving the subtraction
 * against a shape that has already been saved.
 */
function NewRegion({
  flash,
}: {
  flash: (msg: string, undo?: () => void) => void;
}) {
  const [level, setLevel] = useState(2);
  const [parent, setParent] = useState<{ id?: string; name?: string }>({});
  const [strip, setStrip] = useState(true);
  const [oceans, setOceans] = useState(true);
  const [picking, setPicking] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  useEffect(() => () => disarmParentPick(), []);

  // The sea tiles are only fetched while this is armed — a source with no layer
  // pointing at it loads nothing, and the strip would then find no sea to cut.
  useEffect(() => {
    setStripOceans(strip && oceans);
    return () => setStripOceans(false);
  }, [strip, oceans]);

  const draw = async () => {
    disarmParentPick();
    setPicking(false);
    flash("Click to place points · Enter closes · Esc cancels");
    const r = await drawRegion({ level, parent: parent.id, strip, oceans });
    if (!r) return flash("Cancelled");
    if (r.id === null)
      return flash(
        `Nothing left after stripping ${r.stripped} region(s) — every part of that shape is already claimed.`,
      );
    setLast(r.id);
    flash(
      strip
        ? `Added, carved out of ${r.stripped} existing region(s) — click it to fill in details`
        : "Region added — click it to fill in details",
    );
  };

  return (
    <div className="flex flex-col gap-1.5 rounded border border-neutral-800 p-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        New region
      </span>

      {/* flex-wrap: a pair of fields that will not fit side by side stacks
          instead of squeezing both into something unreadable. */}
      <div className="flex flex-wrap gap-2">
        <Field label="Level">
          <select
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((l) => (
              <option key={l} value={l}>
                {l} · {tierName(l)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Inside">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-neutral-300">
              {parent.name ?? "— none —"}
            </span>
            <button
              onClick={() => {
                if (picking) {
                  disarmParentPick();
                  return setPicking(false);
                }
                setPicking(true);
                flash("Click the region it sits inside");
                armParentPick((p) => {
                  setParent({ id: String(p.osmId), name: p.name });
                  setPicking(false);
                  flash(`Inside: ${p.name}`);
                });
              }}
              className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                picking ? "bg-amber-500 text-neutral-900" : "bg-neutral-800"
              }`}
            >
              {picking ? "Click map…" : "Pick"}
            </button>
            {parent.id !== undefined && (
              <button
                onClick={() => setParent({})}
                aria-label="Clear parent"
                className="shrink-0 rounded px-1 text-xs text-neutral-400 hover:bg-neutral-800"
              >
                ✕
              </button>
            )}
          </div>
        </Field>
      </div>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={strip}
          onChange={() => setStrip((s) => !s)}
          className="mt-1 accent-neutral-100"
        />
        <span>
          <span className="text-neutral-100">Strip existing states</span>
          <span className="block text-[11px] leading-snug text-neutral-500">
            Enclose the whole area and let the overlap be cut away. Removes{" "}
            {tierName(level).toLowerCase()}-level territory and anything above it
            except {parent.name ?? "the parent"} — subdivisions inside are kept.
          </span>
        </span>
      </label>

      {strip && (
        <label className="ml-5 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={oceans}
            onChange={() => setOceans((o) => !o)}
            className="mt-1 accent-neutral-100"
          />
          <span>
            <span className="text-neutral-100">…and the sea</span>
            <span className="block text-[11px] leading-snug text-neutral-500">
              Cut the ocean out too, so a coastal region stops at the coastline
              instead of running out to the box you drew. Lakes are kept.
            </span>
          </span>
        </label>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={() => void draw()}
          className="flex-1 rounded-md bg-amber-500/90 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-amber-400"
        >
          + Draw region
        </button>
        {/* Stripping only subtracts what the tiles currently hold, so a region
            drawn while zoomed out can be re-cut once its neighbours load. */}
        {last && (
          <button
            onClick={async () => {
              const n = await restripRegion(last, level, parent.id, oceans);
              flash(
                n === null
                  ? "Nothing left to keep — the strip was not applied."
                  : `Re-stripped against ${n} region(s).`,
              );
            }}
            className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs"
          >
            Re-strip
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * <input type="date"> only accepts YYYY-MM-DD. OHM dates are often just a year
 * ("1815") or a BC year ("-0218"), which the input rejects silently — leaving
 * the field blank and, on save, wiping a date the user never touched.
 */
function dateValue(v: unknown): string {
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(s);
  return m ? `${m[1]}-${m[2] ?? "01"}-01` : "";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    // basis-32 is what makes `flex-wrap` on the rows above actually wrap. With
    // the default `flex-1` (basis 0) two fields never exceed the row, so they
    // squeeze to 37 px each instead — narrow enough that the Pick button alone
    // overflowed. Below 8rem apiece they stack.
    <label className="min-w-0 flex-1 basis-32">
      <span className="block text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}
