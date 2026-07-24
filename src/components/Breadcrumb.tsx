import type { FocusState } from "../focus.ts";

/**
 * Drill-down trail. Only rendered once you are below the country view, so the
 * default map carries no extra chrome.
 */
export default function Breadcrumb({
  focus,
  onJump,
}: {
  focus: FocusState;
  onJump: (index: number) => void;
}) {
  if (!focus.trail.length) return null;

  return (
    <nav
      aria-label="Territory hierarchy"
      className="pointer-events-auto flex items-center gap-1 rounded-lg bg-neutral-900/85 px-2 py-1.5 text-sm backdrop-blur"
    >
      <button
        onClick={() => onJump(0)}
        className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
      >
        World
      </button>
      {focus.trail.map((l, i) => (
        <span key={`${l.osmId}-${i}`} className="flex items-center gap-1">
          <span className="text-neutral-600">›</span>
          <button
            onClick={() => onJump(i + 1)}
            className={`rounded px-1.5 py-0.5 hover:bg-neutral-800 ${
              i === focus.trail.length - 1
                ? "text-neutral-100"
                : "text-neutral-400 hover:text-neutral-100"
            }`}
          >
            {l.name}
          </button>
        </span>
      ))}
      <span className="ml-1 hidden text-xs text-neutral-600 sm:inline">
        Esc to go up · double-click to go deeper
      </span>
    </nav>
  );
}
