import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage } from './helpers/hub-dom.mjs';
import { crewSchedule } from '../functions/_lib/crew-schedule.js';
import { STAFF_GATED_PATHS, staffGatedPath, safeStaffNext } from '../staff-paths.js';

// CREW-SCHEDULE (WP6): crew/schedule.html and crew/schedule.js run in a small DOM with the real script. The answers come
// from the real server projection (functions/_lib/crew-schedule.js), so the page and the API share one contract.
// Synthetic people and customers only; Friday 2026-10-16 09:00 Mountain Time.
const NOW = Date.parse('2026-10-16T15:00:00.000Z');
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('crew/schedule.js'), html = read('crew/schedule.html');
const CREWS = [
  { id: 'crew_one', recordType: 'crew', name: 'Crew 1', priority: 1, memberIds: ['ana.lead', 'ben.crew'], leadId: 'ana.lead', status: 'active' },
  { id: 'crew_two', recordType: 'crew', name: 'Crew 2', priority: 2, memberIds: ['cara.crew'], leadId: 'cara.crew', status: 'active' },
];
const job = (id, changes) => ({ id, type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: 'Synthetic Person', address: '1 Fixture Way, Fort Collins, CO 80525', serviceType: 'Garage cleanout', date: '2026-10-16', endDate: '2026-10-16', time: '09:30', endTime: '12:00', crewNeeded: 1, total: 990, ...changes });
const JOBS = [
  job('job_ben', { crewId: 'crew_one', assignedCrew: ['ben.crew'], crewLead: 'ben.crew', customer: 'Alma <img src=x onerror=alert(1)> Synthetic' }),
  job('job_ana', { crewId: 'crew_one', assignedCrew: ['ana.lead'], crewLead: 'ana.lead', customer: 'Bea Synthetic', time: '13:00', endTime: '15:00', status: 'in_progress', pipelineStatus: 'in_progress' }),
  job('job_cara', { crewId: 'crew_two', assignedCrew: ['cara.crew'], crewLead: 'cara.crew', customer: 'Cy Synthetic', address: '2 Sample Ct, Loveland, CO 80537' }),
  job('job_open', { assignedCrew: [], customer: 'Dot Synthetic', time: '10:00', endTime: '11:00', crewNeeded: 2 }),
  job('job_week', { crewId: 'crew_one', assignedCrew: ['ben.crew'], customer: 'Eve Synthetic', date: '2026-10-20', endDate: '2026-10-21', time: '09:30', endTime: '15:00' }),
  // KNOCK-BRIDGE: a walkthrough a door-to-door rep set, booked with the estimator Bea.
  job('walk_bea', { type: 'walkthrough', assignedCrew: ['est.bea'], customer: 'Fay Synthetic', serviceType: '', time: '10:00', endTime: '11:00' }),
];
const SESSIONS = { ben: { user: 'ben.crew', role: 'crew' }, eli: { user: 'eli.team', role: 'crew', staffRoles: ['team_lead'] }, bea: { user: 'est.bea', role: 'sales' } };
// No role flag: a team lead reads every crew on the role alone (schedule.view).
async function answer(who, url) {
  const params = new URL(url, 'https://easygaragecleaning.com').searchParams, scope = params.get('scope'), session = SESSIONS[who];
  const canViewAll = who === 'eli';
  if (scope === 'all' && !canViewAll) return Response.json({ ok: false, code: 'crew_schedule_forbidden', error: 'Every crew’s schedule needs the Team lead or Manager role. Ask the owner.' }, { status: 403 });
  const body = await crewSchedule({ session, env: {}, crews: CREWS, jobs: JOBS, from: params.get('from'), to: params.get('to'), scope, now: new Date(NOW),
    access: { assigned: async row => (row.assignedCrew || []).includes(session.user), exactly: id => id === session.user }, names: { 'ana.lead': 'Ana Synthetic', 'ben.crew': 'Ben Synthetic', 'cara.crew': 'Cara Synthetic' } });
  return Response.json(body);
}

async function page({ respond, hint = null, online = true, prefs = {} } = {}) {
  const document = createDocument(), main = document.createElement('main'), calls = [], local = storage(prefs);
  main.id = 'schedule-main'; document.body.append(main);
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const context = vm.createContext({ document, console, URL, URLSearchParams, Intl, Date: FixedDate, Promise, JSON, Math, Number, String, Array, Object, Set, Map, Error, Boolean, encodeURIComponent, AbortController, setTimeout, clearTimeout,
    navigator: { onLine: online }, localStorage: local, addEventListener() {},
    fetch: async (url, init) => { calls.push(url); assert.equal(init.credentials, 'same-origin'); return respond(url); } });
  context.window = context;
  if (hint) context.EGCHubAuth = { profile: () => hint };
  vm.runInContext(source, context);
  const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  return { document, main, calls, local, settle, context };
}
// Each text node is a separate word group, as a browser lays the row's blocks out.
const leaves = node => node.nodeType === 3 ? [node.data] : node.childNodes.flatMap(leaves);
const text = node => leaves(node).map(part => part.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').replace(/ →$/, '');

test('a crew member sees today for their crew: their own jobs open the job page, a crewmate’s is shown but locked', async () => {
  const { main, calls } = await page({ respond: url => answer('ben', url) });
  assert.deepEqual(calls, ['/api/crew-schedule?from=2026-10-16&to=2026-10-16&scope=mine']);
  assert.equal(text(main.querySelector('h1')), 'My crew’s schedule');
  const rows = main.querySelectorAll('.job-row');
  assert.deepEqual(rows.map(row => [row.tagName, row.getAttribute('data-job')]), [['A', 'job_ben'], ['DIV', 'job_ana']]);
  assert.equal(rows[0].getAttribute('href'), '/crew/job.html?jobId=job_ben');
  assert.match(text(rows[0]), /^9:30 AM–12:00 PM Alma · Fort Collins Garage cleanout · Crew 1 · Lead: Ben Synthetic You’re on this job/);
  assert.match(text(rows[1]), /1:00 PM–3:00 PM Bea · Fort Collins .*In progress Not on your assignment/);
  assert.equal(main.querySelectorAll('img').length, 0, 'customer text is never markup');
  assert.equal(main.querySelectorAll('.chips').length, 0, 'one crew: no crew switcher');
  assert.ok(!text(main).includes('990'), 'no money');
  assert.equal(main.querySelector('[data-range="today"]').getAttribute('aria-pressed'), 'true');
});

test('an estimator sees the walkthrough booked with them; it opens the walkthrough page, not the job page', async () => {
  const { main } = await page({ respond: url => answer('bea', url) });
  const rows = main.querySelectorAll('.job-row');
  assert.deepEqual(rows.map(row => [row.tagName, row.getAttribute('data-job')]), [['A', 'walk_bea']]);
  assert.equal(rows[0].getAttribute('href'), '/crew/gameplan?walkthroughId=walk_bea');
  assert.match(text(rows[0]), /^10:00 AM–11:00 AM Fay · Fort Collins Walkthrough You’re on this job/);
  const ben = await page({ respond: url => answer('ben', url) });
  assert.ok(!ben.main.querySelectorAll('.job-row').some(row => row.getAttribute('data-job') === 'walk_bea'), 'nobody else sees it');
});

test('This week reads seven days from today, shows each day, and is remembered on this phone', async () => {
  const view = await page({ respond: url => answer('ben', url) });
  view.main.querySelector('[data-range="week"]').click();
  await view.settle();
  assert.equal(view.calls.at(-1), '/api/crew-schedule?from=2026-10-16&to=2026-10-22&scope=mine');
  const days = view.main.querySelectorAll('.day');
  assert.deepEqual(days.map(day => day.getAttribute('data-day')), ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
  assert.match(text(days[0].querySelector('h2')), /Friday, Oct 16 Today/);
  assert.equal(text(days[1]), 'Saturday, Oct 17 No crew jobs.');
  assert.match(text(days[4]), /9:30 AM Eve · Fort Collins .*Multi-day · through Wed, Oct 21/);
  assert.match(text(days[5]), /Until 3:00 PM Eve · Fort Collins .*Continues · through Wed/);
  assert.deepEqual(JSON.parse(view.local.getItem('egc.crew-schedule.v1')), { range: 'week', crew: 'all' });
  const again = await page({ respond: url => answer('ben', url), prefs: { 'egc.crew-schedule.v1': JSON.stringify({ range: 'week', crew: 'all' }) } });
  assert.equal(again.calls[0], '/api/crew-schedule?from=2026-10-16&to=2026-10-22&scope=mine');
});

test('a team lead reads every crew, switches between crews, and sees the work no crew has yet', async () => {
  const view = await page({ respond: url => answer('eli', url), hint: { user: 'eli.team', capabilities: ['schedule.view'] } });
  assert.deepEqual(view.calls, ['/api/crew-schedule?from=2026-10-16&to=2026-10-16&scope=all']);
  assert.equal(text(view.main.querySelector('h1')), 'Every crew');
  const chips = () => view.main.querySelectorAll('.chips button');
  assert.deepEqual(chips().map(button => [button.getAttribute('data-crew'), text(button)]), [['all', 'All crews'], ['crew_one', 'Crew 1'], ['crew_two', 'Crew 2'], ['none', 'Not on a crew']]);
  assert.deepEqual(view.main.querySelectorAll('.crew-block h3').map(text), ['Crew 1 · Lead: Ana Synthetic', 'Crew 2 · Lead: Cara Synthetic', 'Not on a crew'], 'every crew by priority, then the work on no crew');
  assert.match(text(view.main.querySelector('[data-job="job_open"]')), /Dot · Fort Collins Garage cleanout · No crew yet Needs crew/);
  assert.equal(view.main.querySelectorAll('a.job-row').length, 0, 'the team lead is on none of these jobs, so none opens');
  view.main.querySelector('[data-crew="crew_two"]').click();
  await view.settle();
  assert.deepEqual(view.main.querySelectorAll('.job-row').map(row => row.getAttribute('data-job')), ['job_cara']);
  assert.equal(view.calls.length, 1, 'switching crews reads nothing more');
  assert.equal(chips().find(button => button.getAttribute('aria-pressed') === 'true').getAttribute('data-crew'), 'crew_two');
});

test('a stale hint falls back to the person’s own crews; 401 asks to sign in; offline and outages say so', async () => {
  const stale = await page({ respond: url => answer('ben', url), hint: { user: 'ben.crew', capabilities: ['schedule.view'] } });
  assert.deepEqual(stale.calls, ['/api/crew-schedule?from=2026-10-16&to=2026-10-16&scope=all', '/api/crew-schedule?from=2026-10-16&to=2026-10-16&scope=mine']);
  assert.equal(text(stale.main.querySelector('h1')), 'My crew’s schedule');
  const promoted = await page({ respond: url => answer('eli', url) });
  assert.deepEqual(promoted.calls.map(url => new URL(url, 'https://x.invalid').searchParams.get('scope')), ['mine', 'all'], 'a viewer the server says reads every crew gets every crew');
  const signedOut = await page({ respond: () => Response.json({ ok: false, code: 'crew_schedule_sign_in_required', error: 'Sign in to see your crew schedule.' }, { status: 401 }) });
  assert.equal(signedOut.main.querySelector('a.btn').getAttribute('href'), '/crew/?next=%2Fcrew%2Fschedule');
  assert.equal(safeStaffNext('/crew/schedule'), '/crew/schedule', 'the sign-in page returns to the schedule');
  const offline = await page({ respond: () => { throw new Error('no network'); }, online: false });
  assert.deepEqual(offline.calls, []);
  assert.match(text(offline.main), /You’re offline\. The crew schedule loads when you reconnect\./);
  const down = await page({ respond: () => Response.json({ ok: false, code: 'crew_schedule_storage_unavailable', error: 'The crew schedule could not be loaded. Retry when connected.' }, { status: 503 }) });
  assert.match(text(down.main.querySelector('.notice')), /The crew schedule could not be loaded\. Retry when connected\. Try again/);
  const broken = await page({ respond: () => Response.json({ ok: true, scope: 'mine', groups: 'nope' }) });
  assert.match(text(broken.main.querySelector('.notice')), /incomplete/);
});

test('with no role flag the Hub lists no schedule.view, so a team lead’s first open asks twice and later opens once', async () => {
  // /api/hub-auth lists schedule.view only with EGC_STAFF_ROLE_ACCESS on; the server still answers canViewAll.
  const first = await page({ respond: url => answer('eli', url), hint: { user: 'eli.team', capabilities: [] } });
  assert.deepEqual(first.calls.map(url => new URL(url, 'https://x.invalid').searchParams.get('scope')), ['mine', 'all']);
  assert.equal(text(first.main.querySelector('h1')), 'Every crew');
  const saved = first.local.getItem('egc.crew-schedule.v1');
  assert.deepEqual(JSON.parse(saved), { range: 'today', crew: 'all', viewsAll: 'eli.team' }, 'this browser remembers who read every crew, and nothing of the schedule');
  const later = await page({ respond: url => answer('eli', url), hint: { user: 'Eli.Team', capabilities: [] }, prefs: { 'egc.crew-schedule.v1': saved } });
  assert.deepEqual(later.calls.map(url => new URL(url, 'https://x.invalid').searchParams.get('scope')), ['all'], 'one read');
  const someoneElse = await page({ respond: url => answer('ben', url), hint: { user: 'ben.crew', capabilities: [] }, prefs: { 'egc.crew-schedule.v1': saved } });
  assert.deepEqual(someoneElse.calls.map(url => new URL(url, 'https://x.invalid').searchParams.get('scope')), ['mine'], 'another person on the same phone asks for their own crews');
  assert.equal(JSON.parse(someoneElse.local.getItem('egc.crew-schedule.v1')).viewsAll, undefined, 'and the remembered hint is dropped');
});

test('EGC_CREW_SCHEDULE=false: the page says the schedule is off, with nothing to retry', async () => {
  const off = await page({ respond: () => Response.json({ ok: false, code: 'crew_schedule_disabled', error: 'The crew schedule is turned off. Ask your manager for this week’s schedule.' }, { status: 404 }) });
  assert.equal(off.calls.length, 1);
  assert.match(text(off.main), /Schedule is off The crew schedule is turned off\. Ask your manager for this week’s schedule\. Back to crew home/);
  assert.equal(off.main.querySelector('a.btn').getAttribute('href'), '/crew/');
  assert.equal(off.main.querySelectorAll('button').length, 0, 'no Try again, Refresh or range buttons');
});

test('the page is a gated staff page that loads its own versioned script and the crew look', () => {
  assert.ok(STAFF_GATED_PATHS.includes('/crew/schedule*'));
  for (const path of ['/crew/schedule', '/crew/schedule.html', '/crew/schedule.js']) assert.equal(staffGatedPath(path), true, path);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<link rel="stylesheet" href="\/crew\/crew-brand\.css\?v=[^"]+">/);
  assert.match(html, /<script src="\/crew\/hub-auth\.js\?v=[^"]+" defer><\/script>\n<script src="\/crew\/schedule\.js\?v=20261017knockbridge2" defer><\/script>/);
  assert.match(html, /<main id="schedule-main">/);
  assert.match(html, /\.job-row\{[^}]*min-height:64px/);
  assert.match(html, /:is\(\.seg,\.chips\) button:focus-visible/);
  assert.doesNotMatch(source, /innerHTML/, 'the schedule page builds nodes; customer text is never parsed as markup');
  assert.doesNotMatch(source, /sessionStorage|indexedDB/, 'no schedule data is kept on the phone');
  const home = read('crew/index.html');
  assert.match(home, /<a class="tool hot" id="schedule-tool" href="\/crew\/schedule">/, 'the crew home links the schedule');
});
