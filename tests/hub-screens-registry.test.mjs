import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hubPage, createDocument } from './helpers/hub-dom.mjs';

const CREW = { user: 'Synthetic.Crew', business: false, role: 'crew' };
const MANAGER = { user: 'AlexK', business: true, role: 'manager' };

function fixtureScreen(overrides = {}) {
  const calls = { mount: [], unmount: 0, refresh: 0 }, state = { dirty: false };
  const spec = {
    id: 'fixture_ledger', group: 'CLIENT WORK', label: 'Fixture ledger', iconPath: 'M4 4h16v16H4z', capability: 'business',
    mount(host, ctx) { calls.mount.push({ host, ctx }); },
    unmount() { calls.unmount++; },
    canLeave() { return !state.dirty; },
    refresh() { calls.refresh++; },
    ...overrides,
  };
  return { spec, calls, state };
}
const tabs = page => page.document.querySelectorAll('[data-ops-tab]').map(button => button.getAttribute('data-ops-tab'));
// Screens the shipped MANIFEST registers (REVIEWS-UI, M5 invoicing); fixtures register after them. SHIPPED are the business
// screens; the owner-only screens (P3-04 followup_settings, FUN-15 ad_spend, CATALOG-ADMIN catalog, DISPATCH-RULES dispatch_rules) register first and are checked separately.
// CREW-NOTIFY's Schedule alerts is crewVisible (every signed-in viewer sees it) and registers before them. STAFF-ACCESS's
// Password (My EGC) follows it and needs the 'password' capability, which the suite adds only when the server reports
// password.change (EGC_STAFF_PASSWORD_RESET on, an employee account).
// WT-OUTCOME: the Walkthroughs screen (employee-walkthroughs.js) replaces the suite's built-in Walkthroughs view in place.
const SHIPPED = ['reviews', 'message_templates', 'stocked_costs', 'staff', 'invoicing', 'walkthroughs'];
const OWNER_SHIPPED = ['followup_settings', 'ad_spend', 'catalog', 'dispatch_rules'];
const CREW_SHIPPED = ['crew_alerts'];
const PASSWORD_SHIPPED = ['password'];

test('a registered screen joins the nav under its group only when the capability matches', () => {
  for (const [who, expected] of [[{}, true], [MANAGER, true], [CREW, false]]) {
    const page = hubPage(who), screen = fixtureScreen();
    // Shipped MANIFEST screens (M5 added 'invoicing' to CLIENT WORK) register first.
    const lastInGroup = [...page.api.visibleNav()].filter(item => item[0] === 'CLIENT WORK').at(-1)?.[1];
    page.context.EGCHubScreens.register(screen.spec);
    const nav = page.api.visibleNav(), at = nav.findIndex(item => item[1] === 'fixture_ledger');
    assert.equal(at >= 0, expected, JSON.stringify(who));
    assert.equal(page.api.canView('fixture_ledger'), expected);
    if (expected) {
      assert.deepEqual([...nav[at]], ['CLIENT WORK', 'fixture_ledger', 'Fixture ledger']);
      assert.equal(nav[at - 1][1], lastInGroup, 'appended after the last item in its group');
      assert.equal(nav[at + 1][0], 'CRM');
      page.api.install();
      assert.ok(tabs(page).includes('fixture_ledger'));
      const button = page.document.querySelector('[data-ops-tab="fixture_ledger"]');
      assert.equal(button.querySelector('path').getAttribute('d'), 'M4 4h16v16H4z');
      assert.match(button.textContent, /Fixture ledger/);
    } else {
      page.api.install();
      assert.ok(!tabs(page).includes('fixture_ledger'));
      page.api.go('fixture_ledger');
      assert.equal(page.api.S.active, 'my_day', 'a crew member cannot open a business screen by name');
      assert.equal(screen.calls.mount.length, 0);
    }
  }
});

test('crew-visible and owner-only screens follow the viewer, not the nav group', () => {
  const crew = hubPage(CREW), shipped = new Set(crew.context.EGCHubScreens.list().map(entry => entry.id));
  crew.context.EGCHubScreens.register({ ...fixtureScreen().spec, id: 'fixture_crew', group: 'MY EGC', label: 'Fixture crew', capability: undefined, crewVisible: true });
  crew.context.EGCHubScreens.register({ ...fixtureScreen().spec, id: 'fixture_owner', group: 'SYSTEM', label: 'Fixture owner', capability: 'owner' });
  const crewNav = crew.api.visibleNav();
  assert.deepEqual([...crewNav.map(item => item[1])].filter(id => !shipped.has(id)).slice(-2), ['onboarding', 'fixture_crew']);
  assert.ok(crewNav.some(item => item[1] === 'crew_alerts'), 'the shipped Schedule alerts screen is crew-visible');
  assert.ok(!crewNav.some(item => item[1] === 'fixture_owner'));
  assert.deepEqual([...crew.api.hubCapabilities()], ['crew']);
  const manager = hubPage(MANAGER);
  manager.context.EGCHubScreens.register({ ...fixtureScreen().spec, id: 'fixture_owner', group: 'SYSTEM', label: 'Fixture owner', capability: 'owner' });
  assert.ok(!manager.api.canView('fixture_owner'), 'business access is not owner access');
  const owner = hubPage();
  owner.context.EGCHubScreens.register({ ...fixtureScreen().spec, id: 'fixture_owner', group: 'SYSTEM', label: 'Fixture owner', capability: 'owner' });
  assert.ok(owner.api.canView('fixture_owner'));
  assert.deepEqual([...owner.api.hubCapabilities()], ['crew', 'business', 'owner']);
});

test('render lazily loads the kit then the screen once, mounts with the Hub context and unmounts on navigation', async () => {
  const page = hubPage(), requested = [], mounts = [];
  let unmounts = 0;
  page.document.onAsset = node => {
    const url = node.getAttribute('src') || node.getAttribute('href');
    requested.push(url);
    if (url.startsWith('employee-ui-kit.js')) page.context.EGCHubKit = { ready: true };
    if (url.startsWith('fixture-lazy.js')) page.context.EGCFixtureLazy = { mount(host, ctx) { mounts.push({ host, ctx }); host.append(page.document.createElement('article')); }, unmount() { unmounts++; }, canLeave: () => true };
    queueMicrotask(() => node.onload());
  };
  page.context.EGCHubScreens.register({ id: 'fixture_lazy', group: 'SYSTEM', label: 'Fixture lazy', capability: 'business', load: { js: 'fixture-lazy.js', css: 'fixture-lazy.css', v: 't1' }, module: 'EGCFixtureLazy' });
  page.api.install();
  await page.flush();
  page.api.go('fixture_lazy');
  assert.ok(page.main().querySelector('.hub-screen-loading'), 'a skeleton shows while assets load');
  await page.flush();
  assert.deepEqual(requested.sort(), ['employee-ui-kit.css?v=20260929mobilehub', 'employee-ui-kit.js?v=20260929mobilehub', 'fixture-lazy.css?v=t1', 'fixture-lazy.js?v=t1']);
  assert.equal(mounts.length, 1);
  const { host, ctx } = mounts[0];
  assert.equal(host, page.main());
  assert.equal(ctx.identity, 'ZacB');
  assert.equal(ctx.role, 'owner');
  assert.deepEqual([...ctx.capabilities], ['crew', 'business', 'owner']);
  assert.equal(ctx.screen, 'fixture_lazy');
  for (const key of ['hubFetch', 'toast', 'askAction', 'go']) assert.equal(typeof ctx[key], 'function', key);
  assert.equal(page.document.querySelector('#ops-title').textContent, 'Fixture lazy');
  assert.equal(page.document.querySelector('#ops-kicker').textContent, 'SYSTEM');

  page.api.render();
  page.context.refresh?.();
  await page.flush();
  assert.equal(mounts.length, 1, 'background renders keep the mounted screen');
  assert.equal(host.querySelector('article')?.tagName, 'ARTICLE');

  page.api.go('customers');
  assert.equal(unmounts, 1);
  assert.match(page.main().textContent, /Every promise and visit in one place/);
  page.api.go('fixture_lazy');
  await page.flush();
  assert.equal(mounts.length, 2);
  assert.equal(requested.length, 4, 'assets load once per page');
});

test('a registered screen that cannot leave blocks go() until its changes are finished', async () => {
  const page = hubPage(), screen = fixtureScreen();
  page.context.EGCHubKit = {};
  page.context.EGCHubScreens.register(screen.spec);
  page.api.install();
  page.api.go('fixture_ledger');
  await page.flush();
  assert.equal(screen.calls.mount.length, 1);
  screen.state.dirty = true;
  page.api.go('customers');
  assert.equal(page.api.S.active, 'fixture_ledger');
  assert.equal(screen.calls.unmount, 0);
  assert.match(page.toasts.at(-1), /Finish or save the changes/);
  screen.state.dirty = false;
  page.api.go('customers');
  assert.equal(page.api.S.active, 'customers');
  assert.equal(screen.calls.unmount, 1);
});

test('signing out unmounts the active registered screen', async () => {
  const page = hubPage(), screen = fixtureScreen();
  page.context.EGCHubKit = {};
  page.context.EGCHubScreens.register(screen.spec);
  page.api.install();
  page.api.go('fixture_ledger');
  await page.flush();
  assert.equal(page.context.EGCHubScreens.current().mounted, true);
  page.fire('egc:signout');
  assert.equal(screen.calls.unmount, 1);
  assert.equal(page.context.EGCHubScreens.current(), null);
  assert.equal(page.api.S.installed, false);
});

test('a screen whose files fail to load shows unavailable with Retry, never an empty screen', async () => {
  const page = hubPage();
  let broken = true, mounted = 0;
  page.document.onAsset = node => {
    const url = node.getAttribute('src') || node.getAttribute('href') || '';
    if (url.startsWith('employee-ui-kit.js')) page.context.EGCHubKit = {};
    if (url.startsWith('fixture-broken.js') && !broken) page.context.EGCFixtureBroken = { mount() { mounted++; }, unmount() {} };
    queueMicrotask(() => (url.startsWith('fixture-broken.js') && broken ? node.onerror() : node.onload()));
  };
  page.context.EGCHubScreens.register({ id: 'fixture_broken', group: 'SYSTEM', label: 'Fixture broken', capability: 'business', load: { js: 'fixture-broken.js', v: 't1' }, module: 'EGCFixtureBroken' });
  page.api.install();
  page.api.go('fixture_broken');
  await page.flush();
  const alert = page.main().querySelector('[role="alert"]');
  assert.match(alert.textContent, /Fixture broken is unavailable/);
  assert.equal(page.document.querySelectorAll('script[data-egc-hub-asset="fixture-broken.js"]').length, 0, 'a failed script tag is removed so Retry can load it again');
  page.api.render();
  await page.flush();
  assert.ok(page.main().querySelector('[role="alert"]'), 'background renders keep the failure visible instead of looping');
  broken = false;
  alert.querySelector('button').click();
  await page.flush();
  assert.equal(mounted, 1);
});

test('registration rejects ambiguous access, unsafe asset paths and markup in labels', () => {
  const page = hubPage(), registry = page.context.EGCHubScreens, base = fixtureScreen().spec;
  // Screens shipped in MANIFEST (FUN-19 stocked_costs, TEAM-UI staff) register first; none of the invalid specs may join them.
  const shipped = registry.list().map(entry => entry.id);
  registry.register(base);
  const registered = [...registry.list().map(entry => entry.id)];
  assert.ok(registered.includes('fixture_ledger'));
  const invalid = [
    { ...base },
    { ...base, id: 'Bad-Id' },
    { ...base, id: 'no_access', capability: undefined },
    { ...base, id: 'both_access', crewVisible: true },
    { ...base, id: 'cross_origin', mount: undefined, module: 'EGCCross', load: { js: 'https://example.invalid/x.js', v: '1' } },
    { ...base, id: 'protocol_relative', mount: undefined, module: 'EGCCross', load: { js: '//example.invalid/x.js', v: '1' } },
    { ...base, id: 'parent_path', mount: undefined, module: 'EGCCross', load: { js: '../x.js', v: '1' } },
    { ...base, id: 'bad_version', load: { css: 'x.css', v: 'a b' } },
    { ...base, id: 'markup_label', label: '<img src=x onerror=alert(1)>' },
    { ...base, id: 'bad_icon', iconPath: '"/><script>' },
    { ...base, id: 'no_mount', mount: undefined },
  ];
  for (const spec of invalid) assert.throws(() => registry.register(spec), /Hub screen registry/, spec.id);
  assert.deepEqual([...registry.list().map(entry => entry.id)], [...shipped, 'fixture_ledger']);
  assert.deepEqual([...registry.list().map(entry => entry.id)], registered, 'no invalid spec registered (shipped MANIFEST screens stay as they were)');
  assert.ok(Object.isFrozen(registry.get('fixture_ledger')));
});

test('capabilities come from the signed-in server profile, never from a client staff list', () => {
  const cases = [
    [{ user: 'ZacB', business: false, role: 'owner', owner: false }, ['crew']],
    [{ user: 'ZacB', business: false, role: 'owner', owner: true }, ['crew'], 'an owner flag without business access grants nothing'],
    [{ user: 'Synthetic.Lead', business: true, role: 'manager', owner: false }, ['crew', 'business'], 'a user on no hard-coded list still gets business from the profile'],
    [{ user: 'Synthetic.Partner', business: true, role: 'manager', owner: true }, ['crew', 'business', 'owner']],
    [{ user: '', business: true, role: 'owner', owner: true }, ['crew'], 'a grant without a signed-in user is ignored'],
  ];
  for (const [who, expected, why] of cases) {
    const page = hubPage(who);
    page.context.EGCHubScreens.register({ ...fixtureScreen().spec, id: 'fixture_owner', group: 'SYSTEM', label: 'Fixture owner', capability: 'owner' });
    assert.deepEqual([...page.api.hubCapabilities()], expected, why || JSON.stringify(who));
    assert.equal(page.api.canView('fixture_owner'), expected.includes('owner'), JSON.stringify(who));
    assert.equal(page.api.canView('finance'), expected.includes('business'), 'built-in business views follow the same profile');
  }
  const page = hubPage({ user: 'Synthetic.Lead', business: true, role: 'manager', owner: false });
  page.session.setItem('egc_owner', 'true');
  assert.deepEqual([...page.api.hubCapabilities()], ['crew', 'business', 'owner'], 'the stored profile is read on every check, so sign-in changes apply at once');
  page.session.setItem('egc_business_access', 'false');
  assert.deepEqual([...page.api.hubCapabilities()], ['crew']);
});

test("labels are plain text: '&' and quotes are accepted and escaped by the shell, markup and control characters are refused", () => {
  const page = hubPage(), registry = page.context.EGCHubScreens, base = fixtureScreen().spec;
  registry.register({ ...base, id: 'fixture_estimates', group: 'CLIENT WORK', label: 'Estimates & payments' });
  registry.register({ ...base, id: 'fixture_quotes', group: 'R&D "lab"', label: "Owner's \"quick\" quotes" });
  for (const label of ['<b>x</b>', 'Tab\there', 'Line\nbreak', 'Back`tick', 'Nul\u0000', 'Del\u007f']) assert.throws(() => registry.register({ ...base, id: 'fixture_bad', label }), /Hub screen registry/, JSON.stringify(label));
  page.api.install();
  const button = id => page.document.querySelector(`[data-ops-tab="${id}"]`);
  assert.equal(button('fixture_estimates').querySelector('span').textContent, 'Estimates & payments');
  assert.equal(button('fixture_quotes').querySelector('span').textContent, "Owner's \"quick\" quotes");
  assert.ok(page.document.querySelectorAll('.ops-nav-label').some(node => node.textContent === 'R&D "lab"'), 'group labels are escaped too');
  assert.equal(page.document.querySelectorAll('.ops-nav script, .ops-nav b, .ops-nav img').length, 0);
  assert.equal(button('safety').querySelector('span').textContent, 'Safety & equipment', 'built-in labels go in the same way');
  assert.equal(button('finance').querySelector('span').textContent, 'Estimates & payments');
  assert.equal(page.document.querySelector('.ops-nav').innerHTML, '', 'the nav is built with textContent, never an HTML string');
  button('fixture_estimates').click();
  assert.equal(page.api.S.active, 'fixture_estimates', 'a nav button opens its view');
  assert.equal(page.document.querySelector('#ops-title').textContent, 'Estimates & payments');
  assert.match(button('fixture_estimates').className, /\bactive\b/);
  assert.equal(button('fixture_estimates').type, 'button');
  assert.equal(button('fixture_estimates').querySelector('path').getAttribute('d'), 'M4 4h16v16H4z');
});

test('one invalid MANIFEST line is skipped with a console warning and every other screen still registers', () => {
  const source = readFileSync(new URL('../employee-hub-screens.js', import.meta.url), 'utf8');
  // Screens have landed (FUN-19 stocked_costs, TEAM-UI staff, P3-04 followup_settings), so the fixtures are appended after the shipped lines, and
  // every shipped line must itself register cleanly.
  const manifest = /const MANIFEST=\[\n((?:\{[^\n]*\},\n)*)\];/.exec(source);
  assert.ok(manifest, 'MANIFEST keeps one {...}, line per screen');
  const shipped = [...manifest[1].matchAll(/^\{id:'([a-z][a-z0-9_]+)'/gm)].map(match => match[1]);
  for (const id of ['stocked_costs', 'staff', 'followup_settings', 'dispatch_rules']) assert.ok(shipped.includes(id), `${id} ships in MANIFEST`);
  // P3-04: the shipped source itself registers every MANIFEST line with no warnings, one screen per line.
  const shippedWarnings = [], shippedContext = { document: createDocument(), console: { warn: (...args) => shippedWarnings.push(args.join(' ')), error() {}, log() {} }, addEventListener() {}, Promise, Map, Set, Error, Object, String, Array };
  shippedContext.window = shippedContext;
  vm.runInNewContext(source, shippedContext, { filename: 'employee-hub-screens.js' });
  assert.deepEqual(shippedWarnings, [], 'every shipped MANIFEST line registers');
  assert.deepEqual([...shippedContext.EGCHubScreens.list().map(entry => entry.id)], shipped, 'one registered screen per shipped line');
  const lines = [
    "{id:'fixture_first',group:'SYSTEM',label:'First & foremost',capability:'business',mount(){}}",
    "{id:'Bad Id',group:'SYSTEM',label:'Broken',capability:'business',mount(){}}",
    "{id:'fixture_markup',group:'SYSTEM',label:'<img src=x>',capability:'business',mount(){}}",
    "null",
    "{id:'fixture_first',group:'SYSTEM',label:'Duplicate',capability:'business',mount(){}}",
    "{id:'fixture_last',group:'MY EGC',label:'Last one',crewVisible:true,mount(){}}",
  ];
  const warnings = [], errors = [], listeners = {};
  const context = { document: createDocument(), console: { warn: (...args) => warnings.push(args.join(' ')), error: (...args) => errors.push(args), log() {} }, addEventListener: (name, listener) => { (listeners[name] ||= []).push(listener); }, Promise, Map, Set, Error, Object, String, Array };
  context.window = context;
  vm.runInNewContext(source.replace(manifest[0], `const MANIFEST=[\n${manifest[1]}${lines.join(',\n')}\n];`), context, { filename: 'employee-hub-screens.js' });
  assert.deepEqual([...context.EGCHubScreens.list().map(entry => entry.id)], [...shipped, 'fixture_first', 'fixture_last']);
  assert.equal(context.EGCHubScreens.get('fixture_first').label, 'First & foremost');
  assert.equal(warnings.length, 4, warnings.join('\n'));
  assert.ok(warnings.every(line => /Hub screen registry skipped a MANIFEST entry: Hub screen registry: /.test(line)), warnings.join('\n'));
  assert.match(warnings.join('\n'), /invalid screen id/);
  assert.match(warnings.join('\n'), /fixture_markup needs a nav group and label/);
  assert.match(warnings.join('\n'), /fixture_first is already registered/);
  assert.deepEqual(errors, []);
  assert.equal(typeof listeners['egc:signout']?.[0], 'function', 'the registry finished installing after the bad lines');
});

test('the shipped screens register cleanly for business viewers only and lazy-load their own files', () => {
  const warnings = [], context = { document: createDocument(), console: { warn: (...args) => warnings.push(args.join(' ')), error() {}, log() {} }, addEventListener() {}, Promise, Map, Set, Error, Object, String, Array };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../employee-hub-screens.js', import.meta.url), 'utf8'), context, { filename: 'employee-hub-screens.js' });
  assert.deepEqual(warnings, []);
  const registry = context.EGCHubScreens;
  assert.deepEqual([...registry.list().map(entry => entry.id)], [...CREW_SHIPPED, ...PASSWORD_SHIPPED, ...OWNER_SHIPPED, ...SHIPPED]);
  const password = registry.get('password');
  assert.deepEqual([password.group, password.label, password.capability, password.crewVisible, password.module, password.load.js, password.load.css], ['MY EGC', 'Password', 'password', false, 'EGCStaffAccess', 'employee-staff-access.js', 'employee-staff-access.css']);
  assert.ok(!registry.allowed(password, ['crew', 'business', 'owner']) && registry.allowed(password, ['crew', 'password']));
  for (const id of OWNER_SHIPPED) assert.equal(registry.get(id).capability, 'owner', id);
  const invoicing = registry.get('invoicing');
  assert.deepEqual([invoicing.group, invoicing.label, invoicing.capability, invoicing.crewVisible, invoicing.module, invoicing.load.js, invoicing.load.css], ['CLIENT WORK', 'Invoicing', 'business', false, 'EGCMoney', 'employee-money.js', 'employee-money.css']);
  assert.ok(!registry.allowed(invoicing, ['crew']) && registry.allowed(invoicing, ['crew', 'business']));
  const money = { addEventListener() {} };
  money.window = money;
  vm.runInNewContext(readFileSync(new URL(`../${invoicing.load.js}`, import.meta.url), 'utf8'), money, { filename: invoicing.load.js });
  assert.deepEqual(Object.keys(money[invoicing.module]).sort(), ['canLeave', 'mount', 'refresh', 'unmount'], 'the Invoicing module provides the screen API');
  assert.ok(readFileSync(new URL(`../${invoicing.load.css}`, import.meta.url), 'utf8').length > 0, invoicing.load.css);
  const reviews = registry.get('reviews'), templates = registry.get('message_templates');
  assert.deepEqual([reviews.group, reviews.label, reviews.capability, reviews.module, reviews.load.js, reviews.load.css], ['RUN THE BUSINESS', 'Review queues', 'business', 'EGCReviews', 'employee-reviews.js', 'employee-reviews.css']);
  assert.deepEqual([templates.group, templates.label, templates.capability, templates.module, templates.load.js, templates.load.css], ['SYSTEM', 'Message templates', 'business', 'EGCMessageTemplates', 'message-templates.js', 'message-templates.css']);
  assert.match(readFileSync(new URL('../message-templates.js', import.meta.url), 'utf8'), /window\.EGCMessageTemplates = \{ mount, unmount, refresh, canLeave \}/, 'the standalone templates page module is the Hub screen');
  for (const [who, visible] of [[CREW, false], [MANAGER, true], [{}, true]]) {
    const page = hubPage(who), nav = page.api.visibleNav().map(item => item[1]);
    for (const id of SHIPPED) assert.equal(nav.includes(id), visible, `${id} for ${JSON.stringify(who)}`);
    for (const id of CREW_SHIPPED) assert.ok(nav.includes(id), `${id} for ${JSON.stringify(who)}`);
    if (visible) assert.ok(nav.indexOf('reviews') > nav.indexOf('delivery') && nav.indexOf('message_templates') > nav.indexOf('settings'), 'each joins the end of its nav group');
  }
});
