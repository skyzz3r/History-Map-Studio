// The territory hierarchy as DATA, plus the one layout every diagram shares.
//
// Four views were asked for — list, sankey, radial tree, sunburst — and they
// differ only in how a node's span is projected: to a y-band, to an angle, or
// to an arc. So the layout runs once and returns spans in the unit interval,
// and each renderer is then a handful of coordinate lines. Rewriting the
// recursion three times is how the three views end up disagreeing about which
// node is which.
//
// No d3. The tree here is a spine of at most a few ancestors plus one fan of
// children; d3-hierarchy + d3-sankey + d3-shape is ~200 kB to lay out a dozen
// nodes whose spans are a running sum.

import type { FocusState } from "./focus.ts";
import { ROOT_LEVEL } from "./focus.ts";

export type Kind = "world" | "ancestor" | "tip" | "child";

export type HNode = {
  /** Stable across re-layouts, so a collapsed node stays collapsed. */
  key: string;
  id: string | number;
  name: string;
  level: number;
  kind: Kind;
  /** Trail index to pop back to. Absent on children, which drill in instead. */
  trailIndex?: number;
  children: HNode[];
};

/** ponytail: the fan is capped, or a 189-commune sunburst is a grey disc.
 *  The list view reports the remainder; drill in to narrow it instead. */
export const FAN_CAP = 16;

/** World -> ancestors -> focused polity -> its subdivisions. */
export function hierTree(focus: FocusState): HNode {
  const kids: HNode[] = focus.children.slice(0, FAN_CAP).map((c, i) => ({
    key: `c-${c.osmId}-${i}`,
    id: c.osmId,
    name: c.name,
    level: c.adminLevel,
    kind: "child",
    children: [],
  }));

  // Built from the tip backwards so each ancestor can own the node below it.
  let node: HNode | null = null;
  for (let i = focus.trail.length - 1; i >= 0; i--) {
    const l = focus.trail[i];
    node = {
      key: `t-${l.osmId}-${i}`,
      id: l.osmId,
      name: l.name,
      level: l.adminLevel,
      kind: i === focus.trail.length - 1 ? "tip" : "ancestor",
      trailIndex: i + 1,
      children: node ? [node] : kids,
    };
  }

  return {
    key: "world",
    id: "world",
    name: "World",
    level: ROOT_LEVEL - 1,
    kind: focus.trail.length ? "ancestor" : "tip",
    trailIndex: 0,
    children: node ? [node] : kids,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Placed = {
  node: HNode;
  depth: number;
  /** Span in [0,1]: a y-band for the sankey, an angle sweep for the round views. */
  a0: number;
  a1: number;
  parent: Placed | null;
};

export type Layout = { rows: Placed[]; maxDepth: number };

const visibleChildren = (n: HNode, collapsed: Set<string>) =>
  collapsed.has(n.key) ? [] : n.children;

/** Leaves under a node, which is what its span is proportional to. */
export function leafCount(n: HNode, collapsed: Set<string>): number {
  const kids = visibleChildren(n, collapsed);
  if (!kids.length) return 1;
  let total = 0;
  for (const k of kids) total += leafCount(k, collapsed);
  return total;
}

/**
 * Depth-first placement. Each node gets the slice of its parent's span that its
 * leaf count earns, so siblings partition the parent exactly and every diagram
 * inherits the same proportions.
 */
export function layout(root: HNode, collapsed = new Set<string>()): Layout {
  const rows: Placed[] = [];
  let maxDepth = 0;

  const walk = (n: HNode, depth: number, a0: number, a1: number, parent: Placed | null) => {
    const p: Placed = { node: n, depth, a0, a1, parent };
    rows.push(p);
    maxDepth = Math.max(maxDepth, depth);
    const kids = visibleChildren(n, collapsed);
    if (!kids.length) return;
    const total = leafCount(n, collapsed) || 1;
    let at = a0;
    for (const k of kids) {
      const w = ((a1 - a0) * leafCount(k, collapsed)) / total;
      walk(k, depth + 1, at, at + w, p);
      at += w;
    }
  };

  walk(root, 0, 0, 1, null);
  return { rows, maxDepth };
}

// ---------------------------------------------------------------------------
// SVG path builders — pure, so a wrong arc is caught in node and not by eye
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** Cartesian point on a circle, 0 rad at 12 o'clock and clockwise from there. */
export function polar(cx: number, cy: number, r: number, t: number): [number, number] {
  const a = t * TAU - Math.PI / 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/**
 * One sunburst wedge: the ring between r0 and r1, from t0 to t1 turns.
 *
 * The large-arc flag is computed, not hardcoded to 0. A single child fills the
 * whole ring — an arc of more than half a turn — and with the flag pinned at 0
 * the renderer draws the SHORT way round, so a lone province appeared as a thin
 * sliver of the circle it in fact owns entirely.
 */
export function wedgePath(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  t0: number,
  t1: number,
): string {
  // A full turn cannot be expressed as one arc (start and end coincide, and the
  // renderer draws nothing); shave it so the ring closes visibly.
  const span = Math.min(t1 - t0, 0.9999);
  const end = t0 + span;
  const big = span > 0.5 ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, t0);
  const [x1, y1] = polar(cx, cy, r1, end);
  const [x2, y2] = polar(cx, cy, r0, end);
  const [x3, y3] = polar(cx, cy, r0, t0);
  return [
    `M${x0} ${y0}`,
    `A${r1} ${r1} 0 ${big} 1 ${x1} ${y1}`,
    `L${x2} ${y2}`,
    r0 > 0 ? `A${r0} ${r0} 0 ${big} 0 ${x3} ${y3}` : `L${cx} ${cy}`,
    "Z",
  ].join(" ");
}

/** Radial-tree link: a curve that leaves the parent outward and arrives at the
 *  child, rather than a straight chord cutting across the rings. */
export function radialLink(
  cx: number,
  cy: number,
  r0: number,
  t0: number,
  r1: number,
  t1: number,
): string {
  const [x0, y0] = polar(cx, cy, r0, t0);
  const [x1, y1] = polar(cx, cy, r1, t1);
  const mid = (r0 + r1) / 2;
  const [cxa, cya] = polar(cx, cy, mid, t0);
  const [cxb, cyb] = polar(cx, cy, mid, t1);
  return `M${x0} ${y0} C${cxa} ${cya} ${cxb} ${cyb} ${x1} ${y1}`;
}

/**
 * Sankey ribbon between two columns.
 *
 * The bands are the SAME span at both ends — children partition their parent
 * exactly — so the visible convergence comes from the per-node padding the
 * renderer applies, which is what makes a fan of twelve read as a fan.
 */
export function ribbonPath(
  x0: number,
  x1: number,
  ay0: number,
  ay1: number,
  by0: number,
  by1: number,
): string {
  const mx = (x0 + x1) / 2;
  return [
    `M${x0} ${ay0}`,
    `C${mx} ${ay0} ${mx} ${by0} ${x1} ${by0}`,
    `L${x1} ${by1}`,
    `C${mx} ${by1} ${mx} ${ay1} ${x0} ${ay1}`,
    "Z",
  ].join(" ");
}
