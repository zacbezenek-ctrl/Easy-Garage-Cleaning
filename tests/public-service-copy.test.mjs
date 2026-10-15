import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = name => readFileSync(new URL(`../${name}.html`, import.meta.url), 'utf8');
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const anchors = html => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
  .map(([, attributes, label]) => ({ href: attr(attributes, 'href'), className: attr(attributes, 'class') || '', label: text(label) }));

test('curbside primary actions request pickup or a quote without promising a booked walkthrough', () => {
  const html = page('flat-rate-junk-removal-fort-collins-co');
  const links = anchors(html);
  const nav = links.filter(link => /(?:^|\s)(?:nav-cta|drawer-cta)(?:\s|$)/.test(link.className));
  assert.deepEqual(nav.map(link => [link.href, link.label]), [['#quote', 'Request a Quote'], ['#quote', 'Request a Quote']]);
  const quoteLinks = links.filter(link => /^(?:Request a Quote|Quote)$/.test(link.label));
  assert.equal(quoteLinks.length, 4, 'nav, drawer, footer and mobile quote actions');
  assert.ok(quoteLinks.every(link => link.href === '#quote'));
  assert.ok(links.filter(link => link.href === '/book').every(link => /walkthrough/i.test(link.label)));
  assert.ok(links.some(link => link.href === '#quote' && link.label === 'Request My $139 Pickup'));
  const primary = links.filter(link => link.href === '#quote' || nav.includes(link));
  assert.doesNotMatch(primary.map(link => link.label).join(' '), /\b(?:book|schedule|walkthrough)\b/i);
  assert.match(html, /<h3>Request pickup<\/h3>/);
  assert.match(html, /We will contact you to confirm load size and availability\./);
  assert.doesNotMatch(html, /fastest confirmation|Book My \$139 Pickup|Book your slot/);
  assert.equal((html.match(/\bid="quote"/g) || []).length, 1);
  assert.match(html, /<section\b[^>]*id="quote"[^>]*tabindex="-1"[^>]*aria-labelledby="cta-heading"/);
});

test('curbside retains its two existing forms, field contracts and SMS request destination', () => {
  const html = page('flat-rate-junk-removal-fort-collins-co');
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
  assert.equal(forms.length, 2);
  const fields = ['access_key', 'subject', 'from_name', 'redirect', 'botcheck', 'source', 'fbc', 'fbp', 'fbclid', 'landing_url', 'referrer', 'name', 'phone', 'items', 'sms_consent'].sort();
  for (const [, attributes, body] of forms) {
    assert.equal(attr(attributes, 'action'), 'https://api.web3forms.com/submit');
    assert.equal(attr(attributes, 'method'), 'POST');
    assert.deepEqual([...body.matchAll(/<(?:input|select|textarea)\b([^>]*)>/g)].map(([, attributes]) => attr(attributes, 'name')).sort(), fields);
    assert.match(body, /name="redirect" value="https:\/\/easygaragecleaning\.com\/thank-you"/);
    assert.match(body, /<button\b[^>]*type="submit"[^>]*>Request My (?:Curbside Quote|\$139 Pickup) &rarr;<\/button>/);
  }
  const sms = anchors(html).filter(link => link.href?.includes('?body='));
  assert.ok(sms.length >= 2);
  for (const link of sms) {
    assert.equal(link.href.split('?')[0], 'sms:+19709991818');
    assert.equal(new URLSearchParams(link.href.split('?')[1]).get('body'), 'Hi! I would like to request the $139 curbside pickup for up to 4 cubic yards.');
  }
});

test('curbside and full-service pricing and walkthrough requirements remain distinct', () => {
  const curbside = page('flat-rate-junk-removal-fort-collins-co');
  const comparison = curbside.match(/<section class="pricing" id="pricing"[\s\S]*?<\/section>/)?.[0];
  assert.ok(comparison);
  assert.match(text(comparison), /\$139 curbside pickup.*up to 4 cubic yards.*No walkthrough needed/);
  assert.match(text(comparison), /Full service from \$675.*carry items out.*free on-site walkthrough/);
  assert.ok(anchors(comparison).some(link => link.href === '/book' && link.label.startsWith('Request a free walkthrough')));
  assert.match(text(curbside), /No on-site estimate, no hourly clock/);
  assert.match(text(page('junk-removal-fort-collins-co')), /Curbside pickup is \$139 flat.*crew carries items out.*from \$675/);
  for (const name of ['index', 'junk-removal-fort-collins-co']) {
    const nav = anchors(page(name)).filter(link => /(?:^|\s)(?:nav-cta|drawer-cta)(?:\s|$)/.test(link.className));
    assert.ok(nav.length > 0 && nav.every(link => link.href === '/book'), `${name} keeps its garage walkthrough navigation`);
  }
});

test('junk metadata and contact widgets use neutral response copy without a five-minute promise', () => {
  const junk = page('junk-removal-fort-collins-co');
  assert.doesNotMatch(junk, /\b(?:5|five)[ -]minutes?\b/i);
  assert.match(junk, /Contact our local team for availability/);
  for (const name of ['index', 'book', 'junk-removal-fort-collins-co']) {
    const html = page(name);
    const heading = html.match(/<div class="contact-widget-head">([\s\S]*?)<\/span>/)?.[1];
    assert.ok(heading, `${name} contact widget exists`);
    assert.match(text(heading), /Contact our local team/);
    assert.doesNotMatch(html, /Usually replies in (?:5|five) minutes/i);
  }
});
