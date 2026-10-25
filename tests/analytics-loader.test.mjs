import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { onRequest } from '../functions/_middleware.js';

const source = readFileSync(new URL('../analytics-loader.js', import.meta.url), 'utf8');
function harness(readyState = 'loading', hostname = 'easygaragecleaning.com') {
  const listeners = new Map(), timers = [], scripts = [];
  const window = {
    location: { hostname },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
  };
  const document = {
    readyState,
    currentScript: { getAttribute() { return '123456789012345'; } },
    createElement() { return {}; },
    head: { appendChild(script) {
      assert.equal(typeof window.clarity, 'function', 'Clarity has its queue before any vendor evaluates');
      scripts.push(script);
    } },
  };
  const context = vm.createContext({ window, document });
  return { window, listeners, timers, scripts, run() { vm.runInContext(source, context); } };
}

test('events queue before the first interaction and repeated loader insertion never duplicates them', () => {
  const h = harness(); h.run();
  assert.equal(h.scripts.length, 1, 'GA starts before window.load or interaction');
  assert.match(h.scripts[0].src, /gtag\/js\?id=G-CV7HJ2QGHX$/);
  const events = h.window.dataLayer.length;
  assert.equal(h.window.fbq.queue.length, 2);
  assert.deepEqual(Array.from(h.window.fbq.queue[0]), ['init', '123456789012345']);
  h.window.clarity('set', 'synthetic', 'queued');
  assert.deepEqual(Array.from(h.window.clarity.q[0]), ['set', 'synthetic', 'queued']);
  h.run();
  assert.equal(h.window.dataLayer.length, events);
  assert.equal(h.window.fbq.queue.length, 2);
  h.listeners.get('load')();
  assert.equal(h.timers[0].ms, 2500);
  h.listeners.get('pointerdown')();
  h.timers[0].fn();
  assert.equal(h.scripts.length, 4);
  assert.equal(new Set(h.scripts.map(s => s.src)).size, 4);
  assert.ok(h.scripts.every(s => s.async));
  assert.ok(!h.listeners.has('pointerdown'));
});

test('a loader inserted after window load still starts without requiring interaction', () => {
  const h = harness('complete'); h.run();
  assert.equal(h.timers.length, 1);
  assert.equal(h.scripts.length, 1);
  h.timers[0].fn();
  assert.equal(h.scripts.length, 4);
});

test('production measurement never initializes on local, preview or lookalike hosts', () => {
  for (const host of ['localhost', '127.0.0.1', 'terminal.local', 'preview.easy-garage-cleaning.pages.dev', 'easygaragecleaning.com.example.test']) {
    const h = harness('complete', host); h.run();
    assert.equal(h.scripts.length, 0, host);
    assert.equal(h.timers.length, 0, host);
    assert.equal(h.window.dataLayer, undefined, host);
  }
  const www = harness('loading', 'www.easygaragecleaning.com'); www.run();
  assert.equal(www.scripts.length, 1);
});

test('known Google collection origins are allowed without weakening private page policies', async () => {
  const response = await onRequest({ request: new Request('https://example.test/'), env: {}, next: async () => new Response('public') });
  const csp = response.headers.get('Content-Security-Policy');
  const connect = csp.split('; ').find(rule => rule.startsWith('connect-src ')).split(' ');
  for (const origin of ['https://analytics.google.com', 'https://www.google.com', 'https://stats.g.doubleclick.net', 'https://ad.doubleclick.net', 'https://googleads.g.doubleclick.net']) assert.ok(connect.includes(origin), origin);
  assert.ok(!connect.includes('https:'));
  assert.doesNotMatch(csp, /unsafe-eval|cloud\.run|on\.aws/);
  const privatePage = await onRequest({ request: new Request('https://example.test/business-hub'), env: {}, next: async () => new Response('private') });
  assert.match(privatePage.headers.get('Content-Security-Policy'), /connect-src 'self';/);
  assert.doesNotMatch(privatePage.headers.get('Content-Security-Policy'), /google|doubleclick/);
});
