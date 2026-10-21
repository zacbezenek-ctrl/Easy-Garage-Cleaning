/* Real Hub handlers for the crew price check in tests/browser/test_gameplan_pricing_ui.py (FIX-CREW-PRICE-LEAK).
   /api/walkthrough-handoff runs the real signed handoff against an in-memory dispatch store, and /api/field-jobs runs
   the real field-jobs handler against tests/helpers/field-fixture.mjs's Firestore fake holding the saved jobs. The test
   forwards the page's requests here with X-Fixture-User naming the signed-in employee. Synthetic data, a fixed clock and
   no network; it prints READY <port> once listening.
   PORTAL-LINKS (B): sales.person is a Sales estimator (the sales role with EGC_STAFF_ROLE_PERMISSIONS, no business access,
   on no crew). Their page uploads the walkthrough photos through the real POST /api/field-jobs (Drive is field-fixture's
   fake) and asks for the server's first sync, simulated here: it records the sync and the portal invitation on the job
   as highlevel.js syncSavedHandoff does, once per signed request (GET /__fixture/state counts them; POST /__fixture/invite
   sets what the next invitation records). */
import { createServer } from 'node:http';
import { installClockShift } from '../helpers/clock-shift-core.mjs';
import { storage } from '../helpers/field-fixture.mjs';
import { handoffHandlers } from '../../functions/api/walkthrough-handoff.js';
import * as fieldJobs from '../../functions/api/field-jobs.js';
import { createHubSessionCookie } from '../../functions/_lib/hub-session.js';

export const FIXED_NOW = '2026-09-22T15:00:00.000Z';
installClockShift(globalThis, Date.parse(FIXED_NOW) - Date.now());
const env = { HUB_SESSION_SECRET: 'synthetic-crew-scope-browser-session-secret', FIREBASE_API_KEY: 'firebase-test-crew-scope-browser',
  HUB_AUTH_USERS_JSON: JSON.stringify({ zacb: { passwordHash: 'test', role: 'owner', displayName: 'Synthetic Owner' }, 'crew.one': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' } }) };
const PEOPLE = { zacb: { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' }, 'crew.one': { user: 'crew.one', role: 'crew', displayName: 'Crew One' },
  'sales.person': { user: 'sales.person', role: 'sales', businessAccess: false, displayName: 'Synthetic Sales', source: 'employee-account', staffRoles: ['sales'] } };
// The Sales estimator's deployment: role permissions on, and Drive connected for the walkthrough photos.
const salesEnv = { ...env, EGC_STAFF_ROLE_PERMISSIONS: 'true', GOOGLE_CLIENT_ID: 'synthetic', GOOGLE_CLIENT_SECRET: 'synthetic', GOOGLE_REFRESH_TOKEN: 'synthetic',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ...JSON.parse(env.HUB_AUTH_USERS_JSON), 'sales.person': { passwordHash: 'test', role: 'sales', displayName: 'Synthetic Sales', staffRoles: ['sales'] } }) };
const envFor = user => user === 'sales.person' ? salesEnv : env;

const rows = new Map([
  ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
  ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '08:00', endTime: '09:00', projectId: 'p1' }],
  ['projects/p1', { id: 'p1', revision: 'p1r', customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' }],
]);
let revision = 0;
const store = {
  read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
  jobs: async () => [...rows].filter(([key]) => key.startsWith('jobs/')).map(([, value]) => structuredClone(value)),
  resources: async () => [], roster: async () => [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew.one', name: 'Crew One', role: 'crew' }],
  async commit(writes) {
    for (const write of writes) {
      const old = rows.get(`${write.collection}/${write.id}`);
      if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
    }
    for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `rev-${++revision}` });
  },
};
// field-fixture's Firestore fake installs itself as globalThis.fetch.
const firestore = storage({ mock: { method: (object, name, implementation) => { object[name] = implementation; } } });
// The server's first sync of a signed handoff (highlevel.js syncSavedHandoff, simulated): the job is synced and the
// "quote is approved" invitation recorded once; a synced job is skipped, as the real one skips it.
const state = { syncs: [], invite: { status: 'submitted', channel: 'SMS' } };
const serverSync = async (_env, actor, { jobId, handoffRequestId }) => {
  const job = rows.get(`jobs/${jobId}`);
  if (!job || job.handoffRequestId !== handoffRequestId) return { status: 'skipped', reason: 'not_this_handoff' };
  if (job.syncStatus === 'synced') return { status: 'skipped', reason: 'already_synced' };
  state.syncs.push({ jobId, by: actor.user });
  rows.set(`jobs/${jobId}`, { ...job, syncStatus: 'synced', handoffServerSync: { status: 'synced', at: FIXED_NOW, by: actor.user }, customerPortalInvitation: { jobId, ...state.invite }, revision: `rev-${++revision}` });
  return { status: 'synced', portalInvitation: state.invite };
};
const waits = [];
const handoff = handoffHandlers({ session: async request => PEOPLE[request.headers.get('X-Fixture-User')] || null, storage: () => store, now: () => new Date(FIXED_NOW), stripe: () => null, serverSync });
const cookies = Object.fromEntries(await Promise.all(Object.keys(PEOPLE).map(async user => [user, (await createHubSessionCookie(envFor(user), user)).split(';')[0]])));

async function answer(request) {
  const url = new URL(request.url), user = request.headers.get('X-Fixture-User') || '';
  if (url.pathname === '/__fixture/state') return Response.json({ syncs: state.syncs, jobs: [...firestore.documents.keys()].filter(key => key.startsWith('jobs/')).map(key => ({ id: key.slice(5), photos: (firestore.get(key).fieldExecution?.photos || []).map(photo => ({ category: photo.category, actorId: photo.actorId })) })) });
  if (url.pathname === '/__fixture/invite') { state.invite = await request.json(); return Response.json({ ok: true }); }
  if (url.pathname === '/api/walkthrough-handoff') {
    if (request.method !== 'POST') return handoff.get({ request, env: envFor(user) });
    const response = await handoff.post({ request, env: envFor(user), waitUntil: promise => waits.push(promise) });
    await Promise.all(waits.splice(0));
    return response;
  }
  if (url.pathname === '/api/field-jobs') {
    // The field store reads the jobs the handoff saved, as Firestore holds them.
    for (const [key, { id, revision: saved, ...data }] of rows) if (key.startsWith('jobs/') && !firestore.documents.has(key)) firestore.put(key, data);
    const headers = { Cookie: cookies[user] || '', ...(request.method === 'POST' ? { 'Content-Type': request.headers.get('Content-Type') || 'application/json' } : {}) };
    const forwarded = new Request(request.url, { method: request.method, headers, ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}) });
    return request.method === 'POST' ? fieldJobs.onRequestPost({ env: envFor(user), request: forwarded }) : fieldJobs.onRequestGet({ env: envFor(user), request: forwarded });
  }
  return Response.json({ ok: false, error: 'Not part of the crew scope fixture.' }, { status: 404 });
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
    const method = incoming.method || 'GET';
    const response = await answer(new Request(`https://easygaragecleaning.com${incoming.url}`, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks) }));
    outgoing.writeHead(response.status, { 'Content-Type': response.headers.get('Content-Type') || 'application/json' });
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.writeHead(500, { 'Content-Type': 'text/plain' }); outgoing.end(String(error?.stack || error)); }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`READY ${server.address().port}\n`));
