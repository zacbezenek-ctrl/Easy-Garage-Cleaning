import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import publicWorker, { PasswordVerifier } from '../src/index.js';

const actor = new PasswordVerifier();
const salt = Buffer.from(Array.from({ length: 16 }, (_, index) => index)).toString('base64url');
const valid = { algorithm: 'pbkdf2-sha256', password: 'synthetic-only-password', salt, iterations: 210000, length: 32 };
const request = (input, options = {}) => new Request('https://hub-password-verifier.internal/derive', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), ...options,
});

test('private verifier matches independent native PBKDF2 at supported iteration boundaries', async () => {
  for (const iterations of [100000, 210000, 1000000]) {
    const input = { ...valid, iterations, password: 'synthetic-\0-unicode-π-🔑' };
    const response = await actor.fetch(request(input));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const actual = Buffer.from(await response.arrayBuffer());
    assert.equal(actual.length, 32);
    const expected = pbkdf2Sync(Buffer.from(input.password, 'utf8'), Buffer.from(salt, 'base64url'), iterations, 32, 'sha256');
    assert.deepEqual(actual, expected);
  }
});

test('a wrong password produces a different value and repeated requests retain no credential state', async () => {
  const expected = pbkdf2Sync(valid.password, Buffer.from(salt, 'base64url'), valid.iterations, 32, 'sha256');
  const wrong = await actor.fetch(request({ ...valid, password: 'different-synthetic-password' }));
  assert.equal(wrong.status, 200);
  assert.notDeepEqual(Buffer.from(await wrong.arrayBuffer()), expected);
  const correct = await actor.fetch(request(valid));
  assert.deepEqual(Buffer.from(await correct.arrayBuffer()), expected);
  assert.deepEqual(Object.getOwnPropertyNames(actor), []);
});

test('maximum password and salt bounds preserve byte-for-byte native derivation', async () => {
  const input = { ...valid, iterations: 100000, password: '\u0800'.repeat(8192), salt: Buffer.alloc(4096, 0xff).toString('base64url') };
  const response = await actor.fetch(request(input));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pbkdf2Sync(input.password, Buffer.from(input.salt, 'base64url'), input.iterations, 32, 'sha256'));
});

test('invalid algorithms, output sizes, rounds, passwords, salts, and shapes fail closed', async () => {
  const inputs = [
    null, [], 'bad', { ...valid, extra: true },
    { ...valid, algorithm: 'pbkdf2-sha512' }, { ...valid, algorithm: 'PBKDF2-SHA256' },
    { ...valid, length: 31 }, { ...valid, length: '32' },
    { ...valid, iterations: 99999 }, { ...valid, iterations: 1000001 },
    { ...valid, iterations: 210000.5 }, { ...valid, iterations: '210000' }, { ...valid, iterations: null },
    { ...valid, password: '' }, { ...valid, password: 123 }, { ...valid, password: 'x'.repeat(8193) },
    { ...valid, salt: '' }, { ...valid, salt: null }, { ...valid, salt: 'AB' }, { ...valid, salt: 'A' },
    { ...valid, salt: 'AA==' }, { ...valid, salt: '+/8' },
    { ...valid, salt: Buffer.alloc(4097).toString('base64url') },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'length')),
  ];
  for (const input of inputs) {
    const response = await actor.fetch(request(input));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(await response.text(), '{"error":"Invalid derivation request."}');
  }
});

test('wrong route, method, content type, malformed JSON, and invalid UTF8 are rejected', async () => {
  assert.equal((await actor.fetch(new Request('https://hub-password-verifier.internal/other'))).status, 404);
  assert.equal((await actor.fetch(new Request('https://hub-password-verifier.internal/derive'))).status, 405);
  assert.equal((await actor.fetch(request(valid, { headers: { 'Content-Type': 'text/plain' } }))).status, 415);
  assert.equal((await actor.fetch(request(valid, { body: '{invalid' }))).status, 400);
  assert.equal((await actor.fetch(request(valid, { body: Uint8Array.of(0xc0, 0x80) }))).status, 400);
});

test('body bounds are enforced before derivation without trusting Content-Length', async () => {
  const oversize = JSON.stringify(valid) + ' '.repeat(64 * 1024);
  for (const headers of [
    { 'Content-Type': 'application/json' },
    { 'Content-Type': 'application/json', 'Content-Length': '1' },
    { 'Content-Type': 'application/json', 'Content-Length': '65537' },
  ]) assert.equal((await actor.fetch(request(valid, { body: oversize, headers }))).status, 413);
});

test('an oversized streaming request is cancelled without consuming the remainder', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { cancelled = true; },
  });
  const response = await actor.fetch(request(valid, { body, duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
});

test('unexpected request failure returns a generic unavailable response without echoing secrets', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error('synthetic-private-material')); } });
  const response = await actor.fetch(request(valid, { body, duplex: 'half' }));
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"Derivation unavailable."}');
});

test('the public worker never invokes derivation or reads a credential request body', async () => {
  const poisonous = { get body() { throw new Error('must not read'); } };
  for (const input of [poisonous, request(valid), new Request('https://example.com/')]) {
    const response = await publicWorker.fetch(input, new Proxy({}, { get() { throw new Error('must not use binding'); } }));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  }
});

test('deployment configuration keeps the verifier private and uses a Free-compatible SQLite class', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const dependency = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(config.name, 'egc-password-verifier');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  assert.equal(config.observability.enabled, false);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['PasswordVerifier'] }]);
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'HUB_PASSWORD_VERIFIER', class_name: 'PasswordVerifier' }]);
  assert.equal(dependency.dependencies['@noble/hashes'], '2.0.1');
});
