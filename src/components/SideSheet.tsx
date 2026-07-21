import type { Picked } from "../map.ts";
import type { Info } from "../wikidata.ts";

export default function SideSheet({
  picked,
  info,
  onClose,
}: {
  picked: Picked;
  info: Info | null;
  onClose: () => void;
}) {
  return (
    <aside className="absolute right-0 top-0 flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-neutral-800 bg-neutral-900/95 p-5 backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-medium leading-tight">
          {info?.name ?? picked.name}
        </h2>
        <button
          onClick={onClose}
          aria-label="Close"
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
        <Row label="Subject to" value={picked.subjectTo} />
        <Row label="Part of" value={picked.partOf} />
        <Row label="Head of state" value={info?.leader} />
        <Row label="Population" value={info?.population} />
      </dl>

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

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{value}</dd>
    </div>
  );
}
