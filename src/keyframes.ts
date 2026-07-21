// Camera keyframes. No GSAP: interpolating a camera is a lerp of five numbers.

export type Key = {
  t: number; // seconds
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
  index: number; // timeline slider position, so time-travel is keyframed too
};

export type Camera = Omit<Key, "t">;

const easeInOut = (u: number) =>
  u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/**
 * Shortest-arc bearing lerp. Naive lerp from 350 to 10 spins the map 340 degrees
 * the wrong way; this goes forward through 0.
 */
export function lerpBearing(a: number, b: number, u: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return a + d * u;
}

/** Camera at time t, or null if there are no keys. Clamps outside the range. */
export function sampleCamera(keys: Key[], t: number): Camera | null {
  if (!keys.length) return null;
  const k = [...keys].sort((x, y) => x.t - y.t);
  if (t <= k[0].t) return strip(k[0]);
  if (t >= k[k.length - 1].t) return strip(k[k.length - 1]);

  let i = 0;
  while (i < k.length - 2 && k[i + 1].t <= t) i++;
  const a = k[i];
  const b = k[i + 1];
  const u = easeInOut((t - a.t) / (b.t - a.t));

  return {
    lng: lerp(a.lng, b.lng, u),
    lat: lerp(a.lat, b.lat, u),
    zoom: lerp(a.zoom, b.zoom, u),
    pitch: lerp(a.pitch, b.pitch, u),
    bearing: lerpBearing(a.bearing, b.bearing, u),
    index: lerp(a.index, b.index, u),
  };
}

export const duration = (keys: Key[]) =>
  keys.length ? Math.max(...keys.map((k) => k.t)) : 0;

const strip = ({ t: _t, ...cam }: Key): Camera => cam;

/** rAF playback. Returns a stop function. */
export function play(
  keys: Key[],
  onTick: (cam: Camera, t: number) => void,
  onDone: () => void,
): () => void {
  const end = duration(keys);
  const start = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const t = (now - start) / 1000;
    const cam = sampleCamera(keys, Math.min(t, end));
    if (cam) onTick(cam, Math.min(t, end));
    if (t >= end) return onDone();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
