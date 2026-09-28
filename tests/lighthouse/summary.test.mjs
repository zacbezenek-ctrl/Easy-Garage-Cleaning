import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageScores, summarize } from './summary.mjs';

const config = createRequire(import.meta.url)('./lighthouserc.cjs');

const run = (path, performance, accessibility) => ({ url: `http://127.0.0.1:9393${path}`, isRepresentativeRun: false, summary: { performance, accessibility } });
const manifest = [run('/', 0.91, 0.95), run('/', 0.85, 0.95), run('/', 0.93, 0.95), run('/book', 0.97, 0.88), run('/book', 0.99, 0.88), run('/book', 0.98, 0.9)];

test('scores are the median of each page\'s runs', () => {
  assert.deepEqual(pageScores(manifest), [{ path: '/', runs: 3, performance: 0.91, accessibility: 0.95 }, { path: '/book', runs: 3, performance: 0.98, accessibility: 0.88 }]);
  const [even] = pageScores([run('/x', 0.8, 1), run('/x', 0.9, 1)]);
  assert.ok(Math.abs(even.performance - 0.85) < 1e-9);
  assert.equal(even.accessibility, 1);
  assert.deepEqual(pageScores([{ url: 'not a url' }, run('/y', null, 0.9)]), [{ path: '/y', runs: 1, performance: null, accessibility: 0.9 }]);
});

test('the summary flags pages below the threshold and pages that were never measured', () => {
  const text = summarize(manifest, { minScore: 0.9, paths: ['/', '/book', '/field-today'] });
  assert.match(text, /Warn-only: set the LIGHTHOUSE_ENFORCE repository variable to 'true'/);
  assert.match(text, /\| `\/` \| 91 \| 95 \| 3 \|/);
  assert.match(text, /\| `\/book` \| 98 \| \*\*88\*\* \(below 90\) \| 3 \|/);
  assert.match(text, /\| `\/field-today` \| not measured \| not measured \| 0 \|/);
  assert.match(text, /1 of 2 measured page\(s\) below 90 in at least one category\./);
  assert.match(text, /1 page\(s\) not measured in every category: `\/field-today`\./);
  assert.doesNotMatch(text, /of 3/, 'an unmeasured page is never counted as a page below the threshold');
  assert.match(summarize(manifest, { enforce: true }), /Enforced: every page must score at least 90\./);
  assert.match(summarize([], {}), /No Lighthouse runs were recorded\./);
});

test('a partial collect counts only measured pages and lists required pages that are missing', () => {
  const partial = [run('/', 0.95, 0.96), run('/', 0.97, 0.96), run('/book', 0.95, null), run('/pricing', 0.85, 0.92)];
  const text = summarize(partial, { minScore: 0.9, paths: ['/', '/book', '/pricing', '/field-today'], pending: ['/client-login'] });
  assert.match(text, /\| `\/book` \| 95 \| not measured \| 1 \|/);
  assert.match(text, /\| `\/client-login` \| not measured \(page missing\) \| not measured \(page missing\) \| 0 \|/);
  assert.match(text, /^1 of 2 measured page\(s\) below 90 in at least one category\.$/m);
  assert.match(text, /^2 page\(s\) not measured in every category: `\/book`, `\/field-today`\.$/m);
  assert.match(text, /^1 required page\(s\) missing from this checkout and not measured: `\/client-login`\.$/m);
  const all = summarize([run('/', 0.95, 0.95)], { paths: ['/'], pending: [] });
  assert.match(all, /^0 of 1 measured page\(s\) below 90 in at least one category\.$/m);
  assert.doesNotMatch(all, /not measured/);
  const none = summarize([], { paths: ['/', '/book'], pending: ['/client-login'] });
  assert.match(none, /^No Lighthouse runs were recorded\.$/m);
  assert.doesNotMatch(none, /measured page\(s\) below|not measured in every category/);
  assert.match(none, /missing from this checkout and not measured: `\/client-login`/);
  const shipped = summarize([...partial, run('/client-login', 0.97, 0.98)], { paths: ['/', '/client-login'], pending: ['/client-login'] });
  assert.equal(shipped.match(/^\| `\/client-login` \|/gm).length, 1, 'a pending page that was audited gets one row');
  assert.match(shipped, /\| `\/client-login` \| 97 \| 98 \| 1 \|/);
  assert.doesNotMatch(shipped, /page missing|missing from this checkout/);
});

test('the command-line summary reads the default report folder and names the pending Client Login page', () => {
  const out = spawnSync(process.execPath, [fileURLToPath(new URL('./summary.mjs', import.meta.url)), join(tmpdir(), 'egc-lighthouse-no-such-dir', 'manifest.json')], { encoding: 'utf8', env: { ...process.env, LIGHTHOUSE_ENFORCE: 'true' } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Enforced: every page must score at least 90\./);
  assert.match(out.stdout, /No Lighthouse runs were recorded\./);
  for (const path of config.paths) assert.match(out.stdout, new RegExp(`\\| \`${path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\` \\| not measured \\| not measured \\| 0 \\|`), path);
  for (const path of config.pending) assert.match(out.stdout, new RegExp(`\`${path}\` \\| not measured \\(page missing\\)`), path);
});
