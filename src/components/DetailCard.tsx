import { useEffect, useState } from "react";
import { drillInto, type Picked } from "../map.ts";
import { tierName } from "./HierarchyPanel.tsx";
import type { Info } from "../wikidata.ts";

/**
 * What you clicked, in a card rather than a full-height sheet.
 *
 * The sheet it replaces took a fixed 320 px column of the window for as long as
 * anything was selected, which on a laptop is a quarter of the map. This is the
 * same information in a card pinned to one corner: the facts you always want
 * are always visible, and the summary — the only genuinely long part — is one
 * disclosure away.
 */
export default function DetailCard({
  picked,
  info,
  others,
  onSelect,
  onShowHierarchy,
  onClose,
}: {
  picked: Picked;
  info: Info | null;
  /** Other polities under the same click — an occupier and the claim it displaced. */
  others: Picked[];
  onSelect: (p: Picked) => void;
  /** Open the sidebar's hierarchy section on this region. */
  onShowHierarchy: () => void;
  /** Omitted when the card is docked in a tab: the tab has a ✕ of its own, and
   *  two of them on one card read as a bug. */
  onClose?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    setBusy(false);
    setMore(false);
  }, [picked]);

  const facts = [
    ["Existed", range(picked.startDate, picked.endDate)],
    ["Level", picked.adminLevel ? tierName(picked.adminLevel) : undefined],
    ["Head of state", info?.leader],
    ["Population", info?.population],
  ] as const;

  return (
    <aside
      aria-label="Territory details"
      className="panel pointer-events-auto flex max-h-full w-80 flex-col gap-2.5 overflow-y-auto p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        {info?.flag && (
          <img
            src={info.flag}
            alt=""
            loading="lazy"
            className="h-7 shrink-0 rounded border border-neutral-700 object-contain"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        )}
        <h2 className="min-w-0 flex-1 text-base font-medium leading-tight">
          {info?.name ?? picked.name}
        </h2>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close details"
            className="shrink-0 rounded px-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        )}
      </div>

      {/* Two columns of short facts, so four rows cost two lines rather than
          four — the difference between a card and another sheet. */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">
        {facts.map(([k, v]) =>
          v ? (
            <div key={k} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                {k}
              </dt>
              <dd className="truncate text-neutral-200" title={v}>
                {v}
              </dd>
            </div>
          ) : null,
        )}
      </dl>

      {info === null && <p className="text-xs text-neutral-500">Loading…</p>}

      <div className="flex flex-wrap gap-1.5">
        {/* Was "Show subdivisions", which only drilled and then said nothing —
            the result was a hierarchy you had to go and look for. This drills
            AND opens the sidebar's hierarchy section on the way, so the answer
            arrives with the action. The panel itself reports an empty level, so
            this button no longer has to. */}
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            onShowHierarchy();
            await drillInto(picked);
            setBusy(false);
          }}
          className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:cursor-default disabled:opacity-50"
        >
          {busy ? "Looking…" : "Show hierarchy ↗"}
        </button>
        {(info?.summary || info?.arms) && (
          <button
            onClick={() => setMore((m) => !m)}
            aria-expanded={more}
            className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            {more ? "Less" : "More"}
          </button>
        )}
        {info?.url && (
          <a
            href={info.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-2.5 py-1 text-xs text-sky-400 underline underline-offset-2 hover:bg-neutral-800"
          >
            Wikipedia ↗
          </a>
        )}
      </div>

      {more && (
        <div className="flex flex-col gap-2 border-t border-neutral-800 pt-2">
          {info?.arms && (
            <img
              src={info.arms}
              alt=""
              loading="lazy"
              className="h-20 self-start object-contain"
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
          )}
          {info?.summary && (
            <p className="text-[13px] leading-relaxed text-neutral-300">
              {info.summary}
            </p>
          )}
        </div>
      )}

      {/* Two polities can genuinely cover one point — in 1942 the Deutsches
          Reich held Lviv while the Soviet Union still claimed it. Without this
          list the one that loses the click is unreachable by any click. */}
      {others.length > 0 && (
        <div className="border-t border-neutral-800 pt-2">
          <p className="text-[10px] uppercase tracking-wide text-neutral-500">
            Also here
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {others.map((o) => (
              <button
                key={String(o.osmId)}
                onClick={() => onSelect(o)}
                className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
              >
                {o.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Falls back to the feature's own attributes when Wikidata has no match —
          routine for ancient and obscure polities. */}
      {info && !info.qid && (
        <p className="text-[11px] text-neutral-500">
          No Wikidata match. Showing map attributes only.
        </p>
      )}
    </aside>
  );
}

/** OHM dates are ISO-ish and end_date is often absent, meaning "still exists". */
const range = (start?: string, end?: string) =>
  start || end ? `${start ?? "?"} – ${end ?? "present"}` : undefined;
