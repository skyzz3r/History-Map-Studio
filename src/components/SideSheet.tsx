import { useEffect, useState } from "react";
import { drillInto, type Picked } from "../map.ts";
import { tierName } from "./HierarchyPanel.tsx";
import type { Info } from "../wikidata.ts";

export default function SideSheet({
  picked,
  info,
  others,
  onSelect,
  onClose,
}: {
  picked: Picked;
  info: Info | null;
  /** Other polities under the same click — an occupier and the claim it displaced. */
  others: Picked[];
  onSelect: (p: Picked) => void;
  onClose: () => void;
}) {
  // "none" only after a drill actually ran and came back empty, so the button
  // never lies about data it has not looked for yet.
  const [sub, setSub] = useState<"idle" | "busy" | "none">("idle");
  useEffect(() => setSub("idle"), [picked]);

  return (
    <aside className="absolute right-0 top-0 flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-neutral-800 bg-neutral-900/95 p-5 backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-medium leading-tight">
          {info?.name ?? picked.name}
        </h2>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="shrink-0 rounded px-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          ✕
        </button>
      </div>

      {info === null && <p className="text-sm text-neutral-500">Loading…</p>}

      <div className="flex gap-3">
        {info?.flag && (
          <img
            src={info.flag}
            alt=""
            loading="lazy"
            className="h-16 rounded border border-neutral-700 object-contain"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        )}
        {info?.arms && (
          <img
            src={info.arms}
            alt=""
            loading="lazy"
            className="h-16 object-contain"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        )}
      </div>

      <dl className="space-y-1.5 text-sm">
        {/* Straight off the clicked feature — the exact validity window the
            source records for it, which is what the date filter matched on. */}
        <Row label="Existed" value={range(picked.startDate, picked.endDate)} />
        <Row
          label="Level"
          value={picked.adminLevel ? tierName(picked.adminLevel) : undefined}
        />
        <Row label="Head of state" value={info?.leader} />
        <Row label="Population" value={info?.population} />
      </dl>

      <button
        disabled={sub !== "idle"}
        onClick={async () => {
          setSub("busy");
          setSub((await drillInto(picked)) ? "idle" : "none");
        }}
        className="rounded-lg bg-neutral-800 px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-neutral-800"
      >
        {sub === "busy"
          ? "Looking…"
          : sub === "none"
            ? "No subdivisions recorded"
            : "Show subdivisions ↓"}
      </button>

      {/* Two polities can genuinely cover one point — in 1942 the Deutsches
          Reich held Lviv while the Soviet Union still claimed it. Without this
          list the one that loses the click is unreachable by any click. */}
      {others.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            Also here
          </p>
          {others.map((o) => (
            <button
              key={o.osmId}
              onClick={() => onSelect(o)}
              className="block w-full rounded px-2 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800"
            >
              {o.name}
            </button>
          ))}
        </div>
      )}

      {info?.summary && (
        <p className="text-sm leading-relaxed text-neutral-300">{info.summary}</p>
      )}

      {/* Falls back to the feature's own attributes when Wikidata has no match —
          routine for ancient and obscure polities. */}
      {info && !info.qid && (
        <p className="text-sm text-neutral-500">
          No Wikidata match. Showing map attributes only.
        </p>
      )}

      {info?.url && (
        <a
          href={info.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-sky-400 underline underline-offset-2"
        >
          Read on Wikipedia
        </a>
      )}
    </aside>
  );
}

/** OHM dates are ISO-ish and end_date is often absent, meaning "still exists". */
const range = (start?: string, end?: string) =>
  start || end ? `${start ?? "?"} – ${end ?? "present"}` : undefined;

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{value}</dd>
    </div>
  );
}
