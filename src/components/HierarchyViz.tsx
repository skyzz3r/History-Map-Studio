import { useState } from "react";
import type { FocusState, Level } from "../focus.ts";
import {
  hierTree,
  layout,
  polar,
  radialLink,
  ribbonPath,
  wedgePath,
  type HNode,
  type Placed,
} from "../hier.ts";
import { tierName } from "./HierarchyPanel.tsx";

export type VizView = "sankey" | "radial" | "sunburst";

/**
 * The hierarchy as a diagram: sankey, collapsible radial tree, or sunburst.
 *
 * All three read the same layout (hier.ts), so they can never disagree about
 * which node is which or how big it is — they differ only in whether a node's
 * span becomes a band, an angle, or an arc.
 *
 * Every node is a control, exactly as in the list view: an ancestor pops back
 * to it, a child drills into it. On the round views the ring around a node
 * collapses its branch instead, so a deep tree can be folded down.
 */
export default function HierarchyViz({
  focus,
  view,
  onJump,
  onDrill,
}: {
  focus: FocusState;
  view: VizView;
  onJump: (index: number) => void;
  onDrill: (n: Level) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const root = hierTree(focus);
  const { rows, maxDepth } = layout(root, collapsed);

  const activate = (n: HNode) => {
    if (n.trailIndex !== undefined) return onJump(n.trailIndex);
    onDrill({ osmId: n.id, name: n.name, adminLevel: n.level });
  };

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Tested on the TREE, not on the laid-out rows. Folding the root also
  // collapses `rows` to one entry, and checking that swapped the diagram for
  // "nothing to draw" — with the fold control gone there was then no way back.
  if (!root.children.length)
    return (
      <p className="px-1 py-3 text-[11px] leading-snug text-neutral-400">
        {focus.resolved
          ? "Nothing below this level to draw. Drill into a territory to see its subdivisions."
          : "Looking…"}
      </p>
    );

  return view === "sankey" ? (
    <Sankey rows={rows} maxDepth={maxDepth} onPick={activate} />
  ) : view === "radial" ? (
    <Radial
      rows={rows}
      maxDepth={maxDepth}
      collapsed={collapsed}
      onPick={activate}
      onToggle={toggle}
    />
  ) : (
    <Sunburst rows={rows} maxDepth={maxDepth} onPick={activate} />
  );
}

/** Same colour code as the map fills, so the diagram and the map agree. */
function hue(n: HNode): string {
  if (n.kind === "world") return "#525252";
  if (n.level <= 1) return "#a78bfa";
  if (n.level === 2) return "#e5e7eb";
  return "#94a3b8";
}

const label = (n: HNode) => `${n.name} · ${n.kind === "world" ? "All polities" : tierName(n.level)}`;

// ---------------------------------------------------------------------------
// Sankey
// ---------------------------------------------------------------------------

function Sankey({
  rows,
  maxDepth,
  onPick,
}: {
  rows: Placed[];
  maxDepth: number;
  onPick: (n: HNode) => void;
}) {
  const W = Math.max(260, 90 * (maxDepth + 1));
  const leaves = rows.filter((r) => r.a1 - r.a0 > 0).length;
  const H = Math.max(140, Math.min(24 * leaves, 420));
  const colW = W / (maxDepth + 1);
  const bar = 9;
  // Padding is what makes a fan read as a fan: without it every child band is
  // flush against the next and the ribbons are one solid block.
  const pad = 1.5;

  const band = (p: Placed) => {
    const y0 = p.a0 * H + pad;
    const y1 = Math.max(y0 + 1, p.a1 * H - pad);
    return [y0, y1] as const;
  };
  const x = (d: number) => d * colW;

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img" aria-label="Hierarchy, as a flow diagram">
        {rows.map((p) => {
          if (!p.parent) return null;
          const [ay0, ay1] = band(p.parent);
          const [by0, by1] = band(p);
          return (
            <path
              key={`r-${p.node.key}`}
              d={ribbonPath(x(p.parent.depth) + bar, x(p.depth), ay0, ay1, by0, by1)}
              fill={hue(p.node)}
              opacity={0.16}
            />
          );
        })}
        {rows.map((p) => {
          const [y0, y1] = band(p);
          return (
            <g key={p.node.key}>
              <rect
                x={x(p.depth)}
                y={y0}
                width={bar}
                height={y1 - y0}
                rx={2}
                fill={hue(p.node)}
                opacity={p.node.kind === "tip" ? 1 : 0.75}
              />
              <text
                x={x(p.depth) + bar + 4}
                y={(y0 + y1) / 2}
                dominantBaseline="middle"
                className="cursor-pointer fill-neutral-300 text-[10px] hover:fill-neutral-50"
                onClick={() => onPick(p.node)}
              >
                {p.node.name.length > 14 ? `${p.node.name.slice(0, 13)}…` : p.node.name}
                <title>{label(p.node)}</title>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Radial tree
// ---------------------------------------------------------------------------

function Radial({
  rows,
  maxDepth,
  collapsed,
  onPick,
  onToggle,
}: {
  rows: Placed[];
  maxDepth: number;
  collapsed: Set<string>;
  onPick: (n: HNode) => void;
  onToggle: (key: string) => void;
}) {
  const S = 260;
  const c = S / 2;
  const ring = (S / 2 - 26) / Math.max(maxDepth, 1);
  const at = (p: Placed): [number, number] =>
    polar(c, c, p.depth * ring, (p.a0 + p.a1) / 2);

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${S} ${S}`}
      role="img"
      aria-label="Hierarchy, as a radial tree"
    >
      {rows.map((p) =>
        p.parent ? (
          <path
            key={`l-${p.node.key}`}
            d={radialLink(
              c,
              c,
              p.parent.depth * ring,
              (p.parent.a0 + p.parent.a1) / 2,
              p.depth * ring,
              (p.a0 + p.a1) / 2,
            )}
            fill="none"
            stroke="#525252"
            strokeWidth={1}
          />
        ) : null,
      )}
      {rows.map((p) => {
        const [x, y] = at(p);
        const has = p.node.children.length > 0;
        const folded = collapsed.has(p.node.key);
        return (
          <g key={p.node.key}>
            <circle
              cx={x}
              cy={y}
              r={p.node.kind === "tip" ? 5 : 4}
              fill={folded ? "transparent" : hue(p.node)}
              stroke={hue(p.node)}
              strokeWidth={1.5}
              className={has ? "cursor-pointer" : ""}
              onClick={() => has && onToggle(p.node.key)}
            >
              <title>
                {has
                  ? `${folded ? "Expand" : "Collapse"} ${p.node.name}`
                  : p.node.name}
              </title>
            </circle>
            <text
              x={x}
              y={y - 8}
              textAnchor="middle"
              className="cursor-pointer fill-neutral-300 text-[9px] hover:fill-neutral-50"
              onClick={() => onPick(p.node)}
            >
              {p.node.name.length > 12 ? `${p.node.name.slice(0, 11)}…` : p.node.name}
              <title>{label(p.node)}</title>
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sunburst
// ---------------------------------------------------------------------------

function Sunburst({
  rows,
  maxDepth,
  onPick,
}: {
  rows: Placed[];
  maxDepth: number;
  onPick: (n: HNode) => void;
}) {
  const S = 260;
  const c = S / 2;
  const ring = (S / 2 - 8) / (maxDepth + 1);

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${S} ${S}`}
      role="img"
      aria-label="Hierarchy, as a sunburst"
    >
      {rows.map((p) => (
        <path
          key={p.node.key}
          d={wedgePath(c, c, p.depth * ring, (p.depth + 1) * ring - 1.5, p.a0, p.a1)}
          fill={hue(p.node)}
          opacity={p.node.kind === "tip" ? 0.95 : 0.5}
          stroke="#0a0a0a"
          strokeWidth={0.75}
          className="cursor-pointer hover:opacity-100"
          onClick={() => onPick(p.node)}
        >
          <title>{label(p.node)}</title>
        </path>
      ))}
      {/* The centre is the world view, which is otherwise a wedge you cannot
          aim at once the tree is more than two levels deep. */}
      <text
        x={c}
        y={c}
        textAnchor="middle"
        dominantBaseline="middle"
        className="pointer-events-none fill-neutral-900 text-[9px] font-medium"
      >
        {rows[0]?.node.name.slice(0, 8)}
      </text>
    </svg>
  );
}
