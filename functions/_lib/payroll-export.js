// Same spreadsheet formula-injection guard as employee-suite.js csvCell, extended to tab/CR-led cells.
export const csvCell = value => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
};

export const csvRows = rows => rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

const PAYROLL_HEADER = ['Employee name', 'Employee username', 'Week start', 'Week end', 'Overtime policy', 'Regular hours', 'Overtime hours', 'Double-time hours', 'Paid time off hours', 'Total paid hours',
  'Regular rate', 'Straight-time pay', 'Overtime premium', 'Paid time off pay', 'Bonus', 'Tips', 'Gross pay', 'Overtime basis', 'Approved timecards', 'Pending timecards included', 'Review flags', 'Job time'];

/** The week's worked time by job, from the crew's job segments: work and travel per job, then general company time,
 * shifts whose segments need a manager's review (the Hub's wording) and time with no job segments. It explains the
 * hours; pay is still the hour columns above. */
export function jobTimeText(time) {
  const fixed = value => `${Number(value || 0).toFixed(3)} h`, parts = [];
  for (const job of time?.jobs || []) parts.push(`${job.jobLabel || `Job ${job.jobId}`}: work ${fixed(job.workHours)}${job.travelHours ? `, travel ${fixed(job.travelHours)}` : ''}`);
  if (time?.generalHours) parts.push(`General company time ${fixed(time.generalHours)}`);
  if (time?.reviewHours) parts.push(`Job time needs manager review ${fixed(time.reviewHours)}`);
  if (time?.untrackedHours) parts.push(`No job segments ${fixed(time.untrackedHours)}`);
  return parts.join('; ');
}

export const payrollCsvFilename = week => `egc-payroll-${week.weekStart}-to-${week.weekEnd}.csv`;

/** One row per employee-week from computeTimesheetWeek. Pay is straight time for every worked hour at its
 * snapshotted rate plus the overtime premium, so Straight-time + Overtime premium + PTO pay + Bonus + Tips = Gross pay. */
export function payrollCsv(week) {
  const fixed = (value, digits) => Number(value || 0).toFixed(digits);
  return csvRows([PAYROLL_HEADER, ...week.employees.map(row => [row.name, row.employee, week.weekStart, week.weekEnd, week.policy.name,
    fixed(row.regularHours, 3), fixed(row.overtimeHours, 3), fixed(row.doubleTimeHours, 3), fixed(row.ptoHours, 3), fixed(row.totalPaidHours, 3),
    fixed(row.regularRate, 4), fixed(row.straightPay, 2), fixed(row.overtimePremium, 2), fixed(row.ptoPay, 2), fixed(row.bonus, 2), fixed(row.tips, 2), fixed(row.grossPay, 2), row.overtimeBasis,
    row.approvedTimecards, row.pendingTimecards, row.flags.join(' '), jobTimeText(row.jobTime)])]);
}

// Gusto's hours import (GUSTO-EXPORT, OPS-13). Gusto offers its API only to approved App Integrations (docs/gusto-sync.md),
// so an approved week reaches Gusto as a file the owner imports. Neither docs/gusto-sync.md nor anything else in this repo
// documents Gusto's hours-import template, so these headers are EGC's reading of it, not Gusto's confirmed layout. OWNER
// ITEM (docs/OWNER-GO-LIVE-CHECKLIST.md): download Gusto's hours-import template once, compare its headers with these and,
// if they differ, change them here. This constant is the whole column layout: each entry is [header, the export row field
// that fills it], in file order, and gustoHoursFile writes nothing else.
export const GUSTO_HOURS_COLUMNS = Object.freeze([
  ['Gusto employee ID', 'gustoEmployeeId'],
  ['Employee name', 'name'],
  ['Regular hours', 'regularHours'],
  ['Overtime hours', 'overtimeHours'],
  ['Double overtime hours', 'doubleTimeHours'],
  ['Paid time off hours', 'ptoHours'],
].map(column => Object.freeze(column)));

export const gustoHoursFilename = week => `egc-gusto-hours-${week.weekStart}-to-${week.weekEnd}.csv`;
const gustoFail = (message, code, details) => Object.assign(new Error(message), { code, status: 409, details });
const named = rows => rows.map(row => `${row.name} (${row.employee})`).join(', ');
// Engine hours are exact thousandths; this rounds one to whole hundredths, half up.
const hundredths = value => Math.round(Math.round(Number(value || 0) * 1000) / 10);

/** The Gusto hours file of a settled computeTimesheetWeek week: { rows, csv, notInGusto }. profiles is staff-directory.js
 * gustoPayrollProfiles (username to { gustoEmployeeId, gustoExcluded, displayName }). One row per employee with hours,
 * keyed by their Gusto employee ID. The hours are the payroll engine's, as the payroll CSV has them: its overtime
 * (Colorado or federal, never recomputed here), double time and approved paid time off. Overtime, double time and paid
 * time off are rounded to the hundredth, and regular hours are the worked hours to the hundredth less overtime and double
 * time, so a row's worked hours match the payroll CSV's rounded total. Someone the owner marked not paid through Gusto is
 * left out and listed in notInGusto ({ employee, name }). An employee without an ID, or two in the file with one ID, stop
 * the file (409) and are named. Rows with no hours are left out. The name is the timecards' (the payroll CSV's), or the
 * profile's display name when the week has only the username, as for someone with paid time off and no timecard. */
export function gustoHoursFile(week, profiles) {
  const people = week.employees.map(row => {
    const profile = profiles.get(row.employee) || {}, overtime = hundredths(row.overtimeHours), doubleTime = hundredths(row.doubleTimeHours);
    const name = profile.displayName && String(row.name).trim().toLowerCase() === row.employee ? profile.displayName : row.name;
    return { employee: row.employee, name, gustoEmployeeId: profile.gustoEmployeeId || '', excluded: profile.gustoExcluded === true, worked: hundredths(row.workedHours), overtime, doubleTime, pto: hundredths(row.ptoHours) };
  }).filter(row => row.worked || row.pto);
  const rows = people.filter(row => !row.excluded), notInGusto = people.filter(row => row.excluded).map(({ employee, name }) => ({ employee, name }));
  const missing = rows.filter(row => !row.gustoEmployeeId);
  if (missing.length) throw gustoFail(`Add the Gusto employee ID for ${named(missing)} in the staff directory (Team), or mark them not paid through Gusto there, before downloading the Gusto hours file. Former employees are listed under Former staff at the end of the directory.`, 'timesheet_gusto_id_missing', { missing: missing.map(({ employee, name }) => ({ employee, name })) });
  const byId = new Map();
  for (const row of rows) byId.set(row.gustoEmployeeId.toLowerCase(), [...byId.get(row.gustoEmployeeId.toLowerCase()) || [], row]);
  const shared = [...byId.values()].filter(list => list.length > 1).flat();
  if (shared.length) throw gustoFail(`${named(shared)} have the same Gusto employee ID. Give each employee their own in the staff directory (Team) before downloading the Gusto hours file.`, 'timesheet_gusto_id_conflict', { shared: shared.map(({ employee, name }) => ({ employee, name })) });
  const fixed = value => (value / 100).toFixed(2);
  const lines = rows.map(row => ({ gustoEmployeeId: row.gustoEmployeeId, name: row.name, regularHours: fixed(row.worked - row.overtime - row.doubleTime), overtimeHours: fixed(row.overtime), doubleTimeHours: fixed(row.doubleTime), ptoHours: fixed(row.pto) }));
  return { rows: lines, csv: csvRows([GUSTO_HOURS_COLUMNS.map(([header]) => header), ...lines.map(row => GUSTO_HOURS_COLUMNS.map(([, field]) => row[field]))]), notInGusto };
}
export const gustoHoursRows = (week, profiles) => gustoHoursFile(week, profiles).rows;
export const gustoHoursCsv = (week, profiles) => gustoHoursFile(week, profiles).csv;
// The response header that lists who was left out as not paid through Gusto: URI-encoded JSON of notInGusto, so any name
// fits a header. The Hub shows it after the download.
export const GUSTO_NOT_INCLUDED_HEADER = 'X-EGC-Gusto-Not-Included';

const TIP_HEADER = ['Employee name', 'Employee username', 'Tips received from', 'Tips received through', 'Job ID', 'Customer', 'Service date', 'Job work minutes', 'Employee work minutes', 'Job card tips', 'Employee tip share', 'Review flags'];
const lastDay = end => new Date(Date.parse(`${end}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

export const customerTipsCsvFilename = allocation => `egc-customer-tips-${allocation.start}-to-${lastDay(allocation.end)}.csv`;

/** Customer card tips for payroll, one row per employee share of a job's tips (computeTipAllocation). Tips on a job
 * with no recorded work time, or with crew time not tracked to it (untracked_job_time: every share is 0.00 and the
 * tracked minutes are listed), are an unassigned row so a manager pays them by hand, never silently dropped. */
export function customerTipsCsv(allocation) {
  const dollars = cents => (cents / 100).toFixed(2), through = lastDay(allocation.end), rows = [];
  for (const job of allocation.jobs) {
    const base = [allocation.start, through, job.jobId, job.customer, job.serviceDate, job.workMinutes];
    for (const share of job.employees) rows.push([share.name, share.employee, ...base, share.minutes, dollars(job.tipCents), dollars(share.tipCents), job.reasons.join(' ')]);
    if (job.unallocatedCents) rows.push(['Unassigned - pay by hand', '', ...base, 0, dollars(job.tipCents), dollars(job.unallocatedCents), job.reasons.join(' ')]);
  }
  return csvRows([TIP_HEADER, ...rows]);
}
