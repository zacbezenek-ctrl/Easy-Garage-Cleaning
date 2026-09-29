import assert from 'node:assert/strict';
import { matchesWhere } from './firestore-query.mjs';
import { createHubSessionCookie } from '../../functions/_lib/hub-session.js';
import { employeeInvitationStore } from '../../functions/_lib/employee-accounts.js';

// Firestore REST emulation for the encrypted employee vault: document GET/PATCH with
// currentDocument preconditions, runQuery over any collection (EQUAL/AND filters) and
// atomic :commit with updateMask merges and per-write preconditions. Precondition
// failures answer as the Firestore emulator does: a stale updateTime (or an update of a
// missing document) is 400 FAILED_PRECONDITION and a create over an existing document is
// 409 ALREADY_EXISTS. Anything but firestore.googleapis.com fails the test.
// Dispatch storage (the request workflow's availability blocks) also needs collection
// scans (one unpaginated page, masks ignored) and the :beginTransaction / :batchGet /
// :rollback calls its verified commit makes.
export const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
export const ORIGIN = 'https://easygaragecleaning.com';
export const PASSWORD = 'Synthetic-Staff-Password-904';

export function vaultFirestore(t) {
  const documents = new Map(), requests = [], commits = [], hooks = { beforeCommit: null, commitStatus: 0, loseCommitReply: false };
  let revision = 0;
  const version = () => `2026-09-22T12:00:00.${String(++revision).padStart(6, '0')}Z`;
  const matches = (current, condition) => !condition ? true : condition.exists === false ? !current : condition.exists === true ? Boolean(current) : !condition.updateTime || current?.updateTime === condition.updateTime;
  const refused = condition => {
    const [code, status] = condition.exists === false ? [409, 'ALREADY_EXISTS'] : [400, 'FAILED_PRECONDITION'];
    return Response.json({ error: { code, status, message: 'synthetic precondition failure' } }, { status: code });
  };
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
    assert.equal(url.hostname, 'firestore.googleapis.com', 'the test must never contact another service');
    requests.push({ url, method, body });
    const path = decodeURIComponent(url.pathname.split('/documents')[1] || '');
    if (path === ':runQuery') {
      const collection = body.structuredQuery.from[0].collectionId;
      const rows = [...documents].filter(([key, doc]) => key.startsWith(`${collection}/`) && matchesWhere(doc, body.structuredQuery.where)).map(([, doc]) => ({ document: structuredClone(doc) }));
      return Response.json(rows.length ? rows : [{ readTime: '2026-09-22T12:00:00Z' }]);
    }
    if (path === ':beginTransaction') return Response.json({ transaction: 'synthetic-transaction' });
    if (path === ':rollback') return Response.json({});
    if (path === ':batchGet') return Response.json(body.documents.map(name => {
      const doc = documents.get(name.split('/documents/')[1]);
      return doc ? { found: structuredClone(doc) } : { missing: name };
    }));
    if (path === ':commit') {
      if (hooks.beforeCommit) { const hook = hooks.beforeCommit; hooks.beforeCommit = null; await hook(); }
      if (hooks.commitStatus) { const status = hooks.commitStatus; hooks.commitStatus = 0; return Response.json({ error: { status: 'UNAVAILABLE' } }, { status }); }
      const keys = body.writes.map(write => write.update.name.split('/documents/')[1]);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      const failed = body.writes.findIndex((write, index) => !matches(documents.get(keys[index]), write.currentDocument));
      if (failed >= 0) return refused(body.writes[failed].currentDocument);
      const updateTime = version();
      body.writes.forEach((write, index) => {
        const existing = documents.get(keys[index]), fields = write.updateMask ? { ...(existing?.fields || {}), ...write.update.fields } : write.update.fields;
        documents.set(keys[index], { name: write.update.name, fields, updateTime });
      });
      commits.push(body.writes);
      if (hooks.loseCommitReply) { hooks.loseCommitReply = false; throw new TypeError('Synthetic lost commit reply'); }
      return Response.json({ writeResults: body.writes.map(() => ({ updateTime })), commitTime: updateTime });
    }
    const key = path.replace(/^\//, '');
    if (method === 'PATCH') {
      const condition = url.searchParams.get('currentDocument.exists') === 'false' ? { exists: false } : url.searchParams.has('currentDocument.updateTime') ? { updateTime: url.searchParams.get('currentDocument.updateTime') } : null;
      if (!matches(documents.get(key), condition)) return refused(condition);
      documents.set(key, { name: `${ROOT}/${key}`, fields: body.fields, updateTime: version() });
    }
    if (method !== 'GET' && method !== 'PATCH') throw new Error(`Unexpected ${method} ${url}`);
    if (method === 'GET' && key.split('/').length % 2 === 1) return Response.json({ documents: [...documents].filter(([name]) => name.startsWith(`${key}/`) && !name.slice(key.length + 1).includes('/')).map(([, doc]) => structuredClone(doc)) });
    return documents.has(key) ? Response.json(structuredClone(documents.get(key))) : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
  });
  const writes = () => requests.filter(request => request.method === 'PATCH' || request.url.pathname.endsWith(':commit'));
  return { documents, requests, commits, hooks, writes, snapshot: () => JSON.stringify([...documents].sort(([a], [b]) => a.localeCompare(b))) };
}

// Configured Hub users as HUB_AUTH_USERS_JSON declares them. Only ZacB, TylerG and
// AlexK have business access (functions/_lib/business-users.js).
export function staffEnv(extra = {}, users = {}) {
  return {
    HUB_SESSION_SECRET: 'synthetic-staff-directory-session-secret',
    EMPLOYEE_HUB_DATA_SECRET: 'synthetic-staff-directory-vault-secret',
    FIREBASE_API_KEY: 'firebase-test-staff-directory',
    HUB_AUTH_USERS_JSON: JSON.stringify({
      ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner', displayName: 'Synthetic Owner', payType: 'owner' },
      TylerG: { passwordHash: 'unused-synthetic-manager-hash', role: 'manager', displayName: 'Synthetic Manager', hourlyRate: 30 },
      AlexK: { passwordHash: 'unused-synthetic-lead-hash', role: 'crew_lead', displayName: 'Synthetic Business Lead' },
      'Crew.Static': { passwordHash: 'unused-synthetic-crew-hash', role: 'crew', displayName: 'Synthetic Static Crew', hourlyRate: 19 },
      ...users,
    }),
    ...extra,
  };
}

export const cookieFor = async (env, user) => (await createHubSessionCookie(env, user)).split(';')[0];

// A real sealed employee account, as signup/approval or the named invitation leaves it.
export async function seedAccount(env, username, { status = 'approved', sales = false, extra = {} } = {}) {
  const store = employeeInvitationStore(env), email = `${username.toLowerCase()}@example.invalid`;
  const at = '2026-09-20T12:00:00.000Z';
  const account = { username, usernameKey: username.toLowerCase(), displayName: `Synthetic ${username}`, firstName: 'Synthetic', lastName: username, email, phone: '9705550142',
    ...(await store.password(PASSWORD)), status, role: sales ? 'sales' : 'crew', payType: 'hourly', hourlyRate: 21, businessAccess: false, appliedAt: at, updatedAt: at,
    reviewedAt: at, reviewedBy: 'zacb', sessionVersion: `synthetic-version-${username}`,
    ...(sales ? { invitation: { kind: 'named_staff_v1', id: `synthetic-${username}`, username, email, approvedBy: 'zacb', consumedAt: at } } : {}), ...extra };
  await store.create(account);
  return account;
}

export async function login(env, username, password = PASSWORD) {
  const { onRequestPost } = await import('../../functions/api/hub-auth.js');
  const response = await onRequestPost({ env, request: new Request(`${ORIGIN}/api/hub-auth`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }) });
  assert.equal(response.status, 200, await response.clone().text());
  return { cookie: response.headers.get('set-cookie').split(';')[0], profile: await response.json() };
}

export const jsonRequest = (path, body, cookie, headers = {}) => new Request(`${ORIGIN}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
