import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { customerResolveHandler } from '../functions/api/customer-resolve.js';

// D2D-BOARD (owner 2026-10-17): the Hub's older booking forms (employee-booking.js) default to Any crew when
// EGC_DISPATCH_CREW_AUTO_ASSIGN is on: a service job saved with nobody chosen asks the server for the first free crew.
// Real /api/dispatch handlers over an in-memory store; synthetic people only. 2026-10-19 is a Monday, 2026-10-24 a Saturday.
const source = readFileSync(new URL('../employee-booking.js', import.meta.url), 'utf8');
const owner = { user: 'zacb', role: 'owner', businessAccess: true };
const AUTO = { EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' }, MON = '2026-10-19', SAT = '2026-10-24', NOW = '2026-10-17T15:00:00.000Z';
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const crew = (id, name, memberIds, extra) => ({ id, recordType: 'crew', name, memberIds, leadId: memberIds[0], status: 'active', revision: `${id}-r`, ...extra });

function fixture(env) {
  const rows = new Map([
    ...['c1', 'c2', 'c3', 'c4'].map((id, index) => [`customers/${id}`, { id, revision: `${id}-r`, name: `Synthetic Customer ${id}`, phone: `970555010${index}`, email: `synthetic.${id}@example.invalid`, address: `${index + 1} Synthetic Way` }]),
    ...[crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS, code: 'crew-1' }), crew('crew_two', 'Crew 2', ['c2a'], { priority: 2, serviceDays: WEEKDAYS, code: 'crew-2' }),
      crew('crew_three', 'Crew 3', ['c3a'], { priority: 3, serviceDays: ['sat', 'sun'], code: 'crew-3' })].map(row => [`dispatchResources/${row.id}`, row]),
  ]);
  const posts = [], storage = {};
  let revision = 0;
  const scan = collection => [...rows].filter(([key]) => key.startsWith(collection + '/')).map(([, row]) => structuredClone(row));
  const roster = ['zacb', 'c1a', 'c1b', 'c2a', 'c3a', 'est.one'].map(id => ({ id, name: `Synthetic ${id}`, role: id === 'zacb' ? 'owner' : 'crew' }));
  const store = { read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null), roster: async () => structuredClone(roster), jobs: async () => scan('jobs'), customers: async () => scan('customers'), recurringPlans: async () => [], resources: async () => scan('dispatchResources'),
    commit: async writes => {
      for (const write of writes) { const current = rows.get(`${write.collection}/${write.id}`); if (write.revision ? current?.revision !== write.revision : Boolean(current)) throw Object.assign(new Error('Changed'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
    } };
  const routes = dispatchHandlers({ session: async () => owner, storage: () => store, now: () => new Date(NOW) }), customer = customerResolveHandler({ session: async () => owner, storage: () => store });
  const sessionStorage = { getItem: key => storage[key] ?? null, setItem: (key, value) => { storage[key] = String(value); }, removeItem: key => { delete storage[key]; } };
  sessionStorage.setItem('egc_u', 'zacb');
  const context = { URLSearchParams, Date, Intl, Promise, Set, Map, Error, JSON, crypto, AbortSignal, sessionStorage, addEventListener() {},
    fetch: async (path, options = {}) => {
      const request = new Request('https://easygaragecleaning.com' + path, { ...options, headers: { Origin: 'https://easygaragecleaning.com', ...(options.headers || {}) } });
      if (options.body && path.startsWith('/api/dispatch')) posts.push(JSON.parse(options.body));
      if (path.startsWith('/api/customer-resolve')) return customer({ request, env });
      if (path.startsWith('/api/recurring-plans')) return Response.json({ ok: true, enabled: false });
      return routes[options.method === 'POST' ? 'post' : 'get']({ request, env });
    } };
  context.window = context;
  vm.runInNewContext(source, context);
  return { ui: context.EGCBooking, posts, rows };
}
const draft = (id, changes = {}) => ({ id, type: 'job', customerId: 'c1', customer: 'Synthetic Customer', date: MON, time: '10:00', endTime: '12:00', assignedCrew: [], crewNeeded: 1, ...changes });

test('flag on: a service job with nobody chosen asks for the first free crew: Crew 1, then Crew 2, then none; Saturday is Crew 3', async () => {
  const f = fixture(AUTO);
  const first = await f.ui.save(draft('first'));
  assert.equal(f.posts.at(-1).autoCrew, true);
  assert.deepEqual([first.crewId, [...first.assignedCrew].sort()], ['crew_one', ['c1a', 'c1b']]);
  assert.equal(first.crewNotice, 'Crew 1 was assigned automatically.', 'the booking dialog says which crew the server picked');
  assert.equal(Object.keys(first).includes('crewNotice'), false, 'the notice never enters job caches');
  const second = await f.ui.save(draft('second', { customerId: 'c2', customer: 'Synthetic Customer c2' }));
  assert.deepEqual([second.crewId, [...second.assignedCrew]], ['crew_two', ['c2a']], 'Crew 1 is booked, so Crew 2 takes the same time');
  const third = await f.ui.save(draft('third', { customerId: 'c3', customer: 'Synthetic Customer c3' }));
  assert.deepEqual([third.crewId || null, [...third.assignedCrew]], [null, []], 'no crew free: the booking is still saved, unstaffed');
  assert.equal(f.rows.get(`jobs/${third.id}`).soldNeedsCrew?.reason, 'no_crew_free');
  assert.match(third.crewNotice, /^No crew is free then, so it was saved without a crew/);
  const saturday = await f.ui.save(draft('saturday', { date: SAT }));
  assert.equal(saturday.crewId, 'crew_three', 'the weekend crew on Saturday');
});

test('flag on: walkthroughs, blocks and people a manager chose never ask for a crew', async () => {
  const f = fixture(AUTO);
  const visit = await f.ui.save(draft('visit', { type: 'walkthrough', assignedCrew: ['est.one'], time: '09:00', endTime: '10:00' }));
  assert.equal('autoCrew' in f.posts.at(-1), false);
  assert.deepEqual([...visit.assignedCrew], ['est.one']);
  await f.ui.save(draft('unstaffed-visit', { type: 'walkthrough', time: '13:00', endTime: '14:00' }));
  assert.equal('autoCrew' in f.posts.at(-1), false, 'an unstaffed walkthrough waits for an estimator');
  const chosen = await f.ui.save(draft('chosen', { assignedCrew: ['c2a'] }));
  assert.equal('autoCrew' in f.posts.at(-1), false);
  assert.deepEqual([chosen.crewId || null, [...chosen.assignedCrew]], [null, ['c2a']]);
  await f.ui.save(draft('block', { type: 'blocked', customerId: undefined, customer: 'Truck maintenance', time: '15:00', endTime: '16:00' }));
  assert.equal('autoCrew' in f.posts.at(-1), false);
});

test('flag off: the booking request is exactly as before, with no crew pick', async () => {
  const f = fixture({});
  const saved = await f.ui.save(draft('legacy'));
  const body = f.posts.at(-1);
  assert.equal('autoCrew' in body, false);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'changes', 'customerId', 'kind', 'requestId']);
  assert.deepEqual([saved.crewId || null, [...saved.assignedCrew]], [null, []]);
  assert.equal(f.rows.get(`jobs/${saved.id}`).soldNeedsCrew, undefined);
});

test('flag on: changing a saved job never asks for a crew, so a job left unstaffed stays unstaffed when it moves', async () => {
  const f = fixture(AUTO);
  const staffed = await f.ui.save(draft('first'));
  await f.ui.save(draft('second', { customerId: 'c2', customer: 'Synthetic Customer c2' }));
  const third = await f.ui.save(draft('third', { customerId: 'c3', customer: 'Synthetic Customer c3' }));
  assert.deepEqual([third.crewId || null, [...third.assignedCrew]], [null, []]);
  // An owner moves the unstaffed job to Tuesday, when Crew 1 is free: it is still saved as left, with nobody on it.
  const moved = await f.ui.save({ ...third, date: '2026-10-20', endDate: '2026-10-20' }, third);
  const body = f.posts.at(-1);
  assert.deepEqual([body.action, 'autoCrew' in body], ['schedule.update', false]);
  assert.deepEqual([moved.date, moved.crewId || null, [...moved.assignedCrew], moved.crewNotice], ['2026-10-20', null, [], '']);
  // A job the server staffed keeps its crew on another weekday it works...
  const tuesday = await f.ui.save({ ...staffed, date: '2026-10-20', endDate: '2026-10-20', time: '13:00', endTime: '15:00' }, staffed);
  assert.equal('autoCrew' in f.posts.at(-1), false);
  assert.equal(tuesday.crewId, 'crew_one');
  // ...and the server alone re-picks it when it moves to a day its crew does not work (owner rule D4).
  const saturday = await f.ui.save({ ...tuesday, date: SAT, endDate: SAT }, tuesday);
  assert.equal('autoCrew' in f.posts.at(-1), false);
  assert.equal(saturday.crewId, 'crew_three');
});

test('flag on: a manager may turn the crew pick off for one new booking; the dialogs learn the setting from the roster read', async () => {
  const f = fixture(AUTO);
  assert.deepEqual({ ...f.ui.crewAuto() }, { on: false, booker: false }, 'unknown until Dispatch answers');
  await f.ui.roster();
  assert.deepEqual({ ...f.ui.crewAuto() }, { on: true, booker: false });
  const kept = await f.ui.save(draft('manual', { autoCrew: false }));
  assert.equal('autoCrew' in f.posts.at(-1), false);
  assert.deepEqual([kept.crewId || null, [...kept.assignedCrew], kept.crewNotice], [null, [], '']);
  assert.equal(f.rows.get(`jobs/${kept.id}`).soldNeedsCrew, undefined, 'a deliberately unstaffed booking is not flagged as needing a crew');
  // A recurring series asks for each new visit the same way: opted out, none of them is staffed.
  const series = await f.ui.saveSeries(draft('weekly', { customerId: 'c2', customer: 'Synthetic Customer c2', recurrence: 'weekly', autoCrew: false }), {}, { operationKey: 'weekly' });
  assert.ok(series.visits.length > 1);
  assert.ok(series.visits.every(visit => !visit.crewId && !visit.assignedCrew.length));
  assert.ok(f.posts.filter(post => post.action === 'schedule.create').slice(1).every(post => !('autoCrew' in post)));
  const off = fixture({});
  await off.ui.roster();
  assert.deepEqual({ ...off.ui.crewAuto() }, { on: false, booker: false });
});
