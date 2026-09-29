/** Provider numbers to integer cents and counts. Anything unparseable is null (unknown),
 * never 0; callers fail the pull instead of storing a guess. Postgres integer bounds apply. */
export const MAX_INT = 2_147_483_647;
/** Meta reports spend as a decimal string in account currency units. Half-up at the third decimal. */
export function decimalCents(value: unknown): number | null {
  const text = typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : value;
  if (typeof text !== "string") return null;
  const match = /^(\d{1,12})(?:\.(\d{1,9}))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const cents = Number(match[1]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) && cents <= MAX_INT ? cents : null;
}
/** Google reports cost in micros (int64, JSON string). */
export function parseMicros(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return typeof value === "string" && /^\d{1,18}$/.test(value) ? BigInt(value) : null;
}
export function microsCents(micros: bigint): number | null {
  if (micros < 0n) return null;
  const cents = (micros + 5_000n) / 10_000n;
  return cents <= BigInt(MAX_INT) ? Number(cents) : null;
}
export function countValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_INT ? n : null;
}
