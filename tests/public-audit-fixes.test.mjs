import {sourceFiles} from './source-files.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('homepage loads analytics outside the critical rendering path', () => {
  const html = read('index.html');
  assert.match(html, /<script src="\/analytics-loader\.js\?v=20260904b" defer><\/script>/);
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/www\.googletagmanager\.com\/gtag\/js/);
  assert.doesNotMatch(html, /<script[^>]*>[\s\S]*?connect\.facebook\.net\/en_US\/fbevents\.js[\s\S]*?<\/script>/);
  assert.doesNotMatch(html, /<script[^>]*>[\s\S]*?www\.clarity\.ms\/tag[\s\S]*?<\/script>/);
});

test('analytics is deferred site-wide and preserves the paid-campaign pixel mapping', () => {
  const root = new URL('../', import.meta.url);
  const pages = sourceFiles(root)
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }));
  for (const page of pages) {
    assert.doesNotMatch(page.html, /<script[^>]+src="https:\/\/www\.googletagmanager\.com\/gtag\/js/, `${page.name} loads Google Analytics directly`);
    assert.doesNotMatch(page.html, /<script[^>]*>[\s\S]*?www\.clarity\.ms\/tag[\s\S]*?<\/script>/, `${page.name} loads Clarity directly`);
  }
  const loader=read('analytics-loader.js');
  assert.match(loader,/data-meta-pixel-id/);
  assert.match(loader,/setTimeout\(startAnalytics, 2500\)/);
  assert.match(read('ads.html'),/data-meta-pixel-id="861741726934219"/);
  assert.match(read('thank-you.html'),/data-meta-pixel-id="861741726934219"/);
});

test('private employee portal does not load marketing analytics or preconnect to trackers', () => {
  const html = read('employee.html');
  assert.doesNotMatch(html, /analytics-loader\.js|googletagmanager\.com|connect\.facebook\.net|clarity\.ms/);
});

test('HTML media, external tabs, and forms keep release-safe attributes', () => {
  const root = new URL('../', import.meta.url);
  const pages = sourceFiles(root)
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }));
  const failures = [];
  for (const page of pages) {
    for (const [tag] of page.html.matchAll(/<img\b[^>]*>/gi)) {
      if (!/\balt\s*=/.test(tag)) failures.push(`${page.name}: image missing alt`);
      if (!/\bwidth\s*=/.test(tag) || !/\bheight\s*=/.test(tag)) failures.push(`${page.name}: image missing dimensions`);
    }
    for (const [tag] of page.html.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>/gi)) {
      if (!/\brel=["'][^"']*noopener/.test(tag)) failures.push(`${page.name}: _blank link missing noopener`);
    }
    if (/(?:href|src|action)=["']http:\/\/(?!localhost|127\.0\.0\.1)/i.test(page.html)) failures.push(`${page.name}: mixed-content URL`);
    for (const [form] of page.html.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
      if (/<button\b(?![^>]*\btype=)[^>]*>/i.test(form)) failures.push(`${page.name}: form button missing explicit type`);
    }
  }
  assert.deepEqual(failures, []);
});

test('homepage prioritizes a responsive, compressed LCP image', () => {
  const html = read('index.html');
  assert.match(html, /rel="preload"[^>]+job-before-after-1-824\.webp[^>]+imagesrcset=/);
  assert.match(html, /<source type="image\/webp"[^>]+job-before-after-1-824\.webp 824w[^>]+job-before-after-1\.webp 1646w/);
  assert.match(html, /<img[^>]+job-before-after-1\.jpg[^>]+fetchpriority="high"/);
  assert.doesNotMatch(html, /<img[^>]+job-before-after-1\.jpg[^>]+loading="lazy"/);
});

test('homepage exposes an accessible first-party contact widget', () => {
  const html = read('index.html');
  assert.match(html, /id="chat-widget"/);
  assert.match(html, /aria-controls="contact-widget-panel"/);
  assert.match(html, /href="sms:\+19709991818/);
  assert.match(html, /<script src="\/site-enhancements\.js\?v=20260903a" defer><\/script>/);
});

test('client hub empty-state logo preserves its aspect ratio', () => {
  const html = read('customer-portal.html');
  assert.match(html, /\.empty-state img\{height:auto\}/);
});

// styles.css is served immutable, so a browser keeps what a ?v= URL first returned for a year.
// The pin ties the version to the exact bytes: any change to styles.css, including a merge of two
// branches that each changed it, fails here until the version is bumped everywhere (HEAD and the
// patch_static_pages regex in _generate_site.py, functions/before-after.js, the private shells,
// then a rebuild) and this pin names the new version and hash.
const STYLES_RELEASE = { version: '20260928p', sha256: '3058352c20b6774915fab0b882ac3496fd22260bead970283c65c0f4fb0e41d9' };

test('Cloudflare caches versioned public assets', () => {
  const headers = read('_headers');
  const styles = read('styles.css');
  assert.match(headers, /\/styles\.css[\s\S]*max-age=31536000, immutable/);
  assert.match(headers, /\/images\/\*[\s\S]*max-age=31536000, immutable/);
  assert.match(styles, /body:has\(form:focus-within\) \.mobile-sticky-cta/);
  const root = new URL('../', import.meta.url);
  const pages = sourceFiles(root)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }))
    .filter((page) => page.html.includes('styles.css'));
  // STYLES_VERSION in _generate_site.py is the one styles.css version (HEAD, patch_static_pages, before-after); STYLES_RELEASE
  // ties it to the file's content, so a styles.css change must move every page to a version never served before.
  const version = read('_generate_site.py').match(/^STYLES_VERSION = "(\d{8}[a-z])"$/m)[1];
  assert.equal(version, STYLES_RELEASE.version);
  assert.equal(createHash('sha256').update(styles.replace(/\r\n/g, '\n')).digest('hex'), STYLES_RELEASE.sha256, `styles.css changed under ?v=${STYLES_RELEASE.version}, which browsers already cache as immutable: bump it everywhere to a version never served before and update STYLES_RELEASE`);
  for (const page of pages) assert.match(page.html, new RegExp(`styles\\.css\\?v=${version}["']`), `${page.name} loads a stale shared stylesheet`);
});

test('the shared visual refresh preserves readable text on light and dark surfaces', () => {
  const styles = read('styles.css');
  assert.match(styles, /h1\.hero-title\{[^}]*color:var\(--ink\)/);
  assert.match(styles, /\.hero\.hero-premium h1\.hero-title\{color:#fff\}/);
  assert.match(styles, /\.btn-secondary\[style\*="color:var\(--paper\)"\][^{]*\{background:transparent\}/);
  assert.doesNotMatch(styles, /\.hero \.form-card \.sms-consent\{color:var\(--muted-dark\)\}/);

  const estate = read('estate-cleanout-fort-collins.html');
  assert.match(estate, /\.nav \.nav-links a \{ color: var\(--ink\); \}/);
  assert.match(estate, /\.hero \.trust-pill \{[^}]*color: var\(--paper\);/);
  assert.match(estate, /\.how \.step h3 \{ color: var\(--white\); \}/);
  assert.match(estate, /\.faq button\.faq-q \{[^}]*background: transparent;[^}]*color: var\(--paper\);/);
  assert.match(estate, /\.section-sub \{ color: var\(--muted-light\); \}/);
  assert.match(estate, /\.how \.step \.step-num \{ color: var\(--accent\); \}/);

  const crew = read('crew/index.html');
  const legacy = read('fort-collins-junk-removal.html');
  const ads = read('ads.html');
  assert.match(crew, /\.next-card\.empty \.next-top>span\{color:#b63a0b\}/);
  assert.match(legacy, /\.faq \.section-label \{[^}]*color: var\(--accent-deep\);/);
  assert.match(ads, /\.hero \.form-card \.sms-consent \{ color: #4b5563; \}/);
  for (const page of ['loveland-garage-cleanout.html', 'wellington-junk-removal.html', 'windsor-garage-cleanout.html']) {
    assert.match(read(page), /\.form-card \.sms-consent \{ color: var\(--muted-dark\); \}/);
  }
});

test('garage turnaround keeps the landing-page quality through the full page', () => {
  const html = read('garage-turnaround-fort-collins-co.html');
  const css = read('garage-turnaround.css');
  assert.match(html, /garage-turnaround\.css\?v=20260904b/);
  for (const marker of ['turnaround-overview-grid', 'turnaround-audience', 'turnaround-proof', 'turnaround-pricing-grid', 'turnaround-included', 'turnaround-system', 'turnaround-local-notes']) {
    assert.match(html, new RegExp(marker), `${marker} is missing`);
    assert.match(css, new RegExp(`\\.${marker}`), `${marker} has no styling`);
  }
  assert.match(html, /One-day turnaround[\s\S]*\$1,200–\$2,200/);
  assert.match(html, /turnaround-card-index" aria-hidden="true"/);
  assert.match(html, /turnaround-step-index" aria-hidden="true"/);
  assert.match(html, /turnaround-check" aria-hidden="true"/);
  assert.doesNotMatch(css, /content:counter\(timeline\)|content:"✓"/);
  assert.match(css, /@media\(max-width:560px\)/);
  assert.doesNotMatch(html, /<section class="body-copy"><div class="wrap"><div class="body-copy-inner reveal"><(?:aside class="typical-job|div class="def-block")/);
});

test('private workflow shells are never indexed, framed, or cached', () => {
  const headers = read('_headers');
  for (const route of ['/employee*', '/crew/*', '/copilot*', '/quote*', '/tyler-contract*']) {
    assert.ok(headers.includes(route), `${route} is missing from Cloudflare headers`);
  }
  assert.match(headers, /X-Robots-Tag: noindex/);
  assert.match(headers, /Cache-Control: no-store/);
  assert.match(headers, /X-Frame-Options: DENY/);
});

test('every image has an explicit accessible text alternative', () => {
  const root = new URL('../', import.meta.url);
  const pages = sourceFiles(root)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }));
  for (const page of pages) {
    for (const image of page.html.matchAll(/<img\b[^>]*>/gi)) {
      assert.match(image[0], /\balt\s*=\s*["'][^"']*["']/i, `${page.name} has an image without alt text`);
    }
  }
});

test('every public lead form mirrors to HighLevel and carries its own consent disclosure', () => {
  const root = new URL('../', import.meta.url);
  const pages = sourceFiles(root)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }))
    .filter((page) => /<form[^>]*class=["'][^"']*(?:lead-form-lite|multi-step-form)/i.test(page.html));
  assert.ok(pages.length >= 45, 'expected the full lead-form page set');
  for (const page of pages) {
    assert.match(page.html, /<script[^>]+src="\/fb-capture\.js\?v=20260903c"[^>]*>/, `${page.name} does not load the current HighLevel mirror`);
    const forms = [...page.html.matchAll(/<form[^>]*class=["'][^"']*(?:lead-form-lite|multi-step-form)[^"']*["'][^>]*>([\s\S]*?)<\/form>/gi)];
    assert.ok(forms.length, `${page.name} has no readable lead form`);
    for (const form of forms) {
      assert.match(form[0], /name=["']sms_consent["']/, `${page.name} lead form has no SMS consent field`);
      assert.match(form[0], /href=["']\/privacy-policy["']/, `${page.name} lead form has no privacy link`);
      assert.match(form[0], /href=["']\/terms-of-service["']/, `${page.name} lead form has no terms link`);
    }
  }
});
