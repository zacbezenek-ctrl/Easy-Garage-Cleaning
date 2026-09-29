import { LEADGEN_RETENTION_DAYS, RESTATEMENT_DAYS } from "./config.js";
import { addDays, dateRange, maxDate, minDate } from "./dates.js";
import type { DateRange } from "./provider.js";

export interface DayState { reportDate: string; settled: boolean }
/** A day is final once it was pulled after leaving the restatement window: today and the
 * three complete days before it are always re-pulled. */
export const settledOn = (reportDate: string, today: string, restatementDays = RESTATEMENT_DAYS) => reportDate <= addDays(today, -(restatementDays + 1));
/** The oldest Denver day whose lead-form leads Meta can still return in full. */
export const leadgenRetentionFloor = (today: string) => addDays(today, -(LEADGEN_RETENTION_DAYS - 1));
/** Earliest day kept continuous: the configured start date or the first day ever pulled,
 * whichever is earlier; with neither, just the restatement window. */
export function pullFloor({ today, startDate, earliest, restatementDays = RESTATEMENT_DAYS, maxHistoryDays = 730 }:
  { today: string; startDate: string | null; earliest: string | null; restatementDays?: number; maxHistoryDays?: number }) {
  return maxDate(addDays(today, -maxHistoryDays), minDate(startDate, earliest, addDays(today, -restatementDays)))!;
}
/** Every missing or unsettled day from the floor to today, as contiguous chunks, newest
 * first, so the live window is refreshed before any backfill and gaps self-heal. */
export function planPulls({ today, floor, states, maxChunkDays = 31, maxChunks = 6 }:
  { today: string; floor: string; states: DayState[]; maxChunkDays?: number; maxChunks?: number }): DateRange[] {
  const settled = new Set(states.filter(s => s.settled).map(s => s.reportDate));
  const runs: DateRange[] = [];
  for (const date of dateRange(floor, today)) {
    if (settled.has(date)) continue;
    const last = runs.at(-1);
    if (last && addDays(last.to, 1) === date) last.to = date; else runs.push({ from: date, to: date });
  }
  const chunks: DateRange[] = [];
  for (const run of runs.reverse()) {
    for (let to = run.to; to >= run.from && chunks.length < maxChunks;) {
      const from = maxDate(run.from, addDays(to, -(maxChunkDays - 1)))!;
      chunks.push({ from, to });
      to = addDays(from, -1);
    }
  }
  return chunks.slice(0, maxChunks);
}
