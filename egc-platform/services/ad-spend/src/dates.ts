/** Calendar helpers. Provider reports are dated in the ad account's own time zone;
 * the business reports Denver days. Everything here is pure and takes explicit
 * instants, so no caller depends on the host clock or the host time zone. */
export const DENVER = "America/Denver";
const DAY = 86_400_000, MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, value);
  }
  return value;
}
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try { formatter(value); return true; } catch { return false; }
}
// Built from components so '2026-02-30' is invalid instead of rolling over.
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const stamp = Date.UTC(y, m - 1, d, 12);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}
export function zonedDate(instant: Date | number, timeZone: string = DENVER): string {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const addDays = (date: string, count: number) => new Date(Date.parse(`${date}T12:00:00Z`) + count * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
export const minDate = (...dates: (string | null | undefined)[]) => dates.filter((d): d is string => Boolean(d)).sort()[0] ?? null;
export const maxDate = (...dates: (string | null | undefined)[]) => dates.filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
/** Inclusive list of dates, bounded so a malformed range can never allocate unbounded memory. */
export function dateRange(from: string, to: string): string[] {
  const count = daysBetween(from, to) + 1;
  if (!validDate(from) || !validDate(to) || count < 1 || count > 3700) return [];
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}
/** First instant (minute resolution) whose local calendar date is `date`. A binary
 * search instead of offset arithmetic also handles zones whose midnight is skipped. */
export function dayStart(date: string, timeZone: string): number {
  let lo = Math.floor(Date.parse(`${date}T00:00:00Z`) / MINUTE) - 30 * 60, hi = lo + 60 * 60;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (zonedDate(mid * MINUTE, timeZone) < date) lo = mid; else hi = mid;
  }
  return hi * MINUTE;
}
/** True when the provider's local day is exactly the Denver day (same start and end instants). */
export function alignedWithDenver(date: string, timeZone: string): boolean {
  if (timeZone === DENVER) return true;
  const next = addDays(date, 1);
  return dayStart(date, timeZone) === dayStart(date, DENVER) && dayStart(next, timeZone) === dayStart(next, DENVER);
}
/** The Denver date a provider day is reported under. Aligned days map exactly; any other
 * zone maps by the provider day's midpoint and callers mark that day partial. */
export function denverDateOf(reportDate: string, timeZone: string): string {
  if (alignedWithDenver(reportDate, timeZone)) return reportDate;
  return zonedDate((dayStart(reportDate, timeZone) + dayStart(addDays(reportDate, 1), timeZone)) / 2, DENVER);
}
/** False when no provider day in `timeZone` is reported under Denver date `date`: midpoint
 * mapping skips a Denver date for zones about 12 hours away around a Denver DST change, and
 * that day's spend is counted on the neighbouring Denver date instead. */
export function denverDateReceivesDay(date: string, timeZone: string): boolean {
  return [-2, -1, 0, 1, 2].some(offset => denverDateOf(addDays(date, offset), timeZone) === date);
}
/** Strict provider instant: ISO date-time with an explicit offset (Meta sends +0000). */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match || !validDate(value.slice(0, 10))) return null;
  const offset = match[2] === "Z" ? "Z" : `${match[2]!.slice(0, 3)}:${match[2]!.slice(-2)}`;
  const stamp = Date.parse(`${match[1]}${offset}`);
  return Number.isFinite(stamp) ? stamp : null;
}
