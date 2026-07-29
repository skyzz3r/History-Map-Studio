import { useState } from "react";
import {
  removeCustomBasemap,
  saveCustomBasemap,
  savedCustomBasemaps,
  setBasemap,
  setSources,
  type CustomBasemap,
} from "../map.ts";
import {
  putCustomSource,
  removeCustomSource,
  savedCustomSources,
  savedSources,
  type CustomSource,
} from "../sources.ts";

type Draft = Omit<CustomSource, "id"> & { id?: string };

const blankSource = (): Draft => ({
  label: "",
  url: "",
  kind: "geojson",
  sourceLayer: "boundaries",
});

/**
 * Add, edit and delete the data this map draws from.
 *
 * A dialog rather than another docked panel: this is where you go once to wire
 * up a dataset, not something you keep on screen, and every edge of the window
 * already belongs to something.
 */
export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [sources, setSrcs] = useState<CustomSource[]>(savedCustomSources);
  const [maps, setMaps] = useState<CustomBasemap[]>(savedCustomBasemaps);
  const [draft, setDraft] = useState<Draft>(blankSource);
  const [bmName, setBmName] = useState("");
  const [bmUrl, setBmUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const saveSource = () => {
    const url = draft.url.trim();
    if (!url) return setNote("A source needs a URL.");
    putCustomSource({ ...draft, url, label: draft.label.trim() || "Custom source" });
    setSrcs(savedCustomSources());
    setDraft(blankSource());
    setNote("Saved. Pick it under Border source in the sidebar.");
  };

  const dropSource = (c: CustomSource) => {
    if (!confirm(`Delete the source “${c.label}”? Any edits made against it stay saved.`))
      return;
    removeCustomSource(c.id);
    setSrcs(savedCustomSources());
    // Unconditionally re-apply. savedSources() has ALREADY dropped the id — it
    // filters against the registered sources, which this delete just changed —
    // so testing whether the deleted id is still selected can never be true,
    // and the map was left drawing a dataset the panel said was gone.
    void setSources(savedSources());
    setNote("Deleted.");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="pointer-events-auto absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-neutral-950/70 p-8 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="panel flex w-full max-w-2xl flex-col gap-4 p-4 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        {note && <p className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-200">{note}</p>}

        {/* ---- Border sources ------------------------------------------- */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-neutral-500">
            Border sources
          </h3>
          <p className="text-[11px] leading-snug text-neutral-400">
            A GeoJSON file, or a vector tileset ({"{z}/{x}/{y}"} template or a
            pmtiles:// archive). Features are read for <code>name</code>,{" "}
            <code>admin_level</code> and <code>start_date</code>/
            <code>end_date</code>; anything missing gets a sensible default so the
            dataset still draws.
          </p>

          {sources.length > 0 && (
            <ul className="flex flex-col gap-1">
              {sources.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 rounded border border-neutral-800 px-2 py-1"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-neutral-100">{c.label}</span>
                    <span className="block truncate text-[11px] text-neutral-500">
                      {c.kind} · {c.url}
                    </span>
                  </span>
                  <button
                    onClick={() => setDraft({ ...c })}
                    className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => dropSource(c)}
                    className="shrink-0 rounded px-2 py-0.5 text-xs text-red-300 hover:bg-neutral-800"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-2 rounded border border-neutral-800 p-2">
            <label className="min-w-0 flex-1">
              <span className="block text-[11px] text-neutral-500">Name</span>
              <input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="My borders"
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              />
            </label>
            <label>
              <span className="block text-[11px] text-neutral-500">Kind</span>
              <select
                value={draft.kind}
                onChange={(e) =>
                  setDraft({ ...draft, kind: e.target.value as CustomSource["kind"] })
                }
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              >
                <option value="geojson">GeoJSON</option>
                <option value="vector">Vector tiles</option>
              </select>
            </label>
            {draft.kind === "vector" && (
              <label>
                <span className="block text-[11px] text-neutral-500">Layer</span>
                <input
                  value={draft.sourceLayer ?? ""}
                  onChange={(e) => setDraft({ ...draft, sourceLayer: e.target.value })}
                  placeholder="boundaries"
                  className="w-28 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
                />
              </label>
            )}
            <label className="w-full">
              <span className="block text-[11px] text-neutral-500">URL</span>
              <input
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://example.org/borders.geojson"
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-100"
              />
            </label>
            <button
              onClick={saveSource}
              className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900"
            >
              {draft.id ? "Update source" : "Add source"}
            </button>
            {draft.id && (
              <button
                onClick={() => setDraft(blankSource())}
                className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
              >
                Cancel
              </button>
            )}
          </div>
        </section>

        {/* ---- Basemaps -------------------------------------------------- */}
        <section className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
          <h3 className="text-xs uppercase tracking-wide text-neutral-500">Basemaps</h3>
          <p className="text-[11px] leading-snug text-neutral-400">
            Any MapLibre style URL — a MapTiler one with your own key pastes
            straight in. Kept in this browser, so no key is ever baked into the
            deployed site.
          </p>

          {maps.length > 0 && (
            <ul className="flex flex-col gap-1">
              {maps.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-2 rounded border border-neutral-800 px-2 py-1"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-neutral-100">{m.label}</span>
                    <span className="block truncate text-[11px] text-neutral-500">
                      {m.url}
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      setBmName(m.label);
                      setBmUrl(m.url);
                    }}
                    className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (!confirm(`Delete the basemap “${m.label}”?`)) return;
                      removeCustomBasemap(m.id);
                      setMaps(savedCustomBasemaps());
                      void setBasemap("dark");
                    }}
                    className="shrink-0 rounded px-2 py-0.5 text-xs text-red-300 hover:bg-neutral-800"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const u = bmUrl.trim();
              if (!u) return setNote("A basemap needs a style URL.");
              // Re-saving the same URL renames it rather than duplicating it,
              // which is what makes the Edit button above work.
              const entry = saveCustomBasemap(bmName.trim(), u);
              setMaps(savedCustomBasemaps());
              setBmName("");
              setBmUrl("");
              void setBasemap(entry.id);
              setNote(`Using “${entry.label}”.`);
            }}
            className="flex flex-wrap items-end gap-2 rounded border border-neutral-800 p-2"
          >
            <label className="min-w-0 flex-1">
              <span className="block text-[11px] text-neutral-500">Name</span>
              <input
                value={bmName}
                onChange={(e) => setBmName(e.target.value)}
                placeholder="MapTiler Topo"
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              />
            </label>
            <label className="w-full">
              <span className="block text-[11px] text-neutral-500">style.json URL</span>
              <input
                value={bmUrl}
                onChange={(e) => setBmUrl(e.target.value)}
                placeholder="https://api.maptiler.com/maps/…/style.json?key=…"
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-100"
              />
            </label>
            <button className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900">
              Save &amp; use
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
