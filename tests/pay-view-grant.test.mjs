// PAY-VIEW-GRANT: EGC_STAFF_PAY_VIEWERS lets the owner show other employees' pay to named business accounts while pay
// stays owner-only for everyone else. Viewing only: setting pay, moving pay, the payroll CSV, the Gusto file and job labor
// dollars stay the owner's. Synthetic accounts and canary rates only.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoOthersPay, assertPayUnchanged, canSetPay, payViewGranted, seesLaborCost, seesOthersPay, timesheetPayView, visiblePay } from '../functions/_lib/pay-visibility.js';
import { computeTimesheetWeek, ptoFromRequests } from '../functions/_lib/timesheet-week.js';
import { timesheetHandlers } from '../functions/api/timesheets.js';

const OWNER = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const LEAD = { user: 'TylerG', displayName: 'Synthetic Team Lead', role: 'manager', businessAccess: true };
const OTHER = { user: 'AlexK', displayName: 'Synthetic Manager', role: 'crew_lead', businessAccess: true };
const CREW = { user: 'Crew.One', displayName: 'Synthetic Crew', role: 'crew' };
const GRANT = { EGC_STAFF_PAY_VIEWERS: ' tylerg , crew.one ' };
const NOW = new Date('2026-10-05T18:00:00.000Z');
const at = (date, time) => `${date}T${time}:00-06:00`;
const card = (id, employee, date, rate) => ({ id, employee, employeeName: `Synthetic ${employee}`, payType: 'hourly', hourlyRate: rate, clockInAt: at(date, '08:00'), clockOutAt: at(date, '12:00'), status: 'submitted', approvalStatus: 'approved', breaks: [] });
const CARDS = [card('a', 'Crew.One', '2026-09-21', 37.13), card('b', 'TylerG', '2026-09-22', 41.23), card('c', 'AlexK', '2026-09-23', 43.29)];
const week = () => computeTimesheetWeek({ timecards: CARDS, pto: ptoFromRequests([]), weekStart: '2026-09-21', now: NOW.toISOString() });
const get = async (session, query, env) => {
  const response = await timesheetHandlers({ session: async () => session, read: async () => ({ timecards: CARDS, requests: [] }), now: () => NOW }).get({ request: new Request(`https://easygaragecleaning.com/api/timesheets${query}`), env });
  return { status: response.status, text: await response.text() };
};

test('a listed business account sees other employees\' pay; unlisted managers, unlisted names and crew do not', () => {
  assert.equal(payViewGranted(LEAD, GRANT), true, 'names are matched without case or spaces');
  assert.equal(seesOthersPay(LEAD, GRANT), true);
  assert.equal(seesOthersPay(OTHER, GRANT), false, 'another manager keeps the owner-only rule');
  assert.equal(seesOthersPay(CREW, GRANT), false, 'a listed account without business access gets nothing');
  assert.equal(seesOthersPay(LEAD, {}), false, 'unset: only the owner');
  assert.equal(payViewGranted(LEAD, { ...GRANT, EGC_STAFF_PAY_OWNER_ONLY: 'false' }), false, 'the list does nothing with the flag off');
  const timecard = card('x', 'Crew.One', '2026-09-21', 37.13);
  assert.equal(visiblePay(LEAD, GRANT, 'timeEntries', timecard).hourlyRate, 37.13);
  assert.equal(visiblePay(OTHER, GRANT, 'timeEntries', timecard).hourlyRate, undefined);
});

test('the grant is viewing only: no pay change, no pay move, no labor dollars', () => {
  assert.equal(canSetPay(LEAD, GRANT), false);
  assert.equal(seesLaborCost(LEAD, GRANT), false, 'job labor dollars stay with whoever sets pay');
  assert.throws(() => assertNoOthersPay(LEAD, GRANT, 'timeEntries', { hourlyRate: 50 }), { code: 'pay_owner_only' });
  assert.throws(() => assertNoOthersPay(LEAD, GRANT, 'timeEntries', { approvalStatus: 'approved' }, { moved: true }), { code: 'pay_owner_only' });
  assert.throws(() => assertPayUnchanged(LEAD, GRANT, { hourlyRate: 99 }, { hourlyRate: 41.23 }), { code: 'pay_owner_only' });
  assert.equal(canSetPay(OWNER, GRANT), true, 'the owner is unchanged');
});

test('/api/timesheets: the listed account gets the owner\'s week, but never the payroll CSV or the Gusto file', async () => {
  const owner = await get(OWNER, '?view=week&start=2026-09-21', GRANT), lead = await get(LEAD, '?view=week&start=2026-09-21', GRANT), other = await get(OTHER, '?view=week&start=2026-09-21', GRANT);
  assert.equal(lead.status, 200);
  assert.equal(lead.text, owner.text, 'the same week the owner sees, pay included');
  assert.deepEqual(JSON.parse(lead.text), { ok: true, ...timesheetPayView(OWNER, GRANT, week()) });
  assert.equal(JSON.parse(other.text).payVisibility, 'own', 'an unlisted manager still sees only their own pay');
  for (const query of ['?view=week&start=2026-09-21&format=csv', '?view=week&start=2026-09-21&format=gusto']) {
    const refused = await get(LEAD, query, GRANT);
    assert.deepEqual([refused.status, JSON.parse(refused.text).code], [403, 'pay_owner_only'], query);
  }
});
