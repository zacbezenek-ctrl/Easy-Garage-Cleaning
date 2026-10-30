/* Which timecard breaks are paid time worked (compliance default, 2026-10-30; the owner confirms it with the rest of the
   COMPS reading in timesheet-week.js). A manager's marking wins: kind 'rest' is a paid rest break and kind 'meal' an
   unpaid meal period. An unmarked break (the crew's Start break) of 20 minutes or less is paid and a longer one is an
   unpaid meal period: federal rules count breaks of 20 minutes or less as hours worked (29 CFR 785.18), and Colorado's
   COMPS Order (rule 5.2) requires a paid 10-minute rest period for every 4 hours worked. Every hour total uses this rule:
   the payroll week, the timecard's saved hours, the Gusto sync, job costing and tip splits on the server, and the Hub's
   own copies in employee-suite.js (breakMinutes) and employee-timecard-correct.js. */
export const PAID_BREAK_MAX_MS = 20 * 60000;
export const paidBreak = (item, from = Date.parse(item?.startAt), to = Date.parse(item?.endAt)) =>
  item?.kind === 'rest' || item?.kind !== 'meal' && to - from <= PAID_BREAK_MAX_MS;
