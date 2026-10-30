// Owner decisions of 2026-10-30 for the public website: junk and item pickups start from $250 (the $250 minimum to come
// out) while garage cleanouts keep "from $675"; no money-back or "or it's free" guarantees; special items are priced
// upfront instead of "no per-item surcharges"; /ads covers every city the site serves; Garage Guard drops its scarcity
// and gift-card claims; the Terms state the 75% at completion and the 48-hour deposit line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicPages } from './e2e/helpers/public-pages.mjs';
import { TRAVEL_ZIP_CENTROIDS } from '../functions/_lib/dispatch-travel.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pages = publicPages().map(path => [path.slice(1), read(path.slice(1))]);
const text = html => html.replace(/<script(?! type="application\/ld\+json")[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const schemas = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
const offers = html => JSON.stringify(schemas(html)).match(/"minPrice":"\d+"/g) || [];
const CITIES = ['Fort Collins', 'Loveland', 'Windsor', 'Timnath', 'Wellington', 'Severance', 'LaPorte', 'Johnstown', 'Berthoud'];

test('no public page or machine summary makes an "or it\'s free" or pay-half money guarantee', () => {
  const found = [];
  for (const [name, html] of [...pages, ['llms.txt', read('llms.txt')], ['ai.txt', read('ai.txt')]]) {
    const copy = text(html);
    for (const pattern of [/or it['’]?s free/i, /job is free/i, /pay half/i, /every guarantee below is in writing/i, /you don't pay a cent/i]) if (pattern.test(copy)) found.push(`${name}: ${pattern}`);
  }
  assert.deepEqual(found, []);
  const home = schemas(read('index.html')).find(schema => schema['@type'] === 'LocalBusiness');
  assert.equal(home.slogan, 'Done by Dinner');
});

test('/ads covers every city the site serves and makes no time or money promises', () => {
  const ads = read('ads.html'), copy = text(ads);
  const zips = new Set(ads.match(/const SERVICE_ZIPS = new Set\(\[([\s\S]*?)\]\)/)[1].match(/\d{5}/g));
  const expected = Object.entries(TRAVEL_ZIP_CENTROIDS).filter(([, [, , city]]) => CITIES.includes(city)).map(([zip]) => zip);
  assert.equal(expected.length, 20, 'the repo ZIP table names every claimed city');
  assert.deepEqual(expected.filter(zip => !zips.has(zip)), [], 'every claimed city ZIP is in the service area');
  for (const city of CITIES) assert.ok(copy.includes(`Serving ${CITIES.slice(0, -1).join(', ')} & Berthoud`) && copy.includes(city), city);
  assert.match(copy, /We currently serve Fort Collins, Loveland, Windsor, Timnath, Wellington, Severance, LaPorte, Johnstown, and Berthoud\./);
  assert.doesNotMatch(copy, /Timnath only|within 5 minutes|2-?hr response/i);
  assert.match(copy, /We'll get back to you shortly\./);
  assert.match(copy, /Text us a photo and we'll get back to you shortly with a ballpark\./);
  assert.match(copy, /Done By Dinner Is the Goal/);
});

test('junk removal and item pickups start from $250; garage cleanouts keep from $675', () => {
  for (const name of ['junk-removal-fort-collins-co.html', 'couch-removal-fort-collins-co.html', 'furniture-removal-fort-collins-co.html', 'appliance-removal-fort-collins-co.html',
    'mattress-removal-fort-collins-co.html', 'hot-tub-removal-fort-collins-co.html', 'refrigerator-removal-fort-collins-co.html', 'treadmill-removal-fort-collins-co.html',
    'yard-debris-removal-fort-collins-co.html', 'junk-removal-loveland-co.html', 'junk-removal-windsor-co.html', 'junk-removal-wellington-co.html', 'timnath-junk-removal.html',
    'old-town-fort-collins-junk-removal.html', 'flat-rate-junk-removal-fort-collins-co.html']) {
    const html = read(name);
    assert.ok(offers(html).length > 0 && offers(html).every(offer => offer === '"minPrice":"250"'), `${name}: ${offers(html)}`);
    assert.match(text(html), /from \$250, our \$250 minimum to come out/i, name);
    assert.doesNotMatch(text(html), /carr(?:y|ies) (?:it|them|items) out[^.]{0,30}from \$675/i, name);
  }
  for (const name of ['garage-cleanouts-fort-collins-co.html', 'garage-cleaning-fort-collins-co.html', 'garage-organization-fort-collins-co.html', 'garage-turnaround-fort-collins-co.html']) {
    assert.ok(offers(read(name)).includes('"minPrice":"675"'), name);
  }
  const faq = text(read('faq.html'));
  assert.match(faq, /Garage cleanouts and turnarounds start from \$675\./);
  assert.match(faq, /Junk removal and item pickups start from \$250 , our \$250 minimum to come out/);
  assert.match(read('llms.txt'), /\| Junk removal & item pickup \| From \$250 \|/);
  assert.match(read('ai.txt'), /^junk_removal_and_item_pickup: from \$250 \(our \$250 minimum to come out/m);
});

test('special items are priced upfront instead of a "no per-item surcharge" promise', () => {
  const found = pages.filter(([, html]) => /no per-item (?:surcharge|fee)|per-item franchise|\$30[–-]\$75 per appliance|no extra charge per appliance/i.test(text(html))).map(([name]) => name);
  assert.deepEqual(found, []);
  const faq = read('faq.html');
  assert.match(text(faq), /Mattresses, appliances, hot tubs, and other special items are priced upfront at your walkthrough \(or from your photos for a removal-only job\)/);
  const answer = schemas(faq)[0].mainEntity.find(entry => entry.name === 'Do you charge extra for heavy items like appliances or furniture?').acceptedAnswer.text;
  assert.match(answer, /^Mattresses, appliances, hot tubs, and other special items are priced upfront/);
});

test('Garage Guard makes no scarcity or gift-card claims', () => {
  const guard = read('garage-guard.html');
  assert.doesNotMatch(text(guard), /gift card|only 5|5 spots|limited to 5/i);
  assert.match(text(guard), /That's \$208\.33\/month/);
});

test('the Terms state the 75% at completion and the 48-hour deposit line', () => {
  const terms = text(read('terms-of-service.html'));
  assert.match(terms, /A 25% deposit is due when you approve or sign your estimate, and the remaining 75% is due when the job is complete/);
  assert.match(terms, /If you cancel or reschedule at least 48 hours before your job, your deposit is refunded or moved to the new date; inside 48 hours it covers the crew we reserved\./);
  assert.match(terms, /removal-only jobs \(junk and single items\) may be priced from the photos and information you supply/);
  assert.doesNotMatch(terms, /75% is due on the job day/);
});
