import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('homepage uses one request destination and preserves optional supporting detail', () => {
 const html=read('index.html'), nav=html.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];
 assert.doesNotMatch(html, /<form\b|id="seasonal-banner"|class="trust-strip"|id="egc-customer-access"|Popular <em>pages/);
 assert.doesNotMatch(nav, /Business Hub|Customer Portal|Reviews|FAQ|How It Works/);
 assert.match(nav, />Services</); assert.match(nav, />Pricing</); assert.match(nav, />Results</); assert.match(nav, />About</);
 assert.match(html, /class="home-details"/);
 for(const href of ['/book','/customer-portal','/business-hub','/what-we-take','/service-areas','/reviews']) assert.ok(html.includes(`href="${href}"`), href);
 assert.doesNotMatch(html, /href="#(?:quote|turnaround-plan)"/);
 assert.equal((html.match(/class="hero-contact"/g)||[]).length,1);
});

test('curbside pickup retains its own intake and never texts a walkthrough request', () => {
 const html=read('flat-rate-junk-removal-fort-collins-co.html');
 // Owner decision 2026-10-30: the $139 curbside price is retired; curbside pickup starts from $250.
 assert.doesNotMatch(html.replace(/<input\b[^>]*type="hidden"[^>]*>/g, ''), /\$139/); assert.match(html, /from <strong>\$250<\/strong>, our \$250 minimum to come out/);
 assert.match(html, /No walkthrough needed/);
 assert.match(html, /<form\b/); assert.match(html, /Request My Curbside Pickup/);
 assert.match(html, /Stage items at the curb, driveway, or open garage; we load and haul them/);
 assert.doesNotMatch(html, /you don(?:'|&rsquo;)t touch a thing|We do all lifting|(?:reply|replies|respond).*?5 minutes/i);
 assert.doesNotMatch(html, /\$400\s*(?:-|–|—|to)\s*\$?3,?500|nationals make you wait|Most national haulers|No - on-site estimate/);
 assert.match(html, /<h3>Full service<\/h3>/); assert.match(html, /Garage cleanouts start from \$675/);
 for(const [,href] of html.matchAll(/href="(sms:[^"]+)"/g)) assert.doesNotMatch(href,/walkthrough/);
});

test('pricing shows one pair of offers before explaining the process', () => {
 const html=read('pricing.html');
 assert.equal((html.match(/class="pricing-how-grid reveal"/g)||[]).length,1);
 assert.doesNotMatch(html, /class="price-card/);
 assert.ok(html.indexOf('class="pricing-how-grid') < html.indexOf('id="process"'));
 assert.match(html, /No walkthrough|no walkthrough/);
});
