import { useState } from "react";
import { BASEMAPS, savedBasemap, setBasemap, setGlobe } from "../map.ts";

/**
 * Backdrop and projection. Both are one MapLibre call each, so this holds the
 * only state React needs: what is currently selected.
 */
export default function MapControls() {
  const [choice, setChoice] = useState(savedBasemap);
  const [globe, setGlobeOn] = useState(false);
  const [url, setUrl] = useState("");

  const pick = (v: string) => {
    setChoice(v);
    setBasemap(v);
  };

  const custom = !BASEMAPS.some((b) => b.id === choice);

  return (
    <div className="pointer-events-auto flex flex-col gap-2 rounded-lg bg-neutral-900/80 p-2 text-sm backdrop-blur">
      <div className="flex items-center gap-2">
        <select
          value={custom ? "custom" : choice}
          onChange={(e) => e.target.value !== "custom" && pick(e.target.value)}
          aria-label="Basemap"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200"
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
          className={`rounded-md px-2.5 py-1 ${
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
          className="w-52 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600"
        />
        <button className="rounded-md bg-neutral-800 px-2 py-1 text-xs">
          Load
        </button>
      </form>
    </div>
  );
}
