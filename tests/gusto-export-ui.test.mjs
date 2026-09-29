process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, FixedDate, hubPage, NOW, storage } from './helpers/hub-dom.mjs';
import { timesheetHandlers } from '../functions/api/timesheets.js';
import { STAFF_CAPABILITIES, ROLE_CAPABILITIES } from '../functions/_lib/staff-roles.js';
import { SKILL_CATALOG, SKILL_CATALOG_VERSION, SKILL_LEVELS } from '../functions/_lib/staff-skills.js';
import { WEEK_DAYS } from '../functions/_lib/staff-directory.js';

const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const PEOPLE = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
// The 56.5 h audit week (Sep 14-20, over by the hub-dom clock, Sep 22): Denver hour `hour` of `date`, a 30-minute meal each.
const at = (date, hour) => new Date(Date.parse(`${date}T00:00:00Z`) + (hour + 6) * 3600000).toISOString();
const WEEK = [['2026-09-14', 5, 18.5], ['2026-09-15', 6, 16], ['2026-09-16', 6, 16], ['2026-09-17', 6, 16], ['2026-09-18', 6, 16], ['2026-09-19', 8, 14]].map(([date, from, to]) => ({
  id: `maria-${date}`, employee: 'Maria.Synthetic', employeeName: 'Synthetic Maria', payType: 'hourly', hourlyRate: 22, clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved',
  breaks: [{ startAt: at(date, from + 4), endAt: at(date, from + 4.5) }], updatedAt: '2026-09-21T01:00:00.000Z' }));
const IDS = new Map([['maria.synthetic', { gustoEmployeeId: 'gusto-syn-1001', gustoExcluded: false, displayName: null }]]);

// The timesheet screen of employee-suite.js with the payroll week card, served by the real /api/timesheets handler.
// tamper(response): what the Gusto download answers with instead of the handler's response (a proxy that drops a header).
function timesheetScreen({ user = 'ZacB', role = 'owner', owner, timecards = WEEK, ids = IDS, env = {}, tamper = response => response } = {}) {
  const server = { queries: [] }, session = { user, role, businessAccess: true, displayName: `Synthetic ${user}` };
  const handlers = timesheetHandlers({ session: async () => session, read: async () => ({ timecards: structuredClone(timecards), requests: [] }), gustoProfiles: async () => ids, now: () => new Date(NOW) });
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('/api/timesheets')) {
      const query = Object.fromEntries(new URL(url, 'https://easygaragecleaning.com').searchParams), response = await handlers.get({ request: new Request('https://easygaragecleaning.com' + url), env });
      server.queries.push(query);
      return query.format === 'gusto' ? tamper(response) : response;
    }
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: { ...Object.fromEntries(PEOPLE.map(name => [name, []])), timeEntries: structuredClone(timecards) } });
    if (url.startsWith('/api/highlevel?view=command')) return json({ ok: true, pipelines: [], opportunities: [] });
    if (url.startsWith('/api/highlevel?view=walkthroughs')) return json({ ok: true, events: [] });
    if (url.startsWith('/api/integration-status')) return json({ ok: true, status: {} });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  };
  const page = hubPage({ user, role, fetcher, ...(owner === undefined ? {} : { owner }) }), blobs = [];
  page.context.URL = Object.assign(Object.create(URL), { createObjectURL: blob => { blobs.push(blob); return 'blob:synthetic-payroll'; }, revokeObjectURL() {} });
  vm.runInContext(readFileSync(new URL('../employee-payroll-week.js', import.meta.url), 'utf8'), page.context, { filename: 'employee-payroll-week.js' });
  const card = () => page.document.querySelector('.egc-payroll-week');
  const button = text => card().querySelectorAll('button').find(node => node.textContent === text);
  return { page, server, blobs, card, button, handlers, env };
}
async function open(screen) {
  screen.page.api.install();
  await settle();
  screen.page.api.S.timesheetAnchor = '2026-09-15';
  screen.page.api.go('timesheets');
  await settle();
  return screen.card();
}

test('the owner downloads the week\'s Gusto hours file from the payroll week card, byte for byte the server\'s', async () => {
  const bonus = WEEK.map((card, index) => index ? card : { ...card, bonus: 25 });
  const screen = timesheetScreen({ timecards: bonus }), card = await open(screen);
  assert.match(card.textContent, /Every timecard is settled\./);
  assert.ok(screen.button('Download payroll CSV'), 'the payroll CSV stays');
  screen.button('Download Gusto hours').click();
  await settle();
  const query = screen.server.queries.find(item => item.format === 'gusto');
  assert.deepEqual(query, { view: 'week', start: '2026-09-14', format: 'gusto' });
  assert.equal(screen.blobs.length, 1);
  const expected = await (await screen.handlers.get({ request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-14&format=gusto'), env: {} })).text();
  assert.equal(await screen.blobs[0].text(), expected);
  assert.match(expected, /"gusto-syn-1001","Synthetic Maria","40\.00","16\.50","0\.00","0\.00"\r\n$/);
  const status = screen.card().querySelector('[role="status"]');
  assert.equal(status.textContent, 'Gusto hours file for Sep 14 – Sep 20 downloaded. This week also has $25.00 in timecard bonuses: they are not in the Gusto file, so enter them in Gusto from the payroll CSV.');
  assert.match(screen.card().textContent, /keyed by the Gusto employee ID in the staff directory/);
  assert.equal(screen.button('Download Gusto hours').hasAttribute('disabled'), false, 'ready for another download');
});

test('a missing Gusto ID or an unsettled week is shown as the server says it, and nothing downloads', async () => {
  const screen = timesheetScreen({ ids: new Map() });
  await open(screen);
  screen.button('Download Gusto hours').click();
  await settle();
  const alert = screen.card().querySelector('[role="alert"]');
  assert.match(alert.textContent, /^Add the Gusto employee ID for Synthetic Maria \(maria\.synthetic\) in the staff directory \(Team\)/);
  assert.equal(screen.blobs.length, 0);
  assert.equal(screen.button('Export with these flags'), undefined, 'a missing ID cannot be acknowledged away');
  // A flagged week offers the acknowledgement for the Gusto file it was asked for.
  const flagged = timesheetScreen({ timecards: WEEK.map(card => ({ ...card, hourlyRate: undefined })) });
  await open(flagged);
  flagged.button('Download Gusto hours').click();
  await settle();
  assert.match(flagged.card().querySelector('[role="alert"]').textContent, /Fix the flagged pay \(missing_rate\)/);
  flagged.button('Export with these flags').click();
  await settle();
  assert.deepEqual(flagged.server.queries.filter(item => item.format).map(item => [item.format, item.acknowledge]), [['gusto', undefined], ['gusto', 'missing_rate']]);
  assert.equal(flagged.blobs.length, 1);
  assert.match(flagged.card().querySelector('[role="status"]').textContent, /^Gusto hours file for Sep 14 – Sep 20 downloaded with its pay-review flags\./);
});

test('a manager never sees the Gusto hours button, even with the payroll CSV open to managers, and never asks for the file', async () => {
  for (const env of [{}, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }]) {
    const screen = timesheetScreen({ user: 'TylerG', role: 'manager', env });
    const card = await open(screen);
    assert.ok(card, 'the manager sees the payroll week card');
    assert.equal(screen.button('Download Gusto hours'), undefined);
    assert.doesNotMatch(card.textContent, /Gusto hours|gusto-syn/);
    assert.equal(Boolean(screen.button('Download payroll CSV')), env.EGC_STAFF_PAY_OWNER_ONLY === 'false');
    assert.equal(screen.server.queries.some(item => item.format === 'gusto'), false);
  }
  // A tab that claims the owner grant still gets the server's 403: the button goes and the refusal is shown.
  const forged = timesheetScreen({ user: 'TylerG', role: 'manager', owner: true, env: { EGC_STAFF_PAY_OWNER_ONLY: 'false' } });
  await open(forged);
  forged.button('Download Gusto hours').click();
  await settle();
  assert.equal(forged.button('Download Gusto hours'), undefined);
  assert.equal(forged.card().querySelector('[role="alert"]').textContent, 'Only the owner can download the Gusto hours file. Managers review hours and approvals here.');
  assert.equal(forged.blobs.length, 0);
});

test('after the download the owner is told who was left out as not paid through Gusto, by name', async () => {
  const contract = WEEK.slice(0, 2).map(card => ({ ...card, id: card.id.replace('maria', 'contract'), employee: 'Crew.Contract', employeeName: 'Crew.Contract' }));
  const ids = new Map([...IDS, ['crew.contract', { gustoEmployeeId: null, gustoExcluded: true, displayName: 'Synthetic Contractor' }]]);
  const screen = timesheetScreen({ timecards: [...WEEK, ...contract], ids });
  await open(screen);
  screen.button('Download Gusto hours').click();
  await settle();
  assert.equal(screen.blobs.length, 1);
  assert.doesNotMatch(await screen.blobs[0].text(), /Contract/, 'their hours are not in the file');
  assert.equal(screen.card().querySelector('[role="status"]').textContent, 'Gusto hours file for Sep 14 – Sep 20 downloaded. Left out as not paid through Gusto (the payroll CSV has their hours): Synthetic Contractor.');
  assert.match(screen.card().textContent, /nor anyone marked not paid through Gusto there/);
  // A header that cannot be read is reported as such, never as nobody left out.
  const garbled = timesheetScreen({ timecards: [...WEEK, ...contract], ids, tamper: response => { const headers = new Headers(response.headers); headers.set('X-EGC-Gusto-Not-Included', '%E0%A4%A'); return new Response(response.body, { status: response.status, headers }); } });
  await open(garbled);
  garbled.button('Download Gusto hours').click();
  await settle();
  assert.equal(garbled.card().querySelector('[role="status"]').textContent, 'Gusto hours file for Sep 14 – Sep 20 downloaded. Some employees were left out as not paid through Gusto; the payroll CSV has their hours.');
});

// employee-gusto.js: Connect Gusto only once Gusto has approved production access.
function gustoCard(connection) {
  const host = { innerHTML: '' }, window = { addEventListener() {} };
  const context = vm.createContext({ window, document: { getElementById: id => id === 'ops-gusto-payroll' ? host : null }, location: { search: '' }, URLSearchParams, Date: FixedDate,
    hubFetch: async () => Response.json({ ok: true, connection, rows: [], excluded: [] }) });
  vm.runInContext(readFileSync(new URL('../employee-gusto.js', import.meta.url), 'utf8'), context);
  window.EGCGusto.mount({ owner: true, identity: 'ZacB', generation: 1, startDate: '2026-09-14', endDate: '2026-09-20', askAction: async () => null });
  return host;
}

test('Connect Gusto is hidden until GUSTO_PRODUCTION_APPROVED, and the card points to the Gusto hours file instead', async () => {
  const demo = gustoCard({ configured: true, connected: false, environment: 'demo', productionApproved: false, message: 'Connect the EGC Gusto account to sync approved hours.' });
  const unconfigured = gustoCard({ configured: false, connected: false, productionApproved: false, message: 'Gusto sync is not configured.' });
  const approved = gustoCard({ configured: true, connected: false, environment: 'production', productionApproved: true, message: 'Connect the EGC Gusto account to sync approved hours.' });
  const older = gustoCard({ configured: true, connected: false, environment: 'demo', message: 'Connect the EGC Gusto account to sync approved hours.' });
  await settle();
  for (const host of [demo, unconfigured, older]) {
    assert.doesNotMatch(host.innerHTML, /href="\/api\/gusto-auth"|>Connect Gusto</);
    assert.match(host.innerHTML, /Download Gusto hours on the payroll week card/);
  }
  assert.match(approved.innerHTML, /<a class="ops-button primary" href="\/api\/gusto-auth">Connect Gusto<\/a>/);
});

// employee-staff.js: the owner's Gusto employee ID editor.
const source = readFileSync(new URL('../employee-staff.js', import.meta.url), 'utf8');
const person = (username, overrides = {}) => ({ username, displayName: `Synthetic ${username}`, source: 'employee_account', accountStatus: 'approved', staffRoles: ['crew'], staffRolesSource: 'account', primaryRole: 'crew',
  skills: [], weeklyAvailability: null, weeklyAvailabilityNeedsReview: false, history: [], revision: `rev-${username}-1`, profileNeedsReview: false, ...overrides });
const directory = (people, capabilities = [...STAFF_CAPABILITIES], user = 'ZacB') => ({ ok: true, authority: 'employee_hub', timeZone: 'America/Denver', today: '2026-09-22', viewer: { user, capabilities },
  catalog: { version: SKILL_CATALOG_VERSION, skills: SKILL_CATALOG, levels: SKILL_LEVELS, roles: ['owner', 'manager', 'crew_lead', 'crew', 'sales', 'phone'], days: WEEK_DAYS }, people, coverage: { complete: true, asOf: '2026-09-22T18:00:00.000Z' } });
// respond(body): the saved person the server answers with (by default the first person with the posted Gusto fields).
function staffUi(data, { identity = 'ZacB', capabilities = ['crew', 'business', 'owner'], respond = body => ({ ...data.people[0], gustoEmployeeId: body.gustoEmployeeId || null, gustoExcluded: body.gustoExcluded === true, revision: 'rev-2' }) } = {}) {
  const document = createDocument(), posts = [];
  const context = vm.createContext({ console, Intl, Promise, Set, Map, Error, JSON, Object, Array, Math, Number, String, Symbol, AbortController, crypto, Date: FixedDate, document,
    sessionStorage: storage(), setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, fetch: async () => { throw new Error('the injected Hub fetch is always used'); } });
  context.window = context;
  vm.runInContext(source, context, { filename: 'employee-staff.js' });
  const host = document.createElement('div');
  document.body.append(host);
  const hubFetch = async (url, init = {}) => {
    if (init.body) { const body = JSON.parse(init.body); posts.push(body); return { ok: true, status: 200, json: async () => ({ ok: true, authority: 'employee_hub', person: respond(body) }) }; }
    return { ok: true, status: 200, json: async () => structuredClone(data) };
  };
  context.EGCStaff.mount(host, { identity, capabilities, hubFetch, toast() {} });
  const input = (name = 'gustoEmployeeId') => host.querySelectorAll('input').find(node => node.getAttribute('name') === name);
  return { host, posts, buttons: () => host.querySelectorAll('button'), input, submit: () => host.querySelector('form.st-editor').dispatchEvent({ type: 'submit', preventDefault() {} }) };
}

test('the staff directory shows the Gusto employee ID and its editor to the owner only, and saves a checked ID', async () => {
  const ui = staffUi(directory([person('Crew.One', { gustoEmployeeId: null }), person('Crew.Two', { gustoEmployeeId: 'gusto-syn-2' })]));
  await settle();
  const cards = ui.host.querySelectorAll('article');
  assert.match(cards[0].textContent, /Gusto employee ID\s*Not set\. The payroll week’s Gusto hours file names this employee and stops until it is added, or until they are marked not paid through Gusto\./);
  assert.match(cards[1].textContent, /gusto-syn-2/);
  ui.buttons().find(node => node.getAttribute('aria-label') === 'Set Gusto ID for Synthetic Crew.One').click();
  const input = ui.input();
  assert.equal(input.getAttribute('type'), 'text'); assert.equal(input.getAttribute('autocomplete'), 'off'); assert.equal(String(input.maxLength ?? input.getAttribute('maxLength')), '64');
  input.value = 'has space'; input.dispatchEvent({ type: 'input' });
  ui.host.querySelector('form.st-editor').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.equal(ui.posts.length, 0, 'a malformed ID is caught before a request id is spent');
  assert.match(ui.host.querySelector('.st-error').textContent, /letters, digits, dots, dashes or underscores/);
  ui.input().value = '  gusto-syn-1 '; ui.input().dispatchEvent({ type: 'input' });
  ui.host.querySelector('form.st-editor').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.equal(ui.posts.length, 1);
  const [body] = ui.posts;
  assert.deepEqual([body.action, body.username, body.expectedRevision, body.gustoEmployeeId, body.gustoExcluded, body.expectedUser], ['set_gusto_id', 'Crew.One', 'rev-Crew.One-1', 'gusto-syn-1', false, 'zacb']);
  assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(ui.host.textContent, /Saved: Gusto employee ID for Synthetic Crew\.One\./);
  assert.match(ui.host.querySelectorAll('article')[0].textContent, /gusto-syn-1/);
});

test('a manager\'s staff directory has no Gusto employee ID section or editor', async () => {
  const ui = staffUi(directory([person('Crew.One')], [...ROLE_CAPABILITIES.manager], 'TylerG'), { identity: 'TylerG', capabilities: ['crew', 'business'] });
  await settle();
  assert.ok(ui.host.querySelector('article'));
  assert.doesNotMatch(ui.host.textContent, /Gusto/);
  assert.equal(ui.buttons().some(node => /Gusto/.test(node.getAttribute('aria-label') || node.textContent)), false);
});

test('the owner marks someone not paid through Gusto from the same editor, and the card says so', async () => {
  const ui = staffUi(directory([person('Crew.Contract', { gustoEmployeeId: null, gustoExcluded: false })]));
  await settle();
  ui.buttons().find(node => node.getAttribute('aria-label') === 'Set Gusto ID for Synthetic Crew.Contract').click();
  const box = ui.input('gustoExcluded');
  assert.equal(box.getAttribute('type'), 'checkbox');
  assert.equal(box.checked, false);
  assert.match(box.parentNode.textContent, /Not paid through Gusto/);
  box.checked = true; box.dispatchEvent({ type: 'change' });
  ui.submit();
  await settle();
  assert.deepEqual([ui.posts[0].gustoEmployeeId, ui.posts[0].gustoExcluded], ['', true]);
  assert.match(ui.host.querySelector('article').textContent, /Not paid through Gusto: left out of the Gusto hours file/);
  assert.doesNotMatch(ui.host.querySelector('article').textContent, /Not set\./, 'no longer flagged as missing an ID');
  // Reopened, the editor starts from the saved mark.
  ui.buttons().find(node => node.getAttribute('aria-label') === 'Set Gusto ID for Synthetic Crew.Contract').click();
  assert.equal(ui.input('gustoExcluded').checked, true);
});

test('former staff are listed for the owner under the directory, with only the Gusto editor', async () => {
  const former = { username: 'Gone.Crew', displayName: 'Synthetic Gone Crew', source: 'former', accountStatus: 'rejected', gustoEmployeeId: null, gustoExcluded: false, history: [], revision: 'rev-gone-1', profileNeedsReview: false };
  const data = { ...directory([person('Crew.One', { gustoEmployeeId: 'gusto-syn-1' })]), formerStaff: [former] };
  const ui = staffUi(data, { respond: body => ({ ...former, gustoEmployeeId: body.gustoEmployeeId || null, gustoExcluded: body.gustoExcluded === true, revision: 'rev-gone-2',
    history: [{ action: 'set_gusto_id', scope: 'gusto', actor: 'ZacB', at: '2026-09-22T18:00:00.000Z', changes: { before: { gustoEmployeeId: null, gustoExcluded: false }, after: { gustoEmployeeId: body.gustoEmployeeId, gustoExcluded: false } } }] }) });
  await settle();
  const section = ui.host.querySelector('details.st-former');
  assert.ok(section);
  assert.match(section.querySelector('summary').textContent, /^Former staff \(1\) · Gusto IDs only$/);
  const card = section.querySelector('article');
  assert.match(card.textContent, /Synthetic Gone Crew@Gone\.Crew · Account not approvedFormer staff/);
  assert.match(card.textContent, /Not set\./);
  assert.deepEqual(card.querySelectorAll('button').map(node => node.textContent), ['Set Gusto ID'], 'no roles, skills, pay or availability for former staff');
  card.querySelectorAll('button')[0].click();
  assert.ok(ui.host.querySelector('details.st-former').hasAttribute('open'), 'the section stays open while its editor is');
  ui.input().value = 'gusto-syn-gone'; ui.input().dispatchEvent({ type: 'input' });
  ui.submit();
  await settle();
  assert.deepEqual([ui.posts[0].action, ui.posts[0].username, ui.posts[0].expectedRevision, ui.posts[0].gustoEmployeeId], ['set_gusto_id', 'Gone.Crew', 'rev-gone-1', 'gusto-syn-gone']);
  assert.match(ui.host.textContent, /Saved: Gusto employee ID for Synthetic Gone Crew\./);
  const saved = ui.host.querySelector('details.st-former article');
  assert.match(saved.textContent, /gusto-syn-gone/);
  assert.match(saved.textContent, /Change history \(1\)Gusto employee ID set/);
  assert.match(ui.host.querySelectorAll('article')[0].textContent, /gusto-syn-1/, 'the active directory is unchanged');
  // A malformed former-staff entry makes the whole directory unverified rather than drawing part of it.
  const bad = staffUi({ ...data, formerStaff: [{ ...former, gustoExcluded: 'no' }] });
  await settle();
  assert.equal(bad.host.querySelector('article'), null);
  assert.match(bad.host.textContent, /Staff directory unavailable/);
});

test('a manager handed former staff by a forged response still gets no Gusto editor for them', async () => {
  const former = { username: 'Gone.Crew', displayName: 'Synthetic Gone Crew', source: 'former', gustoEmployeeId: null, gustoExcluded: false, history: [], revision: 'rev-gone-1', profileNeedsReview: false };
  const ui = staffUi({ ...directory([person('Crew.One')], [...ROLE_CAPABILITIES.manager], 'TylerG'), formerStaff: [former] }, { identity: 'TylerG', capabilities: ['crew', 'business'] });
  await settle();
  assert.equal(ui.buttons().some(node => /Gusto/.test(node.getAttribute('aria-label') || node.textContent)), false);
});
