import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { onRequestPost } from '../functions/api/hub-auth.js';
import { createHubCredentialHash } from '../functions/_lib/hub-session.js';
import { PasswordVerifier } from '../auth-verifier/src/index.js';

const password = ' Synthetic-\u00e9-\ud83d\udd10-password-1 ';
const salt = Buffer.from('synthetic-salt-16');
const hashFor = (iterations = 210000, supplied = password) => `pbkdf2-sha256$${iterations}$${salt.toString('base64url')}$${pbkdf2Sync(supplied, salt, iterations, 32, 'sha256').toString('base64url')}`;

function login(hash, supplied, namespace, extraEnv = {}) {
  return onRequestPost({
    env: {
      HUB_SESSION_SECRET: 'synthetic-private-verifier-session',
      HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: hash, role: 'owner' } }),
      HUB_PASSWORD_VERIFIER: namespace,
      ...extraEnv,
    },
    request: new Request('https://easygaragecleaning.com/api/hub-auth', {
      method: 'POST',
      headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'zacb', password: supplied }),
    }),
  });
}

function capNativeIterations(t) {
  const native = crypto.subtle.deriveBits.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'deriveBits', (...args) => {
    if (args[0].name === 'PBKDF2' && args[0].iterations > 100000) {
      throw new DOMException('Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000).', 'NotSupportedError');
    }
    return native(...args);
  });
}

function privateVerifier(respond = data => binaryResponse(pbkdf2Sync(data.password, Buffer.from(data.salt, 'base64url'), data.iterations, data.length, 'sha256'))) {
  const requests = [], id = {};
  return {
    requests,
    idFromName(name) {
      assert.equal(name, 'hub-password-verifier-v1');
      return id;
    },
    get(requestedId) {
      assert.equal(requestedId, id);
      return { async fetch(url, init) {
        assert.equal(url, 'https://hub-password-verifier.internal/derive');
        assert.equal(init.method, 'POST');
        assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
        const data = JSON.parse(init.body);
        assert.deepEqual(Object.keys(data).sort(), ['algorithm', 'iterations', 'length', 'password', 'salt']);
        assert.equal(data.algorithm, 'pbkdf2-sha256');
        assert.equal(data.length, 32);
        requests.push(data);
        return respond(data);
      } };
    },
  };
}

const binaryResponse = (bytes, options = {}) => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' }, ...options });

async function assertUnavailable(response) {
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.code, 'HUB_AUTH_CONFIGURATION');
  assert.equal(response.headers.has('set-cookie'), false);
  assert.doesNotMatch(JSON.stringify(data), /Synthetic|pbkdf2-sha256\$|private provider|internal/);
}

test('private verifier preserves existing hashes, exact password bytes, and wrong-password rejection', async t => {
  capNativeIterations(t);
  const verifier = privateVerifier();
  for (const iterations of [210000, 310000]) {
    const hash = hashFor(iterations);
    const accepted = await login(hash, password, verifier, { HUB_PASSWORD_HASH_FALLBACK: 'enabled' });
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get('set-cookie'), /HttpOnly; Secure/);
    assert.equal((await accepted.json()).user, 'ZacB');
    for (const wrong of [password.trim(), 'WrongSyntheticPassword1']) {
      const rejected = await login(hash, wrong, verifier);
      assert.equal(rejected.status, 401);
      assert.equal(rejected.headers.has('set-cookie'), false);
      assert.equal((await rejected.json()).error, 'Incorrect username or password');
    }
  }
  assert.equal(verifier.requests.length, 6);
  assert.deepEqual(verifier.requests[0], { algorithm: 'pbkdf2-sha256', password, salt: salt.toString('base64url'), iterations: 210000, length: 32 });
});

test('credential generation retains the existing 210000-round representation through the private verifier', async t => {
  capNativeIterations(t);
  const verifier = privateVerifier();
  const generated = await createHubCredentialHash(password, { HUB_PASSWORD_VERIFIER: verifier });
  const [algorithm, rounds, generatedSalt, derived] = generated.split('$');
  assert.equal(algorithm, 'pbkdf2-sha256');
  assert.equal(rounds, '210000');
  assert.equal(Buffer.from(generatedSalt, 'base64url').length, 16);
  assert.equal(derived, pbkdf2Sync(password, Buffer.from(generatedSalt, 'base64url'), 210000, 32, 'sha256').toString('base64url'));
  assert.equal(verifier.requests.length, 1);
});

test('Pages login interoperates with the real private verifier and preserves long Unicode passwords', async t => {
  capNativeIterations(t);
  const actor = new PasswordVerifier();
  const verifier = privateVerifier(data => actor.fetch(new Request('https://hub-password-verifier.internal/derive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })));
  const longPassword = ' \u00e9\ud83d\udd10 '.repeat(250);
  assert.ok(Buffer.byteLength(longPassword) > 1024);
  const hash = hashFor(210000, longPassword);
  assert.equal((await login(hash, longPassword, verifier)).status, 200);
  const rejected = await login(hash, `${longPassword}wrong`, verifier);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.has('set-cookie'), false);
});

test('successful native derivation never invokes the private verifier', async t => {
  capNativeIterations(t);
  const verifier = privateVerifier(() => { throw new Error('must not reach private provider'); });
  assert.equal((await login(hashFor(100000), password, verifier)).status, 200);
  assert.equal(verifier.requests.length, 0);
});

test('unrelated native errors and malformed hashes cannot trigger the private verifier', async t => {
  const verifier = privateVerifier();
  t.mock.method(crypto.subtle, 'deriveBits', () => { throw new DOMException('private provider unavailable', 'OperationError'); });
  await assertUnavailable(await login(hashFor(), password, verifier, { HUB_PASSWORD_HASH_FALLBACK: 'enabled' }));
  await assertUnavailable(await login('pbkdf2-sha256$210000$invalid!$bad', password, verifier));
  assert.equal(verifier.requests.length, 0);
});

test('private verifier failures fail closed even when the old software fallback is enabled', async t => {
  capNativeIterations(t);
  const hash = hashFor();
  const invalidResponses = [
    () => { throw new Error('private provider failure with Synthetic secret detail'); },
    () => binaryResponse(new Uint8Array(32), { status: 403 }),
    () => binaryResponse(new Uint8Array(32), { status: 500 }),
    () => new Response(new Uint8Array(32), { headers: { 'Content-Type': 'application/json' } }),
    () => binaryResponse(null),
    () => binaryResponse(new Uint8Array(31)),
    () => binaryResponse(new Uint8Array(33)),
    () => binaryResponse(new Uint8Array(32), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '999999' } }),
    () => binaryResponse(new ReadableStream({ start(controller) { controller.error(new Error('private provider body failure')); } })),
  ];
  for (const respond of invalidResponses) {
    const verifier = privateVerifier(respond);
    await assertUnavailable(await login(hash, password, verifier, { HUB_PASSWORD_HASH_FALLBACK: 'enabled' }));
    assert.equal(verifier.requests.length, 1);
  }
  for (const malformedBinding of [{}, false, { idFromName() { throw new Error('private provider namespace failure'); } }]) {
    await assertUnavailable(await login(hash, password, malformedBinding, { HUB_PASSWORD_HASH_FALLBACK: 'enabled' }));
  }
});

test('private verifier accepts exactly 32 streamed bytes and cancels oversized responses', async t => {
  capNativeIterations(t);
  const hash = hashFor();
  const verifier = privateVerifier(data => {
    const bytes = pbkdf2Sync(data.password, Buffer.from(data.salt, 'base64url'), data.iterations, 32, 'sha256');
    return binaryResponse(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 13));
      controller.enqueue(bytes.subarray(13));
      controller.close();
    } }));
  });
  assert.equal((await login(hash, password, verifier)).status, 200);
  let cancelled = false;
  const oversized = privateVerifier(() => binaryResponse(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(33)); },
    cancel() { cancelled = true; },
  })));
  await assertUnavailable(await login(hash, password, oversized, { HUB_PASSWORD_HASH_FALLBACK: 'enabled' }));
  assert.equal(cancelled, true);
});
