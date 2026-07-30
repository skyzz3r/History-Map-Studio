// Studio annotations: free text, character cards, region cards.
//
// These are drawn INTO the WebGL canvas as symbol icons, not as DOM overlays,
// and that is the whole design constraint. Both exports read the canvas —
// `canvas.toBlob` for the PNG and `new VideoFrame(canvas)` for the MP4 — so a
// caption placed with a maplibregl.Marker would look perfect on screen and be
// missing from every file the user actually keeps.
//
// Each annotation is composited on a 2D canvas and registered with
// `map.addImage`, so font, size, colour and opacity are ordinary canvas calls
// against whatever fonts the machine has. Going through a MapLibre `text-field`
// instead would have limited the choice to the three Noto weights the Protomaps
// glyph server happens to host.

import { load, set } from "./store.ts";

export type AnnotLayer = "photo" | "video";
export type AnnotKind = "text" | "character" | "region";

export type Annot = {
  id: string;
  layer: AnnotLayer;
  kind: AnnotKind;
  /** [lng, lat] — where it is pinned on the map. */
  at: [number, number];
  text: string;
  /** Second line: a character's title, a region's dates. */
  sub?: string;
  /** Data URL, downscaled on import. Character cards only. */
  image?: string;
  font: string;
  size: number;
  color: string;
  /** 0..1 */
  opacity: number;
};

export const FONTS = [
  { label: "Sans", css: "system-ui, sans-serif" },
  { label: "Serif", css: "Georgia, 'Times New Roman', serif" },
  { label: "Mono", css: "'Courier New', monospace" },
  { label: "Display", css: "Impact, 'Arial Black', sans-serif" },
];

export const newAnnot = (
  layer: AnnotLayer,
  kind: AnnotKind,
  at: [number, number],
  n: number,
): Annot => ({
  id: `an-${n}`,
  layer,
  kind,
  at,
  text: kind === "character" ? "Name" : kind === "region" ? "Region" : "Label",
  sub: kind === "text" ? undefined : "",
  font: FONTS[0].css,
  size: kind === "text" ? 28 : 20,
  color: "#f8fafc",
  opacity: 1,
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const STORE = "annots:v1";
let list: Annot[] | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

/**
 * Read the saved annotations into memory. Awaited once at boot.
 *
 * Pictures are stored as data URLs, so this list is the first thing in the app
 * to reach the origin's storage quota — which is why it lives in IndexedDB now.
 * See store.ts.
 */
export async function hydrateAnnots(): Promise<Annot[]> {
  const v = await load(STORE, (raw) => (Array.isArray(raw) ? raw.filter(isAnnot) : []));
  list = v ?? [];
  hydrated = true;
  return list;
}

/** The in-memory list. Empty until hydrateAnnots() has resolved. */
export function loadAnnots(): Annot[] {
  return (list ??= []);
}

const isAnnot = (a: any): a is Annot =>
  !!a && typeof a.id === "string" && Array.isArray(a.at) && a.at.length === 2;

export function onAnnotsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit() {
  // Never write before the read: a commit in that gap would persist an empty
  // list over everything the user already had.
  if (hydrated)
    set(STORE, list ?? []).catch((e) => {
    // The in-memory list stays authoritative so the user still sees their work.
    console.warn("could not persist annotations", e);
  });
  for (const fn of listeners) fn();
}

export function addAnnot(layer: AnnotLayer, kind: AnnotKind, at: [number, number]): Annot {
  const all = loadAnnots();
  const n = all.reduce((m, a) => Math.max(m, Number(a.id.slice(3)) || 0), 0) + 1;
  const a = newAnnot(layer, kind, at, n);
  all.push(a);
  commit();
  return a;
}

export function updateAnnot(id: string, patch: Partial<Annot>) {
  const a = loadAnnots().find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  commit();
}

export function removeAnnot(id: string) {
  list = loadAnnots().filter((a) => a.id !== id);
  commit();
}

export const annotsFor = (layer: AnnotLayer) =>
  loadAnnots().filter((a) => a.layer === layer);

// ---------------------------------------------------------------------------
// Layer visibility and exchange
// ---------------------------------------------------------------------------

const HIDE_STORE = "annots:hidden:v1";
let hidden: AnnotLayer[] | null = null;

export function hiddenLayers(): AnnotLayer[] {
  if (hidden) return hidden;
  try {
    const v = JSON.parse(localStorage.getItem(HIDE_STORE) ?? "[]");
    hidden = Array.isArray(v) ? v.filter((x) => x === "photo" || x === "video") : [];
  } catch {
    hidden = [];
  }
  return hidden;
}

export const isHidden = (l: AnnotLayer) => hiddenLayers().includes(l);

export function setLayerHidden(layer: AnnotLayer, hide: boolean) {
  const now = hiddenLayers().filter((l) => l !== layer);
  hidden = hide ? [...now, layer] : now;
  try {
    localStorage.setItem(HIDE_STORE, JSON.stringify(hidden));
  } catch {
    /* visibility is not worth failing over */
  }
  for (const fn of listeners) fn();
}

/** The layers whose annotations actually draw. */
export const visibleLayers = (): AnnotLayer[] =>
  (["photo", "video"] as const).filter((l) => !isHidden(l));

/**
 * Exchange the two layers' contents.
 *
 * Its own operation rather than a per-annotation move, because the case that
 * comes up is "I built this whole thing on the wrong layer". Being its own
 * inverse is what makes it safe to offer on a press-and-hold: doing it twice
 * puts everything back.
 */
export function swapLayers() {
  for (const a of loadAnnots()) a.layer = a.layer === "photo" ? "video" : "photo";
  commit();
}

/** The GeoJSON the symbol layer reads. Pure, so it can be asserted in node. */
export function annotFeatures(all: Annot[], layers: AnnotLayer[]) {
  return {
    type: "FeatureCollection" as const,
    features: all
      .filter((a) => layers.includes(a.layer))
      .map((a) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: a.at },
        properties: { id: a.id },
      })),
  };
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

/** Greedy wrap by width in characters. Pure, so the card height maths is
 *  testable without a canvas. */
export function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars || !line) line = next;
    else {
      out.push(line);
      line = w;
    }
  }
  out.push(line);
  return out;
}

/** Everything is composited at 2x and registered with pixelRatio 2, so cards
 *  stay sharp on a retina screen and in a 1080p export.
 *  ponytail: a 4K export raises the map's pixel ratio past this, so a card is
 *  upscaled there. Re-compositing per export is the fix if it ever shows. */
const DPR = 2;

/**
 * Draw one annotation to an offscreen canvas.
 *
 * Returns null when there is nothing to draw, which keeps a half-typed card
 * from registering a zero-width image — MapLibre throws on those rather than
 * ignoring them.
 */
export function cardCanvas(a: Annot): HTMLCanvasElement | null {
  const img = a.kind === "character" ? loadedImage(a.image) : null;
  const pad = 12;
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  if (!g) return null;

  const titleFont = `600 ${a.size}px ${a.font}`;
  const subSize = Math.max(10, Math.round(a.size * 0.62));
  const subFont = `400 ${subSize}px ${a.font}`;

  // Measure first on a throwaway context state, then size the canvas — resizing
  // a canvas resets it, so measuring after would lose every setting.
  g.font = titleFont;
  const lines = wrapLines(a.text || "", 22);
  const titleW = Math.max(...lines.map((l) => g.measureText(l).width), 1);
  g.font = subFont;
  const subLines = a.sub ? wrapLines(a.sub, 30) : [];
  const subW = subLines.length
    ? Math.max(...subLines.map((l) => g.measureText(l).width))
    : 0;

  const imgH = img ? 92 : 0;
  const textW = Math.max(titleW, subW);
  const w = Math.ceil(Math.max(textW, img ? 92 : 0) + pad * 2);
  const lineH = Math.round(a.size * 1.2);
  const subLineH = Math.round(subSize * 1.3);
  const h = Math.ceil(
    imgH +
      (img ? 8 : 0) +
      lines.length * lineH +
      subLines.length * subLineH +
      pad * 2,
  );
  if (w < 4 || h < 4) return null;

  c.width = w * DPR;
  c.height = h * DPR;
  g.scale(DPR, DPR);
  g.globalAlpha = Math.max(0, Math.min(1, a.opacity));

  // Plain text gets no chrome at all — a caption over the map, not a widget.
  if (a.kind !== "text") {
    g.fillStyle = "rgba(10,10,10,0.78)";
    roundRect(g, 0.5, 0.5, w - 1, h - 1, 10);
    g.fill();
    g.strokeStyle = "rgba(245,245,245,0.35)";
    g.lineWidth = 1;
    g.stroke();
  }

  let y = pad;
  if (img) {
    const side = Math.min(92, w - pad * 2);
    g.save();
    roundRect(g, (w - side) / 2, y, side, imgH, 8);
    g.clip();
    // Cover-fit, so a portrait photo is not squashed into the square.
    const scale = Math.max(side / img.width, imgH / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    g.drawImage(img, (w - dw) / 2, y + (imgH - dh) / 2, dw, dh);
    g.restore();
    y += imgH + 8;
  }

  g.fillStyle = a.color;
  g.font = titleFont;
  g.textBaseline = "top";
  g.textAlign = "center";
  if (a.kind === "text") {
    // A caption sits over arbitrary map colour, so it carries its own halo.
    g.strokeStyle = "rgba(10,10,10,0.85)";
    g.lineWidth = Math.max(2, a.size / 8);
    g.lineJoin = "round";
  }
  for (const l of lines) {
    if (a.kind === "text") g.strokeText(l, w / 2, y);
    g.fillText(l, w / 2, y);
    y += lineH;
  }
  if (subLines.length) {
    g.font = subFont;
    g.fillStyle = "#a3a3a3";
    for (const l of subLines) {
      g.fillText(l, w / 2, y);
      y += subLineH;
    }
  }
  return c;
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Decoded pictures, kept hot.
 *
 * cardCanvas has to be synchronous — it runs inside the map's re-register pass
 * — so an image that has not decoded yet is skipped and the card is rebuilt
 * once `primeImages` reports the decode is done.
 */
const images = new Map<string, HTMLImageElement>();

const loadedImage = (src?: string) => {
  if (!src) return null;
  const img = images.get(src);
  return img?.complete && img.naturalWidth ? img : null;
};

/** Decode every picture referenced by `all`; resolves when they are usable. */
export async function primeImages(all: Annot[]): Promise<void> {
  await Promise.all(
    all
      .map((a) => a.image)
      .filter((src): src is string => !!src && !images.has(src))
      .map(
        (src) =>
          new Promise<void>((done) => {
            const img = new Image();
            img.onload = img.onerror = () => done();
            img.src = src;
            images.set(src, img);
          }),
      ),
  );
}

/**
 * Read a picked file into a downscaled data URL.
 *
 * Downscaled because these go into localStorage: a 4 MB phone photo blows the
 * ~5 MB quota with one card, and the card only ever draws it 92 px wide.
 */
export function readPicture(file: File, max = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("not an image"));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
