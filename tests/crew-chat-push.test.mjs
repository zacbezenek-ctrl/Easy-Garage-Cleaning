// CREW-PUSH (EGC_CREW_CHAT_PUSH): crew-chat phone alerts while the Hub is closed. The Web Push library (RFC 8291
// encryption, RFC 8292 VAPID) on WebCrypto, who a message alerts (readers of its room, today's staff, never the sender),
// what the lock screen shows (sender and room, never the text), dead subscriptions dropped, the subscription API, and
// that the Hub's polls never read subscriptions. Synthetic staff from tests/helpers/vault-fixture.mjs; every push
// service call is caught here, nothing leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { vaultFirestore, staffEnv, cookieFor, ROOT, ORIGIN } from './helpers/vault-fixture.mjs';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { base64UrlDecode, base64UrlEncode, encryptPushPayload, pushEndpoint, pushSubscription, sendWebPush, vapidAuthorization, vapidKeys } from '../functions/_lib/web-push.js';
import { crewChatAlert, crewChatPushEnabled, listCrewPushSubscriptions, saveCrewPushSubscription, PUSH_COLLECTION } from '../functions/_lib/crew-push.js';
import { onRequestGet as hubGet, onRequestPost as hubPost } from '../functions/api/employee-hub.js';
import { hubPushHandlers } from '../functions/api/hub-push.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
// The receiving browser's side of RFC 8291, written from the RFC independently of web-push.js.
async function decryptAsBrowser(body, browser) {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen), sealed = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  const sender = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, browser.privateKey, 256));
  const ikm = await hkdf(browser.auth, shared, concat(encoder.encode('WebPush: info\0'), browser.publicRaw, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), sealed));
  let end = plain.length - 1; while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'a single, last record');
  return decoder.decode(plain.slice(0, end));
}
async function browserKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: pair.privateKey, publicRaw, auth, keys: { p256dh: base64UrlEncode(publicRaw), auth: base64UrlEncode(auth) } };
}
async function vapidEnv() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { EGC_VAPID_PUBLIC_KEY: base64UrlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)), EGC_VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d };
}

test('RFC 8291 Appendix A: the published example encrypts to exactly the published message', async () => {
  const asPublic = base64UrlDecode('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const jwk = { kty: 'EC', crv: 'P-256', x: base64UrlEncode(asPublic.slice(1, 33)), y: base64UrlEncode(asPublic.slice(33)), d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' };
  const local = { privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']), publicKey: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []) };
  const subscription = { keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
  const body = await encryptPushPayload(subscription, 'When I grow up, I want to be a watermelon', { local, salt: base64UrlDecode('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.equal(base64UrlEncode(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a push decrypts in the browser with its own keys, and a fresh salt and key each time', async () => {
  const browser = await browserKeys(), subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: browser.keys };
  const first = await encryptPushPayload(subscription, '{"title":"EGC crew chat"}'), second = await encryptPushPayload(subscription, '{"title":"EGC crew chat"}');
  assert.equal(await decryptAsBrowser(first, browser), '{"title":"EGC crew chat"}');
  assert.notDeepEqual(first.slice(0, 16), second.slice(0, 16), 'a new salt per message');
  await assert.rejects(encryptPushPayload(subscription, 'x'.repeat(4080)), RangeError);
});

test('the VAPID header signs for the push service origin with the configured key, for 12 hours', async () => {
  const env = await vapidEnv(), keys = vapidKeys(env), now = Date.parse('2026-10-26T15:00:00Z');
  const header = await vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', { subject: 'https://easygaragecleaning.com', now });
  const [, token, publicKey] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(publicKey, env.EGC_VAPID_PUBLIC_KEY);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(decoder.decode(base64UrlDecode(head))), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(decoder.decode(base64UrlDecode(claims))), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 43200, sub: 'https://easygaragecleaning.com' });
  const verifier = await crypto.subtle.importKey('raw', base64UrlDecode(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, base64UrlDecode(signature), encoder.encode(`${head}.${claims}`)), true);
  assert.equal(vapidKeys({ ...env, EGC_VAPID_PRIVATE_KEY: '' }), null, 'both halves are needed');
  assert.equal(vapidKeys({ ...env, EGC_VAPID_PUBLIC_KEY: env.EGC_VAPID_PUBLIC_KEY.slice(2) }), null, 'a malformed key is refused');
});

test('only https endpoints on the known push services are ever posted to, with well-formed browser keys', async () => {
  const browser = await browserKeys();
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/a', 'https://web.push.apple.com/QGx', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-by3p.notify.windows.com/w/?token=x'])
    assert.ok(pushEndpoint(endpoint), endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/a', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://notfcm.googleapis.com/x', 'https://169.254.169.254/x', '', null, 'x'.repeat(2000)])
    assert.equal(pushEndpoint(endpoint), '', String(endpoint).slice(0, 60));
  assert.ok(pushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: browser.keys }));
  assert.equal(pushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { ...browser.keys, auth: 'AAAA' } }), null);
  assert.equal(pushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { ...browser.keys, p256dh: browser.keys.auth } }), null);
  let posted = 0;
  assert.equal(await sendWebPush(vapidKeys(await vapidEnv()), { endpoint: 'https://evil.example/x', keys: browser.keys }, '{}', { fetcher: async () => { posted++; return new Response(null, { status: 201 }); } }), 0);
  assert.equal(posted, 0);
});

test('the lock screen shows the sender and the room, never the message text or the customer', () => {
  const message = { id: 'message-x-1', sender: 'Crew.Static', senderName: 'Synthetic Static Crew', body: 'Gate code is 4242, customer owes balance', jobId: 'job-1' };
  const team = crewChatAlert(message), room = crewChatAlert(message, { id: 'job-1', date: '2026-10-27', customer: 'Synthetic Customer Name', address: '1 Synthetic Way' });
  assert.deepEqual(team, { title: 'EGC crew chat', body: 'Synthetic Static Crew posted in General crew chat', tag: 'message-x-1', view: 'crew_chat', room: 'team' });
  assert.deepEqual(room, { title: 'EGC crew chat', body: 'Synthetic Static Crew posted in a job room (Tue, Oct 27)', tag: 'message-x-1', view: 'crew_chat', room: 'job:job-1' });
  for (const alert of [team, room]) for (const secret of ['4242', 'owes', 'Synthetic Customer Name', 'Synthetic Way']) assert.ok(!JSON.stringify(alert).includes(secret), secret);
});

// The Hub end to end: vault storage faked in memory, every push service call caught.
async function pushWorld(t, { extra = {}, statuses = {} } = {}) {
  const store = vaultFirestore(t), firestore = globalThis.fetch, pushes = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'fcm.googleapis.com') { pushes.push({ url: url.href, init }); return new Response(null, { status: statuses[url.pathname.split('/').pop()] || 201 }); }
    return firestore(input, init);
  });
  const env = staffEnv({ EGC_CREW_CHAT_PUSH: 'true', HUB_OFFLINE_ENABLED: 'true', ...(await vapidEnv()), ...extra }, { 'Crew.Two': { passwordHash: 'unused-synthetic-crew-two-hash', role: 'crew', displayName: 'Synthetic Second Crew' } });
  const browsers = new Map();
  const subscribe = async (user, tag = user.toLowerCase().replace(/\W/g, '')) => { const browser = await browserKeys(); browsers.set(tag, browser); await saveCrewPushSubscription(env, user, { endpoint: `https://fcm.googleapis.com/fcm/send/${tag}`, keys: browser.keys }); return tag; };
  const post = async (user, collection, id, data, body = {}) => hubPost({ env, request: new Request(`${ORIGIN}/api/employee-hub`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: await cookieFor(env, user) }, body: JSON.stringify({ collection, id, data, ...body }) }) });
  const job = (id, fields) => store.documents.set(`jobs/${id}`, { name: `${ROOT}/jobs/${id}`, fields: encodeFirestoreFields({ type: 'job', ...fields }), updateTime: '2026-10-26T12:00:00.000000Z' });
  const sentTo = () => pushes.map(push => push.url.split('/').pop()).sort();
  const opened = async push => JSON.parse(await decryptAsBrowser(new Uint8Array(push.init.body), browsers.get(push.url.split('/').pop())));
  const subscriptionReads = () => store.requests.filter(request => request.body?.structuredQuery?.from?.[0]?.collectionId === PUSH_COLLECTION || request.url.pathname.includes(`/${PUSH_COLLECTION}/`));
  return { store, env, pushes, subscribe, post, job, sentTo, opened, subscriptionReads };
}

test('a general-room message alerts every current staff member who subscribed, never the sender or a removed account', async t => {
  const world = await pushWorld(t);
  for (const user of ['ZacB', 'TylerG', 'AlexK', 'Crew.Static', 'Crew.Two', 'Former.Crew']) await world.subscribe(user);
  const response = await world.post('Crew.Static', 'teamMessages', 'message-crewstatic-1', { body: 'Truck two is at the dump, back in 20' });
  assert.equal(response.status, 200);
  assert.deepEqual(world.sentTo(), ['alexk', 'crewtwo', 'tylerg', 'zacb'], 'not the sender; not an account that is no longer staff');
  const alert = await world.opened(world.pushes[0]);
  assert.deepEqual(alert, { title: 'EGC crew chat', body: 'Synthetic Static Crew posted in General crew chat', tag: 'message-crewstatic-1', view: 'crew_chat', room: 'team' });
  for (const push of world.pushes) {
    assert.equal(push.init.method, 'POST');
    assert.equal(push.init.headers['Content-Encoding'], 'aes128gcm');
    assert.match(push.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    assert.ok(!decoder.decode(push.init.body).includes('dump'), 'the body is encrypted and the text is never in it');
  }
});

test('a job-room message alerts that job\'s assigned crew and managers only', async t => {
  const world = await pushWorld(t);
  for (const user of ['ZacB', 'TylerG', 'AlexK', 'Crew.Static', 'Crew.Two']) await world.subscribe(user);
  world.job('job-assigned', { assignedCrew: ['Crew.Static'], date: '2026-10-27', customer: 'Synthetic Customer Name' });
  assert.equal((await world.post('TylerG', 'jobMessages', 'message-tylerg-1', { jobId: 'job-assigned', body: 'Bring the long ladder' })).status, 200);
  assert.deepEqual(world.sentTo(), ['alexk', 'crewstatic', 'zacb'], 'the assigned crew member and the other managers; not Crew.Two, not the sender');
  const alert = await world.opened(world.pushes.find(push => push.url.endsWith('/crewstatic')));
  assert.deepEqual(alert, { title: 'EGC crew chat', body: 'Synthetic Manager posted in a job room (Tue, Oct 27)', tag: 'message-tylerg-1', view: 'crew_chat', room: 'job:job-assigned' });
});

test('a subscription the push service says is gone (404, 410) is deleted; one that failed otherwise is kept', async t => {
  const world = await pushWorld(t, { statuses: { tylerg: 410, alexk: 404, crewtwo: 500 } });
  for (const user of ['ZacB', 'TylerG', 'AlexK', 'Crew.Two']) await world.subscribe(user);
  assert.equal((await world.post('Crew.Static', 'teamMessages', 'message-crewstatic-2', { body: 'Lunch' })).status, 200, 'a failed alert never fails the message');
  assert.deepEqual((await listCrewPushSubscriptions(world.env)).map(row => row.user).sort(), ['Crew.Two', 'ZacB']);
});

test('a queued message replayed after it was saved alerts nobody a second time; an edit of an old message alerts nobody', async t => {
  const world = await pushWorld(t);
  await world.subscribe('ZacB');
  const requestId = '7d1c6a52-1d2b-4c1e-9f0a-1234567890ab';
  assert.equal((await world.post('Crew.Static', 'teamMessages', 'message-crewstatic-3', { body: 'On site' }, { requestId })).status, 200);
  assert.equal(world.pushes.length, 1);
  assert.equal((await world.post('Crew.Static', 'teamMessages', 'message-crewstatic-3', { body: 'On site' }, { requestId })).status, 200);
  assert.equal(world.pushes.length, 1, 'the replay sends nothing');
  assert.equal((await world.post('TylerG', 'teamMessages', 'message-crewstatic-3', { status: 'archived' })).status, 200);
  assert.equal(world.pushes.length, 1, 'a manager archiving a message sends nothing');
});

test('switched off, or without the installable Hub or a key, a message reads no subscription and posts nothing', async t => {
  for (const extra of [{ EGC_CREW_CHAT_PUSH: 'false' }, { EGC_CREW_CHAT_PUSH: 'TRUE' }, { HUB_OFFLINE_ENABLED: '' }, { EGC_VAPID_PRIVATE_KEY: '' }]) {
    await t.test(JSON.stringify(extra), async t => {
      const world = await pushWorld(t, { extra });
      assert.equal(crewChatPushEnabled(world.env), false);
      const before = world.subscriptionReads().length;
      assert.equal((await world.post('Crew.Static', 'teamMessages', 'message-off-1', { body: 'Hello' })).status, 200);
      assert.deepEqual([world.pushes.length, world.subscriptionReads().length], [0, before]);
    });
  }
});

test('READ-BUDGET: the Hub\'s polls (chat every 15 s, full every minute) never read push subscriptions', async t => {
  const world = await pushWorld(t);
  await world.subscribe('ZacB');
  const reads = world.subscriptionReads().length;
  for (const query of ['?view=messages', '']) {
    const response = await hubGet({ env: world.env, request: new Request(`${ORIGIN}/api/employee-hub${query}`, { headers: { Cookie: await cookieFor(world.env, 'Crew.Static') } }) });
    assert.equal(response.status, 200, query);
  }
  assert.equal(world.subscriptionReads().length, reads);
});

test('/api/hub-push: the switch and public key, and a person saves and removes only their own device', async t => {
  const world = await pushWorld(t), api = hubPushHandlers({ now: () => new Date('2026-10-26T15:00:00Z') });
  const call = async (method, body, user, headers = {}) => api[method.toLowerCase()]({ env: world.env, request: new Request(`${ORIGIN}/api/hub-push`, { method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(user ? { Cookie: await cookieFor(world.env, user) } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }) });
  assert.deepEqual(await (await api.get({ env: world.env })).json(), { ok: true, enabled: true, publicKey: world.env.EGC_VAPID_PUBLIC_KEY });
  assert.deepEqual(await (await api.get({ env: { ...world.env, HUB_OFFLINE_ENABLED: 'false' } })).json(), { ok: true, enabled: false });
  const browser = await browserKeys(), subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/shared-phone', keys: browser.keys };
  assert.equal((await call('POST', { subscription })).status, 401, 'signed in only');
  assert.equal((await call('POST', { subscription }, 'Crew.Static', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await api.post({ env: { ...world.env, EGC_CREW_CHAT_PUSH: '' }, request: new Request(`${ORIGIN}/api/hub-push`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: await cookieFor(world.env, 'Crew.Static') }, body: JSON.stringify({ subscription }) }) })).status, 404);
  assert.equal((await call('POST', { subscription: { ...subscription, endpoint: 'https://evil.example/x' } }, 'Crew.Static')).status, 400);
  assert.equal((await call('POST', { subscription }, 'Crew.Static')).status, 200);
  assert.deepEqual((await listCrewPushSubscriptions(world.env)).map(row => [row.user, row.updatedAt]), [['Crew.Static', '2026-10-26T15:00:00.000Z']]);
  // The same phone, signed in as someone else, now alerts for them only.
  assert.equal((await call('POST', { subscription }, 'Crew.Two')).status, 200);
  assert.deepEqual((await listCrewPushSubscriptions(world.env)).map(row => row.user), ['Crew.Two']);
  assert.deepEqual(await (await call('DELETE', { endpoint: subscription.endpoint }, 'Crew.Static')).json(), { ok: true, removed: false }, 'not theirs to remove');
  assert.equal((await listCrewPushSubscriptions(world.env)).length, 1);
  assert.deepEqual(await (await call('DELETE', { endpoint: subscription.endpoint }, 'Crew.Two')).json(), { ok: true, removed: true });
  assert.equal((await listCrewPushSubscriptions(world.env)).length, 0);
});

test('subscriptions are sealed: the stored document holds no endpoint, key or username in the clear', async t => {
  const world = await pushWorld(t);
  await world.subscribe('Crew.Static', 'sealed-check');
  const stored = [...world.store.documents].filter(([key]) => key.startsWith(`${PUSH_COLLECTION}/`));
  assert.equal(stored.length, 1);
  const raw = JSON.stringify(stored);
  for (const clear of ['sealed-check', 'fcm.googleapis', 'Crew.Static']) assert.ok(!raw.includes(clear), clear);
  assert.ok(!readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8').includes(PUSH_COLLECTION), 'no browser rule opens it: the catch-all denies it');
});

// employee-crew-push.js in a browser realm.
function page({ agent = 'Mozilla/5.0 (Linux; Android 14) Chrome/130', standalone = false, config = { ok: true, enabled: true, publicKey: 'BA' + 'A'.repeat(85) }, permission = 'granted', existing = null } = {}) {
  const values = new Map([['egc_u', 'Crew.Static'], ['egc_browser_alerts', 'on']]), storage = { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const calls = { fetches: [], subscribed: [], unsubscribed: 0 }, listeners = {};
  const subscription = endpoint => ({ endpoint, options: { applicationServerKey: base64UrlDecode(config.publicKey).buffer }, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { calls.unsubscribed++; state.current = null; return true; } });
  const state = { current: existing ? { ...subscription(existing.endpoint), options: { applicationServerKey: base64UrlDecode(existing.key).buffer } } : null };
  const pushManager = { getSubscription: async () => state.current, subscribe: async options => { calls.subscribed.push(base64UrlEncode(options.applicationServerKey)); state.current = subscription(`https://fcm.googleapis.com/fcm/send/new-${calls.subscribed.length}`); return state.current; } };
  const registration = { pushManager };
  const context = {
    console, Promise, Uint8Array, JSON, Date, Number, String, Boolean, atob, btoa,
    localStorage: storage, sessionStorage: storage, setTimeout: callback => { callback(); return 1; },
    navigator: { userAgent: agent, platform: /iPhone/.test(agent) ? 'iPhone' : 'Linux', maxTouchPoints: 5, standalone, serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration } },
    Notification: { permission }, PushManager: function PushManager() {},
    matchMedia: () => ({ matches: standalone }),
    document: { getElementById: () => null },
    addEventListener: (type, listener) => (listeners[type] ||= []).push(listener),
    fetch: async (url, init = {}) => { calls.fetches.push([init.method || 'GET', url, init.body ? JSON.parse(init.body) : null]); return { ok: true, json: async () => (init.method ? { ok: true } : config) }; },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../employee-crew-push.js', import.meta.url), 'utf8'), context);
  return { push: context.EGCCrewPush, calls, values, state, fire: type => (listeners[type] || []).forEach(listener => listener()) };
}

test('Enable browser alerts subscribes this phone with the server key and saves it once; the page check does not save again', async () => {
  const hub = page();
  assert.equal(await hub.push.enable(), 'on');
  assert.deepEqual(hub.calls.subscribed, ['BA' + 'A'.repeat(85)]);
  assert.deepEqual(hub.calls.fetches.map(([method, url, body]) => [method, url, body?.subscription?.endpoint]), [['GET', '/api/hub-push', undefined], ['POST', '/api/hub-push', 'https://fcm.googleapis.com/fcm/send/new-1']]);
  assert.equal(await hub.push.enable({ quiet: true }), 'on');
  assert.equal(hub.calls.fetches.length, 2, 'the same person and phone, saved this week: nothing written');
  hub.values.set('egc_u', 'Crew.Two');
  assert.equal(await hub.push.enable({ quiet: true }), 'on');
  assert.equal(hub.calls.fetches.at(-1)[0], 'POST', 'another person signed in on this phone: saved for them');
});

test('a phone subscribed under an older key pair subscribes again under the new one', async () => {
  const hub = page({ existing: { endpoint: 'https://fcm.googleapis.com/fcm/send/old', key: 'BB' + 'B'.repeat(85) } });
  assert.equal(await hub.push.enable(), 'on');
  assert.deepEqual([hub.calls.unsubscribed, hub.calls.subscribed.length, hub.calls.fetches.at(-1)[2].subscription.endpoint], [1, 1, 'https://fcm.googleapis.com/fcm/send/new-1']);
});

test('switched off, nothing subscribes; an iPhone in Safari is told to add the Hub to its home screen', async () => {
  const off = page({ config: { ok: true, enabled: false } });
  assert.equal(await off.push.enable(), 'off');
  assert.equal(off.calls.subscribed.length, 0);
  assert.equal(off.push.needsInstall(), false, 'no iPhone note while the switch is off');
  const safari = page({ agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1' });
  assert.equal(await safari.push.enable(), 'install');
  assert.equal(safari.push.needsInstall(), true);
  assert.match(safari.push.installCopy, /Share, then Add to Home Screen/);
  assert.equal(safari.calls.subscribed.length, 0);
  const homeScreen = page({ agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148', standalone: true });
  assert.equal(await homeScreen.push.enable(), 'on', 'the home-screen Hub on an iPhone subscribes');
  assert.equal((await page({ permission: 'default' }).push.enable()), 'unsupported', 'never without the person allowing alerts');
});

test('turning alerts off or signing out removes this phone on the server and unsubscribes it', async () => {
  const hub = page();
  await hub.push.enable();
  await hub.push.disable();
  assert.deepEqual(hub.calls.fetches.at(-1).slice(0, 3), ['DELETE', '/api/hub-push', { endpoint: 'https://fcm.googleapis.com/fcm/send/new-1' }]);
  assert.deepEqual([hub.calls.unsubscribed, hub.state.current, hub.values.has('egc_crew_push')], [1, null, false]);
  await hub.push.enable();
  hub.fire('egc:signout');
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  assert.equal(hub.calls.unsubscribed, 2, 'sign-out unsubscribes too');
});

test('on Cloudflare the alerts run after the reply, through the request context\'s waitUntil', async t => {
  const world = await pushWorld(t), waited = [];
  await world.subscribe('ZacB');
  const context = { env: world.env, waitUntil(promise) { assert.equal(this, context, 'called on the context'); waited.push(promise); }, request: new Request(`${ORIGIN}/api/employee-hub`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: await cookieFor(world.env, 'Crew.Static') }, body: JSON.stringify({ collection: 'teamMessages', id: 'message-crewstatic-9', data: { body: 'Done for the day' } }) }) };
  assert.equal((await hubPost(context)).status, 200);
  assert.equal(waited.length, 1);
  assert.deepEqual(await waited[0], { sent: 1, gone: 0, failed: 0 });
  assert.deepEqual(world.sentTo(), ['zacb']);
});
