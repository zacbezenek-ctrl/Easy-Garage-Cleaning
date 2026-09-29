import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { onRequest } from '../functions/_middleware.js';
import { confirmPage, retryPage } from '../functions/api/customer-login-verify.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('client-login.html'), script = read('client-login.js'), css = read('client-login.css');
const run = (path, type = 'text/html') => onRequest({ request: new Request(`https://easygaragecleaning.com${path}`), next: async () => new Response('body', { headers: { 'Content-Type': type } }), env: {} });
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(match => match[0]);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];

test('the Client Login page is a private, single-h1, labelled, mobile-first shell', () => {
  assert.match(page, /^<!doctype html>\n<html lang="en">/);
  assert.match(page, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(page, /<link rel="canonical" href="https:\/\/easygaragecleaning\.com\/client-login">/);
  assert.equal(tags(page, 'h1').length, 1);
  assert.equal(tags(page, 'title').length, 1);
  assert.match(page, /<meta name="viewport" content="width=device-width,initial-scale=1/);
  const inputs = tags(page, 'input').filter(tag => !/type="radio"/.test(tag) && !/name="botcheck"/.test(tag));
  assert.deepEqual(inputs.map(tag => [attr(tag, 'type'), attr(tag, 'inputmode'), attr(tag, 'autocomplete')]), [['tel', 'tel', 'tel'], ['email', 'email', 'email']]);
  for (const tag of inputs) assert.ok(page.includes(`<label for="${attr(tag, 'id')}">`), `${attr(tag, 'id')} has a label`);
  const buttons = tags(page, 'button');
  assert.ok(buttons.length >= 2);
  for (const tag of buttons) assert.match(tag, /\stype="(submit|button)"/, tag);
  assert.equal(buttons.filter(tag => /type="submit"/.test(tag)).length, 1);
  const trap = tags(page, 'input').find(tag => /name="botcheck"/.test(tag));
  assert.match(trap, /tabindex="-1"/); assert.match(trap, /autocomplete="off"/);
  assert.match(page, /<label class="cl-honeypot" aria-hidden="true">/);
  assert.match(page, /role="alert"/); assert.match(page, /aria-live="polite"/);
  assert.match(page, /href="sms:\+19709991818"/, 'the fallback texts the business line');
});

test('no analytics, lead-form classes, inline scripts or inline styles, so the strict CSP holds', () => {
  assert.doesNotMatch(page, /analytics-loader|googletagmanager|gtag\(|fbevents|clarity\.ms|fb-capture|site-enhancements/);
  assert.doesNotMatch(page, /lead-form-lite|multi-step-form|sms_consent/);
  const scripts = tags(page, 'script');
  assert.deepEqual(scripts, ['<script src="/client-login.js?v=20260928b" defer>']);
  assert.doesNotMatch(page, /<script>(?!<\/script>)|<script [^>]*>[^<]+<\/script>/);
  assert.doesNotMatch(page, /\sstyle="|<style|\son[a-z]+="/i);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test('the script posts JSON with the portal header and never branches its message on the lookup', () => {
  assert.match(script, /fetch\('\/api\/customer-login', \{/);
  assert.match(script, /'Content-Type': 'application\/json', 'X-EGC-Portal': '1'/);
  assert.match(script, /credentials: 'same-origin'/);
  assert.match(script, /JSON\.stringify\(\{ identifier: identifier, botcheck: form\.elements\.botcheck\.value \}\)/);
  assert.match(script, /response\.status === 202/);
  assert.match(script, /fallback\(\);/);
});

// A minimal DOM for client-login.js: the ids it reads, events it listens to and the fetch it makes.
function harness({ html = page, search = '', fetch }) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]), elements = new Map(), calls = [], replaced = [];
  const listeners = () => ({ listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } });
  for (const id of ids) {
    const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(html)[0];
    elements.set(id, { id, ...listeners(), hidden: /\shidden[\s>]/.test(tag), textContent: '', disabled: false, value: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, removeAttribute(name) { delete this.attributes[name]; }, focus() { focused.id = id; } });
  }
  const focused = { id: '' }, $ = id => elements.get(id);
  const confirmButton = { ...listeners(), textContent: 'Sign in to my projects', disabled: false };
  if ($('cl-form')) Object.assign($('cl-form'), { elements: { botcheck: { value: '' } }, reset() {}, querySelector: () => ({ value: 'phone' }), querySelectorAll: () => [] });
  if ($('cl-confirm')) $('cl-confirm').querySelector = () => confirmButton;
  if ($('cl-submit')) $('cl-submit').textContent = 'Send my sign-in link';
  const window = { ...listeners(), location: { search, pathname: '/client-login' }, history: { replaceState: (...args) => replaced.push(args) } };
  const context = { window, document: { readyState: 'complete', getElementById: $, addEventListener() {} }, URLSearchParams, AbortController, setTimeout: () => 0, clearTimeout() {},
    fetch: (url, options) => { calls.push({ url, ...options }); return fetch(url, options); } };
  vm.runInNewContext(script, context);
  const fire = (target, type, event = {}) => { let prevented = false; for (const fn of target.listeners[type] || []) fn({ preventDefault() { prevented = true; }, ...event }); return prevented; };
  const settle = async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve)); };
  const panel = () => ['cl-form', 'cl-sent', 'cl-fallback'].filter(id => !$(id).hidden);
  return { $, calls, replaced, window, confirmButton, fire, settle, panel };
}
const answer = status => async () => ({ status, json: async () => (status === 202 ? { ok: true, message: 'Synthetic generic message' } : { ok: false }) });

test('on load the page asks the API once and shows "Text us" straight away when sign-in is off, not ready or unreachable', async () => {
  for (const [label, reply] of [['off', answer(404)], ['not ready', answer(503)], ['offline', async () => { throw new TypeError('Failed to fetch'); }]]) {
    const h = harness({ fetch: reply });
    await h.settle();
    assert.deepEqual(h.panel(), ['cl-fallback'], label);
    assert.deepEqual(h.calls.map(call => [call.url, call.method, call.credentials, call.cache, call.body]), [['/api/customer-login', 'GET', 'same-origin', 'no-store', undefined]], label);
  }
  const ready = harness({ fetch: answer(405) });
  await ready.settle();
  assert.deepEqual(ready.panel(), ['cl-form'], 'ready: the form stays');
  for (const other of [500, 403]) { const h = harness({ fetch: answer(other) }); await h.settle(); assert.deepEqual(h.panel(), ['cl-form'], `${other} leaves the decision to the POST`); }
});

test('a slow probe never replaces a request the customer already sent', async () => {
  let release;
  const h = harness({ fetch: (url, options) => options.method === 'GET' ? new Promise(resolve => { release = () => resolve({ status: 404 }); }) : answer(202)() });
  h.$('cl-phone').value = '970 555 0101';
  h.fire(h.$('cl-form'), 'submit');
  await h.settle();
  assert.deepEqual(h.panel(), ['cl-sent']);
  assert.equal(h.$('cl-sent-message').textContent, 'Synthetic generic message');
  release(); await h.settle();
  assert.deepEqual(h.panel(), ['cl-sent'], 'the late 404 does not hide the sent message');
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST']);
});

test('a link used a moment ago says so and offers the portal; other statuses do not', async () => {
  const used = harness({ search: '?status=used', fetch: answer(405) });
  await used.settle();
  assert.match(used.$('cl-status').textContent, /^That sign-in link was already used\. If you just tapped it, open your projects\. Otherwise wait 10 minutes/);
  assert.match(used.$('cl-status').textContent, /We send up to 3 links a day, so if no link arrives, text us at \(970\) 999-1818\.$/, 'the daily limit is named, with a way out');
  assert.deepEqual([used.$('cl-status').hidden, used.$('cl-status-portal').hidden], [false, false]);
  assert.deepEqual(used.replaced, [[null, '', '/client-login']], 'the status leaves the address bar');
  assert.match(page, /<a id="cl-status-portal" class="cl-button secondary cl-status-link" href="\/customer-portal" hidden>Open my projects<\/a>/);
  const expired = harness({ search: '?status=expired', fetch: answer(405) });
  await expired.settle();
  assert.equal(expired.$('cl-status').textContent, 'That sign-in link expired or is no longer valid. Request a new one below.');
  assert.equal(expired.$('cl-status-portal').hidden, true);
});

test('the confirm page submits once: a second tap or Enter is ignored until the page is restored', async () => {
  const html = await confirmPage('A'.repeat(43)).text();
  const h = harness({ html, fetch: async () => { throw new Error('the confirm page makes no fetch'); } });
  assert.equal(h.fire(h.$('cl-confirm'), 'submit'), false, 'the first tap submits the form');
  assert.deepEqual([h.confirmButton.disabled, h.confirmButton.textContent], [true, 'Signing in…']);
  assert.equal(h.fire(h.$('cl-confirm'), 'submit'), true, 'a second submit is cancelled');
  h.fire(h.window, 'pageshow', { persisted: false });
  assert.equal(h.confirmButton.disabled, true);
  h.fire(h.window, 'pageshow', { persisted: true });
  assert.deepEqual([h.confirmButton.disabled, h.confirmButton.textContent], [false, 'Sign in to my projects'], 'back/forward cache restores a usable button');
  assert.equal(h.fire(h.$('cl-confirm'), 'submit'), false);
  assert.deepEqual(h.calls, []);
});

test('mobile CSS: 16px inputs, 44px+ targets, no fixed widths that could scroll', () => {
  assert.match(css, /\.cl-field input\{[^}]*min-height:48px[^}]*font-size:16px/);
  assert.match(css, /\.cl-button\{[^}]*min-height:48px/);
  assert.match(css, /\.cl-tab span\{[^}]*min-height:44px/);
  assert.match(css, /\.cl-shell\{[^}]*max-width:480px[^}]*padding:[^;]*16px/);
  assert.doesNotMatch(css, /(?:^|[;{])width:\s*\d{3,}px/m, 'no fixed pixel widths; max-width only');
});

test('headers and middleware keep /client-login private, uncached, unframed and under a strict CSP', async () => {
  assert.match(read('_headers'), /\/client-login\*\n  X-Robots-Tag: noindex\n  Cache-Control: no-store\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n/);
  for (const [path, type] of [['/client-login', 'text/html'], ['/client-login.html', 'text/html'], ['/client-login.js', 'text/javascript'], ['/client-login.css', 'text/css'], ['/api/customer-login', 'application/json'], ['/api/customer-login-verify', 'text/html']]) {
    const response = await run(path, type), csp = response.headers.get('Content-Security-Policy');
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY', path);
    assert.equal(response.headers.get('Referrer-Policy'), path === '/api/customer-login-verify' ? 'strict-origin' : 'no-referrer', path);
    assert.match(response.headers.get('X-Robots-Tag'), /noindex/, path);
    assert.match(csp, /script-src 'self';/, path);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|googletagmanager|facebook|clarity/, path);
    assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /form-action 'self'/); assert.match(csp, /connect-src 'self'/);
  }
  const home = await run('/');
  assert.match(home.headers.get('Content-Security-Policy'), /unsafe-inline/, 'public pages keep their existing policy');
  assert.notEqual(home.headers.get('Cache-Control'), 'no-store');
  const lookalike = await run('/client-login-evil');
  assert.notEqual(lookalike.headers.get('X-Frame-Options'), 'DENY', 'only the exact Client Login paths');
});

test('the link-confirm page is private, works without script, loads only the same-origin guard, and the portal error screen links to Client Login', async () => {
  const response = confirmPage('A'.repeat(43)), html = await response.text();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(html, /<html lang="en">/);
  assert.equal(tags(html, 'h1').length, 1);
  assert.deepEqual(tags(html, 'script'), ['<script src="/client-login.js?v=20260928b" defer>']);
  assert.doesNotMatch(html, /<script[^>]*>[^<]|\sstyle="|<style|\son[a-z]+="/i);
  assert.match(html, /<form id="cl-confirm" class="cl-form" method="post" action="\/api\/customer-login-verify">/, 'a plain form POST: it signs in with script off');
  for (const tag of tags(html, 'button')) assert.match(tag, /type="submit"/);
  assert.match(html, /<link rel="stylesheet" href="\/client-login\.css\?v=20260928b">/);
  // Under no-referrer a form POST sends `Origin: null`; strict-origin keeps the real Origin and never the token URL.
  assert.match(html, /<meta name="referrer" content="strict-origin">/);
  assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin');
  const portal = read('customer-portal.html');
  // Client Login is off by default, so the existing in-page message form stays the primary action.
  assert.match(portal, /<section id="error"[^\n]*<div class="access-actions"><button class="btn" type="button" id="open-help-form">Message the team here<\/button><a class="btn secondary" href="\/client-login">Get a new sign-in link<\/a>/);
});

test('the retry page (a sign-in that did not finish) is private, re-offers the same link once, and works without script', async () => {
  const response = retryPage('A'.repeat(43)), html = await response.text();
  assert.equal(response.status, 503);
  assert.deepEqual(['Cache-Control', 'X-Frame-Options', 'Referrer-Policy'].map(name => response.headers.get(name)), ['no-store', 'DENY', 'strict-origin']);
  assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal(tags(html, 'h1').length, 1);
  assert.deepEqual(tags(html, 'script'), ['<script src="/client-login.js?v=20260928b" defer>']);
  assert.doesNotMatch(html, /<script[^>]*>[^<]|\sstyle="|<style|\son[a-z]+="/i);
  assert.match(html, /<form id="cl-confirm" class="cl-form" method="post" action="\/api\/customer-login-verify">\n<input type="hidden" name="token" value="A{43}">/);
  for (const tag of tags(html, 'button')) assert.match(tag, /type="submit"/);
  assert.match(html, /<button class="cl-button" type="submit">Try again<\/button>/);
  assert.ok(!retryPage('"><script>alert(1)</script>').headers.get('Set-Cookie'));
  assert.ok((await retryPage('"><script>alert(1)</script>').text()).includes('&quot;&gt;&lt;script&gt;'));
  const h = harness({ html, fetch: async () => { throw new Error('the retry page makes no fetch'); } });
  assert.equal(h.fire(h.$('cl-confirm'), 'submit'), false, 'the first tap submits the form');
  assert.deepEqual([h.confirmButton.disabled, h.confirmButton.textContent], [true, 'Signing in…']);
  assert.equal(h.fire(h.$('cl-confirm'), 'submit'), true, 'a second submit is cancelled');
  h.fire(h.window, 'pageshow', { persisted: true });
  assert.equal(h.confirmButton.disabled, false, 'back/forward cache restores a usable button');
});
