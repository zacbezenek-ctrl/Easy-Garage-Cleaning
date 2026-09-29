process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hubPage, NOW } from './helpers/hub-dom.mjs';
import { timesheetHandlers } from '../functions/api/timesheets.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import { cookieFor, jsonRequest, staffEnv, vaultFirestore } from './helpers/vault-fixture.mjs';

// The timesheet screen of employee-suite.js with the payroll week card, served by the real /api/timesheets handler.
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const PEOPLE = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
const at = (date, time) => `${date}T${time}:00-06:00`;
const card = (id, employee, date, extra = {}) => ({ id, employee, employeeName: `Synthetic ${employee}`, payType: 'hourly', clockInAt: at(date, '08:00'), clockOutAt: at(date, '12:00'), status: 'submitted', approvalStatus: 'approved', breaks: [], hourlyRate: 37.13, updatedAt: '2026-09-19T01:00:00.000Z', ...extra });
const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };

function timesheetScreen({ user = 'TylerG', role = 'manager', timecards, jobs = [] }) {
  const server = { timecards: structuredClone(timecards), reads: 0, exports: 0, holdExport: null };
  const session = { user, role, businessAccess: true, displayName: `Synthetic ${user}` };
  const handlers = timesheetHandlers({ session: async () => session, read: async () => ({ timecards: structuredClone(server.timecards), requests: [] }), now: () => new Date(NOW) });
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('/api/timesheets')) {
      const response = () => handlers.get({ request: new Request('https://easygaragecleaning.com' + url), env: {} });
      if (!url.includes('format=csv')) { server.reads++; return response(); }
      server.exports++;
      return server.holdExport ? new Promise(resolve => { server.release = () => resolve(response()); }) : response();
    }
    if (url === '/api/employee-hub' && init.method === 'POST') {
      const { collection, id, data } = JSON.parse(init.body), row = collection === 'timeEntries' && server.timecards.find(item => item.id === id);
      if (row) Object.assign(row, data, { updatedAt: '2026-09-22T18:00:01.000Z' });
      return json({ ok: true, record: row || data });
    }
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: { ...Object.fromEntries(PEOPLE.map(name => [name, []])), timeEntries: structuredClone(server.timecards) } });
    if (url.startsWith('/api/highlevel?view=command')) return json({ ok: true, pipelines: [], opportunities: [] });
    if (url.startsWith('/api/highlevel?view=walkthroughs')) return json({ ok: true, events: [] });
    if (url.startsWith('/api/integration-status')) return json({ ok: true, status: {} });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  };
  const page = hubPage({ user, role, fetcher });
  page.context.jobsCache = jobs;
  vm.runInContext(readFileSync(new URL('../employee-payroll-week.js', import.meta.url), 'utf8'), page.context, { filename: 'employee-payroll-week.js' });
  return { page, server, card: () => page.document.querySelector('.egc-payroll-week') };
}
async function open(screen) {
  screen.page.api.install();
  await settle();
  screen.page.api.S.timesheetAnchor = '2026-09-15';
  screen.page.api.go('timesheets');
  await settle();
  return screen.card();
}

// Week of Sep 14-20 (over by the hub-dom clock, Sep 22), with one shift still waiting for approval, and a shift open today.
const WEEK = [
  card('crew-mon', 'Crew.One', '2026-09-14'),
  card('crew-tue', 'Crew.One', '2026-09-15', { approvalStatus: 'pending' }),
  card('crew-open', 'Crew.Two', '2026-09-22', { clockOutAt: '', status: 'active', approvalStatus: 'pending', updatedAt: '2026-09-22T17:00:00.000Z' }),
];

test('approving time below the payroll week card rereads the week at once; unchanged data and an open shift\'s pings do not', async () => {
  const screen = timesheetScreen({ timecards: WEEK }), { page, server } = screen;
  const week = await open(screen);
  assert.ok(week, 'the manager sees the payroll week card');
  assert.equal(server.reads, 1);
  assert.match(week.textContent, /Not final: timecards are waiting for approval\./);
  assert.match(week.textContent, /Pay hidden/, 'another employee\'s pay reads "Pay hidden" in the card');
  // Background renders of the same records reuse the loaded week.
  page.api.render();
  await settle();
  assert.equal(server.reads, 1);
  // A location ping on the open shift changes only that shift's updatedAt: no reread.
  server.timecards[2].updatedAt = '2026-09-22T17:59:00.000Z';
  await page.api.loadAll();
  await settle();
  assert.equal(server.reads, 1);
  assert.equal(page.api.S.people.timeEntries.find(item => item.id === 'crew-open').updatedAt, '2026-09-22T17:59:00.000Z', 'the suite did reload its records');
  // Approving the pending shift on the board below: the card rereads the week well within five minutes.
  await page.context.opsApproveTime('crew-tue', 'approved');
  await settle();
  assert.equal(server.reads, 2);
  assert.match(screen.card().textContent, /Every timecard is settled\./);
  assert.doesNotMatch(screen.card().textContent, /waiting for approval/);
});

test('a reread while the owner downloads the payroll CSV does not cancel the download', async () => {
  const settled = WEEK.slice(0, 2).map(item => ({ ...item, approvalStatus: 'approved' }));
  const screen = timesheetScreen({ user: 'ZacB', role: 'owner', timecards: settled }), { page, server } = screen;
  page.context.URL = Object.assign(Object.create(URL), { createObjectURL: () => 'blob:synthetic-payroll', revokeObjectURL() {} });
  const week = await open(screen);
  assert.match(week.textContent, /Every timecard is settled\./);
  const button = () => screen.card().querySelectorAll('button').find(node => /Download payroll CSV|Preparing/.test(node.textContent));
  server.holdExport = true;
  button().click();
  await settle();
  assert.equal(button().textContent, 'Preparing…');
  // Meanwhile a timecard in the suite's records changes and the screen renders: the week is reread.
  server.timecards[0].notes = 'Synthetic edit';
  server.timecards[0].updatedAt = '2026-09-22T17:30:00.000Z';
  await page.api.loadAll();
  await settle();
  assert.equal(server.reads, 2);
  server.release();
  await settle();
  assert.equal(server.exports, 1);
  assert.equal(button().textContent, 'Download payroll CSV', 'the export finished instead of hanging on "Preparing…"');
  assert.match(screen.card().textContent, /Payroll CSV for Sep 14 – Sep 20 downloaded\./);
});

test('the timesheet board labels a timecard with its job\'s service, never its pay type, on screen and in the hours CSV', async () => {
  const jobs = [{ id: 'job-deep', type: 'job', customer: 'Synthetic Customer', serviceType: 'Synthetic deep clean', date: '2026-09-15', status: 'scheduled' }, { id: 'job-plain', type: 'job', customer: 'Synthetic Other', date: '2026-09-16', status: 'scheduled' }];
  const cards = [card('linked', 'Crew.One', '2026-09-15', { jobId: 'job-deep', jobLabel: 'Synthetic Customer', payType: 'salary' }), card('plain', 'Crew.One', '2026-09-16', { jobId: 'job-plain', jobLabel: 'Synthetic Other', payType: 'salary' }), card('general', 'Crew.One', '2026-09-17')];
  const screen = timesheetScreen({ timecards: cards, jobs }), { page } = screen;
  await open(screen);
  const board = page.main().querySelector('.ops-timesheets'), rows = board.querySelectorAll('.ops-time-row b').map(node => node.parentNode.querySelector('span').textContent);
  assert.deepEqual(rows, ['Synthetic deep clean · job-deep', 'Garage service · job-plain', '']);
  assert.doesNotMatch(board.textContent, /salary|hourly/);
  const files = [];
  page.context.Blob = class { constructor(parts) { files.push(parts.join('')); } };
  page.context.URL = Object.assign(Object.create(URL), { createObjectURL: () => 'blob:synthetic-hours', revokeObjectURL() {} });
  page.context.opsDownloadTimesheets();
  const csv = files[0].split('\r\n').map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')));
  assert.deepEqual(csv.map(row => row[3]), ['Service', 'Synthetic deep clean', 'Garage service', '']);
  assert.doesNotMatch(files[0], /salary|hourly/);
});

test('an employee whose pay the server did not send reads "Pay hidden" on the board, never a $0 total', () => {
  // The suite helpers alone: rows whose gross is null are the rows /api/employee-hub sent without pay (PRICE-SCRUB).
  const context = { console, Intl, Date, Promise, Map, Set, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {}, location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, document: { readyState: 'loading', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }, jobsCache: [{ id: 'job-deep', type: 'job', serviceType: 'Synthetic deep clean' }] };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.ui={timesheetPay,timecardService};})();'), context);
  const { timesheetPay, timecardService } = context.ui;
  assert.equal(timesheetPay([{ hours: 4, gross: null }, { hours: 2, gross: null }]), 'Pay hidden');
  assert.equal(timesheetPay([{ hours: 4, gross: 148.52 }, { hours: 2, gross: 20.5 }]), '$169');
  assert.equal(timesheetPay([{ hours: 3, approvalStatus: 'legacy' }]), '$0', 'legacy job-hours rows (no pay tracked) keep their old total');
  assert.deepEqual([timecardService({ jobId: 'job-deep', payType: 'salary' }), timecardService({ jobId: 'job-gone', payType: 'salary' }), timecardService({ payType: 'hourly' })], ['Synthetic deep clean', '', '']);
});

test('the team board\'s profile form sends pay only when the rate was edited, never the pay it showed', async () => {
  // Another employee's profile, as /api/employee-hub shows it to a viewer who sees pay (payVisibility 'all': the owner,
  // or anyone with EGC_STAFF_PAY_OWNER_ONLY=false; before PRICE-SCRUB, every manager).
  const profiles = [{ id: 'crew.static', username: 'Crew.Static', displayName: 'Synthetic Crew', role: 'crew', payType: 'hourly', hourlyRate: 19.37, status: 'active' }], posts = [];
  const fetcher = async (url, init = {}) => {
    if (url === '/api/employee-hub' && init.method === 'POST') { const body = JSON.parse(init.body); posts.push(body); return json({ ok: true, record: body.data }); }
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: { ...Object.fromEntries(PEOPLE.map(name => [name, []])), profiles: structuredClone(profiles) }, payVisibility: 'all' });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  };
  const page = hubPage({ user: 'TylerG', role: 'manager', fetcher });
  page.api.install();
  await settle();
  const edit = async values => {
    const pending = page.context.opsEditProfile('crew.static'), dialog = page.document.querySelector('.ops-action-dialog');
    assert.equal(dialog.querySelector('[name="hourlyRate"]').value, '19.37', 'the form shows the rate');
    for (const [name, value] of Object.entries(values)) dialog.querySelector(`[name="${name}"]`).value = value;
    page.context.opsActionSubmit({ preventDefault() {}, currentTarget: dialog });
    await pending;
    await settle();
    return posts.filter(post => post.id === 'crew.static').at(-1);
  };
  // A name and job title edit: no pay goes to the server.
  const renamed = await edit({ displayName: 'Synthetic Crew Renamed', jobTitle: 'Synthetic lead' });
  assert.deepEqual([renamed.collection, renamed.id, renamed.data.displayName, renamed.data.jobTitle, renamed.data.username], ['profiles', 'crew.static', 'Synthetic Crew Renamed', 'Synthetic lead', 'Crew.Static']);
  assert.deepEqual(['hourlyRate', 'payType', 'bonus', 'tips'].filter(key => Object.hasOwn(renamed.data, key)), []);
  // The shown rate spelled otherwise is still the shown rate.
  assert.equal(Object.hasOwn((await edit({ hourlyRate: '19.370' })).data, 'hourlyRate'), false);
  // An edited rate is sent (the server decides: the owner's save, or 403 pay_owner_only for anyone else with the flag on).
  const raised = await edit({ hourlyRate: '21.5' });
  assert.deepEqual([raised.data.hourlyRate, raised.data.payType], [21.5, 'hourly']);
  assert.equal(posts.filter(post => post.id === 'crew.static').length, 3, 'one save per submitted form');
  assert.deepEqual([...new Set(posts.filter(post => post.id !== 'crew.static').map(post => `${post.collection}/${post.data.username}`))], ['profiles/TylerG'], 'every other save is the manager\'s own profile (ensureOwnProfile)');
});

// The page's /api/employee-hub calls served by the real handler over the encrypted vault, as `cookie` signs in. The real
// handler does its crypto off the main thread, so a fixed number of turns is not enough: every call is tracked, and
// drain() waits until none is running and the page has stopped starting new ones.
function realHub(env, cookie) {
  const posts = [], replies = [], reads = [], inflight = new Set();
  const track = promise => { inflight.add(promise); const done = () => inflight.delete(promise); promise.then(done, done); return promise; };
  const drain = async () => {
    for (let round = 0; round < 50; round++) {
      await settle();
      if (!inflight.size) return;
      await Promise.allSettled([...inflight]);
    }
    throw new Error('the page kept calling /api/employee-hub');
  };
  const fetcher = (url, init = {}) => track((async () => {
    if (url.startsWith('/api/employee-hub') && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      const response = await employeeHub.onRequestPost({ env, request: jsonRequest(url, init.body, cookie) });
      replies.push(response.status);
      return response;
    }
    if (url.startsWith('/api/employee-hub')) {
      const response = await employeeHub.onRequestGet({ env, request: jsonRequest(url, undefined, cookie) });
      reads.push(await response.clone().json());
      return response;
    }
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  })());
  return { posts, replies, reads, drain, fetcher };
}

// Second review: the path the default flag gives a manager (payVisibility 'own'), served by the real /api/employee-hub
// handler and the encrypted vault. The owner stored the crew member's pay; the manager's form has no rate field, says
// who sets pay, and a name or job-title save sends no pay, so the real handler saves it (200) and the stored pay stays.
test('with pay owner-only (payVisibility "own") the team board\'s profile form has no rate field and its save sends no pay, which the real handler accepts', async t => {
  vaultFirestore(t);
  const env = staffEnv();
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG');
  const seeded = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'profiles', id: 'crew.static', data: { username: 'Crew.Static', displayName: 'Synthetic Crew', jobTitle: 'Synthetic crew', role: 'crew', payType: 'hourly', hourlyRate: 19.37, status: 'active' } }, owner) });
  assert.equal(seeded.status, 200, await seeded.clone().text());
  const stored = async () => (await (await employeeHub.onRequestGet({ env, request: jsonRequest('/api/employee-hub', undefined, owner) })).json()).collections.profiles.find(row => row.username === 'Crew.Static');
  const { posts, replies, reads, drain, fetcher } = realHub(env, manager);
  const page = hubPage({ user: 'TylerG', role: 'manager', fetcher });
  page.api.install();
  await drain();
  assert.ok(reads.length > 0, 'the page read /api/employee-hub');
  // Precondition: the page was served the manager's view, which carries no pay for the crew member.
  const served = reads.at(-1), crewRow = served.collections.profiles.find(row => row.username === 'Crew.Static');
  assert.equal(served.payVisibility, 'own');
  assert.deepEqual(['hourlyRate', 'payType'].filter(key => Object.hasOwn(crewRow, key)), []);
  const pending = page.context.opsEditProfile('crew.static'), dialog = page.document.querySelector('.ops-action-dialog');
  assert.equal(dialog.querySelector('[name="hourlyRate"]'), null, 'no rate field where the pay is not shown');
  assert.match(dialog.textContent, /Pay rates are set by the owner\./);
  assert.doesNotMatch(dialog.textContent, /Pay rate changes affect new timecards/);
  dialog.querySelector('[name="displayName"]').value = 'Synthetic Crew Renamed';
  dialog.querySelector('[name="jobTitle"]').value = 'Synthetic lead';
  page.context.opsActionSubmit({ preventDefault() {}, currentTarget: dialog });
  await pending;
  await drain();
  const saves = posts.map((post, index) => [post, replies[index]]).filter(([post]) => post.id === 'crew.static');
  assert.equal(saves.length, 1, 'one save for the submitted form');
  const [[saved, status]] = saves;
  assert.deepEqual([saved.data.displayName, saved.data.jobTitle, saved.data.username], ['Synthetic Crew Renamed', 'Synthetic lead', 'Crew.Static']);
  assert.deepEqual(['hourlyRate', 'payType', 'bonus', 'tips'].filter(key => Object.hasOwn(saved.data, key)), [], 'no pay goes to the server');
  assert.equal(status, 200, 'the real handler saves it');
  assert.ok(replies.every(code => code === 200), `every save the page made passed: ${replies}`);
  const after = await stored();
  assert.deepEqual([after.displayName, after.jobTitle, after.hourlyRate, after.payType], ['Synthetic Crew Renamed', 'Synthetic lead', 19.37, 'hourly'], 'the owner\'s pay stays');
});

// Fourth check: the manager's own profile under payVisibility 'own'. With the flag on a manager cannot change their own
// pay either (the server refuses it), so the form has no rate field there too: it shows their rate read-only and says who
// sets pay, and a name or job-title save sends no pay, which the real handler saves (200) with the rate unchanged.
test('with pay owner-only (payVisibility "own") the manager\'s own profile shows their rate read-only, with no rate field, and its save sends no pay', async t => {
  vaultFirestore(t);
  const env = staffEnv();
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG');
  const ownProfile = async cookie => (await (await employeeHub.onRequestGet({ env, request: jsonRequest('/api/employee-hub', undefined, cookie) })).json()).collections.profiles.find(row => row.username === 'TylerG');
  const { posts, replies, reads, drain, fetcher } = realHub(env, manager);
  const page = hubPage({ user: 'TylerG', role: 'manager', fetcher });
  page.api.install();
  await drain();
  // Precondition: the manager is served payVisibility 'own' and their own rate (the Hub configuration's 30).
  const served = reads.at(-1), own = served.collections.profiles.find(row => row.username === 'TylerG');
  assert.equal(served.payVisibility, 'own');
  assert.deepEqual([own.id, own.hourlyRate], ['tylerg', 30]);
  // The team board shows the manager their own rate but offers no pay edit.
  page.api.go('people');
  await drain();
  const button = page.main().querySelectorAll('button').find(node => node.getAttribute('onclick') === "opsEditProfile('tylerg')");
  assert.equal(button.textContent, 'Edit profile', 'no "Edit profile & pay" where pay cannot be set');
  assert.match(page.main().textContent, /\$30\/hrCurrent profile rate/, 'the manager still sees their own rate on the board');
  const before = posts.length;
  const pending = page.context.opsEditProfile('tylerg'), dialog = page.document.querySelector('.ops-action-dialog');
  assert.equal(dialog.querySelector('[name="hourlyRate"]'), null, 'no rate field on the manager\'s own profile');
  assert.deepEqual(dialog.querySelectorAll('input').map(node => node.getAttribute('name')), ['displayName', 'jobTitle', 'phone', 'emergencyContact']);
  assert.match(dialog.textContent, /Your hourly rate: \$30\.00\. Pay rates are set by the owner\./, 'the rate is shown read-only');
  assert.doesNotMatch(dialog.textContent, /Pay rate changes affect new timecards/);
  dialog.querySelector('[name="displayName"]').value = 'Synthetic Manager Renamed';
  dialog.querySelector('[name="jobTitle"]').value = 'Synthetic operations';
  page.context.opsActionSubmit({ preventDefault() {}, currentTarget: dialog });
  await pending;
  await drain();
  const saves = posts.map((post, index) => [post, replies[index]]).slice(before).filter(([post]) => post.collection === 'profiles' && post.id === 'tylerg');
  assert.equal(saves.length, 1, 'one save for the submitted form');
  const [[saved, status]] = saves;
  assert.deepEqual([saved.data.displayName, saved.data.jobTitle, saved.data.username], ['Synthetic Manager Renamed', 'Synthetic operations', 'TylerG']);
  assert.deepEqual(['hourlyRate', 'payType', 'bonus', 'tips'].filter(key => Object.hasOwn(saved.data, key)), [], 'no pay goes to the server');
  assert.equal(status, 200, 'the real handler saves it');
  assert.ok(replies.every(code => code === 200), `every save the page made passed: ${replies}`);
  for (const cookie of [owner, manager]) {
    const after = await ownProfile(cookie);
    assert.deepEqual([after.displayName, after.jobTitle, after.hourlyRate], ['Synthetic Manager Renamed', 'Synthetic operations', 30], 'the rate stays');
  }
});
