import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './source-files.mjs';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { onRequestGet } from '../functions/projects/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('homepage metadata describes the new page and does not advertise removed FAQ or tutorial content', () => {
  const home = read('index.html');
  const title = home.match(/<title>([^<]+)<\/title>/)[1];
  const description = home.match(/<meta name="description" content="([^"]+)"/)[1];
  for (const field of ['og:title', 'twitter:title']) assert.ok(home.includes(`${field}" content="${title}"`));
  for (const field of ['og:description', 'twitter:description']) assert.ok(home.includes(`${field}" content="${description}"`));
  assert.doesNotMatch(home, /"@type": "(?:FAQPage|HowTo)"/);
  assert.equal((home.match(/data-gallery-cta="projects"/g) || []).length, 1);
});

test('articles have one byline, matching publication metadata and no empty image placeholder', () => {
  for (const file of readdirSync(new URL('../blog/', import.meta.url)).filter(f => f.endsWith('.html') && f !== 'index.html')) {
    const article = read('blog/' + file);
    const bylines = [...article.matchAll(/<(div|p) class="article-meta[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)];
    assert.equal(bylines.length, 1, file);
    assert.doesNotMatch(article, /<div class="article-hero-strip/);
    const schema = [...article.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(m => JSON.parse(m[1])).find(n => n['@type'] === 'BlogPosting');
    assert.ok(schema, file);
    assert.ok(article.includes(`property="article:published_time" content="${schema.datePublished}"`), file);
    if (!/\bUpdated\b/i.test(bylines[0][2])) {
      assert.equal(schema.dateModified, undefined, file);
      assert.doesNotMatch(article, /property="article:modified_time"/);
    }
  }
});

test('every enhanced page uses the stylesheet content hash and private workflows stay outside it', () => {
  const hash = createHash('sha256').update(read('public-experience.css')).digest('hex').slice(0, 12);
  let enhanced = 0;
  for (const file of sourceFiles(root).filter(f => f.isFile() && f.name.endsWith('.html'))) {
    const text = readFileSync(`${file.parentPath}/${file.name}`, 'utf8');
    if (!text.includes('/public-experience.css')) continue;
    enhanced++;
    assert.ok(text.includes(`/public-experience.css?v=${hash}`), file.name);
    assert.doesNotMatch(text.match(/<meta name="robots"[^>]+>/)?.[0] || '', /noindex/);
  }
  assert.equal(enhanced, 35);
  for (const name of ['employee.html', 'customer-portal.html', 'business-hub.html', 'quote.html', 'book.html', 'flat-rate-junk-removal-fort-collins-co.html']) assert.doesNotMatch(read(name), /public-experience\.css/);
});

test('presentation passes are repeatable and preserve service forms, pricing and approved story slots', () => {
  const result = spawnSync('python3', ['-c', `
from pathlib import Path
import re
from _public_experience import apply_public_experience, GUIDES
root=Path('.')
for path in ['index.html','projects/index.html',*GUIDES,'blog/garage-organizing-ideas-two-car-garage.html']:
    before=(root/path).read_text()
    after=apply_public_experience(before,path,root)
    assert after==apply_public_experience(after,path,root), path+' is not repeatable'
    for pattern in [r'<form\\b[\\s\\S]*?</form>',r'<section class="pricing"[\\s\\S]*?</section>']:
        assert re.findall(pattern,before)==re.findall(pattern,after), path+' changed an existing flow'
assert '<!-- DYNAMIC_PROJECTS -->' in apply_public_experience((root/'projects/index.html').read_text(),'projects/index.html',root)
private='<html><head><meta name="robots" content="noindex,nofollow"></head><body>Private fixture</body></html>'
assert apply_public_experience(private,'blog/private-fixture.html',root)==private
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the redesigned gallery still renders approved stories and excludes unapproved stories and private job details', async () => {
  const fetchBefore = globalThis.fetch;
  const base = { title: 'Synthetic garage reset', description: 'A clear space.', city: 'Fort Collins', serviceType: 'Garage cleanout', status: 'published', consentConfirmed: true, publishedAt: '2026-01-01T00:00:00Z' };
  const jobs = [
    { customer: 'Hidden Synthetic Person', address: '123 Private Fixture Lane', caseStudy: { ...base, slug: 'synthetic-approved' } },
    { caseStudy: { ...base, slug: 'synthetic-unapproved', consentConfirmed: false } },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(jobs.map((job, i) => ({ document: { name: `projects/demo/databases/(default)/documents/jobs/private-${i}`, fields: encodeFirestoreFields(job) } }))));
  try {
    const response = await onRequestGet({ env: { FIREBASE_API_KEY: 'firebase-test-public-gallery' }, next: async () => new Response(read('projects/index.html'), { headers: { 'Content-Type': 'text/html' } }) });
    const html = await response.text();
    assert.match(html, /href="\/projects\/synthetic-approved"/);
    assert.match(html, /egc-project-photo/);
    assert.doesNotMatch(html, /synthetic-unapproved|Hidden Synthetic Person|123 Private Fixture Lane|private-0/);
  } finally { globalThis.fetch = fetchBefore; }
});
