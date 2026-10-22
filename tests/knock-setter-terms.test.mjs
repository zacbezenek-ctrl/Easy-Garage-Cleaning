// R8 / D6b: the owner approves the 13% setter + 7% estimator terms (setter.approve); until then every setter and
// estimator share stays held exactly as before. Once approved, a closed job paid in full makes both shares earned and
// payable through the commission statement (Admin > Money, its CSV and the rep's My money). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTER_CONTRACT, SETTER_TERMS, commissionCsv, periodStatement, setterRuleText, SETTER_RULE_TEXT } from '../crew/knock-money.js';
import { loadSettings, loadSetterTerms, setterTermsState } from '../functions/_lib/knock-access.js';
import { approveSetterTerms } from '../functions/_lib/knock-admin.js';
import { classifySetter, projectSetterAttribution } from '../functions/_lib/knock-setters.js';
import { commissionAllocations } from '../functions/_lib/knock-allocations.js';
import { addPayout } from '../functions/_lib/knock-reports.js';
import { createKnockStore } from '../functions/_lib/knock-store.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { knockReportsHandlers } from '../functions/api/knock-reports.js';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { approvedKnockSettings, call, cookieFor, get, knockEnv, post, uuid } from './helpers/knock-fixture.mjs';

const NOW = '2026-10-21T18:00:00.000Z', APPROVED_AT = '2026-10-20T16:00:00.000Z';
const env = knockEnv({ HUB_AUTH_USERS_JSON: JSON.stringify({
  ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Zac' },
  TylerG: { passwordHash: 'test', role: 'manager', displayName: 'Tyler' },
  'Rep.One': { passwordHash: 'test', role: 'sales', displayName: 'Rep One' },
  'Estimator.One': { passwordHash: 'test', role: 'sales', displayName: 'Estimator One' },
  'Estimator.Two': { passwordHash: 'test', role: 'sales', displayName: 'Estimator Two' },
}) });
const owner = { user: 'ZacB', role: 'owner', businessAccess: true }, office = { user: 'TylerG', role: 'manager', businessAccess: true };
const setterApproval = (extra = {}) => ({ contract: SETTER_CONTRACT, reference: 'synthetic-d6b-record', reviewedBy: 'ZacB', reviewedAt: APPROVED_AT, terms: { ...SETTER_TERMS }, ...extra });
// The $3,000 job of the review's scenario: a rep set the walkthrough at the door, the estimator signed it, the customer
// paid in full by a verified card payment.
const paidJob = (id, walkthroughId, amount = 3000, extra = {}) => ({ type: 'job', status: 'scheduled', date: '2026-10-19', sourceWalkthroughId: walkthroughId,
  handoffVersion: 1, handoffRequestId: `req-${id}`, serviceType: 'Garage transformation', scope: { finish: ['cleanout', 'shelving'] }, customer: 'Synthetic Customer',
  estimate: { status: 'accepted', amount, acceptedAt: '2026-10-17T15:00:00Z' }, acceptance: { recordedBy: 'Estimator.One', acceptedAt: '2026-10-17T14:55:00Z' },
  payment: { amount, verified: true, stripeSessions: [{ sessionId: `cs_test_${id.replace(/-/g, "")}`, paymentIntentId: `pi_${id.replace(/-/g, "")}`, amount, purpose: 'balance', verifiedAt: '2026-10-19T20:00:00Z' }] }, ...extra });
const visit = (id, jobId) => ({ type: 'walkthrough', status: 'completed', convertedJobId: jobId, walkthroughOutcome: { outcome: 'sold_on_site' }, assignedCrew: ['estimator.one'] });
// What the Knock bridge records for a door walkthrough (knock-bridge.js recordD2dSetter).
const bridgeRow = (walkthroughId, extra = {}) => ({ walkthroughId, setterKey: 'rep.one', serviceClassification: 'unverified', classificationReference: '',
  estimatorKey: 'estimator.one', estimatorReference: 'knock-walkthrough:kw-1', channel: 'appointment_setter', requestId: 'kw-1', recordedBy: 'knock-bridge', recordedAt: '2026-10-16T18:00:00Z', source: 'knock_walkthrough', ...extra });

function world({ approved = true, settings = approvedKnockSettings(), seed = {} } = {}) {
  const fake = firestoreRest({
    'knock_settings/current': { ...settings, ...(approved ? { setterApproval: setterApproval() } : {}) },
    'knock_reps/rep.one': { repKey: 'rep.one', displayName: 'Rep One', status: 'active', role: 'knocker' },
    'knock_setters/walk-1': bridgeRow('walk-1'),
    'jobs/walk-1': visit('walk-1', 'job-1'), 'jobs/job-1': paidJob('job-1', 'walk-1'),
    // A walkthrough the estimator sold directly: no setter record.
    'jobs/walk-2': visit('walk-2', 'job-2'), 'jobs/job-2': paidJob('job-2', 'walk-2', 1234.56),
    'walkthroughHandoffs/r1': { actorId: 'Estimator.One', jobId: 'job-1', sourceWalkthroughId: 'walk-1', createdAt: '2026-10-17T15:00:00.000Z', signature: 'data:image/png;base64,AAAA', amountCents: 300000 },
    'walkthroughHandoffs/r2': { actorId: 'Estimator.One', jobId: 'job-2', sourceWalkthroughId: 'walk-2', createdAt: '2026-10-17T16:00:00.000Z', signature: 'data:image/png;base64,AAAA', amountCents: 123456 },
    'walkthroughHandoffs/release': { kind: 'prices_release', actorId: 'ZacB', jobId: 'job-2', createdAt: '2026-10-18T16:00:00.000Z' },
    ...seed,
  });
  return { fake, knock: () => createKnockStore(env, fake.fetcher), dispatch: () => dispatchStorage(env, fake.fetcher) };
}
// The dispatch roster (the staff an estimator or a payout may name), without the employee-account store.
const ROSTER = [{ id: 'estimator.one', name: 'Estimator One', role: 'sales' }, { id: 'estimator.two', name: 'Estimator Two', role: 'sales' }, { id: 'tylerg', name: 'Tyler', role: 'manager' }, { id: 'zacb', name: 'Zac', role: 'owner' }];
const admin = (w, clock = NOW) => knockAdminHandlers({ storage: () => w.knock(), dispatch: () => ({ ...w.dispatch(), roster: async () => ROSTER }), now: () => new Date(clock) });
const reports = (w, clock = NOW) => knockReportsHandlers({ storage: () => w.knock(), dispatch: () => w.dispatch(), now: () => new Date(clock) });
const as = async (user, request) => request(await cookieFor(env, user));

test('setter terms stay unapproved by default; only the owner approves them, after the door-to-door terms, and exactly as shown', async () => {
  const w = world({ approved: false });
  const settings = await loadSettings(w.knock());
  assert.equal((await loadSetterTerms(w.knock(), settings)).verified, false);
  const view = (await call(admin(w).get, await as('ZacB', cookie => get('/api/knock-admin?view=settings', cookie)), env)).body.setter;
  assert.deepEqual([view.verified, view.approval, view.canApprove, view.compensationVerified], [false, null, true, true]);
  assert.deepEqual(view.terms, { contract: SETTER_CONTRACT, ...SETTER_TERMS });
  assert.deepEqual([SETTER_TERMS.setterPercent, SETTER_TERMS.estimatorPercent, SETTER_TERMS.directEstimatorPercent], [13, 7, 7]);
  const body = { action: 'setter.approve', requestId: uuid(), contract: SETTER_CONTRACT, reference: 'synthetic-d6b-record', terms: { ...SETTER_TERMS } };
  for (const [user, code] of [['TylerG', 'knock_owner_required'], ['Rep.One', 'knock_admin_required']]) {
    const refused = await call(admin(w).post, await as(user, cookie => post('/api/knock-admin', body, cookie)), env);
    assert.deepEqual([refused.status, refused.body.code], [403, code]);
  }
  for (const [patch, code] of [[{ terms: { ...SETTER_TERMS, setterPercent: 12 } }, 'knock_approval_terms'], [{ terms: { ...SETTER_TERMS, extra: true } }, 'knock_approval_terms'],
    [{ contract: 'knock-collected-v3' }, 'knock_approval_contract'], [{ reference: 'x' }, 'knock_approval_reference']]) {
    await assert.rejects(approveSetterTerms(w.knock(), owner, { ...body, ...patch }, NOW), { code });
  }
  assert.equal(w.fake.get('knock_settings/current').setterApproval, undefined, 'nothing was written');
  // The door-to-door approval (and its pay cycle) comes first.
  const { compensationApproval, ...unapproved } = approvedKnockSettings();
  const early = world({ approved: false, settings: unapproved });
  await assert.rejects(approveSetterTerms(early.knock(), owner, body, NOW), { code: 'knock_compensation_unapproved' });
});

test('the owner approval records setterApproval and its receipt; retries are idempotent and a new reference keeps the approval time', async () => {
  const w = world({ approved: false });
  const body = { action: 'setter.approve', requestId: uuid(), contract: SETTER_CONTRACT, reference: 'synthetic-d6b-record', terms: { ...SETTER_TERMS } };
  const first = await call(admin(w, APPROVED_AT).post, await as('ZacB', cookie => post('/api/knock-admin', body, cookie)), env);
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.duplicate, first.body.referenceOnly, first.body.setter.verified, first.body.setter.approvedAt], [false, false, true, APPROVED_AT]);
  const stored = w.fake.get('knock_settings/current');
  assert.deepEqual({ ...stored.setterApproval }, setterApproval());
  assert.ok(stored.compensationApproval, 'the door-to-door approval beside it is untouched');
  assert.equal(w.fake.get(`knock_receipts/setter_terms_${body.requestId}`).kind, 'setter_terms_approval');
  const replay = await call(admin(w).post, await as('ZacB', cookie => post('/api/knock-admin', body, cookie)), env);
  assert.deepEqual([replay.status, replay.body.duplicate], [200, true]);
  const renamed = await approveSetterTerms(w.knock(), owner, { ...body, requestId: uuid(), reference: 'synthetic-d6b-record-2' }, NOW);
  assert.deepEqual([renamed.referenceOnly, renamed.setter.approvedAt], [true, APPROVED_AT]);
  await assert.rejects(approveSetterTerms(w.knock(), owner, { ...body, reference: 'something-else' }, NOW), { code: 'knock_approval_conflict' });
  // Saving settings that end the door-to-door approval ends this one with it.
  const settings = structuredClone(stored.settings); settings.commission.rate = 0.3;
  await call(admin(w).post, await as('ZacB', cookie => post('/api/knock-admin', { action: 'settings.update', settings }, cookie)), env);
  const after = w.fake.get('knock_settings/current');
  assert.ok(after.setterApproval, 'the approval record survives an unrelated settings save');
  assert.equal(setterTermsState(after, await loadSettings(w.knock())).verified, false);
});

test('a rep-set walkthrough paid in full: held with no amount before approval, $390 to the setter and $210 to the estimator after it', async () => {
  const before = (await call(admin(world({ approved: false })).get, await as('ZacB', cookie => get('/api/knock-admin?view=setters', cookie)), env)).body.rows[0];
  assert.deepEqual([before.state, before.earnedCommission, before.payableCommission, before.reviewReasons], ['review_required', null, null, ['service_scope_unverified']], 'exactly as before the approval');
  const data = (await call(admin(world()).get, await as('ZacB', cookie => get('/api/knock-admin?view=setters', cookie)), env)).body;
  const row = data.rows[0];
  assert.equal(data.policy.approval, 'approved');
  assert.deepEqual([row.state, row.serviceClassification, row.classificationEvidence, row.earnedCommission, row.payableCommission], ['earned', 'garage', 'signed_handoff', 390, 390]);
  assert.deepEqual(row.allocations.map(item => [item.role, item.repKey, item.amountCents]), [['setter', 'rep.one', 39000], ['estimator', 'estimator.one', 21000]]);
  assert.equal(row.qualifyingAt, '2026-10-19T20:00:00.000Z');
  assert.equal(row.earnedAt, APPROVED_AT, 'a job paid before the approval is earned at the approval, never in a closed period');
  // Junk, an unsettled classification without a signed garage handoff, a short payment and a refund stay held.
  const junk = projectSetterAttribution({ ...bridgeRow('walk-1'), serviceClassification: 'junk_removal' }, { ...visit('walk-1', 'job-1'), id: 'walk-1', revision: 'r' }, { ...paidJob('job-1', 'walk-1'), id: 'job-1', revision: 'r' }, [], Date.parse(NOW), { verified: true, approvedAt: APPROVED_AT, reference: 'x' });
  assert.deepEqual([junk.state, junk.earnedCommission], ['excluded', 0]);
  const terms = { verified: true, approvedAt: APPROVED_AT, reference: 'synthetic' }, w = { ...visit('walk-1', 'job-1'), id: 'walk-1', revision: 'r' };
  const project = job => projectSetterAttribution(bridgeRow('walk-1'), w, { ...job, id: 'job-1', revision: 'r' }, [], Date.parse(NOW), terms);
  assert.deepEqual([project(paidJob('job-1', 'walk-1', 3000, { serviceType: 'Junk removal' })).state, project(paidJob('job-1', 'walk-1', 3000, { serviceType: 'Junk removal' })).reviewReasons], ['review_required', ['service_scope_unverified']]);
  const short = paidJob('job-1', 'walk-1'); short.payment.amount = short.payment.stripeSessions[0].amount = 2000;
  assert.deepEqual([project(short).state, project(short).reviewReasons, project(short).projectedCommission], ['review_required', ['partial_collection_policy_unconfigured'], 390]);
  const refunded = paidJob('job-1', 'walk-1'); refunded.payment.refundedAmount = 50;
  assert.equal(project(refunded).earnedCommission, null);
  const unpaid = paidJob('job-1', 'walk-1'); delete unpaid.payment;
  assert.deepEqual([project(unpaid).state, project(unpaid).projectedCommission, project(unpaid).earnedCommission], ['awaiting_collection', 390, null], 'a closed job shows its projection');
});

test('rounding to the cent is part of the approved terms; without them a fractional share is still held', () => {
  const input = { channel: 'appointment_setter', jobId: 'job-1', serviceClassification: 'garage', setterKey: 'rep.one', estimatorKey: 'estimator.one', base: { verified: true, amountCents: 123456, reference: 'x' } };
  assert.ok(commissionAllocations(input).reviewReasons.includes('rounding_policy_unconfigured'));
  assert.deepEqual(commissionAllocations({ ...input, rounding: 'nearest_cent' }).allocations.map(item => item.amountCents), [16049, 8642]);
});

test('the statement pays both shares once approved: Admin > Money, the commission CSV and the rep\'s My money; before approval they are exactly as before', async () => {
  const money = async w => (await call(admin(w).get, await as('ZacB', cookie => get('/api/knock-admin?view=money&date=2026-10-21', cookie)), env)).body;
  const unapproved = await money(world({ approved: false }));
  assert.equal(unapproved.rates.setter, undefined, 'the rates reps and admins read are unchanged before approval');
  assert.ok(unapproved.statement.every(row => !Object.hasOwn(row, 'setterCommission')), 'the statement shape is unchanged before approval');
  const statement = (await money(world())).statement, byKey = Object.fromEntries(statement.map(row => [row.repKey, row]));
  assert.deepEqual([byKey['rep.one'].setterCommission, byKey['rep.one'].earnedCommission, byKey['rep.one'].payableCommission, byKey['rep.one'].compensationState], [390, 390, 390, 'configured']);
  // The estimator: 7% of the rep-set $3,000 job ($210) plus 7% of the directly sold $1,234.56 job ($86.42).
  assert.deepEqual([byKey['estimator.one'].estimatorCommission, byKey['estimator.one'].earnedCommission, byKey['estimator.one'].payableCommission], [296.42, 296.42, 296.42]);
  assert.equal(byKey['zacb'], undefined, 'a price release receipt is not a sale');
  const response = await admin(world()).get({ request: await as('ZacB', cookie => get('/api/knock-admin?view=export&kind=commission&date=2026-10-21', cookie)), env });
  assert.equal(response.status, 200);
  const exported = await response.text();
  const [header, ...lines] = exported.trim().split('\r\n');
  assert.match(header, /,setter_commission_included,estimator_commission_included$/);
  assert.ok(lines.some(line => line.includes(',rep.one,') && line.endsWith(',390.00,0.00')));
  assert.ok(lines.some(line => line.includes(',estimator.one,') && line.endsWith(',0.00,296.42')));
  const plain = await (await admin(world({ approved: false })).get({ request: await as('ZacB', cookie => get('/api/knock-admin?view=export&kind=commission&date=2026-10-21', cookie)), env })).text();
  assert.doesNotMatch(plain, /setter_commission/);
  // The rep's My money: their own 13% in the period it was earned, and on their walkthrough card; never the estimator's.
  const mine = (await call(reports(world()).get, await as('Rep.One', cookie => get('/api/knock-reports?view=my-money&date=2026-10-21', cookie)), env)).body;
  assert.deepEqual([mine.periods[0].setterCommission, mine.periods[0].earnedCommission, mine.rates.setter.verified], [390, 390, true]);
  assert.deepEqual([mine.setters.rows[0].state, mine.setters.rows[0].earnedCommission], ['earned', 390]);
  assert.deepEqual(mine.setters.rows[0].allocations.map(item => item.role), ['setter']);
  assert.doesNotMatch(JSON.stringify(mine), /estimator\.one|21000|210\b/);
  const held = (await call(reports(world({ approved: false })).get, await as('Rep.One', cookie => get('/api/knock-reports?view=my-money&date=2026-10-21', cookie)), env)).body;
  assert.deepEqual([held.periods[0].earnedCommission, Object.hasOwn(held.periods[0], 'setterCommission'), held.rates.setter, held.setters.rows[0].earnedCommission], [0, false, undefined, null]);
  assert.equal(setterRuleText(null), SETTER_RULE_TEXT);
  assert.match(setterRuleText({ verified: true }), /^13% to you .*the estimator gets 7% \(20% total\)/);
});

test('a setter record whose walkthrough cannot be read holds the approved statement instead of leaving its shares out', async () => {
  const w = world(), broken = () => { const store = w.dispatch(); return { ...store, readMany: async (collection, ids, fields) => { if (ids.includes('walk-1')) throw new Error('unavailable'); return store.readMany(collection, ids, fields); } }; };
  const handlers = knockAdminHandlers({ storage: () => w.knock(), dispatch: broken, now: () => new Date(NOW) });
  const statement = (await call(handlers.get, await as('ZacB', cookie => get('/api/knock-admin?view=money&date=2026-10-21', cookie)), env)).body.statement;
  assert.ok(statement.length && statement.every(row => row.payableCommission === null && row.reviewReasons.includes('setter_source_unavailable')), JSON.stringify(statement.map(row => [row.repKey, row.reviewReasons])));
});

test('periodStatement adds channel shares only in their period and holds every row when the records were not all read', () => {
  const settings = { commission: { verified: true }, payroll: {} }, period = { key: '2026-10-19_2026-11-01', start: '2026-10-19', end: '2026-11-01' };
  const channels = [{ repKey: 'rep.one', role: 'setter', amount: 390, earnedAt: Date.parse('2026-10-20T16:00:00Z') }, { repKey: 'est.one', role: 'estimator', amount: 210, earnedAt: Date.parse('2026-10-20T16:00:00Z'), name: 'Est One' },
    { repKey: 'est.two', role: 'estimator', amount: 70, earnedAt: Date.parse('2026-10-02T16:00:00Z') }];
  const rows = periodStatement({ reps: [{ repKey: 'rep.one', displayName: 'Rep One', status: 'active' }], settings, period, channels });
  assert.deepEqual(rows.map(row => [row.repKey, row.name, row.earned, row.setterCommission, row.estimatorCommission, row.payableCommission]), [['est.one', 'Est One', 210, 0, 210, 210], ['rep.one', 'Rep One', 390, 390, 0, 390]],
    'a share earned in another period is not in this one');
  const held = periodStatement({ reps: [], settings, period, channels, channelReview: ['setter_records_truncated'] });
  assert.ok(held.every(row => row.earnedCommission === null && row.setterCommission === null && row.reviewReasons.includes('setter_records_truncated')));
  assert.deepEqual(periodStatement({ reps: [{ repKey: 'rep.one', status: 'active' }], settings, period }), periodStatement({ reps: [{ repKey: 'rep.one', status: 'active' }], settings, period, channelReview: ['ignored'] }), 'no channels: unchanged');
  assert.doesNotMatch(commissionCsv(periodStatement({ reps: [], settings, period }), period), /setter_commission/);
});

test('the office classifies a bridged setter record once (junk earns nothing); only the owner changes its recorded estimator to someone who did not sign; retries are idempotent', async () => {
  const w = world();
  const body = { requestId: uuid(), walkthroughId: 'walk-1', serviceClassification: 'junk_removal', classificationReference: 'synthetic-scope-review' };
  await assert.rejects(classifySetter(w.knock(), office, { ...body, serviceClassification: 'unverified' }, NOW), { code: 'knock_setter_scope' });
  await assert.rejects(classifySetter(w.knock(), office, { ...body, walkthroughId: 'walk-9' }, NOW), { code: 'knock_setter_missing' });
  await assert.rejects(classifySetter(w.knock(), office, { ...body, estimatorKey: 'Estimator.Two' }, NOW), { code: 'knock_setter_estimator' }, 'a reference is required');
  // A manager cannot move the bridge's estimator to someone who did not sign the handoff (Estimator.One signed it).
  const classify = { action: 'setter.classify', ...body, estimatorKey: 'Estimator.Two', estimatorReference: 'synthetic-roster-review' };
  const refused = await call(admin(w).post, await as('TylerG', cookie => post('/api/knock-admin', classify, cookie)), env);
  assert.deepEqual([refused.status, refused.body.code, w.fake.get('knock_setters/walk-1').estimatorKey], [409, 'knock_setter_conflict', 'estimator.one'], 'nothing was reassigned');
  const result = await call(admin(w).post, await as('ZacB', cookie => post('/api/knock-admin', classify, cookie)), env);
  assert.equal(result.status, 200);
  const saved = w.fake.get('knock_setters/walk-1');
  assert.deepEqual([saved.serviceClassification, saved.classificationReference, saved.estimatorKey, saved.classifiedBy, saved.estimatorClassifiedBy], ['junk_removal', 'synthetic-scope-review', 'estimator.two', 'ZacB', 'ZacB']);
  assert.deepEqual({ ...w.fake.get(`knock_receipts/setter_classify_${body.requestId}`).previous }, { serviceClassification: 'unverified', classificationReference: '', estimatorKey: 'estimator.one', estimatorReference: 'knock-walkthrough:kw-1' });
  assert.equal((await classifySetter(w.knock(), office, { ...body, estimatorKey: 'estimator.two', estimatorReference: 'synthetic-roster-review' }, NOW)).duplicate, true);
  await assert.rejects(classifySetter(w.knock(), office, { ...body, requestId: uuid(), serviceClassification: 'garage' }, NOW), { code: 'knock_setter_conflict' }, 'a settled classification is never changed here');
  const row = (await call(admin(w).get, await as('ZacB', cookie => get('/api/knock-admin?view=setters', cookie)), env)).body.rows[0];
  assert.deepEqual([row.state, row.earnedCommission], ['excluded', 0]);
  const rep = await call(admin(w).post, await as('Rep.One', cookie => post('/api/knock-admin', { action: 'setter.classify', ...body, requestId: uuid() }, cookie)), env);
  assert.equal(rep.status, 403);
});

test('an estimator on the roster can be paid their recorded 7% once the terms are approved; an unknown key still cannot', async () => {
  const body = { requestId: uuid(), repKey: 'estimator.one', periodKey: '2026-10-19_2026-11-01', amount: 296.42, note: 'Synthetic estimator payment' };
  const rostered = w => () => ({ ...w.dispatch(), roster: async () => [{ id: 'estimator.one', name: 'Estimator One', role: 'sales' }, { id: 'zacb', name: 'Zac', role: 'owner' }] });
  const early = world({ approved: false });
  await assert.rejects(addPayout(early.knock(), office, body, NOW, env, { dispatch: rostered(early) }), { code: 'knock_rep_missing' }, 'not before the owner approved the terms');
  const w = world();
  const handlers = knockAdminHandlers({ storage: () => w.knock(), dispatch: rostered(w), now: () => new Date(NOW) });
  const paid = (await call(handlers.post, await as('ZacB', cookie => post('/api/knock-admin', { action: 'payout.add', ...body }, cookie)), env)).body;
  assert.deepEqual([paid.duplicate, paid.payout.repKey, paid.payout.amount], [false, 'estimator.one', 296.42]);
  assert.equal((await addPayout(w.knock(), office, body, NOW, env, { dispatch: rostered(w) })).duplicate, true);
  await assert.rejects(addPayout(w.knock(), office, { ...body, requestId: uuid(), repKey: 'nobody.here' }, NOW, env, { dispatch: rostered(w) }), { code: 'knock_rep_missing' });
  const statement = (await call(admin(w).get, await as('ZacB', cookie => get('/api/knock-admin?view=money&date=2026-10-21', cookie)), env)).body.statement;
  const row = statement.find(item => item.repKey === 'estimator.one');
  assert.deepEqual([row.paid, row.payableCommission], [296.42, 0]);
});

// REP-WALKTHROUGH (owner decision 2026-10-21): a walkthrough the rep ran and signed themselves (the bridge's selfRun
// record) pays the rep's door-sale 25% through the same statement, and no estimator 7% anywhere.
test('a walkthrough the rep ran and signed pays the rep 25% in Admin > Money and My money, with no estimator share anywhere', async () => {
  const selfJob = paidJob('job-3', 'walk-3', 2000, { acceptance: { recordedBy: 'Rep.One', acceptedAt: '2026-10-17T14:55:00Z' } });
  const w = world({ seed: {
    'knock_setters/walk-3': bridgeRow('walk-3', { estimatorKey: 'rep.one', requestId: 'kw-3', selfRun: true, repStaffKey: 'rep.one' }),
    'jobs/walk-3': { ...visit('walk-3', 'job-3'), assignedCrew: ['rep.one'] }, 'jobs/job-3': selfJob,
    'walkthroughHandoffs/r3': { actorId: 'Rep.One', jobId: 'job-3', sourceWalkthroughId: 'walk-3', createdAt: '2026-10-17T15:00:00.000Z', signature: 'data:image/png;base64,AAAA', amountCents: 200000 },
  } });
  const statement = (await call(admin(w).get, await as('ZacB', cookie => get('/api/knock-admin?view=money&date=2026-10-21', cookie)), env)).body.statement;
  const byKey = Object.fromEntries(statement.map(row => [row.repKey, row]));
  // The rep: 13% of the estimator-signed $3,000 job ($390) plus 25% of their own $2,000 walkthrough ($500).
  assert.deepEqual([byKey['rep.one'].setterCommission, byKey['rep.one'].doorWalkthroughCommission, byKey['rep.one'].estimatorCommission, byKey['rep.one'].earnedCommission], [390, 500, 0, 890]);
  // The estimator is paid exactly as before: nothing from the rep's own walkthrough.
  assert.deepEqual([byKey['estimator.one'].estimatorCommission, byKey['estimator.one'].earnedCommission], [296.42, 296.42]);
  const own = (await call(reports(w).get, await as('Rep.One', cookie => get('/api/knock-reports?view=my-money&date=2026-10-21', cookie)), env)).body;
  assert.deepEqual([own.periods[0].doorWalkthroughCommission, own.periods[0].estimatorCommission, own.periods[0].earnedCommission], [500, 0, 890], 'the rep signed it, but earns no 7% on top');
  const card = own.setters.rows.find(row => row.walkthroughId === 'walk-3');
  assert.deepEqual([card.channel, card.earnedCommission, card.allocations.map(item => item.role)], ['direct_sale', 500, ['direct_rep']]);
});
