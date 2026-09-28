import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { confirmationPayloadHash, confirmations, consumeConfirmation, issueConfirmation, verifyConfirmation } from '../functions/_lib/confirm-token.js';
import { PURPOSES, purposeSign } from '../functions/_lib/purpose-keys.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { auditWrite } from '../functions/_lib/hub-audit.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const env = { HUB_SESSION_SECRET: 'synthetic-hub-session-root-secret-0123456789abcdef' };
const NOW = '2026-09-22T12:00:00.000Z';
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();
const payload = { jobId: 'job-1', amountCents: 45000, recipient: 'synthetic.customer@example.invalid', lines: [{ name: 'Synthetic cleanout', cents: 45000 }] };
const action = { actorId: 'zacb', action: 'invoice.send', entityId: 'job-1', payload };
const issue = (overrides = {}) => issueConfirmation(env, { ...action, now: NOW, ...overrides });
const decode = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const sha256 = text => createHash('sha256').update(text).digest('hex');

function memoryStore({ beforeCommit = async () => {} } = {}) {
  const rows = new Map();
  let revision = 0, commits = 0;
  return {
    rows, get commits() { return commits; },
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      commits++;
      await beforeCommit(writes);
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
}
const expected = (overrides = {}) => ({ ...action, now: at(60000), ...overrides });

test('issue binds actor, action, record and a payload digest in a signed five-minute token without the payload itself', async () => {
  const issued = await issue({ summary: '  Send invoice for $450.00 to Synthetic Customer  ' });
  assert.match(issued.confirmationId, /^[a-f0-9]{64}$/);
  assert.equal(issued.expiresAt, at(300000));
  assert.equal(issued.summary, 'Send invoice for $450.00 to Synthetic Customer');
  assert.equal(issued.payloadHash, await confirmationPayloadHash(payload));
  assert.match(issued.token, /^ect1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const claims = decode(issued.token);
  assert.deepEqual(Object.keys(claims).sort(), ['a', 'e', 'exp', 'h', 'iat', 'n', 'v', 'x']);
  assert.deepEqual([claims.a, claims.x, claims.e, claims.iat, claims.exp], ['zacb', 'invoice.send', 'job-1', Date.parse(NOW), Date.parse(NOW) + 300000]);
  assert.equal(issued.confirmationId, sha256(claims.n), 'The single-use id is sha256(nonce).');
  assert.ok(!issued.token.includes('example') && !Buffer.from(issued.token.split('.')[1], 'base64url').toString().includes('45000'), 'Tokens carry only a digest of the payload.');
  assert.equal(claims.h, sha256('{"amountCents":45000,"jobId":"job-1","lines":[{"cents":45000,"name":"Synthetic cleanout"}],"recipient":"synthetic.customer@example.invalid"}'));
  assert.equal((await issue()).summary, 'Confirm invoice.send for job-1');
  assert.notEqual((await issue()).confirmationId, issued.confirmationId, 'Each confirmation has a fresh nonce.');
  assert.equal((await issue({ ttlSeconds: 60 })).expiresAt, at(60000));
  assert.equal((await issue({ actorId: '  ZacB ' })).token.length > 0, true);
  assert.equal(decode((await issue({ actorId: '  ZacB ' })).token).a, 'zacb');
  for (const overrides of [{ ttlSeconds: 301 }, { ttlSeconds: 0 }, { ttlSeconds: 1.5 }, { actorId: '' }, { actorId: 'bad actor' }, { action: 'Invoice Send' }, { entityId: '' }, { entityId: 'x'.repeat(201) },
    { now: 'not a time' }, { now: Date.parse(NOW) }, { summary: 42 }, { payload: { big: 10n } }, { payload: { blob: 'x'.repeat(300000) } }]) {
    await assert.rejects(issue(overrides), error => error.code === 'confirm_token_input_invalid' && error.status === 400, JSON.stringify(overrides, (_k, v) => typeof v === 'bigint' ? 'bigint' : v));
  }
  await assert.rejects(issueConfirmation({}, { ...action, now: NOW }), error => error.code === 'purpose_key_unavailable' && error.status === 503);
});

test('consume creates confirm_tokens/{sha256(nonce)} atomically with the confirmed change', async () => {
  const store = memoryStore(), issued = await issue(), requestId = randomUUID();
  await store.commit([{ collection: 'jobs', id: 'job-1', patch: { invoiceStatus: 'ready' } }]);
  const job = await store.read('jobs', 'job-1');
  const audit = auditWrite({ actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', action: 'invoice.send', entity: { collection: 'jobs', id: 'job-1' }, requestId, now: at(60000) });
  const result = await consumeConfirmation(env, store, issued.token, expected({ requestId }), [{ collection: 'jobs', id: 'job-1', revision: job.revision, patch: { invoiceStatus: 'sending' } }, audit]);
  assert.deepEqual(result, { ok: true, confirmationId: issued.confirmationId, consumedAt: at(60000), replayed: false });
  const saved = await store.read('confirm_tokens', issued.confirmationId);
  // attemptId is random per call (not the requestId) so a read-back can tell this call's own commit from another call with the same requestId.
  assert.match(saved.attemptId, /^[a-f0-9]{32}$/); assert.notEqual(saved.attemptId, requestId.replaceAll('-', ''));
  assert.deepEqual({ ...saved, revision: undefined }, { v: 1, confirmationId: issued.confirmationId, actorId: 'zacb', action: 'invoice.send', entityId: 'job-1', payloadHash: issued.payloadHash, issuedAt: NOW, expiresAt: issued.expiresAt, consumedAt: at(60000), attemptId: saved.attemptId, requestId, id: issued.confirmationId, revision: undefined });
  assert.ok(!JSON.stringify(saved).includes(decode(issued.token).n), 'The raw nonce is never stored.');
  assert.equal((await store.read('jobs', 'job-1')).invoiceStatus, 'sending');
  assert.ok(await store.read('hub_audit', audit.id));
  assert.equal(store.commits, 2, 'Token, change and audit were one commit.');
});

test('payload tampering, actor swap, action swap and record swap are rejected without consuming the token', async () => {
  const store = memoryStore(), issued = await issue();
  const mismatches = [
    { payload: { ...payload, amountCents: 45001 } }, { payload: { ...payload, recipient: 'other@example.invalid' } }, { payload: { ...payload, lines: [] } }, { payload: undefined },
    { actorId: 'tylerg' }, { action: 'invoice.void' }, { entityId: 'job-2' },
  ];
  for (const overrides of mismatches) {
    await assert.rejects(consumeConfirmation(env, store, issued.token, expected(overrides), [{ collection: 'jobs', id: 'job-1', patch: { sent: true } }]), error => error.code === 'confirm_token_mismatch' && error.status === 403, JSON.stringify(overrides));
  }
  assert.equal(store.commits, 0); assert.equal(store.rows.size, 0);
  const reordered = { lines: [{ cents: 45000, name: 'Synthetic cleanout' }], recipient: payload.recipient, amountCents: 45000, jobId: 'job-1', ignored: undefined };
  assert.equal((await consumeConfirmation(env, store, issued.token, expected({ payload: reordered, actorId: 'ZACB' }))).ok, true, 'Key order, casing of the account and undefined keys do not matter.');
});

test('forged, re-signed or malformed tokens are invalid', async () => {
  const issued = await issue(), [prefix, body, signature] = issued.token.split('.');
  const claims = decode(issued.token);
  const forgedBody = Buffer.from(JSON.stringify({ ...claims, h: await confirmationPayloadHash({ ...payload, amountCents: 1 }) })).toString('base64url');
  const otherPurpose = await purposeSign(env, PURPOSES.magicLink, `${prefix}.${body}`);
  const otherRoot = (await issueConfirmation({ HUB_SESSION_SECRET: 'synthetic-other-root-secret-0123456789abcdefgh' }, { ...action, now: NOW })).token;
  const longBody = Buffer.from(JSON.stringify({ ...claims, exp: claims.iat + 3600000 })).toString('base64url');
  const tokens = [`${prefix}.${forgedBody}.${signature}`, `${prefix}.${body}.${otherPurpose}`, otherRoot, `ect2.${body}.${signature}`, `${prefix}.${body}`, `${issued.token}.extra`,
    `${prefix}.${body}.${signature.slice(0, -1)}${signature.at(-1) === 'A' ? 'B' : 'A'}`, `${prefix}.${longBody}.${await purposeSign(env, PURPOSES.confirm, `${prefix}.${longBody}`)}`,
    '', null, 42, `${issued.token}${'A'.repeat(3000)}`];
  for (const token of tokens) await assert.rejects(verifyConfirmation(env, token, expected()), error => error.code === 'confirm_token_invalid' && error.status === 403, String(token).slice(0, 40));
  const resigned = Buffer.from(JSON.stringify({ ...claims, a: 'tylerg' })).toString('base64url');
  const valid = `${prefix}.${resigned}.${await purposeSign(env, PURPOSES.confirm, `${prefix}.${resigned}`)}`;
  assert.equal((await verifyConfirmation(env, valid, expected({ actorId: 'tylerg' }))).actorId, 'tylerg', 'Only the server key can bind an actor.');
});

test('expiry and issue time are enforced with the injected clock', async () => {
  const issued = await issue(), store = memoryStore();
  assert.equal((await verifyConfirmation(env, issued.token, expected({ now: at(299999) }))).expiresAt, at(300000));
  for (const now of [at(300000), at(300001), at(86400000)]) await assert.rejects(consumeConfirmation(env, store, issued.token, expected({ now })), error => error.code === 'confirm_token_expired' && error.status === 410);
  assert.equal(store.commits, 0);
  const short = await issue({ ttlSeconds: 30 });
  await assert.rejects(verifyConfirmation(env, short.token, expected({ now: at(30000) })), error => error.code === 'confirm_token_expired');
  const future = await issue({ now: at(120000) });
  await assert.rejects(verifyConfirmation(env, future.token, expected({ now: NOW })), error => error.code === 'confirm_token_invalid', 'A token issued in the future is refused.');
  assert.ok(await verifyConfirmation(env, (await issue({ now: at(30000) })).token, expected({ now: NOW })), 'Small clock skew is tolerated.');
  await assert.rejects(verifyConfirmation(env, issued.token, expected({ now: undefined })), error => error.code === 'confirm_token_input_invalid');
  assert.equal((await consumeConfirmation(env, store, issued.token, expected({ now: at(299999) }))).consumedAt, at(299999));
});

test('a used token is rejected on replay and the replayed change is not applied', async () => {
  const store = memoryStore(), issued = await issue();
  await consumeConfirmation(env, store, issued.token, expected(), [{ collection: 'jobs', id: 'send-1', patch: { attempt: 1 } }]);
  for (const requestId of [undefined, randomUUID()]) {
    await assert.rejects(consumeConfirmation(env, store, issued.token, expected({ requestId }), [{ collection: 'jobs', id: 'send-2', patch: { attempt: 2 } }]), error => error.code === 'confirm_token_used' && error.status === 409);
  }
  assert.equal(await store.read('jobs', 'send-2'), null);
  await assert.rejects(consumeConfirmation(env, store, issued.token, expected({ requestId: 'not-a-uuid' })), error => error.code === 'confirm_token_input_invalid');
});

test('concurrent consumes of one token: exactly one succeeds', async () => {
  const store = memoryStore({ beforeCommit: () => new Promise(resolve => setImmediate(resolve)) }), issued = await issue();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => consumeConfirmation(env, store, issued.token, expected({ requestId: randomUUID() }), [{ collection: 'sends', id: `send-${index}`, patch: { index } }])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'confirm_token_used'));
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('sends/')).length, 1, 'Only the winning change was applied.');
});

test('the Firestore create-only precondition makes consumption single-use through the real dispatch storage adapter', async () => {
  const docs = new Map();
  let clock = 0;
  const root = 'projects/egcw-1ec83/databases/(default)/documents/';
  const fetcher = async (_env, url, options = {}) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'firestore.googleapis.com');
    if (target.pathname.endsWith(':commit')) {
      await new Promise(resolve => setImmediate(resolve));
      const { writes } = JSON.parse(options.body);
      for (const write of writes) {
        const existing = docs.get(write.update.name);
        if (write.currentDocument.exists === false ? existing : existing?.updateTime !== write.currentDocument.updateTime) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 412 });
      }
      for (const write of writes) docs.set(write.update.name, { name: write.update.name, fields: write.update.fields, updateTime: `2026-09-22T12:00:00.${String(++clock).padStart(6, '0')}Z` });
      return Response.json({ writeResults: writes.map(() => ({})) });
    }
    const name = decodeURIComponent(target.pathname.split('/v1/')[1]);
    return docs.has(name) ? Response.json(docs.get(name)) : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
  };
  const store = dispatchStorage({}, fetcher), issued = await issue();
  const results = await Promise.allSettled([0, 1, 2].map(() => consumeConfirmation(env, store, issued.token, expected({ requestId: randomUUID() }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code), ['confirm_token_used', 'confirm_token_used']);
  const saved = decodeFirestoreFields(docs.get(`${root}confirm_tokens/${issued.confirmationId}`).fields);
  assert.equal(saved.action, 'invoice.send'); assert.equal(saved.payloadHash, issued.payloadHash);
});

test('the business store adapter accepts confirmation receipts in its own commit and read paths', async t => {
  const docs = new Map(), issued = await issue();
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'firestore.googleapis.com'); assert.equal(target.searchParams.get('key'), 'firebase-test-confirm');
    if (target.pathname.endsWith(':commit')) {
      const { writes } = JSON.parse(options.body);
      if (writes.some(write => write.currentDocument.exists === false && docs.has(write.update.name))) return Response.json({}, { status: 409 });
      for (const write of writes) docs.set(write.update.name, { name: write.update.name, fields: write.update.fields, updateTime: NOW });
      return Response.json({ writeResults: [] });
    }
    const name = decodeURIComponent(target.pathname.split('/v1/')[1]);
    return docs.has(name) ? Response.json(docs.get(name)) : Response.json({}, { status: 404 });
  });
  const { createBusinessStore } = await import('../functions/_lib/business-hub-store.js');
  const store = createBusinessStore({ FIREBASE_API_KEY: 'firebase-test-confirm' });
  const account = { collection: 'business_accounts', id: 'b'.repeat(32), data: { status: 'active' } };
  assert.equal((await consumeConfirmation(env, store, issued.token, expected(), [account])).ok, true);
  assert.ok([...docs.keys()].some(name => name.endsWith(`/confirm_tokens/${issued.confirmationId}`)));
  await assert.rejects(consumeConfirmation(env, store, issued.token, expected(), [{ ...account, id: 'c'.repeat(32) }]), error => error.code === 'confirm_token_used');
});

test('a lost commit response is recovered by requestId; caller conflicts and storage failures are not mislabeled', async () => {
  const requestId = randomUUID();
  let lose = true;
  const store = memoryStore();
  const lossy = { read: store.read, async commit(writes) { await store.commit(writes); if (lose) { lose = false; throw Object.assign(new Error('lost'), { code: 'dispatch_outcome_unknown', status: 503 }); } } };
  const issued = await issue();
  assert.equal((await consumeConfirmation(env, lossy, issued.token, expected({ requestId }))).replayed, false, 'The read-back proves this attempt applied.');
  assert.equal((await consumeConfirmation(env, lossy, issued.token, expected({ requestId: requestId.toUpperCase() }))).replayed, true, 'Retrying the same request is recognized, not rejected.');
  await assert.rejects(consumeConfirmation(env, lossy, issued.token, expected({ requestId: randomUUID() })), error => error.code === 'confirm_token_used');

  const conflict = memoryStore(), second = await issue();
  await conflict.commit([{ collection: 'jobs', id: 'job-1', patch: { invoiceStatus: 'ready' } }]);
  await assert.rejects(consumeConfirmation(env, conflict, second.token, expected(), [{ collection: 'jobs', id: 'job-1', revision: 'stale', patch: { invoiceStatus: 'sending' } }]), error => error.code === 'dispatch_revision_conflict' && error.status === 409);
  assert.equal(await conflict.read('confirm_tokens', second.confirmationId), null, 'A rejected change leaves the token unused.');
  const current = await conflict.read('jobs', 'job-1');
  assert.equal((await consumeConfirmation(env, conflict, second.token, expected(), [{ collection: 'jobs', id: 'job-1', revision: current.revision, patch: { invoiceStatus: 'sending' } }])).ok, true);

  // The receipt is read before committing, so unreadable storage fails closed without sending anything.
  const third = await issue();
  let downCommits = 0;
  const unknown = async () => { downCommits++; throw Object.assign(new Error('unknown'), { code: 'dispatch_outcome_unknown', status: 503 }); };
  const down = { read: async () => { throw Object.assign(new Error('read unavailable'), { code: 'dispatch_storage_unavailable', status: 503 }); }, commit: unknown };
  await assert.rejects(consumeConfirmation(env, down, third.token, expected()), error => error.code === 'dispatch_storage_unavailable' && error.status === 503);
  assert.equal(downCommits, 0);
  // When the read-back after an unknown outcome fails, the original unknown outcome is reported, never success.
  let reads = 0;
  const flaky = { read: async () => { if (reads++) throw new Error('read unavailable'); return null; }, commit: unknown };
  await assert.rejects(consumeConfirmation(env, flaky, third.token, expected()), error => error.code === 'dispatch_outcome_unknown' && error.status === 503);
  const absent = { read: async () => null, commit: unknown };
  await assert.rejects(consumeConfirmation(env, absent, third.token, expected()), error => error.code === 'dispatch_outcome_unknown');
  await assert.rejects(consumeConfirmation(env, memoryStore(), third.token, expected(), 'not writes'), error => error.code === 'confirm_token_input_invalid');
});

test('a retry of a completed request is replayed from the receipt even when its stale caller write would fail first with 503', async () => {
  // Real Firestore reports a stale updateTime as FAILED_PRECONDITION, which a store may still map to 503
  // (dispatchStorage did before P0-4);
  // this store checks the caller's writes before the receipt, the order that previously misreported replayed:false.
  const rows = new Map();
  let revision = 0, commits = 0;
  const store = {
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      commits++;
      for (const write of [...writes].reverse()) {
        const old = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('precondition'), write.revision ? { code: 'dispatch_outcome_unknown', status: 503 } : { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  rows.set('jobs/job-1', { invoiceStatus: 'ready', id: 'job-1', revision: 'r0' });
  const issued = await issue(), requestId = randomUUID();
  const writes = [{ collection: 'jobs', id: 'job-1', revision: 'r0', patch: { invoiceStatus: 'sending' } }];
  const first = await consumeConfirmation(env, store, issued.token, expected({ requestId }), writes);
  assert.equal(first.replayed, false);
  const retry = await consumeConfirmation(env, store, issued.token, expected({ requestId, now: at(90000) }), writes);
  assert.deepEqual(retry, { ...first, replayed: true }, 'The retry reports the earlier consumption and its time.');
  assert.equal(commits, 1, 'A replay commits nothing.');
  await assert.rejects(consumeConfirmation(env, store, issued.token, expected({ requestId: randomUUID() }), writes), error => error.code === 'confirm_token_used');
  await assert.rejects(consumeConfirmation(env, store, issued.token, expected(), writes), error => error.code === 'confirm_token_used');
  assert.equal(commits, 1);
});

test('two concurrent calls with the same requestId: one applies, the other is a replay', async () => {
  const store = memoryStore({ beforeCommit: () => new Promise(resolve => setImmediate(resolve)) }), issued = await issue(), requestId = randomUUID();
  const results = await Promise.all([0, 1].map(index => consumeConfirmation(env, store, issued.token, expected({ requestId }), [{ collection: 'sends', id: `send-${index}`, patch: { index } }])));
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true], 'Exactly one caller is told it applied the change.');
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('sends/')).length, 1);
});

test('confirmations(env) binds the env once, and spec-shaped calls without the env fail loudly', async () => {
  const bound = confirmations(env), store = memoryStore();
  const issued = await bound.issue({ ...action, now: NOW });
  assert.equal((await bound.verify(issued.token, expected())).confirmationId, issued.confirmationId);
  assert.equal((await bound.consume(store, issued.token, expected(), [{ collection: 'sends', id: 'send-1', patch: { sent: true } }])).replayed, false);
  assert.ok(await store.read('sends', 'send-1'));
  await assert.rejects(issueConfirmation({ ...action, now: NOW }), TypeError);
  await assert.rejects(consumeConfirmation(store, issued.token, expected()), TypeError);
  await assert.rejects(consumeConfirmation(env, null, issued.token, expected()), TypeError);
});
