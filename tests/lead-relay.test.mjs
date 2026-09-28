import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('fb-capture.js');
const DAY = 24 * 60 * 60 * 1000;
const IN_AREA_ZIPS = ['80521', '80522', '80523', '80524', '80525', '80526', '80527', '80528', '80537', '80538', '80539',
  '80550', '80551', '80547', '80549', '80546', '80535'];

// Model document capture -> form submit handler -> document bubble. All
// transport is intercepted; this never submits a form or contacts the CRM.
function relayHarness(className = 'multi-step-form', options = {}) {
  const {
    href = 'https://easygaragecleaning.com/book?fbclid=synthetic-click',
    cookie = '_fbp=synthetic-fbp',
    stored = {},
    fields = [
      ['Name', 'Walkthrough Test'], ['Phone', '(970) 555-0101'],
      ['Email', 'walkthrough@example.test'], ['Service type', 'Garage Cleanout'],
      ['Job size', 'Medium garage'], ['sms_consent', ''],
    ],
    crypto,
  } = options;
  let clock = options.now ?? Date.UTC(2026, 8, 28, 15, 0, 0);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const values = new Map(fields);
  const form = {
    values,
    bot: false,
    dataset: {},
    classList: { contains: value => value === className },
    querySelector(selector) {
      if (selector === 'input[name="botcheck"]') return { checked: this.bot };
      const name = selector.match(/^input\[name="([^"]+)"\]$/)?.[1];
      if (!values.has(name)) return null;
      return { get value() { return values.get(name); }, set value(v) { values.set(name, v); } };
    },
  };
  const listeners = [];
  const requests = [];
  const storage = new Map(Object.entries(stored));
  const url = new URL(href);
  const document = {
    readyState: 'complete', cookie, referrer: 'https://example.test/ad',
    querySelectorAll(selector) {
      return selector.split(',').some(part => part.trim() === `form.${className}`) ? [form] : [];
    },
    addEventListener(type, callback, options) { listeners.push({ type, callback, capture: options === true || options?.capture === true }); },
  };
  const window = { fetch: true };
  const context = {
    document, window, location: { href: url.href, search: url.search },
    URLSearchParams, Date: FakeDate, Math, Number, String, JSON, Object,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, String(value)) },
    FormData: class { constructor(f) { this.values = new Map(f.values); } get(name) { return this.values.get(name) ?? null; } },
    navigator: {},
    fetch(url, options) { requests.push({ url, options, body: JSON.parse(options.body) }); return Promise.resolve(harness.respond); },
  };
  if (crypto) context.crypto = crypto;
  const harness = { respond: undefined };
  vm.runInNewContext(source, context);
  return Object.assign(harness, {
    form, requests, storage, window,
    advance(ms) { clock += ms; },
    submit(targetHandler = () => {}) {
      const event = { target: form, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of listeners.filter(l => l.type === 'submit' && l.capture)) listener.callback(event);
      targetHandler(event, form);
      for (const listener of listeners.filter(l => l.type === 'submit' && !l.capture)) listener.callback(event);
      return event;
    },
  });
}

test('multistep walkthrough relay uses finalized fields and attribution without canceling native email submission', () => {
  const harness = relayHarness();
  const event = harness.submit((_, form) => {
    form.values.set('phone', '+19705550101');
    form.values.set('items', 'Garage Cleanout — Medium garage');
    form.values.set('What to remove', 'Garage Cleanout — boxes — preferred morning');
    form.values.set('booking_slot', 'Tomorrow AM');
    form.values.set('flow_type', 'walkthrough');
  });
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.equal(request.url, '/api/web-lead');
  assert.equal(request.options.keepalive, true);
  assert.equal(request.body.phone, '+19705550101');
  assert.equal(request.body.items, 'Garage Cleanout — Medium garage');
  assert.equal(request.body.what_to_remove, 'Garage Cleanout — boxes — preferred morning');
  assert.equal(request.body.booking_slot, 'Tomorrow AM');
  assert.equal(request.body.sms_consent, '');
  assert.equal(request.body.fbp, 'synthetic-fbp');
  assert.match(request.body.fbc, /^fb\.1\.\d+\.synthetic-click$/);
  assert.equal(request.body.landing_url, 'https://easygaragecleaning.com/book?fbclid=synthetic-click');
  assert.equal(request.body.referrer, 'https://example.test/ad');
  harness.submit(event => event.preventDefault());
  assert.equal(harness.requests.length, 1, 'a canceled duplicate must not reach the relay');
});

test('relay preserves consent and suppresses canceled, bot and unrelated forms', () => {
  for (const className of ['lead-form-lite', 'multi-step-form']) {
    const harness = relayHarness(className);
    harness.submit(event => event.preventDefault());
    assert.equal(harness.requests.length, 0);
    harness.form.bot = true;
    harness.submit();
    assert.equal(harness.requests.length, 0);
    harness.form.bot = false;
    harness.form.values.set('sms_consent', 'yes');
    assert.equal(harness.submit().defaultPrevented, false);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].body.sms_consent, 'yes');
  }
  const unrelated = relayHarness('other-form');
  unrelated.submit();
  assert.equal(unrelated.requests.length, 0);
});

test('an AJAX page (ads.html pattern) relays exactly once through EGCLeadRelay.relay', () => {
  const harness = relayHarness('lead-form-lite', {
    href: 'https://easygaragecleaning.com/ads?gclid=synthetic-gclid&utm_source=google&utm_medium=cpc&utm_campaign=junk',
    fields: [['name', 'Ads Test'], ['phone', '(970) 555-0102'], ['ZIP', '80549'], ['sms_consent', 'yes'],
      ['request_id', ''], ['in_service_area', ''], ['source', 'Ads Landing Page']],
    crypto: { randomUUID: () => 'synthetic-uuid-0001' },
  });
  assert.equal(typeof harness.window.EGCLeadRelay?.relay, 'function');
  const ajaxHandler = (event, form) => {
    event.preventDefault();
    form.values.set('in_service_area', 'yes');
    assert.equal(harness.window.EGCLeadRelay.relay(form), true);
    // a second call in the same submit (or a double tap) must not duplicate the lead
    assert.equal(harness.window.EGCLeadRelay.relay(form), false);
  };
  const event = harness.submit(ajaxHandler);
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.requests.length, 1, 'the document listener must skip the canceled AJAX submit');
  const body = harness.requests[0].body;
  assert.equal(harness.requests[0].url, '/api/web-lead');
  assert.equal(harness.requests[0].options.keepalive, true);
  assert.equal(body.request_id, 'synthetic-uuid-0001');
  assert.equal(harness.form.values.get('request_id'), 'synthetic-uuid-0001', 'the Web3Forms copy carries the same request id');
  assert.equal(harness.form.dataset.egcRelayed, 'synthetic-uuid-0001');
  assert.equal(body.serviceZip, '80549');
  assert.equal(body.in_service_area, 'yes');
  assert.equal(body.sms_consent, 'yes');
  assert.equal(body.gclid, 'synthetic-gclid');
  assert.equal(body.utm_campaign, 'junk');
  assert.equal(body.name, 'Ads Test');
  harness.advance(3500);
  // ads.html re-enables the button after a Web3Forms error; the retry is the
  // same lead with the same request id and must not reach the relay (or text) again.
  harness.submit((event, form) => { event.preventDefault(); assert.equal(harness.window.EGCLeadRelay.relay(form), false); });
  assert.equal(harness.requests.length, 1);
  harness.form.values.set('phone', '(970) 555-0199');
  harness.submit(ajaxHandler);
  assert.equal(harness.requests.length, 2, 'a corrected resubmission is still relayed');
  assert.equal(harness.requests[1].body.request_id, 'synthetic-uuid-0001');
});

test('a relay the server rejected can be sent again', async () => {
  const harness = relayHarness('lead-form-lite', { fields: [['name', 'Retry Test'], ['phone', '9705550109'], ['request_id', 'rid-retry-1']] });
  harness.respond = { ok: false, status: 502 };
  harness.submit();
  assert.equal(harness.requests.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  harness.advance(3500);
  harness.submit();
  assert.equal(harness.requests.length, 2, 'the failed relay was not marked as sent');
  await new Promise(resolve => setImmediate(resolve));
  harness.respond = { ok: true, status: 200 };
  harness.advance(3500);
  harness.submit();
  assert.equal(harness.requests.length, 3);
  await new Promise(resolve => setImmediate(resolve));
  harness.advance(3500);
  harness.submit();
  assert.equal(harness.requests.length, 3, 'an accepted relay is not repeated');
});

test('native POST forms relay once from the document listener with page service, variant and request id', () => {
  const harness = relayHarness('lead-form-lite', {
    href: 'https://easygaragecleaning.com/junk-removal-quote?v=hot-tub',
    fields: [['name', 'Native Test'], ['phone', '9705550103'], ['serviceZip', '80631'], ['Service type', 'Hot tub'],
      ['preferred_timing', 'Soonest available'], ['page_service', 'hot-tub'], ['page_variant', 'hot-tub'],
      ['request_id', 'page-set-request-id'], ['in_service_area', 'no'], ['items', 'Hot tub — Soonest available']],
  });
  const event = harness.submit((_, form) => {
    // the page's own handler finalizes fields but leaves the native POST alone
    assert.equal(harness.window.EGCLeadRelay.relay(form), true);
  });
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.requests.length, 1, 'bubble listener must not resend a form the page already relayed');
  const body = harness.requests[0].body;
  assert.equal(body.request_id, 'page-set-request-id');
  assert.equal(body.page_service, 'hot-tub');
  assert.equal(body.page_variant, 'hot-tub');
  assert.equal(body.service_type, 'Hot tub');
  assert.equal(body.in_service_area, 'no');
  assert.equal(body.preferred_timing, 'Soonest available');
  assert.equal(body.items, 'Hot tub — Soonest available');
});

test('relay always carries a request id and derives service area from any ZIP field name', () => {
  const cases = [
    [[['ZIP', '80535']], 'yes'], [[['Zip code', '80546']], 'yes'], [[['zip', '80631']], 'no'],
    [[['serviceZip', '80549']], 'yes'], [[], 'unknown'],
  ];
  for (const [zipField, expected] of cases) {
    const harness = relayHarness('lead-form-lite', { fields: [['name', 'Zip Test'], ['phone', '9705550104'], ...zipField] });
    harness.submit();
    assert.equal(harness.requests.length, 1);
    const body = harness.requests[0].body;
    assert.equal(body.serviceZip, zipField[0]?.[1] ?? '');
    assert.equal(body.in_service_area, expected, `ZIP ${zipField[0]?.[1]}`);
    assert.match(body.request_id, /^egc-[a-z0-9]+-[a-z0-9]+$/, 'falls back when crypto.randomUUID is unavailable');
  }
  const garage = relayHarness('lead-form-lite', { fields: [['name', 'Size Test'], ['Garage size', 'Two-car'], ['service_type', 'Junk Pickup']] });
  garage.submit();
  assert.equal(garage.requests[0].body.job_size, 'Two-car');
  assert.equal(garage.requests[0].body.service_type, 'Junk Pickup');
});

test('Google gbraid/wbraid and msclkid are captured from the URL with a timestamp', () => {
  const now = Date.UTC(2026, 8, 28, 16, 0, 0);
  const harness = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote?gbraid=synthetic-gbraid&wbraid=synthetic-wbraid&msclkid=synthetic-ms',
    fields: [['name', 'Braid Test'], ['phone', '9705550105'], ['gbraid', ''], ['wbraid', '']],
  });
  assert.equal(harness.storage.get('egc_gbraid'), 'synthetic-gbraid');
  assert.equal(harness.storage.get('egc_gbraid_ts'), String(now));
  assert.equal(harness.storage.get('egc_wbraid'), 'synthetic-wbraid');
  assert.equal(harness.storage.get('egc_wbraid_ts'), String(now));
  assert.equal(harness.form.values.get('gbraid'), 'synthetic-gbraid', 'hidden click-id inputs are filled');
  harness.submit();
  const body = harness.requests[0].body;
  assert.equal(body.gbraid, 'synthetic-gbraid');
  assert.equal(body.wbraid, 'synthetic-wbraid');
  assert.equal(body.msclkid, 'synthetic-ms');
  assert.equal(body.gclid, '');
});

test('stored click ids and UTMs expire after 90 days; a new click resets the landing page', () => {
  const now = Date.UTC(2026, 8, 28, 16, 0, 0);
  const stale = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote',
    stored: {
      egc_gclid: 'stale-gclid', egc_gclid_ts: String(now - 91 * DAY),
      egc_wbraid: 'recent-wbraid', egc_wbraid_ts: String(now - 10 * DAY),
      egc_msclkid: 'legacy-no-timestamp',
      egc_utm_source: 'google', egc_utm_campaign: 'old-campaign', egc_utm_ts: String(now - 120 * DAY),
      egc_landing: 'https://easygaragecleaning.com/old-landing?gclid=stale-gclid',
    },
    fields: [['name', 'Stale Test'], ['phone', '9705550106']],
  });
  stale.submit();
  const body = stale.requests[0].body;
  assert.equal(body.gclid, '', 'a 91-day-old gclid is ignored');
  assert.equal(body.wbraid, 'recent-wbraid', 'a 10-day-old click id is kept');
  assert.equal(body.msclkid, '', 'a click id of unknown age is not trusted');
  assert.equal(body.utm_source, '');
  assert.equal(body.utm_campaign, '');
  assert.equal(body.landing_url, 'https://easygaragecleaning.com/old-landing?gclid=stale-gclid', 'no new touch keeps the first landing page');
  assert.equal(stale.storage.get('egc_gclid'), '', 'the stale gclid is cleared');

  const cookieFallback = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote',
    cookie: `_fbp=synthetic-fbp; _gcl_aw=GCL.${Math.floor((now - 5 * DAY) / 1000)}.linker-gclid`,
    fields: [['name', 'Linker Test'], ['phone', '9705550107']],
  });
  cookieFallback.submit();
  assert.equal(cookieFallback.requests[0].body.gclid, 'linker-gclid', "Google's dated conversion-linker cookie is a fallback");

  const fresh = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote?gclid=new-gclid&utm_source=google&utm_campaign=junk-q4',
    stored: {
      egc_landing: 'https://easygaragecleaning.com/old-landing', egc_referrer: 'https://old.example/',
      egc_utm_source: 'facebook', egc_utm_content: 'old-creative', egc_utm_ts: String(now - DAY),
    },
    fields: [['name', 'Fresh Test'], ['phone', '9705550108']],
  });
  fresh.submit();
  const freshBody = fresh.requests[0].body;
  assert.equal(freshBody.gclid, 'new-gclid');
  assert.equal(freshBody.landing_url, 'https://easygaragecleaning.com/junk-removal-quote?gclid=new-gclid&utm_source=google&utm_campaign=junk-q4');
  assert.equal(freshBody.referrer, 'https://example.test/ad');
  assert.equal(freshBody.utm_source, 'google');
  assert.equal(freshBody.utm_campaign, 'junk-q4');
  assert.equal(freshBody.utm_content, '', 'a new tagged link replaces the whole UTM set');
  assert.equal(fresh.storage.get('egc_gclid_ts'), String(now));
});

test('a new tagged visit drops older click ids so an old ad click never outranks it', () => {
  const now = Date.UTC(2026, 8, 28, 16, 0, 0);
  const meta = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote?fbclid=new-fb&utm_source=facebook&utm_medium=paid',
    cookie: `_fbp=synthetic-fbp; _gcl_aw=GCL.${Math.floor((now - 5 * DAY) / 1000)}.linker-gclid`,
    stored: { egc_gclid: 'old-gclid', egc_gclid_ts: String(now - 10 * DAY), egc_wbraid: 'old-wbraid', egc_wbraid_ts: String(now - 3 * DAY) },
    fields: [['name', 'Meta Test'], ['phone', '9705550110']],
  });
  meta.submit();
  const body = meta.requests[0].body;
  assert.equal(body.gclid, '', 'neither the stored gclid nor the conversion-linker cookie outranks a new Meta click');
  assert.equal(body.wbraid, '');
  assert.equal(body.fbclid, 'new-fb');
  assert.equal(meta.storage.get('egc_gclid'), '');
  assert.equal(meta.storage.get('egc_fbclid_ts'), String(now));

  const later = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote?utm_source=google&utm_medium=organic',
    stored: { egc_fbclid: 'old-fb', egc_fbclid_ts: String(now - 2 * DAY), egc_fbc: 'fb.1.1.old-fb' },
    cookie: '',
    fields: [['name', 'Later Test'], ['phone', '9705550111']],
  });
  later.submit();
  assert.equal(later.requests[0].body.fbclid, '', 'a new tagged visit without fbclid is not Facebook Paid');
  assert.equal(later.requests[0].body.fbc, '');

  const stale = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote',
    stored: { egc_fbclid: 'stale-fb', egc_fbclid_ts: String(now - 91 * DAY) },
    cookie: '',
    fields: [['name', 'Stale Fb'], ['phone', '9705550112']],
  });
  stale.submit();
  assert.equal(stale.requests[0].body.fbclid, '', 'a 91-day-old fbclid is ignored');

  const direct = relayHarness('lead-form-lite', {
    now,
    href: 'https://easygaragecleaning.com/junk-removal-quote',
    stored: { egc_fbclid: 'recent-fb', egc_fbclid_ts: String(now - 2 * DAY), egc_gclid: 'recent-gclid', egc_gclid_ts: String(now - 2 * DAY) },
    cookie: '',
    fields: [['name', 'Direct Test'], ['phone', '9705550113']],
  });
  direct.submit();
  assert.equal(direct.requests[0].body.gclid, 'recent-gclid', 'an untagged return visit keeps the last ad click');
  assert.equal(direct.requests[0].body.fbclid, 'recent-fb');
});

test('AJAX landing pages hand their leads to the relay after validation and before Web3Forms', () => {
  for (const page of ['ads.html', 'junk-removal-fort-collins.html']) {
    const html = read(page);
    const handler = html.indexOf("addEventListener('submit'");
    const prevent = html.indexOf('e.preventDefault()', handler);
    const relay = html.indexOf('window.EGCLeadRelay.relay(form)', handler);
    const web3forms = html.indexOf('fetch(', relay);
    assert.ok(handler > 0 && prevent > handler && relay > prevent && web3forms > relay, `${page} must relay after validation, before Web3Forms`);
    assert.match(html, /<script src="\/fb-capture\.js\?v=20260928a" defer><\/script>/, `${page} loads the current relay`);
    assert.doesNotMatch(html, /capture phase/, `${page} documents the listener phase correctly`);
  }
  const ads = read('ads.html');
  const adsZips = ads.match(/const SERVICE_ZIPS = new Set\(\[([\s\S]*?)\]\)/)[1].match(/'(\d{5})'/g).map(zip => zip.slice(1, -1));
  assert.deepEqual([...adsZips].sort(), [...IN_AREA_ZIPS].sort());
  const captureZips = source.match(/var SERVICE_ZIPS = \{([\s\S]*?)\};/)[1].match(/'(\d{5})'/g).map(zip => zip.slice(1, -1));
  assert.deepEqual([...captureZips].sort(), [...IN_AREA_ZIPS].sort());
  assert.match(ads, /name="in_service_area"/);
  assert.match(ads, /<input type="hidden" name="page_service" value="garage-cleanout">/, '/ads names its service so HighLevel files it as a garage cleanout');
  assert.match(ads, /in_service_area"\]'\)\.value = inServiceArea \? 'yes' : 'no'/);
  assert.doesNotMatch(ads, /Windsor &amp; Timnath only|Windsor, and Timnath only/);
  for (const town of ['Wellington', 'Severance', 'LaPorte']) {
    assert.match(ads.match(/<div class="service-bar">[\s\S]*?<\/div>/)[0], new RegExp(town));
    assert.match(ads.match(/id="formOutOfArea">[\s\S]*?<\/div>/)[0], new RegExp(town));
  }
});
