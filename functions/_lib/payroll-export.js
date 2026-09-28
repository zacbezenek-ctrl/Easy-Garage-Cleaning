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
