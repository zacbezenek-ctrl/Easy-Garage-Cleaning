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

// Review findings on #175: an approved card of one's own could be edited and re-approved in the same save, or moved to
// someone else and back with an approval each way.
test('a manager cannot inflate their own approved card by resending the approval with an edit', () => {
  const approved = { ...card('TylerG'), breaks: [{ startAt: '2026-09-22T16:00:00.000Z', endAt: '2026-09-22T17:00:00.000Z' }], approvalStatus: 'approved', approvedAt: '2026-09-22T19:00:00.000Z', approvedBy: 'zacb' };
  for (const incoming of [{ clockOutAt: '2026-09-23T02:00:00.000Z', approvalStatus: 'approved' }, { breaks: [], approvalStatus: 'approved' } /* drops the hour-long break */, { clockOutAt: '2026-09-23T02:00:00.000Z', approvalStatus: 'rejected' }])
    assert.throws(() => save(MANAGER, approved, incoming), refused, JSON.stringify(incoming));
  // An edit without a status returns their own card to pending for someone else to decide.
  const edited = save(MANAGER, approved, { clockOutAt: '2026-09-23T02:00:00.000Z' });
  assert.deepEqual([edited.approvalStatus, edited.approvedAt, edited.approvedBy], ['pending', '', '']);
  // Repeating the stored status with nothing else changed is a no-op: it is not re-stamped as theirs.
  const repeated = save(MANAGER, approved, { approvalStatus: 'approved' });
  assert.deepEqual([repeated.approvalStatus, repeated.approvedBy, repeated.approvedAt], ['approved', 'zacb', '2026-09-22T19:00:00.000Z']);
  // The owner editing and approving a manager's card in one save is unchanged.
  assert.equal(save(OWNER, approved, { clockOutAt: '2026-09-23T02:00:00.000Z', approvalStatus: 'approved' }).approvedBy, 'zacb');
});

test('a manager cannot approve their own card by moving it to someone else and back', () => {
  const own = card('TylerG');
  assert.throws(() => save(MANAGER, own, { employee: 'Crew.One', approvalStatus: 'approved' }), refused, 'moving away with an approval');
  const moved = save(MANAGER, own, { employee: 'Crew.One' });
  assert.throws(() => save(MANAGER, moved, { employee: 'TylerG', approvalStatus: 'approved' }), refused, 'moving back with an approval');
  const approvedOwn = { ...own, approvalStatus: 'approved', approvedBy: 'zacb', approvedAt: '2026-09-22T19:00:00.000Z' };
  assert.equal(save(MANAGER, approvedOwn, { employee: 'Crew.One' }).approvalStatus, 'pending', 'moving an approved card of one\'s own away undoes the approval');
});
