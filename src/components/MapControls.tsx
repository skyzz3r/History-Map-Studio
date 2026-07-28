import { useState } from "react";
import {
  BASEMAPS,
  savedBasemap,
  savedClip,
  setBasemap,
  setClip,
  setGlobe,
  setSources,
} from "../map.ts";
import { SOURCES, isOverlay, savedSources } from "../sources.ts";

/**
 * Data sources, backdrop and projection.
 *
 * ONE border dataset at a time, as a radio. These used to be checkboxes on the
 * theory that layering OHM's precision over Historical-Basemaps' reach was
 * useful — in practice the two disagree about the same borders, so wherever both
 * had coverage the map drew two contradictory sets of lines and pick order
 * silently decided which one a click landed on.
 *
 * Overlays (present day) are separate checkboxes: they stack on top of whichever
 * dataset is chosen and are cosmetic, never clickable.
 */
export default function MapControls() {
  const [choice, setChoice] = useState(savedBasemap);
  const [globe, setGlobeOn] = useState(false);
  const [url, setUrl] = useState("");
  // savedSources(), not the map's runtime list: this component mounts before
  // initMap has populated that, so reading it there left every box unchecked
  // while OHM and Historical-Basemaps were plainly rendering.
  const [on, setOn] = useState<string[]>(savedSources);
  const [clip, setClipOn] = useState(savedClip);
  const [open, setOpen] = useState(false);

  const pick = (v: string) => {
    setChoice(v);
    setBasemap(v);
  };

  const confirmRestricted = (id: string, restricted?: boolean) => {
    if (!restricted || on.includes(id)) return true;
    const s = SOURCES.find((x) => x.id === id);
    // A licence that forbids commercial use is not something to discover later,
    // so it is confirmed the first time it is switched on.
    return confirm(`${s?.label}\n\n${s?.note}\n\nEnable this source?`);
  };

  /** Pick the one border dataset, keeping whatever overlays are on. */
  const choose = (id: string, restricted?: boolean) => {
    if (!confirmRestricted(id, restricted)) return;
    const next = [id, ...on.filter(isOverlay)];
    setOn(next);
    void setSources(next);
  };

  const toggleOverlay = (id: string) => {
    const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
    setOn(next);
    void setSources(next);
  };

  const datasets = SOURCES.filter((s) => !s.overlay);
  const overlays = SOURCES.filter((s) => s.overlay);
  const current = on.find((id) => !isOverlay(id)) ?? datasets[0]?.id;

  const custom = !BASEMAPS.some((b) => b.id === choice);

  return (
    <div className="pointer-events-auto flex w-64 flex-col gap-2 rounded-lg bg-neutral-900/85 p-2 text-sm backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Border source: ${
          SOURCES.find((s) => s.id === current)?.label ?? "none"
        }. ${open ? "Collapse" : "Expand"} source options.`}
        className="flex items-center justify-between rounded-md px-1 py-0.5 text-left text-neutral-300 hover:text-neutral-100"
      >
        <span>
          Borders: {SOURCES.find((s) => s.id === current)?.label ?? "—"}
        </span>
        <span className="text-xs text-neutral-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-b border-neutral-800 pb-2">
          <ul className="flex flex-col gap-1.5">
            {datasets.map((s) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="border-source"
                    checked={current === s.id}
                    onChange={() => choose(s.id, s.restricted)}
                    className="mt-1 accent-neutral-100"
                  />
                  <span>
                    <span className="text-neutral-100">{s.label}</span>
                    {s.restricted && (
                      <span className="ml-1 rounded bg-amber-900/70 px-1 text-[10px] uppercase text-amber-200">
                        NC
                      </span>
                    )}
                    {s.note && (
                      <span className="block text-xs leading-snug text-neutral-500">
                        {s.note}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <ul className="flex flex-col gap-1.5 border-t border-neutral-800 pt-2">
            {overlays.map((s) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={on.includes(s.id)}
                    onChange={() => toggleOverlay(s.id)}
                    className="mt-1 accent-neutral-100"
                  />
                  <span>
                    <span className="text-neutral-100">{s.label}</span>
                    {s.note && (
                      <span className="block text-xs leading-snug text-neutral-500">
                        {s.note}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {/* A render option, not a dataset: clips whichever borders are shown
              to the coastline by masking the sea. */}
          <label className="flex cursor-pointer items-start gap-2 border-t border-neutral-800 pt-2">
            <input
              type="checkbox"
              checked={clip}
              onChange={() => {
                const next = !clip;
                setClipOn(next);
                setClip(next);
              }}
              className="mt-1 accent-neutral-100"
            />
            <span>
              <span className="text-neutral-100">Clip borders to coastline</span>
              <span className="block text-xs leading-snug text-neutral-500">
                Hide each territory's sea area so borders follow the coast. Keeps
                lake borders (e.g. the Great Lakes).
              </span>
            </span>
          </label>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          value={custom ? "custom" : choice}
          onChange={(e) => e.target.value !== "custom" && pick(e.target.value)}
          aria-label="Basemap"
          className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200"
        >
          {BASEMAPS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
          {custom && <option value="custom">Custom URL</option>}
        </select>

        <button
          onClick={() => {
            setGlobeOn(!globe);
            setGlobe(!globe);
          }}
          aria-pressed={globe}
          className={`shrink-0 rounded-md px-2.5 py-1 ${
            globe ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800"
          }`}
        >
          Globe
        </button>
      </div>

      {/* Any MapLibre style URL, including a MapTiler one with your own key.
          Kept out of the build so no key is baked into the deployed bundle. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) pick(url.trim());
        }}
        className="flex gap-1"
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="style.json URL (e.g. MapTiler)"
          aria-label="Custom style URL"
          className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-400"
        />
        <button className="shrink-0 rounded-md bg-neutral-800 px-2 py-1 text-xs">
          Load
        </button>
      </form>

      {/* The map's fill colours carry meaning the panels never spell out. A
          collapsed disclosure keeps the chrome minimal but stops the colour code
          being learned by trial and error. */}
      <details className="border-t border-neutral-800 pt-2 text-xs">
        <summary className="cursor-pointer select-none text-neutral-300 hover:text-neutral-100">
          Legend
        </summary>
        <ul className="mt-2 flex flex-col gap-1.5 text-neutral-300">
          {LEGEND.map((it) => (
            <li key={it.label} className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-3 w-4 shrink-0 rounded-[3px] border"
                style={{ background: it.fill, borderColor: it.border }}
              />
              <span className="leading-snug">{it.label}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Swatches for the map's fill/line colours — kept in step with sources.ts. */
const LEGEND = [
  { label: "Empire / union & its members", fill: "#a78bfa", border: "#c4b5fd" },
  { label: "Country", fill: "#e5e7eb", border: "#f8fafc" },
  { label: "Region / province", fill: "#94a3b8", border: "#cbd5e1" },
  { label: "Disputed border", fill: "#d97706", border: "#f59e0b" },
  { label: "Occupation zone (by holder)", fill: "#dc2626", border: "#0f172a" },
  { label: "Your unsaved edits", fill: "#f59e0b", border: "#fbbf24" },
  { label: "Present-day reference", fill: "transparent", border: "#22d3ee" },
] as const;
