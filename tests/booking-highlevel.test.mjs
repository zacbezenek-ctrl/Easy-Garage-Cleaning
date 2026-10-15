import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../booking-highlevel.js', import.meta.url), 'utf8');
function setup() {
  let timeout;
  const context = { URL, URLSearchParams, setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() {}, };
  vm.runInNewContext(source, context);
  function element(tag) {
    return { tag, children: [], hidden: false, attrs: {}, events: {},
      setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this[k]; },
      addEventListener(k,v) { this.events[k]=v; }, append(...nodes) { this.children.push(...nodes); },
      remove() { this.removed = true; }, focus() { this.focused = true; } };
  }
  const original = element('form');
  const card = { dataset: {}, classList: { add() {}, remove() {} }, children: [original], ownerDocument: { createElement: element },
    querySelector(selector) { return selector === '.ghl-booking' ? null : original; },
    prepend(node) { this.shell = node; } };
  return { api: context.EGCBookingHighLevel, card, original, timeout: () => timeout() };
}
test('absent or unverified URLs leave existing intake untouched', () => {
  const {api, card, original} = setup();
  for (const value of ['', 'https://evil.example/widget/form/abc', 'https://api.leadconnectorhq.com.evil.example/widget/form/abc', 'http://api.leadconnectorhq.com/widget/form/abc', 'https://api.leadconnectorhq.com/widget/form/abc?phone=private', 'https://api.leadconnectorhq.com/widget/form/abc#private']) {
    card.dataset.highlevelFormUrl = value; api.mount(card);
    assert.equal(card.shell, undefined); assert.equal(original.hidden, false);
  }
});
test('only verified vendor and EGC branded embed hosts are accepted', () => {
  const { api } = setup();
  assert.equal(api.verifiedUrl('https://links.easygaragecleaning.com/widget/form/fixture'), 'https://links.easygaragecleaning.com/widget/form/fixture');
  assert.equal(api.verifiedUrl('https://links.easygaragecleaning.com.evil.example/widget/form/fixture'), null);
});

test('native embed forwards only bounded campaign context and never private page fields or cookies', () => {
  const { api } = setup(), base = 'https://links.easygaragecleaning.com/widget/form/fixture';
  const stored = { egc_utm_medium: 'qa', egc_fbclid: 'existing-click', egc_fbc: 'private-cookie', egc_phone: 'private-phone' };
  const url = new URL(api.attributedUrl(base, 'https://easygaragecleaning.com/book?utm_source=egc-qa&utm_campaign=readiness&phone=private&token=secret#private', { getItem: key => stored[key] }));
  assert.deepEqual(Object.fromEntries(url.searchParams), { utm_source: 'egc-qa', utm_medium: 'qa', utm_campaign: 'readiness', fbclid: 'existing-click' });
  assert.doesNotMatch(url.href, /private|secret|[?&]fbc=|phone|token/);
  assert.equal(api.attributedUrl(base + '?phone=private', 'https://easygaragecleaning.com/book', null), null);
});

test('ambiguous or invalid campaign values are omitted and unavailable storage stays usable', () => {
  const { api } = setup(), base = 'https://links.easygaragecleaning.com/widget/form/fixture';
  const url = new URL(api.attributedUrl(base, 'https://easygaragecleaning.com/book?utm_source=one&utm_source=two&utm_medium=%0Aqa&utm_campaign=' + 'x'.repeat(513), { getItem() { throw new Error('blocked'); } }));
  assert.equal(url.search, '');
  assert.equal(api.attributedUrl(base, undefined, null), base);
});
test('embed recovery preserves existing form and never declares submission success', () => {
  const { api, card, original, timeout } = setup();
  card.dataset.highlevelFormUrl = 'https://api.leadconnectorhq.com/widget/form/verifiedFixture';
  api.mount(card);
  const [, , status, retry, fallback, , frame] = card.shell.children;
  assert.equal(original.hidden, true);
  assert.equal(frame.title, 'Easy Garage Cleaning walkthrough request');
  timeout(); assert.match(status.textContent, /Taking longer/);
  retry.events.click(); assert.match(status.textContent, /Loading/);
  frame.events.load(); assert.match(status.textContent, /blank/);
  assert.doesNotMatch(status.textContent, /confirmed|received|success/i);
  frame.events.error(); assert.match(status.textContent, /could not load/);
  fallback.events.click(); assert.equal(original.hidden, false);
  assert.equal(original.focused, true); assert.equal(frame.src, undefined);
});
test('live page and generator load enhancement without enabling an unverified form', () => {
  for (const filename of ['book.html', '_generate_site.py']) {
    const text = fs.readFileSync(new URL('../' + filename, import.meta.url), 'utf8');
    assert.match(text, /booking-highlevel\.js/); assert.match(text, /booking-highlevel\.css/);
    assert.doesNotMatch(text, /data-highlevel-form-url=/);
  }
  assert.match(fs.readFileSync(new URL('../book.html', import.meta.url), 'utf8'), /action="https:\/\/api.web3forms.com\/submit"/);
});
