import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('homepage loads analytics outside the critical rendering path', () => {
  const html = read('index.html');
  assert.match(html, /<script src="\/analytics-loader\.js\?v=20260903a" defer><\/script>/);
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/www\.googletagmanager\.com\/gtag\/js/);
  assert.doesNotMatch(html, /<script[^>]*>[\s\S]*?connect\.facebook\.net\/en_US\/fbevents\.js[\s\S]*?<\/script>/);
  assert.doesNotMatch(html, /<script[^>]*>[\s\S]*?www\.clarity\.ms\/tag[\s\S]*?<\/script>/);
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

test('Cloudflare caches versioned public assets', () => {
  const headers = read('_headers');
  const styles = read('styles.css');
  assert.match(headers, /\/styles\.css[\s\S]*max-age=31536000, immutable/);
  assert.match(headers, /\/images\/\*[\s\S]*max-age=31536000, immutable/);
  assert.match(styles, /body:has\(form:focus-within\) \.mobile-sticky-cta/);
  const root = new URL('../', import.meta.url);
  const pages = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }))
    .filter((page) => page.html.includes('styles.css'));
  for (const page of pages) assert.match(page.html, /styles\.css\?v=20260904j/, `${page.name} loads a stale shared stylesheet`);
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
  assert.match(html, /garage-turnaround\.css\?v=20260904a/);
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
  const pages = readdirSync(root, { recursive: true, withFileTypes: true })
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
  const pages = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }))
    .filter((page) => page.html.includes('lead-form-lite'));
  assert.ok(pages.length >= 50, 'expected the full lead-form page set');
  for (const page of pages) {
    assert.match(page.html, /<script[^>]+src="\/fb-capture\.js\?v=20260903c"[^>]*>/, `${page.name} does not load the current HighLevel mirror`);
    const forms = [...page.html.matchAll(/<form[^>]*class=["'][^"']*lead-form-lite[^"']*["'][^>]*>([\s\S]*?)<\/form>/gi)];
    assert.ok(forms.length, `${page.name} has no readable lead form`);
    for (const form of forms) {
      assert.match(form[0], /name=["']sms_consent["']/, `${page.name} lead form has no SMS consent field`);
      assert.match(form[0], /href=["']\/privacy-policy["']/, `${page.name} lead form has no privacy link`);
      assert.match(form[0], /href=["']\/terms-of-service["']/, `${page.name} lead form has no terms link`);
    }
  }
});
