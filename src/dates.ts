// Time is one number everywhere in this app: a decimal year. 1942.36 is
// 1942-05-12, -44.2 is a spring day in 45 BC. It sorts correctly, subtracts
// correctly, survives BC, and drops straight into a MapLibre GPU comparison —
// none of which a date string does.

const CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// Proleptic Gregorian. ponytail: historians use Julian dates before 1582, so
// very early dates can be off by up to ~13 days. Irrelevant at the zoom levels
// borders change at; revisit only if someone is mapping day-level antiquity.
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number) => (isLeap(y) ? 366 : 365);

function dayOfYear(y: number, month: number, day: number): number {
  return CUMULATIVE[month - 1] + day + (month > 2 && isLeap(y) ? 1 : 0);
}

/**
 * OHM dates are "1942", "1942-05", "1942-05-12", or "-0044-03-15" for BC.
 * Returns null for absent or unparseable input so callers can pick a sentinel.
 */
export function toDecimalYear(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const m = /^(-?\d+)(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(String(iso).trim());
  if (!m) return null;
  const year = parseInt(m[1], 10);
  if (!Number.isFinite(year)) return null;
  const month = m[2] ? parseInt(m[2], 10) : 1;
  const day = m[3] ? parseInt(m[3], 10) : 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return year;
  return year + (dayOfYear(year, month, day) - 1) / daysInYear(year);
}

/** Decimal year -> {year, month, day}. Inverse of toDecimalYear. */
export function fromDecimalYear(dec: number) {
  const year = Math.floor(dec);
  let remaining = Math.round((dec - year) * daysInYear(year)) + 1;
  const leap = isLeap(year) ? 1 : 0;
  for (let month = 12; month >= 1; month--) {
    const start = CUMULATIVE[month - 1] + (month > 2 ? leap : 0);
    if (remaining > start) return { year, month, day: remaining - start };
  }
  return { year, month: 1, day: 1 };
}

/** `<input type="date">` value. Null below AD 1 — the element has no BC. */
export function toInputDate(dec: number): string | null {
  const { year, month, day } = fromDecimalYear(dec);
  if (year < 1 || year > 9999) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${p(month)}-${p(day)}`;
}

export function formatDate(dec: number): string {
  const { year, month, day } = fromDecimalYear(dec);
  const md = `${day} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][month - 1]}`;
  return year < 0
    ? `${md} ${Math.abs(year).toLocaleString()} BC`
    : `${md} ${year}`;
}
