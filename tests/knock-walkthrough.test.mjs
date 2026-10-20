import test from 'node:test';
import assert from 'node:assert/strict';
import { MON, NOW, TUE, MIN, SECRET_ENV, USERS, busy, bridgeWorld, id, iso, saleBatch } from './helpers/knock-bridge-fixture.mjs';
import { estimatorIds, estimatorRef } from '../functions/_lib/knock-bridge.js';
import { call, get, post } from './helpers/knock-fixture.mjs';
import { knockSyncHandlers } from '../functions/api/knock-sync.js';
import { nativeHouseClaimId } from '../functions/_lib/knock-form-claims.js';
import { setterPolicy } from '../functions/_lib/knock-setters.js';
import { countKnocks, metrics, scoreboard } from '../crew/knock-stats.js';
import { doorStatus } from '../crew/knock-doors.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { assignedDuring } from '../functions/_lib/field-execution-visits.js';
import { dispatchOverview } from '../functions/_lib/dispatch-service.js';
import { repSetterRows } from '../functions/_lib/knock-reports.js';
import { installFirestoreFake } from './knock-dev-server.mjs';

// KNOCK-BRIDGE (EGC_KNOCK_JOB_BRIDGE; owner decisions D8, D6b, 2026-10-17): a rep sets an estimator walkthrough at the
// door. It lands on the estimator's schedule (assignedCrew) and in Hub dispatch, with the setter attribution recorded
// in the same request. Synthetic data only.

const visits = w => w.docs('jobs/').filter(row => row.type === 'walkthrough');

function walkBatch({ n = 2902, shiftId = id(), knockId = id(), walkId = id(), walk = {} } = {}) {
  return {
    shiftId, knockId, walkId,
    events: [
      { id: id(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 30 * MIN) },
      { id: knockId, type: 'knock', shiftId, houseId: `h-${n}-blue-leaf-dr`, outcome: 'walkthrough_set', carOutside: false, at: iso(NOW - 4 * MIN) },
      { id: walkId, type: 'walkthrough', knockId, houseId: `h-${n}-blue-leaf-dr`, at: iso(NOW - 3 * MIN), customer: { name: `Lee Synthetic ${n}`, phone: `970-555-1${String(n).slice(-3)}`, email: '' },
        date: MON, dayPart: 'am', textConsent: true, note: 'Two-car garage, wants shelving', ...walk },
    ],
  };
}

test('who estimates: the walkthrough skill with the staff directory, else the sales role; never the setter or office-only staff', () => {
  const roster = [{ id: 'alex', name: 'Alex E', role: 'sales' }, { id: 'rep.one', name: 'Rep One', role: 'sales' }, { id: 'cy', name: 'Cy', role: 'crew' },
    { id: 'dee', name: 'Dee', role: 'crew', skills: [{ id: 'walkthrough_estimating', level: 'proficient' }] }, { id: 'boss', name: 'Boss', role: 'manager', fieldWork: false, skills: [{ id: 'walkthrough_estimating', level: 'lead' }] },
    { id: 'new', name: 'New', role: 'crew', skills: [{ id: 'walkthrough_estimating', level: 'learning' }] }];
  assert.deepEqual(estimatorIds(roster, {}, 'rep.one'), ['alex']);
  assert.deepEqual(estimatorIds(roster, { EGC_STAFF_DIRECTORY_ENABLED: 'true' }, 'rep.one'), ['dee'], 'proficient or lead skill, field staff only');
  // A directory turned on before any field staff member holds the skill (only learners, or office-only staff) keeps
  // the sales role, so door walkthroughs stay bookable until the owner gives someone the skill.
  const noSkillYet = roster.filter(person => person.id !== 'dee');
  assert.deepEqual(estimatorIds(noSkillYet, { EGC_STAFF_DIRECTORY_ENABLED: 'true' }, 'rep.one'), ['alex']);
  assert.deepEqual(estimatorIds([...noSkillYet, { id: 'nick', name: 'Nick', role: 'crew', staffRoles: ['crew', 'sales'] }], { EGC_STAFF_DIRECTORY_ENABLED: 'true' }, 'rep.one'), ['alex', 'nick'], 'a stored Sales role counts');
});

test('slots: the next 10 days, 9:00 to 5:00, each with the estimator\'s first name and an opaque handle only', async () => {
  const w = await bridgeWorld();
  const slots = await w.walkSlots();
  assert.equal(slots.status, 200, JSON.stringify(slots.body));
  assert.deepEqual(Object.keys(slots.body).sort(), ['days', 'from', 'minutes', 'ok', 'serverTime', 'slots']);
  assert.ok(slots.body.slots.length > 0);
  for (const slot of slots.body.slots) {
    assert.deepEqual(Object.keys(slot).sort(), ['date', 'endTime', 'estimator', 'ref', 'time']);
    assert.ok(['Alex', 'Bea'].includes(slot.estimator), slot.estimator);
    assert.ok(slot.time >= '09:00' && slot.endTime <= '17:00' && slot.date >= '2026-10-20' && slot.date < '2026-10-30', JSON.stringify(slot));
    assert.match(slot.ref, /^[a-f0-9]{16}$/);
  }
  assert.ok(slots.body.slots.every(slot => slot.date > '2026-10-20' || slot.time >= '11:00'), 'nothing earlier than now');
  assert.equal(slots.body.slots[0].ref, await estimatorRef('est.alex', SECRET_ENV));
  assert.doesNotMatch(JSON.stringify(slots.body), /est\.alex|est\.bea|Estimator|Rep One|rep\.one|roster|employeeIds/, 'no staff key, surname, roster or the rep themself');
});

test('a walkthrough set at the door books the picked estimator, lands on their schedule and records the 13% / 7% setter split', async () => {
  const w = await bridgeWorld();
  const ref = await estimatorRef('est.bea', SECRET_ENV);
  const { walkId, knockId, events } = walkBatch({ walk: { date: MON, time: '10:00', estimatorRef: ref, dayPart: null, zip: '80525' } });
  const synced = await w.send(events);
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.deepEqual(synced.body.results.map(r => r.status), ['applied', 'applied', 'applied']);
  assert.deepEqual(synced.body.results[2].bridge, { kind: 'walkthrough', status: 'pending' });
  const record = w.fake.get(`knock_walkthroughs/${walkId}`);
  assert.deepEqual([record.repKey, record.knockId, record.customer.phone, record.address.city, record.address.zip], ['rep.one', knockId, '+19705551902', 'Fort Collins', '80525']);
  assert.deepEqual(record.requested, { date: MON, time: '10:00', part: null, estimatorRef: ref, source: 'slot' });
  const door = w.fake.get(`knock_events/${walkId}`);
  assert.deepEqual(Object.keys(door).filter(key => !['receivedAt', 'fingerprint', 'repKey', 'day', 'revision'].includes(key)).sort(), ['at', 'houseId', 'knockId', 'type'], 'no customer details on the event');

  const booked = await w.book('walkthrough', walkId);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.deepEqual(booked.body.booking, { kind: 'walkthrough', id: walkId, status: 'booked', date: MON, time: '10:00', endTime: '11:00', estimator: 'Bea', message: 'Walkthrough booked: Mon Oct 26, 10:00 am with Bea' });
  const [visit] = visits(w);
  assert.deepEqual([visit.date, visit.time, visit.endTime, visit.assignedCrew, visit.status], [MON, '10:00', '11:00', ['est.bea'], 'scheduled']);
  assert.deepEqual([visit.source, visit.knockWalkthroughId, visit.ghlTags, visit.d2d.kind, visit.d2d.setterEventId, visit.d2d.contactSource], ['door_to_door', walkId, ['egc-d2d-walkthrough'], 'walkthrough', walkId, 'Door to door']);
  assert.match(visit.operationalScope.text, /Two-car garage, wants shelving/);
  assert.equal(w.fake.get(`customers/${visit.customerId}`).acquisition.setterEventId, walkId);
  // It is on Bea's own day (the assignment rule /api/field-jobs uses for crew home's walkthrough cards) and on the board.
  const bea = createJobAssignmentAccess(w.env, { user: 'Est.Bea', displayName: 'Bea Estimator' }), alex = createJobAssignmentAccess(w.env, { user: 'Est.Alex', displayName: 'Alex Estimator' });
  assert.deepEqual([await assignedDuring(visit, MON, MON, bea), await assignedDuring(visit, MON, MON, alex)], [true, false]);
  const board = await dispatchOverview(w.dispatchStore(), { user: 'zacb', role: 'owner', businessAccess: true }, { startDate: MON, endDate: TUE }, new Date(NOW));
  assert.deepEqual(board.jobs.filter(row => row.id === visit.id).map(row => [row.type, row.assignedCrew.join()]), [['walkthrough', 'est.bea']]);

  const setter = w.fake.get(`knock_setters/${visit.id}`);
  assert.deepEqual([setter.walkthroughId, setter.setterKey, setter.estimatorKey, setter.channel, setter.source, setter.recordedBy], [visit.id, 'rep.one', 'est.bea', 'appointment_setter', 'knock_walkthrough', 'knock-bridge']);
  assert.deepEqual(setter.rates, { setter: 0.13, estimator: 0.07, total: 0.2 });
  assert.deepEqual([setterPolicy.rate, setterPolicy.estimatorRate], [0.13, 0.07]);
  assert.equal(w.fake.get(`knock_receipts/setter_${walkId}`).walkthroughId, visit.id);
  // The rep's money screen lists the setter record against the Hub walkthrough.
  const money = await w.report('my-money');
  assert.deepEqual(money.body.setters.rows.map(row => [row.walkthroughId, row.setterKey, row.rate]), [[visit.id, 'rep.one', 0.13]]);
  // The rep's own list shows the booking with the estimator's first name only.
  const mine = await w.report('my-sales');
  assert.deepEqual(mine.body.walkthroughs.map(row => [row.id, row.booking.status, row.booking.estimator, row.booking.date, row.booking.time]), [[walkId, 'booked', 'Bea', MON, '10:00']]);
  assert.doesNotMatch(JSON.stringify(mine.body.walkthroughs), /est\.bea|visit_|customer_/);
});

test('the picked estimator is taken: another estimator then; both taken: the nearest free hour; nobody: To schedule', async () => {
  const bea = await estimatorRef('est.bea', SECRET_ENV);
  const w = await bridgeWorld({ seed: { 'jobs/bea_busy': busy(MON, ['est.bea'], { type: 'walkthrough' }) } });
  const first = walkBatch({ walk: { date: MON, time: '10:00', estimatorRef: bea, dayPart: null } });
  await w.send(first.events);
  const alex = await w.book('walkthrough', first.walkId);
  assert.deepEqual([alex.body.booking.status, alex.body.booking.estimator, alex.body.booking.date, alex.body.booking.time], ['booked', 'Alex', MON, '10:00']);
  assert.equal(w.fake.get(`knock_setters/${visits(w).find(v => v.knockWalkthroughId === first.walkId).id}`).estimatorKey, 'est.alex', 'the estimator who goes is the one credited');

  const v = await bridgeWorld({ seed: { 'jobs/bea_busy': busy(MON, ['est.bea'], { type: 'walkthrough' }), 'jobs/alex_busy': busy(MON, ['est.alex'], { type: 'walkthrough' }) } });
  const second = walkBatch({ walk: { date: MON, time: '10:00', estimatorRef: bea, dayPart: null } });
  await v.send(second.events);
  const tuesday = await v.book('walkthrough', second.walkId);
  assert.deepEqual([tuesday.body.booking.status, tuesday.body.booking.estimator, tuesday.body.booking.date, tuesday.body.booking.time], ['booked', 'Bea', TUE, '10:00'], 'the picked estimator first when the next day is open');

  const u = await bridgeWorld({ env: { HUB_AUTH_USERS_JSON: JSON.stringify(Object.fromEntries(Object.entries(USERS).filter(([name]) => !name.startsWith('Est.')))) } });
  const third = walkBatch({ walk: { date: MON, dayPart: 'pm' } });
  await u.send(third.events);
  const queued = await u.book('walkthrough', third.walkId);
  assert.deepEqual([queued.body.booking.status, queued.body.booking.date, queued.body.booking.estimator, queued.body.booking.message], ['requested', '', '', 'Walkthrough request sent: the office will set the time']);
  const [request] = visits(u);
  assert.deepEqual([request.date, request.assignedCrew, request.status], ['', [], 'unscheduled'], 'an undated walkthrough waits in To schedule');
  assert.match(request.opsNotes, /asked for Mon Oct 26 afternoon\. No estimator was free/);
  assert.deepEqual([u.fake.get(`knock_setters/${request.id}`).setterKey, u.fake.get(`knock_setters/${request.id}`).estimatorKey], ['rep.one', ''], 'the setter is credited even before an estimator is booked');
});

test('offline replay and repeated booking are idempotent on the client event id', async () => {
  const w = await bridgeWorld();
  const { walkId, events } = walkBatch();
  await w.send(events);
  assert.deepEqual((await w.send(events)).body.results.map(r => r.status), ['duplicate', 'duplicate', 'duplicate']);
  const first = await w.book('walkthrough', walkId);
  assert.deepEqual([first.body.booking.status, first.body.booking.date, first.body.booking.time], ['booked', MON, '09:00'], 'morning starts at 9:00 for walkthroughs');
  const second = await w.book('walkthrough', walkId);
  assert.deepEqual(second.body.booking, first.body.booking);
  // A lost answer: the record never learned its visit; the dispatch receipt answers the same one.
  const record = w.fake.get(`knock_walkthroughs/${walkId}`);
  w.fake.put(`knock_walkthroughs/${walkId}`, { ...record, status: 'set', booking: { status: 'pending', jobId: '' } });
  const third = await w.book('walkthrough', walkId);
  assert.deepEqual([third.body.booking.status, third.body.booking.date], ['booked', MON]);
  assert.equal(visits(w).length, 1);
  assert.equal(w.docs('knock_setters/').length, 1);
  assert.equal(w.docs('knock_receipts/setter_').length, 1);
  assert.equal(w.docs('customers/').length, 1);
});

test('the door rules: Walkthrough set needs its walkthrough, cannot be edited into, and locks once saved; another rep cannot book it', async () => {
  const w = await bridgeWorld();
  const { shiftId, knockId, walkId, events } = walkBatch();
  await w.send(events);
  const again = await w.send([{ ...events[2], id: id() }]);
  assert.equal(again.body.results[0].code, 'knock_walkthrough_exists');
  const lonely = await w.send([{ ...events[2], id: id(), knockId: id() }]);
  assert.equal(lonely.body.results[0].code, 'knock_walkthrough_invalid');
  const edits = await w.send([
    { id: id(), type: 'knock', shiftId, houseId: 'h-2904-blue-leaf-dr', outcome: 'no_answer', at: iso(NOW - 2 * MIN) },
    { id: id(), type: 'knock.void', target: knockId, houseId: 'h-2902-blue-leaf-dr', at: iso(NOW - MIN) },
  ]);
  assert.deepEqual(edits.body.results.map(r => r.code || r.status), ['applied', 'knock_walkthrough_locked']);
  const toWalk = await w.send([{ id: id(), type: 'knock.edit', target: edits.body.results[0].id, houseId: 'h-2904-blue-leaf-dr', outcome: 'walkthrough_set', at: iso(NOW) }]);
  assert.equal(toWalk.body.results[0].code, 'knock_edit_walkthrough');
  const bad = await w.send([{ ...walkBatch({ n: 2906 }).events[2], customer: { name: 'X', phone: '12' } }]);
  assert.equal(bad.body.results[0].code, 'knock_walkthrough_invalid', 'no door for it');
  assert.equal((await w.book('walkthrough', walkId, w.cookies.two)).body.code, 'knock_walkthrough_missing');
  assert.equal(doorStatus({}, { lastOutcome: 'walkthrough_set', lastAt: iso(NOW) }, {}, NOW).reason, 'Walkthrough set');
});

test('switching a house to an in-person sale: the same rep may sell after a walkthrough or a native walkthrough request', async () => {
  const w = await bridgeWorld();
  const walk = walkBatch({ n: 2900 });
  await w.send(walk.events);
  await w.book('walkthrough', walk.walkId);
  const sale = saleBatch({ n: 2900, shiftId: walk.shiftId, at: NOW - MIN });
  const synced = await w.send(sale.events.slice(1));
  assert.deepEqual(synced.body.results.map(r => r.status), ['applied', 'applied'], 'Sold after Walkthrough set on the same house');
  await w.book('sale', sale.saleId);
  const job = w.docs('jobs/').find(row => row.knockSaleId === sale.saleId);
  const visit = visits(w)[0];
  assert.match(job.opsNotes, new RegExp(`door-to-door walkthrough \\(Hub visit ${visit.id}\\)\\. Cancel it if this sale replaces it\\.`));
  assert.equal(w.fake.get(`knock_walkthroughs/${walk.walkId}`).supersededBySaleId, sale.saleId);

  // A native walkthrough request (knock-form-handoff.js) by the same rep: with the bridge on, the rep may now sell.
  const claim = n => ({ [`knock_receipts/${n}`]: { kind: 'native_house_claim', houseId: 'h-2904-blue-leaf-dr', channel: 'walkthrough_request', repKey: 'rep.one', generation: 1, state: 'active' } });
  const claimId = await nativeHouseClaimId('h-2904-blue-leaf-dr');
  for (const [bridge, who, expected] of [[true, 'rep', 'applied'], [false, 'rep', 'knock_form_channel_conflict'], [true, 'two', 'knock_form_channel_conflict']]) {
    const v = await bridgeWorld({ bridge, seed: claim(claimId) });
    const attempt = saleBatch({ n: 2904 });
    const result = await v.send(attempt.events, v.cookies[who]);
    assert.equal(result.body.results[1].code || result.body.results[1].status, expected, `bridge ${bridge}, ${who}`);
  }
});

test('the scoreboard counts walkthroughs set; a summary without any is exactly as before', async () => {
  const w = await bridgeWorld();
  const { events } = walkBatch();
  await w.send(events);
  const day = w.fake.get('knock_days/rep.one_2026-10-20');
  assert.deepEqual([day.doors, day.answers, day.looks, day.sales, day.walkthroughs], [1, 1, 0, 0, 1]);
  assert.equal(day.byNeighborhood['english-ranch'].walkthroughs, 1);
  const rows = scoreboard([day], { groupBy: 'rep' });
  assert.equal(rows[0].metrics.walkthroughs, 1);
  const plain = countKnocks([{ outcome: 'no_answer' }, { outcome: 'look' }]);
  assert.equal('walkthroughs' in plain, false);
  assert.equal('walkthroughs' in metrics(plain), false);
});

/* ---------- review fixes: every walkthrough set at the door reaches the office ---------- */

const officeList = async w => (await call(w.h.admin.get, get('/api/knock-admin?view=sales', w.cookies.zac), w.env)).body.walkthroughs;
const restlessSchedule = store => ({ ...store, read: (collection, docId) => collection === 'dispatchState' ? Promise.resolve({ id: 'revision', revision: crypto.randomUUID() }) : store.read(collection, docId) });

test('a lost sync answer: a replayed walkthrough not booked yet is marked pending again; once booked it is not', async () => {
  const w = await bridgeWorld();
  const { walkId, events } = walkBatch();
  await w.send(events);
  const replay = await w.send(events);
  assert.deepEqual(replay.body.results.map(row => row.bridge || null), [null, null, { kind: 'walkthrough', status: 'pending' }]);
  await w.book('walkthrough', walkId);
  assert.deepEqual((await w.send(events)).body.results.map(row => row.bridge || null), [null, null, null]);
});

test('a dated walkthrough the Hub refuses still reaches Dispatch: an undated walkthrough in To schedule with the reason', async () => {
  const w = await bridgeWorld();
  const { walkId, events } = walkBatch({ walk: { date: MON, time: '10:00', estimatorRef: await estimatorRef('est.bea', SECRET_ENV), dayPart: null } });
  await w.send(events);
  // The save of the dated, assigned visit is refused (a refusal that does not clear by itself); the undated one is not.
  w.wrapDispatch(store => ({ ...store, commit: writes => (writes.some(item => item.collection === 'jobs' && item.patch?.dispatchRequestId && item.patch.date)
    ? Promise.reject(Object.assign(new Error('Synthetic refusal of the dated visit.'), { code: 'dispatch_skills_missing', status: 409 })) : store.commit(writes)) }));
  const booked = await w.book('walkthrough', walkId);
  assert.deepEqual([booked.body.booking.status, booked.body.booking.message], ['requested', 'Walkthrough request sent: the office will set the time']);
  const [request] = visits(w);
  assert.deepEqual([request.date, request.status, request.knockWalkthroughId], ['', 'unscheduled', walkId]);
  assert.match(request.opsNotes, /asked for Mon Oct 26 10:00 am\. The Hub refused the Mon Oct 26 10:00 am booking: Synthetic refusal of the dated visit\. \(dispatch_skills_missing\); book it and call the customer\./);
  assert.equal(w.fake.get(`knock_setters/${request.id}`).setterKey, 'rep.one', 'the setter is still credited');
  assert.deepEqual(await officeList(w), [], 'it is in Dispatch, so not on the office list');
});

test('a customer the Hub cannot match safely: kept for review, listed for the office, never retried by the phone, booked once fixed', async () => {
  // Two Hub records for the same household (one surname, so the names agree): the Hub cannot tell which one.
  const twin = { name: 'Lee Synthetic', phone: '+19705551902', email: '' };
  const w = await bridgeWorld({ seed: { 'customers/customer_twin_a': { ...twin }, 'customers/customer_twin_b': { ...twin, name: 'Lee Synthetic B' } } });
  const { walkId, events } = walkBatch();
  await w.send(events);
  const review = await w.book('walkthrough', walkId);
  assert.deepEqual([review.body.booking.status, review.body.booking.message], ['review', 'Saved. The office will book the walkthrough.']);
  assert.equal(visits(w).length, 0);
  const [listed] = await officeList(w);
  assert.deepEqual([listed.id, listed.customer.phone, listed.booking.status, listed.booking.code], [walkId, '+19705551902', 'review', 'customer_resolve_ambiguous_customer']);
  assert.match(listed.booking.error, /More than one customer matches this phone or email/);
  const before = w.fake.calls.length;
  assert.equal((await w.book('walkthrough', walkId)).body.booking.status, 'review');
  assert.equal(w.fake.calls.slice(before).filter(row => !row.path.includes('knock_')).length, 0, 'the phone does not retry it');
  // The office merges the duplicate, then books it from Admin > Sales.
  w.fake.put('customers/customer_twin_b', { name: 'Lee Synthetic B', phone: '+19705550000', email: '' });
  const office = await w.admin({ action: 'walkthrough.book', walkthroughId: walkId });
  assert.deepEqual([office.status, office.body.booking.status], [200, 'booked']);
  assert.equal(visits(w)[0].customerId, 'customer_twin_a');
  assert.deepEqual(await officeList(w), []);
});

test('a failed estimator search is retried later, never turned into a To schedule request', async () => {
  const w = await bridgeWorld();
  const { walkId, events } = walkBatch({ walk: { date: MON, time: '10:00', estimatorRef: await estimatorRef('est.bea', SECRET_ENV), dayPart: null } });
  await w.send(events);
  w.wrapDispatch(restlessSchedule);
  const first = await w.book('walkthrough', walkId);
  assert.deepEqual([first.body.booking.status, first.body.booking.retryAt], ['pending', iso(NOW + MIN)]);
  assert.equal(visits(w).length, 0, 'the rep\'s pick is not given up');
  assert.deepEqual((await officeList(w)).map(row => [row.id, row.booking.status, row.booking.code]), [[walkId, 'retry', 'dispatch_snapshot_changed']]);
  w.wrapDispatch(null);
  w.setClock(NOW + 2 * MIN);
  const later = await w.book('walkthrough', walkId);
  assert.deepEqual([later.body.booking.status, later.body.booking.estimator, later.body.booking.time], ['booked', 'Bea', '10:00']);
});

test('another rep cannot log Sold or Walkthrough set where a walkthrough stands; a sale by the setter withdraws one not booked yet', async () => {
  const w = await bridgeWorld();
  const walk = walkBatch({ n: 2902 });
  await w.send(walk.events);
  const shiftId = id();
  const other = await w.send([{ id: id(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 20 * MIN) },
    { id: id(), type: 'knock', shiftId, houseId: 'h-2902-blue-leaf-dr', outcome: 'sold', at: iso(NOW - 2 * MIN) },
    { id: id(), type: 'knock', shiftId, houseId: 'h-2902-blue-leaf-dr', outcome: 'walkthrough_set', at: iso(NOW - MIN) },
    { id: id(), type: 'knock', shiftId, houseId: 'h-2904-blue-leaf-dr', outcome: 'sold', at: iso(NOW) }], w.cookies.two);
  assert.deepEqual(other.body.results.map(row => row.code || row.status), ['applied', 'knock_walkthrough_other_rep', 'knock_walkthrough_other_rep', 'applied']);
  // The setter closes the sale at the door before the walkthrough was booked: it is withdrawn and never books.
  const sale = saleBatch({ n: 2902, shiftId: walk.shiftId, at: NOW - MIN });
  assert.deepEqual((await w.send(sale.events.slice(1))).body.results.map(row => row.status), ['applied', 'applied']);
  await w.book('sale', sale.saleId);
  const record = w.fake.get(`knock_walkthroughs/${walk.walkId}`);
  assert.deepEqual([record.status, record.supersededBySaleId, record.booking.status], ['superseded', sale.saleId, 'superseded']);
  const answer = await w.book('walkthrough', walk.walkId);
  assert.deepEqual([answer.body.booking.status, answer.body.booking.message], ['superseded', 'Replaced by the sale at this house.']);
  assert.equal(visits(w).length, 0, 'no estimator goes to a customer who bought');
  assert.deepEqual(await officeList(w), []);
  // Superseded, the house is open again to anyone.
  assert.equal((await w.send([{ id: id(), type: 'knock', shiftId, houseId: 'h-2902-blue-leaf-dr', outcome: 'not_interested', at: iso(NOW) }], w.cookies.two)).body.results[0].status, 'applied');
});

test('the estimator handle is keyed by the server secret: a rep cannot test guessed usernames against it', async () => {
  const keyed = await estimatorRef('est.bea', SECRET_ENV);
  const plainHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('egc-knock-estimator:est.bea')))].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
  assert.match(keyed, /^[a-f0-9]{16}$/);
  assert.notEqual(keyed, plainHash);
  assert.notEqual(keyed, await estimatorRef('est.bea', { HUB_SESSION_SECRET: 'another-synthetic-secret-0123456789abcdef' }));
  assert.equal(keyed, await estimatorRef('est.bea', SECRET_ENV), 'stable for one secret');
  await assert.rejects(estimatorRef('est.bea', {}), { code: 'knock_bridge_unavailable' });
});

// E2E-D2D finding: a rep's My money listed each setter record as the office sees it, so every door walkthrough the bridge
// booked showed the rep the estimator's staff key (which estimatorRef keeps from reps), and a converted job would have
// shown the closer, any other rep's direct sale and the estimator's own allocation. The rep now sees only themselves.
test('My money\'s setter records name only the rep: never the estimator, the closer, another rep or the estimator\'s pay', async () => {
  const w = await bridgeWorld();
  const { walkId, events } = walkBatch({ walk: { date: MON, time: '10:00', estimatorRef: await estimatorRef('est.bea', SECRET_ENV), dayPart: null } });
  await w.send(events);
  await w.book('walkthrough', walkId);
  const visit = visits(w)[0];
  assert.equal(w.fake.get(`knock_setters/${visit.id}`).estimatorKey, 'est.bea', 'the office record keeps the estimator');
  // The setter projection reads the walkthrough through the production dispatch storage (global fetch): answer it from
  // the same in-memory Firestore, so the full record is projected.
  const restore = installFirestoreFake(w.fake);
  let money, admin;
  try { money = await w.report('my-money'); admin = await call(w.h.admin.get, get('/api/knock-admin?view=setters', w.cookies.zac), w.env); } finally { restore(); }
  assert.equal(money.status, 200, JSON.stringify(money.body));
  assert.deepEqual(money.body.setters.rows.map(row => [row.walkthroughId, row.setterKey, row.rate, row.state, row.estimatorEvidence]), [[visit.id, 'rep.one', 0.13, 'awaiting_close', 'admin_recorded_unreconciled']]);
  assert.doesNotMatch(JSON.stringify(money.body), /est\.bea|estimatorKey|closingActorKey|directSaleRepKey/);
  assert.deepEqual(admin.body.rows.map(row => [row.setterKey, row.estimatorKey, row.state]), [['rep.one', 'est.bea', 'awaiting_close']], 'Admin > Setters still names the estimator');

  // A converted, collected walkthrough: of the allocations the rep sees their own 13% share only.
  const converted = { id: 'w1', walkthroughId: 'w1', setterKey: 'rep.one', estimatorKey: 'est.bea', closingActorKey: 'est.bea', directSaleRepKey: 'rep.two', state: 'review_required', rate: 0.13,
    allocations: [{ id: 'j1:appointment_setter:setter:rep.one', role: 'setter', repKey: 'rep.one', rate: 0.13, amountCents: 26000 }, { id: 'j1:appointment_setter:estimator:est.bea', role: 'estimator', repKey: 'est.bea', rate: 0.07, amountCents: 14000 }] };
  const shown = repSetterRows({ rows: [converted, { ...converted, id: 'w2', walkthroughId: 'w2', setterKey: 'rep.two' }], truncated: false, policy: { rate: 0.13 } }, 'rep.one');
  assert.deepEqual(shown, { rows: [{ id: 'w1', walkthroughId: 'w1', setterKey: 'rep.one', state: 'review_required', rate: 0.13, allocations: [converted.allocations[0]] }], truncated: false, policy: { rate: 0.13 } });
});

/* ---------- review fixes: one sale or walkthrough per house, and which customer it books ---------- */

// Rep Two's walkthrough on h-<n>, synced from Rep Two's phone (a shift, the Walkthrough set door, the walkthrough).
const twoWalk = n => walkBatch({ n, walk: { customer: { name: `Lee Synthetic ${n}`, phone: `970-555-1${String(n).slice(-3)}`, email: '' } } });

// REVIEW integrity-races-2: a Walkthrough set door on a house that already bought (another rep's sale, or the rep's own)
// was accepted and booked an estimator, with a 13% / 7% setter record nobody reviewed.
test('no walkthrough over a door sale: another rep\'s, the rep\'s own, or a native direct sale; a cancelled sale leaves the house open', async () => {
  const w = await bridgeWorld();
  const sale = saleBatch({ n: 2902 });
  await w.send(sale.events);
  assert.equal((await w.book('sale', sale.saleId)).body.booking.status, 'booked');
  const other = twoWalk(2902);
  const refused = await w.send(other.events, w.cookies.two);
  assert.deepEqual(refused.body.results.map(row => row.code || row.status), ['applied', 'knock_house_sold', 'knock_walkthrough_invalid']);
  assert.equal(refused.body.results[1].error, 'This house already has a sale at the door. Ask the office before setting a walkthrough.');
  assert.deepEqual([w.docs('knock_walkthroughs/').length, visits(w).length, w.docs('knock_setters/').length], [0, 0, 0], 'no estimator and no setter record');
  // The walkthrough event alone, on a door logged earlier (before the sale synced), is refused too.
  const early = await bridgeWorld();
  const door = twoWalk(2902);
  await early.send(door.events.slice(0, 2), early.cookies.two);
  const sold = saleBatch({ n: 2902 });
  await early.send(sold.events);
  assert.deepEqual((await early.send(door.events.slice(2), early.cookies.two)).body.results.map(row => row.code || row.status), ['knock_house_sold']);
  // The rep's own sale: the customer already bought, so no estimator either.
  const own = walkBatch({ n: 2902, shiftId: sale.shiftId });
  assert.deepEqual((await w.send(own.events.slice(1))).body.results.map(row => row.code || row.status), ['knock_house_sold', 'knock_walkthrough_invalid']);
  // A direct sale filed through the native form claims the house.
  const claimId = await nativeHouseClaimId('h-2904-blue-leaf-dr');
  const native = await bridgeWorld({ seed: { [`knock_receipts/${claimId}`]: { houseId: 'h-2904-blue-leaf-dr', channel: 'direct_sale', repKey: 'rep.two', generation: 0, state: 'active' } } });
  assert.equal((await native.send(walkBatch({ n: 2904 }).events)).body.results[1].code, 'knock_form_channel_conflict');
  // A cancelled sale (the customer used the right to cancel) leaves the house open to a walkthrough.
  await w.admin({ action: 'sale.status', saleId: sale.saleId, status: 'cancelled' });
  const later = twoWalk(2902);
  assert.deepEqual((await w.send(later.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
});

// Holds each sync's event commit until both syncs reach it, so both decide against the same state (two Workers).
function racingSync(w) {
  const waiting = [];
  let armed = 2;
  const storage = env => {
    const store = w.world.storage(env);
    return { ...store, commit: async writes => {
      if (armed > 0 && writes.some(item => String(item.update?.name || '').includes('/knock_events/'))) {
        armed -= 1;
        await new Promise(resolve => { waiting.push(resolve); if (waiting.length === 2) waiting.forEach(release => release()); });
      }
      return store.commit(writes);
    } };
  };
  const sync = knockSyncHandlers({ storage, now: () => new Date(NOW) });
  return (events, who) => call(sync.post, post('/api/knock-sync', { events }, who), w.env);
}

// REVIEW integrity-races-2: the one-walkthrough-per-house rule was check-then-act, so two reps' walkthroughs (or a sale and
// a walkthrough) syncing at the same moment both committed.
test('two syncs deciding about one house at the same moment: one commits, the other is busy and then refused', async () => {
  const w = await bridgeWorld();
  const send = racingSync(w);
  const one = walkBatch({ n: 2902 }), two = twoWalk(2902);
  const answers = await Promise.all([send(one.events, w.cookies.rep), send(two.events, w.cookies.two)]);
  assert.deepEqual(answers.map(row => row.status).sort(), [200, 503], JSON.stringify(answers.map(row => row.body)));
  const busy = answers.find(row => row.status === 503);
  assert.deepEqual([busy.body.code, busy.body.error], ['knock_house_busy', 'Another phone changed one of these houses at the same moment. Syncing again.']);
  assert.equal(w.docs('knock_walkthroughs/').length, 1, 'one walkthrough stands');
  // The busy phone syncs again (a 503 keeps its changes queued) and is refused for the walkthrough that won.
  const [winner, loser] = answers[0].status === 200 ? [one, two] : [two, one];
  const retry = await w.send(loser.events, loser === one ? w.cookies.rep : w.cookies.two);
  assert.deepEqual(retry.body.results.map(row => row.code || row.status), ['applied', 'knock_walkthrough_other_rep', 'knock_walkthrough_invalid']);
  assert.deepEqual(w.docs('knock_walkthroughs/').map(row => row.path.split('/').pop()), [winner.walkId]);

  // A sale and another rep's walkthrough at the same moment: never both, so no estimator for a customer who bought.
  const v = await bridgeWorld();
  const race = racingSync(v);
  const sale = saleBatch({ n: 2904 }), walk = twoWalk(2904);
  const both = await Promise.all([race(sale.events, v.cookies.rep), race(walk.events, v.cookies.two)]);
  assert.deepEqual(both.map(row => row.status).sort(), [200, 503]);
  assert.equal(v.docs('knock_sales/').length + v.docs('knock_walkthroughs/').length, 1, 'a sale or a walkthrough, never both');
  // Without the bridge every sync commits as before (no fence is read or verified).
  const off = await bridgeWorld({ bridge: false });
  const plain = racingSync(off);
  const first = saleBatch({ n: 2900 }), second = saleBatch({ n: 2906 });
  assert.deepEqual((await Promise.all([plain(first.events, off.cookies.rep), plain(second.events, off.cookies.two)])).map(row => row.status), [200, 200]);
  assert.equal(off.fake.calls.some(row => row.method === 'GET' && row.path.startsWith('knock_form_revisions/')), false, 'no fence read with the bridge off');
});

// REVIEW security-privacy-1, the walkthrough side: a phone that is another Hub customer's, under another name.
test('a door walkthrough whose phone is another Hub customer\'s, under another name, waits for the office; its Book in Hub links them', async () => {
  const w = await bridgeWorld({ seed: { 'customers/customer_other': { name: 'Morgan Unrelated', phone: '+19705551902', email: '' } } });
  const { walkId, events } = walkBatch();
  await w.send(events);
  const review = await w.book('walkthrough', walkId);
  assert.deepEqual([review.body.booking.status, visits(w).length, w.docs('knock_setters/').length], ['review', 0, 0]);
  const [listed] = await officeList(w);
  assert.deepEqual([listed.id, listed.booking.code], [walkId, 'customer_identity_review']);
  assert.doesNotMatch(JSON.stringify(review.body), /Morgan|customer_other/);
  const office = await w.admin({ action: 'walkthrough.book', walkthroughId: walkId });
  assert.deepEqual([office.status, office.body.booking.status, visits(w)[0].customerId], [200, 'booked', 'customer_other']);
});
