import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  armParentPick,
  currentSourceId,
  disarmParentPick,
  download,
  drawRegion,
  saveEdit,
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
  onEditsChange,
  restore,
  type EditProps,
} from "../edits.ts";
import { SOURCES } from "../sources.ts";
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
  onClose: () => void;
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
    const patch: Partial<EditProps> = displayChanged
      ? { ...orig, ...form, parent: parentId }
      : { parent: parentId };
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
      className="pointer-events-auto flex w-80 flex-col gap-3 overflow-y-auto rounded-lg bg-neutral-900/95 p-3 text-sm backdrop-blur"
      style={{ maxHeight: "calc(100dvh - 12rem)" }}
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
        <button
          onClick={onClose}
          aria-label="Close editor"
          className="rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={async () => {
            flash("Click to place points · Enter closes · Esc cancels");
            const id = await drawRegion();
            flash(id ? "Region added — click it to fill in details" : "Cancelled");
          }}
          className="rounded-md bg-amber-500/90 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-amber-400"
        >
          + Add region
        </button>
        <button
          onClick={() => {
            download(new Blob([exportEdits()], { type: "application/json" }), "json");
            flash("Exported");
          }}
          disabled={!total}
          className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs disabled:opacity-40"
        >
          Export
        </button>
        <button
          onClick={() => file.current?.click()}
          className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs"
        >
          Import
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
          <div className="flex gap-2">
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
    <label className="min-w-0 flex-1">
      <span className="block text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}
