import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { onRequestPost } from '../functions/api/hub-auth.js';

const password = 'SyntheticExistingPassword1', salt = Buffer.from('synthetic-salt-16');
const validHash = iterations => `pbkdf2-sha256$${iterations}$${salt.toString('base64url')}$${pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url')}`;
function login(hash, supplied = 'DeliberatelyWrongSyntheticPassword1') {
  return onRequestPost({
    env: { HUB_SESSION_SECRET: 'synthetic-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: hash, role: 'owner' } }) },
    request: new Request('https://easygaragecleaning.com/api/hub-auth', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'zacb', password: supplied }) }),
  });
}
test('a host PBKDF2 iteration cap reports configuration failure instead of blaming the password', async t => {
  const hash = validHash(210000);
  const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'deriveBits', (...args) => {
    if (args[0].name === 'PBKDF2' && args[0].iterations > 100000) throw new DOMException('Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000).', 'NotSupportedError');
    return deriveBits(...args);
  });
  for (const supplied of [password, 'DeliberatelyWrongSyntheticPassword1']) {
    const response = await login(hash, supplied), data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.code, 'HUB_AUTH_CONFIGURATION');
    assert.match(data.error, /iteration count/i);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.doesNotMatch(JSON.stringify(data), /SyntheticExisting|pbkdf2-sha256\$/);
  }
});
test('other host derivation failures cannot masquerade as wrong passwords or leak provider details', async t => {
  const hash = validHash(210000);
  t.mock.method(crypto.subtle, 'deriveBits', () => { throw new Error('private provider state: synthetic sensitive detail'); });
  const response = await login(hash), data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.code, 'HUB_AUTH_CONFIGURATION');
  assert.doesNotMatch(JSON.stringify(data), /private provider|sensitive detail/);
});
test('malformed stored password formats return setup failure before expensive derivation', async t => {
  let derives = 0;
  t.mock.method(crypto.subtle, 'deriveBits', () => { derives++; throw new Error('must not derive malformed hashes'); });
  for (const hash of ['broken', 'pbkdf2-sha256$210000$$a', `pbkdf2-sha256$99999$${salt.toString('base64url')}$abc`, `pbkdf2-sha256$210000$!bad!$${'a'.repeat(43)}`, `pbkdf2-sha256$210000$${salt.toString('base64url')}$abc`, `pbkdf2-sha256$210000$${salt.toString('base64url')}$${'a'.repeat(43)}$extra`]) {
    const response = await login(hash), data = await response.json();
    assert.equal(response.status, 503, hash);
    assert.equal(data.code, 'HUB_AUTH_CONFIGURATION');
  }
  assert.equal(derives, 0);
});
test('supported existing 210000-round credentials retain correct and incorrect password behavior', async () => {
  const hash = validHash(210000);
  assert.equal((await login(hash, password)).status, 200);
  const rejected = await login(hash);
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).error, 'Incorrect username or password');
});
