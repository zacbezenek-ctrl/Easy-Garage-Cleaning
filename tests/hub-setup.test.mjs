import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto, pbkdf2Sync } from 'node:crypto';
import { onRequest } from '../functions/_middleware.js';

test('remote owner setup cannot submit forms, connect to services, be framed, indexed, or cached', async () => {
  for (const path of ['/hub-login-setup', '/hub-login-setup.html', '/hub-login-setup.js']) {
    const response = await onRequest({ request: new Request(`https://easygaragecleaning.com${path}`), next: async () => new Response('synthetic') });
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
  }
});

test('owner setup generates a compatible hash locally and clears inputs and cancelled results', async () => {
  const ids = ['password', 'confirmation', 'generate', 'clear', 'results', 'session-value', 'users-value', 'status', 'copy-session', 'copy-users'];
  const nodes = Object.fromEntries(ids.map(id => [id, {
    value: '', textContent: '', className: '', hidden: id === 'results', disabled: false,
    attributes: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    focus() {}, select() {}, setSelectionRange() {}, scrollIntoView() {},
  }]));
  const events = {};
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] },
    window: { addEventListener: (name, fn) => { events[name] = fn; } }, navigator: {},
    // Predictable bytes here are synthetic test inputs, never production credentials.
    crypto: { subtle: webcrypto.subtle, getRandomValues: bytes => { bytes.forEach((_, i) => { bytes[i] = i + 11; }); return bytes; } },
    TextEncoder, Uint8Array, btoa,
  });
  vm.runInContext(fs.readFileSync(new URL('../hub-login-setup.js', import.meta.url), 'utf8'), context);
  nodes.password.value = nodes.confirmation.value = 'short';
  await nodes.generate.listeners.click();
  assert.equal(nodes.results.hidden, true);
  const password = 'SYNTHETIC-TEST-ONLY';
  nodes.password.value = password; nodes.confirmation.value = 'mismatch';
  await nodes.generate.listeners.click();
  assert.equal(nodes.results.hidden, true);
  nodes.password.value = nodes.confirmation.value = password;
  await nodes.generate.listeners.click();
  assert.equal(nodes.results.hidden, false);
  assert.equal(nodes.password.value, ''); assert.equal(nodes.confirmation.value, '');
  const users = JSON.parse(nodes['users-value'].value);
  assert.deepEqual(Object.keys(users), ['ZacB']);
  const [prefix, iterations, salt, hash] = users.ZacB.passwordHash.split('$');
  assert.equal(prefix, 'pbkdf2-sha256'); assert.equal(Number(iterations), 210000);
  assert.equal(hash, pbkdf2Sync(password, Buffer.from(salt, 'base64url'), 210000, 32, 'sha256').toString('base64url'));
  assert.equal(Buffer.from(nodes['session-value'].value, 'base64url').length, 32);
  nodes.clear.listeners.click();
  assert.equal(nodes.results.hidden, true); assert.equal(nodes['users-value'].value, '');
  nodes.password.value = nodes.confirmation.value = password;
  const inFlight = nodes.generate.listeners.click(); nodes.clear.listeners.click(); await inFlight;
  assert.equal(nodes.results.hidden, true); assert.equal(nodes['session-value'].value, '');
  nodes.password.value = password; events.pagehide();
  assert.equal(nodes.password.value, ''); assert.equal(nodes['users-value'].value, '');
});
