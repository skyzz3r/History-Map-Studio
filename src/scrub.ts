// The 60Hz path. Nothing here touches React state — the slider is uncontrolled and
// writes straight to deck props and one text node. That is the whole "transient
// update" requirement; it needs no store middleware to achieve.

import { bracket, formatYear, getSnapshot, peek, yearAt } from "./borders.ts";
import { setBorders } from "./map.ts";

let current = 0;
let token = 0;
let labelEl: HTMLElement | null = null;
let sliderEl: HTMLInputElement | null = null;
let yearEl: HTMLInputElement | null = null;

export const bindLabel = (el: HTMLElement | null) => (labelEl = el);
export const bindSlider = (el: HTMLInputElement | null) => (sliderEl = el);
export const bindYear = (el: HTMLInputElement | null) => (yearEl = el);
export const getIndex = () => current;

/** Move the timeline. Synchronous when both snapshots are cached. */
export function applyIndex(i: number, moveSlider = false) {
  current = i;
  const year = yearAt(i);
  if (labelEl) labelEl.textContent = formatYear(year);
  if (moveSlider && sliderEl) sliderEl.value = String(i);
  // Never while it is focused, or it would fight the user mid-keystroke.
  if (yearEl && document.activeElement !== yearEl) yearEl.value = String(year);

  const { a, b, t } = bracket(i);
  const da = peek(a);
  const db = peek(b);
  if (da && db) {
    setBorders({ index: a, data: da }, { index: b, data: db }, t);
    return;
  }

  // Cache miss: fetch, and drop the result if the user has scrubbed on since.
  const my = ++token;
  Promise.all([getSnapshot(a), getSnapshot(b)])
    .then(([na, nb]) => {
      if (my !== token) return;
      setBorders({ index: a, data: na }, { index: b, data: nb }, t);
    })
    .catch((e) => console.error("snapshot load failed", e));
}
