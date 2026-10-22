// FIELD-FLAGS: the late / not-en-route / not-clocked-in rule for today's jobs. The rule lives in
// /employee-arrival-deadline.js so the Hub runs the same file as a classic script; importing it here runs it once and
// it leaves its frozen, pure API on globalThis.
// flags() indexes timeEntries once per array identity and Denver day (clockIns): a caller that adds entries must pass a
// new array, never push onto the one it passed before, or the new clock-ins are not seen.
import '../../employee-arrival-deadline.js';

const rule = globalThis.EGCArrivalDeadline;
export const { flags, underway, visitRow, arrivalDeadline, enRouteDeadline, startAt, denverDate, denverInstant, LATE_GRACE_MS, EN_ROUTE_LEAD_MS } = rule;
