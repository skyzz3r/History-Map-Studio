// The 60Hz path. Nothing here touches React state — the slider is uncontrolled
// and writes straight to deck props, one MapLibre filter, and one text node.
// That is the whole "transient update" requirement; it needs no store.

import { getSnapshot, nearestIndex, peek, yearAt } from "./borders.ts";
import { setBorders, setOhmDate } from "./map.ts";
import { formatDate, toInputDate } from "./dates.ts";

let current = 0;
let token = 0;
let labelEl: HTMLElement | null = null;
let sliderEl: HTMLInputElement | null = null;
let dateEl: HTMLInputElement | null = null;

export const bindLabel = (el: HTMLElement | null) => (labelEl = el);
export const bindSlider = (el: HTMLInputElement | null) => (sliderEl = el);
export const bindDate = (el: HTMLInputElement | null) => (dateEl = el);
export const getIndex = () => current;
export const getDate = () => yearAt(current);

// ponytail: setFilter re-evaluates every loaded feature, and dragging fires
// ~60x/sec across ~96k dated boundaries. 10Hz is imperceptible while scrubbing
// and keeps the frame budget. Drop to scrub-end only if this still stutters.
let lastOhm = 0;
let lastOhmDate = NaN;
function pushOhm(dec: number, force = false) {
  const now = performance.now();
  if (!force && now - lastOhm < 100 && Math.abs(dec - lastOhmDate) < 5) return;
  lastOhm = now;
  lastOhmDate = dec;
  setOhmDate(dec);
}

/** Move the timeline. Synchronous when the snapshot is already cached. */
export function applyIndex(i: number, moveSlider = false) {
  current = i;
  const dec = yearAt(i);

  if (labelEl) labelEl.textContent = formatDate(dec);
  if (moveSlider && sliderEl) sliderEl.value = String(i);
  // Never while focused, or it fights the user mid-keystroke.
  if (dateEl && document.activeElement !== dateEl) {
    const v = toInputDate(dec);
    dateEl.value = v ?? "";
    dateEl.disabled = v === null; // <input type="date"> has no BC
  }

  pushOhm(dec);

  // One snapshot, snapped. No crossfade: two eras at partial opacity showed
  // borders that never coexisted.
  const idx = nearestIndex(i);
  const hit = peek(idx);
  if (hit) return setBorders(idx, hit);

  const my = ++token;
  getSnapshot(idx)
    .then((data) => my === token && setBorders(idx, data))
    .catch((e) => console.error("snapshot load failed", e));
}

/** Called when dragging stops, so the GPU filter lands on the exact date. */
export const settle = () => pushOhm(yearAt(current), true);
