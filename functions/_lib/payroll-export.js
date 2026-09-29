// Same spreadsheet formula-injection guard as employee-suite.js csvCell, extended to tab/CR-led cells.
export const csvCell = value => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
};

export const csvRows = rows => rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

const PAYROLL_HEADER = ['Employee name', 'Employee username', 'Week start', 'Week end', 'Overtime policy', 'Regular hours', 'Overtime hours', 'Double-time hours', 'Paid time off hours', 'Total paid hours',
  'Regular rate', 'Straight-time pay', 'Overtime premium', 'Paid time off pay', 'Bonus', 'Tips', 'Gross pay', 'Overtime basis', 'Approved timecards', 'Pending timecards included', 'Review flags'];

export const payrollCsvFilename = week => `egc-payroll-${week.weekStart}-to-${week.weekEnd}.csv`;

/** One row per employee-week from computeTimesheetWeek. Pay is straight time for every worked hour at its
 * snapshotted rate plus the overtime premium, so Straight-time + Overtime premium + PTO pay + Bonus + Tips = Gross pay. */
export function payrollCsv(week) {
  const fixed = (value, digits) => Number(value || 0).toFixed(digits);
  return csvRows([PAYROLL_HEADER, ...week.employees.map(row => [row.name, row.employee, week.weekStart, week.weekEnd, week.policy.name,
    fixed(row.regularHours, 3), fixed(row.overtimeHours, 3), fixed(row.doubleTimeHours, 3), fixed(row.ptoHours, 3), fixed(row.totalPaidHours, 3),
    fixed(row.regularRate, 4), fixed(row.straightPay, 2), fixed(row.overtimePremium, 2), fixed(row.ptoPay, 2), fixed(row.bonus, 2), fixed(row.tips, 2), fixed(row.grossPay, 2), row.overtimeBasis,
    row.approvedTimecards, row.pendingTimecards, row.flags.join(' ')])]);
}

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
