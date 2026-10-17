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
  const second = await f.ui.save(draft('second', { customerId: 'c2', customer: 'Synthetic Customer c2' }));
  assert.deepEqual([second.crewId, [...second.assignedCrew]], ['crew_two', ['c2a']], 'Crew 1 is booked, so Crew 2 takes the same time');
  const third = await f.ui.save(draft('third', { customerId: 'c3', customer: 'Synthetic Customer c3' }));
  assert.deepEqual([third.crewId || null, [...third.assignedCrew]], [null, []], 'no crew free: the booking is still saved, unstaffed');
  assert.equal(f.rows.get(`jobs/${third.id}`).soldNeedsCrew?.reason, 'no_crew_free');
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
