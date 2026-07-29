import { useState } from "react";

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

/**
 * The colour code, in its own corner.
 *
 * It used to be a disclosure buried at the bottom of the source picker, which
 * is not where anyone looks when they are wondering why Portugal is violet.
 * Bottom right, offset past the sidebar and the timeline so it overlaps
 * neither.
 */
export default function Legend() {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="pointer-events-auto absolute z-10"
      style={{
        right: "calc(var(--rail) + 0.75rem)",
        // Clears the timeline AND the attribution strip MapLibre parks just
        // above it — 1.5rem left the two overlapping at 720p.
        bottom: "calc(var(--tl) + 2.75rem)",
      }}
    >
      <div className="panel p-2 text-xs">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-neutral-300 hover:text-neutral-100"
        >
          <span className="flex gap-0.5" aria-hidden>
            {LEGEND.slice(0, 3).map((it) => (
              <span
                key={it.label}
                className="h-3 w-2 rounded-[2px] border"
                style={{ background: it.fill, borderColor: it.border }}
              />
            ))}
          </span>
          <span>Legend</span>
          <span className="ml-auto text-neutral-500">{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <ul className="mt-2 flex w-56 flex-col gap-1.5 text-neutral-300">
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
        )}
      </div>
    </div>
  );
}
