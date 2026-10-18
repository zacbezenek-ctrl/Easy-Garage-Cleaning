import test from 'node:test';
import assert from 'node:assert/strict';
import { MON, NOW, TUE, MIN, bridgeWorld, id, iso, saleBatch } from './helpers/knock-bridge-fixture.mjs';
import { call, get } from './helpers/knock-fixture.mjs';
import { namesAgree } from '../functions/_lib/knock-bridge.js';
import { SOLD_OPEN_DAYS } from '../functions/_lib/knock-walkthroughs.js';

// KNOCK-BRIDGE review of the merged integrity, read-budget and commission lanes (integrity-merge-2, -3, -5, -7, -8, -9;
// -1 is in knock-job-bridge.test.mjs, the price signed at the door). Synthetic data only.

const jobsOf = w => w.docs('jobs/').filter(row => row.type === 'job' && !row.recordType);
const visits = w => w.docs('jobs/').filter(row => row.type === 'walkthrough');
const pick = (row, ...keys) => Object.fromEntries(keys.map(key => [key, row?.[key]]));
const unavailable = () => Object.assign(new Error('Dispatch storage is unavailable.'), { code: 'dispatch_storage_unavailable', status: 503 });
const adminSales = async w => (await call(w.h.admin.get, get('/api/knock-admin?view=sales', w.cookies.zac), w.env)).body;
const LEE = { name: 'Lee Synthetic 2902', phone: '970-555-1902', email: '' };

function walkBatch({ n = 2902, shiftId = id(), knockId = id(), walkId = id() } = {}) {
  return { shiftId, knockId, walkId, events: [
    { id: id(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 30 * MIN) },
    { id: knockId, type: 'knock', shiftId, houseId: `h-${n}-blue-leaf-dr`, outcome: 'walkthrough_set', carOutside: false, at: iso(NOW - 4 * MIN) },
    { id: walkId, type: 'walkthrough', knockId, houseId: `h-${n}-blue-leaf-dr`, at: iso(NOW - 3 * MIN), customer: LEE, date: MON, dayPart: 'am', textConsent: true, note: '' },
  ] };
}
// The same rep then sells at that house (same customer, now with the email the contract needs).
const houseSale = walk => saleBatch({ n: 2902, shiftId: walk.shiftId, at: NOW - MIN, sale: { customer: { ...LEE, phone: '(970) 555-1902', email: 'lee2902@example.com' } } });

/* The dispatch save that `match` picks applies, but its answer is lost and its receipt cannot be read back during the
   same outage, so the save's own recovery cannot find it: the caller learns nothing (the bridge retries later). */
function loseAnswer(w, match) {
  const fault = { fired: false, failing: false };
  w.wrapDispatch(store => ({ ...store,
    read: async (collection, docId) => { if (fault.failing) throw unavailable(); return store.read(collection, docId); },
    commit: async writes => {
      const out = await store.commit(writes);
      if (!fault.fired && writes.some(match)) { fault.fired = true; fault.failing = true; throw Object.assign(new Error('The answer was lost.'), { code: 'dispatch_outcome_unknown', status: 503 }); }
      return out;
    } }));
  return { heal: () => { fault.failing = false; w.wrapDispatch(null); } };
}
const saleSave = saleId => item => item.collection === 'jobs' && item.patch?.dispatchRequestId === saleId;
const visitSave = walkId => item => item.collection === 'jobs' && item.patch?.knockWalkthroughId === walkId;

/* ---------- integrity-merge-2: a walkthrough's visit saved without the walkthrough learning it ---------- */

test('integrity-merge-2: a walkthrough visit saved with its answer lost is named on the sale that replaces it, and recorded by its retry', async () => {
  const w = await bridgeWorld();
  const walk = walkBatch();
  await w.send(walk.events);
  const fault = loseAnswer(w, visitSave(walk.walkId));
  assert.equal((await w.book('walkthrough', walk.walkId)).body.booking.status, 'pending');
  fault.heal();
  const [visit] = visits(w);
  assert.equal(visit.status, 'scheduled', 'the visit was saved');
  assert.deepEqual(pick(w.fake.get(`knock_walkthroughs/${walk.walkId}`).booking, 'status', 'jobId'), { status: 'retry', jobId: '' });
  const sale = houseSale(walk);
  assert.deepEqual((await w.send(sale.events.slice(1))).body.results.map(row => row.status), ['applied', 'applied']);
  assert.equal((await w.book('sale', sale.saleId)).body.booking.status, 'booked');
  // The sale's job names the visit for the office (found by the walkthrough's receipt), as for any booked walkthrough.
  const job = jobsOf(w).find(row => row.knockSaleId === sale.saleId);
  assert.match(job.opsNotes, new RegExp(`door-to-door walkthrough \\(Hub visit ${visit.id}\\)\\. Cancel it if this sale replaces it\\.`));
  const record = w.fake.get(`knock_walkthroughs/${walk.walkId}`);
  assert.deepEqual([record.supersededBySaleId, record.status], [sale.saleId, 'set'], 'not withdrawn: it was booked');
  // The walkthrough's own retry records the visit it booked; nothing is booked twice.
  w.setClock(NOW + 2 * MIN);
  assert.deepEqual(pick((await w.book('walkthrough', walk.walkId)).body.booking, 'status', 'date'), { status: 'booked', date: MON });
  assert.deepEqual([w.fake.get(`knock_walkthroughs/${walk.walkId}`).booking.jobId, visits(w).length], [visit.id, 1]);

  // The sale books between the visit's save and the walkthrough learning it: the sale's job names the visit too.
  const v = await bridgeWorld();
  const other = walkBatch();
  await v.send(other.events);
  const otherSale = houseSale(other);
  await v.send(otherSale.events.slice(1));
  let fired = false;
  v.wrapDispatch(store => ({ ...store, commit: async writes => {
    const out = await store.commit(writes);
    if (!fired && writes.some(visitSave(other.walkId))) { fired = true; assert.equal((await v.book('sale', otherSale.saleId)).body.booking.status, 'booked'); }
    return out;
  } }));
  assert.equal((await v.book('walkthrough', other.walkId)).body.booking.status, 'booked');
  v.wrapDispatch(null);
  const [raced] = visits(v);
  assert.match(jobsOf(v).find(row => row.knockSaleId === otherSale.saleId).opsNotes, new RegExp(`Hub visit ${raced.id}\\)\\. Cancel it if this sale replaces it\\.`));
  assert.deepEqual(pick(v.fake.get(`knock_walkthroughs/${other.walkId}`), 'status', 'supersededBySaleId'), { status: 'booked', supersededBySaleId: otherSale.saleId });
});

test('integrity-merge-2: a visit saved after its walkthrough was withdrawn for a sale is cancelled, never booked or paid as a setter\'s', async () => {
  const w = await bridgeWorld();
  const walk = walkBatch();
  await w.send(walk.events);
  const fault = loseAnswer(w, visitSave(walk.walkId));
  await w.book('walkthrough', walk.walkId);
  fault.heal();
  const [visit] = visits(w);
  // The sale's check ran before that visit was saved (it saw no receipt): the walkthrough is withdrawn.
  const sale = houseSale(walk);
  await w.send(sale.events.slice(1));
  w.wrapDispatch(store => ({ ...store, read: (collection, docId) => collection === 'dispatchOperations' && docId === walk.walkId.toLowerCase() ? Promise.resolve(null) : store.read(collection, docId) }));
  assert.equal((await w.book('sale', sale.saleId)).body.booking.status, 'booked');
  w.wrapDispatch(null);
  assert.deepEqual(pick(w.fake.get(`knock_walkthroughs/${walk.walkId}`), 'status', 'supersededBySaleId'), { status: 'superseded', supersededBySaleId: sale.saleId });
  // The phone asks again: the visit is found by the walkthrough's receipt, recorded and cancelled.
  w.setClock(NOW + 2 * MIN);
  const retry = await w.book('walkthrough', walk.walkId);
  assert.deepEqual(pick(retry.body.booking, 'status', 'date', 'message'), { status: 'superseded', date: '', message: 'Replaced by the sale at this house.' });
  const cancelled = w.fake.get(visit.path);
  assert.deepEqual([cancelled.status, cancelled.cancelledBy, cancelled.cancellationReasonCode], ['cancelled', 'knock-bridge', 'duplicate_booking']);
  assert.deepEqual(pick(w.fake.get(`knock_walkthroughs/${walk.walkId}`).booking, 'status', 'jobId', 'withdrawn'), { status: 'superseded', jobId: visit.id, withdrawn: 'cancelled' });
  assert.equal(w.docs('knock_setters/').length, 0, 'no setter record');
  // Settled: asking again (the office's Book in Hub) writes nothing to the Hub.
  const commits = w.fake.calls.filter(row => row.path === ':commit').length;
  assert.equal((await w.admin({ action: 'walkthrough.book', walkthroughId: walk.walkId })).body.booking.status, 'superseded');
  assert.equal(w.fake.calls.filter(row => row.path === ':commit').length, commits);
  assert.equal(jobsOf(w).find(row => row.knockSaleId === sale.saleId).status, 'scheduled', 'the sale\'s job stands');
});

test('integrity-merge-2: withdrawn while its visit was being saved: the walkthrough stays withdrawn and the visit is cancelled', async () => {
  const w = await bridgeWorld();
  const walk = walkBatch();
  await w.send(walk.events);
  // The house becomes a sale just as the visit is saved (supersedeWalkthroughs, from a sale that saw no visit yet).
  let fired = false;
  w.wrapDispatch(store => ({ ...store, commit: async writes => {
    const out = await store.commit(writes);
    if (!fired && writes.some(visitSave(walk.walkId))) {
      fired = true;
      const record = w.fake.get(`knock_walkthroughs/${walk.walkId}`);
      w.fake.put(`knock_walkthroughs/${walk.walkId}`, { ...record, status: 'superseded', supersededBySaleId: 'sale-synthetic', booking: { ...record.booking, status: 'superseded' } });
    }
    return out;
  } }));
  const answer = await w.book('walkthrough', walk.walkId);
  w.wrapDispatch(null);
  assert.deepEqual([answer.status, answer.body.booking.status], [200, 'superseded']);
  const record = w.fake.get(`knock_walkthroughs/${walk.walkId}`);
  assert.deepEqual([record.status, record.booking.status, record.booking.jobId, record.booking.withdrawn], ['superseded', 'superseded', visits(w)[0].id, 'cancelled']);
  assert.equal(visits(w)[0].status, 'cancelled', 'no estimator goes to a customer who already bought');
  assert.equal(w.docs('knock_setters/').length, 0);
  // While the Hub is down the withdrawal waits (503: the phone asks again) instead of answering as if it were settled.
  const v = await bridgeWorld();
  const other = walkBatch();
  await v.send(other.events);
  const fault = loseAnswer(v, visitSave(other.walkId));
  await v.book('walkthrough', other.walkId);
  fault.heal();
  const record2 = v.fake.get(`knock_walkthroughs/${other.walkId}`);
  v.fake.put(`knock_walkthroughs/${other.walkId}`, { ...record2, status: 'superseded', supersededBySaleId: 'sale-synthetic', booking: { ...record2.booking, status: 'superseded' } });
  v.setDispatchDown(true);
  v.setClock(NOW + 2 * MIN);
  assert.deepEqual([(await v.book('walkthrough', other.walkId)).status, visits(v)[0].status], [503, 'scheduled']);
  v.setDispatchDown(false);
  assert.equal((await v.book('walkthrough', other.walkId)).body.booking.status, 'superseded');
  assert.equal(visits(v)[0].status, 'cancelled');
});

/* ---------- integrity-merge-3: the office's new job date and a booking whose answer was lost ---------- */

test('integrity-merge-3: the office moves a sale whose booking answer was lost: the Hub job, found by its receipt, moves with it', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch({ sale: { package: 'Quick Clear', slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } } });
  await w.send(events);
  const fault = loseAnswer(w, saleSave(saleId));
  assert.equal((await w.book('sale', saleId)).body.booking.status, 'pending');
  fault.heal();
  assert.deepEqual([w.fake.get(`knock_sales/${saleId}`).handoff.job.status, jobsOf(w).map(job => `${job.date} ${job.time}`)], ['retry', [`${MON} 09:30`]]);
  w.setClock(NOW + MIN);
  const moved = await w.admin({ action: 'sale.jobDate', saleId, jobDate: TUE, jobStartTime: '13:00' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(pick(moved.body.hubJob, 'date', 'time'), { date: TUE, time: '13:00' });
  const [job] = jobsOf(w);
  assert.deepEqual([job.date, job.time, job.endTime], [TUE, '13:00', '16:00']);
  const sale = w.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual(pick(sale.handoff.job, 'status', 'ref', 'date', 'time', 'moved'), { status: 'created', ref: job.id, date: TUE, time: '13:00', moved: false }, 'linked by the move');
  assert.deepEqual([sale.jobDate, sale.jobStartTime], [TUE, '13:00']);
  // The phone's retry finds it linked; the Hub job, the admin card and the customer text agree on Tuesday.
  w.setClock(NOW + 5 * MIN);
  assert.deepEqual(pick((await w.book('sale', saleId)).body.booking, 'status', 'date', 'time', 'moved'), { status: 'booked', date: TUE, time: '13:00', moved: false });
  assert.equal(jobsOf(w).length, 1);
  const line = (await adminSales(w)).sales.find(row => row.id === saleId);
  assert.match(line.message, /Tuesday, October 27/);
  assert.equal(line.handoff.job.moved, false, 'no "booked at another time than the rep asked" banner');
});

test('integrity-merge-3: a date changed while the receipt could not be read is followed by the booking that finds the job', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch({ sale: { package: 'Quick Clear', slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } } });
  await w.send(events);
  const fault = loseAnswer(w, saleSave(saleId));
  await w.book('sale', saleId);
  // Still in the outage: only the sale's date changes, as before.
  w.setClock(NOW + MIN);
  const alone = await w.admin({ action: 'sale.jobDate', saleId, jobDate: TUE, jobStartTime: '13:00' });
  fault.heal();
  assert.deepEqual([alone.status, 'hubJob' in alone.body, jobsOf(w)[0].date], [200, false, MON]);
  // The phone's next try replays the receipt and moves the Hub job to the office's date.
  w.setClock(NOW + 5 * MIN);
  assert.deepEqual(pick((await w.book('sale', saleId)).body.booking, 'status', 'date', 'time', 'moved'), { status: 'booked', date: TUE, time: '13:00', moved: false });
  assert.deepEqual(pick(jobsOf(w)[0], 'date', 'time'), { date: TUE, time: '13:00' });
  const sale = w.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual([sale.jobDate, sale.handoff.job.date, sale.handoff.job.moved, sale.handoff.job.hubChange.status], [TUE, TUE, false, 'done']);
  assert.match(sale.statusHistory.at(-1).note, /^Hub job moved to 2026-10-27 13:00/);
});

test('integrity-merge-3: when the Hub refuses to follow the office\'s date, Admin shows both days (not "no crew was free"), and Try again moves it', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch({ sale: { package: 'Quick Clear' } });
  await w.send(events);
  let raced = false, refuse = true;
  w.wrapDispatch(store => ({ ...store, commit: async writes => {
    if (!raced && writes.some(saleSave(saleId))) {
      raced = true;
      assert.equal((await w.admin({ action: 'sale.jobDate', saleId, jobDate: TUE })).status, 200);
    }
    if (refuse && writes.some(item => item.collection === 'jobs' && item.revision && !item.patch?.recordType && item.patch?.date === TUE)) {
      throw Object.assign(new Error('Synthetic refusal: that crew is not free then.'), { code: 'dispatch_conflict', status: 409 });
    }
    return store.commit(writes);
  } }));
  const booked = await w.book('sale', saleId);
  assert.deepEqual(pick(booked.body.booking, 'status', 'date', 'moved'), { status: 'booked', date: MON, moved: false });
  const sale = w.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual([sale.jobDate, sale.handoff.job.date, sale.handoff.job.moved, sale.handoff.job.hubChange.action, sale.handoff.job.hubChange.status], [TUE, MON, false, 'move', 'failed']);
  assert.match(sale.handoff.job.hubChange.message, /^The Hub job is on Mon Oct 26 9:30 am, but this sale's job date is Tue Oct 27 9:30 am\. The Hub job could not move to Tue Oct 27 9:30 am: Synthetic refusal/);
  assert.doesNotMatch(sale.handoff.job.hubChange.message, /no crew was free/);
  // Try again (the banner's button: the same status) once the Hub takes it.
  refuse = false;
  const again = await w.admin({ action: 'sale.status', saleId, status: 'booked' });
  w.wrapDispatch(null);
  assert.deepEqual(pick(again.body.hub, 'action', 'status'), { action: 'move', status: 'done' });
  assert.deepEqual([jobsOf(w)[0].date, w.fake.get(`knock_sales/${saleId}`).handoff.job.date], [TUE, TUE]);
});

/* ---------- integrity-merge-5: whose record a door customer links to ---------- */

test('integrity-merge-5: names agree on a surname or a shorter name, never on a shared first name, a household word or nothing at all', async () => {
  for (const [hub, door, expected] of [['John Smith', 'John Doe', false], ['Mike Johnson', 'Mike Lee', false], ['Smith Family', 'Jones Family', false],
    ['The Smiths', 'The Joneses', false], ['Victim Existing', 'J', false], ['Victim Existing', 'Mrs', false], ['Victim Existing', 'Mrs.', false],
    ['Pat', 'Pat Smith', true], ['Pat Smith', 'Pat', true], ['Jo Synthetic', 'Pat Synthetic', true], ['Mary Smith', 'Mary Ann Smith', true],
    ['Smith, John', 'John Smith', true], ['The Smith Family', 'Smith', true], ['', 'J', true], ['', 'Anyone', true]]) {
    assert.equal(namesAgree(hub, door), expected, `${hub} / ${door}`);
  }
  const existing = { 'customers/customer_other_john': { name: 'John Existing', phone: '+19705550900', email: '', highlevelContactId: 'ghlOther1' } };
  for (const [name, expected] of [['John Newdoor', 'review'], ['J', 'review'], ['Mrs', 'review'], ['Jo Existing', 'booked']]) {
    const w = await bridgeWorld({ seed: existing });
    const { saleId, events } = saleBatch({ sale: { customer: { name, phone: '(970) 555-0900', email: 'door.buyer@example.com' } } });
    assert.deepEqual((await w.send(events)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
    const booked = await w.book('sale', saleId);
    assert.equal(booked.body.booking.status, expected, name);
    if (expected === 'review') {
      assert.deepEqual([w.fake.get(`knock_sales/${saleId}`).handoff.job.code, jobsOf(w).length], ['customer_identity_review', 0], name);
    } else assert.equal(jobsOf(w)[0].customerId, 'customer_other_john', 'a household links at once');
  }
});

/* ---------- integrity-merge-7: which door sale keeps a walkthrough off a house ---------- */

test('integrity-merge-7: only an open door sale blocks a walkthrough; a job done, or an earlier season\'s customer, leaves the house open', async () => {
  assert.equal(SOLD_OPEN_DAYS, 30);
  const sold = (status, jobDate) => ({ 'knock_sales/sale_earlier': { houseId: 'h-2902-blue-leaf-dr', repKey: 'rep.two', status, saleDate: '2025-09-01', jobDate, ticket: 900, package: 'Quick Clear',
    completedAt: status === 'booked' ? null : `${jobDate}T20:00:00.000Z`, paidAt: status === 'paid' ? `${jobDate}T21:00:00.000Z` : null } });
  for (const [status, jobDate, refused] of [['paid', '2025-09-08', false], ['completed', '2025-09-08', false], ['booked', '2025-09-08', false], ['completed', '2026-10-16', false],
    ['booked', '2026-09-19', false], ['booked', '2026-09-20', true], ['booked', MON, true]]) {
    const w = await bridgeWorld({ seed: sold(status, jobDate) });
    const result = await w.send(walkBatch().events);
    assert.deepEqual(result.body.results.map(row => row.code || row.status), refused ? ['applied', 'knock_house_sold', 'knock_walkthrough_invalid'] : ['applied', 'applied', 'applied'], `${status} ${jobDate}`);
  }
});

/* ---------- integrity-merge-8 and -9: a cancelled sale, reinstated ---------- */

test('integrity-merge-8: a sale cancelled during its booking makes no Hub customer; reinstated, it is booked at once', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  let once = false;
  w.wrapDispatch(store => ({ ...store, read: async (collection, docId) => {
    if (!once && collection === 'dispatchOperations') { once = true; assert.equal((await w.admin({ action: 'sale.status', saleId, status: 'cancelled' })).status, 200); }
    return store.read(collection, docId);
  } }));
  const refused = await w.book('sale', saleId);
  w.wrapDispatch(null);
  assert.deepEqual([refused.status, refused.body.code, jobsOf(w).length, w.docs('customers/').length], [409, 'knock_sale_cancelled', 0, 0], 'no job and no Hub customer');
  assert.deepEqual(pick(w.fake.get(`knock_sales/${saleId}`).handoff.job, 'mode', 'status'), { mode: 'hub', status: 'pending' });
  // The phone dropped it (a 409). The office reinstates it: it is booked then, not left pending with nothing booking it.
  const reinstated = await w.admin({ action: 'sale.status', saleId, status: 'booked' });
  assert.equal(reinstated.status, 200, JSON.stringify(reinstated.body));
  assert.deepEqual(pick(reinstated.body.hub, 'action', 'status', 'message'), { action: 'book', status: 'done', message: 'Booked: Crew 1, Mon Oct 26, 9:30 am' });
  assert.deepEqual([reinstated.body.sale.handoff.job.status, reinstated.body.sale.handoff.job.ref, jobsOf(w).length], ['created', jobsOf(w)[0].id, 1]);
  // One the office must review (another Hub customer's phone) keeps waiting for that review.
  const v = await bridgeWorld({ seed: { 'customers/customer_victim': { name: 'Victim Existing', phone: '+19705550900', email: '' } } });
  const other = saleBatch({ sale: { customer: { name: 'Pat Different Person', phone: '(970) 555-0900', email: 'pat.diff@example.com' } } });
  await v.send(other.events);
  assert.equal((await v.book('sale', other.saleId)).body.booking.status, 'review');
  await v.admin({ action: 'sale.status', saleId: other.saleId, status: 'cancelled' });
  const back = await v.admin({ action: 'sale.status', saleId: other.saleId, status: 'booked' });
  assert.deepEqual([back.status, 'hub' in back.body, back.body.sale.handoff.job.status, jobsOf(v).length], [200, false, 'review', 0]);
});

test('integrity-merge-9: a Hub failure the sale has since made moot is cleared, so a healthy job shows no "The Hub job needs you"', async () => {
  // No job yet: the check for one to cancel failed (dispatch down); the sale is reinstated and booked.
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  w.setDispatchDown(true);
  assert.deepEqual(pick((await w.admin({ action: 'sale.status', saleId, status: 'cancelled' })).body.hub, 'action', 'status'), { action: 'cancel', status: 'failed' });
  w.setDispatchDown(false);
  assert.deepEqual(pick((await w.admin({ action: 'sale.status', saleId, status: 'booked' })).body.hub, 'action', 'status'), { action: 'book', status: 'done' });
  const job = w.fake.get(`knock_sales/${saleId}`).handoff.job;
  assert.deepEqual([job.status, job.hubChange ?? null], ['created', null]);
  const again = await w.admin({ action: 'sale.status', saleId, status: 'booked' });
  assert.deepEqual([again.status, 'hub' in again.body], [200, false], 'Try again on a healthy job has nothing to do');
  // A booked job whose cancellation failed: the sale is reinstated, the Hub job was never cancelled, nothing needs the office.
  const v = await bridgeWorld();
  const other = saleBatch();
  await v.send(other.events);
  await v.book('sale', other.saleId);
  v.setDispatchDown(true);
  assert.equal((await v.admin({ action: 'sale.status', saleId: other.saleId, status: 'cancelled' })).body.hub.status, 'failed');
  v.setDispatchDown(false);
  const restored = await v.admin({ action: 'sale.status', saleId: other.saleId, status: 'booked' });
  assert.deepEqual(pick(restored.body.hub, 'action', 'status', 'message'), { action: 'cancel', status: 'done', message: 'Its Hub job is open.' });
  assert.deepEqual([jobsOf(v)[0].status, v.fake.get(`knock_sales/${other.saleId}`).handoff.job.hubChange.status], ['scheduled', 'done']);
  // The same after a reinstated sale's lost booking was booked by Book in Hub (the finding's path).
  const u = await bridgeWorld();
  const third = saleBatch();
  await u.send(third.events);
  u.setDispatchDown(true);
  await u.admin({ action: 'sale.status', saleId: third.saleId, status: 'cancelled' });
  const reinstated = await u.admin({ action: 'sale.status', saleId: third.saleId, status: 'booked' });
  assert.equal(reinstated.body.hub.status, 'failed', 'the booking could not reach the Hub either');
  assert.equal(u.fake.get(`knock_sales/${third.saleId}`).handoff.job.hubChange ?? null, null, 'the cancel check is moot');
  u.setDispatchDown(false);
  assert.equal((await u.admin({ action: 'sale.book', saleId: third.saleId })).body.booking.status, 'booked');
  assert.equal(u.fake.get(`knock_sales/${third.saleId}`).handoff.job.hubChange ?? null, null);
});
