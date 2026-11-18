/**
 * Formatting helpers.
 *
 * ORENEX reports tonnes, grade and probability, so number formatting carries
 * real meaning here: thousands separators, fixed significant digits on grades,
 * uncertainty shown inline.
 */

const nf = (min: number, max: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: min, maximumFractionDigits: max });

const f0 = nf(0, 0);
const f1 = nf(1, 1);
const f2 = nf(2, 2);
const f3 = nf(3, 3);

export function num(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (decimals === 0) return f0.format(Math.round(v));
  if (decimals === 1) return f1.format(v);
  if (decimals === 2) return f2.format(v);
  return f3.format(v);
}

export function tonnes(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${num(v, decimals)} t`;
}

export function pct(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${decimals === 0 ? f0.format(v * 100) : f1.format(v * 100)}%`;
}

export function grade(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${decimals === 0 ? f0.format(v) : decimals === 1 ? f1.format(v) : f2.format(v)}%`;
}

export function metres(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${num(v, decimals)} m`;
}

export function signed(v: number, decimals = 0): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${num(Math.abs(v), decimals)}`;
}

// ── Dates ───────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** System clock is used deliberately — the prototype shows "today's intelligence". */
export const NOW = new Date();

export function fmtDateShort(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return `${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]}`;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** Monsoon intensity 0..1 for Balaghat — June to September peak. */
export function monsoonFactor(d: Date): number {
  const m = d.getMonth();
  const dayFrac = d.getDate() / 30;
  if (m === 5) return 0.28 + 0.4 * dayFrac; // Jun
  if (m === 6) return 0.72 + 0.25 * dayFrac; // Jul
  if (m === 7) return 1.0 - 0.2 * dayFrac; // Aug
  if (m === 8) return 0.78 - 0.4 * dayFrac; // Sep
  if (m === 4) return 0.16 * dayFrac; // May
  return 0;
}
