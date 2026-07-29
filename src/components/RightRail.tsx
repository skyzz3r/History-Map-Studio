import { useState, type ReactNode } from "react";
import {
  BASEMAPS,
  getDisplay,
  savedBasemap,
  savedClip,
  savedCustomBasemaps,
  setBasemap,
  setClip,
  setDisplay,
  setSources,
  drillInto,
  drillOut,
} from "../map.ts";
import { SOURCES, isOverlay, savedSources } from "../sources.ts";
import type { Display } from "../view.ts";
import type { FocusState, Level } from "../focus.ts";
import HierarchyPanel from "./HierarchyPanel.tsx";
import HierarchyViz, { type VizView } from "./HierarchyViz.tsx";

type Tab = "list" | VizView;

const TABS: { id: Tab; label: string; title: string }[] = [
  { id: "list", label: "List", title: "The spine and its subdivisions, as a tree" },
  { id: "sankey", label: "Sankey", title: "Flow diagram, sized by how much sits under each node" },
  { id: "radial", label: "Radial", title: "Radial tree — click a node's ring to fold its branch" },
  { id: "sunburst", label: "Sunburst", title: "Concentric rings, one per level" },
];

/**
 * Everything about HOW the map is drawn, in one column on the right.
 *
 * These controls used to be a floating card that overlapped the map and the
 * detail sheet. A docked rail cannot collide with anything: the map, the
 * timeline and the legend are all laid out against `--rail`, which this sets.
 */
export default function RightRail({
  open,
  onOpen,
  hierOpen,
  onHierOpen,
  focus,
}: {
  open: boolean;
  onOpen: (v: boolean) => void;
  /** Controlled from App so the detail card's "Show hierarchy" can open it. */
  hierOpen: boolean;
  onHierOpen: (v: boolean) => void;
  focus: FocusState;
}) {
  const [display, setLocal] = useState<Display>(getDisplay);
  const [basemap, setBase] = useState(savedBasemap);
  const [on, setOn] = useState<string[]>(savedSources);
  const [clip, setClipOn] = useState(savedClip);
  const [tab, setTab] = useState<Tab>("list");

  const customs = savedCustomBasemaps();
  const datasets = SOURCES.filter((s) => !s.overlay);
  const overlays = SOURCES.filter((s) => s.overlay);
  const current = on.find((id) => !isOverlay(id)) ?? datasets[0]?.id;

  const put = (patch: Partial<Display>) => {
    const next = { ...display, ...patch };
    setLocal(next);
    setDisplay(next);
  };

  const chooseDataset = (id: string, restricted?: boolean) => {
    const s = SOURCES.find((x) => x.id === id);
    // A licence that forbids commercial use is not something to discover later.
    if (restricted && !on.includes(id) && !confirm(`${s?.label}\n\n${s?.note}\n\nEnable this source?`))
      return;
    const next = [id, ...on.filter(isOverlay)];
    setOn(next);
    void setSources(next);
  };

  if (!open)
    return (
      <div className="absolute right-3 top-20 z-20">
        <button
          onClick={() => onOpen(true)}
          aria-expanded={false}
          aria-label="Show map settings and hierarchy"
          className="panel px-2 py-2 text-sm text-neutral-300 hover:text-neutral-100"
        >
          ☰
        </button>
      </div>
    );

  return (
    <aside
      aria-label="Map settings and hierarchy"
      className="absolute bottom-0 right-0 top-16 z-20 flex w-72 flex-col gap-3 overflow-y-auto border-l border-neutral-700/60 bg-neutral-900/90 p-3 text-sm backdrop-blur"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">View</h2>
        <button
          onClick={() => onOpen(false)}
          aria-expanded
          aria-label="Collapse the sidebar"
          className="rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          ✕
        </button>
      </div>

      <Field label="Basemap">
        <select
          value={basemap}
          onChange={(e) => {
            setBase(e.target.value);
            void setBasemap(e.target.value);
          }}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200"
        >
          {BASEMAPS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
          {customs.length > 0 && (
            <optgroup label="Saved styles">
              {customs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>

      <Field label="Border source">
        <ul className="flex flex-col gap-1">
          {datasets.map((s) => (
            <li key={s.id}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="border-source"
                  checked={current === s.id}
                  onChange={() => chooseDataset(s.id, s.restricted)}
                  className="mt-1 accent-neutral-100"
                />
                <span className="min-w-0">
                  <span className="text-neutral-100">{s.label}</span>
                  {s.restricted && (
                    <span className="ml-1 rounded bg-amber-900/70 px-1 text-[10px] uppercase text-amber-200">
                      NC
                    </span>
                  )}
                  {s.note && (
                    <span className="block text-[11px] leading-snug text-neutral-500">
                      {s.note}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <ul className="mt-1.5 flex flex-col gap-1 border-t border-neutral-800 pt-1.5">
          {overlays.map((s) => (
            <li key={s.id}>
              <Check
                checked={on.includes(s.id)}
                onChange={() => {
                  const next = on.includes(s.id)
                    ? on.filter((x) => x !== s.id)
                    : [...on, s.id];
                  setOn(next);
                  void setSources(next);
                }}
                label={s.label}
                note={s.note}
              />
            </li>
          ))}
        </ul>
      </Field>

      <Field label="Projection">
        <div className="flex gap-1">
          {(["mercator", "globe"] as const).map((p) => (
            <button
              key={p}
              onClick={() => put({ projection: p })}
              aria-pressed={display.projection === p}
              className={`flex-1 rounded-md px-2 py-1 capitalize ${
                display.projection === p
                  ? "bg-neutral-100 font-medium text-neutral-900"
                  : "bg-neutral-800 text-neutral-300"
              }`}
            >
              {p === "mercator" ? "Flat" : "Globe"}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Territory">
        <Check
          checked={display.fill}
          onChange={() => put({ fill: !display.fill })}
          label="Colour fill"
          note="Off leaves the border lines and labels."
        />
        <Check
          checked={clip}
          onChange={() => {
            setClipOn(!clip);
            setClip(!clip);
          }}
          label="Clip to coastline"
          note="Hides each territory's sea area. Keeps lake borders."
        />
      </Field>

      <Field label="Labels">
        <Check checked={display.labelFlag} onChange={() => put({ labelFlag: !display.labelFlag })} label="Flag" />
        <Check checked={display.labelName} onChange={() => put({ labelName: !display.labelName })} label="Name" />
        <Check checked={display.labelDates} onChange={() => put({ labelDates: !display.labelDates })} label="Dates" />
      </Field>

      <div className="border-t border-neutral-800 pt-2">
        <button
          onClick={() => onHierOpen(!hierOpen)}
          aria-expanded={hierOpen}
          className="flex w-full items-center justify-between rounded px-1 py-0.5 text-left text-xs uppercase tracking-wide text-neutral-500 hover:text-neutral-300"
        >
          <span>Hierarchy</span>
          <span>{hierOpen ? "▲" : "▼"}</span>
        </button>

        {hierOpen && (
          <>
            <div role="tablist" aria-label="Hierarchy view" className="mt-2 flex gap-0.5 rounded-md bg-neutral-950/60 p-0.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  title={t.title}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 rounded px-1.5 py-1 text-[11px] ${
                    tab === t.id
                      ? "bg-neutral-100 font-medium text-neutral-900"
                      : "text-neutral-400 hover:text-neutral-100"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="mt-2">
              {tab === "list" ? (
                <HierarchyPanel focus={focus} onJump={drillOut} onDrill={drill} />
              ) : (
                <HierarchyViz focus={focus} view={tab} onJump={drillOut} onDrill={drill} />
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

const drill = (n: Level) =>
  void drillInto({ osmId: n.osmId, name: n.name, adminLevel: n.adminLevel });

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      {children}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  note?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-neutral-100"
      />
      <span className="min-w-0">
        <span className="text-neutral-100">{label}</span>
        {note && (
          <span className="block text-[11px] leading-snug text-neutral-500">
            {note}
          </span>
        )}
      </span>
    </label>
  );
}
