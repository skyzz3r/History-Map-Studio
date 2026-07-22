import { useEffect, useRef, useState } from "react";
import {
  applyIndex,
  bindDate,
  bindLabel,
  bindSlider,
  getIndex,
  settle,
} from "../scrub.ts";
import { getSnapshots, indexForYear } from "../borders.ts";
import { toDecimalYear } from "../dates.ts";

/**
 * Uncontrolled on purpose. onInput fires ~60x/sec while dragging and must not
 * enter React at all. The only state here is the play/pause icon.
 */
export default function Timeline({ max }: { max: number }) {
  const label = useRef<HTMLSpanElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const date = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState(false);

  const snaps = getSnapshots();

  useEffect(() => {
    bindLabel(label.current);
    bindSlider(slider.current);
    bindDate(date.current);
  }, []);

  useEffect(() => {
    if (!playing || max <= 0) return;
    let raf = 0;
    let prev = performance.now();
    const step = (now: number) => {
      const i = getIndex() + ((now - prev) / 1000) * 0.6; // snapshots per second
      prev = now;
      if (i >= max) {
        applyIndex(max, true);
        settle();
        return setPlaying(false);
      }
      applyIndex(i, true);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, max]);

  return (
    <div className="absolute inset-x-0 bottom-0 flex items-center gap-4 bg-gradient-to-t from-neutral-950 to-transparent px-6 pb-5 pt-12">
      <button
        onClick={() => setPlaying((p) => !p)}
        disabled={max <= 0}
        className="shrink-0 rounded-full bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-30"
      >
        {playing ? "Pause" : "Play"}
      </button>

      <span
        ref={label}
        className="w-40 shrink-0 font-mono text-lg tabular-nums text-neutral-100"
      >
        —
      </span>

      {/* Day-level jump. Disabled automatically for BC dates — the native date
          element has no year 0 or earlier; the slider still reaches them. */}
      <input
        ref={date}
        type="date"
        disabled={max <= 0}
        aria-label="Jump to date"
        onInput={(e) => {
          const dec = toDecimalYear(e.currentTarget.value);
          if (dec === null) return;
          setPlaying(false);
          applyIndex(indexForYear(dec), true);
          settle();
        }}
        className="shrink-0 rounded-md border border-neutral-700 bg-neutral-900/80 px-2 py-1 font-mono text-sm text-neutral-200 disabled:opacity-30 [color-scheme:dark]"
      />

      <input
        ref={slider}
        type="range"
        min={0}
        max={Math.max(max, 0)}
        step={0.0001}
        defaultValue={0}
        list="eras"
        disabled={max <= 0}
        aria-label="Timeline"
        onInput={(e) => {
          setPlaying(false);
          applyIndex(+e.currentTarget.value);
        }}
        onPointerUp={settle}
        onKeyUp={settle}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-neutral-700 accent-neutral-100 disabled:opacity-30"
      />
      {/* Free era ticks: the browser renders one notch per snapshot. */}
      <datalist id="eras">
        {snaps.map((_, i) => (
          <option key={i} value={i} />
        ))}
      </datalist>
    </div>
  );
}
