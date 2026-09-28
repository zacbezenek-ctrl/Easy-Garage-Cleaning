import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as quo from '../functions/api/quo-send.js';

const NOW = '2026-09-22T12:00:00.000Z';
const origin = 'https://easygaragecleaning.com';
const users = {
  ZacB: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Owner', role: 'owner' },
  'Crew.One': { passwordHash: 'synthetic-hash', displayName: 'Synthetic Crew One', role: 'crew' },
  'Crew.Two': { passwordHash: 'synthetic-hash', displayName: 'Synthetic Crew Two', role: 'crew' },
  Outsider: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Outsider', role: 'crew' },
};
const env = {
  HUB_SESSION_SECRET: 'synthetic-quo-session-secret', HUB_AUTH_USERS_JSON: JSON.stringify(users),
  FIREBASE_API_KEY: 'firebase-test-quo-send', QUO_API_KEY: 'synthetic-quo-key',
};
const cookies = new Map(await Promise.all(Object.keys(users).map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const handler = quoSendHandlers => quoSendHandlers({ now: () => new Date(NOW) }).post;
const send = handler(quo.quoSendHandlers);
const JOB = { type: 'job', customer: 'Dana Synthetic', phone: '(970) 555-0100', address: '746 Synthetic Grass Ln', total: 450, assignedCrew: ['Crew.One', 'Crew.Two'] };
const ARRIVAL = 'Hi Dana — the Easy Garage Cleaning crew is on the way to 746 Synthetic Grass Ln. We\'ll see you shortly. Reply here if anything changed.';
const CONFIRMATION = rate => `Hi Dana, it's Easy Garage Cleaning — confirming your garage comeback tomorrow at [TIME]. Crew of [N], we'll knock when we arrive. Flat rate locked at $${rate} like we agreed — nothing changes. Reply C to confirm. — Alex`;
const KEY = 'arrival-text:job-1:2026-09-22T12:00';

function request(user, body, { key = KEY, headers = {} } = {}) {
  return new Request(`${origin}/api/quo-send`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookies.get(user) || '', 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const payload = (message = ARRIVAL, extra = {}) => ({ job_id: 'job-1', to: '9705550100', message, idempotency_key: KEY, ...extra });

// Firestore REST emulation with create-only and updateTime preconditions, plus
// a Quo stub that records every provider request.
function fixture(t, job = JOB, others = {}) {
  const docs = new Map(), state = { quo: [], quoReplies: [], reads: [], unavailable: new Set(), docs };
  let revision = 0;
  const document = (path, data) => {
    const saved = { name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(data), updateTime: `2026-09-22T12:00:00.${String(++revision).padStart(6, '0')}Z` };
    docs.set(path, saved);
    return saved;
  };
  if (job) document('jobs/job-1', job);
  for (const [id, other] of Object.entries(others)) document(`jobs/${id}`, other);
  state.receipts = () => [...docs].filter(([path]) => path.startsWith('messageReceipts/')).map(([path, doc]) => ({ path, ...decodeFirestoreFields(doc.fields) }));
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'api.openphone.com') {
      assert.equal(options.headers.Authorization, 'synthetic-quo-key');
      state.quo.push(JSON.parse(options.body));
      const reply = state.quoReplies.shift() || { status: 200, body: { data: { id: `synthetic-message-${state.quo.length}` } } };
      if (reply.error) throw new Error('synthetic network failure');
      return Response.json(reply.body || {}, { status: reply.status });
    }
    assert.equal(url.hostname, 'firestore.googleapis.com', 'no other host may be contacted');
    if (url.pathname.endsWith(':runQuery')) return Response.json([{ readTime: NOW }]);
    const path = decodeURIComponent(url.pathname.split('/documents/')[1]);
    if ([...state.unavailable].some(prefix => path.startsWith(prefix) || path.includes(prefix))) return Response.json({}, { status: 503 });
    const existing = docs.get(path);
    if (method === 'GET') { state.reads.push(path); return existing ? Response.json(existing) : Response.json({}, { status: 404 }); }
    assert.equal(method, 'PATCH');
    if (url.searchParams.get('currentDocument.exists') === 'false' && existing) return Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 });
    const expected = url.searchParams.get('currentDocument.updateTime');
    if (expected && expected !== existing?.updateTime) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
    const incoming = decodeFirestoreFields(JSON.parse(options.body).fields), mask = url.searchParams.getAll('updateMask.fieldPaths');
    const merged = mask.length ? { ...decodeFirestoreFields(existing?.fields || {}), ...Object.fromEntries(mask.map(field => [field, incoming[field]])) } : incoming;
    return Response.json(document(path, merged));
  });
  return state;
}

test('replaying the same Idempotency-Key texts the customer once and returns the saved result', async t => {
  const state = fixture(t);
  const first = await send({ env, request: request('Crew.One', payload()) });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, id: 'synthetic-message-1' });
  const replay = await send({ env, request: request('Crew.One', payload()) });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, id: 'synthetic-message-1', replayed: true });
  assert.equal(state.quo.length, 1, 'exactly one Quo request');
  assert.deepEqual(state.quo[0], { from: '+19709991818', to: ['+19705550100'], content: ARRIVAL });
  const [receipt] = state.receipts();
  assert.match(receipt.path, /^messageReceipts\/quo_[0-9a-f]{64}$/, 'receipts live in a top-level server-only collection, not in jobs');
  assert.equal(receipt.jobId, 'job-1');
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.messageId, 'synthetic-message-1');
  assert.equal(receipt.template, 'arrival');
  assert.equal(receipt.actorId, 'Crew.One');
  assert.equal(receipt.idempotencyKey, KEY);
  assert.equal(receipt.createdAt, NOW);
  assert.equal(receipt.sentAt, NOW);
  assert.equal(receipt.attempts, 1);
  assert.equal(JSON.stringify(receipt).includes('555'), false, 'receipts keep a fingerprint, not the customer phone');
  assert.equal(JSON.stringify(receipt).includes('on the way'), false, 'receipts keep a fingerprint, not the message');
});

test('a second assigned crew member tapping the same scripted text replays instead of texting again', async t => {
  const state = fixture(t);
  assert.equal((await send({ env, request: request('Crew.One', payload()) })).status, 200);
  const other = await send({ env, request: request('Crew.Two', payload()) });
  assert.equal(other.status, 200);
  assert.equal((await other.json()).replayed, true);
  assert.equal(state.quo.length, 1);
});

test('simultaneous double taps claim one receipt and never send twice', async t => {
  const state = fixture(t);
  const responses = await Promise.all([1, 2, 3].map(() => send({ env, request: request('Crew.One', payload()) })));
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.equal(state.quo.length, 1);
  assert.equal(bodies.filter(body => body.ok && !body.replayed).length, 1);
  for (const [index, body] of bodies.entries()) {
    if (body.ok) continue;
    assert.equal(responses[index].status, 409);
    assert.equal(body.code, 'QUO_SEND_OUTCOME_UNKNOWN');
  }
  assert.equal(state.receipts().length, 1);
});

test('the send key is required, may come from the header or body, and must agree', async t => {
  const state = fixture(t);
  const missing = await send({ env, request: request('Crew.One', payload(ARRIVAL, { idempotency_key: undefined }), { key: '' }) });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'QUO_SEND_IDEMPOTENCY_KEY_REQUIRED');
  for (const key of ['short', 'arrival text with spaces', '../../escape', 'x'.repeat(300)]) {
    const invalid = await send({ env, request: request('Crew.One', payload(ARRIVAL, { idempotency_key: key }), { key }) });
    assert.equal(invalid.status, 400, key);
  }
  const mismatch = await send({ env, request: request('Crew.One', payload(ARRIVAL, { idempotency_key: 'arrival-text:job-1:other' })) });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).code, 'QUO_SEND_IDEMPOTENCY_KEY_MISMATCH');
  assert.equal(state.quo.length, 0);
  assert.equal(state.receipts().length, 0);
  assert.equal((await send({ env, request: request('Crew.One', payload(), { key: '' }) })).status, 200, 'body-only key');
  const headerOnly = await send({ env, request: request('Crew.One', payload(ARRIVAL, { idempotency_key: undefined })) });
  assert.equal((await headerOnly.json()).replayed, true, 'the header carries the same key');
  assert.equal(state.quo.length, 1);
});

test('reusing a key for a different text is a conflict and sends nothing new', async t => {
  const state = fixture(t);
  assert.equal((await send({ env, request: request('Crew.One', payload()) })).status, 200);
  const changed = await send({ env, request: request('Crew.One', payload(ARRIVAL.replace('Hi Dana', 'Hi there'))) });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, 'QUO_SEND_IDEMPOTENCY_CONFLICT');
  state.docs.set('jobs/job-1', { ...state.docs.get('jobs/job-1'), fields: encodeFirestoreFields({ ...JOB, phone: '9705550199' }) });
  const newPhone = await send({ env, request: request('Crew.One', payload()) });
  assert.equal(newPhone.status, 409, 'a changed saved phone is a different send');
  assert.equal(state.quo.length, 1);
});

test('a definitive Quo rejection can be retried with the same key; ambiguous outcomes never auto-resend', async t => {
  const state = fixture(t);
  state.quoReplies.push({ status: 429, body: { message: 'PRIVATE-PROVIDER-CANARY' } });
  const rejected = await send({ env, request: request('Crew.One', payload()) });
  assert.equal(rejected.status, 502);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.status, 429);
  assert.equal(JSON.stringify(rejectedBody).includes('PRIVATE-PROVIDER-CANARY'), false);
  assert.equal(state.receipts()[0].status, 'rejected');
  const retried = await send({ env, request: request('Crew.One', payload()) });
  assert.equal(retried.status, 200);
  assert.equal(state.quo.length, 2);
  assert.equal(state.receipts()[0].attempts, 2);
  assert.equal(state.receipts()[0].status, 'sent');

  for (const [index, reply] of [{ status: 503 }, { error: true }].entries()) {
    const key = `arrival-text:job-1:2026-09-22T12:0${index + 1}`;
    state.quoReplies.push(reply);
    const before = state.quo.length;
    const unknown = await send({ env, request: request('Crew.One', payload(ARRIVAL, { idempotency_key: key }), { key }) });
    assert.equal(unknown.status, 502);
    assert.equal((await unknown.json()).code, 'QUO_SEND_OUTCOME_UNKNOWN');
    const again = await send({ env, request: request('Crew.One', payload(ARRIVAL, { idempotency_key: key }), { key }) });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'QUO_SEND_OUTCOME_UNKNOWN');
    assert.equal(state.quo.length, before + 1, 'an uncertain send is not repeated');
  }
});

test('unreadable job or receipt storage fails closed before Quo is contacted', async t => {
  const state = fixture(t);
  state.unavailable.add('messageReceipts/');
  const receipt = await send({ env, request: request('Crew.One', payload()) });
  assert.equal(receipt.status, 503);
  assert.equal((await receipt.json()).code, 'QUO_SEND_STORAGE_UNAVAILABLE');
  state.unavailable.add('jobs/job-1');
  assert.equal((await send({ env, request: request('Crew.One', payload()) })).status, 503);
  assert.equal(state.quo.length, 0);
});

test('crew texts are limited to the pre-job scripts rendered from the saved job; business keeps free-form job texts', async t => {
  const state = fixture(t);
  let n = 0;
  const attempt = async (user, message, extra = {}) => {
    const key = `synthetic-template-${++n}`;
    return send({ env, request: request(user, payload(message, { idempotency_key: key, to: '+15555550000', ...extra }), { key }) });
  };
  const ARRIVAL_SCRIPT = 'Hi [NAME] — the Easy Garage Cleaning crew is on the way to [ADDRESS]. We\'ll see you shortly. Reply here if anything changed.';
  const allowed = [
    [ARRIVAL, ARRIVAL],
    [ARRIVAL.replace('746 Synthetic Grass Ln', 'your garage'), ARRIVAL.replace('746 Synthetic Grass Ln', 'your garage')],
    [ARRIVAL.replace('Hi Dana', 'Hi there'), ARRIVAL.replace('Hi Dana', 'Hi there')],
    [ARRIVAL.replace('Hi Dana', 'Hi Anne-Marie'), ARRIVAL.replace('Hi Dana', 'Hi Anne-Marie')],
    [ARRIVAL.replace('Hi Dana', "Hi O'Brien"), ARRIVAL.replace('Hi Dana', "Hi O'Brien")],
    [ARRIVAL_SCRIPT, ARRIVAL],
    [CONFIRMATION('450'), CONFIRMATION('450')],
    [CONFIRMATION('[RATE]'), CONFIRMATION('450')],
  ];
  for (const [message, sent] of allowed) {
    assert.equal((await attempt('Crew.One', message)).status, 200, message);
    assert.equal(state.quo.at(-1).content, sent, 'the server renders what the customer receives');
  }
  const refused = [
    '',
    'Synthetic free-form message to the customer',
    ARRIVAL + ' Pay at synthetic.example',
    ARRIVAL.replace('746 Synthetic Grass Ln', '1 Other Synthetic Rd'),
    ARRIVAL.replace('Hi Dana', 'Hi synthetic.example'),
    ARRIVAL.replace('Hi Dana', 'Hi bit.ly/abc'),
    ARRIVAL.replace('Hi Dana', 'Hi Call-9705550199'),
    CONFIRMATION('free'),
    CONFIRMATION('450').replace('[TIME]', 'midnight, pay cash'),
  ];
  for (const message of refused) {
    const response = await attempt('Crew.One', message);
    assert.equal(response.status, 400, message);
    assert.equal((await response.json()).code, 'QUO_SEND_TEMPLATE_REQUIRED');
  }
  for (const template of ['custom', 'arrival2', '__proto__']) {
    const response = await attempt('Crew.One', undefined, { template });
    assert.equal(response.status, 400, template);
    assert.equal((await response.json()).code, 'QUO_SEND_TEMPLATE_REQUIRED');
  }
  assert.equal((await attempt('Crew.One', CONFIRMATION('450'), { template: 'arrival' })).status, 400, 'a named script must match the text');
  assert.equal(state.quo.length, allowed.length);
  assert.equal((await attempt('ZacB', 'Synthetic manager update for this job')).status, 200);
  assert.equal((await attempt('ZacB', CONFIRMATION('475'))).status, 200);
  assert.equal(state.quo.at(-1).content, CONFIRMATION('475'), 'managers send the flat rate they typed on the page');
  assert.ok(state.quo.every(body => body.to.length === 1 && body.to[0] === '+19705550100'), 'the saved job phone is always the recipient');
  const managerReceipts = state.receipts().filter(receipt => receipt.actorId === 'ZacB').map(receipt => receipt.template).sort();
  assert.deepEqual(managerReceipts, ['confirmation', 'custom']);
});

test('crew never supply or learn the saved price: every rate guess gets the same reply and sends the saved rate', async t => {
  const state = fixture(t, { ...JOB, total: '', priceQuoted: 612.5 });
  const replies = [];
  let n = 0;
  for (const guess of ['1', '45', '612.5', '612.50', '9999999', '[RATE]']) {
    const key = `synthetic-rate-guess-${++n}`;
    const response = await send({ env, request: request('Crew.One', payload(CONFIRMATION(guess), { idempotency_key: key }), { key }) });
    const body = await response.json();
    replies.push(JSON.stringify([response.status, Object.keys(body).sort(), body.ok, body.code ?? null]));
  }
  assert.equal(new Set(replies).size, 1, 'a right guess and a wrong guess are indistinguishable');
  assert.equal(JSON.parse(replies[0])[0], 200);
  assert.equal(state.quo.length, 6);
  assert.ok(state.quo.every(body => body.content === CONFIRMATION('612.50')), 'the customer always gets the saved rate');
  const replay = await send({ env, request: request('Crew.One', payload(CONFIRMATION('777'), { idempotency_key: 'synthetic-rate-guess-1' }), { key: 'synthetic-rate-guess-1' }) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true, 'another guess under a used key replays the rendered send');
  const key = 'synthetic-template-only';
  const byId = await send({ env, request: request('Crew.One', { job_id: 'job-1', template: 'confirmation', idempotency_key: key }, { key }) });
  assert.equal(byId.status, 200, 'crew may send the script id alone');
  assert.equal(state.quo.at(-1).content, CONFIRMATION('612.50'));
  assert.equal(state.quo.length, 7);
});

test('the confirmation is refused the same way for every guess when the job has no saved rate', async t => {
  const state = fixture(t, { ...JOB, total: '', priceQuoted: null });
  let n = 0;
  for (const body of [payload(CONFIRMATION('450')), payload(CONFIRMATION('[RATE]')), { job_id: 'job-1', template: 'confirmation' }]) {
    const key = `synthetic-no-rate-${++n}`;
    const response = await send({ env, request: request('Crew.One', { ...body, idempotency_key: key }, { key }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'QUO_SEND_RATE_UNAVAILABLE');
  }
  assert.equal(state.quo.length, 0, 'a literal $[RATE] never reaches the customer from crew');
  assert.equal(state.receipts().length, 0);
  assert.equal((await send({ env, request: request('Crew.One', payload()) })).status, 200, 'the arrival script needs no rate');
});

test('a send key is global: reusing it on another job is a conflict and never a second text', async t => {
  const twin = { ...JOB }, other = { ...JOB, customer: 'Casey Synthetic', phone: '(970) 555-0101', address: '9 Synthetic Ct' };
  const state = fixture(t, JOB, { 'job-2': other, 'job-3': twin });
  const shared = 'shared-key-12345';
  const keyed = (user, body) => send({ env, request: request(user, { ...body, idempotency_key: shared }, { key: shared }) });
  assert.equal((await keyed('Crew.One', payload())).status, 200);
  for (const [user, body] of [
    ['Crew.One', payload(ARRIVAL.replace('Dana', 'Casey').replace('746 Synthetic Grass Ln', '9 Synthetic Ct'), { job_id: 'job-2' })],
    ['Crew.One', payload(ARRIVAL, { job_id: 'job-3' })],
    ['ZacB', payload('Synthetic manager note for job 2', { job_id: 'job-2' })],
  ]) {
    const reused = await keyed(user, body);
    assert.equal(reused.status, 409, `${user} ${body.job_id}`);
    assert.equal((await reused.json()).code, 'QUO_SEND_IDEMPOTENCY_CONFLICT');
  }
  assert.equal(state.quo.length, 1);
  assert.equal(state.receipts().length, 1);
  const replay = await keyed('Crew.Two', payload());
  assert.equal((await replay.json()).replayed, true, 'the original job still replays');
});

test('unassigned accounts and unsafe job ids are refused before receipts or Quo', async t => {
  const state = fixture(t);
  assert.equal((await send({ env, request: request('Outsider', payload()) })).status, 403);
  for (const job_id of ['../job-1', 'job\\1', '_egc_schedule_lock_2026-09-22', 'secure_vault', 'x'.repeat(181)]) {
    assert.equal((await send({ env, request: request('ZacB', payload(ARRIVAL, { job_id })) })).status, 400, job_id);
  }
  assert.equal((await send({ env, request: request('Crew.One', 'null') })).status, 400);
  assert.equal(state.quo.length, 0);
  assert.equal(state.receipts().length, 0);
});

test('quo-send grants no cross-origin access and requires same-origin JSON', async t => {
  const state = fixture(t);
  const foreign = await quo.onRequestOptions({ request: new Request(`${origin}/api/quo-send`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }) });
  assert.equal(foreign.status, 403);
  const own = await quo.onRequestOptions({ request: new Request(`${origin}/api/quo-send`, { method: 'OPTIONS', headers: { Origin: origin } }) });
  assert.equal(own.status, 204);
  assert.equal(own.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await send({ env, request: request('Crew.One', payload(), { headers: { 'Sec-Fetch-Site': 'cross-site' } }) })).status, 403);
  // Strict same-origin: formerly allow-listed sibling hosts are now foreign too.
  for (const other of ['https://attacker.example', 'https://www.easygaragecleaning.com', 'https://easy-garage-cleaning.pages.dev', 'http://easygaragecleaning.com', 'null']) {
    const response = await send({ env, request: request('Crew.One', payload(), { headers: { Origin: other } }) });
    assert.equal(response.status, 403, other);
    assert.equal((await response.json()).code, 'QUO_SEND_ORIGIN_FORBIDDEN');
  }
  const refererOnly = new Request(`${origin}/api/quo-send`, { method: 'POST', headers: { Referer: 'https://attacker.example/page', Cookie: cookies.get('Crew.One'), 'Content-Type': 'application/json', 'Idempotency-Key': KEY }, body: JSON.stringify(payload()) });
  assert.equal((await send({ env, request: refererOnly })).status, 403);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
    const response = await send({ env, request: request('Crew.One', payload(), { headers: { 'Content-Type': type } }) });
    assert.equal(response.status, 415, type || 'missing');
    assert.equal((await response.json()).code, 'QUO_SEND_JSON_REQUIRED');
  }
  const huge = await send({ env, request: request('Crew.One', payload(ARRIVAL, { padding: 'é'.repeat(4200) })) });
  assert.equal(huge.status, 413, 'the byte size is capped, not the character count');
  assert.deepEqual(state.reads, [], 'refused requests never reach job or receipt storage');
  assert.equal(state.quo.length, 0);
  const accepted = await send({ env, request: request('Crew.One', payload(), { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } }) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(accepted.headers.get('Cache-Control'), 'no-store');
  const bare = new Request(`${origin}/api/quo-send`, { method: 'POST', headers: { Cookie: cookies.get('Crew.One'), 'Content-Type': 'application/json', 'Idempotency-Key': KEY }, body: JSON.stringify(payload()) });
  assert.equal((await (await send({ env, request: bare })).json()).replayed, true, 'same-origin fetches without Origin still work');
  assert.equal(state.quo.length, 1);
});

// Runs the real crew/prejob.html send code (SECTIONS plus the SMS helpers) in
// a VM against the handler, with a fixed clock and persistent page storage.
function prejobPage(t, user, options = {}) {
  const state = fixture(t, options.job || JOB);
  const html = readFileSync(new URL('../crew/prejob.html', import.meta.url), 'utf8');
  const sectionsStart = html.indexOf('const SECTIONS = [');
  const sections = html.slice(sectionsStart, html.indexOf('\n];', sectionsStart) + 3).replace('const SECTIONS = ', 'globalThis.SECTIONS = ');
  const sms = html.slice(html.indexOf('function custPhoneDigits(){'), html.indexOf('function callOffice(){'));
  const page = { alerts: [], crm: [], clock: NOW, dropResponse: false, stored: new Map(), elements: new Map(), location: {}, values: { j_name: 'Dana Synthetic', j_rate: '450' } };
  const storage = map => ({ getItem: name => map.has(name) ? map.get(name) : null, setItem: (name, value) => map.set(name, String(value)), removeItem: name => map.delete(name) });
  const element = id => {
    if (!page.elements.has(id)) page.elements.set(id, { id, textContent: '' });
    const found = page.elements.get(id);
    if (id in page.values) found.value = page.values[id];
    return found;
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [page.clock])); } static now() { return Date.parse(page.clock); } }
  const context = vm.createContext({
    Date: FixedDate, JSON, String, Error, Array, Math, Uint8Array, console, encodeURIComponent, crypto: globalThis.crypto,
    ACTIVE: { jobId: 'job-1', phone: '9705550100', addr: JOB.address, name: JOB.customer },
    HUBDB: null, state: {}, key: (si, ii) => `${si}_${ii}`, actId: (si, ii) => `act_${si}_${ii}`, saveAll() {}, queueProgressSave() {}, render() {},
    alert: message => page.alerts.push(message), location: page.location,
    sessionStorage: storage(new Map([['egc_u', user]])), localStorage: storage(page.stored),
    document: { getElementById: element },
    EGCHubAuth: {
      async fetch(path, init) {
        if (path === '/api/highlevel') { page.crm.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
        assert.equal(path, '/api/quo-send');
        const response = await send({ env, request: new Request(origin + path, { ...init, headers: { ...init.headers, Origin: origin, Cookie: cookies.get(user) } }) });
        page.sent = (page.sent || 0) + 1;
        if (page.dropResponse) { page.dropResponse = false; throw new TypeError('Synthetic network connection lost'); }
        return response;
      },
    },
  });
  vm.runInContext(sections, context);
  vm.runInContext(sms, context);
  const buttons = [];
  context.SECTIONS.forEach((section, si) => section.items.forEach((item, ii) => { if (item.act?.type === 'sms') buttons.push([si, ii]); }));
  const find = script => buttons.find(([si, ii]) => context.SECTIONS[si].items[ii].act.script === script);
  page.buttons = buttons;
  page.tap = async script => { const [si, ii] = find(script), button = {}; await context.smsCustomer(si, ii, button); return { button, note: element(`act_${si}_${ii}_status`).textContent }; };
  return { state, page };
}

for (const user of ['ZacB', 'Crew.One']) {
  test(`crew/prejob.html (${user}): one key per job and script survives retries across minutes and never double-texts`, async t => {
    const { state, page } = prejobPage(t, user);
    assert.equal(page.buttons.length, 2, 'the playbook has the confirmation and arrival scripts');
    const first = await page.tap('arrival');
    assert.equal(first.note, 'Sent through Quo.');
    const doubleTap = await page.tap('arrival');
    assert.match(doubleTap.note, /^Already sent/);
    page.clock = '2026-09-22T12:07:30.000Z';
    const later = await page.tap('arrival');
    assert.match(later.note, /^Already sent/, 'a retry minutes later reuses the same key');
    assert.equal(state.quo.length, 1);
    assert.equal(state.quo[0].content, ARRIVAL);
    assert.equal(page.crm.length, 3, 'each confirmed success still records the CRM note under its own key');
    assert.equal(new Set(page.crm.map(note => note.idempotency_key)).size, 1);

    const confirmation = await page.tap('confirmation');
    assert.equal(confirmation.note, 'Sent through Quo.', 'the other script has its own key, so it is never a conflict');
    assert.equal(state.quo.length, 2);
    assert.equal(state.quo[1].content, CONFIRMATION('450'));
    const keys = [...page.stored].filter(([name]) => name.startsWith(`egc-quo-send:${user}:job-1:`)).map(([, value]) => JSON.parse(value).key);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 2);
    for (const key of keys) assert.match(key, /^prejob-(arrival|confirmation):job-1:[0-9a-f-]{36}$/);
    assert.deepEqual(state.receipts().map(receipt => receipt.template).sort(), ['arrival', 'confirmation']);
    assert.deepEqual(page.alerts, []);
    assert.equal(page.location.href, undefined);
  });

  test(`crew/prejob.html (${user}): an unknown outcome or dropped connection shows a note instead of the SMS composer`, async t => {
    const { state, page } = prejobPage(t, user);
    state.quoReplies.push({ status: 503 });
    const unknown = await page.tap('arrival');
    assert.match(unknown.note, /may already have been sent\. Check the customer's conversation in Quo before resending/);
    assert.notEqual(unknown.button.textContent, 'Open phone text instead');
    const recheck = await page.tap('arrival');
    assert.match(recheck.note, /may already have been sent/, 'a retry reuses the key and gets the saved 409 outcome');
    assert.equal(state.quo.length, 1, 'an uncertain send is never repeated');

    page.values.j_name = 'Jo Synthetic';
    page.dropResponse = true;
    const dropped = await page.tap('arrival');
    assert.match(dropped.note, /connection dropped, so this text may already have been sent/);
    assert.equal(state.quo.length, 2, 'the server did send before the response was lost');
    const retried = await page.tap('arrival');
    assert.match(retried.note, /^Already sent/, 'the retry replays instead of texting twice');
    assert.equal(state.quo.length, 2);
    assert.deepEqual(page.alerts, [], 'no alert for an outcome that may already have reached the customer');
    assert.equal(page.location.href, undefined, 'the SMS composer never opens automatically');
  });

  test(`crew/prejob.html (${user}): changed job details start a new key; definitive failures still offer the composer`, async t => {
    const { state, page } = prejobPage(t, user);
    page.values.j_name = 'Sam Synthetic';
    page.dropResponse = true;
    await page.tap('arrival');
    assert.equal(state.quo.length, 1);
    const saved = state.docs.get('jobs/job-1');
    state.docs.set('jobs/job-1', { ...saved, fields: encodeFirestoreFields({ ...JOB, phone: '9705550111' }) });
    const conflict = await page.tap('arrival');
    assert.match(conflict.note, /job details changed since the last attempt, so nothing was sent/);
    assert.equal(state.quo.length, 1);
    const resend = await page.tap('arrival');
    assert.equal(resend.note, 'Sent through Quo.', 'the forgotten key is replaced after the conflict');
    assert.deepEqual(state.quo[1].to, ['+19705550111']);
    assert.deepEqual(page.alerts, []);

    page.values.j_name = 'Lee Synthetic';
    state.quoReplies.push({ status: 400, body: { message: 'Synthetic rejection' } });
    const rejected = await page.tap('arrival');
    assert.equal(rejected.button.textContent, 'Open phone text instead');
    assert.equal(page.alerts.length, 1);
    assert.match(page.location.href, /^sms:9705550100&body=Hi%20Lee%20/);
  });
}

test('Quo send receipts stay server-only under the Firestore rules', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/, 'the catch-all deny covers messageReceipts');
  const explicit = /match \/messageReceipts\/\{[^}]+\} \{([^}]*)\}/.exec(rules);
  if (explicit) assert.match(explicit[1], /^\s*allow read, write: if false;\s*$/, 'an explicit block may only deny');
  const wildcards = [...rules.matchAll(/match \/\{\w+=\*\*\} \{([^}]*)\}/g)].map(match => match[1]);
  assert.ok(wildcards.every(body => /^\s*allow read, write: if false;\s*$/.test(body)), 'no recursive wildcard grants browsers access');
});
