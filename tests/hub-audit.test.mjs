import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auditSnapshot, auditWrite, hubAuditStorage, listAudit, requireAuditReader } from '../functions/_lib/hub-audit.js';
import { hubAuditHandlers } from '../functions/api/hub-audit.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { schedulingStorage } from '../functions/_lib/operations-scheduling.js';
import { createBusinessStore } from '../functions/_lib/business-hub-store.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createCustomerPortalAccessToken, createCustomerPortalCollaboratorAccessToken, createCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { createHubActionState, createHubSessionToken } from '../functions/_lib/hub-session.js';
import { issueConfirmation } from '../functions/_lib/confirm-token.js';

const NOW = '2026-09-22T12:00:00.000Z';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const manager = { user: 'tylerg', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const human = { id: 'ZacB', kind: 'human', role: 'owner' };
const prefixOf = iso => (0xffffffffffff - Date.parse(iso)).toString(16).padStart(12, '0');
const entry = (overrides = {}) => auditWrite({ actor: human, via: 'hub', action: 'invoice.void', entity: { collection: 'jobs', id: 'job-1' }, before: { status: 'sent' }, after: { status: 'void' }, requestId: randomUUID(), reason: 'Synthetic duplicate invoice', now: NOW, ...overrides });

// Revisioned in-memory store with Firestore commit semantics: every write's
// precondition is checked before any write applies, so a conflict applies none.
function memoryStore() {
  const rows = new Map();
  let revision = 0;
  return {
    rows,
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
      return { writeResults: [] };
    },
    async auditPage({ entityKey, actorId, fromId, beforeId, after, limit }) {
      return [...rows.entries()].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => structuredClone(row))
        .filter(row => (!entityKey || row.entityKey === entityKey) && (!actorId || row.actor?.id === actorId) && (!fromId || row.id >= fromId) && (!beforeId || row.id < beforeId) && (!after || row.id > after))
        .sort((a, b) => a.id < b.id ? -1 : 1).slice(0, limit);
    },
  };
}

test('auditWrite builds one create-only hub_audit write with a newest-first id and normalized fields', () => {
  const requestId = randomUUID().toUpperCase();
  const write = entry({ requestId });
  assert.equal(write.collection, 'hub_audit');
  assert.equal(write.revision, undefined, 'Audit entries are create-only (exists:false).');
  assert.match(write.id, /^[a-f0-9]{40}$/);
  assert.equal(write.id.slice(0, 12), prefixOf(NOW));
  assert.equal(write.data, write.patch, 'businessStore reads data; dispatch and scheduling stores read patch.');
  const { patch } = write;
  assert.deepEqual({ ...patch, before: JSON.parse(patch.before), after: JSON.parse(patch.after) }, {
    v: 1, at: NOW, actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', action: 'invoice.void',
    entity: { collection: 'jobs', id: 'job-1' }, entityKey: 'jobs/job-1', requestId: requestId.toLowerCase(), reason: 'Synthetic duplicate invoice',
    before: { status: 'sent' }, after: { status: 'void' }, changedKeys: ['status'], truncated: false, visibility: 'business',
  });
  assert.equal(entry({ requestId }).id, write.id, 'The same request produces the same entry id.');
  assert.notEqual(entry().id, write.id);
  const unrequested = [entry({ requestId: null }), entry({ requestId: null })];
  assert.notEqual(unrequested[0].id, unrequested[1].id);
  assert.equal(unrequested[0].patch.requestId, null);
  assert.ok(entry({ now: '2026-09-22T12:00:00.001Z' }).id < write.id, 'A later entry sorts before an earlier one.');
  const cron = auditWrite({ actor: { id: 'egc-cron', kind: 'system' }, via: 'cron', action: 'reminder.queue', entity: { collection: 'jobs', id: 'job-2' }, now: new Date(NOW) });
  assert.deepEqual([cron.patch.actor.role, cron.patch.before, cron.patch.after, cron.patch.reason, cron.patch.changedKeys], [null, null, null, null, []]);
});

test('auditWrite rejects unverifiable actors, sources, records, request ids and clocks before anything is committed', () => {
  const invalid = [
    { actor: null }, { actor: { id: '', kind: 'human' } }, { actor: { id: 'zacb', kind: 'robot' } }, { actor: { id: 'zacb', kind: 'human', role: 'Owner!' } },
    { via: 'browser' }, { via: undefined }, { action: 'Invoice Void' }, { action: '' }, { entity: { collection: 'jobs', id: 'a/b' } },
    { entity: { collection: '../jobs', id: 'x' } }, { entity: null }, { requestId: 'not-a-uuid' }, { reason: 42 },
    { now: '2026-09-22' }, { now: 'yesterday' }, { now: 1790000000000 }, { visibility: 'managers' }, { visibility: null },
  ];
  for (const overrides of invalid) assert.throws(() => entry(overrides), error => error.code === 'hub_audit_invalid' && error.status === 503, JSON.stringify(overrides));
});

test('snapshots redact credential and payment-card data wherever it appears', () => {
  const canaries = ['CANARY-PASSWORD', 'CANARY-API', 'CANARY-SESSION', 'CANARY-HASH', 'CANARY-CVC', 'CANARY-NONCE', 'CANARY-OTP', 'CANARY-SIG'];
  const before = {
    status: 'draft', password: 'CANARY-PASSWORD', nested: { apiKey: 'CANARY-API', list: [{ sessionToken: 'CANARY-SESSION' }, { inviteHash: 'CANARY-HASH' }] },
    card: { number: '4242 4242 4242 4242', cvc: 'CANARY-CVC', brand: 'visa', last4: '4242' }, nonce: 'CANARY-NONCE', otp: 'CANARY-OTP', customerSignature: 'CANARY-SIG',
    note: 'Paid with 4000-0566-5566-5556 today; call 970-555-0100', header: 'Bearer abc.def.ghi', stripe: 'sk_live_1234567890abcdef', hook: 'whsec_abcdefghijklmnop',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl', link: 'https://easygaragecleaning.com/customer-portal?job=j1&t=secret-portal-token#x',
    photo: `data:image/jpeg;base64,${'A'.repeat(5000)}`, order: '4242424242424241',
  };
  const write = entry({ before, after: { ...before, password: 'CANARY-PASSWORD-2', status: 'sent' } });
  const stored = JSON.stringify(write.patch);
  for (const canary of [...canaries, 'CANARY-PASSWORD-2', '4242 4242 4242 4242', '4000-0566-5566-5556', 'sk_live_', 'whsec_', 'eyJhbGci', 'secret-portal-token', 'abc.def.ghi', 'AAAAAAAAAA']) assert.ok(!stored.includes(canary), `${canary} leaked into the audit entry`);
  const saved = JSON.parse(write.patch.before);
  assert.equal(saved.card.brand, 'visa'); assert.equal(saved.card.last4, '4242'); assert.equal(saved.card.cvc, '[redacted]');
  assert.equal(saved.card.number, '[redacted-card]');
  assert.equal(saved.note, 'Paid with [redacted-card] today; call 970-555-0100', 'Phone numbers stay readable; card numbers do not.');
  assert.equal(saved.order, '4242424242424241', 'A non-Luhn digit string is not mistaken for a card.');
  assert.equal(saved.link, 'https://easygaragecleaning.com/customer-portal?job=j1&t=[redacted]#x');
  assert.equal(saved.photo, '[data omitted]');
  assert.deepEqual(write.patch.changedKeys, ['password', 'status'], 'A changed secret is listed by name only.');
  assert.equal(auditSnapshot({ expectedRevision: 'r1', expiresAt: NOW, pinned: true, footprint: 'wide' }).expectedRevision, 'r1', 'Ordinary keys that resemble secret words stay readable.');
  assert.deepEqual(auditSnapshot({ pinned: true, footprint: 'wide', authority: 'employee_hub' }), { pinned: true, footprint: 'wide', authority: 'employee_hub' });
});

test("snapshots, reasons and listed rows redact this codebase's own bearer links and tokens", async () => {
  const env = { HUB_SESSION_SECRET: 'synthetic-hub-session-root-secret-0123456789abcdef', CUSTOMER_PORTAL_SECRET: 'synthetic-customer-portal-secret-0123456789abcdef' };
  const ms = Date.parse(NOW);
  // Owner portal tokens carry the account link version and root, as production mints them since P4-15.
  const portal = await createCustomerPortalAccessToken(env, 'job-1', ms, 0, 'job-1');
  const collaborator = await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', { view: true, pay: true }, ms);
  const portalSession = await createCustomerPortalSessionToken(env, 'job-1', ms, { linkVersion: 0, linkRoot: 'job-1' });
  const hubSession = await createHubSessionToken(env, 'zacb', ms, { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner' });
  const crewSession = await createHubSessionToken(env, 'crew1', ms, { source: 'employee-account', sessionVersion: 'v1', displayName: 'Synthetic Crew', payType: 'hourly', hourlyRate: 25 });
  const oauthState = await createHubActionState(env, 'gusto', 'zacb', ms);
  const confirm = (await issueConfirmation(env, { actorId: 'zacb', action: 'invoice.send', entityId: 'job-1', payload: { amountCents: 45000 }, now: NOW })).token;
  const invite = `${'a'.repeat(32)}.${'b'.repeat(32)}.${'c'.repeat(64)}`;
  const tokens = { portal, collaborator, portalSession, hubSession, crewSession, oauthState, confirm, invite };
  const link = token => `https://easygaragecleaning.com/api/customer-portal-session?access=${encodeURIComponent(token)}`;
  const snapshot = {
    portalUrl: link(portal), collaboratorUrl: link(collaborator), inviteUrl: `https://easygaragecleaning.com/business-hub#invite=${invite}`,
    oauthUrl: `https://app.example.invalid/oauth?client_id=synthetic&state=${encodeURIComponent(oauthState)}&redirect_uri=x`,
    message: `Hi Synthetic, your quote is approved. Here is your private Easy Garage Cleaning project portal: ${link(portal)}`,
    forwarded: `redirect=${encodeURIComponent(link(collaborator))} and cookie egc_hub_session=${hubSession}; confirm ${confirm}`,
    access: portal, customerAccess: collaborator, hubSession, session: portalSession, confirm, value: crewSession, invite, state: oauthState,
    pwd: 'CANARY-PWD', passwd: 'CANARY-PASSWD', header: `Authorization: Bearer ${'Z'.repeat(40)}`,
    businessAccess: true, access_level: 'view', sessionVersion: 3, plain: 'https://easygaragecleaning.com/customer-portal?job=job-1',
  };
  const write = entry({ before: snapshot, after: { ...snapshot, status: 'sent' }, reason: `Resent ${link(portal)} after ${confirm}` });
  const secrets = [...Object.values(tokens), ...Object.values(tokens).map(token => token.split('.').at(-1)), 'CANARY-PWD', 'CANARY-PASSWD', 'Z'.repeat(40)];
  const leaks = text => secrets.filter(secret => text.includes(secret) || text.includes(encodeURIComponent(secret)));
  assert.deepEqual(leaks(JSON.stringify(write.patch)), [], 'No working credential reaches hub_audit.');
  const saved = JSON.parse(write.patch.before);
  assert.equal(saved.portalUrl, 'https://easygaragecleaning.com/api/customer-portal-session?access=[redacted]');
  assert.equal(saved.message, 'Hi Synthetic, your quote is approved. Here is your private Easy Garage Cleaning project portal: https://easygaragecleaning.com/api/customer-portal-session?access=[redacted]');
  assert.equal(saved.inviteUrl, 'https://easygaragecleaning.com/business-hub#invite=[redacted]');
  assert.deepEqual([saved.businessAccess, saved.access_level, saved.sessionVersion, saved.plain], [true, 'view', 3, snapshot.plain], 'Flags, levels, counters and token-free links stay readable.');
  assert.deepEqual([saved.access, saved.hubSession, saved.pwd, saved.passwd], ['[redacted]', '[redacted]', '[redacted]', '[redacted]']);
  assert.ok(write.patch.reason.startsWith('Resent https://easygaragecleaning.com/api/customer-portal-session?access=[redacted] after [redacted]'));
  // Rows stored before this redaction (or written outside auditWrite) are redacted again when listed.
  const legacy = { ...write.patch, id: write.id, before: JSON.stringify(snapshot), after: JSON.stringify({ note: snapshot.message }), reason: `Resent ${link(portal)}` };
  const page = await listAudit({ auditPage: async () => [legacy] }, {}, owner);
  assert.deepEqual(leaks(JSON.stringify(page)), [], 'Listing never returns a stored credential.');
  assert.equal(page.entries[0].after.note, saved.message);
  assert.equal(page.entries[0].reason, 'Resent https://easygaragecleaning.com/api/customer-portal-session?access=[redacted]');
});

test('owner-only entries keep snapshots and reason from managers but still show who changed which keys', async () => {
  const store = memoryStore();
  const payroll = entry({ entity: { collection: 'employee_profiles', id: 'crew1' }, action: 'payroll.rate', before: { hourlyRate: 25, displayName: 'Synthetic Crew' }, after: { hourlyRate: 31.37, displayName: 'Synthetic Crew' }, reason: 'Synthetic raise to $31.37/hr', visibility: 'owner', now: '2026-09-22T12:00:00.000Z' });
  const business = entry({ now: '2026-09-22T11:00:00.000Z' });
  const odd = entry({ now: '2026-09-22T10:00:00.000Z' }), old = entry({ now: '2026-09-22T09:00:00.000Z' });
  const { visibility: _omitted, ...legacyPatch } = old.patch;
  await store.commit([payroll, business, { ...odd, patch: { ...odd.patch, visibility: 'unexpected' } }, { ...old, patch: legacyPatch }]);
  assert.equal(payroll.patch.visibility, 'owner');
  const byReader = async reader => (await listAudit(store, {}, reader)).entries;
  for (const reader of [manager, null, { ...manager, role: 'owner' }, { ...owner, businessAccess: false }]) {
    const [rate, visible, unknown, legacy] = await byReader(reader);
    assert.deepEqual([rate.before, rate.after, rate.reason, rate.withheld, rate.visibility], [null, null, null, true, 'owner'], JSON.stringify(reader));
    assert.deepEqual([rate.action, rate.actor.id, rate.entity, rate.changedKeys], ['payroll.rate', 'zacb', { collection: 'employee_profiles', id: 'crew1' }, ['hourlyRate']]);
    assert.ok(!JSON.stringify(rate).includes('31.37'), 'The new pay rate never reaches a manager.');
    assert.deepEqual([visible.before, visible.after, visible.withheld, visible.visibility], [{ status: 'sent' }, { status: 'void' }, undefined, 'business']);
    assert.deepEqual([unknown.before, unknown.withheld, unknown.visibility], [null, true, 'owner'], 'An unrecognized visibility fails closed.');
    assert.deepEqual([legacy.before, legacy.visibility], [{ status: 'sent' }, 'business'], 'Rows from before visibility existed stay business rows.');
  }
  const [rate] = await byReader(owner);
  assert.deepEqual([rate.before, rate.after, rate.reason, rate.withheld], [{ hourlyRate: 25, displayName: 'Synthetic Crew' }, { hourlyRate: 31.37, displayName: 'Synthetic Crew' }, 'Synthetic raise to $31.37/hr', undefined]);
  const handlers = session => hubAuditHandlers({ session: async () => session, storage: () => store, now: () => new Date(NOW) });
  const read = async session => (await (await handlers(session).get({ env: {}, request: new Request('https://easygaragecleaning.com/api/hub-audit?limit=1') })).json()).entries[0];
  assert.deepEqual([(await read(manager)).after, (await read(manager)).withheld], [null, true], 'GET /api/hub-audit withholds owner-only snapshots from a manager session.');
  assert.deepEqual((await read(owner)).after, { hourlyRate: 31.37, displayName: 'Synthetic Crew' });
});

test('snapshots and reasons are bounded and flagged as truncated', () => {
  const huge = { text: 'x'.repeat(5000), list: Array.from({ length: 80 }, (_, index) => index), deep: { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } }, keys: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`k${index}`, index])) };
  const write = entry({ before: huge, after: null, reason: 'r'.repeat(900) });
  const saved = JSON.parse(write.patch.before);
  assert.equal(write.patch.truncated, true);
  assert.ok(saved.text.length < 2100 && saved.text.endsWith('…[truncated]'));
  assert.equal(saved.list.length, 50); assert.equal(Object.keys(saved.keys).length, 100);
  assert.equal(saved.deep.a.b.c.d.e, '[depth limit]');
  assert.equal(write.patch.reason.length, 500);
  const oversized = entry({ after: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, 'y'.repeat(1900)])) });
  const after = JSON.parse(oversized.patch.after);
  assert.equal(after._truncated, true); assert.equal(after.keys.length, 50); assert.equal(oversized.patch.truncated, true);
  for (const write of [entry({ before: huge }), oversized]) assert.ok(new TextEncoder().encode(JSON.stringify(write.patch)).byteLength < 40000, 'Audit documents stay far below Firestore limits.');
  const circular = {}; circular.self = circular;
  assert.deepEqual(auditSnapshot(circular), { _unserializable: true });
  assert.equal(entry({ before: { big: 10n } }).patch.truncated, true);
});

test('an audit entry commits atomically with the change: a conflict rolls back both', async () => {
  const store = memoryStore();
  await store.commit([{ collection: 'jobs', id: 'job-1', patch: { status: 'sent', invoiceTotalCents: 45000 } }]);
  const job = await store.read('jobs', 'job-1');
  const change = revision => [{ collection: 'jobs', id: 'job-1', revision, patch: { status: 'void' } }, entry({ requestId: randomUUID() })];
  await assert.rejects(store.commit(change('stale-revision')), error => error.status === 409);
  assert.equal((await store.read('jobs', 'job-1')).status, 'sent');
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('hub_audit/')).length, 0, 'No audit entry exists for a change that did not happen.');
  const [update, audit] = change(job.revision);
  await store.commit([update, audit]);
  assert.equal((await store.read('jobs', 'job-1')).status, 'void');
  assert.equal((await store.read('hub_audit', audit.id)).action, 'invoice.void');
  await assert.rejects(store.commit([{ ...update, revision: (await store.read('jobs', 'job-1')).revision }, audit]), error => error.status === 409, 'Replaying the same entry cannot duplicate it.');
  assert.equal((await store.read('jobs', 'job-1')).status, 'void');
  const page = await listAudit(store, { entity: 'jobs/job-1' });
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].id, audit.id);
});

test('dispatch, scheduling and business stores send the audit entry inside the same single commit', async t => {
  const audit = entry(), response = () => Response.json({ writeResults: [] });
  const sent = [];
  const fetcher = async (_env, url, options) => { sent.push({ url: String(url), body: JSON.parse(options.body) }); return response(); };
  await dispatchStorage({}, fetcher).commit([{ collection: 'jobs', id: 'job-1', revision: 'r1', patch: { status: 'void' } }, audit]);
  await schedulingStorage({}, fetcher).commit([{ collection: 'jobs', id: 'job-1', revision: 'r1', patch: { status: 'void' } }, audit]);
  t.mock.method(globalThis, 'fetch', async (url, options) => { assert.equal(new URL(url).hostname, 'firestore.googleapis.com'); sent.push({ url: String(url), body: JSON.parse(options.body) }); return response(); });
  await createBusinessStore({ FIREBASE_API_KEY: 'firebase-test-hub-audit' }).commit([{ collection: 'business_accounts', id: 'a'.repeat(32), version: 'v1', data: { status: 'active' }, patch: true }, audit]);
  assert.equal(sent.length, 3, 'Each store made exactly one request.');
  for (const { url, body } of sent) {
    assert.match(url, /:commit(?:\?|$)/);
    assert.equal(body.writes.length, 2);
    const [change, saved] = body.writes;
    assert.ok(change.currentDocument.updateTime, 'The business change keeps its revision precondition.');
    assert.equal(saved.update.name, `${ROOT}/hub_audit/${audit.id}`);
    assert.deepEqual(saved.currentDocument, { exists: false });
    assert.deepEqual(saved.update.fields, encodeFirestoreFields(audit.patch));
  }
});

test('listAudit pages newest first with stable cursors and exact entity, actor and Denver date filters', async () => {
  const store = memoryStore();
  const times = ['2026-09-21T05:59:59.999Z', '2026-09-21T06:00:00.000Z', '2026-09-21T18:00:00.000Z', '2026-09-22T05:59:59.999Z', '2026-09-22T06:00:00.000Z', '2026-09-23T01:00:00.000Z'];
  const writes = times.map((now, index) => entry({ now, actor: { id: index % 2 ? 'tylerg' : 'zacb', kind: 'human', role: index % 2 ? 'manager' : 'owner' }, entity: { collection: 'jobs', id: index < 4 ? 'job-1' : 'job-2' } }));
  await store.commit(writes);
  const all = [];
  let cursor, pages = 0;
  do { const page = await listAudit(store, { limit: '2', ...(cursor ? { cursor } : {}) }); pages++; all.push(...page.entries); cursor = page.nextCursor; assert.ok(page.entries.length <= 2); } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(all.map(item => item.at), [...times].reverse());
  assert.equal((await listAudit(store, {})).limit, 50);
  const ids = page => page.entries.map(item => item.at);
  assert.deepEqual(ids(await listAudit(store, { entity: 'jobs/job-2' })), [times[5], times[4]]);
  assert.deepEqual(ids(await listAudit(store, { actor: 'TylerG' })), [times[5], times[3], times[1]]);
  assert.deepEqual(ids(await listAudit(store, { entity: 'jobs/job-1', actor: 'zacb' })), [times[2], times[0]]);
  // 2026-09-21 in Denver (MDT, UTC-6) is [06:00Z on the 21st, 06:00Z on the 22nd).
  assert.deepEqual(ids(await listAudit(store, { startDate: '2026-09-21', endDate: '2026-09-22' })), [times[3], times[2], times[1]]);
  assert.deepEqual(ids(await listAudit(store, { startDate: '2026-09-22' })), [times[5], times[4]]);
  assert.deepEqual(ids(await listAudit(store, { endDate: '2026-09-21' })), [times[0]]);
  // 01:00Z on the 23rd is still 19:00 on the 22nd in Denver.
  const first = await listAudit(store, { startDate: '2026-09-21', endDate: '2026-09-23', limit: '1' });
  assert.deepEqual(ids(first), [times[5]]);
  assert.deepEqual(ids(await listAudit(store, { startDate: '2026-09-21', endDate: '2026-09-23', limit: '2', cursor: first.nextCursor })), [times[4], times[3]]);
  assert.deepEqual(ids(await listAudit(store, { startDate: '2026-09-21', endDate: '2026-09-22' })).length, 3);
  const [newest] = (await listAudit(store, { limit: '1' })).entries;
  assert.deepEqual(newest.actor, { id: 'tylerg', kind: 'human', role: 'manager' });
  assert.deepEqual([newest.before, newest.after, newest.changedKeys], [{ status: 'sent' }, { status: 'void' }, ['status']]);
});

test('listAudit validates filters and fails closed on incomplete or out-of-filter pages', async () => {
  const store = memoryStore();
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '2.5' }, { limit: 'all' }, { entity: 'jobs' }, { entity: 'jobs/a/b' }, { entity: '../x/y' }, { actor: 'bad actor!' },
    { startDate: '2026-02-30' }, { endDate: '09/22/2026' }, { startDate: '2026-09-22', endDate: '2026-09-22' }, { cursor: '../../jobs' },
    // Dates before 1970 or with years below 100 used to become id bounds no entry can match: an empty page that looked complete.
    { startDate: '1969-12-31' }, { endDate: '1969-12-31' }, { startDate: '0099-06-01' }, { endDate: '0001-01-01' }, { startDate: '1999-12-31' }, { startDate: 20260922 }]) {
    await assert.rejects(listAudit(store, query), error => error.code === 'hub_audit_query_invalid' && error.status === 400, JSON.stringify(query));
  }
  const a = entry({ now: '2026-09-22T12:00:00.000Z' }), b = entry({ now: '2026-09-22T11:00:00.000Z' });
  const rows = [{ ...a.patch, id: a.id }, { ...b.patch, id: b.id }];
  const broken = [null, { rows: [] }, [rows[1], rows[0]], [rows[0], rows[0]], [rows[0], rows[1], rows[1], rows[1]], [{ ...rows[0], id: '../escape' }]];
  for (const result of broken) await assert.rejects(listAudit({ auditPage: async () => result }, { limit: '2' }), error => error.code === 'hub_audit_storage_incomplete' && error.status === 503);
  await assert.rejects(listAudit({ auditPage: async () => rows }, { entity: 'jobs/other' }), error => error.code === 'hub_audit_storage_incomplete');
  await assert.rejects(listAudit({ auditPage: async () => rows }, { actor: 'someone' }), error => error.code === 'hub_audit_storage_incomplete');
  await assert.rejects(listAudit({ auditPage: async () => rows }, { startDate: '2026-09-23' }), error => error.code === 'hub_audit_storage_incomplete');
  await assert.rejects(listAudit({ auditPage: async () => rows }, { cursor: a.id }), error => error.code === 'hub_audit_storage_incomplete');
  assert.deepEqual((await listAudit(store, { startDate: '2000-01-01', endDate: '9999-12-31' })).entries, [], 'The widest accepted range is a valid query.');
  // Rows written outside auditWrite are re-redacted and never hidden.
  const [legacy] = (await listAudit({ auditPage: async () => [{ id: a.id, at: NOW, before: JSON.stringify({ password: 'CANARY', ok: 1 }), after: '{broken', actor: { id: 'zacb', kind: 'human' }, entity: { collection: 'jobs', id: 'x' } }] }, {})).entries;
  assert.deepEqual(legacy.before, { password: '[redacted]', ok: 1 });
  assert.equal(legacy.after, null); assert.equal(legacy.unreadable, true); assert.equal(legacy.action, null);
});

test('Firestore audit storage runs one bounded structured query and rejects unverifiable documents', async () => {
  const calls = [];
  const a = entry();
  const document = (id, fields = encodeFirestoreFields(a.patch)) => ({ document: { name: `${ROOT}/hub_audit/${id}`, updateTime: '2026-09-22T12:00:00.000001Z', fields }, readTime: NOW });
  const storage = responder => hubAuditStorage({}, async (_env, url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return responder(); });
  const rows = await storage(() => Response.json([document(a.id), { readTime: NOW }])).auditPage({ entityKey: 'jobs/job-1', actorId: 'zacb', fromId: '000000000001', beforeId: 'ffffffffff00', after: 'abc123', limit: 26 });
  assert.equal(rows.length, 1); assert.equal(rows[0].id, a.id); assert.equal(rows[0].action, 'invoice.void'); assert.equal(rows[0].revision, '2026-09-22T12:00:00.000001Z');
  assert.match(calls[0].url, /\/documents:runQuery$/);
  const query = calls[0].body.structuredQuery;
  assert.deepEqual(query.from, [{ collectionId: 'hub_audit' }]);
  assert.deepEqual(query.orderBy, [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }]);
  assert.equal(query.limit, 26);
  assert.deepEqual(query.where.compositeFilter.filters.map(filter => [filter.fieldFilter.field.fieldPath, filter.fieldFilter.op]), [['entityKey', 'EQUAL'], ['actor.id', 'EQUAL'], ['__name__', 'GREATER_THAN_OR_EQUAL'], ['__name__', 'LESS_THAN']]);
  assert.equal(query.where.compositeFilter.filters[2].fieldFilter.value.referenceValue, `${ROOT}/hub_audit/000000000001`);
  assert.deepEqual(query.startAt, { values: [{ referenceValue: `${ROOT}/hub_audit/abc123` }], before: false });
  await storage(() => Response.json([])).auditPage({ limit: 51 });
  assert.equal(calls[1].body.structuredQuery.where, undefined); assert.equal(calls[1].body.structuredQuery.startAt, undefined);
  await storage(() => Response.json([])).auditPage({ actorId: 'zacb', limit: 5 });
  assert.equal(calls[2].body.structuredQuery.where.fieldFilter.field.fieldPath, 'actor.id');
  for (const body of [{ documents: [] }, [document('x', [])], [{ document: { name: `${ROOT}/jobs/${a.id}`, updateTime: NOW, fields: {} } }], [{ document: { name: `${ROOT}/hub_audit/${a.id}`, fields: {} } }]]) {
    await assert.rejects(storage(() => Response.json(body)).auditPage({ limit: 5 }), error => error.code === 'hub_audit_storage_incomplete');
  }
  await assert.rejects(storage(() => Response.json({}, { status: 400 })).auditPage({ limit: 5 }), error => error.code === 'hub_audit_unavailable' && error.status === 503);
  await assert.rejects(hubAuditStorage({}, async () => { throw new Error('network'); }).auditPage({ limit: 5 }), error => error.code === 'hub_audit_unavailable');
});

test('only owner and manager business sessions may read the audit', () => {
  assert.throws(() => requireAuditReader(null), error => error.code === 'hub_audit_sign_in_required' && error.status === 401);
  for (const session of [{ user: 'crew1', role: 'crew' }, { user: 'zacb', role: 'crew_lead', businessAccess: true }, { user: 'alexk', role: 'sales', businessAccess: true }, { user: 'someone', role: 'owner', businessAccess: true }, { user: 'tylerg', role: 'manager', businessAccess: false }]) {
    assert.throws(() => requireAuditReader(session), error => error.code === 'hub_audit_forbidden' && error.status === 403, JSON.stringify(session));
  }
  assert.doesNotThrow(() => requireAuditReader(owner)); assert.doesNotThrow(() => requireAuditReader(manager));
});

test('GET /api/hub-audit enforces auth, same-origin reads, strict filters, pagination and no-store', async () => {
  const store = memoryStore();
  await store.commit(['2026-09-22T10:00:00.000Z', '2026-09-22T11:00:00.000Z', '2026-09-22T12:00:00.000Z'].map(now => entry({ now })));
  let actor = null, touched = 0;
  const clock = new Date('2026-09-22T12:30:00.000Z');
  const handlers = hubAuditHandlers({ session: async () => actor, storage: () => { touched++; return store; }, now: () => clock });
  const url = 'https://easygaragecleaning.com/api/hub-audit';
  const get = (query = '', headers = {}) => handlers.get({ env: {}, request: new Request(`${url}${query}`, { headers }) });
  let response = await get();
  assert.equal(response.status, 401); assert.equal((await response.json()).code, 'hub_audit_sign_in_required');
  actor = { user: 'crew1', role: 'crew' };
  response = await get();
  assert.equal(response.status, 403); assert.equal((await response.json()).code, 'hub_audit_forbidden');
  actor = { user: 'alexk', role: 'sales', businessAccess: true };
  assert.equal((await get()).status, 403);
  assert.equal(touched, 0, 'Storage is never opened for unauthorized readers.');
  actor = owner;
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://attacker.example' }, { Referer: 'https://attacker.example/page' }, { Origin: 'null' }]) {
    response = await get('', headers);
    assert.equal(response.status, 403, JSON.stringify(headers)); assert.equal((await response.json()).code, 'hub_audit_origin_forbidden');
  }
  assert.equal(touched, 0);
  for (const query of ['?limit=1&limit=2', '?unknown=1', '?entity=jobs/a&Entity=jobs/b', '?limit=500', '?startDate=2026-13-01']) {
    response = await get(query);
    assert.equal(response.status, 400, query); assert.equal((await response.json()).code, 'hub_audit_query_invalid');
  }
  response = await get('?limit=2', { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://easygaragecleaning.com' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const first = await response.json();
  assert.equal(first.ok, true); assert.equal(first.authority, 'employee_hub'); assert.equal(first.asOf, clock.toISOString());
  assert.deepEqual(first.entries.map(item => item.at), ['2026-09-22T12:00:00.000Z', '2026-09-22T11:00:00.000Z']);
  actor = manager;
  const second = await (await get(`?limit=2&cursor=${first.nextCursor}`, { Referer: 'https://easygaragecleaning.com/employee' })).json();
  assert.deepEqual(second.entries.map(item => item.at), ['2026-09-22T10:00:00.000Z']); assert.equal(second.nextCursor, null);
  const filtered = await (await get('?entity=jobs/job-1&actor=zacb&startDate=2026-09-22&endDate=2026-09-23')).json();
  assert.equal(filtered.entries.length, 3); assert.deepEqual(filtered.filters, { entity: 'jobs/job-1', actor: 'zacb', startDate: '2026-09-22', endDate: '2026-09-23' });
  for (const method of ['onRequestPost', 'onRequestPut', 'onRequestPatch', 'onRequestDelete']) {
    const module = await import('../functions/api/hub-audit.js');
    response = await module[method]({ env: {}, request: new Request(url, { method: method.slice(9).toUpperCase(), headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: '{}' }) });
    assert.equal(response.status, 405); assert.equal(response.headers.get('Allow'), 'GET'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const failing = hubAuditHandlers({ session: async () => owner, storage: () => ({ auditPage: async () => { throw new Error('raw provider detail'); } }), now: () => clock });
  response = await failing.get({ env: {}, request: new Request(url) });
  const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.code, 'hub_audit_unavailable'); assert.ok(!JSON.stringify(body).includes('raw provider detail'));
  const unavailable = hubAuditHandlers({ session: async () => owner, storage: () => hubAuditStorage({}, async () => Response.json({}, { status: 500 })), now: () => clock });
  assert.equal((await (await unavailable.get({ env: {}, request: new Request(url) })).json()).code, 'hub_audit_unavailable');
});
