import type { FocusState, Level } from "../focus.ts";
import { ROOT_LEVEL } from "../focus.ts";

/**
 * The territory hierarchy, drawn as a tree.
 *
 * The breadcrumb said where you were but not what the structure IS: how deep the
 * hierarchy goes, what tier you are on, or what is one step below without
 * drilling to find out. This shows the spine from the world view down to the
 * focused polity, then the children as a fanned-out list, with real connector
 * lines so the parent/child relation is visible rather than implied by indent.
 *
 * Every node is a control: an ancestor pops back to it, a child drills into it.
 */
export default function HierarchyPanel({
  focus,
  onJump,
  onDrill,
  onClose,
}: {
  focus: FocusState;
  /** Pop to trail index (0 = world view). */
  onJump: (index: number) => void;
  onDrill: (node: Level) => void;
  /** Omitted when the panel is embedded in the sidebar, which owns its own
   *  header and collapse control — two ✕ buttons on one card read as a bug. */
  onClose?: () => void;
}) {
  const spine: Node[] = [
    { key: "world", name: "World", tier: "All polities", depth: 0 },
    ...focus.trail.map((l, i) => ({
      key: `${l.osmId}-${i}`,
      name: l.name,
      tier: tierName(l.adminLevel),
      depth: i + 1,
      onClick: () => onJump(i + 1),
    })),
  ];
  spine[0].onClick = () => onJump(0);
  const last = spine[spine.length - 1];
  last.current = true;
  last.onClick = undefined;

  const kids = focus.children;

  return (
    <section
      aria-label="Territory hierarchy"
      className={
        onClose
          ? "panel pointer-events-auto flex w-64 flex-col gap-2 overflow-y-auto p-3 text-sm"
          : // Docked: fill the tile, and let the children list be the part that
            // scrolls. min-h-0 is what allows a flex child to shrink below its
            // content — without it the list pushes the panel past the tile.
            "flex h-full min-h-0 flex-col gap-2 text-sm"
      }
    >
      {onClose && (
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-wide text-neutral-500">
            Hierarchy
          </h2>
          <button
            onClick={onClose}
            aria-label="Collapse panel"
            className="rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>
      )}

      <ol className="flex shrink-0 flex-col">
        {spine.map((n, i) => (
          <li key={n.key} className="flex items-stretch gap-2">
            {/* The connector column: a vertical rail through every node above,
                and an elbow into this one. Drawn, not indented, so the depth of
                the hierarchy is readable at a glance. */}
            <Rail first={i === 0} last={i === spine.length - 1 && !kids.length} />
            <button
              onClick={n.onClick}
              disabled={!n.onClick}
              aria-label={`${n.name}, ${n.tier}${n.current ? ", current level" : ""}`}
              className={`my-0.5 min-w-0 flex-1 rounded px-2 py-1 text-left ${
                n.current
                  ? "bg-neutral-100/10 text-neutral-100 ring-1 ring-neutral-100/25"
                  : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              }`}
            >
              <span className="block truncate">{n.name}</span>
              <span className="block truncate text-[11px] text-neutral-500">
                {n.tier}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {kids.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* No naive plural "s": the tier names include "State / province",
              which pluralised to "state / provinces". */}
          <p className="pl-6 text-[11px] uppercase tracking-wide text-neutral-500">
            {kids.length} below · {tierName(kids[0].adminLevel)}
          </p>
          {/* The 12-item cap and its "+N more" went with the fixed sidebar. A
              tile whose height the user chose should use it: the list fills
              what it is given and scrolls past that, instead of hiding twenty
              members under a count while half the panel sits empty. */}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {kids.map((k, i) => (
              <li key={`${k.osmId}-${i}`} className="flex items-stretch gap-2">
                <Rail child last={i === kids.length - 1} />
                <button
                  onClick={() => onDrill(k)}
                  className="my-px min-w-0 flex-1 truncate rounded px-2 py-0.5 text-left text-[13px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  {k.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* "Still looking" and "looked, found none" must not read the same. This
          announced "No subdivisions recorded here" for the second or two before
          the European Union's 32 member states arrived. */}
      {!kids.length && focus.trail.length > 0 && (
        <p className="pl-6 text-[11px] text-neutral-400">
          {focus.resolved ? "No subdivisions recorded here." : "Looking…"}
        </p>
      )}

      <p className="text-[11px] leading-snug text-neutral-400">
        Double-click a territory to go deeper · Esc to go up
      </p>
    </section>
  );
}

type Node = {
  key: string;
  name: string;
  tier: string;
  depth: number;
  current?: boolean;
  onClick?: () => void;
};

/**
 * One cell of the connector tree. `first` has no incoming rail, `last` stops the
 * rail below the elbow so the line does not dangle past the final node.
 */
function Rail({
  first,
  last,
  child,
}: {
  first?: boolean;
  last?: boolean;
  child?: boolean;
}) {
  return (
    <span aria-hidden className="relative w-3 shrink-0">
      {!first && (
        <span
          className="absolute left-1 top-0 w-px bg-neutral-700"
          style={{ height: last ? "50%" : "100%" }}
        />
      )}
      {!first && (
        <span className="absolute left-1 top-1/2 h-px w-2 bg-neutral-700" />
      )}
      {/* A filled dot marks a node that exists on the map; children get a hollow
          one because they are not drawn as the focus yet. */}
      <span
        className={`absolute left-[1px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full ${
          child ? "border border-neutral-600" : "bg-neutral-500"
        }`}
        style={{ left: child ? "1px" : "1px" }}
      />
    </span>
  );
}

/**
 * Tier names. Level 1 is genuinely the supranational tier in OHM — the European
 * Union, the British Empire and 805 others carry admin_level=1.
 */
export function tierName(level: number): string {
  if (level <= ROOT_LEVEL) return "Empire / union";
  return (
    { 2: "Country", 3: "Region", 4: "State / province", 5: "District", 6: "County" }[
      level
    ] ?? `Level ${level}`
  );
}
