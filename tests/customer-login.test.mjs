import test from 'node:test';
import assert from 'node:assert/strict';
import { customerLoginHandlers, CUSTOMER_LOGIN_MESSAGE, MIN_RESPONSE_MS, READINESS_TTL_MS, loginLogLine } from '../functions/api/customer-login.js';
import { customerLoginVerifyHandlers, confirmPage } from '../functions/api/customer-login-verify.js';
import { createLoginLink, loginIdentifier, loginLinkId, loginLinkOrigin, LOGIN_LINK_TTL_MS, LOGIN_LIMITS, requestCustomerLoginLink, redeemLoginLink } from '../functions/_lib/customer-magic-link.js';
import { CUSTOMER_SESSION_TTL_MS, readCustomerAccountSession } from '../functions/_lib/customer-account-session.js';
import { verifyCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { createApprovedSendService } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { PURPOSES, purposeSign } from '../functions/_lib/purpose-keys.js';
import { RATE_LIMITS, rateLimitId } from '../functions/_lib/rate-limit.js';
import { customerAccountStorage } from '../functions/_lib/customer-account-access.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { messagingStorage } from '../functions/_lib/message-send-store.js';
import { randomUUID } from 'node:crypto';
import { fakeGhl } from './helpers/messaging-fixture.mjs';
import { NOW, ORIGIN, env, owner, memory, clock, contacts, approveLoginTemplate, loginRequest, verifyRequest, tokenFrom, seed } from './helpers/customer-login-fixture.mjs';

const MIN = 60000;
const code = expected => error => { assert.equal(error.code, expected); return true; };

async function harness(t, { rows, ghl: ghlOptions = {}, flags = {}, approve = true, identity, random, cleanup } = {}) {
  const store = memory(rows), time = clock(), sleeps = [], background = [], cleaned = [], outcomes = [], logs = [];
  if (approve) await approveLoginTemplate(store);
  const ghl = fakeGhl({ contacts: contacts(), ...ghlOptions });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname !== 'services.leadconnectorhq.com') throw new Error(`Unexpected host ${url}`);
    return ghl.fetcher(url, options);
  });
  const settings = { ...env, ...flags };
  const login = customerLoginHandlers({
    storage: () => store, identity: () => identity || store, messaging: () => store.messaging, now: time,
    sleep: async ms => { sleeps.push(ms); time.advance(ms); }, ...(random ? { random } : {}),
    cleanup: cleanup || (async (_, collection, at) => { cleaned.push([collection, at]); return 0; }), log: line => logs.push(line),
  });
  const verify = customerLoginVerifyHandlers({ storage: () => store, now: time });
  const post = async (body, options = {}) => {
    const { inline, ...rest } = options, context = { request: loginRequest(body, rest), env: settings };
    if (!inline) context.waitUntil = promise => background.push(promise);
    const response = await login.post(context);
    return { response, status: response.status, text: await response.text() };
  };
  const settle = async () => { while (background.length) outcomes.push(...await Promise.all(background.splice(0))); };
  const verifyGet = token => verify.get({ request: new Request(`${ORIGIN}/api/customer-login-verify?token=${token}`), env: settings });
  const verifyPost = (token, options) => verify.post({ request: verifyRequest(token, options), env: settings });
  const linkRows = () => [...store.rows].filter(([key]) => key.startsWith('customer_login_links/')).map(([key, value]) => ({ id: key.split('/')[1], ...value }));
  const sessions = () => [...store.rows].filter(([key]) => key.startsWith('customer_sessions/')).map(([key, value]) => ({ id: key.split('/')[1], ...value }));
  const ledgers = () => [...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, value]) => value);
  const probe = () => login.get({ request: new Request(`${ORIGIN}/api/customer-login`), env: settings });
  return { store, time, sleeps, background, cleaned, outcomes, logs, ghl, settings, login, verify, post, settle, probe, verifyGet, verifyPost, linkRows, sessions, ledgers };
}

async function sendLink(t, options = {}) {
  const h = await harness(t, options);
  const sent = await h.post({ identifier: '(970) 555-0101' });
  assert.equal(sent.status, 202);
  await h.settle();
  const token = tokenFrom(h.ghl.sends().at(-1)?.body.message);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, 'the provider received a sign-in link');
  return { h, token };
}

test('identical status, body and headers for known, unknown, ambiguous, stale, DND, notify-off and rate-limited identifiers', async t => {
  const h = await harness(t);
  const identifiers = ['970-555-0101', '970-555-0100', 'nobody@example.invalid', '970-555-0104', '970-555-0105', '970-555-0103', '970-555-0106', 'AVERY@Example.invalid'];
  const answers = [];
  for (const [index, identifier] of identifiers.entries()) answers.push(await h.post({ identifier }, { ip: `203.0.113.${index + 1}` }));
  await h.settle();
  const lookups = [];
  for (let index = 0; index < 4; index += 1) { answers.push(await h.post({ identifier: '970-555-0102' }, { ip: '198.51.100.9' })); await h.settle(); lookups.push(h.store.calls.queryCustomers); }
  const first = answers[0];
  assert.equal(first.status, 202);
  assert.deepEqual(JSON.parse(first.text), { ok: true, message: CUSTOMER_LOGIN_MESSAGE });
  for (const answer of answers) {
    assert.equal(answer.status, 202);
    assert.equal(answer.text, first.text);
    assert.deepEqual([...answer.response.headers].sort(), [...first.response.headers].sort());
  }
  assert.deepEqual(h.sleeps, answers.map(() => MIN_RESPONSE_MS), 'every answer is padded to the same envelope');
  await h.settle();
  const sends = h.ghl.sends();
  assert.deepEqual(sends.map(call => [call.body.contactId, call.body.toNumber]).sort(), [['contact-a', '+19705550101'], ['contact-b', '+19705550102']], 'only the single exact, contactable matches were sent a link');
  assert.equal(h.ledgers().filter(row => row.status === 'suppressed').length, 0, 'suppressed sends never claim the ledger');
  assert.equal(sends.length, 2);
  assert.deepEqual(h.outcomes.slice(-4).map(result => [result.outcome, result.status]), [['send', 'submitted'], ['send', 'already_sent'], ['send', 'already_sent'], ['rate_limited', undefined]], 'the ten-minute send key holds the second and third; the limiter stops the fourth');
  assert.deepEqual(h.outcomes.at(-1), { outcome: 'rate_limited', bucket: 'customer_login_identifier' });
  assert.equal(lookups[3], lookups[2], 'the rate-limited fourth request never looked the number up');
});

test('the outcome behind each request: exact match only, saved contact only, DND and notify respected', async t => {
  const h = await harness(t);
  const service = createApprovedSendService({ store: h.store.messaging, messenger: createGhlMessenger({ env: h.settings }), clock: h.time, env: h.settings, links: { loginLink: async ({ purpose }) => purpose === 'send' ? `${ORIGIN}/api/customer-login-verify?token=${'A'.repeat(43)}` : undefined } });
  const run = (identifier, ip = '203.0.113.50', deps = {}) => requestCustomerLoginLink({ store: h.store, identity: h.store, env: h.settings, service, now: h.time.iso, ...deps }, { identifier, ip });
  assert.deepEqual(await run('not a contact'), { outcome: 'invalid' });
  assert.deepEqual(await run('970-555-0100'), { outcome: 'unknown' });
  assert.deepEqual(await run('970-555-0104'), { outcome: 'ambiguous' });
  assert.deepEqual(await run('970-555-0105'), { outcome: 'unknown' }, 'a stale lookup key is not evidence');
  assert.deepEqual(await run('970-555-0103'), { outcome: 'send', status: 'suppressed', reason: 'contact_dnd_sms' });
  assert.deepEqual(await run('970-555-0106'), { outcome: 'send', status: 'suppressed', reason: 'job_notifications_off' });
  assert.deepEqual(await run('Avery@Example.INVALID'), { outcome: 'send', status: 'submitted', reason: '' });
  const [delivery] = h.ghl.sends();
  assert.equal(delivery.body.toNumber, '+19705550101', 'a typed email still delivers only to the saved phone on file');
  assert.equal(delivery.body.contactId, 'contact-a');
  // The identity index still lists the typed number, but the saved record no longer carries it.
  const staleIndex = { queryCustomers: async (field, value) => field === 'phoneE164' && value === '+19705550101' ? [{ id: 'customer-b', revision: 'r', name: 'Synthetic', phone: '9705550101', phoneE164: '+19705550101', emailLower: '' }] : [], jobsByContact: async () => [] };
  assert.deepEqual(await run('970-555-0101', '203.0.113.51', { identity: staleIndex }), { outcome: 'contact_mismatch' }, 'the typed number must equal the saved number');
  h.store.edit('customers/customer-b', { portalSessionVersion: 'broken' });
  assert.deepEqual(await run('970-555-0102', '203.0.113.52'), { outcome: 'account_review' });
  assert.equal(h.ghl.sends().length, 1);
});

test('per-identifier and per-IP limits with the injected clock and window reset', async t => {
  const h = await harness(t);
  const lookups = () => h.store.calls.queryCustomers;
  for (let index = 0; index < 5; index += 1) await h.post({ identifier: '970-555-0177' }, { ip: `192.0.2.${index + 1}` });
  await h.settle();
  assert.equal(lookups(), LOGIN_LIMITS.identifier.limit, 'only three lookups per number per window');
  h.time.advance(LOGIN_LIMITS.identifier.windowMs);
  await h.post({ identifier: '970-555-0177' }, { ip: '192.0.2.99' });
  await h.settle();
  assert.equal(lookups(), 4, 'a new window allows the number again');
  const before = lookups();
  for (let index = 0; index < 12; index += 1) { await h.post({ identifier: `970-555-${String(200 + index).padStart(4, '0')}` }, { ip: '198.51.100.20' }); await h.settle(); }
  assert.equal(lookups() - before, LOGIN_LIMITS.ip.limit, 'one address gets ten lookups per window across different numbers');
  // A parallel burst from one address contends on one counter and never exceeds the limit.
  const burst = lookups();
  for (let index = 0; index < 15; index += 1) await h.post({ identifier: `970-555-${String(300 + index).padStart(4, '0')}` }, { ip: '198.51.100.21' });
  await h.settle();
  assert.ok(lookups() - burst >= 1 && lookups() - burst <= LOGIN_LIMITS.ip.limit, `burst lookups ${lookups() - burst}`);
  const counters = [...h.store.rows].filter(([key]) => key.startsWith('rate_limits/'));
  assert.ok(counters.every(([key, row]) => /^rate_limits\/rl_[A-Za-z0-9_-]{43}$/.test(key) && !JSON.stringify(row).includes('198.51.100.20') && !JSON.stringify(row).includes('9705550177')), 'counters hold no raw address or number');
});

test('an IPv6 client is limited by its /64, however it rotates addresses inside it', async t => {
  const h = await harness(t);
  const lookups = () => h.store.calls.queryCustomers;
  for (let index = 0; index < 12; index += 1) { await h.post({ identifier: `970-555-${String(400 + index).padStart(4, '0')}` }, { ip: `2001:db8:5:6:${(index + 1).toString(16)}::${index + 7}` }); await h.settle(); }
  assert.equal(lookups(), LOGIN_LIMITS.ip.limit, 'twelve addresses in one /64 share ten lookups');
  await h.post({ identifier: '970-555-0450' }, { ip: '2001:db8:5:7::1' });
  await h.post({ identifier: '970-555-0451' }, { ip: '::ffff:192.0.2.77' });
  await h.settle();
  assert.equal(lookups(), LOGIN_LIMITS.ip.limit + 2, 'the next /64 and an IPv4 client have their own counters');
  assert.deepEqual(h.outcomes.slice(-4, -2).map(result => result.outcome), ['rate_limited', 'rate_limited']);
  assert.ok(h.outcomes.slice(-4, -2).every(result => result.bucket === 'customer_login_ip'));
});

test('a filled honeypot gets the same answer and is never looked up or counted', async t => {
  const h = await harness(t);
  const trap = await h.post({ identifier: '970-555-0101', botcheck: 'https://spam.example' });
  const real = await h.post({ identifier: '970-555-0100' });
  assert.equal(trap.status, 202); assert.equal(trap.text, real.text);
  await h.settle();
  assert.equal(h.store.calls.queryCustomers, 1);
  assert.equal(h.ghl.sends().length, 0);
});

test('the response never waits for the lookup: it is padded to a fixed minimum by the injected clock', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = memory();
  const identity = { queryCustomers: async (...args) => { await gate; return store.queryCustomers(...args); }, jobsByContact: (...args) => store.jobsByContact(...args) };
  const h = await harness(t, { identity });
  const answer = await h.post({ identifier: '970-555-0101' });
  assert.equal(answer.status, 202);
  assert.deepEqual(h.sleeps, [MIN_RESPONSE_MS]);
  assert.equal(h.background.length, 1, 'the lookup and send continue after the response');
  release(); await h.settle();
  assert.equal(h.ghl.sends().length, 1);
  // Without waitUntil the work runs inline; slow work is padded only up to the envelope.
  const inline = await harness(t);
  inline.store.hooks.beforeCommit = () => inline.time.advance(40);
  const started = inline.time().getTime();
  await inline.post({ identifier: '970-555-0101' }, { inline: true });
  assert.equal(inline.time().getTime() - started, MIN_RESPONSE_MS, 'known and unknown alike finish at the envelope');
  assert.ok(inline.sleeps[0] < MIN_RESPONSE_MS && inline.sleeps[0] > 0);
  const slow = await harness(t);
  slow.store.hooks.beforeCommit = () => slow.time.advance(400);
  await slow.post({ identifier: '970-555-0101' }, { inline: true });
  assert.deepEqual(slow.sleeps, [], 'work longer than the envelope is not padded further');
});

test('the flag off returns 404 everywhere and touches nothing; messaging off returns 503', async t => {
  const h = await harness(t, { flags: { CUSTOMER_LOGIN_ENABLED: 'false' } });
  const commits = h.store.commits.length;
  const off = await h.post({ identifier: '970-555-0101' });
  assert.equal(off.status, 404);
  assert.deepEqual(JSON.parse(off.text), { ok: false, code: 'CUSTOMER_LOGIN_UNAVAILABLE', error: 'Client Login is not available right now. Text us for a secure link.' });
  assert.equal((await h.login.get({ request: new Request(`${ORIGIN}/api/customer-login`), env: h.settings })).status, 404);
  assert.equal((await h.verifyGet('A'.repeat(43))).status, 404);
  assert.equal((await h.verifyPost('A'.repeat(43))).status, 404);
  assert.equal(h.store.commits.length, commits); assert.equal(h.store.calls.queryCustomers, 0);
  const unset = await harness(t, { flags: { CUSTOMER_LOGIN_ENABLED: undefined } });
  assert.equal((await unset.post({ identifier: '970-555-0101' })).status, 404, 'unset means off');
  const quiet = await harness(t, { flags: { EGC_MESSAGING_ENABLED: undefined } });
  const unavailable = await quiet.post({ identifier: '970-555-0101' });
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.parse(unavailable.text).code, 'CUSTOMER_LOGIN_UNAVAILABLE');
  assert.equal(quiet.background.length, 0);
  assert.equal((await quiet.probe()).status, 503, 'the page probe sees the same');
  assert.deepEqual(quiet.logs.map(line => JSON.parse(line)), [{ event: 'customer_login', outcome: 'unavailable', reason: 'messaging_disabled' }], 'the owner can see why customers are told to text, once per minute');
  quiet.time.advance(READINESS_TTL_MS);
  assert.equal((await quiet.probe()).status, 503);
  assert.deepEqual(quiet.logs.map(line => JSON.parse(line).reason), ['messaging_disabled', 'messaging_disabled'], 'and again once the minute has passed');
  assert.deepEqual([h.logs, unset.logs], [[], []], 'switched off on purpose: nothing to explain');
  assert.equal((await h.login.get({ request: new Request(`${ORIGIN}/api/customer-login`), env: env })).status, 405);
});

test('the page probe and every request answer 503 while no link could be sent: unapproved wording, missing keys or unreadable templates', async t => {
  const ready = await harness(t);
  assert.equal((await ready.probe()).status, 405, 'on and ready');
  const unapproved = await harness(t, { approve: false });
  const probe = await unapproved.probe();
  assert.deepEqual([probe.status, (await probe.json()).code], [503, 'CUSTOMER_LOGIN_UNAVAILABLE']);
  const refused = await unapproved.post({ identifier: '970-555-0101' });
  assert.deepEqual([refused.status, JSON.parse(refused.text).code], [503, 'CUSTOMER_LOGIN_UNAVAILABLE']);
  assert.equal((await unapproved.post({ identifier: '970-555-0100' })).text, refused.text, 'the same answer for every identifier: it is global state');
  assert.deepEqual([unapproved.background.length, unapproved.store.calls.queryCustomers, unapproved.ghl.sends().length], [0, 0, 0]);
  await approveLoginTemplate(unapproved.store);
  unapproved.time.advance(READINESS_TTL_MS);
  assert.equal((await unapproved.probe()).status, 405, 'owner approval turns it on without a deploy, within a minute');
  const keyless = await harness(t, { flags: { HUB_SESSION_SECRET: undefined } });
  assert.equal((await keyless.probe()).status, 503);
  assert.equal((await keyless.post({ identifier: '970-555-0101' })).status, 503);
  const down = await harness(t);
  down.store.hooks.failRead = collection => collection === 'message_templates';
  assert.equal((await down.probe()).status, 503);
  assert.equal((await down.post({ identifier: '970-555-0101' })).status, 503);
  assert.equal(down.background.length, 0);
  // Refusals log their reason (once per reason per minute), and nothing about the phone or email.
  const reasons = run => run.logs.map(line => JSON.parse(line)).map(line => [line.outcome, line.reason]);
  assert.deepEqual(reasons(unapproved), [['unavailable', 'template_unapproved']]);
  assert.deepEqual(reasons(keyless), [['unavailable', 'link_keys_unavailable']]);
  assert.deepEqual(reasons(down), [['unavailable', 'template_unreadable']]);
  assert.deepEqual(reasons(ready), []);
  assert.ok(![...unapproved.logs, ...keyless.logs, ...down.logs].join('\n').includes('555'));
});

test('one redacted log line per request says why nothing arrived, without the identifier, address or link', async t => {
  const h = await harness(t, { flags: { EGC_MESSAGING_DRY_RUN: undefined } });
  for (const [identifier, ip, botcheck] of [['Avery@Example.invalid', '2001:db8:77:1::5'], ['970-555-0100', '203.0.113.201'], ['970-555-0103', '203.0.113.202'], ['970-555-0101', '203.0.113.203', 'filled']]) {
    await h.post({ identifier, ...(botcheck ? { botcheck } : {}) }, { ip });
    await h.settle();
  }
  h.store.hooks.failRead = collection => collection === 'rate_limits';
  await h.post({ identifier: '970-555-0101' }, { ip: '203.0.113.204' });
  await h.settle();
  assert.deepEqual(h.logs.map(line => JSON.parse(line)), [
    { event: 'customer_login', outcome: 'send', status: 'dry_run' },
    { event: 'customer_login', outcome: 'unknown' },
    { event: 'customer_login', outcome: 'send', status: 'suppressed', reason: 'contact_dnd_sms' },
    { event: 'customer_login', outcome: 'honeypot' },
    { event: 'customer_login', outcome: 'error', code: 'dispatch_storage_unavailable' },
  ]);
  assert.equal(h.ghl.sends().length, 0, 'a dry run sends nothing and the log says so');
  const text = h.logs.join('\n');
  for (const secret of ['avery', 'Avery', '9705550100', '555', '2001:db8', '203.0.113', 'customer-', 'contact-', 'token', 'http']) assert.ok(!text.includes(secret), secret);
  assert.equal(loginLogLine({ outcome: 'send', status: 'failed', reason: 'bad +1 (970) 555-0101', code: 'x@example.invalid', bucket: '+19705550101', extra: 'customer-a' }), '{"event":"customer_login","outcome":"send","status":"failed","reason":"redacted","code":"redacted","bucket":"redacted"}', 'only plain codes are logged; anything else is redacted, and unknown keys never appear');
  assert.equal(loginLogLine(null), '{"event":"customer_login"}');
  h.store.hooks.failRead = null;
  const noisy = customerLoginHandlers({ storage: () => h.store, identity: () => h.store, messaging: () => h.store.messaging, now: h.time, sleep: async () => {}, log: () => { throw new Error('log sink down'); } });
  const context = { request: loginRequest({ identifier: '970-555-0100' }, { ip: '203.0.113.205' }), env: h.settings, waitUntil: promise => h.background.push(promise) };
  assert.equal((await noisy.post(context)).status, 202);
  await h.settle();
  assert.equal(h.outcomes.at(-1).outcome, 'unknown', 'a failing log sink never changes the outcome');
});

test('requests must be same-origin JSON with the portal header; malformed ones are refused before any lookup', async t => {
  const h = await harness(t);
  const cases = [
    [{ origin: 'https://evil.example' }, 403, 'CUSTOMER_LOGIN_ORIGIN_FORBIDDEN'],
    [{ origin: '' }, 403, 'CUSTOMER_LOGIN_ORIGIN_FORBIDDEN'],
    [{ headers: { 'X-EGC-Portal': '' } }, 403, 'CUSTOMER_LOGIN_ORIGIN_FORBIDDEN'],
    [{ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403, 'CUSTOMER_LOGIN_ORIGIN_FORBIDDEN'],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415, 'CUSTOMER_LOGIN_JSON_REQUIRED'],
  ];
  for (const [options, status, expected] of cases) {
    const answer = await h.post({ identifier: '970-555-0101' }, options);
    assert.deepEqual([answer.status, JSON.parse(answer.text).code], [status, expected], JSON.stringify(options));
  }
  const big = await h.post(JSON.stringify({ identifier: '970-555-0101', botcheck: 'x'.repeat(3000) }));
  assert.equal(big.status, 413);
  assert.equal((await h.post('{"identifier":')).status, 400);
  assert.equal(JSON.parse((await h.post({ identifier: '970-555-0101', customerId: 'customer-b' })).text).code, 'CUSTOMER_LOGIN_REQUEST_INVALID');
  assert.equal(JSON.parse((await h.post(['970-555-0101'])).text).code, 'CUSTOMER_LOGIN_REQUEST_INVALID');
  const known = await h.post({ identifier: '555-0101' }), unknown = await h.post({ identifier: 'no-at-sign.example' });
  assert.equal(known.status, 400); assert.equal(known.text, unknown.text, 'format errors say nothing about existence');
  assert.equal(JSON.parse(known.text).code, 'CUSTOMER_LOGIN_IDENTIFIER_INVALID');
  assert.equal(h.background.length, 0); assert.equal(h.store.calls.queryCustomers, 0);
});

test('GET renders a link-scanner-safe confirm page and never consumes the token', async t => {
  const { h, token } = await sendLink(t);
  h.store.hooks.failRead = () => true;
  for (let index = 0; index < 3; index += 1) {
    const page = await h.verifyGet(token);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('Cache-Control'), 'no-store');
    assert.equal(page.headers.get('Referrer-Policy'), 'strict-origin', 'the token URL never leaves as a Referer, yet the form POST keeps its Origin');
    const html = await page.text();
    assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
    assert.match(html, /<form id="cl-confirm" class="cl-form" method="post" action="\/api\/customer-login-verify">/);
    assert.ok(html.includes(`<input type="hidden" name="token" value="${token}">`));
    assert.match(html, /<button class="cl-button" type="submit">Sign in to my projects<\/button>/);
    assert.deepEqual(html.match(/<script\b[^>]*>/gi), ['<script src="/client-login.js?v=20260928b" defer>'], 'only the same-origin double-tap guard; the form works without it');
    assert.doesNotMatch(html, /<script[^>]*>[^<]/i);
  }
  h.store.hooks.failRead = null;
  const [link] = h.linkRows();
  assert.equal(link.usedAt, null, 'three GETs left the link unused');
  for (const bad of ['short', `${token}x`, `${token.slice(0, 42)}!`]) {
    const response = await h.verifyGet(encodeURIComponent(bad));
    assert.deepEqual([response.status, response.headers.get('Location')], [303, '/client-login?status=invalid']);
  }
  // Click tracking and UTM tags on the link are ignored, never read and never echoed.
  for (const query of [`token=${token}&utm_source=sms&utm_medium=text`, `utm_campaign=login&token=${token}&fbclid=synthetic`, `token=${token}&next=https://evil.example`]) {
    const tracked = await h.verify.get({ request: new Request(`${ORIGIN}/api/customer-login-verify?${query}`), env: h.settings });
    assert.equal(tracked.status, 200, query);
    const html = await tracked.text();
    assert.ok(html.includes(`<input type="hidden" name="token" value="${token}">`));
    assert.ok(!html.includes('utm_') && !html.includes('evil.example') && !html.includes('fbclid'), query);
  }
  for (const query of [`token=${token}&token=${token}`, `utm_source=sms`, `token=&utm_source=sms`, `TOKEN=${token}`]) {
    const refused = await h.verify.get({ request: new Request(`${ORIGIN}/api/customer-login-verify?${query}`), env: h.settings });
    assert.equal(refused.headers.get('Location'), '/client-login?status=invalid', query);
  }
  assert.equal(h.linkRows()[0].usedAt, null);
});

test('POST consumes the token once, opens an account session and lands on the customer\'s own project', async t => {
  const { h, token } = await sendLink(t);
  h.time.advance(5 * MIN);
  const response = await h.verifyPost(token);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/customer-portal');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  const account = cookies.find(cookie => cookie.startsWith('__Host-egc_customer='));
  assert.match(account, /^__Host-egc_customer=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.doesNotMatch(account, /Domain=/i, '__Host- cookies are host-only');
  const portal = cookies.find(cookie => cookie.startsWith('egc_customer_portal='));
  assert.match(portal, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
  const handoff = await verifyCustomerPortalSessionToken(h.settings, portal.split(';')[0].split('=')[1], h.time().getTime());
  assert.deepEqual([handoff.jobId, handoff.linkVersion, handoff.linkRoot, handoff.actorId], ['job-a1', 0, 'job-a1', ''], 'the upcoming project of the signed-in customer, with its P4-15 link version');
  const [session] = h.sessions();
  assert.deepEqual({ ...session, id: undefined }, { id: undefined, customerId: 'customer-a', sessionVersion: 0, via: 'magic_link', createdAt: h.time.iso(), expiresAt: new Date(h.time().getTime() + CUSTOMER_SESSION_TTL_MS).toISOString(), revokedAt: null });
  const [link] = h.linkRows();
  assert.deepEqual([link.usedAt, link.sessionId], [h.time.iso(), session.id]);
  const signedIn = await readCustomerAccountSession(h.store, h.settings, new Request(`${ORIGIN}/customer-portal`, { headers: { Cookie: account.split(';')[0] } }), h.time.iso());
  assert.equal(signedIn.customerId, 'customer-a');
  const again = await h.verifyPost(token);
  assert.deepEqual([again.status, again.headers.get('Location'), again.headers.getSetCookie().length], [303, '/client-login?status=used', 0], 'the second POST fails and says the link was just used');
  assert.equal(h.sessions().length, 1);
});

test('concurrent POSTs of one token open exactly one session', async t => {
  const { h, token } = await sendLink(t);
  const results = await Promise.all([1, 2, 3].map(() => h.verifyPost(token)));
  assert.deepEqual(results.map(response => response.headers.get('Location')).sort(), ['/client-login?status=used', '/client-login?status=used', '/customer-portal']);
  assert.equal(h.sessions().length, 1);
});

test('the token expires fifteen minutes after it is created, by the injected clock', async t => {
  const { h, token } = await sendLink(t);
  h.time.advance(LOGIN_LINK_TTL_MS);
  assert.equal((await h.verifyPost(token)).headers.get('Location'), '/client-login?status=expired');
  const second = await sendLink(t);
  second.h.time.advance(LOGIN_LINK_TTL_MS - 1);
  assert.equal((await second.h.verifyPost(second.token)).headers.get('Location'), '/customer-portal');
  assert.equal(h.sessions().length, 0);
});

test('a session-version bump after the link was sent voids it; a record change mid sign-in can be retried', async t => {
  const { h, token } = await sendLink(t);
  h.store.edit('customers/customer-a', { portalSessionVersion: 1 });
  assert.equal((await h.verifyPost(token)).headers.get('Location'), '/client-login?status=expired');
  const other = await sendLink(t);
  let bumped = false;
  other.h.store.hooks.beforeCommit = writes => { if (!bumped && writes.some(write => write.collection === 'customer_sessions')) { bumped = true; other.h.store.edit('customers/customer-a', { name: 'Synthetic renamed' }); } };
  assert.equal((await other.h.verifyPost(other.token)).headers.get('Location'), '/client-login?status=retry');
  assert.equal(other.h.linkRows()[0].usedAt, null);
  assert.equal((await other.h.verifyPost(other.token)).headers.get('Location'), '/customer-portal', 'the unused link still works');
});

test('a lost commit response still completes the exact sign-in it wrote', async t => {
  const { h, token } = await sendLink(t);
  h.store.hooks.loseResponse = writes => writes.some(write => write.collection === 'customer_sessions');
  const response = await h.verifyPost(token);
  assert.equal(response.headers.get('Location'), '/customer-portal');
  assert.equal(response.headers.getSetCookie().length, 2);
});

test('cross-origin, originless and malformed verify POSTs are refused and leave the token unused', async t => {
  const { h, token } = await sendLink(t);
  assert.equal((await h.verifyPost(token, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.verifyPost(token, { origin: '' })).status, 403);
  const nullOrigin = site => h.verify.post({ request: new Request(`${ORIGIN}/api/customer-login-verify`, { method: 'POST', body: `token=${token}`, headers: { Origin: 'null', ...(site ? { 'Sec-Fetch-Site': site } : {}), 'Content-Type': 'application/x-www-form-urlencoded' } }), env: h.settings });
  assert.equal((await nullOrigin('')).status, 403, 'an opaque origin without fetch metadata is refused');
  assert.equal((await nullOrigin('same-site')).status, 403);
  assert.equal((await nullOrigin('cross-site')).status, 403);
  const crossSite = await h.verify.post({ request: new Request(`${ORIGIN}/api/customer-login-verify`, { method: 'POST', body: `token=${token}`, headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/x-www-form-urlencoded' } }), env: h.settings });
  assert.equal(crossSite.status, 403);
  assert.equal((await h.verifyPost(token, { contentType: 'application/json', body: JSON.stringify({ token }) })).headers.get('Location'), '/client-login?status=invalid');
  assert.equal((await h.verifyPost(token, { body: `token=${token}&customerId=customer-b` })).headers.get('Location'), '/client-login?status=invalid');
  assert.equal((await h.verifyPost(token, { body: `token=${token}&token=${token}` })).headers.get('Location'), '/client-login?status=invalid');
  assert.equal((await h.verifyPost('A'.repeat(43))).headers.get('Location'), '/client-login?status=invalid', 'an unknown token');
  assert.equal(h.linkRows()[0].usedAt, null);
  assert.equal((await nullOrigin('same-origin')).headers.get('Location'), '/customer-portal', 'a same-origin form that reports an opaque Origin still signs in');
});

test('a token for one customer can never open another customer\'s account or project', async t => {
  const h = await harness(t);
  await h.post({ identifier: '970-555-0101' }, { ip: '203.0.113.1' });
  await h.settle();
  await h.post({ identifier: '970-555-0102' }, { ip: '203.0.113.2' });
  await h.settle();
  const [tokenA, tokenB] = h.ghl.sends().map(call => tokenFrom(call.body.message));
  assert.deepEqual(h.ghl.sends().map(call => call.body.contactId), ['contact-a', 'contact-b']);
  assert.ok(tokenA && tokenB && tokenA !== tokenB);
  for (const [token, customerId, jobs] of [[tokenA, 'customer-a', ['job-a1', 'job-a2']], [tokenB, 'customer-b', ['job-b1']]]) {
    const response = await h.verifyPost(token), cookies = response.headers.getSetCookie();
    const session = await readCustomerAccountSession(h.store, h.settings, new Request(ORIGIN, { headers: { Cookie: cookies[0].split(';')[0] } }), h.time.iso());
    assert.equal(session.customerId, customerId);
    const handoff = await verifyCustomerPortalSessionToken(h.settings, cookies[1].split(';')[0].split('=')[1], h.time().getTime());
    assert.ok(jobs.includes(handoff.jobId), `${customerId} lands on its own project`);
  }
});

test('a customer without an active project is signed in and told so, and any older project cookie is cleared', async t => {
  const h = await harness(t);
  const { url } = await createLoginLink(h.store, h.settings, { customerId: 'customer-stale', sessionVersion: 0 }, h.time.iso(), { origin: ORIGIN });
  const response = await h.verifyPost(tokenFrom(url));
  assert.equal(response.headers.get('Location'), '/client-login?status=signed_in');
  const [account, portal] = response.headers.getSetCookie();
  assert.match(account, /^__Host-egc_customer=[A-Za-z0-9_-]{43};/);
  assert.equal(portal, 'egc_customer_portal=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0', 'a project cookie from an earlier sign-in on this browser is cleared');
});

test('tokens are never stored raw: links, sessions and the send ledger hold digests and display text only', async t => {
  const { h, token } = await sendLink(t);
  const response = await h.verifyPost(token), sessionToken = response.headers.getSetCookie()[0].split(';')[0].split('=')[1];
  const everything = JSON.stringify([...h.store.rows]) + JSON.stringify(h.store.commits);
  assert.ok(!everything.includes(token), 'the link token is not stored');
  assert.ok(!everything.includes(sessionToken), 'the session token is not stored');
  assert.ok(!everything.includes('/api/customer-login-verify?token='), 'the bearer URL is not stored');
  const [link] = h.linkRows(), [session] = h.sessions();
  assert.equal(link.id, await loginLinkId(h.settings, token));
  assert.equal(link.id, `ml_${await purposeSign(h.settings, PURPOSES.magicLink, token)}`, 'egc/magic-link/v1 keys the link digest');
  assert.equal(session.id, `cs_${await purposeSign(h.settings, PURPOSES.customerAccountSession, sessionToken)}`, 'egc/customer-account-session/v1 keys the session digest');
  const [ledger] = h.ledgers();
  assert.match(ledger.body, /sign-in link: \[secure link\]/);
  assert.equal(ledger.approval, 'customer_initiated'); assert.equal(ledger.source, 'portal'); assert.equal(ledger.targetId, 'customer-a');
});

test('a provider failure is recorded and never retried automatically; an uncertain send is never repeated', async t => {
  const failed = await harness(t, { ghl: { sendStatus: 422 } });
  await failed.post({ identifier: '970-555-0101' });
  await failed.settle();
  assert.equal(failed.ghl.sends().length, 1);
  assert.deepEqual(failed.ledgers().map(row => [row.status, row.attempts]), [['failed', 1]]);
  const unsure = await harness(t, { ghl: { sendStatus: 503 } });
  await unsure.post({ identifier: '970-555-0101' }, { ip: '203.0.113.60' });
  await unsure.settle();
  unsure.time.advance(MIN);
  await unsure.post({ identifier: '970-555-0101' }, { ip: '203.0.113.61' });
  await unsure.settle();
  assert.equal(unsure.ghl.sends().length, 1, 'an uncertain outcome is never resent');
  assert.equal(unsure.ledgers()[0].status, 'uncertain');
  const unapproved = await harness(t, { approve: false });
  assert.equal((await unapproved.post({ identifier: '970-555-0101' })).status, 503, 'unapproved wording is refused up front with the text-us answer');
  await unapproved.settle();
  assert.equal(unapproved.ghl.sends().length, 0, 'nothing is sent until the owner approves the wording');
  assert.equal(unapproved.linkRows().length, 0);
  // The wording becomes unreadable between the up-front check and the send: nothing is sent, and the log says why.
  const raced = await harness(t);
  raced.store.hooks.failRead = (collection, id) => collection === 'message_templates' && raced.store.calls.queryCustomers > 0 && id === 'portal_magic_link';
  await raced.post({ identifier: '970-555-0101' });
  await raced.settle();
  assert.equal(raced.ghl.sends().length, 0);
  assert.equal(JSON.parse(raced.logs[0]).outcome, 'error');
});

test('expired records are cleaned up occasionally and within a bound', async t => {
  const always = await harness(t, { random: bytes => bytes.length === 1 ? bytes.fill(0) : globalThis.crypto.getRandomValues(bytes) });
  await always.post({ identifier: '970-555-0100' });
  await always.settle();
  assert.deepEqual(always.cleaned.map(([collection]) => collection), ['rate_limits', 'customer_login_links', 'customer_sessions']);
  assert.ok(always.cleaned.every(([, at]) => at === always.time.iso()), 'the injected clock dates the cleanup');
  const never = await harness(t, { random: bytes => bytes.length === 1 ? bytes.fill(255) : globalThis.crypto.getRandomValues(bytes) });
  await never.post({ identifier: '970-555-0100' });
  await never.settle();
  assert.deepEqual(never.cleaned, []);
});

test('identifier normalization, link origins and the confirm page escape', async () => {
  assert.deepEqual(loginIdentifier(' (970) 555-0101 '), { kind: 'phone', field: 'phoneE164', value: '+19705550101' });
  assert.deepEqual(loginIdentifier('Avery@Example.INVALID'), { kind: 'email', field: 'emailLower', value: 'avery@example.invalid' });
  for (const bad of ['', '   ', '555-0101', 'a@b', 42, null, 'x'.repeat(300)]) assert.equal(loginIdentifier(bad), null, String(bad));
  assert.equal(loginLinkOrigin('https://easygaragecleaning.com/api/customer-login'), 'https://easygaragecleaning.com');
  assert.equal(loginLinkOrigin('https://www.easygaragecleaning.com/api/customer-login'), 'https://www.easygaragecleaning.com');
  assert.equal(loginLinkOrigin('https://synthetic-branch.easy-garage-cleaning.pages.dev/api/customer-login'), 'https://synthetic-branch.easy-garage-cleaning.pages.dev');
  for (const other of ['https://evil.example/api/customer-login', 'http://easygaragecleaning.com/x', 'https://easygaragecleaning.com.evil.example/x', 'not a url']) assert.equal(loginLinkOrigin(other), 'https://easygaragecleaning.com', other);
  const html = await confirmPage('"><script>alert(1)</script>').text();
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&quot;&gt;&lt;script&gt;'));
});

test('redeem refuses unknown, malformed and wrong-customer links without writing', async () => {
  const store = memory(seed()), commits = () => store.commits.length;
  await assert.rejects(redeemLoginLink(store, env, 'short', NOW), code('CUSTOMER_LOGIN_LINK_INVALID'));
  await assert.rejects(redeemLoginLink(store, env, 'B'.repeat(43), NOW), code('CUSTOMER_LOGIN_LINK_INVALID'));
  const { url } = await createLoginLink(store, env, { customerId: 'customer-a', sessionVersion: 0 }, NOW, { origin: ORIGIN });
  const token = tokenFrom(url), before = commits();
  store.remove('customers/customer-a');
  await assert.rejects(redeemLoginLink(store, env, token, NOW), code('CUSTOMER_LOGIN_LINK_REVOKED'));
  assert.equal(commits(), before);
  await assert.rejects(createLoginLink(store, env, { customerId: 'secure_customer', sessionVersion: 0 }, NOW), code('CUSTOMER_LOGIN_LINK_INVALID'));
  await assert.rejects(createLoginLink(store, env, { customerId: 'customer-a', sessionVersion: -1 }, NOW), code('CUSTOMER_LOGIN_LINK_INVALID'));
});

// A small Firestore REST double: documents, masked EQUAL/LESS_THAN queries in
// name order with a cursor, transactions with batchGet, and commits whose
// stale updateTime answers 400 FAILED_PRECONDITION as Firestore does.
function firestoreRest() {
  const ROOT = 'projects/egcw-1ec83/databases/(default)/documents', docs = new Map(), requests = [];
  let counter = 0;
  const put = (path, fields) => docs.set(path, { fields, updateTime: `2026-09-22T00:00:00.${String(++counter).padStart(6, '0')}Z` });
  // Field masks keep top-level names and map.subfield paths, as Firestore projections do.
  const masked = (fields, mask) => { const out = {}; for (const path of mask) { const [top, sub] = path.split('.'), value = fields[top]; if (!value) continue; if (sub === undefined) out[top] = value; else if (value.mapValue?.fields?.[sub]) out[top] = { mapValue: { fields: { ...out[top]?.mapValue.fields, [sub]: value.mapValue.fields[sub] } } }; } return out; };
  const doc = (path, mask) => { const row = docs.get(path); return { name: `${ROOT}/${path}`, fields: mask ? masked(row.fields, mask) : row.fields, updateTime: row.updateTime }; };
  const value = field => field?.stringValue ?? field?.integerValue ?? null;
  async function handle(url, options = {}) {
    requests.push(url.toString());
    assert.equal(url.searchParams.get('key'), 'firebase-test-client-login');
    const path = decodeURIComponent(url.pathname.split('/documents')[1] || '').replace(/^\//, ''), body = options.body ? JSON.parse(options.body) : {};
    if (path === ':runQuery') {
      const query = body.structuredQuery, collection = query.from[0].collectionId, filter = query.where.fieldFilter, mask = query.select?.fields.map(field => field.fieldPath);
      let rows = [...docs.keys()].filter(key => key.startsWith(`${collection}/`) && !key.slice(collection.length + 1).includes('/')).sort();
      rows = rows.filter(key => { const current = value(docs.get(key).fields[filter.field.fieldPath]); return filter.op === 'EQUAL' ? current === value(filter.value) : current !== null && current < value(filter.value); });
      if (query.startAt) rows = rows.filter(key => `${ROOT}/${key}` > query.startAt.values[0].referenceValue);
      rows = rows.slice(0, query.limit);
      return Response.json(rows.length ? rows.map(key => ({ document: doc(key, mask) })) : [{ readTime: '2026-09-22T18:00:00Z' }]);
    }
    if (path === ':beginTransaction') return Response.json({ transaction: 'synthetic-transaction' });
    if (path === ':rollback') return Response.json({});
    if (path === ':batchGet') return Response.json(body.documents.map(name => { const key = name.slice(ROOT.length + 1); return docs.has(key) ? { found: doc(key, body.mask?.fieldPaths) } : { missing: name }; }));
    if (path === ':commit') {
      for (const write of body.writes) {
        const key = (write.update?.name || write.delete).slice(ROOT.length + 1), current = docs.get(key), condition = write.currentDocument || {};
        if (condition.exists === false && current) return Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 });
        if (condition.updateTime && current?.updateTime !== condition.updateTime) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
      }
      for (const write of body.writes) {
        if (write.delete) { docs.delete(write.delete.slice(ROOT.length + 1)); continue; }
        const key = write.update.name.slice(ROOT.length + 1), current = docs.get(key)?.fields || {};
        put(key, write.updateMask ? { ...current, ...Object.fromEntries(write.updateMask.fieldPaths.map(field => [field, write.update.fields[field]])) } : write.update.fields);
      }
      return Response.json({ commitTime: '2026-09-22T18:00:00Z' });
    }
    return docs.has(path) ? Response.json(doc(path)) : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
  }
  return { docs, requests, put, handle, keys: prefix => [...docs.keys()].filter(key => key.startsWith(prefix)) };
}

test('production wiring: the default handlers and storage adapters complete a sign-in over Firestore REST', async t => {
  const rest = firestoreRest(), ghl = fakeGhl({ contacts: contacts() }), time = clock(), settings = { ...env, FIREBASE_API_KEY: 'firebase-test-client-login' };
  for (const [key, value] of Object.entries(seed())) rest.put(key, encodeFirestoreFields(value));
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'firestore.googleapis.com') return rest.handle(url, options);
    if (url.hostname === 'services.leadconnectorhq.com') return ghl.fetcher(url.toString(), options);
    throw new Error(`Unexpected host ${url.hostname}`);
  });
  const templates = messagingStorage(settings), state = await readTemplate(templates, 'portal_magic_link');
  await mutateTemplate(templates, owner, { action: 'approve', requestId: randomUUID(), kind: 'portal_magic_link', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  const logs = [], login = customerLoginHandlers({ now: time, sleep: async ms => time.advance(ms), log: line => logs.push(line) }), verify = customerLoginVerifyHandlers({ now: time }), background = [];
  const answer = await login.post({ request: loginRequest({ identifier: '970.555.0101' }), env: settings, waitUntil: promise => background.push(promise) });
  assert.deepEqual([answer.status, await answer.json()], [202, { ok: true, message: CUSTOMER_LOGIN_MESSAGE }]);
  assert.equal((await login.get({ request: new Request(`${ORIGIN}/api/customer-login`), env: settings })).status, 405, 'the probe reads the approved wording over REST');
  assert.deepEqual(await Promise.all(background), [{ outcome: 'send', status: 'submitted', reason: '' }]);
  assert.deepEqual(logs, ['{"event":"customer_login","outcome":"send","status":"submitted"}']);
  assert.deepEqual(['rate_limits/', 'customer_login_links/', 'message_sends/'].map(prefix => rest.keys(prefix).length), [4, 1, 1], 'IP and identifier windows, the rolling identifier day and the rolling customer day');
  const token = tokenFrom(ghl.sends()[0].body.message);
  assert.ok(ghl.sends()[0].body.message.includes(`https://easygaragecleaning.com/api/customer-login-verify?token=${token}`));
  assert.equal((await verify.get({ request: new Request(`${ORIGIN}/api/customer-login-verify?token=${token}`), env: settings })).status, 200);
  const signedIn = await verify.post({ request: verifyRequest(token), env: settings });
  assert.deepEqual([signedIn.status, signedIn.headers.get('Location'), signedIn.headers.getSetCookie().length], [303, '/customer-portal', 2]);
  assert.equal(rest.keys('customer_sessions/').length, 1);
  const session = await readCustomerAccountSession(customerAccountStorage(settings), settings, new Request(ORIGIN, { headers: { Cookie: signedIn.headers.getSetCookie()[0].split(';')[0] } }), time.iso());
  assert.equal(session.customerId, 'customer-a');
  assert.equal((await verify.post({ request: verifyRequest(token), env: settings })).headers.get('Location'), '/client-login?status=used', 'a replay is refused');
  time.advance(11 * MIN);
  await login.post({ request: loginRequest({ identifier: '970.555.0101' }), env: settings, waitUntil: promise => background.push(promise) });
  await Promise.all(background);
  const second = tokenFrom(ghl.sends()[1].body.message);
  const raced = await Promise.all([1, 2].map(() => verify.post({ request: verifyRequest(second), env: settings })));
  assert.deepEqual(raced.map(response => response.headers.get('Location')).sort(), ['/client-login?status=used', '/customer-portal'], 'a double tap on a real commit opens one session');
  assert.equal(rest.keys('customer_sessions/').length, 2);
  assert.ok(!JSON.stringify([...rest.docs]).includes(token) && !JSON.stringify([...rest.docs]).includes(second), 'no raw token in Firestore');
  assert.ok(rest.requests.some(url => url.includes(':beginTransaction')), 'the customer fence runs in a transaction');
});

test('a business-linked project (B2B-SAFE) never gets a homeowner owner session from a sign-in, even after staff bump its link version', async t => {
  const rows = seed();
  // customer-a's only projects belong to a business account; staff also revoked the homeowner links (version 3).
  rows['jobs/job-a1'] = { ...rows['jobs/job-a1'], businessAccountId: 'biz_acme', customerPortalLinkVersion: 3 };
  const { h, token } = await sendLink(t, { rows });
  const response = await h.verifyPost(token);
  assert.deepEqual([response.status, response.headers.get('Location')], [303, '/client-login?status=signed_in']);
  const cookies = response.headers.getSetCookie();
  assert.match(cookies[0], /^__Host-egc_customer=[A-Za-z0-9_-]{43};/, 'the account session still opens');
  assert.deepEqual(cookies.filter(cookie => cookie.startsWith('egc_customer_portal=')), ['egc_customer_portal=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'], 'no project session is minted; an older one on this browser is cleared');
  assert.equal(h.store.get('jobs/job-a1').customerPortalLinkVersion, 3, 'the revoked version is not re-issued');
  // With a homeowner project as well, the sign-in lands there and never on the company project.
  const mixed = seed();
  mixed['jobs/job-a0'] = { ...mixed['jobs/job-a1'], businessAccountId: 'biz_acme', date: '2026-09-23' };
  const second = await sendLink(t, { rows: mixed });
  const landed = await second.h.verifyPost(second.token);
  assert.equal(landed.headers.get('Location'), '/customer-portal');
  const handoff = await verifyCustomerPortalSessionToken(second.h.settings, landed.headers.getSetCookie()[1].split(';')[0].split('=')[1], second.h.time().getTime());
  assert.deepEqual([handoff.jobId, handoff.actorId], ['job-a1', '']);
});

test('a slow drip cannot text a customer all night: at most three sign-in texts per customer in any 24 hours', async t => {
  const h = await harness(t);
  const start = Date.parse('2026-09-23T06:00:00.000Z'); // Midnight in Denver.
  let lookups = 0;
  for (let index = 0; index < 24 * 6; index += 1) {
    h.time.set(new Date(start + index * 10 * MIN).toISOString());
    assert.equal((await h.post({ identifier: '970-555-0101' }, { ip: '203.0.113.7' })).status, 202);
    await h.settle();
    if (index === 4) lookups = h.store.calls.queryCustomers;
  }
  const tally = {};
  for (const result of h.outcomes) { const key = result.outcome === 'send' ? `send:${result.status}` : `${result.outcome}:${result.bucket}`; tally[key] = (tally[key] || 0) + 1; }
  assert.deepEqual(tally, { 'send:submitted': 3, 'rate_limited:customer_login_customer_day': 2, 'rate_limited:customer_login_identifier_day': 139 }, 'one request every ten minutes for a whole day from one address');
  assert.equal(h.ghl.sends().length, 3);
  assert.ok(lookups > 0);
  assert.equal(h.store.calls.queryCustomers, lookups, 'after five requests the number is not even looked up for the rest of the day');
  // A day after the first request, one slot reopens.
  h.time.set(new Date(start + 24 * 60 * MIN).toISOString());
  await h.post({ identifier: '970-555-0101' }, { ip: '203.0.113.7' });
  await h.settle();
  assert.deepEqual(h.outcomes.at(-1), { outcome: 'send', status: 'submitted', reason: '' });
  assert.equal(h.ghl.sends().length, 4);
});

test('the customer cap counts texts, not taps: three taps inside three minutes send one text and use one slot, so a request two hours later still sends', async t => {
  const h = await harness(t);
  const at = minutes => new Date(Date.parse(NOW) + minutes * MIN).toISOString();
  const hits = async customerId => h.store.get(`${RATE_LIMITS}/${await rateLimitId(env, LOGIN_LIMITS.customerDay.bucket, `customer:${customerId}`, 'rolling')}`)?.hits;
  const request = async (minutes, identifier = '970-555-0101', ip = '203.0.113.9') => { h.time.set(at(minutes)); await h.post({ identifier }, { ip }); await h.settle(); return h.outcomes.at(-1); };
  for (const minutes of [0, 1, 3]) await request(minutes);
  assert.deepEqual(h.outcomes.map(result => result.status), ['submitted', 'already_sent', 'already_sent'], 'the approved-send ten-minute key turns the repeats away');
  assert.equal(h.ghl.sends().length, 1, 'one text');
  assert.deepEqual(await hits('customer-a'), [NOW], 'the two repeats gave their slots back');
  assert.deepEqual(await request(120), { outcome: 'send', status: 'submitted', reason: '' }, 'two hours later the customer still gets a link');
  assert.equal(h.ghl.sends().length, 2);
  assert.deepEqual(await hits('customer-a'), [NOW, at(120)]);
  // A suppressed send (notify off) texts nothing and keeps no slot.
  assert.deepEqual(await request(121, '970-555-0106', '203.0.113.10'), { outcome: 'send', status: 'suppressed', reason: 'job_notifications_off' });
  assert.deepEqual(await hits('customer-quiet'), []);
  // A give-back that cannot be written leaves the slot counted (fail closed), and the request still reports its send.
  h.store.hooks.beforeCommit = writes => { if (writes.some(write => write.collection === RATE_LIMITS && Object.hasOwn(write.patch, 'hits') && !Object.hasOwn(write.patch, 'expiresAt'))) throw Object.assign(new Error('Synthetic outage'), { code: 'dispatch_storage_unavailable', status: 503 }); };
  assert.deepEqual(await request(125), { outcome: 'send', status: 'already_sent', reason: '' });
  assert.deepEqual(await hits('customer-a'), [NOW, at(120), at(125)]);
  h.store.hooks.beforeCommit = null;
  // Three slots are counted, so the customer's email (a fresh identifier) is refused for the rest of the day.
  assert.deepEqual(await request(240, 'avery@example.invalid'), { outcome: 'rate_limited', bucket: LOGIN_LIMITS.customerDay.bucket });
  assert.equal(h.ghl.sends().length, 2);
});

test('a phone and an email for the same customer share the daily cap', async t => {
  const h = await harness(t);
  const identifiers = ['970-555-0101', 'avery@example.invalid', '(970) 555-0101', 'Avery@Example.invalid', '970.555.0101'];
  for (const [index, identifier] of identifiers.entries()) {
    h.time.set(new Date(Date.parse(NOW) + index * 11 * MIN).toISOString());
    await h.post({ identifier }, { ip: `203.0.113.${20 + index}` });
    await h.settle();
  }
  assert.equal(h.ghl.sends().length, 3);
  assert.deepEqual(h.outcomes.slice(-2), [{ outcome: 'rate_limited', bucket: 'customer_login_customer_day' }, { outcome: 'rate_limited', bucket: 'customer_login_customer_day' }]);
  assert.deepEqual(h.logs.slice(-1).map(line => JSON.parse(line)), [{ event: 'customer_login', outcome: 'rate_limited', bucket: 'customer_login_customer_day' }], 'the log names the bucket, never the customer');
  // Another customer is unaffected.
  await h.post({ identifier: '970-555-0102' }, { ip: '203.0.113.40' });
  await h.settle();
  assert.equal(h.ghl.sends().at(-1).body.contactId, 'contact-b');
});

test('a failed landing lookup leaves the link unspent and offers the same tap again', async t => {
  const { h, token } = await sendLink(t);
  const customerJobs = h.store.customerJobs;
  h.store.customerJobs = async () => { throw Object.assign(new Error('Synthetic outage'), { code: 'CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', status: 503 }); };
  const failed = await h.verifyPost(token);
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.headers.getSetCookie(), [], 'no cookie is set or cleared: an existing project session stays');
  assert.equal(failed.headers.get('Cache-Control'), 'no-store');
  const html = await failed.text();
  assert.match(html, /<h1>Sign-in didn’t finish<\/h1>/);
  assert.ok(html.includes(`<input type="hidden" name="token" value="${token}">`));
  assert.match(html, /<form id="cl-confirm" class="cl-form" method="post" action="\/api\/customer-login-verify">/);
  assert.match(html, /<button class="cl-button" type="submit">Try again<\/button>/);
  assert.deepEqual([h.linkRows()[0].usedAt, h.sessions().length], [null, 0], 'the link was not spent and no session opened');
  // A storage outage while reading the link itself answers the same way.
  h.store.hooks.failRead = collection => collection === 'customer_login_links';
  assert.equal((await h.verifyPost(token)).status, 503);
  h.store.hooks.failRead = null;
  h.store.customerJobs = customerJobs;
  const retried = await h.verifyPost(token);
  assert.deepEqual([retried.status, retried.headers.get('Location'), retried.headers.getSetCookie().length], [303, '/customer-portal', 2], 'the same link then signs in');
  assert.equal(h.sessions().length, 1);
});

test('the readiness check is cached per isolate by the injected clock, and the unavailable line is logged once a minute', async t => {
  const h = await harness(t);
  let reads = 0, broken = false;
  h.store.hooks.failRead = collection => { if (collection !== 'message_templates') return false; reads += 1; return broken; };
  for (let index = 0; index < 5; index += 1) assert.equal((await h.probe()).status, 405);
  assert.equal((await h.post({ identifier: '970-555-0101', botcheck: 'filled' })).status, 202);
  assert.equal(reads, 1, 'one template read for six requests');
  h.time.advance(READINESS_TTL_MS);
  await h.probe();
  assert.equal(reads, 2, 'read again after a minute');
  // A read error is cached briefly (ten seconds) and logged once.
  broken = true;
  h.time.advance(READINESS_TTL_MS);
  for (let index = 0; index < 4; index += 1) assert.equal((await h.probe()).status, 503);
  assert.equal(reads, 3);
  h.time.advance(10000);
  broken = false;
  assert.equal((await h.probe()).status, 405, 'recovers ten seconds after a read error');
  assert.equal(reads, 4);
  await h.settle();
  const unavailableLines = () => h.logs.map(line => JSON.parse(line)).filter(line => line.outcome === 'unavailable');
  assert.deepEqual(unavailableLines(), [{ event: 'customer_login', outcome: 'unavailable', reason: 'template_unreadable' }]);
  // A different reason is logged straight away.
  const quiet = customerLoginHandlers({ storage: () => h.store, identity: () => h.store, messaging: () => h.store.messaging, now: h.time, sleep: async () => {}, log: line => h.logs.push(line) });
  await quiet.get({ request: new Request(`${ORIGIN}/api/customer-login`), env: { ...h.settings, EGC_MESSAGING_ENABLED: undefined } });
  await quiet.get({ request: new Request(`${ORIGIN}/api/customer-login`), env: { ...h.settings, HUB_SESSION_SECRET: undefined } });
  await quiet.get({ request: new Request(`${ORIGIN}/api/customer-login`), env: { ...h.settings, HUB_SESSION_SECRET: undefined } });
  assert.deepEqual(unavailableLines().slice(1).map(line => line.reason), ['messaging_disabled', 'link_keys_unavailable']);
});
