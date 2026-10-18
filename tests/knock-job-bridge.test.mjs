import test from 'node:test';
import assert from 'node:assert/strict';
import { MON, NOW, SAT, TUE, MIN, busy, bridgeWorld, id, iso, saleBatch } from './helpers/knock-bridge-fixture.mjs';
import { call, get } from './helpers/knock-fixture.mjs';
import { customerSearchFields } from '../functions/_lib/customer-identity.js';
import { clockLabel, dayLabel, knockJobBridgeEnabled, namesAgree, nearestStart, repCrewSlots } from '../functions/_lib/knock-bridge.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { JOB_START_MINIMUM as POLICY_MINIMUM, JOB_START_POLICY_DATE as POLICY_DATE } from '../functions/_lib/job-start-policy.js';
import { JOB_START_MINIMUM, JOB_START_POLICY_DATE, PACKAGE_JOB_MINUTES, defaultJobStart, jobMinutes } from '../crew/knock-sale-rules.js';
import { DEFAULT_SETTINGS, PACKAGES } from '../crew/knock-settings.js';

// KNOCK-BRIDGE (EGC_KNOCK_JOB_BRIDGE; owner decisions D8, D2, D4, 2026-10-17): a door sale becomes a Hub customer and a
// crew job, idempotent on the sale id, never refused or lost because of scheduling. Synthetic data only.

const jobsOf = world => world.docs('jobs/').filter(row => !row.path.includes('_egc_schedule_lock_') && row.type);

test('flag, policy copies and package lengths', () => {
  assert.equal(knockJobBridgeEnabled({ EGC_KNOCK_JOB_BRIDGE: 'true' }), true);
  for (const value of ['TRUE', '1', 'yes', '', undefined]) assert.equal(knockJobBridgeEnabled({ EGC_KNOCK_JOB_BRIDGE: value }), false, String(value));
  assert.deepEqual([JOB_START_MINIMUM, JOB_START_POLICY_DATE], [POLICY_MINIMUM, POLICY_DATE], 'the phone copy matches the dispatch job-start policy');
  assert.equal(DEFAULT_SETTINGS.sale.defaultJobStartTime, '09:30');
  assert.equal(defaultJobStart({ sale: { defaultJobStartTime: '08:00' } }, MON), '09:30', 'a stored 8:00 default reads as 9:30 on policy dates');
  assert.equal(defaultJobStart({ sale: { defaultJobStartTime: '08:00' } }, '2026-10-10'), '08:00', 'older job dates keep their start');
  assert.deepEqual(Object.keys(PACKAGE_JOB_MINUTES).sort(), [...PACKAGES].sort(), 'every package has a booked length');
  for (const pkg of PACKAGES) assert.ok(jobMinutes(pkg) <= 450, `${pkg} fits a 9:30-5:00 day`);
  assert.equal(dayLabel(MON), 'Mon Oct 26');
  assert.deepEqual([clockLabel('09:30'), clockLabel('13:00'), clockLabel('12:15')], ['9:30 am', '1:00 pm', '12:15 pm']);
});

test('nearestStart: the asked time, else that day, else the nearest day; repCrewSlots carries nothing but the slot', () => {
  const row = (date, time, gapEnd, extra = {}) => ({ date, time, endDate: date, endTime: '', gapEndAt: new Date(Date.parse(`${date}T${gapEnd}:00-06:00`)).toISOString(), crewId: 'c', crewName: 'Crew 2', priority: 2, employeeIds: ['secret.person'], ...extra });
  const rows = [row(MON, '13:00', '17:00'), row(TUE, '09:30', '17:00', { crewName: 'Crew 1', priority: 1 })];
  assert.deepEqual(nearestStart(rows, { date: MON, time: '13:00', minutes: 180 }).time, '13:00');
  const sameDay = nearestStart(rows, { date: MON, time: '09:30', minutes: 180 });
  assert.deepEqual([sameDay.date, sameDay.time, sameDay.exact], [MON, '13:00', false], 'the same day wins over a free morning the next day');
  const nextDay = nearestStart(rows, { date: MON, time: '09:30', minutes: 420 });
  assert.deepEqual([nextDay.date, nextDay.time], [TUE, '09:30'], 'Monday afternoon is too short for a 7-hour job');
  assert.equal(nearestStart([], { date: MON, time: '09:30', minutes: 60 }), null);
  const slots = repCrewSlots(rows, { minutes: 180 });
  for (const slot of slots) assert.deepEqual(Object.keys(slot).sort(), ['crewLabel', 'date', 'endTime', 'priority', 'time']);
  assert.doesNotMatch(JSON.stringify(slots), /secret\.person|"c"/);
  assert.deepEqual(slots.slice(0, 2).map(slot => `${slot.date} ${slot.time}-${slot.endTime}`), [`${MON} 13:00-16:00`, `${MON} 14:00-17:00`]);
});

test('a door sale syncs, then books a Hub customer and a Crew 1 job at the picked slot, idempotent on the sale id', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch({ sale: { zip: '80528', city: 'Fort Collins', slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } } });
  const synced = await w.send(events);
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.deepEqual(synced.body.results.map(r => r.status), ['applied', 'applied', 'applied']);
  assert.deepEqual(synced.body.results[2].bridge, { kind: 'sale', status: 'pending' }, 'the sync never schedules: it tells the phone to book');
  const sale = w.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual(sale.address, { number: '2900', street: 'BLUE LEAF DR', unit: '', city: 'Fort Collins', state: 'CO', zip: '80528' });
  assert.deepEqual(sale.schedule, { source: 'slot', date: MON, time: '09:30', crewLabel: 'Crew 1', part: 'am' });
  assert.deepEqual(sale.handoff.job, { mode: 'hub', status: 'pending', ref: '', at: null, by: '' });
  assert.equal(jobsOf(w).length, 0);

  const booked = await w.book('sale', saleId);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.deepEqual(booked.body.booking, { kind: 'sale', id: saleId, status: 'booked', date: MON, time: '09:30', endTime: '16:30', crewLabel: 'Crew 1', moved: false, message: 'Booked: Crew 1, Mon Oct 26, 9:30 am' });
  const [job] = jobsOf(w);
  assert.equal(job.customerId, w.fake.get(`knock_sales/${saleId}`).handoff.job.customerId);
  assert.deepEqual([job.type, job.date, job.time, job.endTime, job.crewId, job.assignedCrew], ['job', MON, '09:30', '16:30', 'crew_one', ['crew.a1', 'crew.a2']]);
  assert.deepEqual([job.source, job.knockSaleId, job.ghlTags], ['door_to_door', saleId, ['egc-d2d-sale']]);
  assert.deepEqual(job.d2d, { kind: 'sale', repKey: 'rep.one', saleId, houseId: 'h-2900-blue-leaf-dr', contactSource: 'Door to door', at: iso(NOW) });
  assert.equal(job.address, '2900 Blue Leaf Dr, Fort Collins, CO 80528');
  assert.equal(job.estimatedDurationMin, 420, 'The Works is booked for 7 hours');
  assert.match(job.operationalScope.text, /^Sold at the door: The Works\./);
  assert.doesNotMatch(`${job.operationalScope.text} ${job.title}`, /\$|1600|1,600/, 'the crew-facing text has no price');
  assert.equal(job.createdBy, 'knock-bridge');
  const customer = w.fake.get(`customers/${job.customerId}`);
  assert.deepEqual([customer.name, customer.phone, customer.email], ['Pat Synthetic 2900', '+19705550900', 'pat2900@example.com']);
  assert.deepEqual(customer.acquisition, { channel: 'door_to_door', kind: 'sale', repKey: 'rep.one', saleId, houseId: 'h-2900-blue-leaf-dr', contactSource: 'Door to door', at: iso(NOW) });
  const linked = w.fake.get(`knock_sales/${saleId}`).handoff.job;
  assert.deepEqual([linked.mode, linked.status, linked.ref, linked.assignment, linked.crewLabel, linked.by], ['hub', 'created', job.id, 'assigned', 'Crew 1', 'knock-bridge']);

  // A repeat (a retry, a second phone tap, the next sync) answers the same booking and writes nothing.
  const writes = w.fake.calls.filter(call => call.path === ':commit').length;
  const again = await w.book('sale', saleId);
  assert.deepEqual(again.body.booking, booked.body.booking);
  assert.equal(w.fake.calls.filter(call => call.path === ':commit').length, writes);
  // A lost answer: the sale never learned its job. The dispatch receipt (request id = sale id) answers the same job.
  w.fake.put(`knock_sales/${saleId}`, { ...w.fake.get(`knock_sales/${saleId}`), handoff: { ...w.fake.get(`knock_sales/${saleId}`).handoff, job: { mode: 'hub', status: 'pending', ref: '', at: null, by: '' } } });
  const recovered = await w.book('sale', saleId);
  assert.deepEqual([recovered.body.booking.status, recovered.body.booking.crewLabel], ['booked', 'Crew 1']);
  assert.equal(jobsOf(w).length, 1, 'still one job');
  assert.equal(w.docs('customers/').length, 1, 'still one customer');
  // Replaying the whole batch from the phone is acknowledged without a second sale.
  assert.deepEqual((await w.send(events)).body.results.map(r => r.status), ['duplicate', 'duplicate', 'duplicate']);
  assert.equal(w.docs('knock_sales/').length, 1);
});

test('the picked slot is gone: Crew 2 the same time, else the nearest start, else saved without a crew; the sale is always kept', async () => {
  // Crew 1 is out all Monday: Crew 2 takes the 9:30 slot the rep picked.
  const w = await bridgeWorld({ seed: { 'jobs/busy_c1_mon': busy(MON, ['crew.a1', 'crew.a2'], { crewId: 'crew_one' }) } });
  const first = saleBatch({ sale: { slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } } });
  await w.send(first.events);
  const toCrew2 = await w.book('sale', first.saleId);
  assert.deepEqual([toCrew2.body.booking.status, toCrew2.body.booking.crewLabel, toCrew2.body.booking.date, toCrew2.body.booking.time, toCrew2.body.booking.moved], ['booked', 'Crew 2', MON, '09:30', false]);
  assert.equal(toCrew2.body.booking.message, 'Booked: Crew 2, Mon Oct 26, 9:30 am');

  // Both weekday crews are out Monday: the nearest start is Tuesday 9:30 with Crew 1, and the office is told it moved.
  const v = await bridgeWorld({ seed: { 'jobs/busy_c1_mon': busy(MON, ['crew.a1', 'crew.a2'], { crewId: 'crew_one' }), 'jobs/busy_c2_mon': busy(MON, ['crew.b1', 'crew.b2'], { crewId: 'crew_two' }) } });
  const second = saleBatch({ sale: { dayPart: 'am' } });
  await v.send(second.events);
  const moved = await v.book('sale', second.saleId);
  assert.deepEqual([moved.body.booking.status, moved.body.booking.crewLabel, moved.body.booking.date, moved.body.booking.time, moved.body.booking.moved], ['booked', 'Crew 1', TUE, '09:30', true]);
  const [job] = jobsOf(v).filter(row => row.knockSaleId === second.saleId);
  assert.match(job.opsNotes, /asked for Mon Oct 26 9:30 am; booked Tue Oct 27 9:30 am instead because no crew was free then\. Confirm the day with the customer\./);
  // The sale moves with its job, so the customer text and the refund cutoff name the booked day; the ask is kept.
  const movedSale = v.fake.get(`knock_sales/${second.saleId}`);
  assert.deepEqual([movedSale.jobDate, movedSale.jobStartTime, movedSale.schedule.date, movedSale.handoff.job.requested], [TUE, '09:30', MON, { date: MON, time: '09:30' }]);
  assert.match(movedSale.statusHistory.at(-1).note, /^Booked in the Hub for Tue Oct 27 9:30 am \(asked for Mon Oct 26 9:30 am\): no crew was free then\./);
  const admin = await call(v.h.admin.get, get('/api/knock-admin?view=sales', v.cookies.zac), v.env);
  const line = admin.body.sales.find(row => row.id === second.saleId);
  assert.match(line.message, /Tuesday, October 27/, 'the customer text names the booked day');
  assert.doesNotMatch(line.message, /Monday, October 26/);
  assert.equal(line.handoff.job.moved, true, 'the admin card says it moved');

  // No crew at all (none set up yet): booked on the asked day and time without a crew, flagged Sold: needs crew.
  const u = await bridgeWorld({ crews: false });
  const third = saleBatch({ sale: { slot: { date: MON, time: '10:00', crewLabel: 'Crew 1' }, jobStartTime: '10:00' } });
  await u.send(third.events);
  const unassigned = await u.book('sale', third.saleId);
  assert.deepEqual([unassigned.body.booking.status, unassigned.body.booking.crewLabel, unassigned.body.booking.date, unassigned.body.booking.time], ['needs_crew', '', MON, '10:00']);
  assert.equal(unassigned.body.booking.message, 'Booked: office will confirm the crew');
  const [waiting] = jobsOf(u);
  assert.deepEqual([waiting.assignedCrew, waiting.crewId, waiting.soldNeedsCrew.reason, waiting.status], [[], null, 'no_crew_free', 'scheduled']);
  assert.equal(u.fake.get(`knock_sales/${third.saleId}`).status, 'booked', 'the sale stands');
});

test('with crew auto-assign off the job waits for a manager (Sold: needs crew); dispatch trouble is retried, never lost', async () => {
  const w = await bridgeWorld({ autoCrew: false });
  const { saleId, events } = saleBatch();
  await w.send(events);
  w.setDispatchDown(true);
  const down = await w.book('sale', saleId);
  assert.equal(down.status, 200);
  assert.deepEqual([down.body.booking.status, down.body.booking.message, down.body.booking.retryAt], ['pending', 'Saved. Booking it with the office…', iso(NOW + MIN)]);
  const pending = w.fake.get(`knock_sales/${saleId}`).handoff.job;
  assert.deepEqual([pending.status, pending.code, pending.attempts, pending.retryAfter], ['retry', 'dispatch_storage_unavailable', 1, iso(NOW + MIN)]);
  assert.equal(jobsOf(w).length, 0);
  w.setDispatchDown(false);
  // The phone asking again before the wait is over is answered from the sale: no dispatch read at all.
  const reads = w.fake.calls.length;
  assert.deepEqual((await w.book('sale', saleId)).body.booking.status, 'pending');
  assert.equal(w.fake.calls.filter((call, index) => index >= reads && !call.path.startsWith('knock_') && !call.path.includes('knock_')).length, 0, 'only the sale was read');
  w.setClock(NOW + 2 * MIN);
  const booked = await w.book('sale', saleId);
  assert.deepEqual([booked.body.booking.status, booked.body.booking.date, booked.body.booking.time], ['needs_crew', MON, '09:30']);
  const [job] = jobsOf(w);
  assert.deepEqual([job.assignedCrew, job.soldNeedsCrew.reason, job.soldNeedsCrew.by], [[], 'auto_assign_off', 'knock-bridge']);
  assert.equal(job.crewAutoAssigned, undefined, 'no pick was asked for');
});

test('dates never before the earliest job date; a start before 9:30 is refused; 9:30 is accepted', async () => {
  const w = await bridgeWorld();
  const slots = await w.crewSlots(`?from=2026-10-21&package=${encodeURIComponent('Quick Clear')}`);
  assert.equal(slots.status, 200, JSON.stringify(slots.body));
  assert.equal(slots.body.earliestJobDate, SAT);
  assert.equal(slots.body.from, SAT, 'an earlier day asked for is moved to the earliest job date');
  assert.ok(slots.body.slots.length > 0);
  assert.ok(slots.body.slots.every(slot => slot.date >= SAT && slot.time >= '09:30' && slot.endTime <= '17:00'));
  assert.deepEqual(slots.body.slots[0], { date: SAT, time: '09:30', endTime: '12:30', crewLabel: 'Crew 3', priority: 3 }, 'Saturday is the weekend crew');
  assert.ok(slots.body.slots.some(slot => slot.date === MON && slot.crewLabel === 'Crew 1'));

  const early = saleBatch({ sale: { jobStartTime: '09:29' } });
  const refused = await w.send(early.events);
  assert.deepEqual([refused.body.results[2].status, refused.body.results[2].code], ['rejected', 'knock_sale_job_time']);
  const before = saleBatch({ n: 2902, sale: { jobDate: '2026-10-23' } });
  assert.equal((await w.send(before.events)).body.results[2].code, 'knock_sale_job_date', 'before the right to cancel ends');
  const ok = saleBatch({ n: 2904, sale: { jobStartTime: '09:30' } });
  assert.equal((await w.send(ok.events)).body.results[2].status, 'applied');
  // A stored sale the bridge books is never put before its earliest job date, whatever its job date or schedule says.
  const sale = w.fake.get(`knock_sales/${ok.saleId}`);
  w.fake.put(`knock_sales/${ok.saleId}`, { ...sale, jobDate: '2026-10-21', schedule: { ...sale.schedule, date: '2026-10-21' } });
  const booked = await w.book('sale', ok.saleId);
  assert.ok(booked.body.booking.date >= SAT, booked.body.booking.date);
});

test('reps see slots and bookings only: no roster, crew member, customer or job ids', async () => {
  const w = await bridgeWorld({ seed: { 'jobs/busy_c1_mon': busy(MON, ['crew.a1', 'crew.a2'], { crewId: 'crew_one', time: '12:00' }) } });
  const slots = await w.crewSlots(`?from=${MON}&days=2`);
  for (const slot of slots.body.slots) assert.deepEqual(Object.keys(slot).sort(), ['crewLabel', 'date', 'endTime', 'priority', 'time']);
  assert.deepEqual(Object.keys(slots.body).sort(), ['days', 'earliestJobDate', 'from', 'minutes', 'ok', 'serverTime', 'slots']);
  const text = JSON.stringify(slots.body);
  for (const secret of ['crew.a1', 'crew.b1', 'Andy', 'Other Synthetic', 'Elsewhere', 'crew_one', 'roster', 'employeeIds']) assert.equal(text.includes(secret), false, secret);
  const { saleId, events } = saleBatch();
  await w.send(events);
  const booked = await w.book('sale', saleId);
  assert.doesNotMatch(JSON.stringify(booked.body), /crew\.a|crew\.b|customer_|visit_|Andy|Bo /);
  const mine = await w.report('my-sales');
  const row = mine.body.sales.find(sale => sale.id === saleId);
  assert.deepEqual(row.handoff.job, { mode: 'hub', status: 'created', at: iso(NOW) });
  assert.deepEqual(row.hubJob, booked.body.booking);
  assert.doesNotMatch(JSON.stringify(mine.body), /visit_|customer_[0-9a-f]|crew_one|crew\.a/);
  assert.equal((await w.me()).body.viewer.jobBridge, true, 'the phone is told to offer slots, ZIP and Walkthrough set');
  // Another rep's sale is not theirs to book.
  assert.equal((await w.book('sale', saleId, w.cookies.two)).body.code, 'knock_sale_missing');
  assert.equal((await w.crewSlots('', '')).status, 401);
});

test('My money names each sale\'s Hub job: day, crew label and live status', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  await w.book('sale', saleId);
  const money = await w.report('my-money');
  assert.equal(money.status, 200, JSON.stringify(money.body));
  const line = money.body.sales.find(sale => sale.id === saleId);
  assert.deepEqual(line.job.live, { status: 'scheduled', date: MON, time: '09:30', crewLabel: 'Crew 1' });
  assert.equal(line.job.message, 'Booked: Crew 1, Mon Oct 26, 9:30 am');
  // A manager moves it to Tuesday by hand: My money reads the Hub, not the old booking.
  const [job] = jobsOf(w);
  w.fake.put(job.path, { ...w.fake.get(job.path.replace(/^/, '')), date: TUE, crewId: 'crew_two', crewAutoAssigned: null });
  const later = await w.report('my-money');
  assert.deepEqual(later.body.sales.find(sale => sale.id === saleId).job.live, { status: 'scheduled', date: TUE, time: '09:30', crewLabel: 'Crew assigned' });
});

test('an admin can book or retry from Admin > Sales; it needs the flag', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  const booked = await w.admin({ action: 'sale.book', saleId });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.equal(booked.body.booking.status, 'booked');
  assert.equal(booked.body.sale.handoff.job.ref, jobsOf(w)[0].id, 'the admin sees the Hub job id');
  const sales = await call_admin_sales(w);
  assert.equal(sales.sync.job, 'hub_job_linked');
  const off = await bridgeWorld({ bridge: false });
  assert.equal((await off.admin({ action: 'sale.book', saleId })).body.code, 'knock_bridge_off');
});

test('a sale made before the bridge (manual hand-off) is the office\'s: the rep cannot book it, an admin can', async () => {
  const off = await bridgeWorld({ bridge: false });
  const { saleId, events } = saleBatch();
  await off.send(events);
  const w = await bridgeWorld();
  w.fake.put(`knock_sales/${saleId}`, off.fake.get(`knock_sales/${saleId}`));
  const refused = await w.book('sale', saleId);
  assert.deepEqual([refused.status, refused.body.code], [409, 'knock_bridge_manual']);
  const booked = await w.admin({ action: 'sale.book', saleId });
  assert.deepEqual([booked.body.booking.status, booked.body.sale.handoff.job.mode], ['booked', 'hub']);
  assert.equal(jobsOf(w)[0].address, '2900 Blue Leaf Dr, CO', 'no town or ZIP was taken on a manual sale; the office completes it');
});

async function call_admin_sales(w) {
  const { call, get } = await import('./helpers/knock-fixture.mjs');
  const view = await call(w.h.admin.get, get('/api/knock-admin?view=sales', w.cookies.zac), w.env);
  assert.equal(view.body.integrations.job.mode, 'hub');
  return view.body.sales[0];
}

test('flag off: sync, sale records, knock-me and the new endpoints are exactly as before', async () => {
  const w = await bridgeWorld({ bridge: false });
  const { saleId, events } = saleBatch({ sale: { zip: '80528', city: 'Fort Collins', dayPart: 'am', slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } } });
  const synced = await w.send(events);
  assert.deepEqual(synced.body.results.map(r => Object.keys(r).sort().join()), ['id,status', 'id,status', 'id,status'], 'no bridge marker');
  const sale = w.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual(sale.address, { number: '2900', street: 'BLUE LEAF DR', unit: '' }, 'no town or ZIP');
  assert.equal(sale.schedule, undefined);
  assert.deepEqual(sale.handoff.job, { mode: 'manual', status: 'pending', ref: '', at: null, by: '' });
  assert.equal(jobsOf(w).length, 0);
  assert.equal(w.docs('customers/').length, 0);
  const me = await w.me();
  assert.deepEqual(Object.keys(me.body.viewer).sort(), ['admin', 'displayName', 'repKey', 'user', 'walkthrough']);
  for (const reply of [await w.book('sale', saleId), await w.crewSlots(), await w.walkSlots()]) assert.deepEqual([reply.status, reply.body.code], [404, 'knock_bridge_off']);
  const shiftId = id(), knockId = id();
  const walk = await w.send([{ id: id(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 20 * MIN) },
    { id: knockId, type: 'knock', shiftId, houseId: 'h-2902-blue-leaf-dr', outcome: 'walkthrough_set', at: iso(NOW - MIN) },
    { id: id(), type: 'walkthrough', knockId, houseId: 'h-2902-blue-leaf-dr', at: iso(NOW), customer: { name: 'Lee', phone: '9705550111' }, date: MON, dayPart: 'am', textConsent: false }]);
  assert.deepEqual(walk.body.results.map(r => r.code || r.status), ['applied', 'knock_outcome_invalid', 'knock_event_type']);
  const mySales = await w.report('my-sales');
  assert.equal('walkthroughs' in mySales.body, false);
  assert.equal('hubJob' in mySales.body.sales[0], false);
  const money = await w.report('my-money');
  assert.equal('job' in money.body.sales[0], false);
  const adminSales = await call(w.h.admin.get, get('/api/knock-admin?view=sales', w.cookies.zac), w.env);
  assert.equal('walkthroughs' in adminSales.body, false, 'no office walkthrough list');
  const cancelled = await w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.deepEqual([cancelled.status, 'hub' in cancelled.body, cancelled.body.sale.handoff.job], [200, false, { mode: 'manual', status: 'pending', ref: '', at: null, by: '' }]);
});

/* ---------- review fixes: lost answers, retries, admin changes, reads ---------- */

// The schedule keeps changing under the openings search (dispatch_snapshot_changed): a fault that clears by itself.
const restlessSchedule = store => ({ ...store, read: (collection, docId) => collection === 'dispatchState' ? Promise.resolve({ id: 'revision', revision: crypto.randomUUID() }) : store.read(collection, docId) });
// The dispatch save itself fails with `error` (thrown before anything is written).
const failingSave = error => store => ({ ...store, commit: writes => (writes.some(item => item.collection === 'jobs' && item.patch?.dispatchRequestId) ? Promise.reject(error) : store.commit(writes)) });

test('a lost sync answer: a replayed sale that is not booked yet is marked pending again; once booked it is not', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  assert.deepEqual((await w.send(events)).body.results[2].bridge, { kind: 'sale', status: 'pending' });
  // The phone never saw that answer and sends the batch again: the sale still needs booking, and the replay says so.
  const replay = await w.send(events);
  assert.deepEqual(replay.body.results.map(row => [row.status, row.bridge || null]), [['duplicate', null], ['duplicate', null], ['duplicate', { kind: 'sale', status: 'pending' }]]);
  assert.equal(w.docs('knock_sales/').length, 1);
  await w.book('sale', saleId);
  assert.deepEqual((await w.send(events)).body.results.map(row => Object.keys(row).sort().join()), ['id,status', 'id,status', 'id,status'], 'booked: a plain duplicate');
});

test('only a passing fault is retried, after a growing wait; anything else, or the eighth failed try, waits for the office', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  // The openings search fails: that is not "no crew free". Nothing is booked blind; it is retried a minute later.
  w.wrapDispatch(restlessSchedule);
  const first = await w.book('sale', saleId);
  assert.deepEqual([first.body.booking.status, first.body.booking.retryAt], ['pending', iso(NOW + MIN)]);
  assert.deepEqual(pick(w.fake.get(`knock_sales/${saleId}`).handoff.job, 'status', 'code', 'attempts'), { status: 'retry', code: 'dispatch_snapshot_changed', attempts: 1 });
  assert.equal(jobsOf(w).length, 0);
  w.setClock(NOW + 2 * MIN);
  const second = await w.book('sale', saleId);
  assert.equal(second.body.booking.retryAt, iso(NOW + 4 * MIN), 'the wait doubles');
  // The eighth failed try goes to the office instead of retrying for ever.
  const sale = w.fake.get(`knock_sales/${saleId}`);
  w.fake.put(`knock_sales/${saleId}`, { ...sale, handoff: { ...sale.handoff, job: { ...sale.handoff.job, attempts: 7 } } });
  w.setClock(NOW + 10 * MIN);
  const eighth = await w.book('sale', saleId);
  assert.deepEqual([eighth.body.booking.status, eighth.body.booking.message], ['review', 'Saved. The office will book the job.']);
  assert.deepEqual(pick(w.fake.get(`knock_sales/${saleId}`).handoff.job, 'status', 'code', 'error', 'retryAfter'),
    { status: 'review', code: 'dispatch_snapshot_changed', error: 'The Hub could not take this booking after 8 tries.', retryAfter: null });

  // A fault that does not clear by itself (here a bug with no code) goes straight to the office, and the phone's
  // later asks are answered from the sale without touching dispatch; the office's Book in Hub tries again.
  const v = await bridgeWorld();
  const other = saleBatch();
  await v.send(other.events);
  v.wrapDispatch(failingSave(new TypeError('synthetic bug')));
  const refused = await v.book('sale', other.saleId);
  assert.equal(refused.body.booking.status, 'review');
  assert.deepEqual(pick(v.fake.get(`knock_sales/${other.saleId}`).handoff.job, 'status', 'code', 'error'), { status: 'review', code: 'bridge_error', error: 'synthetic bug' });
  v.wrapDispatch(null);
  const before = v.fake.calls.length;
  assert.equal((await v.book('sale', other.saleId)).body.booking.status, 'review');
  assert.equal(v.fake.calls.slice(before).filter(row => !row.path.includes('knock_')).length, 0, 'the phone does not retry what the office must look at');
  const office = await v.admin({ action: 'sale.book', saleId: other.saleId });
  assert.deepEqual([office.status, office.body.booking.status], [200, 'booked']);
  assert.equal(jobsOf(v).length, 1);
});

test('an admin cancelling a booked sale cancels its Hub job, reinstating restores it, and a Hub failure never blocks the cancellation', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  await w.book('sale', saleId);
  const [job] = jobsOf(w);
  const cancelled = await w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(pick(cancelled.body.hub, 'action', 'status', 'message'), { action: 'cancel', status: 'done', message: 'Its Hub job was cancelled too.' });
  assert.deepEqual([w.fake.get(job.path).status, w.fake.get(job.path).cancelledBy, w.fake.get(job.path).cancellationReasonCode], ['cancelled', 'knock-bridge', 'customer_changed_plans']);
  assert.deepEqual([cancelled.body.sale.status, cancelled.body.sale.handoff.job.hubCancelled], ['cancelled', true]);
  const mine = await w.report('my-sales');
  assert.deepEqual(pick(mine.body.sales[0].hubJob, 'status', 'message'), { status: 'cancelled', message: 'The Hub job is cancelled.' });
  const reinstated = await w.admin({ action: 'sale.status', saleId, status: 'booked' });
  assert.deepEqual([reinstated.body.hub.status, w.fake.get(job.path).status, reinstated.body.sale.handoff.job.hubCancelled], ['done', 'scheduled', false]);

  // The Hub is down: the sale is still cancelled (the customer's right), the failure is saved and shown, and running
  // the cancellation again once the Hub is back cancels the job.
  w.setDispatchDown(true);
  const down = await w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.deepEqual([down.status, down.body.sale.status, down.body.hub.status], [200, 'cancelled', 'failed']);
  assert.match(down.body.hub.message, /^The Hub job could not be cancelled: .* Cancel it in Dispatch\.$/);
  assert.equal(w.fake.get(job.path).status, 'scheduled');
  assert.deepEqual(pick(w.fake.get(`knock_sales/${saleId}`).handoff.job, 'hubCancelled'), { hubCancelled: false });
  w.setDispatchDown(false);
  const again = await w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.deepEqual([again.body.hub.status, w.fake.get(job.path).status], ['done', 'cancelled']);
  // With the flag off the Hub is never touched.
  const off = await call(w.h.admin.post, (await import('./helpers/knock-fixture.mjs')).post('/api/knock-admin', { action: 'sale.status', saleId, status: 'booked' }, w.cookies.zac), { ...w.env, EGC_KNOCK_JOB_BRIDGE: '' });
  assert.deepEqual([off.status, 'hub' in off.body, w.fake.get(job.path).status], [200, false, 'cancelled']);
});

test('a new job date moves the Hub job first (the crew is picked again); a time the Hub cannot take is refused and nothing moves', async () => {
  const WED = '2026-10-28';
  const w = await bridgeWorld({ seed: { 'jobs/busy_c1_tue': busy(TUE, ['crew.a1', 'crew.a2'], { crewId: 'crew_one' }),
    'jobs/busy_c1_wed': busy(WED, ['crew.a1', 'crew.a2'], { crewId: 'crew_one' }), 'jobs/busy_c2_wed': busy(WED, ['crew.b1', 'crew.b2'], { crewId: 'crew_two' }) } });
  const { saleId, events } = saleBatch();
  await w.send(events);
  await w.book('sale', saleId);
  const [job] = jobsOf(w).filter(row => row.knockSaleId === saleId);
  assert.equal(job.crewId, 'crew_one');
  const moved = await w.admin({ action: 'sale.jobDate', saleId, jobDate: TUE });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const hub = w.fake.get(job.path);
  assert.deepEqual([hub.date, hub.time, hub.endTime, hub.crewId], [TUE, '09:30', '16:30', 'crew_two'], 'Crew 1 is out Tuesday: Crew 2 takes the job');
  assert.deepEqual([moved.body.sale.jobDate, moved.body.sale.handoff.job.date, moved.body.sale.handoff.job.crewLabel, moved.body.hubJob.message], [TUE, TUE, 'Crew 2', 'Booked: Crew 2, Tue Oct 27, 9:30 am']);
  assert.match(moved.body.sale.statusHistory.at(-1).note, /^Job date 2026-10-27; Hub job moved to 2026-10-27 09:30, Crew 2$/);
  // A manager then staffs it by hand: a move that crew cannot make is refused, and neither the sale nor its job moves.
  w.fake.put(job.path, { ...w.fake.get(job.path), crewAutoAssigned: null });
  const refused = await w.admin({ action: 'sale.jobDate', saleId, jobDate: WED });
  assert.deepEqual([refused.status, refused.body.code], [409, 'knock_hub_move_refused']);
  assert.match(refused.body.error, /^The Hub job could not move to Wed Oct 28 9:30 am: .* Pick another day or time, or move it in Dispatch\.$/);
  assert.deepEqual([w.fake.get(`knock_sales/${saleId}`).jobDate, w.fake.get(job.path).date], [TUE, TUE]);
  // The bridge's 9:30 rule holds for an admin's start too.
  assert.equal((await w.admin({ action: 'sale.jobDate', saleId, jobDate: TUE, jobStartTime: '09:00' })).body.code, 'knock_sale_job_time');
  // An auto-assigned job moved to a day no crew is free is never lost: it waits on that day as Sold: needs crew.
  const other = saleBatch({ n: 2902 });
  await w.send(other.events);
  await w.book('sale', other.saleId);
  const full = await w.admin({ action: 'sale.jobDate', saleId: other.saleId, jobDate: WED });
  assert.deepEqual([full.status, full.body.hubJob.assignment, full.body.hubJob.message], [200, 'unassigned', 'Booked: office will confirm the crew']);
  const waiting = jobsOf(w).find(row => row.knockSaleId === other.saleId);
  assert.deepEqual([waiting.date, waiting.assignedCrew, waiting.soldNeedsCrew.reason], [WED, [], 'no_crew_free']);
});

test('with windowed dispatch reads the door customer is matched through the search index, never a full customer scan', async () => {
  const existing = { name: 'Pat Synthetic 2900', phone: '+19705550900', email: 'pat2900@example.com', address: '2900 Blue Leaf Dr, Fort Collins, CO 80528' };
  const seedCustomer = { 'customers/customer_existing': { ...existing, ...customerSearchFields(existing) } };
  const w = await bridgeWorld({ env: { EGC_DISPATCH_WINDOWED_READS: 'true' }, seed: seedCustomer });
  const { saleId, events } = saleBatch();
  await w.send(events);
  const booked = await w.book('sale', saleId);
  assert.equal(booked.body.booking.status, 'booked', JSON.stringify(booked.body));
  assert.equal(jobsOf(w)[0].customerId, 'customer_existing', 'the same phone and email link the existing customer');
  assert.equal(w.fake.scans('customers').length, 0, 'no full customer scan');
  assert.ok(w.fake.queries('customers').length >= 1, 'keyed lookups instead');
  assert.equal(w.fake.get('customers/customer_existing').acquisition, undefined, 'an existing customer is linked, never changed');
  // Full reads (the default) scan as before.
  const v = await bridgeWorld({ seed: seedCustomer });
  const other = saleBatch();
  await v.send(other.events);
  await v.book('sale', other.saleId);
  assert.ok(v.fake.scans('customers').length >= 1);
  assert.equal(jobsOf(v)[0].customerId, 'customer_existing');
});

/* ---------- review fixes: which customer, which day, a cancelled sale, the price ---------- */

test('names agree when they share a word (titles aside); an empty name never contradicts', () => {
  assert.equal(namesAgree('Pat Synthetic 2900', 'Pat Synthetic 2900'), true);
  assert.equal(namesAgree('Jo Synthetic', 'Pat Synthetic'), true, 'a household');
  assert.equal(namesAgree('Patricia Smith', 'pat SMITH'), true);
  assert.equal(namesAgree('José Núñez', 'Jose Nunez'), true, 'accents aside');
  assert.equal(namesAgree('Victim Existing', 'Pat Different Person'), false);
  assert.equal(namesAgree('Mr. Lee Smith', 'Mr Ray Jones'), false, 'a title is not a shared name');
  assert.equal(namesAgree('', 'Pat Different Person'), true);
});

// REVIEW security-privacy-1: the bridge linked a door customer to an existing Hub customer by phone alone, so a typo or a
// shared phone put a crew job (and its HighLevel tags and note) on another person's record with nobody looking.
test('a door sale whose phone is another Hub customer\'s, under another name, waits for the office; its Book in Hub then links them', async () => {
  const victim = { 'customers/customer_victim': { name: 'Victim Existing', phone: '+19705550900', email: '', highlevelContactId: 'ghlVictim1' } };
  const w = await bridgeWorld({ seed: victim });
  const { saleId, events } = saleBatch({ sale: { customer: { name: 'Pat Different Person', phone: '(970) 555-0900', email: 'pat.diff@example.com' } } });
  await w.send(events);
  const review = await w.book('sale', saleId);
  assert.deepEqual([review.status, review.body.booking.status, review.body.booking.message], [200, 'review', 'Saved. The office will book the job.']);
  assert.doesNotMatch(JSON.stringify(review.body), /Victim|customer_victim|ghlVictim/, 'the rep learns nothing of the other customer');
  assert.equal(jobsOf(w).length, 0, 'no crew job on the other customer\'s record');
  assert.equal(w.docs('ghlScheduleMirror/').length, 0, 'nothing for HighLevel either');
  const job = w.fake.get(`knock_sales/${saleId}`).handoff.job;
  assert.deepEqual(pick(job, 'status', 'code', 'retryAfter'), { status: 'review', code: 'customer_identity_review', retryAfter: null });
  assert.match(job.error, /^This phone or email already belongs to a Hub customer with a different name\. .*Book in Hub again links them/);
  assert.doesNotMatch(job.error, /Victim/);
  // The phone asking again is answered from the sale; only the office decides.
  const before = w.fake.calls.length;
  assert.equal((await w.book('sale', saleId)).body.booking.status, 'review');
  assert.equal(w.fake.calls.slice(before).filter(row => !row.path.includes('knock_')).length, 0);
  // The office checked the customer and books it: now it links.
  const office = await w.admin({ action: 'sale.book', saleId });
  assert.deepEqual([office.status, office.body.booking.status], [200, 'booked']);
  assert.deepEqual([jobsOf(w).length, jobsOf(w)[0].customerId, w.docs('customers/').length], [1, 'customer_victim', 1]);

  // A household sharing the phone (same surname) links at once, as before.
  const v = await bridgeWorld({ seed: { 'customers/customer_family': { name: 'Jo Synthetic', phone: '+19705550900', email: '' } } });
  const family = saleBatch();
  await v.send(family.events);
  assert.equal((await v.book('sale', family.saleId)).body.booking.status, 'booked');
  assert.equal(jobsOf(v)[0].customerId, 'customer_family');
  // An admin's first Book in Hub is checked too: the review is what tells the office.
  const u = await bridgeWorld({ seed: victim });
  const first = saleBatch({ sale: { customer: { name: 'Pat Different Person', phone: '(970) 555-0900', email: 'pat.diff@example.com' } } });
  await u.send(first.events);
  assert.equal((await u.admin({ action: 'sale.book', saleId: first.saleId })).body.booking.status, 'review');
  assert.equal(jobsOf(u).length, 0);
});

// REVIEW integrity-races-1: the bridge booked from the rep's original pick (schedule), so a date the office set on a sale
// not in the Hub yet was ignored, then overwritten with the old one and a history note claiming no crew was free.
test('the office moves a sale not booked yet: the Hub job is booked on the office\'s day, and nothing claims no crew was free', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch({ sale: { package: 'Quick Clear', slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } } });
  await w.send(events);
  const moved = await w.admin({ action: 'sale.jobDate', saleId, jobDate: TUE, jobStartTime: '13:00' });
  assert.deepEqual([moved.status, 'hubJob' in moved.body, moved.body.sale.jobDate], [200, false, TUE], 'no Hub job to move yet');
  const booked = await w.admin({ action: 'sale.book', saleId });
  assert.deepEqual(pick(booked.body.booking, 'status', 'date', 'time', 'crewLabel', 'moved'), { status: 'booked', date: TUE, time: '13:00', crewLabel: 'Crew 1', moved: false });
  const [job] = jobsOf(w);
  assert.deepEqual([job.date, job.time, job.endTime], [TUE, '13:00', '16:00']);
  assert.match(job.opsNotes, /The rep asked for Mon Oct 26 9:30 am; the office set Tue Oct 27 1:00 pm\./);
  const sale = w.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual([sale.jobDate, sale.jobStartTime, sale.schedule.date, sale.schedule.time], [TUE, '13:00', MON, '09:30'], 'the office\'s day stands; the rep\'s ask is kept');
  assert.doesNotMatch(sale.statusHistory.map(row => row.note || '').join('\n'), /no crew was free/);

  // The office moves it while the phone's booking is in flight (just before the job is saved): the office's day is never
  // overwritten, the history says where the Hub job is, and setting the day again moves the job (it is linked now).
  const v = await bridgeWorld();
  const other = saleBatch({ sale: { package: 'Quick Clear' } });
  await v.send(other.events);
  let raced = false;
  v.wrapDispatch(store => ({ ...store, commit: async writes => {
    if (!raced && writes.some(item => item.collection === 'jobs' && item.patch?.dispatchRequestId === other.saleId)) {
      raced = true;
      assert.equal((await v.admin({ action: 'sale.jobDate', saleId: other.saleId, jobDate: TUE })).status, 200);
    }
    return store.commit(writes);
  } }));
  const inFlight = await v.book('sale', other.saleId);
  v.wrapDispatch(null);
  assert.deepEqual([inFlight.body.booking.status, inFlight.body.booking.date], ['booked', MON]);
  const kept = v.fake.get(`knock_sales/${other.saleId}`);
  assert.deepEqual([kept.jobDate, kept.handoff.job.date], [TUE, MON]);
  assert.equal(kept.statusHistory.at(-1).note, 'Booked in the Hub for Mon Oct 26 9:30 am before the job date changed to Tue Oct 27 9:30 am. Set the job date again to move the Hub job, or move it in Dispatch.');
  const again = await v.admin({ action: 'sale.jobDate', saleId: other.saleId, jobDate: TUE });
  assert.deepEqual([again.status, again.body.hubJob?.date, jobsOf(v)[0].date], [200, TUE, TUE]);
});

// REVIEW integrity-races-3: a sale cancelled while its booking was in flight kept a scheduled Hub job (a crew sent to a
// customer who used the right to cancel), and nothing showed it.
test('a sale cancelled while its booking is in flight never keeps a live Hub job', async () => {
  const cancel = w => saleId => w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  // Cancelled during the search: no job is made at all.
  const a = await bridgeWorld();
  const early = saleBatch();
  await a.send(early.events);
  let once = false;
  a.wrapDispatch(store => ({ ...store, read: async (collection, docId) => {
    if (!once && collection === 'dispatchOperations') { once = true; assert.equal((await cancel(a)(early.saleId)).status, 200); }
    return store.read(collection, docId);
  } }));
  const refused = await a.book('sale', early.saleId);
  assert.deepEqual([refused.status, refused.body.code], [409, 'knock_sale_cancelled']);
  assert.equal(jobsOf(a).length, 0);

  // Cancelled just before the job is saved: the job just saved is cancelled with the sale.
  const b = await bridgeWorld();
  const late = saleBatch();
  await b.send(late.events);
  let raced = false;
  b.wrapDispatch(store => ({ ...store, commit: async writes => {
    if (!raced && writes.some(item => item.collection === 'jobs' && item.patch?.dispatchRequestId === late.saleId)) {
      raced = true;
      const answer = await cancel(b)(late.saleId);
      assert.deepEqual([answer.status, 'hub' in answer.body], [200, false], 'the Hub has no job for it yet');
    }
    return store.commit(writes);
  } }));
  const answer = await b.book('sale', late.saleId);
  b.wrapDispatch(null);
  assert.deepEqual([answer.status, answer.body.booking.status, answer.body.booking.message], [200, 'cancelled', 'The Hub job is cancelled.']);
  const [job] = jobsOf(b);
  assert.deepEqual([job.status, job.cancelledBy, job.cancellationReasonCode], ['cancelled', 'knock-bridge', 'customer_changed_plans']);
  assert.deepEqual(pick(b.fake.get(`knock_sales/${late.saleId}`).handoff.job, 'status', 'hubCancelled'), { status: 'created', hubCancelled: true });
  assert.equal(b.fake.get(`knock_sales/${late.saleId}`).status, 'cancelled');

  // The job was saved but the sale never learned it (a lost answer), and the office cancels during the retry wait:
  // the cancellation finds the job by its dispatch receipt and cancels it.
  const c = await bridgeWorld();
  const lost = saleBatch();
  await c.send(lost.events);
  await c.book('sale', lost.saleId);
  const unlinked = sale => ({ ...sale, handoff: { ...sale.handoff, job: { mode: 'hub', status: 'retry', code: 'dispatch_outcome_unknown', attempts: 1, retryAfter: iso(NOW + MIN), ref: '' } } });
  c.fake.put(`knock_sales/${lost.saleId}`, unlinked(c.fake.get(`knock_sales/${lost.saleId}`)));
  const office = await cancel(c)(lost.saleId);
  assert.deepEqual([office.status, office.body.hub?.action, office.body.hub?.status, office.body.hub?.message], [200, 'cancel', 'done', 'Its Hub job was cancelled too.']);
  assert.equal(jobsOf(c)[0].status, 'cancelled');
  assert.deepEqual(pick(c.fake.get(`knock_sales/${lost.saleId}`).handoff.job, 'status', 'ref', 'hubCancelled'), { status: 'created', ref: jobsOf(c)[0].id, hubCancelled: true });

  // Cancelled before that lost save (nothing to find then): the phone's next try records the job and cancels it.
  const d = await bridgeWorld();
  const orphan = saleBatch();
  await d.send(orphan.events);
  await d.book('sale', orphan.saleId);
  d.fake.put(`knock_sales/${orphan.saleId}`, { ...unlinked(d.fake.get(`knock_sales/${orphan.saleId}`)), status: 'cancelled', cancelledAt: iso(NOW) });
  d.setClock(NOW + 2 * MIN);
  const retried = await d.book('sale', orphan.saleId);
  assert.deepEqual([retried.status, retried.body.booking.status], [200, 'cancelled']);
  assert.equal(jobsOf(d)[0].status, 'cancelled');
  // A cancelled sale that never had a job is still refused, as before.
  const e = await bridgeWorld();
  const plain = saleBatch();
  await e.send(plain.events);
  await cancel(e)(plain.saleId);
  assert.deepEqual([(await e.book('sale', plain.saleId)).body.code, jobsOf(e).length], ['knock_sale_cancelled', 0]);
});

// REVIEW requirements-1: the door sale's price never reached the Hub job, so every D2D deal the HighLevel mirror created
// was worth $0.
test('the Hub job carries the price signed at the door as its quoted price; crews never see it', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch({ sale: { ticket: 2400.5 } });
  await w.send(events);
  await w.book('sale', saleId);
  const [job] = jobsOf(w);
  assert.deepEqual([job.priceQuoted, job.total, job.estimate], [2400.5, undefined, undefined], 'the quoted price only: no estimate or total is invented');
  const { path: _path, ...stored } = job;
  assert.doesNotMatch(JSON.stringify(crewJobProjection({ ...stored, id: job.path.split('/').pop() })), /2400|priceQuoted/, 'the crew\'s view of the job has no price');
  assert.doesNotMatch(JSON.stringify((await w.book('sale', saleId)).body), /2400/, 'the rep\'s booking answer carries no price');
});

function pick(row, ...keys) {
  return Object.fromEntries(keys.map(key => [key, row?.[key]]));
}
