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
function crewPage(profile, knock = {}, raw = {}) {
  const document = createDocument(), inserted = [];
  const topbar = { insertAdjacentElement: (position, node) => { inserted.push(node); document.body.append(node); } };
  const local = storage({ ...Object.fromEntries(Object.entries(knock).map(([key, value]) => [key, JSON.stringify(value)])), ...raw });
  const context = {
    console, JSON, Number, String, sessionStorage: storage(profile), localStorage: local, fetch: async () => { throw new Error('offline'); },
    document: Object.assign(document, { readyState: 'loading', getElementById: id => id === 'topbar' ? topbar : null, querySelector: selector => document.body.querySelector(selector) }),
    location: { pathname: '/crew/' }, addEventListener() {}, dispatchEvent() {}, Event: class {},
  };
  context.window = context;
  vm.runInNewContext(HUB_AUTH, context);
  const auth = context.EGCHubAuth;
  return { auth, nav: () => { auth.mountCrewNav(); return inserted.at(-1).querySelectorAll('a').map(link => [link.getAttribute('href'), link.textContent]); } };
}
const signedIn = (user, extra = {}) => ({ egc_u: user, egc_name: `Synthetic ${user}`, egc_business_access: 'false', egc_capabilities: '[]', ...extra });
const knockViewer = (user, savedAt) => ({ 'egc-knock:viewer': { user, displayName: `Synthetic ${user}`, repKey: user.toLowerCase(), savedAt } });
const T = Date.parse('2026-10-19T15:00:00.000Z');

test('the crew hub offers Door-to-door to Knock\'s admins and to accounts Knock already knows on this phone, never creating anything', () => {
  const business = crewPage(signedIn('ZacB', { egc_business_access: 'true' }));
  assert.equal(business.auth.canUseKnock(), true, 'business users are Knock admins');
  assert.deepEqual(business.nav(), [['/crew', 'Crew home'], ['/crew/gameplan', 'Walkthrough'], ['/crew/knock', 'Door-to-door'], ['/crew/prejob', 'Pre-job'], ['/crew/postjob', 'Closeout'], ['/employee?view=my_day', 'My Hub']]);

  const crew = crewPage(signedIn('Crew.One'));
  assert.equal(crew.auth.canUseKnock(), false, 'a crew member who never opened Knock here sees no tile');
  assert.deepEqual(crew.nav().map(([href]) => href), ['/crew', '/crew/prejob', '/crew/postjob', '/employee?view=my_day']);

  const rep = crewPage(signedIn('Rep.One'), knockViewer('rep.one', T));
  assert.equal(rep.auth.canUseKnock(), true, 'the account Knock signed in on this phone (any case)');
  assert.deepEqual(rep.nav(), [['/crew', 'Crew home'], ['/crew/knock', 'Door-to-door'], ['/crew/prejob', 'Pre-job'], ['/crew/postjob', 'Closeout'], ['/employee?view=my_day', 'My Hub']]);
  assert.equal(rep.auth.canUseKnock('someone.else'), false, 'only for the signed-in account');

  for (const [label, page] of [
    ['another account\'s Knock', crewPage(signedIn('Crew.One'), knockViewer('Rep.One', T))],
    ['signed out of Knock since', crewPage(signedIn('Rep.One'), { ...knockViewer('Rep.One', T), 'egc-knock:signed-out-at': T + 1 })],
    ['no account signed in', crewPage({}, knockViewer('Rep.One', T))],
  ]) assert.equal(page.auth.canUseKnock(), false, label);
  assert.equal(crewPage(signedIn('Rep.One'), {}, { 'egc-knock:viewer': '{not json' }).auth.canUseKnock(), false, 'an unreadable Knock copy');
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
  assert.doesNotMatch(read('crew/knock-rep.js'), /_blank/);
  assert.match(read('crew/knock-rep.js'), /if \(details\) await logDoor\(house, outcome, details\);\n[^\n]*\n    if \(details\?\.openWalkthrough\) location\.assign\(details\.openWalkthrough\);/);
});

test('six crew links (Walkthrough and Door-to-door) form two full rows on a phone', () => {
  const css = read('crew/crew-brand.css');
  assert.match(css, /\.crew-utility a:first-of-type:nth-last-of-type\(6\),\.crew-utility a:first-of-type:nth-last-of-type\(6\)~a\{grid-column:span 2\}/);
  for (const page of ['crew/index.html', 'crew/gameplan.html', 'crew/prejob.html', 'crew/postjob.html', 'crew/schedule.html']) {
    assert.match(read(page), /\/crew\/crew-brand\.css\?v=20261019d2d/, page);
    assert.match(read(page), /\/crew\/hub-auth\.js\?v=20261019d2d/, page);
  }
});
