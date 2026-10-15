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
    querySelector(selector) { return selector === '.ghl-booking' ? (this.shell?.removed ? null : this.shell) : original; },
    prepend(node) { this.shell = node; } };
  return { api: context.EGCBookingHighLevel, card, original, timeout: () => timeout() };
}
function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants)];
}
function byClass(node, className) {
  return descendants(node).find(child => child.className === className);
}
function byText(node, text) {
  return descendants(node).find(child => child.textContent === text);
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
  const encoded = api.attributedUrl(base, 'https://easygaragecleaning.com/book', { getItem: () => '語'.repeat(512) });
  assert.ok(encoded.length <= 4096, 'encoded attribution cannot exceed the iframe URL budget');
});
test('embed recovery preserves existing form and never declares submission success', () => {
  const { api, card, original, timeout } = setup();
  card.dataset.highlevelFormUrl = 'https://api.leadconnectorhq.com/widget/form/verifiedFixture';
  api.mount(card);
  const status = byClass(card.shell, 'ghl-booking-status');
  const frame = byClass(card.shell, 'ghl-booking-frame');
  const retry = byText(card.shell, 'Reload request form');
  const fallback = byText(card.shell, 'Use the standard request form');
  assert.equal(original.hidden, true);
  assert.equal(frame.title, 'Easy Garage Cleaning walkthrough request');
  timeout(); assert.match(status.textContent, /Taking longer/); assert.equal(status.hidden, false);
  retry.events.click(); assert.match(status.textContent, /Loading/); assert.equal(status.hidden, false);
  frame.events.load(); assert.equal(status.textContent, ''); assert.equal(status.hidden, true);
  assert.doesNotMatch(status.textContent, /confirmed|received|success/i);
  frame.events.error(); assert.match(status.textContent, /could not load/); assert.equal(status.hidden, false);
  fallback.events.click(); assert.equal(original.hidden, false);
  assert.equal(original.focused, true); assert.equal(frame.src, undefined);
});
test('branded wrapper keeps the native form and safe direct fallback together', () => {
  const { api, card } = setup();
  card.dataset.highlevelFormUrl = 'https://links.easygaragecleaning.com/widget/form/DeiRNO6itxjLiTk3Nkj0';
  api.mount(card);
  assert.equal(descendants(card.shell).filter(node => node.tag === 'img').length, 0,
    'the wrapper reuses the site header logo rather than adding a second one');
  const headings = descendants(card.shell).filter(node => /^h[1-6]$/.test(node.tag));
  assert.equal(headings.length, 1);
  assert.equal(headings[0].tag, 'h1');
  assert.equal(headings[0].textContent, 'Request your free walkthrough');
  const frame = byClass(card.shell, 'ghl-booking-frame');
  const direct = byClass(card.shell, 'ghl-booking-direct');
  assert.equal(frame.src, card.dataset.highlevelFormUrl);
  assert.equal(direct.href, frame.src);
  assert.equal(direct.target, '_blank');
  assert.equal(direct.rel, 'noopener noreferrer');
  const recovery = byClass(card.shell, 'ghl-booking-recovery');
  assert.equal(recovery.tag, 'details');
  assert.ok(descendants(recovery).includes(direct), 'alternate links stay in secondary help');
  assert.match(byClass(card.shell, 'ghl-booking-intro').textContent, /contact you to confirm a time/);
  assert.equal(descendants(card.shell).filter(node => node.tag === 'input' || node.tag === 'form').length, 0,
    'the wrapper must not duplicate contact fields or consent outside the native form');
  assert.equal(frame.events.message, undefined, 'no inferred cross-origin success handling');
});
test('mount is idempotent and recovery preserves pre-existing hidden state', () => {
  const { api, card, original } = setup();
  const alreadyHidden = { hidden: true };
  card.children.push(alreadyHidden);
  card.dataset.highlevelFormUrl = 'https://links.easygaragecleaning.com/widget/form/DeiRNO6itxjLiTk3Nkj0';
  api.mount(card);
  const shell = card.shell;
  api.mount(card);
  assert.equal(card.shell, shell);
  byText(shell, 'Use the standard request form').events.click();
  assert.equal(original.hidden, false);
  assert.equal(alreadyHidden.hidden, true);
});
test('recovery returns focus to the selected service instead of skipping to Next', () => {
  const { api, card, original } = setup();
  const selectedService = { focused: false, focus() { this.focused = true; } };
  const query = card.querySelector.bind(card);
  card.querySelector = selector => selector === '.form-panel.active input[type="radio"]:checked'
    ? selectedService : query(selector);
  card.dataset.highlevelFormUrl = 'https://links.easygaragecleaning.com/widget/form/DeiRNO6itxjLiTk3Nkj0';
  api.mount(card);
  byText(card.shell, 'Use the standard request form').events.click();
  assert.equal(selectedService.focused, true);
  assert.equal(original.focused, undefined, 'the selected choice takes priority over later fields');
  assert.equal(original.hidden, false);
});
test('recovery still focuses the first available field if no choice is selected', () => {
  const { api, card, original } = setup();
  const query = card.querySelector.bind(card);
  card.querySelector = selector => selector === '.form-panel.active input[type="radio"]:checked'
    ? null : query(selector);
  card.dataset.highlevelFormUrl = 'https://links.easygaragecleaning.com/widget/form/DeiRNO6itxjLiTk3Nkj0';
  api.mount(card);
  byText(card.shell, 'Use the standard request form').events.click();
  assert.equal(original.focused, true);
  assert.equal(original.hidden, false);
});
test('live page and generator load enhancement without enabling an unverified form', () => {
  for (const filename of ['book.html', '_generate_site.py']) {
    const text = fs.readFileSync(new URL('../' + filename, import.meta.url), 'utf8');
    assert.match(text, /booking-highlevel\.js/); assert.match(text, /booking-highlevel\.css/);
    assert.doesNotMatch(text, /data-highlevel-form-url=/);
  }
  assert.match(fs.readFileSync(new URL('../book.html', import.meta.url), 'utf8'), /action="https:\/\/api.web3forms.com\/submit"/);
});
