import assert from 'node:assert/strict';
import { vaultFirestore, staffEnv, cookieFor, seedAccount, login, ORIGIN } from './vault-fixture.mjs';
import * as hubAuth from '../../functions/api/hub-auth.js';
import * as operations from '../../functions/api/operations.js';
import { staffRolesHandlers } from '../../functions/api/staff-roles.js';
import { dispatchHandlers } from '../../functions/api/dispatch.js';
import { dispatchOpeningsHandlers } from '../../functions/api/dispatch-openings.js';
import { dispatchSearchHandlers } from '../../functions/api/dispatch-search.js';
import { dispatchTravelHandlers } from '../../functions/api/dispatch-travel.js';
import { timesheetHandlers } from '../../functions/api/timesheets.js';
import { handoffHandlers } from '../../functions/api/walkthrough-handoff.js';
import { customerResolveHandler } from '../../functions/api/customer-resolve.js';
import { moneyHandlers } from '../../functions/api/money.js';
import { staffDirectoryHandlers } from '../../functions/api/staff-directory.js';
import { recordWalkthroughVisit, walkthroughVisitState } from '../../functions/_lib/walkthrough-visit.js';
import { getHubSession } from '../../functions/_lib/hub-session.js';

// AUTH-ROLES: every staff kind against every endpoint the role model governs, through the real
// handlers and real signed sessions (configured users and sealed employee accounts). Synthetic
// data only; the clock is fixed; every request id is fixed so responses are byte-comparable.
export const NOW = '2026-09-22T15:00:00.000Z';
export const OPS_SECRET = 'synthetic-auth-roles-operations-signing-secret-0123456789';
// Configured (HUB_AUTH_USERS_JSON) staff outside the business users, with owner-set roles.
export const CONFIGURED = {
  'Config.Manager': { passwordHash: 'unused-synthetic-config-manager-hash', role: 'crew', displayName: 'Synthetic Config Manager', staffRoles: ['manager'] },
  'Config.Phone': { passwordHash: 'unused-synthetic-config-phone-hash', role: 'crew', displayName: 'Synthetic Config Phone', staffRoles: ['phone'] },
};
// Sealed employee accounts: stored roles, none, a signed sales invitation, and a claimed owner role.
export const EMPLOYEES = {
  'Mgr.Account': { extra: { staffRoles: ['manager'] } }, 'Sales.Account': { extra: { staffRoles: ['sales'] } }, 'Phone.Account': { extra: { staffRoles: ['phone'] } },
  'Lead.Account': { extra: { staffRoles: ['crew_lead'] } }, 'Crew.Account': {}, 'Legacy.Sales': { sales: true }, 'Owner.Claim': { extra: { staffRoles: ['owner'] } },
};
export const ACCOUNTS = ['ZacB', 'TylerG', 'AlexK', 'Crew.Static', ...Object.keys(CONFIGURED), ...Object.keys(EMPLOYEES)];

// The sealed stored manager the staff directory probes demote. It is not a probe account, so its demotion changes no
// other probe's answer; seedDirectoryTarget returns a reset that restores the vault as seeded, so every flag mode
// demotes a fresh record.
export const DIRECTORY_TARGET = 'Directory.Target';
export async function seedDirectoryTarget(env, fire) {
  await seedAccount(env, DIRECTORY_TARGET, { extra: { staffRoles: ['manager'] } });
  const seeded = [...fire.documents].map(([key, doc]) => [key, structuredClone(doc)]);
  return () => { fire.documents.clear(); for (const [key, doc] of seeded) fire.documents.set(key, structuredClone(doc)); };
}

export async function staffSessions(t, extra = {}, users = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const fire = vaultFirestore(t), env = staffEnv({ EGC_OPERATIONS_ENABLED: 'false', ...extra }, { ...CONFIGURED, ...users });
  for (const [user, options] of Object.entries(EMPLOYEES)) await seedAccount(env, user, options);
  const cookies = {};
  for (const user of ['ZacB', 'TylerG', 'AlexK', 'Crew.Static', ...Object.keys(CONFIGURED), ...Object.keys(users)]) cookies[user] = await cookieFor(env, user);
  for (const user of Object.keys(EMPLOYEES)) cookies[user] = (await login(env, user)).cookie;
  return { env, cookies, fire };
}

// A fresh in-memory Hub store per request: revision per write, compare-and-set, the whole commit or nothing.
export function memoryStore(env = {}) {
  const rows = new Map(Object.entries({
    'customers/c1': { id: 'c1', name: 'Synthetic Customer', phone: '9705550100', email: 'synthetic.customer@example.invalid', address: '100 Fixture Lane', revision: 'c1r' },
    'jobs/job-crewed': { id: 'job-crewed', revision: 'jr1', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', title: 'Synthetic garage reset', date: '2026-09-25', endDate: '2026-09-25', time: '09:00', endTime: '11:00', assignedCrew: ['crew.one'], assignedTo: 'crew.one', crewNeeded: 1, jobInstructions: 'Synthetic scope', scheduleSource: 'egc_hub', createdBy: 'zacb' },
    'jobs/walk-1': { id: 'walk-1', revision: 'wr1', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', date: '2026-09-22', endDate: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['someone.else'], projectId: 'project_walk-1', scheduleSource: 'egc_hub' },
    'jobs/job-costed': { id: 'job-costed', revision: 'mr1', type: 'job', status: 'completed', customerId: 'c1', customer: 'Synthetic Customer', date: '2026-09-20', total: 900, estimate: { number: 'EST-000001', status: 'accepted', amount: 900, depositRequired: 450 } },
  }));
  let n = 0;
  const clone = value => structuredClone(value);
  const all = collection => [...rows].filter(([key]) => key.startsWith(`${collection}/`)).map(([, row]) => clone(row));
  const roster = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew.one', name: 'Synthetic Crew One', role: 'crew' }];
  const store = {
    env, rows,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(roster), laborRecords: async () => all('jobLaborCosts'),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) ?? null),
    assigned: async (session, job) => (job.assignedCrew || []).includes(String(session.user).toLowerCase()),
    activeShift: async () => null,
    async commit(writes) {
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...clone(write.patch), id: write.id, revision: `r${++n}` });
    },
  };
  return store;
}

const at = () => new Date(NOW);
const get = (cookie, path) => new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
const post = (cookie, path, body) => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
const ids = { walkthrough: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0001', job: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0002', crewed: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0003', blocked: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0004',
  crew: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0005', move: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0006', cancel: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0007', customer: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0008',
  noShow: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0009', operations: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0010', recrew: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0011',
  demote: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0012' };
export const REQUEST_IDS = ids;
const dispatch = () => dispatchHandlers({ storage: env => memoryStore(env), now: at });
// The staff directory runs with its own flag on. revocations answers null (no service account), so a role change that
// reached Firebase revocation would say firebaseRevocation: not_configured in its answer.
const directory = () => staffDirectoryHandlers({ now: at, revocations: () => null });
const directoryEnv = env => ({ ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' });
const demote = { action: 'set_roles', requestId: ids.demote, username: DIRECTORY_TARGET, expectedRevision: '', staffRoles: ['crew'] };
const visit = async (cookie, env, run) => {
  const session = await getHubSession(get(cookie, '/api/walkthrough-visit'), env);
  try { return Response.json(await run(memoryStore(env), session)); }
  catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: error.status || 503 }); }
};

// Each probe: [label, (cookie, env) => Response]. Keys used by the capability matrix are stable.
export const PROBES = [
  ['hub-auth GET', (cookie, env) => hubAuth.onRequestGet({ request: get(cookie, '/api/hub-auth'), env })],
  ['staff-roles GET', (cookie, env) => staffRolesHandlers().get({ request: get(cookie, '/api/staff-roles'), env })],
  ['dispatch GET board', (cookie, env) => dispatch().get({ request: get(cookie, '/api/dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true'), env })],
  ['dispatch GET customers', (cookie, env) => dispatch().get({ request: get(cookie, '/api/dispatch?view=customers&q=Synthetic'), env })],
  ['dispatch-openings GET', (cookie, env) => dispatchOpeningsHandlers({ storage: memoryStore, now: at }).get({ request: get(cookie, '/api/dispatch-openings?employeeIds=crew.one&startDate=2026-09-23&endDate=2026-09-24'), env })],
  ['dispatch-search GET', (cookie, env) => dispatchSearchHandlers({ storage: memoryStore }).get({ request: get(cookie, '/api/dispatch-search?q=Synthetic'), env })],
  ['dispatch-travel GET', (cookie, env) => dispatchTravelHandlers({ storage: memoryStore, now: at }).get({ request: get(cookie, '/api/dispatch-travel?date=2026-09-25'), env })],
  ['dispatch POST walkthrough', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'schedule.create', requestId: ids.walkthrough, customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-24', time: '13:00', endTime: '14:00', title: 'Synthetic walkthrough', assignedCrew: [] } }), env })],
  ['dispatch POST job', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'schedule.create', requestId: ids.job, customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-26', time: '08:00', endTime: '10:00', jobInstructions: 'Synthetic scope' } }), env })],
  ['dispatch POST job with crew', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'schedule.create', requestId: ids.crewed, customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-27', time: '08:00', endTime: '10:00', jobInstructions: 'Synthetic scope', assignedCrew: ['crew.one'] } }), env })],
  ['dispatch POST blocked', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'schedule.create', requestId: ids.blocked, kind: 'blocked', changes: { date: '2026-09-28', time: '08:00', endTime: '12:00', title: 'Synthetic block' } }), env })],
  ['dispatch POST crew.save', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'crew.save', requestId: ids.crew, changes: { name: 'Synthetic Crew', memberIds: ['crew.one'], leadId: 'crew.one', status: 'active' } }), env })],
  ['dispatch POST reschedule', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'schedule.update', requestId: ids.move, jobId: 'job-crewed', expectedRevision: 'jr1', changes: { date: '2026-09-25', time: '12:00', endTime: '14:00', assignedCrew: ['crew.one'] } }), env })],
  ['dispatch POST recrew', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'schedule.update', requestId: ids.recrew, jobId: 'job-crewed', expectedRevision: 'jr1', changes: { assignedCrew: ['zacb'] } }), env })],
  ['dispatch POST cancel', (cookie, env) => dispatch().post({ request: post(cookie, '/api/dispatch', { action: 'schedule.cancel', requestId: ids.cancel, jobId: 'job-crewed', expectedRevision: 'jr1', reasonCode: 'customer_changed_plans', initiatedBy: 'customer' }), env })],
  ['timesheets GET', (cookie, env) => timesheetHandlers({ read: async () => ({ timecards: [], requests: [] }), now: at }).get({ request: get(cookie, '/api/timesheets?view=week&start=2026-09-21'), env })],
  ['operations GET', (cookie, env) => operations.onRequestGet({ request: get(cookie, '/api/operations'), env })],
  ['operations POST', (cookie, env) => operations.onRequestPost({ request: post(cookie, '/api/operations', { requestId: ids.operations, body: { command: 'tasks.list' } }), env })],
  ['walkthrough-handoff GET', (cookie, env) => handoffHandlers({ storage: memoryStore, now: at }).get({ request: get(cookie, '/api/walkthrough-handoff'), env })],
  ['customer-resolve POST', (cookie, env) => customerResolveHandler({ storage: memoryStore })({ request: post(cookie, '/api/customer-resolve', { requestId: ids.customer, customer: { name: 'Synthetic Caller', phone: '9705550177' } }), env })],
  ['money GET', (cookie, env) => moneyHandlers({ storage: memoryStore, now: at }).get({ request: new Request(`${ORIGIN}/api/money?jobId=job-costed`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } }), env })],
  ['walkthrough-visit viewer', (cookie, env) => visit(cookie, env, (store, session) => walkthroughVisitState(store, session, {}, NOW))],
  ['walkthrough-visit state', (cookie, env) => visit(cookie, env, (store, session) => walkthroughVisitState(store, session, { visitId: 'walk-1' }, NOW))],
  ['walkthrough-visit no_show', (cookie, env) => visit(cookie, env, (store, session) => recordWalkthroughVisit(store, session, { action: 'no_show', visitId: 'walk-1', requestId: ids.noShow, expectedRevision: 'wr1', reasonCode: 'unreachable' }, NOW))],
  // Needs seedDirectoryTarget. The owner demotes the target and the same request replays; everyone else is refused.
  ['staff-directory GET', (cookie, env) => directory().get({ request: get(cookie, '/api/staff-directory'), env: directoryEnv(env) })],
  ['staff-directory POST set_roles', (cookie, env) => directory().post({ request: post(cookie, '/api/staff-directory', demote), env: directoryEnv(env) })],
  ['staff-directory POST set_roles replay', (cookie, env) => directory().post({ request: post(cookie, '/api/staff-directory', demote), env: directoryEnv(env) })],
];

// Every response for one account and env, as `status content-type\nbody` per probe.
export async function responses(cookie, env) {
  const out = [];
  for (const [label, run] of PROBES) { const response = await run(cookie, env); out.push([label, `${response.status} ${response.headers.get('Content-Type')}\n${await response.text()}`]); }
  return out;
}
