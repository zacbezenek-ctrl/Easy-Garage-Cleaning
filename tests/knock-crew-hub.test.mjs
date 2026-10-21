import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage } from './helpers/hub-dom.mjs';

// D2D (owner, 2026-10-19): "you shouldn't be redirected every time in the door to door section" and "integrate it natively
// into the crew hub". Knock opens at its clean URL and stays in its own page; the crew hub and Knock link to each other.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const HUB_AUTH = read('crew/hub-auth.js');

// crew/hub-auth.js as a crew page runs it: the signed-in profile in sessionStorage (as remember() stores it from
// /api/hub-auth) and whatever EGC Knock left in this phone's localStorage (crew/knock-app.js remember()).
function crewPage(profile, knock = {}, raw = {}, extra = {}) {
  const document = createDocument(), inserted = [];
  const topbar = { insertAdjacentElement: (position, node) => { inserted.push(node); document.body.append(node); } };
  const local = storage({ ...Object.fromEntries(Object.entries(knock).map(([key, value]) => [key, JSON.stringify(value)])), ...raw });
  const context = {
    console, JSON, Number, String, sessionStorage: storage(profile), localStorage: local, fetch: async () => { throw new Error('offline'); },
    document: Object.assign(document, { readyState: 'loading', getElementById: id => id === 'topbar' ? topbar : null, querySelector: selector => document.body.querySelector(selector) }),
    location: { pathname: '/crew/' }, addEventListener() {}, dispatchEvent() {}, Event: class {}, ...extra,
  };
  context.window = context;
  vm.runInNewContext(HUB_AUTH, context);
  const auth = context.EGCHubAuth;
  return { auth, local, nav: () => { auth.mountCrewNav(); return inserted.at(-1).querySelectorAll('a').map(link => [link.getAttribute('href'), link.textContent]); },
    current: () => inserted.at(-1).querySelectorAll('a').filter(link => link.getAttribute('aria-current') === 'page').map(link => link.textContent) };
}
const signedIn = (user, extra = {}) => ({ egc_u: user, egc_name: `Synthetic ${user}`, egc_business_access: 'false', egc_capabilities: '[]', ...extra });
const knockViewer = (user, savedAt) => ({ 'egc-knock:viewer': { user, displayName: `Synthetic ${user}`, repKey: user.toLowerCase(), savedAt } });
const T = Date.parse('2026-10-19T15:00:00.000Z');

test('the crew hub offers Door-to-door to Knock\'s admins and to accounts Knock already knows on this phone, never creating anything', () => {
  const business = crewPage(signedIn('ZacB', { egc_business_access: 'true' }));
  assert.equal(business.auth.canUseKnock(), true, 'business users are Knock admins');
  assert.deepEqual(business.nav(), [['/crew/', 'Crew home'], ['/crew/gameplan', 'Walkthrough'], ['/crew/knock', 'Door-to-door'], ['/crew/prejob', 'Pre-job'], ['/crew/postjob', 'Closeout'], ['/employee?view=my_day', 'My Hub']]);

  const crew = crewPage(signedIn('Crew.One'));
  assert.equal(crew.auth.canUseKnock(), false, 'a crew member who never opened Knock here sees no tile');
  assert.deepEqual(crew.nav().map(([href]) => href), ['/crew/', '/crew/prejob', '/crew/postjob', '/employee?view=my_day']);

  const rep = crewPage(signedIn('Rep.One'), knockViewer('rep.one', T));
  assert.equal(rep.auth.canUseKnock(), true, 'the account Knock signed in on this phone (any case)');
  assert.deepEqual(rep.nav(), [['/crew/', 'Crew home'], ['/crew/knock', 'Door-to-door'], ['/crew/prejob', 'Pre-job'], ['/crew/postjob', 'Closeout'], ['/employee?view=my_day', 'My Hub']]);
  assert.equal(rep.auth.canUseKnock('someone.else'), false, 'only for the signed-in account');

  for (const [label, page] of [
    ['another account\'s Knock', crewPage(signedIn('Crew.One'), knockViewer('Rep.One', T))],
    ['signed out of Knock since', crewPage(signedIn('Rep.One'), { ...knockViewer('Rep.One', T), 'egc-knock:signed-out-at': T + 1 })],
    ['no account signed in', crewPage({}, knockViewer('Rep.One', T))],
  ]) assert.equal(page.auth.canUseKnock(), false, label);
  assert.equal(crewPage(signedIn('Rep.One'), {}, { 'egc-knock:viewer': '{not json' }).auth.canUseKnock(), false, 'an unreadable Knock copy');
  // The crew home's own clean address (/crew/) is the current page in the menu.
  assert.deepEqual(rep.current(), ['Crew home']);
});

// Signing out of the crew pages (Crew home, walkthrough, pre-job, closeout) signs Knock out on this phone too, and a
// different account signing in drops the previous account's Knock copy: Knock never opens offline as someone who left.
test('a crew sign-out signs Knock out on this phone, and another account signing in drops the previous rep\'s Knock copy', async () => {
  for (const explicit of [true, false]) {
    const page = crewPage(signedIn('Rep.One'), knockViewer('Rep.One', T), {}, { Date: class extends Date { static now() { return T + 60000; } } });
    await page.auth.signOut({ explicit });
    assert.equal(page.local.getItem('egc-knock:viewer'), null, `explicit ${explicit}: Knock's copy of the rep is gone`);
    assert.equal(page.local.getItem('egc-knock:signed-out-at'), JSON.stringify(T + 60000), 'Knock reads the sign-out time as its own');
    assert.equal(page.auth.canUseKnock('Rep.One'), false);
  }
  const answer = user => async url => ({ ok: true, status: 200, json: async () => (String(url).includes('firebase-session') ? { ok: true, token: 'synthetic-token' } : { ok: true, user, displayName: user }) });
  const firebase = { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) };
  const other = crewPage({}, knockViewer('Rep.One', T), {}, { fetch: answer('Crew.Two'), firebase });
  assert.equal(await other.auth.session(), 'Crew.Two');
  assert.equal(other.local.getItem('egc-knock:viewer'), null, 'another account signed in: the previous rep\'s Knock copy goes');
  assert.equal(other.local.getItem('egc-knock:signed-out-at'), null);
  const same = crewPage({}, knockViewer('Rep.One', T), {}, { fetch: answer('rep.one'), firebase });
  assert.equal(await same.auth.session(), 'rep.one');
  assert.equal(JSON.parse(same.local.getItem('egc-knock:viewer')).user, 'Rep.One', 'the same account keeps it (any case)');
  // The Employee Hub's sign-out does the same (employee.html doLogout).
  assert.match(read('employee.html'), /async function doLogout[\s\S]*?localStorage\.setItem\('egc-knock:signed-out-at', JSON\.stringify\(Date\.now\(\)\)\)[\s\S]*?localStorage\.removeItem\('egc-knock:viewer'\)[\s\S]*?return serializeHubAuth/);
});

test('the crew home tile and every Knock link use clean URLs, and Knock links back to the crew home', () => {
  const home = read('crew/index.html'), knockApp = read('crew/knock-app.js'), knockPage = read('crew/knock.html');
  assert.match(home, /<a class="tool" id="knock-tool" href="\/crew\/knock" hidden>[\s\S]*?<h2>Door-to-door<\/h2>/);
  assert.match(home, /document\.getElementById\('knock-tool'\)\.hidden=!EGCHubAuth\.canUseKnock\(profile\.user\);/);
  // The wordmark is a hash link: tapping it goes Home in the same page instead of loading /crew/knock.html (a 308) again.
  assert.match(knockPage, /<a class="wordmark" href="#home">EGC <em>Knock<\/em><\/a>/);
  assert.match(knockApp, /h\('a', \{ class: 'wordmark', href: '#home' \}/);
  for (const [name, source] of [['knock-app.js', knockApp], ['knock.html', knockPage], ['knock-stats-ui.js', read('crew/knock-stats-ui.js')], ['knock-rep.js', read('crew/knock-rep.js')]]) {
    assert.doesNotMatch(source, /\/crew\/knock\.html|\/employee\.html/, `${name} never sends a rep through a .html redirect`);
  }
  assert.match(knockApp, /h\('a', \{ class: 'list-row', href: '\/crew\/' \},\s*h\('span', \{ class: 'list-row__main' \}, h\('span', \{ class: 'list-row__title' \}, 'Crew home'\)/);
  // The installed app opens /crew/knock directly; its id stays the same so installed apps keep their identity.
  const manifest = JSON.parse(read('crew/manifest-knock.webmanifest'));
  assert.deepEqual([manifest.start_url, manifest.id, manifest.scope], ['/crew/knock', '/crew/knock.html', '/crew/']);
  // Owners' Start in-home walkthrough stays in this tab (an installed app keeps its sign-in) after the look is logged.
  // It goes only once the look is logged and sent (the Hub's door-to-door data has it); a refused look says so instead.
  assert.doesNotMatch(read('crew/knock-rep.js'), /_blank/);
  assert.match(read('crew/knock-rep.js'), /const logged = details \? await logDoor\(house, outcome, details\) : null;\n    if \(!details\?\.openWalkthrough\) return;\n[\s\S]*?if \(!logged\?\.id\) \{\n      return toast\('Look not saved'[\s\S]*?action: \{ label: 'Open walkthrough', run: \(\) => location\.assign\(details\.openWalkthrough\) \} \}\);\n    \}\n    await app\.syncBeforeLeaving\(\);\n    location\.assign\(details\.openWalkthrough\);/);
  // Crew links on the crew home and the Hub board's open links use clean URLs too (no .html redirect).
  const tiles = home.slice(home.indexOf('id="walkthrough-tool"') - 30, home.indexOf('id="knock-tool"'));
  assert.deepEqual([...tiles.matchAll(/(?:href|data-business-href)="([^"]+)"/g)].map(match => match[1]), ['/crew/gameplan', '/crew/job', '/crew/prejob', '/crew/job', '/crew/postjob']);
  assert.match(home, /tool\.setAttribute\('href',business\?tool\.dataset\.businessHref:'\/crew\/job'\)/);
  assert.doesNotMatch(read('employee-dispatch-calendar.js'), /\/crew\/(?:gameplan|job)\.html/);
  // With no signal, the crew offline page (what any uncached crew page shows) leads back to Knock, which is cached whole.
  const offline = read('crew/offline.html');
  assert.match(offline, /<a class="button secondary" href="\/crew\/knock">Open EGC Knock<\/a>/);
  assert.match(read('crew/sw.js'), /'\/crew\/knock': '\/crew\/knock\.html'/);
});

test('six crew links (Walkthrough and Door-to-door) form two full rows on a phone', () => {
  const css = read('crew/crew-brand.css');
  assert.match(css, /\.crew-utility a:first-of-type:nth-last-of-type\(6\),\.crew-utility a:first-of-type:nth-last-of-type\(6\)~a\{grid-column:span 2\}/);
  for (const page of ['crew/index.html', 'crew/gameplan.html', 'crew/prejob.html', 'crew/postjob.html', 'crew/schedule.html', 'crew/menu.html']) {
    assert.match(read(page), /\/crew\/crew-brand\.css\?v=20261019d2d/, page);
    assert.match(read(page), /\/crew\/hub-auth\.js\?v=20261021roles/, page);
  }
});
