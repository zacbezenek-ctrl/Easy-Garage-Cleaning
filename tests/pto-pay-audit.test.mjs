import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, planPtoPayAudit, runPtoPayAudit } from '../scripts/pto-pay-audit.mjs';

const NOW = '2026-09-28T12:00:00.000Z', AT = '2026-09-20T15:00:00.000Z';
const base = { type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-25', endDate: '2026-09-28', reason: 'Synthetic private reason', reviewedBy: 'zacb', reviewedAt: '2026-09-15T10:00:00.000Z' };
// What the workflow writes: the terms, and a decision whose by/at are the request's reviewedBy/reviewedAt.
const workflow = (row, terms, action = 'approve') => ({ ...row, ...terms, reviewedBy: 'zacb', reviewedAt: AT, decisions: [...(row.decisions || []), { action, status: 'approved', by: 'zacb', at: AT, note: 'Synthetic note', ...terms }] });

test('lists approved time off whose pay fields no workflow decision set, and pay that holds payroll in review', () => {
  const crafted = { ...base, id: 'crafted', paid: true, hoursPerDay: 12, paidDates: ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'], decisions: [{ action: 'approve', status: 'approved', by: 'zacb', at: '2026-09-01T00:00:00.000Z' }] };
  const requests = [crafted, { ...base, id: 'older', paidHoursPerDay: 8, paidWeekends: true }, { ...base, id: 'older-bad', paidHoursPerDay: 'eight', hoursPerDay: null },
    { ...base, id: 'bad-dates', startDate: '2026-09-28', endDate: '2026-09-25', paidHoursPerDay: 8 }, workflow({ ...base, id: 'workflow' }, { paid: true, hoursPerDay: 8, paidDates: ['2026-09-25'] }),
    workflow({ ...base, id: 'workflow-bad', startDate: 'soon' }, { paid: true, hoursPerDay: 8 }), { ...base, id: 'browser-era' }, { ...base, id: 'ended', paidHoursPerDay: 8, endedEarlyFrom: '2026-09-28' },
    { ...base, id: 'pending', status: 'pending', paid: true, hoursPerDay: 8 }, { ...base, id: 'shift', type: 'shift_change', paid: true }, null, 'junk'];
  const report = planPtoPayAudit(requests, NOW);
  assert.deepEqual([report.mode, report.generatedAt, report.scanned, report.approvedTimeOff, report.workflowApproved], ['read_only', NOW, 12, 8, 2]);
  assert.deepEqual(report.unboundPayFields.map(row => [row.id, row.fields, row.payroll]), [
    ['bad-dates', ['paidHoursPerDay'], { model: 'legacy', review: true }],
    ['crafted', ['paid', 'hoursPerDay', 'paidDates'], { model: null, paidHours: 0, paidDates: [] }],
    ['ended', ['paidHoursPerDay'], { model: 'legacy', hoursPerDay: 8, paidHours: 8, paidDates: ['2026-09-25'] }],
    ['older', ['paidHoursPerDay', 'paidWeekends'], { model: 'legacy', hoursPerDay: 8, paidHours: 32, paidDates: ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'] }],
    ['older-bad', ['paidHoursPerDay'], { model: 'legacy', review: true }]]);
  assert.deepEqual(report.blocksPayroll.map(row => [row.id, row.payroll.model]), [['bad-dates', 'legacy'], ['older-bad', 'legacy'], ['workflow-bad', 'workflow']]);
  assert.deepEqual(report.unboundPayFields.find(row => row.id === 'ended'), { id: 'ended', employee: 'crew.one', startDate: '2026-09-25', endDate: '2026-09-28', endedEarlyFrom: '2026-09-28', fields: ['paidHoursPerDay'], payroll: { model: 'legacy', hoursPerDay: 8, paidHours: 8, paidDates: ['2026-09-25'] } });
  assert.doesNotMatch(JSON.stringify(report), /Synthetic (private reason|note)/);
  // Once a manager changes the pay in the Hub, the request drops out of both lists.
  const fixed = planPtoPayAudit([workflow(crafted, { paid: true, hoursPerDay: 8, paidDates: ['2026-09-25'] }, 'amend'), workflow({ ...base, id: 'older-bad', paidHoursPerDay: 'eight' }, { paid: false }, 'amend')], NOW);
  assert.deepEqual([fixed.workflowApproved, fixed.unboundPayFields, fixed.blocksPayroll], [2, [], []]);
});

test('reads the whole requests family, refuses to run unconfigured or on an incomplete read, and has no write mode', async () => {
  const env = { FIREBASE_API_KEY: 'firebase-test-pto-audit', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-pto-audit-vault-secret' }, calls = [];
  const report = await runPtoPayAudit(env, { read: async (...args) => { calls.push(args); return [{ ...base, id: 'older', paidHoursPerDay: 8 }]; }, now: NOW });
  assert.deepEqual(calls, [[env, 'requests']]); assert.deepEqual(report.unboundPayFields.map(row => row.id), ['older']);
  await assert.rejects(runPtoPayAudit({ FIREBASE_API_KEY: 'firebase-test-pto-audit' }, { read: async () => [], now: NOW }), error => error.code === 'pto_pay_audit_unconfigured');
  await assert.rejects(runPtoPayAudit(env, { read: async () => ({ requests: [] }), now: NOW }), error => error.code === 'pto_pay_audit_input_invalid');
  await assert.rejects(runPtoPayAudit(env, { read: async () => { throw Object.assign(new Error('unreadable'), { code: 'EMPLOYEE_HUB_STORAGE_UNREADABLE' }); }, now: NOW }), error => error.code === 'EMPLOYEE_HUB_STORAGE_UNREADABLE');
  assert.deepEqual(parseArgs([]), { report: '', help: false });
  assert.deepEqual(parseArgs(['--dry-run', '--report', 'out.json']), { report: 'out.json', help: false });
  assert.throws(() => parseArgs(['--apply']), /read-only/);
  assert.throws(() => parseArgs(['--report']), /Unknown or incomplete argument/);
});
