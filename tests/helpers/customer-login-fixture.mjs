// Synthetic Client Login fixtures: one revisioned in-memory Firestore with the
// identity, account-jobs and approved-send views the handlers use, a fixed
// clock and the fake HighLevel from the messaging fixture. No real clock,
// provider or Firestore is ever used.
import assert from 'node:assert/strict';
import { ACCOUNT_JOB_FIELDS } from '../../functions/_lib/customer-account-access.js';
import { mutateTemplate, readTemplate } from '../../functions/_lib/message-template-store.js';
import { randomUUID } from 'node:crypto';

export const NOW = '2026-09-22T18:00:00.000Z';
export const ORIGIN = 'https://easygaragecleaning.com';
export const env = Object.freeze({
  HUB_SESSION_SECRET: 'synthetic-hub-session-secret-0123456789abcdef',
  CUSTOMER_PORTAL_SECRET: 'synthetic-customer-portal-secret-0123456789',
  HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1',
  EGC_MESSAGING_ENABLED: 'true', EGC_MESSAGING_DRY_RUN: 'false', CUSTOMER_LOGIN_ENABLED: 'true',
});
export const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Zac Owner' };
export const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Tyler Manager' };
export const crew = { user: 'crew1', role: 'crew', businessAccess: false, displayName: 'Casey Crew' };

const customer = (id, phone, email, contact, extra = {}) => ({ name: `Synthetic ${id}`, firstName: `Synthetic${id.slice(-1).toUpperCase()}`, phone, email, phoneE164: `+1${phone.replace(/\D/g, '')}`, emailLower: email, highlevelContactId: contact, ...extra });
export const job = (customerId, extra = {}) => ({ type: 'job', customerId, customer: 'Synthetic', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-10-01', time: '09:00', endTime: '12:00', address: '100 Synthetic Way, Fort Collins, CO', serviceType: 'Garage cleanout', ...extra });

export function seed() {
  return {
    'customers/customer-a': customer('customer-a', '9705550101', 'avery@example.invalid', 'contact-a'),
    'customers/customer-b': customer('customer-b', '9705550102', 'blake@example.invalid', 'contact-b'),
    'customers/customer-dnd': customer('customer-dnd', '9705550103', 'dana@example.invalid', 'contact-dnd'),
    'customers/customer-d1': customer('customer-d1', '9705550104', 'dup1@example.invalid', 'contact-d1'),
    'customers/customer-d2': customer('customer-d2', '9705550104', 'dup2@example.invalid', 'contact-d2'),
    // The lookup key was written before the phone changed; it is not evidence.
    'customers/customer-stale': customer('customer-stale', '9705550105', 'stale@example.invalid', 'contact-stale', { phone: '9705550199' }),
    'customers/customer-quiet': customer('customer-quiet', '9705550106', 'quiet@example.invalid', 'contact-quiet', { notify: false }),
    'jobs/job-a1': job('customer-a', { highlevelContactId: 'contact-a', date: '2026-10-01', opsNotes: 'CANARY-OPS-NOTE', notes: 'CANARY-NOTES' }),
    'jobs/job-a2': job('customer-a', { customerAccountOwnerJobId: 'job-a1', status: 'completed', pipelineStatus: 'completed', date: '2026-09-01',
      estimate: { number: 'EST-A2', status: 'accepted', amount: 1200, validUntil: '2026-09-15' }, customerApproval: { status: 'approved', approvedAt: '2026-08-20T12:00:00.000Z', amount: 1200 },
      invoice: { number: 'INV-A2', status: 'paid', dueDate: '2026-09-10' }, payment: { amount: 1200, verified: true, paidAt: '2026-09-02T12:00:00.000Z', receiptUrl: 'https://pay.stripe.com/receipts/synthetic_a2', stripeSessionId: 'cs_test_CANARY', paymentIntentId: 'pi_CANARY' } }),
    'jobs/job-b1': job('customer-b', { highlevelContactId: 'contact-b', date: '2026-10-03', opsNotes: 'CANARY-B-NOTE' }),
    'jobs/job-dnd1': job('customer-dnd', { highlevelContactId: 'contact-dnd' }),
  };
}

export const contacts = () => ({
  'contact-a': { id: 'contact-a', locationId: 'location-1', phone: '+19705550101', email: 'avery@example.invalid', dnd: false, tags: [] },
  'contact-b': { id: 'contact-b', locationId: 'location-1', phone: '+19705550102', email: 'blake@example.invalid', dnd: false, tags: [] },
  'contact-dnd': { id: 'contact-dnd', locationId: 'location-1', phone: '+19705550103', email: 'dana@example.invalid', dnd: true, tags: [] },
  'contact-quiet': { id: 'contact-quiet', locationId: 'location-1', phone: '+19705550106', email: 'quiet@example.invalid', dnd: false, tags: [] },
});

const tick = () => new Promise(resolve => setImmediate(resolve));
// A Firestore field mask over a plain row: top-level names and map.subfield paths.
export function maskRow(row, paths) {
  const out = {};
  for (const path of paths) {
    const [top, sub] = path.split('.'), value = row[top];
    if (!Object.hasOwn(row, top)) continue;
    if (sub === undefined) out[top] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, sub)) out[top] = { ...out[top], [sub]: value[sub] };
  }
  return out;
}
const conflict = code => Object.assign(new Error('Conflict'), { code, status: 409 });

// Revisioned rows, create-only and exact-revision commits, read-only verify
// fences, one write per document per commit.
export function memory(initial = seed()) {
  const rows = new Map(), revisions = new Map(), commits = [], calls = { customerJobs: [], queryCustomers: 0, jobsByContact: 0 };
  let counter = 0;
  const hooks = { beforeCommit: null, loseResponse: null, failRead: null };
  for (const [key, value] of Object.entries(initial)) { rows.set(key, structuredClone(value)); revisions.set(key, `rev-${++counter}`); }
  const list = collection => [...rows].filter(([key]) => key.startsWith(`${collection}/`)).map(([key, value]) => ({ ...structuredClone(value), id: key.slice(collection.length + 1), revision: revisions.get(key) }));
  const store = {
    rows, revisions, commits, calls, hooks,
    get: key => rows.has(key) ? structuredClone(rows.get(key)) : null,
    edit(key, patch) { rows.set(key, { ...rows.get(key), ...structuredClone(patch) }); revisions.set(key, `rev-${++counter}`); },
    remove(key) { rows.delete(key); revisions.delete(key); },
    async read(collection, id) {
      await tick();
      if (hooks.failRead?.(collection, id)) throw Object.assign(new Error('Synthetic outage'), { code: 'dispatch_storage_unavailable', status: 503 });
      const key = `${collection}/${id}`;
      return rows.has(key) ? { ...structuredClone(rows.get(key)), id, revision: revisions.get(key) } : null;
    },
    async commit(writes, code = 'dispatch_revision_conflict') {
      await tick();
      await hooks.beforeCommit?.(writes);
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`;
        assert.ok(!keys.has(key), 'a commit never writes the same document twice');
        keys.add(key);
        if (write.verify ? revisions.get(key) !== write.revision : write.revision ? revisions.get(key) !== write.revision : rows.has(key)) throw conflict(code);
      }
      for (const write of writes.filter(item => !item.verify)) {
        const key = `${write.collection}/${write.id}`;
        rows.set(key, { ...(rows.get(key) || {}), ...structuredClone(write.patch) });
        revisions.set(key, `rev-${++counter}`);
      }
      commits.push(structuredClone(writes));
      if (hooks.loseResponse?.(writes)) throw Object.assign(new Error('Response lost'), { code: 'dispatch_outcome_unknown', status: 503 });
      return {};
    },
    // customerIdentityStorage view.
    async queryCustomers(field, value) { calls.queryCustomers += 1; await tick(); return list('customers').filter(row => row[field] === value); },
    async jobsByContact(contact) { calls.jobsByContact += 1; await tick(); return list('jobs').filter(row => row.highlevelContactId === contact); },
    // customerAccountStorage view: masked, ordered, cursor-paginated.
    async customerJobs(customerId, { limit, after = '' }) {
      calls.customerJobs.push({ customerId, limit, after });
      await tick();
      return list('jobs').filter(row => row.customerId === customerId && row.id > after).sort((a, b) => (a.id > b.id) - (a.id < b.id)).slice(0, limit)
        .map(row => ({ ...maskRow(row, ACCOUNT_JOB_FIELDS), id: row.id, revision: row.revision }));
    },
  };
  // The approved-send service sees messaging_* conflict codes, as messagingStorage maps them.
  store.messaging = { read: (...args) => store.read(...args), commit: writes => store.commit(writes, 'messaging_revision_conflict') };
  return store;
}

export function clock(start = NOW) {
  let current = Date.parse(start);
  const fn = () => new Date(current);
  fn.advance = ms => { current += ms; };
  fn.set = iso => { current = Date.parse(iso); };
  fn.iso = () => new Date(current).toISOString();
  return fn;
}

export async function approveLoginTemplate(store) {
  const state = await readTemplate(store.messaging, 'portal_magic_link');
  await mutateTemplate(store.messaging, owner, { action: 'approve', requestId: randomUUID(), kind: 'portal_magic_link', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
}

export function loginRequest(body, { origin = ORIGIN, headers = {}, ip = '203.0.113.7' } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}/api/customer-login`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-EGC-Portal': '1', 'Sec-Fetch-Site': 'same-origin', ...(origin ? { Origin: origin } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...headers } });
}

export function verifyRequest(token, { origin = ORIGIN, contentType = 'application/x-www-form-urlencoded', body } = {}) {
  return new Request(`${ORIGIN}/api/customer-login-verify`, { method: 'POST', body: body ?? new URLSearchParams({ token }).toString(), headers: { 'Content-Type': contentType, 'Sec-Fetch-Site': 'same-origin', ...(origin ? { Origin: origin } : {}) } });
}

export const tokenFrom = message => { const match = /\/api\/customer-login-verify\?token=([A-Za-z0-9_-]{43})/.exec(message || ''); return match ? match[1] : ''; };
export const cookieValue = (header, name) => { const match = new RegExp(`(?:^|, )${name.replace(/[-_]/g, '\\$&')}=([^;]*)`).exec(header || ''); return match ? match[1] : ''; };
