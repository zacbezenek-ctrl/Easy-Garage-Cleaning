import assert from 'node:assert/strict';
import { createCustomerPortalSessionToken } from '../../functions/_lib/customer-portal.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../../functions/_lib/firestore-job.js';
import { createCustomerPortalHandlers } from '../../functions/api/customer-portal.js';

export const NOW = '2026-09-22T18:00:00.000Z';
export const env = { CUSTOMER_PORTAL_SECRET: 'synthetic-portal-fixture-secret', FIREBASE_API_KEY: 'firebase-test-portal-fixture' };
const origin = 'https://easygaragecleaning.com';

// Firestore REST emulation for single job documents: versioned updateTime,
// updateMask patches and, like real Firestore, a 400 FAILED_PRECONDITION
// whenever currentDocument.updateTime is stale (conflictStatus overrides it).
export function portalStore(t, jobs = {}, { conflictStatus = 400 } = {}) {
  const rows = new Map(), calls = [], writes = [], rejected = [];
  let version = 0, failures = 0;
  const stamp = () => `2026-09-22T00:00:00.${String(++version).padStart(6, '0')}Z`;
  const put = (id, value) => rows.set(id, { value: structuredClone(value), updateTime: stamp() });
  for (const [id, value] of Object.entries(jobs)) put(id, value);
  const document = id => ({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, updateTime: rows.get(id).updateTime, fields: encodeFirestoreFields(rows.get(id).value) });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    calls.push({ host: url.hostname, method });
    assert.equal(url.hostname, 'firestore.googleapis.com', `Unexpected external request to ${url.hostname}`);
    const id = decodeURIComponent(url.pathname.split('/documents/jobs/')[1] || '');
    assert.ok(id, `Unexpected Firestore request ${url.pathname}`);
    if (method === 'GET') return rows.has(id) ? Response.json(document(id)) : Response.json({}, { status: 404 });
    assert.equal(method, 'PATCH');
    if (failures) { failures -= 1; return Response.json({}, { status: 500 }); }
    const precondition = url.searchParams.get('currentDocument.updateTime') || '';
    if (!rows.has(id) || precondition && precondition !== rows.get(id).updateTime) {
      rejected.push({ id, precondition });
      return Response.json({ error: { code: conflictStatus, message: 'the stored version does not match the required base version', status: conflictStatus === 409 ? 'ABORTED' : 'FAILED_PRECONDITION' } }, { status: conflictStatus });
    }
    const mask = url.searchParams.getAll('updateMask.fieldPaths'), patch = decodeFirestoreFields(JSON.parse(options.body).fields);
    const next = { ...rows.get(id).value };
    for (const key of mask) next[key] = patch[key];
    rows.set(id, { value: next, updateTime: stamp() });
    writes.push({ id, fields: mask, precondition });
    return Response.json(document(id));
  });
  return {
    rows, calls, writes, rejected,
    job: id => structuredClone(rows.get(id)?.value),
    revision: id => rows.get(id)?.updateTime,
    edit: (id, patch) => put(id, { ...rows.get(id).value, ...patch }),
    failNextWrite: () => { failures += 1; },
  };
}

// Owner sessions must name their account link version (P4-15); fixture jobs
// were never revoked, so an owner cookie defaults to version 0.
export async function portalCookie(jobId = 'job-1', claims = {}, at = Date.parse(NOW)) {
  const owner = !claims.actorId && claims.linkVersion === undefined ? { linkVersion: 0 } : {};
  return `egc_customer_portal=${await createCustomerPortalSessionToken(env, jobId, at, { ...owner, ...claims })}`;
}

export function portalHandlers(now = NOW, deps = {}) {
  return createCustomerPortalHandlers({ now: () => new Date(now), ...deps });
}

export function portalRequest(cookie, body) {
  return new Request(`${origin}/api/customer-portal`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function portalView(handlers, cookie, testEnv = env) {
  const response = await handlers.onRequestGet({ env: testEnv, request: portalRequest(cookie) });
  return { status: response.status, body: await response.json() };
}

export async function portalPost(handlers, cookie, body, testEnv = env) {
  const response = await handlers.onRequestPost({ env: testEnv, request: portalRequest(cookie, body) });
  return { status: response.status, body: await response.json() };
}

// Loads whole one-line inline functions from customer-portal.html into a vm context.
export function portalScript(source, prefixes) {
  const lines = source.split(/\r?\n/);
  return prefixes.map(prefix => {
    const line = lines.find(item => item.startsWith(prefix));
    assert.ok(line, `${prefix} is missing from customer-portal.html`);
    return line;
  }).join('\n');
}

// Minimal DOM nodes for the portal's render helpers.
export function fakeDom() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set(), attributes = new Map(), listeners = {};
      nodes.set(id, {
        id, textContent: '', dataset: {}, listeners,
        classList: { toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; }, add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        get href() { return attributes.get('href') || ''; }, set href(value) { attributes.set('href', String(value)); },
        hasAttribute: name => attributes.has(name), removeAttribute: name => attributes.delete(name),
        addEventListener: (event, handler) => { listeners[event] = handler; },
      });
    }
    return nodes.get(id);
  };
  return { node, nodes };
}
