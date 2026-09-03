import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
