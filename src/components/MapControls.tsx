import { useState } from "react";
import { BASEMAPS, savedBasemap, setBasemap, setGlobe, setSources } from "../map.ts";
import { SOURCES, savedSources } from "../sources.ts";

/**
 * Data sources, backdrop and projection. Sources are checkboxes, not a radio:
 * no single open dataset covers all of history, so layering OHM's precision
 * over Historical-Basemaps' reach is the normal case.
 */
export default function MapControls() {
  const [choice, setChoice] = useState(savedBasemap);
  const [globe, setGlobeOn] = useState(false);
  const [url, setUrl] = useState("");
  // savedSources(), not the map's runtime list: this component mounts before
  // initMap has populated that, so reading it there left every box unchecked
  // while OHM and Historical-Basemaps were plainly rendering.
  const [on, setOn] = useState<string[]>(savedSources);
  const [open, setOpen] = useState(false);

  const pick = (v: string) => {
    setChoice(v);
    setBasemap(v);
  };

  const toggle = (id: string, restricted?: boolean) => {
    const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
    if (restricted && !on.includes(id)) {
      const s = SOURCES.find((x) => x.id === id);
      // A licence that forbids commercial use is not something to discover
      // later, so it is confirmed the first time it is switched on.
      if (!confirm(`${s?.label}\n\n${s?.note}\n\nEnable this source?`)) return;
    }
    setOn(next);
    void setSources(next);
  };

  const custom = !BASEMAPS.some((b) => b.id === choice);

  return (
    <div className="pointer-events-auto flex w-64 flex-col gap-2 rounded-lg bg-neutral-900/85 p-2 text-sm backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-between rounded-md px-1 py-0.5 text-left text-neutral-300 hover:text-neutral-100"
      >
        <span>Data sources ({on.length})</span>
        <span className="text-xs text-neutral-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <ul className="flex flex-col gap-1.5 border-b border-neutral-800 pb-2">
          {SOURCES.map((s) => (
            <li key={s.id}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={on.includes(s.id)}
                  onChange={() => toggle(s.id, s.restricted)}
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
          className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600"
        />
        <button className="shrink-0 rounded-md bg-neutral-800 px-2 py-1 text-xs">
          Load
        </button>
      </form>
    </div>
  );
}
