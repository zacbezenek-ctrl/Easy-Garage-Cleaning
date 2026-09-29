/* Real Hub handlers for the crew price check in tests/browser/test_gameplan_pricing_ui.py (FIX-CREW-PRICE-LEAK).
   /api/walkthrough-handoff runs the real signed handoff against an in-memory dispatch store, and /api/field-jobs runs
   the real field-jobs handler against tests/helpers/field-fixture.mjs's Firestore fake holding the saved jobs. The test
   forwards the page's requests here with X-Fixture-User naming the signed-in employee. Synthetic data, a fixed clock and
   no network; it prints READY <port> once listening. */
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
const PEOPLE = { zacb: { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' }, 'crew.one': { user: 'crew.one', role: 'crew', displayName: 'Crew One' } };

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
const handoff = handoffHandlers({ session: async request => PEOPLE[request.headers.get('X-Fixture-User')] || null, storage: () => store, now: () => new Date(FIXED_NOW), stripe: () => null });
const cookies = Object.fromEntries(await Promise.all(Object.keys(PEOPLE).map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));

async function answer(request) {
  const url = new URL(request.url), user = request.headers.get('X-Fixture-User') || '';
  if (url.pathname === '/api/walkthrough-handoff') return request.method === 'POST' ? handoff.post({ request, env }) : handoff.get({ request, env });
  if (url.pathname === '/api/field-jobs' && request.method === 'GET') {
    // The field store reads the jobs the handoff saved, as Firestore holds them.
    for (const [key, { id, revision: saved, ...data }] of rows) if (key.startsWith('jobs/') && !firestore.documents.has(key)) firestore.put(key, data);
    return fieldJobs.onRequestGet({ env, request: new Request(request.url, { headers: { Cookie: cookies[user] || '' } }) });
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
