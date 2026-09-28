import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../fb-capture.js', import.meta.url), 'utf8');

// Model document capture -> form submit handler -> document bubble. All
// transport is intercepted; this never submits a form or contacts the CRM.
function relayHarness(className = 'multi-step-form', { withCrypto = false, attributes = {} } = {}) {
  const values = new Map([
    ['Name', 'Walkthrough Test'], ['Phone', '(970) 555-0101'],
    ['Email', 'walkthrough@example.test'], ['Service type', 'Garage Cleanout'],
    ['Job size', 'Medium garage'], ['sms_consent', ''],
  ]);
  const form = {
    values,
    bot: false,
    classList: { contains: value => value === className },
    getAttribute: name => attributes[name] ?? null,
    querySelector(selector) {
      if (selector === 'input[name="botcheck"]') return { checked: this.bot };
      const name = selector.match(/^input\[name="([^"]+)"\]$/)?.[1];
      if (!values.has(name)) return null;
      return { get value() { return values.get(name); }, set value(v) { values.set(name, v); } };
    },
  };
  const listeners = [];
  const requests = [];
  const pixel = [];
  // The relay's HTTP outcome: a Response-like {ok} or a network failure.
  const transport = { outcome: 'ok', next() { return this.outcome === 'offline' ? Promise.reject(new TypeError('offline')) : Promise.resolve({ ok: this.outcome === 'ok' }); } };
  const storage = new Map();
  const document = {
    readyState: 'complete', cookie: '_fbp=synthetic-fbp', referrer: 'https://example.test/ad',
    querySelectorAll(selector) {
      return selector.split(',').some(part => part.trim() === `form.${className}`) ? [form] : [];
    },
    addEventListener(type, callback, options) { listeners.push({ type, callback, capture: options === true || options?.capture === true }); },
  };
  const context = {
    document, location: { href: 'https://easygaragecleaning.com/book?fbclid=synthetic-click', search: '?fbclid=synthetic-click' },
    URLSearchParams, Date,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    FormData: class { constructor(f) { this.values = new Map(f.values); } get(name) { return this.values.get(name) ?? null; } },
    navigator: {}, window: { fetch: true, ...(withCrypto ? { crypto: webcrypto } : {}), fbq: (...args) => pixel.push(args) },
    fetch(url, options) { requests.push({ url, options, body: JSON.parse(options.body) }); return transport.next(); },
  };
  vm.runInNewContext(source, context);
  return {
    form, requests, pixel, context, transport,
    submit(targetHandler = () => {}) {
      const event = { target: form, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of listeners.filter(l => l.type === 'submit' && l.capture)) listener.callback(event);
      targetHandler(event, form);
      for (const listener of listeners.filter(l => l.type === 'submit' && !l.capture)) listener.callback(event);
      return event;
    },
  };
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const settled = () => new Promise(resolve => setImmediate(resolve));

test('FUN-13: each set of answers gets one inquiry id; it is resent, with the same id, only after the relay failed', async () => {
  const harness = relayHarness('multi-step-form', { withCrypto: true });
  harness.transport.outcome = 'offline';
  harness.submit();
  const first = harness.requests[0].body.inquiry_id;
  assert.match(first, UUID);
  harness.submit();
  assert.equal(harness.requests.length, 1, 'a copy while the first send is in flight is not sent');
  await settled();
  harness.transport.outcome = 'server_error';
  harness.submit();
  assert.equal(harness.requests[1].body.inquiry_id, first, 'after a failed send the same answers go again as the same inquiry');
  await settled();
  harness.transport.outcome = 'ok';
  harness.submit();
  await settled();
  harness.submit();
  assert.deepEqual(harness.requests.map(request => request.body.inquiry_id), [first, first, first], 'once the Hub has the answers they are never sent again');
  harness.form.values.set('Phone', '(970) 555-0102');
  harness.submit();
  assert.notEqual(harness.requests[3].body.inquiry_id, first, 'corrected answers are a new inquiry, never an idempotency conflict');
  assert.equal(harness.pixel.length, 0, 'forms without data-meta-lead leave the Meta Lead to their page');
  // Without WebCrypto the lead still goes out (the Hub assigns the id).
  const bare = relayHarness('multi-step-form');
  bare.submit();
  assert.equal(bare.requests[0].body.inquiry_id, undefined);
});

test('FUN-13: a canceled ads.html submit is relayed through EGCLeadCapture.relay, once, with the zip and the page-supplied summary', () => {
  const harness = relayHarness('lead-form-lite', { withCrypto: true });
  harness.form.values.set('ZIP', '80525');
  const relay = harness.context.window.EGCLeadCapture.relay;
  let id;
  harness.submit((event, form) => { event.preventDefault(); id = relay(form, { items: 'Ads landing lead (in service area)', phone: 7, unknown: 'x' }); });
  assert.equal(harness.requests.length, 1, 'the document listener still skips the canceled submit, so nothing is sent twice');
  assert.match(id, UUID);
  const body = harness.requests[0].body;
  assert.deepEqual([body.inquiry_id, body.serviceZip, body.items, body.phone, body.unknown], [id, '80525', 'Ads landing lead (in service area)', '(970) 555-0101', undefined]);
  harness.form.bot = true;
  assert.equal(relay(harness.form), false, 'the honeypot is honoured on the direct path too');
  assert.equal(relay({ classList: { contains: () => false } }), false);
  assert.equal(harness.requests.length, 1);
});

test('FUN-13: book.html (data-meta-lead) reports the Meta Lead with the relayed inquiry id as its eventID', () => {
  const harness = relayHarness('multi-step-form', { withCrypto: true, attributes: { 'data-meta-lead': 'walkthrough_request' } });
  harness.submit();
  const id = harness.requests[0].body.inquiry_id;
  assert.deepEqual(JSON.parse(JSON.stringify(harness.pixel)), [['track', 'Lead', { content_name: 'walkthrough_request' }, { eventID: id }]]);
  harness.submit(event => event.preventDefault());
  harness.form.bot = true;
  harness.submit();
  assert.equal(harness.pixel.length, 1, 'no Lead for a canceled duplicate or a bot');
});
