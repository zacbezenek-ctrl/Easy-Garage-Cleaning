import test from 'node:test';
import assert from 'node:assert/strict';
import { MON, NOW, TUE, MIN, USERS, busy, bridgeWorld, id, iso, saleBatch } from './helpers/knock-bridge-fixture.mjs';
import { estimatorIds, estimatorRef } from '../functions/_lib/knock-bridge.js';
import { nativeHouseClaimId } from '../functions/_lib/knock-form-claims.js';
import { setterPolicy } from '../functions/_lib/knock-setters.js';
import { countKnocks, metrics, scoreboard } from '../crew/knock-stats.js';
import { doorStatus } from '../crew/knock-doors.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { assignedDuring } from '../functions/_lib/field-execution-visits.js';
import { dispatchOverview } from '../functions/_lib/dispatch-service.js';

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
  assert.equal(slots.body.slots[0].ref, await estimatorRef('est.alex'));
  assert.doesNotMatch(JSON.stringify(slots.body), /est\.alex|est\.bea|Estimator|Rep One|rep\.one|roster|employeeIds/, 'no staff key, surname, roster or the rep themself');
});

test('a walkthrough set at the door books the picked estimator, lands on their schedule and records the 13% / 7% setter split', async () => {
  const w = await bridgeWorld();
  const ref = await estimatorRef('est.bea');
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
  const bea = await estimatorRef('est.bea');
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
