/** Calendar arithmetic on 'YYYY-MM-DD' strings (no time zones, no Date drift). */

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(s: string): { y: number; m: number; d: number } {
  const match = RE.exec(s);
  if (!match) throw new Error(`Invalid date "${s}"`);
  const [, y, m, d] = match;
  const out = { y: Number(y), m: Number(m), d: Number(d) };
  if (out.m < 1 || out.m > 12 || out.d < 1 || out.d > daysInMonth(out.y, out.m)) throw new Error(`Invalid date "${s}"`);
  return out;
}

export function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toUtc(s: string): number {
  const { y, m, d } = parseDate(s);
  return Date.UTC(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const t = new Date(toUtc(s) + n * 86_400_000);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/**
 * Add months keeping the anchor day where possible: anchored on the 31st gives
 * 31 Jan → 28/29 Feb → 31 Mar (the anchor is not lost after a short month).
 */
export function addMonthsAnchored(start: string, n: number, anchorDay?: number): string {
  const { y, m, d } = parseDate(start);
  const anchor = anchorDay ?? d;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(anchor, daysInMonth(ny, nm)));
}

export function isSunday(s: string): boolean {
  return new Date(toUtc(s)).getUTCDay() === 0;
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
