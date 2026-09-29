import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPages, siteExcludedDirs, staffPage } from './e2e/helpers/public-pages.mjs';
import { STAFF_GATED_PATHS, STAFF_PUBLIC_PATHS } from '../staff-paths.js';

// PUBLIC-TAP: the device e2e covers every public page, built from the site on disk.
const root = fileURLToPath(new URL('..', import.meta.url));
const pages = publicPages();
const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const noPython = probe.error || probe.status !== 0 ? 'python3 is not installed' : false;

function site(t, files, generator = 'PRIVATE_DIRS = frozenset({\n    ".claude", "crew", "Docs", "tests",\n    "functions",\n})\n') {
  const dir = mkdtempSync(join(tmpdir(), 'egc-public-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (generator !== null) writeFileSync(join(dir, '_generate_site.py'), generator);
  for (const file of files) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), '<!doctype html><title>Synthetic</title>'); }
  return dir;
}

test('every URL in sitemap.xml is a page the device e2e opens', () => {
  const urls = [...readFileSync(join(root, 'sitemap.xml'), 'utf8').matchAll(/<loc>https:\/\/easygaragecleaning\.com(\/[^<]*)<\/loc>/g)].map(match => match[1]);
  assert.ok(urls.length > 50, 'sitemap.xml lists the public site');
  for (const url of urls) {
    const path = url.endsWith('/') ? `${url}index.html` : /\.html$/.test(url) ? url : `${url}.html`;
    assert.ok(pages.includes(path), `${url} (${path}) is missing from the e2e page list`);
  }
});

test('the list is exactly the generator\'s public pages plus the customer app shells, never a staff page', { skip: noPython }, () => {
  const run = spawnSync('python3', ['-c', 'import json, _generate_site as g; print(json.dumps(["/" + p.relative_to(g.ROOT).as_posix() for p in g.site_html_files()]))'], { cwd: root, env: { ...process.env, EGC_SITE_BUILD_DATE: '2026-09-04', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const generated = JSON.parse(run.stdout);
  // Legacy files that _redirects 301s to their replacement are never served, so they are not opened.
  assert.deepEqual(generated.filter(path => !pages.includes(path)), ['/fort-collins-junk-removal.html', '/loveland-garage-cleanout.html', '/wellington-junk-removal.html', '/windsor-garage-cleanout.html']);
  for (const path of ['/junk-removal-fort-collins-co.html', '/garage-cleanouts-loveland-co.html', '/junk-removal-wellington-co.html', '/garage-cleanouts-windsor-co.html']) assert.ok(pages.includes(path), `${path} replaces a redirected legacy page`);
  // Served publicly but outside the generator: customer-facing app shells, each signed out here and with fixtures in hub-shells.spec.mjs.
  assert.deepEqual(pages.filter(path => !generated.includes(path)), ['/business-hub.html', '/customer-portal.html', '/quote.html']);
  for (const path of ['/faq.html', '/blog/index.html', '/what-we-take.html', '/thank-you.html', '/apply.html', '/projects/index.html', '/timnath-junk-removal.html', '/estate-cleanout-fort-collins.html', '/404.html', '/before-after.html']) assert.ok(pages.includes(path), path);
});

test('staff pages from staff-paths.js stay out of the list', () => {
  for (const path of pages) assert.equal(staffPage(path), false, path);
  const staff = ['/employee.html', '/employee-signup.html', '/dispatch.html', '/copilot.html', '/message-templates.html', '/staff-login.html', '/hub-login-setup.html', '/crew/index.html', '/crew/job.html', '/crew/offline.html'];
  for (const path of staff) {
    assert.ok(existsSync(join(root, path)), `${path} exists`);
    assert.equal(staffPage(path), true, path);
    assert.ok(!pages.includes(path), path);
  }
  assert.ok(STAFF_GATED_PATHS.includes('/employee.html') && STAFF_PUBLIC_PATHS.includes('/staff-login.html'));
  assert.equal(staffPage('/faq.html'), false);
  assert.equal(staffPage('/EMPLOYEE.html'), true, 'the gate matches case-insensitively');
});

test('a synthetic site: html in public directories only, dot and generator-private directories pruned, staff and redirected pages dropped', t => {
  const dir = site(t, [
    'index.html', 'faq.html', 'blog/index.html', 'blog/post.html', 'projects/index.html', 'customer-portal.html', 'legacy-rewrite.html', 'notes.txt', 'blog/draft.md',
    'employee.html', 'employee-signup.html', 'dispatch.html', 'copilot.html', 'message-templates.html', 'staff-login.html', 'hub-login-setup.html',
    'crew/index.html', 'crew/job.html', 'docs/guide.html', 'tests/fixture.html', 'functions/x.html', 'node_modules/pkg/doc.html',
    '.claude/worktrees/w/index.html', '.lighthouseci/report.html', '.drafts/post.html', 'blog/.old/post.html', 'test-results/report.html',
  ]);
  assert.deepEqual(publicPages(dir), ['/blog/index.html', '/blog/post.html', '/customer-portal.html', '/faq.html', '/index.html', '/legacy-rewrite.html', '/projects/index.html']);
  writeFileSync(join(dir, '_redirects'), '# legacy pages\n/faq.html  /help  301\n/blog/post  /blog/  308\n/legacy-rewrite  /index.html  200\n/projects/index.html /projects/\n');
  assert.deepEqual(publicPages(dir), ['/blog/index.html', '/customer-portal.html', '/index.html', '/legacy-rewrite.html'], 'a 3xx source (with or without .html, default status 302) is never served; a 200 rewrite is');
  assert.deepEqual([...siteExcludedDirs(dir)].sort(), ['.claude', 'crew', 'docs', 'functions', 'tests']);
});

test('a generator without a PRIVATE_DIRS block fails loudly instead of listing private directories', t => {
  const dir = site(t, ['index.html', 'docs/guide.html'], 'PRIVATE_HTML = frozenset({"sop.html"})\n');
  assert.throws(() => publicPages(dir), /_generate_site\.py has no PRIVATE_DIRS/);
  const missing = site(t, ['index.html'], null);
  assert.throws(() => siteExcludedDirs(missing), /ENOENT/);
});

test('the real generator PRIVATE_DIRS is what the helper reads', { skip: noPython }, () => {
  const run = spawnSync('python3', ['-c', 'import json, _generate_site as g; print(json.dumps(sorted(g.PRIVATE_DIRS)))'], { cwd: root, env: { ...process.env, EGC_SITE_BUILD_DATE: '2026-09-04', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([...siteExcludedDirs()].sort(), JSON.parse(run.stdout).map(name => name.toLowerCase()).sort());
});
