import test from 'node:test';
import assert from 'node:assert/strict';
import { MON, NOW, SAT, TUE, MIN, busy, bridgeWorld, id, iso, saleBatch } from './helpers/knock-bridge-fixture.mjs';
import { clockLabel, dayLabel, knockJobBridgeEnabled, nearestStart, repCrewSlots } from '../functions/_lib/knock-bridge.js';
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
  assert.equal(v.fake.get(`knock_sales/${second.saleId}`).jobDate, MON, 'the signed sale keeps the agreed day; the booking says where it landed');

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
  assert.deepEqual([down.body.booking.status, down.body.booking.message], ['pending', 'Saved. Booking it with the office…']);
  const pending = w.fake.get(`knock_sales/${saleId}`).handoff.job;
  assert.deepEqual([pending.status, pending.code, pending.attempts], ['retry', 'dispatch_storage_unavailable', 1]);
  assert.equal(jobsOf(w).length, 0);
  w.setDispatchDown(false);
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
  // A stored sale the bridge books is never put before its earliest job date, whatever its schedule says.
  const sale = w.fake.get(`knock_sales/${ok.saleId}`);
  w.fake.put(`knock_sales/${ok.saleId}`, { ...sale, schedule: { ...sale.schedule, date: '2026-10-21' } });
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
});
