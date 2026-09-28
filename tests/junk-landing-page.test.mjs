import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Google Ads junk-removal landing page (/junk-removal-quote) and its
// conversion page (/junk-removal-quote-thanks). Nothing here submits a form,
// loads a vendor tag, or contacts HighLevel.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const LP = 'junk-removal-quote.html';
const THANKS = 'junk-removal-quote-thanks.html';
const lp = read(LP);
const thanks = read(THANKS);

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-zA-Z_:-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']));
const formHtml = lp.match(/<form\b[^>]*class="lead-form-lite"[^>]*>[\s\S]*?<\/form>/)[0];
const formTag = attrs(formHtml.match(/<form\b[^>]*>/)[0]);
const inputs = [...formHtml.matchAll(/<input\b[^>]*>/g)].map((m) => attrs(m[0]));
const byName = (name) => inputs.filter((i) => i.name === name);
const one = (name) => { const found = byName(name); assert.equal(found.length, 1, `exactly one ${name} input`); return found[0]; };
const inlineScripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const IN_AREA = ['80521', '80522', '80523', '80524', '80525', '80526', '80527', '80528', '80537', '80538', '80539', '80550', '80551', '80547', '80549', '80546', '80535'];

test('both pages stay out of the index; the landing page keeps its canonical', () => {
  assert.match(lp, /<meta name="robots" content="noindex, follow">/);
  assert.match(lp, /<link rel="canonical" href="https:\/\/easygaragecleaning\.com\/junk-removal-quote">/);
  assert.match(lp, /<title>Junk Removal Fort Collins \| Flat Rate, Priced On-Site<\/title>/);
  assert.match(thanks, /<meta name="robots" content="noindex, nofollow">/);
  for (const html of [lp, thanks]) {
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /<nav\b/, 'paid pages carry no navigation menu');
  }
});

test('the lead form keeps the native Web3Forms POST contract', () => {
  assert.equal((lp.match(/<form\b/g) || []).length, 1);
  assert.equal(formTag.action, 'https://api.web3forms.com/submit');
  assert.equal(formTag.method, 'POST');

  const name = one('name');
  assert.equal(name.type, 'text');
  assert.equal(name.autocomplete, 'given-name');
  assert.ok('required' in name);
  const phone = one('phone');
  assert.equal(phone.type, 'tel');
  assert.equal(phone.autocomplete, 'tel');
  assert.ok('required' in phone);
  const zip = one('serviceZip');
  assert.equal(zip.inputmode, 'numeric');
  assert.equal(zip.pattern, '[0-9]{5}');
  assert.equal(zip.autocomplete, 'postal-code');
  assert.ok('required' in zip);
  for (const field of [name, phone, zip]) assert.match(lp, new RegExp(`<label for="${field.id}">`), `${field.name} has a label`);

  const services = byName('Service type');
  assert.deepEqual(services.map((i) => i.value), ['Single item', 'A few items', 'Partial load', 'Garage or full cleanout', 'Hot tub', 'Not sure']);
  assert.ok(services.every((i) => i.type === 'radio'));
  assert.ok(services.some((i) => 'required' in i), 'the service group is required');
  assert.ok(services.every((i) => !('checked' in i)), 'no service is preselected without a variant');
  const timing = byName('preferred_timing');
  assert.deepEqual(timing.map((i) => i.value), ['Soonest available', 'This week', 'Next week or later']);
  assert.ok(timing.every((i) => i.type === 'radio' && !('required' in i) && !('checked' in i)));

  const consent = one('sms_consent');
  assert.equal(consent.type, 'checkbox');
  assert.equal(consent.value, 'yes');
  assert.ok(!('checked' in consent), 'SMS consent must start unchecked');
  assert.ok(formHtml.includes('I agree to receive text messages from Easy Garage Cleaning about my quote and appointment at the number provided. Consent is not a condition of purchase. Message frequency varies, msg &amp; data rates may apply. Reply STOP to opt out or HELP for help. See our <a href="/privacy-policy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="/terms-of-service" target="_blank" rel="noopener">Terms of Service</a>.'));

  const siteKey = read('ads.html').match(/name="access_key" value="([^"]+)"/)[1];
  const hidden = { access_key: siteKey, subject: 'Google Ads junk lead', from_name: 'EGC Website', redirect: 'https://easygaragecleaning.com/junk-removal-quote-thanks', source: 'google-junk-lp', page_service: 'junk', page_variant: 'default', request_id: '', in_service_area: '', items: '' };
  for (const [key, value] of Object.entries(hidden)) {
    const input = one(key);
    assert.equal(input.type, 'hidden', `${key} is hidden`);
    assert.equal(input.value, value, `${key} default`);
  }
  const bot = one('botcheck');
  assert.equal(bot.type, 'checkbox');
  assert.ok('hidden' in bot && bot.tabindex === '-1');

  const buttons = [...formHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0][0], /type="submit"/);
  assert.equal(buttons[0][1], 'Book My Pickup Window');
  assert.ok(formHtml.includes("No obligation. We'll text or call to lock your window. Mon–Sat 7am–7pm."));
});

test('both pages pin the current relay and analytics loader versions', () => {
  const head = lp.split('</head>')[0];
  assert.ok(head.includes('<script src="/analytics-loader.js?v=20260928a" data-eager="1" defer></script>'), 'a paid landing page measures short ad-click visits');
  assert.ok(lp.includes('<script src="/fb-capture.js?v=20260928a" defer></script>'));
  assert.ok(thanks.split('</head>')[0].includes('<script src="/analytics-loader.js?v=20260928a" data-eager="1" defer></script>'));
  for (const html of [lp, thanks]) {
    for (const [ref] of html.matchAll(/\/(?:fb-capture|analytics-loader)\.js(?:\?v=[^"']*)?/g)) assert.ok(ref.endsWith('?v=20260928a'), ref);
    assert.doesNotMatch(html, /googletagmanager\.com\/gtag\/js|connect\.facebook\.net|clarity\.ms/, 'vendor tags only load through analytics-loader.js');
    assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"|fonts\.googleapis\.com|fonts\.gstatic\.com/, 'no render-blocking stylesheet or web font');
  }
  assert.doesNotMatch(thanks, /fb-capture\.js/, 'the thanks page has no lead form to mirror');
});

test('the landing page never cancels the native submit', () => {
  assert.doesNotMatch(lp, /preventDefault/);
  assert.doesNotMatch(lp, /\.submit\(\)|fetch\(\s*['"]https:\/\/api\.web3forms/);
});

test('only the HighLevel number (970) 999-1818 appears on either page', () => {
  for (const html of [lp, thanks]) {
    const links = [...html.matchAll(/href="(?:tel|sms):([^"?]*)/g)].map((m) => m[1]);
    assert.ok(links.length >= 2);
    for (const number of links) assert.equal(number, '+19709991818');
    for (const [shown] of html.matchAll(/\(\d{3}\)\s?\d{3}-\d{4}/g)) assert.equal(shown, '(970) 999-1818');
    assert.doesNotMatch(html, /658-?9454|6589454/);
  }
  assert.ok(lp.includes('href="sms:+19709991818?&amp;body=Hi!%20I%20need%20junk%20hauled.%20My%20ZIP%20is%20"'));
  assert.ok(thanks.includes('href="sms:+19709991818?&amp;body=Hi!%20Here%27s%20a%20photo%20of%20what%20needs%20to%20go."'));
});

test('copy follows the price-confirmed-on-site policy', () => {
  const forbidden = [/photo[- ]quotes?/i, /quotes? from (?:your )?photos/i, /\b5[- ]min(?:ute)?\b/i, /reply within 5 minutes/i, /firm (?:flat )?price/i];
  for (const html of [lp, thanks]) for (const pattern of forbidden) assert.doesNotMatch(html, pattern);
  for (const range of ['$99–150', '$250–400', '$400–650', '$650+', '$400–800']) assert.ok(lp.includes(range), range);
  assert.ok(lp.includes('Flat rate confirmed on-site before we lift anything. Loading, hauling, disposal, donation drop-off and sweep-up included.</p>'));
  // No promise the business has not confirmed: arrival windows, one-visit estates, weight pricing.
  for (const html of [lp, thanks]) assert.doesNotMatch(html, /2-hour|two-hour|one visit|priced by weight|booked online/i);
  assert.ok(lp.includes('If you decide not to go ahead, you owe nothing.'));
  assert.ok(lp.includes('Insured Colorado LLC'));
  assert.doesNotMatch(lp, /★|\b\d(?:\.\d)? stars?\b|\d+\+? (?:Google )?reviews/i, 'no unverified ratings or review counts');
});

test('the page is light, and tables and images keep the release-safe markup', () => {
  assert.ok(Buffer.byteLength(lp) < 40 * 1024, `landing page is ${Buffer.byteLength(lp)} bytes`);
  for (const [table] of lp.matchAll(/<table\b[^>]*>/g)) assert.ok(lp.includes(`<div class="compare-scroll">${table}`), 'tables are pre-wrapped for the site guard');
  for (const [img] of lp.matchAll(/<img\b[^>]*>/g)) {
    const a = attrs(img);
    assert.ok(a.alt && a.width && a.height, img);
    assert.equal(a.loading, 'lazy');
    assert.match(a.src, /^\/images\/job-/, 'only real job photos');
  }
  assert.doesNotMatch(lp, /gallery-ideal-assets|gallery-preview-assets|internal-gallery-assets/);
  assert.doesNotMatch(lp, /^[ \t]+$/m, 'no whitespace-only lines for the generator to strip');
});

test('the landing page and fb-capture share one in-area ZIP list', () => {
  const zipsIn = (source) => [...source.match(/SERVICE_ZIPS = \{([\s\S]*?)\};/)[1].matchAll(/'(\d{5})'/g)].map((m) => m[1]).sort();
  assert.deepEqual(zipsIn(lp), [...IN_AREA].sort());
  assert.deepEqual(zipsIn(read('fb-capture.js')), [...IN_AREA].sort());
});

// Minimal DOM built from the page's real form markup.
function landingHarness(search) {
  const listeners = {};
  const on = (target) => (type, fn) => { (target.__l[type] ||= []).push(fn); };
  const node = (props = {}) => { const n = { __l: {}, textContent: '', ...props }; n.addEventListener = on(n); return n; };
  const fields = inputs.map((a) => node({ name: a.name, type: a.type, value: a.value ?? '', id: a.id, checked: 'checked' in a, disabled: false, validationMessage: '', setCustomValidity(m) { this.validationMessage = m; } }));
  const form = node({
    querySelector(selector) {
      const m = selector.match(/^input\[name="([^"]+)"\](?:\[value="([^"]+)"\])?(:checked)?$/);
      assert.ok(m, `unsupported selector ${selector}`);
      return fields.find((f) => f.name === m[1] && (!m[2] || f.value === m[2]) && (!m[3] || f.checked)) || null;
    },
  });
  const ids = { 'lp-form': form, 'lp-h1': node({ textContent: 'default h1' }), 'lp-sub': node({ textContent: 'default sub' }), 'lp-submit': node({ textContent: 'Book My Pickup Window' }), 'lp-sticky': node(), 'hero-ctas': node() };
  for (const f of fields) if (f.id) ids[f.id] = f;
  const session = new Map();
  const window = {
    __l: listeners,
    location: { search },
    URLSearchParams,
    setTimeout: (fn) => fn(),
    crypto: { randomUUID: () => 'rid-0000-1111-2222' },
    sessionStorage: { setItem: (k, v) => session.set(k, v), getItem: (k) => session.get(k) ?? null },
    document: { getElementById: (id) => ids[id] || null, querySelectorAll: () => [], addEventListener() {} },
  };
  window.addEventListener = on(window);
  window.window = window;
  const context = vm.createContext(window);
  for (const script of inlineScripts(lp)) vm.runInContext(script, context);
  const value = (name) => fields.find((f) => f.name === name).value;
  const check = (name, v) => { for (const f of fields.filter((f) => f.name === name)) f.checked = f.value === v; };
  const set = (id, v) => { ids[id].value = v; (ids[id].__l.input || []).forEach((fn) => fn()); };
  const submit = () => (form.__l.submit || []).forEach((fn) => fn({ target: form }));
  const checked = (name) => fields.find((f) => f.name === name && f.checked)?.value || '';
  return { ids, value, check, set, submit, checked, session, fields };
}

test('?v= variants swap fixed copy and tag the lead without echoing URL text', () => {
  const cases = {
    furniture: ['Couch & Furniture Removal\u00a0— Flat $99–150 Per Item', 'furniture', 'Single item'],
    couch: ['Couch & Furniture Removal\u00a0— Flat $99–150 Per Item', 'furniture', 'Single item'],
    appliance: ['Appliance & Fridge Removal\u00a0— Flat $99–150', 'appliance', 'Single item'],
    hottub: ['Hot Tub Removal\u00a0— Cut Up & Hauled, $400–800', 'hot-tub', 'Hot tub'],
    'hot-tub': ['Hot Tub Removal\u00a0— Cut Up & Hauled, $400–800', 'hot-tub', 'Hot tub'],
    garage: ['Garage Junk Hauled Away\u00a0— Most Garages $400–650', 'garage-cleanout', 'Garage or full cleanout'],
    fast: ['Need Junk Gone Fast? Book the Soonest Window', 'junk', ''],
    yard: ['Yard Debris & Brush Haul-Away\u00a0— Flat Rate', 'yard', ''],
    estate: ['Estate & House Cleanouts\u00a0— Flat Rate, Priced On-Site', 'estate', 'Garage or full cleanout'],
  };
  for (const [v, [h1, service, pick]] of Object.entries(cases)) {
    const page = landingHarness(`?v=${v}&gclid=abc`);
    assert.equal(page.ids['lp-h1'].textContent, h1, v);
    assert.notEqual(page.ids['lp-sub'].textContent, 'default sub', v);
    assert.equal(page.value('page_service'), service, v);
    assert.equal(page.value('page_variant'), v);
    assert.equal(page.checked('Service type'), pick, v);
  }
  assert.equal(landingHarness('?v=fast').checked('preferred_timing'), 'Soonest available');

  const plain = landingHarness('');
  assert.equal(plain.ids['lp-h1'].textContent, 'default h1');
  assert.equal(plain.value('page_service'), 'junk');
  assert.equal(plain.value('page_variant'), 'default');

  const hostile = landingHarness(`?v=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
  assert.equal(hostile.ids['lp-h1'].textContent, 'default h1', 'unknown variants keep the default copy');
  assert.match(hostile.value('page_variant'), /^[a-z0-9-]*$/);
});

test('submit finalizes request id, service area, items and the thanks redirect', () => {
  const page = landingHarness('?v=hottub');
  page.set('f-phone', '970-555');
  assert.match(page.ids['f-phone'].validationMessage, /10-digit/, 'a short phone blocks native submission');
  page.set('f-phone', '+1 (970) 555-0111');
  assert.equal(page.ids['f-phone'].validationMessage, '');
  page.set('f-zip', '8052');
  assert.match(page.ids['f-zip'].validationMessage, /5-digit/);
  page.set('f-zip', '80525');
  page.check('preferred_timing', 'Soonest available');
  page.submit();
  assert.equal(page.value('request_id'), 'rid-0000-1111-2222');
  assert.equal(page.value('in_service_area'), 'yes');
  assert.equal(page.value('items'), 'Hot tub — Soonest available');
  assert.equal(page.value('redirect'), 'https://easygaragecleaning.com/junk-removal-quote-thanks?rid=rid-0000-1111-2222');
  assert.deepEqual(JSON.parse(page.session.get('egc_lp_lead')), { rid: 'rid-0000-1111-2222', service: 'Hot tub', page_service: 'hot-tub', variant: 'hottub', area: 'yes', consent: 'no' });
  assert.equal(page.ids['lp-submit'].disabled, true);

  page.set('f-zip', '80631');
  page.check('preferred_timing', '__none__');
  page.submit();
  assert.equal(page.value('in_service_area'), 'no');
  assert.equal(page.value('items'), 'Hot tub');
  assert.equal(page.value('redirect'), 'https://easygaragecleaning.com/junk-removal-quote-thanks?rid=rid-0000-1111-2222', 'a resubmit never stacks query strings');
  for (const zip of IN_AREA) {
    page.set('f-zip', zip);
    page.submit();
    assert.equal(page.value('in_service_area'), 'yes', zip);
  }
  // Back + resubmit is the same lead: the request id is kept, so the relay and
  // the conversion are not duplicated.
  page.fields.find((f) => f.name === 'request_id').value = 'kept-request-id-1';
  page.fields.find((f) => f.name === 'sms_consent').checked = true;
  page.submit();
  assert.equal(page.value('redirect'), 'https://easygaragecleaning.com/junk-removal-quote-thanks?rid=kept-request-id-1');
  assert.equal(JSON.parse(page.session.get('egc_lp_lead')).consent, 'yes');
});

test('the mobile sticky bar leads with the form and never covers it', () => {
  const bar = lp.match(/<div class="sticky" id="lp-sticky"[^>]*>([\s\S]*?)<\/div>/)[1];
  const links = [...bar.matchAll(/<a\b[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);
  assert.equal(links.length, 3);
  assert.match(links[0], /class="btn btn-primary" href="#book" data-book/, 'the tracked form is the main sticky action');
  assert.match(links[1], /href="tel:\+19709991818"/);
  assert.match(links[2], /href="sms:\+19709991818/);
  const script = inlineScripts(lp).join('\n');
  assert.match(script, /io\.observe\(ctas\);\s*io\.observe\(card\);/, 'the bar watches the form card as well as the hero buttons');
  assert.match(script, /bar\.classList\.toggle\('show', heroGone && !cardOn\)/);
  assert.match(lp, /\.chips\.err legend\{/, 'an unanswered required choice is visibly marked');
});

test('the site CSP lets the Google Ads tag on these pages reach its endpoints', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const response = await onRequest({ request: new Request('https://easygaragecleaning.com/junk-removal-quote'), next: async () => new Response('ok') });
  const csp = Object.fromEntries((response.headers.get('content-security-policy') || '').split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  for (const host of ['https://www.googleadservices.com', 'https://googleads.g.doubleclick.net', 'https://www.google.com']) assert.ok(csp['script-src'].includes(host), `script-src ${host}`);
  for (const host of ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com', 'https://*.g.doubleclick.net', 'https://www.google.com', 'https://www.googleadservices.com']) assert.ok(csp['connect-src'].includes(host), `connect-src ${host}`);
  for (const host of ['https://td.doubleclick.net', 'https://www.googletagmanager.com']) assert.ok(csp['frame-src'].includes(host), `frame-src ${host}`);
  assert.ok(csp['frame-ancestors'].includes("'none'"));
});

function thanksHarness(search, { lead, local = new Map(), blocked = false } = {}) {
  const session = new Map(lead ? [['egc_lp_lead', JSON.stringify(lead)]] : []);
  const els = { 'out-of-area': { hidden: true }, rid: { textContent: '' }, 'rid-line': { hidden: true }, 'thanks-h1': { textContent: 'default h1' }, 'step-1': { textContent: 'default step' } };
  const deny = () => { throw new Error('storage blocked'); };
  const window = {
    location: { search },
    URLSearchParams,
    sessionStorage: blocked ? { getItem: deny, setItem: deny } : { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    localStorage: { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, v) },
    document: { readyState: 'complete', getElementById: (id) => els[id], addEventListener() {} },
  };
  window.window = window;
  const context = vm.createContext(window);
  for (const script of inlineScripts(thanks)) vm.runInContext(script, context);
  const events = (window.dataLayer || []).map((args) => Array.from(args)).filter((args) => args[0] === 'event');
  return { els, events, local };
}

test('the thanks page fires one generate_lead per request id with a service-based value', () => {
  assert.match(thanks, /<h1 id="thanks-h1">Got it — we'll text or call you shortly to lock your window\.<\/h1>/);
  assert.doesNotMatch(thanks, /content="[^"]*text you shortly/, 'the meta description promises no text');
  assert.ok(thanks.includes("Mon–Sat 7am–7pm. After hours? We'll reply first thing."));
  assert.match(thanks, />Text us a photo \(optional\)</);
  assert.match(thanks, /gtag\('event', 'generate_lead', \{\s*transaction_id: rid/);

  // Expected revenue × the 0.35 close rate.
  const values = { 'Single item': 44, 'A few items': 114, 'Partial load': 114, 'Garage or full cleanout': 184, 'Hot tub': 210, 'Not sure': 88 };
  for (const [service, value] of Object.entries(values)) {
    const rid = `rid-${value}-${service.length}-abcdef`;
    const page = thanksHarness(`?rid=${rid}`, { lead: { rid, service, variant: 'furniture', area: 'yes' } });
    assert.equal(page.events.length, 1, service);
    assert.equal(page.events[0][1], 'generate_lead');
    assert.deepEqual({ ...page.events[0][2] }, { transaction_id: rid, value, currency: 'USD', page_variant: 'furniture', in_service_area: 'yes' });
    assert.equal(page.els.rid.textContent, rid);
    assert.equal(page.els['rid-line'].hidden, false);
  }

  // "Not sure" on an item variant is valued like the item, as in HighLevel.
  const notSure = thanksHarness('?rid=rid-notsure-123', { lead: { rid: 'rid-notsure-123', service: 'Not sure', page_service: 'hot-tub', variant: 'hottub', area: 'yes' } });
  assert.equal(notSure.events[0][2].value, 210);

  const local = new Map();
  const first = thanksHarness('?rid=rid-repeat-12345', { lead: { rid: 'rid-repeat-12345', service: 'Hot tub', variant: 'hottub', area: 'no' }, local });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0][2].value, 0, 'an out-of-area lead carries no bidding value');
  assert.equal(first.els['out-of-area'].hidden, false);
  const reload = thanksHarness('?rid=rid-repeat-12345', { lead: { rid: 'rid-repeat-12345', service: 'Hot tub', variant: 'hottub', area: 'no' }, local });
  assert.equal(reload.events.length, 0, 'a reload or back-navigation never double counts');

  const missing = thanksHarness('', { lead: { rid: 'rid-stored-12345', service: 'Hot tub' } });
  assert.equal(missing.events.length, 0, 'no rid, no conversion');
  assert.equal(missing.els['rid-line'].hidden, true);
  const junk = thanksHarness(`?rid=${encodeURIComponent('<script>alert(1)</script>')}`);
  assert.equal(junk.events.length, 0, 'a malformed rid is ignored');
  assert.equal(junk.els.rid.textContent, '');

  const shared = thanksHarness('?rid=rid-unknown-12345');
  assert.equal(shared.events.length, 0, 'a shared or bookmarked thanks URL never counts a conversion');
  const otherLead = thanksHarness('?rid=rid-unknown-12345', { lead: { rid: 'rid-someone-else', service: 'Hot tub' } });
  assert.equal(otherLead.events.length, 0);
  const blocked = thanksHarness('?rid=rid-blocked-12345', { blocked: true });
  assert.equal(blocked.events.length, 1, 'with session storage blocked the rid alone still converts');
  assert.equal(blocked.events[0][2].value, 88);
});

test('the thanks page promises a text only to leads who agreed to texts', () => {
  const texted = thanksHarness('?rid=rid-consent-yes1', { lead: { rid: 'rid-consent-yes1', service: 'Single item', consent: 'yes' } });
  assert.equal(texted.els['thanks-h1'].textContent, "Got it — we'll text you shortly to lock your window.");
  assert.equal(texted.els['step-1'].textContent, 'default step');
  const called = thanksHarness('?rid=rid-consent-no12', { lead: { rid: 'rid-consent-no12', service: 'Single item', consent: 'no' } });
  assert.equal(called.els['thanks-h1'].textContent, "Got it — we'll call you shortly to lock your window.");
  assert.equal(called.els['step-1'].textContent, 'We call to lock your pickup window.');
  const unknown = thanksHarness('?rid=rid-consent-unk1');
  assert.equal(unknown.els['thanks-h1'].textContent, 'default h1', 'without the submit record the neutral text-or-call headline stays');
  assert.ok(thanks.includes("We'll still reach out to see if we can help."));
  assert.doesNotMatch(thanks, /We'll still text you/);
  assert.ok(lp.includes('We text or call back during business hours'));
});

const GUARD_PY = String.raw`
import pathlib, re, sys
root, path, mode = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, root)
import _generate_site as g
text = pathlib.Path(path).read_text(encoding="utf-8")
if mode == "final-pass":
    from _finalize_urls import _rewrite_html
    text = g.dedupe_mobile_sheet_css(text)
    text = g.patch_performance_and_tracking(text)
    text = g.wrap_scroll_tables(text)
    text = re.sub(r'/analytics-loader\.js\?v=[^"\']+', '/analytics-loader.js?v=20260928a', text)
    text = re.sub(r'^[ \t]+$', '', text, flags=re.M)
    has_public_form = bool(re.search(r'<form[^>]*class=["\'][^"\']*(?:lead-form-lite|multi-step-form)', text, re.I))
    if has_public_form and 'fb-capture.js' not in text:
        text = text.replace('</body>', '<script src="/fb-capture.js?v=20260928a" defer></script>\n</body>', 1)
    elif not has_public_form:
        text = re.sub(r'\s*<script src="/fb-capture\.js\?v=[^"]+" defer></script>', '', text)
    text = _rewrite_html(g.enforce_walkthrough_first_copy(text), "")
else:
    text = g.enforce_walkthrough_first_copy(text)
sys.stdout.buffer.write(text.encode("utf-8"))
`;

test('both pages are unchanged by the site generator truth guard and final pass', (t) => {
  for (const [file, html] of [[LP, lp], [THANKS, thanks]]) {
    for (const mode of ['guard', 'final-pass']) {
      let out;
      try {
        out = execFileSync('python3', ['-c', GUARD_PY, root, `${root}${file}`, mode], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        if (error.code === 'ENOENT') { t.skip('python3 is not installed; generator idempotency was not checked'); return; }
        throw error;
      }
      assert.equal(out, html, `${file} changes under _generate_site.py (${mode})`);
    }
  }
});
