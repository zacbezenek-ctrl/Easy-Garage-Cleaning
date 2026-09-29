import { addDays, validDate } from './dispatch-time.js';

// The one paid-time-off model, shared by the request workflow (employee-pto.js) and
// payroll (timesheet-week.js). An approval made through /api/employee-pto records paid
// (a boolean), hoursPerDay and paidDates, and a later amend replaces them; those fields
// alone decide pay. Other approvals pay only a manager-set paidHoursPerDay (and
// optionally paidWeekends), the rule payroll used before the workflow. Without paidDates
// the paid days are the requested Denver days except Saturday and Sunday, and an early
// end (endedEarlyFrom) pays only the days before the first day back.
export const PTO_MAX_DAYS = 31;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** True when the latest approve or amend decision set the terms of this approved request. The
 * workflow writes that decision with reviewedBy/reviewedAt; a browser-era approval overwrote
 * reviewedAt, so pay fields or decisions an employee wrote into an older request never match. */
export function ptoWorkflowApproved(request) {
  const last = (Array.isArray(request?.decisions) ? request.decisions : []).filter(entry => record(entry) && ['approve','amend'].includes(entry.action) && entry.status === 'approved').at(-1);
  return Boolean(last) && typeof last.at === 'string' && last.at !== '' && last.at === request.reviewedAt && typeof last.by === 'string' && last.by === request.reviewedBy;
}
export const ptoWeekday = date => new Date(`${date}T12:00:00Z`).getUTCDay() % 6 !== 0;
export const validPtoHours = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 12 && Number.isInteger(value * 4);
const payableHours = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24;

/** Requested Denver days, or [] when the dates are invalid or span more than `max` days. */
export function ptoDays(startDate, endDate, max = PTO_MAX_DAYS) {
  if (!validDate(startDate) || !validDate(endDate) || endDate < startDate || Date.parse(endDate) - Date.parse(startDate) >= max * 86400000) return [];
  const days = []; for (let date = startDate; date <= endDate; date = addDays(date, 1)) days.push(date);
  return days;
}

/** The days one time-off request pays, whatever its status: null when it pays nothing, else
 * {model, hours, dates}. A request that is not approved shows the terms it asks for; payroll
 * pays approved requests only. hours is the stored value as-is so payroll can send a bad one to
 * review; review:true (with the first readable date) marks dates or terms that cannot be read. */
export function ptoPaidDays(request) {
  if (!record(request) || request.type !== 'time_off') return null;
  const cutoff = validDate(request.endedEarlyFrom) ? request.endedEarlyFrom : '', first = validDate(request.startDate) ? request.startDate : '';
  const review = (model, hours) => ({ model, hours, dates: [], review: true, date: first });
  if (typeof request.paid === 'boolean' && (request.status !== 'approved' || ptoWorkflowApproved(request))) {
    if (!request.paid) return null;
    const days = ptoDays(request.startDate, request.endDate || request.startDate);
    if (!days.length || !validPtoHours(request.hoursPerDay) || request.paidDates !== undefined && !Array.isArray(request.paidDates)) return review('workflow', request.hoursPerDay);
    const listed = Array.isArray(request.paidDates) ? new Set(request.paidDates) : null;
    return { model: 'workflow', hours: request.hoursPerDay, dates: days.filter(date => (listed ? listed.has(date) : ptoWeekday(date)) && (!cutoff || date < cutoff)), review: false };
  }
  const hours = request.paidHoursPerDay;
  if (hours === undefined || hours === null || hours === '') return null;
  const days = ptoDays(request.startDate, request.endDate || request.startDate);
  if (!days.length) return review('legacy', hours);
  return { model: 'legacy', hours, dates: days.filter(date => (request.paidWeekends === true || ptoWeekday(date)) && (!cutoff || date < cutoff)), review: false };
}

/** What a request pays as the Requests board shows it: unreadable terms pay nothing here and
 * are left to payroll review. */
export function ptoPay(request) {
  const pay = ptoPaidDays(request);
  if (!pay || pay.review || !payableHours(pay.hours)) return { paid: false, hoursPerDay: null, paidDays: [], paidHours: 0, payModel: pay?.model || null };
  return { paid: true, hoursPerDay: pay.hours, paidDays: pay.dates.map(date => ({ date, hours: pay.hours })), paidHours: pay.dates.length * pay.hours, payModel: pay.model };
}
