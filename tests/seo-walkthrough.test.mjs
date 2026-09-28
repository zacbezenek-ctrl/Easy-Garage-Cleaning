import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { sourceFiles } from './source-files.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const privateNames = new Set(['employee.html', 'employee-signup.html', 'customer-portal.html', 'quote.html', 'copilot.html', 'sop.html', 'staff-login.html', 'tyler-contract.html']);

const nonPublicDirs = new Set(['crew', 'contracts']);

// Built on sourceFiles() so this scan skips exactly what every other repo scan skips: agent
// worktrees (.claude/, worktrees/), dependencies, build output and local QA captures.
function publicHtml(base = root) {
  return sourceFiles(base)
    .filter(entry => entry.name.endsWith('.html') && !privateNames.has(entry.name)
      && !path.relative(base, entry.parentPath).split(path.sep).some(part => nonPublicDirs.has(part)))
    .map(entry => path.join(entry.parentPath, entry.name));
}

test('the public-copy scan reads only this checkout, never agent worktrees or QA output', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-public-html-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const planted = ['.claude/worktrees/agent-1/index.html', 'worktrees/agent-2/book.html', 'field-qa/report.html', '.lighthouseci/lhr-1.html',
    'test-results/field-qa/report.html', 'node_modules/synthetic/index.html', 'dist/index.html', 'crew/job.html', 'blog/contracts/sign.html', 'employee.html'];
  for (const file of ['index.html', 'blog/garage-tips.html', ...planted]) {
    fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
    fs.writeFileSync(path.join(temp, file), '<p>Text us for a photo quote.</p>');
  }
  const scanned = publicHtml(temp).map(file => path.relative(temp, file).split(path.sep).join('/')).sort();
  assert.deepEqual(scanned, ['blog/garage-tips.html', 'index.html']);
  assert.ok(publicHtml().some(file => path.relative(root, file) === 'book.html'), 'the real scan still reaches the public pages');
});

test('public marketing pages do not promise prices from photos', () => {
  const prohibited = [
    /photo[- ]quotes?/i,
    /flat[- ]rate from (?:your )?photos/i,
    /(?:exact|locked|flat[- ]rate) price from (?:your )?photos/i,
    /(?:flat[- ]rate )?pricing from (?:your )?photos/i,
    /usually from photos/i,
    /photos? (?:are|is) (?:usually )?all we need to lock/i,
    /text photos for (?:a )?(?:flat-rate )?walkthrough scheduling response/i,
  ];
  const failures = [];
  for (const file of publicHtml()) {
    const html = fs.readFileSync(file, 'utf8');
    for (const pattern of prohibited) if (pattern.test(html)) failures.push(`${path.relative(root, file)}: ${pattern}`);
  }
  assert.deepEqual(failures, []);
  const book = fs.readFileSync(path.join(root, 'book.html'), 'utf8');
  assert.match(book, /Schedule a free on-site garage walkthrough/i);
  assert.match(book, /We do not price the job from photos/i);
});

test('sitemap excludes retired duplicates and private conversion pages', () => {
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  for (const retired of ['loveland-garage-cleanout', 'windsor-garage-cleanout', 'wellington-junk-removal', 'thank-you']) {
    assert.doesNotMatch(sitemap, new RegExp(`<loc>[^<]*${retired}`));
  }
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, urls.length, 'sitemap URLs must be unique');
  assert.match(fs.readFileSync(path.join(root, 'projects/index.html'), 'utf8'), /DYNAMIC_PROJECTS/);
});

test('case-study publishing is manager-only, consent-gated, and privacy checked', async () => {
  const api = await import('../functions/api/case-study.js');
  const env = {
    HUB_SESSION_SECRET: 'case-study-test',
    FIREBASE_API_KEY: 'firebase-test-case-study',
    HUB_AUTH_USERS_JSON: JSON.stringify({
      ZacB: { passwordHash: 'test-zac', displayName: 'Zac', role: 'owner' },
      Crewtest: { passwordHash: 'test-crew', displayName: 'Crew Test', role: 'crew' },
    }),
  };
  const managerCookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const crewCookie = (await createHubSessionCookie(env, 'Crewtest')).split(';')[0];
  const baseBody = {
    jobId: 'job-1', title: 'Two-Car Garage Reset in Fort Collins', city: 'Fort Collins', serviceType: 'Garage cleanout',
    customerProblem: 'Boxes blocked both parking bays.', workCompleted: 'Sorted, donated, hauled, and swept.', result: 'Both cars fit again.',
    consentConfirmation: 'YES', publishConfirmation: 'PUBLISH',
  };
  const crewResponse = await api.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/case-study', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: crewCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(baseBody) }), env });
  assert.equal(crewResponse.status, 403);

  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if ((options.method || 'GET') === 'GET') return new Response(JSON.stringify({ name: 'projects/x/databases/(default)/documents/jobs/job-1', updateTime: '2026-09-04T10:00:00Z', fields: encodeFirestoreFields({ customer: 'Private Person', address: '123 Private Street', status: 'paid', serviceType: 'Garage cleanout' }) }), { status: 200 });
    writes += 1;
    const sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ name: 'projects/x/databases/(default)/documents/jobs/job-1', fields: sent.fields }), { status: 200 });
  };
  try {
    const response = await api.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/case-study', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: managerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(baseBody) }), env });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.caseStudy.status, 'published');
    assert.equal(body.caseStudy.consentConfirmed, true);
    assert.match(body.caseStudy.slug, /^two-car-garage-reset-in-fort-collins-/);
    assert.equal(writes, 1);

    const privateResponse = await api.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/case-study', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: managerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...baseBody, customerProblem: 'Private Person needed help.' }) }), env });
    assert.equal(privateResponse.status, 400);
    assert.equal(writes, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('published case-study pages are server-rendered without customer identity', async () => {
  const route = await import('../functions/projects/[slug].js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{ document: { name: 'projects/x/databases/(default)/documents/jobs/private-id', fields: encodeFirestoreFields({ customer: 'Hidden Customer', address: '123 Hidden Street', caseStudy: { slug: 'garage-reset-fort-collins-abc12', title: 'Garage Reset in Fort Collins', description: 'A cluttered two-car garage became useful again.', city: 'Fort Collins', serviceType: 'Garage cleanout', customerProblem: 'Both bays were blocked.', workCompleted: 'The crew sorted, donated, hauled, and swept.', result: 'The family can park inside again.', status: 'published', consentConfirmed: true, publishedAt: '2026-09-04T12:00:00Z', updatedAt: '2026-09-04T12:00:00Z' } }) } }]), { status: 200 });
  try {
    const response = await route.onRequestGet({ params: { slug: 'garage-reset-fort-collins-abc12' }, env: { FIREBASE_API_KEY: 'firebase-test-case-study' }, next: () => new Response('fallback', { status: 404 }) });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Garage Reset in Fort Collins/);
    assert.match(html, /application\/ld\+json/);
    assert.doesNotMatch(html, /Hidden Customer|123 Hidden Street|private-id/);
  } finally { globalThis.fetch = originalFetch; }
});
