// NO-SELF-APPROVAL: whoever approves time never approves, rejects, reviews or corrects their own timecard; another
// manager or the owner does. The configured owner is the one exception. Synthetic accounts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTimecard, correctTimecard } from '../functions/_lib/employee-timecards.js';

const OWNER = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const MANAGER = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const card = employee => ({ id: `card-${employee}`, employee, employeeName: employee, clockInAt: '2026-09-22T14:00:00.000Z', clockOutAt: '2026-09-22T18:00:00.000Z', breaks: [], status: 'submitted', approvalStatus: 'pending', hourlyRate: 0 });
const save = (session, existing, incoming) => authorizeTimecard({ session, manager: true, id: existing.id, existing, incoming, now: '2026-09-22T20:00:00.000Z' });
const refused = error => error.status === 403 && error.code === 'EMPLOYEE_TIMECARD_SELF_APPROVAL' && /someone else/i.test(error.message);

test('a manager cannot approve, reject or clear the device-time review of their own timecard', () => {
  for (const incoming of [{ approvalStatus: 'approved' }, { approvalStatus: 'rejected' }]) assert.throws(() => save(MANAGER, card('TylerG'), incoming), refused, JSON.stringify(incoming));
  assert.throws(() => save(MANAGER, { ...card('TylerG'), deviceTime: true, needsReview: true }, { deviceTimeReviewed: true }), refused);
  // The name is compared without case, so a differently typed username is still the same person.
  assert.throws(() => save(MANAGER, card('tylerg'), { approvalStatus: 'approved' }), refused);
});

test('a manager still approves other people, and the owner approves anyone including themselves', () => {
  assert.equal(save(MANAGER, card('Crew.One'), { approvalStatus: 'approved' }).approvedBy, 'TylerG');
  assert.equal(save(OWNER, card('zacb'), { approvalStatus: 'approved' }).approvedBy, 'zacb');
  assert.equal(save(OWNER, card('TylerG'), { approvalStatus: 'approved' }).approvedBy, 'zacb');
  // A manager's other saves to their own card (a note, as before) are unchanged.
  assert.equal(save(MANAGER, card('TylerG'), { notes: 'Synthetic note' }).notes, 'Synthetic note');
});

test('a manager cannot correct or close their own timecard; corrections of others are unchanged', () => {
  const env = { EGC_TIMECARD_CORRECTIONS: 'true' };
  const correct = (session, existing) => correctTimecard({ session, manager: true, existing, incoming: { correction: { requestId: crypto.randomUUID(), kind: 'correct', reason: 'Synthetic reason', expectedUpdatedAt: '' } }, now: '2026-09-22T20:00:00.000Z', env });
  assert.throws(() => correct(MANAGER, card('TylerG')), refused);
  assert.throws(() => correct(MANAGER, card('Crew.One')), error => !refused(error), 'another employee\'s card goes on to the usual correction checks');
});
