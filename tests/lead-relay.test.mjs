import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../fb-capture.js', import.meta.url), 'utf8');

// Model document capture -> form submit handler -> document bubble. All
// transport is intercepted; this never submits a form or contacts the CRM.
function relayHarness(className = 'multi-step-form') {
  const values = new Map([
    ['Name', 'Walkthrough Test'], ['Phone', '(970) 555-0101'],
    ['Email', 'walkthrough@example.test'], ['Service type', 'Garage Cleanout'],
    ['Job size', 'Medium garage'], ['sms_consent', ''],
  ]);
  const form = {
    values,
    bot: false,
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
    navigator: {}, window: { fetch: true },
    fetch(url, options) { requests.push({ url, options, body: JSON.parse(options.body) }); return Promise.resolve(); },
  };
  vm.runInNewContext(source, context);
  return {
    form, requests,
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
