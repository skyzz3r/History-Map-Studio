import { useEffect, useRef, useState } from "react";
import { applyIndex, getIndex, onScrub, settle } from "../scrub.ts";
import { formatYear, indexForYear, niceStep, yearAt, yearRange } from "../borders.ts";

/**
 * The timeline, as a strip of the years either side of NOW rather than a slider
 * across all of history.
 *
 * The slider it replaces had one position per pixel for 123,000 years, so a
 * single pixel was decades and nudging it to 1815 was impossible. This shows a
 * window a few decades wide and you drag it past a fixed playhead, like a film
 * strip: the neighbouring years are legible and land under the cursor exactly.
 *
 * Absolute jumps are the top bar's date box — that is why it moved up there.
 *
 * Play is gone. It scrubbed the whole of history at a fixed rate, which is not
 * a thing anyone watches; Studio renders a real fly-through with keyframes.
 */
export default function Timeline({
  max,
  shrunk,
  onShrink,
}: {
  max: number;
  shrunk: boolean;
  onShrink: (v: boolean) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState(40);
  const [year, setYear] = useState(() => yearAt(getIndex()));
  const drag = useRef<{ x: number; year: number } | null>(null);

  // Time can also move from the date box, a Studio preview or a video render.
  // Without this the strip kept showing wherever it was last dragged to.
  useEffect(() => onScrub((i) => setYear(yearAt(i))), []);

  const [lo, hi] = yearRange();
  const clamp = (y: number) => Math.min(hi, Math.max(lo, y));

  const goto = (y: number) => {
    const c = clamp(y);
    setYear(c);
    applyIndex(indexForYear(c), true);
  };

  const half = span / 2;
  const step = niceStep(span);
  const ticks: number[] = [];
  for (let t = Math.ceil((year - half) / step) * step; t <= year + half; t += step)
    ticks.push(t);

  const disabled = max <= 0;

  if (shrunk)
    return (
      <div className="absolute bottom-0 left-0 z-20 flex h-10 items-center gap-3 pl-4 pr-6"
           style={{ right: "var(--rail)" }}>
        <button
          onClick={() => onShrink(false)}
          aria-expanded={false}
          aria-label="Expand the timeline"
          className="panel px-2.5 py-1 text-xs text-neutral-300 hover:text-neutral-100"
        >
          ▲ Timeline
        </button>
        <span className="font-mono text-xs tabular-nums text-neutral-400">
          {formatYear(Math.round(year))}
        </span>
      </div>
    );

  return (
    <div
      className="absolute bottom-0 left-0 z-20 bg-gradient-to-t from-neutral-950 via-neutral-950/80 to-transparent px-4 pb-3 pt-8"
      style={{ right: "var(--rail)" }}
    >
      <div className="flex items-end gap-3">
        <button
          onClick={() => onShrink(true)}
          aria-expanded
          aria-label="Shrink the timeline"
          className="panel mb-1 shrink-0 px-2.5 py-1 text-xs text-neutral-300 hover:text-neutral-100"
        >
          ▼
        </button>

        <div className="min-w-0 flex-1">
          <div
            ref={strip}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="Timeline — drag sideways to move through time"
            aria-valuemin={lo}
            aria-valuemax={hi}
            aria-valuenow={Math.round(year)}
            aria-valuetext={formatYear(Math.round(year))}
            aria-disabled={disabled}
            onKeyDown={(e) => {
              if (disabled) return;
              const k: Record<string, number> = {
                ArrowLeft: -step,
                ArrowRight: step,
                PageDown: -span / 2,
                PageUp: span / 2,
              };
              if (e.key === "Home") return goto(lo), settle();
              if (e.key === "End") return goto(hi), settle();
              const d = k[e.key];
              if (d === undefined) return;
              e.preventDefault();
              goto(year + d);
              settle();
            }}
            onPointerDown={(e) => {
              if (disabled) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, year };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || !strip.current) return;
              // Drag right, go back in time: the strip moves under a fixed
              // playhead, the way a physical reel would.
              const perPx = span / strip.current.getBoundingClientRect().width;
              goto(d.year - (e.clientX - d.x) * perPx);
            }}
            onPointerUp={(e) => {
              if (!drag.current) return;
              drag.current = null;
              e.currentTarget.releasePointerCapture(e.pointerId);
              settle();
            }}
            onWheel={(e) => {
              if (disabled) return;
              // Zoom the WINDOW, not time: this is how you get from centuries
              // to single years without a second control.
              setSpan((s) =>
                Math.min(4000, Math.max(2, s * (e.deltaY > 0 ? 1.25 : 0.8))),
              );
            }}
            className={`relative h-14 select-none overflow-hidden rounded-lg border border-neutral-700/60 bg-neutral-900/70 backdrop-blur ${
              disabled ? "opacity-40" : "cursor-ew-resize"
            }`}
          >
            {ticks.map((t) => {
              const x = ((t - (year - half)) / span) * 100;
              // Decade and century lines are taller, so the eye finds 1800
              // before it finds 1795.
              const major = Math.abs(t % (step * 5)) < 1e-6;
              return (
                <div
                  key={t}
                  className="pointer-events-none absolute top-0 flex h-full flex-col justify-end pb-1"
                  style={{ left: `${x}%`, transform: "translateX(-50%)" }}
                >
                  <span
                    className={`mx-auto w-px ${major ? "h-5 bg-neutral-500" : "h-2.5 bg-neutral-700"}`}
                  />
                  {/* Every tick is labelled. Labelling only the tall ones left
                      two numbers on a 900 px strip, which is a ruler with no
                      markings — the year under the cursor was unknowable. */}
                  <span
                    className={`mt-1 whitespace-nowrap font-mono text-[10px] ${
                      major ? "text-neutral-300" : "text-neutral-500"
                    }`}
                  >
                    {formatYear(t)}
                  </span>
                </div>
              );
            })}

            {/* The playhead. Fixed at the centre — it is the strip that moves. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-100"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-neutral-900"
            >
              {formatYear(Math.round(year))}
            </div>
          </div>
          <p className="mt-1 text-[10px] text-neutral-500">
            Drag sideways to move through time · scroll to zoom ·{" "}
            {Math.round(span)} year window
          </p>
        </div>
      </div>
    </div>
  );
}
