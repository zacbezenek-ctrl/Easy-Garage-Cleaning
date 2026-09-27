import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import { PURPOSES, purposeKey, purposeKeyRoot, purposeSign, purposeVerify } from '../functions/_lib/purpose-keys.js';
import { createHubSessionToken, verifyHubSessionToken } from '../functions/_lib/hub-session.js';

const ROOT = 'synthetic-hub-session-root-secret-0123456789abcdef';
const DEDICATED = 'synthetic-dedicated-purpose-root-fedcba9876543210';
const env = { HUB_SESSION_SECRET: ROOT };
const b64 = bytes => Buffer.from(bytes).toString('base64url');
// Independent Node implementation of the documented derivation.
const expected = (root, label, message) => b64(createHmac('sha256', Buffer.from(hkdfSync('sha256', root, 'egc/purpose-keys/v1', label, 32))).update(message).digest());

test('each registered purpose derives a distinct HMAC key from the same root', async () => {
  assert.deepEqual(Object.values(PURPOSES).sort(), ['egc/confirm/v1', 'egc/customer-account-session/v1', 'egc/magic-link/v1', 'egc/rate-limit/v1']);
  const signatures = await Promise.all(Object.values(PURPOSES).map(label => purposeSign(env, label, 'same message')));
  assert.equal(new Set(signatures).size, signatures.length);
  for (const [index, label] of Object.values(PURPOSES).entries()) {
    assert.equal(signatures[index], expected(ROOT, label, 'same message'), label);
    for (const other of Object.values(PURPOSES).filter(item => item !== label)) assert.equal(await purposeVerify(env, other, 'same message', signatures[index]), false, `${label} must not verify as ${other}`);
  }
  const key = await purposeKey(env, PURPOSES.confirm);
  assert.equal(key.type, 'secret'); assert.equal(key.extractable, false);
  assert.deepEqual([...key.usages].sort(), ['sign', 'verify']); assert.equal(key.algorithm.name, 'HMAC');
});

test('derivation is deterministic across calls and verification is exact', async () => {
  const first = await purposeSign(env, PURPOSES.magicLink, 'payload');
  assert.equal(await purposeSign({ ...env }, PURPOSES.magicLink, 'payload'), first);
  assert.equal(await purposeVerify(env, PURPOSES.magicLink, 'payload', first), true);
  assert.equal(await purposeVerify(env, PURPOSES.magicLink, 'payload!', first), false);
  const tampered = (first[0] === 'A' ? 'B' : 'A') + first.slice(1);
  for (const signature of [tampered, first.slice(1), `${first}A`, '', 'not base64!', null, 42, 'A'.repeat(5000)]) assert.equal(await purposeVerify(env, PURPOSES.magicLink, 'payload', signature), false);
  assert.notEqual(await purposeSign({ HUB_SESSION_SECRET: `${ROOT}x` }, PURPOSES.magicLink, 'payload'), first, 'A different root yields a different key.');
});

test('a missing, short, oversized or non-string root fails closed with a 503 code', async () => {
  const roots = [{}, { HUB_SESSION_SECRET: '' }, { HUB_SESSION_SECRET: 'x'.repeat(31) }, { HUB_SESSION_SECRET: 'x'.repeat(8193) }, { HUB_SESSION_SECRET: 12345678901234567890123456789012345 },
    // A weak dedicated secret never silently falls back to the session secret.
    { HUB_SESSION_SECRET: ROOT, HUB_PURPOSE_KEY_SECRET: 'short-dedicated' }];
  for (const candidate of roots) {
    assert.throws(() => purposeKeyRoot(candidate), error => error.code === 'purpose_key_unavailable' && error.status === 503);
    await assert.rejects(purposeSign(candidate, PURPOSES.confirm, 'message'), error => error.code === 'purpose_key_unavailable' && error.status === 503);
    await assert.rejects(purposeVerify(candidate, PURPOSES.confirm, 'message', 'A'.repeat(43)), error => error.code === 'purpose_key_unavailable');
  }
  assert.equal(purposeKeyRoot({ HUB_SESSION_SECRET: 'x'.repeat(32) }).name, 'HUB_SESSION_SECRET');
  await assert.rejects(purposeSign(env, 'egc/unregistered/v1', 'message'), error => error.code === 'purpose_key_label_invalid');
  await assert.rejects(purposeKey(env, 'egc/confirm/v2'), error => error.code === 'purpose_key_label_invalid');
});

test('a dedicated root replaces the session root only for purpose keys', async () => {
  const dedicated = { HUB_SESSION_SECRET: ROOT, HUB_PURPOSE_KEY_SECRET: DEDICATED };
  assert.equal(purposeKeyRoot(dedicated).name, 'HUB_PURPOSE_KEY_SECRET');
  assert.equal(await purposeSign(dedicated, PURPOSES.confirm, 'message'), expected(DEDICATED, PURPOSES.confirm, 'message'));
  assert.notEqual(await purposeSign(dedicated, PURPOSES.confirm, 'message'), await purposeSign(env, PURPOSES.confirm, 'message'));
});

test('purpose keys never equal the raw secret and existing session tokens are not re-keyed', async () => {
  const hubEnv = { ...env, HUB_AUTH_USERS_JSON: JSON.stringify({ zacb: { passwordHash: 'synthetic', displayName: 'Synthetic Owner', role: 'owner' } }) };
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  const session = await createHubSessionToken(hubEnv, 'zacb', now);
  const [payload, signature] = session.split('.');
  // Sessions still sign with the raw HUB_SESSION_SECRET exactly as before SEC-00.
  assert.equal(signature, b64(createHmac('sha256', ROOT).update(payload).digest()));
  assert.equal((await verifyHubSessionToken(hubEnv, session, now + 1000))?.user, 'zacb');
  for (const label of Object.values(PURPOSES)) {
    const derived = await purposeSign(env, label, payload);
    assert.notEqual(derived, signature, `${label} must not reproduce a raw-secret signature`);
    assert.equal(await purposeVerify(env, label, payload, signature), false, `${label} must reject a session signature`);
    assert.equal(await verifyHubSessionToken(hubEnv, `${payload}.${derived}`, now + 1000), null, `a ${label} signature must not become a session`);
  }
});
