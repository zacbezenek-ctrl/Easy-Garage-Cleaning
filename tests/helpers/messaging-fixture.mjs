// Synthetic fixtures for the approved-send path. No live provider, Firestore
// or real clock is used: every host other than the fake HighLevel is refused.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const NOW = '2026-09-22T18:00:00.000Z'; // 12:00 in Denver (MDT)
export const env = Object.freeze({
  HUB_SESSION_SECRET: 'synthetic-message-confirm-secret-0123456789abcdef',
  HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1',
  EGC_MESSAGING_ENABLED: 'true', EGC_MESSAGING_DRY_RUN: 'false',
});
export const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Zac Owner', kind: 'human', source: 'hub' };
export const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Tyler Manager', kind: 'human', source: 'hub' };
export const crew = { user: 'crew1', role: 'crew', businessAccess: false, displayName: 'Casey Crew', kind: 'human', source: 'hub' };
export const otherCrew = { user: 'crew2', role: 'crew', businessAccess: false, displayName: 'Riley Other', kind: 'human', source: 'hub' };
export const automation = { id: 'cron', kind: 'system', source: 'cron' };
export const uuid = () => randomUUID();

export function job(overrides = {}) {
  return {
    type: 'job', customer: 'Synthetic Customer', phone: '(970) 555-0123', email: 'synthetic@example.invalid', highlevelContactId: 'contact-1',
    date: '2026-09-22', time: '09:00', endTime: '12:00', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'], crewLead: 'crew1',
    customerAutomationEnabled: true,
    invoice: { number: 'INV-1001', amount: 1200, balance: 1200, dueDate: '2026-10-01', status: 'issued' },
    estimate: { number: 'EST-1001', status: 'accepted', amount: 1200, validUntil: '2026-10-05', depositRequired: 300 },
    deposit: { amount: 300, paidAmount: 0 },
    ...overrides,
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// Revisioned in-memory store with Firestore commit precondition semantics.
export function memoryStore(initial = {}) {
  const rows = new Map(), revisions = new Map(), commits = [];
  let counter = 0;
  for (const [key, value] of Object.entries(initial)) { rows.set(key, structuredClone(value)); revisions.set(key, `rev-${++counter}`); }
  const hooks = { beforeCommit: null, failCollections: new Set(), loseResponse: new Set() };
  return {
    rows, commits, hooks,
    get: key => rows.has(key) ? structuredClone(rows.get(key)) : null,
    set(key, value) { rows.set(key, structuredClone(value)); revisions.set(key, `rev-${++counter}`); },
    edit(key, patch) { rows.set(key, { ...rows.get(key), ...structuredClone(patch) }); revisions.set(key, `rev-${++counter}`); },
    async read(collection, id) {
      await tick();
      const key = `${collection}/${id}`;
      return rows.has(key) ? { ...structuredClone(rows.get(key)), id, revision: revisions.get(key) } : null;
    },
    async roster() { return [{ id: 'crew1', name: 'Casey Crew', role: 'crew' }, { id: 'crew2', name: 'Riley Other', role: 'crew' }, { id: 'zacb', name: 'Zac Owner', role: 'owner' }]; },
    async commit(writes) {
      await tick();
      hooks.beforeCommit?.(writes);
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`;
        assert.ok(!keys.has(key), 'a commit never writes the same document twice');
        keys.add(key);
        if (hooks.failCollections.has(write.collection)) throw Object.assign(new Error('Synthetic storage outage'), { code: 'messaging_storage_unavailable', status: 503 });
        if (write.revision ? revisions.get(key) !== write.revision : rows.has(key)) throw Object.assign(new Error('Conflict'), { code: 'messaging_revision_conflict', status: 409 });
      }
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`;
        rows.set(key, { ...(rows.get(key) || {}), ...structuredClone(write.patch) });
        revisions.set(key, `rev-${++counter}`);
      }
      commits.push(structuredClone(writes));
      if (writes.some(write => hooks.loseResponse.has(write.collection))) throw Object.assign(new Error('Response lost'), { code: 'messaging_outcome_unknown', status: 503 });
      return {};
    },
  };
}

// Fake HighLevel API. Routes only services.leadconnectorhq.com paths.
export function fakeGhl({ contact = {}, contacts, sendStatus = 200, sendBody, sendThrows = false, upsertId = 'contact-1' } = {}) {
  const calls = [];
  const state = {
    sendStatus, sendBody, sendThrows, upsertId,
    contacts: contacts || { 'contact-1': { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', dnd: false, tags: [], ...contact } },
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetcher(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.hostname !== 'services.leadconnectorhq.com') throw new Error(`External host refused: ${parsed.hostname}`);
    const call = { path: parsed.pathname, method: options.method || 'GET', headers: { ...options.headers }, body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
    calls.push(call);
    if (parsed.pathname === '/contacts/upsert') return typeof state.upsertId === 'number' ? json({}, state.upsertId) : json({ contact: { id: state.upsertId } });
    const match = /^\/contacts\/([^/]+)$/.exec(parsed.pathname);
    if (match) {
      if (typeof state.contactStatus === 'number') return json({}, state.contactStatus);
      const found = state.contacts[decodeURIComponent(match[1])];
      return found ? json({ contact: found }) : json({}, 404);
    }
    if (parsed.pathname === '/conversations/messages') {
      const count = calls.filter(row => row.path === '/conversations/messages').length;
      if (typeof state.sendThrows === 'function' ? state.sendThrows(count) : state.sendThrows) throw new Error('Connection lost after dispatch');
      const status = typeof state.sendStatus === 'function' ? state.sendStatus(count) : state.sendStatus;
      return json(state.sendBody ?? { messageId: `message-${count}`, conversationId: 'conversation-1' }, status);
    }
    return json({}, 404);
  }
  return { fetcher, calls, state, sends: () => calls.filter(call => call.path === '/conversations/messages') };
}

export function clock(start = NOW) {
  let current = Date.parse(start);
  const fn = () => new Date(current);
  fn.advance = ms => { current += ms; };
  fn.set = iso => { current = Date.parse(iso); };
  return fn;
}
