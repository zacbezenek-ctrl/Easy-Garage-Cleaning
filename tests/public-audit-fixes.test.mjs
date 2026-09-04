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
  assert.match(headers, /\/styles\.css[\s\S]*max-age=31536000, immutable/);
  assert.match(headers, /\/images\/\*[\s\S]*max-age=31536000, immutable/);
});

test('every public lead form mirrors to HighLevel and carries its own consent disclosure', () => {
  const root = new URL('../', import.meta.url);
  const pages = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => ({ name: `${entry.parentPath}/${entry.name}`, html: readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8') }))
    .filter((page) => page.html.includes('lead-form-lite'));
  assert.ok(pages.length >= 50, 'expected the full lead-form page set');
  for (const page of pages) {
    assert.match(page.html, /<script[^>]+src=["'](?:\/)?fb-capture\.js(?:\?[^"']*)?["'][^>]*>/, `${page.name} does not load the HighLevel mirror`);
    const forms = [...page.html.matchAll(/<form[^>]*class=["'][^"']*lead-form-lite[^"']*["'][^>]*>([\s\S]*?)<\/form>/gi)];
    assert.ok(forms.length, `${page.name} has no readable lead form`);
    for (const form of forms) {
      assert.match(form[0], /name=["']sms_consent["']/, `${page.name} lead form has no SMS consent field`);
      assert.match(form[0], /href=["']\/privacy-policy["']/, `${page.name} lead form has no privacy link`);
      assert.match(form[0], /href=["']\/terms-of-service["']/, `${page.name} lead form has no terms link`);
    }
  }
});
