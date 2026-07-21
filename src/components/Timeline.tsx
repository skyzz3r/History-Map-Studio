import { useEffect, useRef, useState } from "react";
import { applyIndex, bindLabel, bindSlider, getIndex } from "../scrub.ts";
import { getSnapshots } from "../borders.ts";

/**
 * Uncontrolled on purpose. onInput fires ~60x/sec while dragging and must not
 * enter React at all — it writes to deck props and one text node directly.
 * The only state here is the play/pause icon.
 */
export default function Timeline({ max }: { max: number }) {
  const label = useRef<HTMLSpanElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    bindLabel(label.current);
    bindSlider(slider.current);
  }, []);

  useEffect(() => {
    if (!playing || max <= 0) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const i = getIndex() + ((now - last) / 1000) * 0.6; // snapshots per second
      last = now;
      if (i >= max) {
        applyIndex(max, true);
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
        className="w-32 shrink-0 font-mono text-lg tabular-nums text-neutral-100"
      >
        —
      </span>

      <input
        ref={slider}
        type="range"
        min={0}
        max={Math.max(max, 0)}
        step={0.01}
        defaultValue={0}
        list="eras"
        disabled={max <= 0}
        onInput={(e) => {
          setPlaying(false);
          applyIndex(+e.currentTarget.value);
        }}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-neutral-700 accent-neutral-100 disabled:opacity-30"
      />
      {/* Free era ticks: the browser renders one notch per snapshot. */}
      <datalist id="eras">
        {getSnapshots().map((_, i) => (
          <option key={i} value={i} />
        ))}
      </datalist>
    </div>
  );
}
