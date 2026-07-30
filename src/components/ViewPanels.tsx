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

/**
 * What used to be the right rail, split into the two panels it always was.
 *
 * The rail packed "how the map draws" and "what is inside what" into one
 * scrolling column with a disclosure between them, because there was only one
 * edge to put them on. In a docking workspace they are separate tabs the user
 * can size independently — the whole point of the hierarchy views is that they
 * are worth 60% of the screen sometimes and 0% the rest of the time, and a
 * fixed 18rem column could never give them that.
 *
 * Both fill their tab. No absolute positioning, no z-index, no `--rail`: the
 * layout engine owns where they are now.
 */

export function LayersPanel() {
  const [display, setLocal] = useState<Display>(getDisplay);
  const [basemap, setBase] = useState(savedBasemap);
  const [on, setOn] = useState<string[]>(savedSources);
  const [clip, setClipOn] = useState(savedClip);

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

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
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
                    <span className="ml-1 rounded bg-amber-900/70 px-1 text-[10px] uppercase text-amber-100">
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
    </div>
  );
}

type Tab = "list" | VizView;

const TABS: { id: Tab; label: string; title: string }[] = [
  { id: "list", label: "List", title: "The spine and its subdivisions, as a tree" },
  { id: "sankey", label: "Sankey", title: "Flow diagram, sized by how much sits under each node" },
  { id: "radial", label: "Radial", title: "Radial tree — click a node's ring to fold its branch" },
  { id: "sunburst", label: "Sunburst", title: "Concentric rings, one per level" },
];

export function HierarchyTab({ focus }: { focus: FocusState }) {
  const [tab, setTab] = useState<Tab>("list");

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-3 text-sm">
      <div role="tablist" aria-label="Hierarchy view" className="flex shrink-0 gap-0.5 rounded-md bg-neutral-950/60 p-0.5">
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
      {/* The visualisations size themselves to this box, so giving the tab more
          room is what makes a sunburst of the British Empire readable. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "list" ? (
          <HierarchyPanel focus={focus} onJump={drillOut} onDrill={drill} />
        ) : (
          <HierarchyViz focus={focus} view={tab} onJump={drillOut} onDrill={drill} />
        )}
      </div>
    </div>
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
