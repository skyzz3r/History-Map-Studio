import { useEffect, useRef, useState } from "react";
import { gotoPolity, searchPolities, type Picked } from "../map.ts";
import { PANELS, type Dock, type PanelId } from "./Dock.tsx";
import { applyIndex, bindLabel, settle } from "../scrub.ts";
import { indexForYear } from "../borders.ts";
import { parseWhen } from "../dates.ts";
import type { Hit } from "../view.ts";
import { tierName } from "./HierarchyPanel.tsx";

export type Mode = "explore" | "studio" | "edit";

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: "explore", label: "Explore", title: "Browse the map and drill the territory hierarchy" },
  { id: "studio", label: "Studio", title: "Compose a scene and export a still or a video" },
  { id: "edit", label: "Edit", title: "Correct or draw regions — saved in this browser" },
];

/**
 * The one bar across the top: what mode you are in, when you are, and how to
 * find a place. Everything else lives at an edge of its own, so nothing on this
 * screen overlaps anything else.
 */
export default function TopBar({
  mode,
  onMode,
  onSettings,
  onPicked,
  error,
  dock,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  onSettings: () => void;
  /** A search result was chosen — open its detail card. */
  onPicked: (p: Picked) => void;
  error: string | null;
  dock: Dock;
}) {
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    bindLabel(label.current);
  }, []);

  // A row in the flow, not a floating layer: the workspace below gets whatever
  // height is left, so no panel can ever be hidden under this bar.
  return (
    <header className="z-30 flex shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-950 p-2">
      <div className="panel flex items-center gap-2 p-1 pl-3">
        <h1 className="hidden text-sm font-medium tracking-tight lg:block">
          History Map
        </h1>
        <div role="tablist" aria-label="Mode" className="flex gap-0.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              title={m.title}
              onClick={() => onMode(m.id)}
              className={`rounded-md px-3 py-1 text-sm ${
                mode === m.id
                  ? "bg-neutral-100 font-medium text-neutral-900"
                  : "text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <WindowMenu dock={dock} onMode={onMode} />

      <DateBox labelRef={label} />

      {error && (
        <span className="rounded-lg bg-red-950/90 px-3 py-1.5 text-sm text-red-200">
          {error}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Search onPicked={onPicked} />
        <button
          onClick={onSettings}
          aria-label="Settings — manage data sources and basemaps"
          title="Settings — manage data sources and basemaps"
          className="panel px-2.5 py-1.5 text-sm text-neutral-300 hover:text-neutral-100"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}

/** Panels whose visibility IS a mode — opening them has to switch the mode too,
 *  or the panel appears and clicking the map still means "tell me about this". */
const MODE_PANEL: Partial<Record<PanelId, Mode>> = { edit: "edit", studio: "studio" };

/**
 * Window: every panel, and whether it is on screen.
 *
 * A checklist rather than a set of buttons, because the question the user has
 * is "what am I looking at" and the answer is the ticks. Unticking removes the
 * tile; ticking puts it back where it belongs — its own corner of the
 * workspace, not wherever the layout engine felt like dropping it.
 */
function WindowMenu({ dock, onMode }: { dock: Dock; onMode: (m: Mode) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Show or hide panels"
        className="panel px-3 py-1.5 text-sm text-neutral-300 hover:text-neutral-100"
      >
        Window
      </button>
      {open && (
        <div role="menu" className="panel absolute left-0 top-full z-40 mt-1 w-52 p-1 text-sm">
          {PANELS.map((p) => (
            <label
              key={p.id}
              role="menuitemcheckbox"
              aria-checked={dock.isOpen(p.id)}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800"
            >
              <input
                type="checkbox"
                checked={dock.isOpen(p.id)}
                onChange={() => {
                  const m = MODE_PANEL[p.id];
                  if (m) return onMode(dock.isOpen(p.id) ? "explore" : m);
                  dock.toggle(p.id);
                }}
                className="accent-neutral-100"
              />
              <span className="text-neutral-100">{p.name}</span>
            </label>
          ))}
          <button
            onClick={() => {
              dock.reset();
              setOpen(false);
            }}
            className="mt-1 w-full rounded border-t border-neutral-800 px-2 py-1 pt-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            Reset layout
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The date setter, and the readout of where the timeline is.
 *
 * The readout is an uncontrolled text node written by scrub.ts at 60 Hz — the
 * whole point of that module is that dragging never enters React.
 */
function DateBox({ labelRef }: { labelRef: React.RefObject<HTMLSpanElement | null> }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  const go = () => {
    const dec = parseWhen(text);
    if (dec === null) return setBad(true);
    setBad(false);
    applyIndex(indexForYear(dec), true);
    settle();
    setText("");
  };

  return (
    <div className="panel pointer-events-auto flex items-center gap-2 px-3 py-1.5">
      <span
        ref={labelRef}
        aria-live="off"
        className="w-28 shrink-0 font-mono text-sm tabular-nums text-neutral-100 lg:w-32"
      >
        —
      </span>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onKeyDown={(e) => e.key === "Enter" && go()}
        onBlur={() => text && go()}
        placeholder="1815 · 44 BC"
        aria-label="Jump to a year or date"
        aria-invalid={bad}
        title="Type a year (1815), a date (1815-06-18) or a BC year (44 BC)"
        className={`w-28 rounded-md border bg-neutral-900/80 px-2 py-0.5 font-mono text-xs text-neutral-200 placeholder:text-neutral-500 ${
          bad ? "border-red-500" : "border-neutral-700"
        }`}
      />
    </div>
  );
}

/**
 * Name search over the loaded tiles.
 *
 * Debounced, because each keystroke walks every loaded feature — cheap at the
 * world view, not free at a city zoom where several hundred tiles are in memory.
 */
function Search({ onPicked }: { onPicked: (p: Picked) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) return setHits([]);
    const t = setTimeout(() => setHits(searchPolities(q)), 160);
    return () => clearTimeout(t);
  }, [q]);

  // Clicking anywhere else closes the list, including on the map.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);

  const choose = async (h: Hit) => {
    setOpen(false);
    setQ(h.name);
    const p = await gotoPolity(h.id);
    if (p) onPicked(p);
  };

  return (
    <div ref={box} className="relative">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) void choose(hits[0]);
          if (e.key === "Escape") setOpen(false);
        }}
        type="search"
        placeholder="Search territories…"
        aria-label="Search territories"
        className="panel w-36 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:w-64 lg:w-56"
      />
      {open && q.trim() !== "" && (
        <ul className="panel absolute right-0 top-full mt-1 max-h-72 w-64 overflow-y-auto p-1 text-sm">
          {hits.map((h) => (
            <li key={String(h.id)}>
              <button
                onClick={() => void choose(h)}
                className="w-full rounded px-2 py-1 text-left hover:bg-neutral-800"
              >
                <span className="block truncate text-neutral-100">{h.name}</span>
                <span className="block text-[11px] text-neutral-500">
                  {tierName(h.level)}
                </span>
              </button>
            </li>
          ))}
          {/* "Nothing matched" and "nothing is loaded to match against" are
              different problems, and only the second one has a fix the user can
              act on. */}
          {!hits.length && (
            <li className="px-2 py-1.5 text-[11px] leading-snug text-neutral-400">
              Nothing loaded matches. Search covers the territories currently on
              the map — zoom out or move the timeline to widen it.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
