import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import * as hook from '../functions/api/crew-hook.js';

const NOW = '2026-09-22T12:00:00.000Z';
const origin = 'https://easygaragecleaning.com';
const env = {
  HUB_SESSION_SECRET: 'synthetic-crew-hook-secret', FIREBASE_API_KEY: 'firebase-test-crew-hook', CREW_WEBHOOK_URL: 'https://hooks.synthetic.invalid/catch',
  HUB_AUTH_USERS_JSON: JSON.stringify({
    ZacB: { passwordHash: 'synthetic', displayName: 'Synthetic Owner', role: 'owner' },
    'Crew.One': { passwordHash: 'synthetic', displayName: 'Synthetic Crew', role: 'crew' },
  }),
};
const cookie = async user => (await createHubSessionCookie(env, user)).split(';')[0];
const post = async (user, body, headers = {}) => hook.onRequestPost({ env, request: new Request(`${origin}/api/crew-hook`, {
  method: 'POST', headers: { Origin: origin, Cookie: user ? await cookie(user) : '', 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}) });

function upstream(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => { calls.push({ url: String(input), body: options.body }); return Response.json({ status: 'success' }); });
  return calls;
}

test('crew-hook stays business-only: crew never reach job storage or the webhook for any tool', async t => {
  const calls = upstream(t);
  for (const tool of ['game_plan', 'review_request', 'post_job', 'plan_text']) {
    const response = await post('Crew.One', { tool, job_id: 'assigned-job', phone: '9705550100', message: 'Synthetic review request' });
    assert.equal(response.status, 403, tool);
  }
  assert.equal((await post(null, { tool: 'post_job' })).status, 401);
  assert.deepEqual(calls, [], 'no Firestore assignment lookups or webhook calls');
});

test('business triggers forward the exact payload once with no wildcard CORS', async t => {
  const calls = upstream(t);
  const body = { tool: 'post_job', job_id: 'job-1', notes: 'Synthetic closeout' };
  const response = await post('ZacB', body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, tool: 'post_job' });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(calls, [{ url: env.CREW_WEBHOOK_URL, body: JSON.stringify(body) }]);
  assert.equal((await post('ZacB', { tool: 'review_request', phone: '12', message: 'Synthetic' })).status, 400);
  assert.equal((await post('ZacB', 'null')).status, 400);
  assert.equal((await post('ZacB', { tool: 'unknown' })).status, 400);
  assert.equal(calls.length, 1);
});

test('crew-hook rejects cross-site requests and grants no foreign preflight', async t => {
  const calls = upstream(t);
  assert.equal((await post('ZacB', { tool: 'post_job' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('ZacB', { tool: 'post_job' }, { Origin: 'https://attacker.example' })).status, 403);
  const foreign = await hook.onRequestOptions({ request: new Request(`${origin}/api/crew-hook`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }) });
  assert.equal(foreign.status, 403);
  const own = await hook.onRequestOptions({ request: new Request(`${origin}/api/crew-hook`, { method: 'OPTIONS', headers: { Origin: origin } }) });
  assert.equal(own.status, 204);
  assert.equal(own.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual(calls, []);
});

test('crew-hook requires the exact request origin and a JSON body before contacting the webhook', async t => {
  const calls = upstream(t);
  // Formerly allow-listed sibling hosts are now foreign: only this origin may post.
  for (const other of ['https://www.easygaragecleaning.com', 'https://easy-garage-cleaning.pages.dev', 'http://localhost:8788', 'http://easygaragecleaning.com']) {
    const response = await post('ZacB', { tool: 'post_job' }, { Origin: other });
    assert.equal(response.status, 403, other);
    assert.equal((await response.json()).code, 'CREW_HOOK_ORIGIN_FORBIDDEN');
  }
  const foreignReferer = await hook.onRequestPost({ env, request: new Request(`${origin}/api/crew-hook`, {
    method: 'POST', headers: { Referer: 'https://attacker.example/form', Cookie: await cookie('ZacB'), 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'post_job' }),
  }) });
  assert.equal(foreignReferer.status, 403);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
    const response = await post('ZacB', { tool: 'post_job' }, { 'Content-Type': type });
    assert.equal(response.status, 415, type || 'missing');
    assert.equal((await response.json()).code, 'CREW_HOOK_JSON_REQUIRED');
  }
  assert.deepEqual(calls, [], 'refused requests never reach the webhook');
  const noOrigin = await hook.onRequestPost({ env, request: new Request(`${origin}/api/crew-hook`, {
    method: 'POST', headers: { Cookie: await cookie('ZacB'), 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ tool: 'post_job', job_id: 'job-1' }),
  }) });
  assert.equal(noOrigin.status, 200, 'same-origin fetches that omit Origin still work');
  assert.equal(calls.length, 1);
});

const crewHome = readFileSync(new URL('../crew/index.html', import.meta.url), 'utf8');

async function renderCrewHome(business, { online = true } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const tool = new RegExp(`<a class="tool" id="${id}" href="([^"]+)" data-business-href="([^"]+)"`).exec(crewHome);
      const attributes = tool ? { href: tool[1] } : {}, classes = new Set();
      elements.set(id, { id, hidden: false, textContent: '', innerHTML: '', className: '', dataset: tool ? { businessHref: tool[2] } : {}, attributes,
        setAttribute(name, value) { attributes[name] = String(value); }, getAttribute: name => attributes[name] ?? null,
        classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) } });
    }
    return elements.get(id);
  };
  const jobs = [
    { id: 'job-1', type: 'job', status: 'scheduled', date: '2026-09-23', time: '09:00', customer: 'Synthetic Scheduled', address: '1 Synthetic Ln', assignedCrew: ['Crew.One'] },
    { id: 'job-2', type: 'job', status: 'in_progress', date: '2026-09-22', time: '08:00', customer: 'Synthetic Active', address: '2 Synthetic Ln', assignedCrew: ['Crew.One'] },
  ];
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } }
  const context = vm.createContext({
    Date: FixedDate, Intl, URLSearchParams, Promise, Set, Number, String, Array, Math, JSON, encodeURIComponent,
    window: {}, location: { search: '' }, navigator: { onLine: online }, addEventListener() {},
    document: { getElementById: element },
    EGCHubAuth: {
      profile: () => ({ user: 'Crew.One', displayName: 'Synthetic Crew', businessAccess: business }),
      canRunBusiness: () => business, mountCrewNav() {},
      async fetch(path) {
        if (path === '/api/crew-jobs') return Response.json({ ok: true, jobs });
        if (path === '/api/employee-hub') return Response.json({ ok: true, collections: { timeEntries: [] } });
        throw new Error(`Unexpected ${path}`);
      },
    },
  });
  const script = crewHome.slice(crewHome.lastIndexOf('<script>') + '<script>'.length, crewHome.lastIndexOf('</script>'));
  vm.runInContext(script, context);
  await context.openCrewHome();
  return element;
}

test('crew home sends employees to the verified job workflow and keeps legacy tools for business users', async () => {
  const crew = await renderCrewHome(false);
  for (const id of ['prejob-tool', 'closeout-tool']) assert.equal(crew(id).getAttribute('href'), '/crew/job.html', id);
  assert.match(crew('assigned-jobs').innerHTML, /href="\/crew\/job\.html\?jobId=job-1"/);
  assert.match(crew('assigned-jobs').innerHTML, /href="\/crew\/job\.html\?jobId=job-2"/);
  assert.match(crew('next-work').innerHTML, /<a class="primary" href="\/crew\/job\.html\?jobId=job-2">Continue closeout<\/a>/);
  assert.doesNotMatch(crew('assigned-jobs').innerHTML + crew('next-work').innerHTML, /prejob|postjob/);
  assert.equal(crew('walkthrough-tool').hidden, true);

  const manager = await renderCrewHome(true);
  assert.equal(manager('prejob-tool').getAttribute('href'), 'prejob.html');
  assert.equal(manager('closeout-tool').getAttribute('href'), 'postjob.html');
  assert.match(manager('assigned-jobs').innerHTML, /href="\/crew\/prejob\?jobId=job-1"/);
  assert.match(manager('next-work').innerHTML, /href="\/crew\/postjob\?jobId=job-2">Continue closeout/);
  assert.equal(manager('walkthrough-tool').hidden, false);
});

test('crew home offline banner describes what actually happens offline', async () => {
  const offline = await renderCrewHome(false, { online: false });
  assert.equal(offline('offline').classList.contains('on'), true);
  const online = await renderCrewHome(false);
  assert.equal(online('offline').classList.contains('on'), false);
  const banner = /<div id="offline"[^>]*>([^<]+)<\/div>/.exec(crewHome)[1];
  assert.doesNotMatch(banner, /sync/i, 'the crew home queues nothing, so it must not promise a sync');
  assert.match(banner, /nothing is saved or sent until you reconnect/);
  assert.doesNotMatch(crewHome, /Your employee tools are Pre-job and Closeout/);
});
