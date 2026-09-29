import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { PURPOSES, SEAL_MAX_BYTES, SEAL_PURPOSES, purposeFromBase64Url, purposeKey, purposeKeyRoot, purposeOpen, purposeSeal, purposeSign, purposeVerify } from '../functions/_lib/purpose-keys.js';
import { createHubSessionToken, verifyHubSessionToken } from '../functions/_lib/hub-session.js';

const ROOT = 'synthetic-hub-session-root-secret-0123456789abcdef';
const DEDICATED = 'synthetic-dedicated-purpose-root-fedcba9876543210';
const env = { HUB_SESSION_SECRET: ROOT };
const b64 = bytes => Buffer.from(bytes).toString('base64url');
// Independent Node implementation of the documented derivation.
const expected = (root, label, message) => b64(createHmac('sha256', Buffer.from(hkdfSync('sha256', root, 'egc/purpose-keys/v1', label, 32))).update(message).digest());

test('each registered purpose derives a distinct HMAC key from the same root', async () => {
  assert.deepEqual(Object.values(PURPOSES).sort(), ['egc/confirm/v1', 'egc/crew-photo-link/v1', 'egc/customer-account-session/v1', 'egc/magic-link/v1', 'egc/rate-limit/v1']);
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

test('FUN-13 sealing keys are AES-GCM keys on their own HKDF label, bound to the record that stores the value', async () => {
  assert.deepEqual(Object.values(SEAL_PURPOSES), ['egc/seal/web-lead-receipt/v1']);
  const label = SEAL_PURPOSES.webLeadReceipt, aad = 'web_lead_receipts/0b7c4f5e-8d1a-4c2b-9e3f-1a2b3c4d5e6f', value = { name: 'Synthetic Person', phone: '(970) 555-0101' };
  const sealed = await purposeSeal(env, label, value, aad);
  assert.deepEqual(Object.keys(sealed), ['v', 'iv', 'ct']);
  assert.doesNotMatch(JSON.stringify(sealed), /Synthetic|555/);
  assert.deepEqual(await purposeOpen(env, label, sealed, aad), value);
  // Independent Node decryption with the documented derivation proves the key and binding.
  const key = Buffer.from(hkdfSync('sha256', ROOT, 'egc/purpose-keys/v1', label, 32)), ct = Buffer.from(sealed.ct, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(ct.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]).toString()), value);
  assert.notDeepEqual((await purposeSeal(env, label, value, aad)).iv, sealed.iv, 'every seal uses a fresh IV');
  const tampered = { ...sealed, ct: `${sealed.ct.slice(0, -2)}${sealed.ct.at(-2) === 'A' ? 'B' : 'A'}${sealed.ct.at(-1)}` };
  for (const [candidate, bound, root] of [[sealed, `${aad}x`, env], [tampered, aad, env], [sealed, aad, { HUB_SESSION_SECRET: `${ROOT}x` }], [{ ...sealed, v: 2 }, aad, env], [{ ...sealed, iv: 'short' }, aad, env], [null, aad, env]]) {
    await assert.rejects(purposeOpen(root, label, candidate, bound), { code: 'purpose_seal_invalid' });
  }
  await assert.rejects(purposeSeal(env, PURPOSES.confirm, value, aad), { code: 'purpose_key_label_invalid' }, 'a signing label never seals');
  await assert.rejects(purposeSign(env, label, 'message'), { code: 'purpose_key_label_invalid' }, 'a sealing label never signs');
  await assert.rejects(purposeSeal(env, label, value, ''), { code: 'purpose_seal_invalid' });
  await assert.rejects(purposeSeal({}, label, value, aad), { code: 'purpose_key_unavailable' });
});

test('FUN-13 sealed values have their own size bound: anything sealed opens again, larger values are refused, tokens keep the 4096 cap', async () => {
  const label = SEAL_PURPOSES.webLeadReceipt, aad = 'web_lead_receipts/0b7c4f5e-8d1a-4c2b-9e3f-1a2b3c4d5e6f';
  // A JSON string of n ASCII characters is n + 2 bytes; the 3-byte characters fill the same bound in UTF-8.
  const largest = 'x'.repeat(SEAL_MAX_BYTES - 2), multiByte = '車'.repeat(Math.floor((SEAL_MAX_BYTES - 2) / 3)), small = { name: 'Synthetic Person' };
  for (const value of [largest, multiByte, small]) {
    const sealed = await purposeSeal(env, label, value, aad);
    assert.deepEqual(await purposeOpen(env, label, sealed, aad), value);
    if (typeof value === 'string') assert.ok(sealed.ct.length > 64 * 4096, 'far past the 4096-character token limit');
    // Node's own AES-GCM opens it too, so the bound is not hiding a different encoding.
    const key = Buffer.from(hkdfSync('sha256', ROOT, 'egc/purpose-keys/v1', label, 32)), ct = Buffer.from(sealed.ct, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(ct.subarray(-16));
    assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]).toString()), value);
  }
  await assert.rejects(purposeSeal(env, label, 'x'.repeat(SEAL_MAX_BYTES - 1), aad), { code: 'purpose_seal_too_large' }, 'a value that could not be opened again is never sealed');
  await assert.rejects(purposeSeal(env, label, '車'.repeat(Math.floor((SEAL_MAX_BYTES - 2) / 3) + 1), aad), { code: 'purpose_seal_too_large' });
  const sealed = await purposeSeal(env, label, largest, aad);
  await assert.rejects(purposeOpen(env, label, { ...sealed, ct: `${sealed.ct}AAAA` }, aad), { code: 'purpose_seal_invalid' });
  // Signatures and confirm-token bodies keep the token cap.
  assert.equal(purposeFromBase64Url('A'.repeat(4096))?.length, 3072);
  assert.equal(purposeFromBase64Url('A'.repeat(4100)), null);
  assert.equal(purposeFromBase64Url(''), null);
  const signature = await purposeSign(env, PURPOSES.confirm, 'message');
  assert.equal(await purposeVerify(env, PURPOSES.confirm, 'message', signature), true);
  assert.equal(await purposeVerify(env, PURPOSES.confirm, 'message', `${signature}${'A'.repeat(4100)}`), false);
});
