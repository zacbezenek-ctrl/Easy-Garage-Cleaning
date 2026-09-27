import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderPublicGallery } from '../functions/before-after.js';
import { isEntryPoint, renderBeforeAfter } from '../scripts/render-before-after.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Single source for the date the checked-in pages were built with. Every build rewrites
// tools/site-build.json with the date it stamped, so commit it together with the pages.
const BUILD_DATE_FILE = 'tools/site-build.json';
const BUILD_DATE = JSON.parse(readFileSync(join(root, BUILD_DATE_FILE), 'utf8')).buildDate;
const REBUILD_HINT = [
  `Rebuilt with buildDate ${BUILD_DATE} from ${BUILD_DATE_FILE}.`,
  `If you intentionally rebuilt with a new date, set "buildDate" in ${BUILD_DATE_FILE} to that date (the build writes it for you: commit ${BUILD_DATE_FILE} together with the regenerated pages).`,
  `Otherwise regenerate with the recorded date and commit the result: EGC_SITE_BUILD_DATE=${BUILD_DATE} npm run site:build`,
].join('\n');
const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const skip = probe.error || probe.status !== 0 ? 'python3 is not installed' : false;
// Other checkouts, dependencies and binary assets are never read by the build.
const NOT_COPIED = new Set(['.git', '.claude', 'node_modules', '.pnpm-store', '.wrangler', 'test-results', 'egc-platform', 'images', 'gallery-ideal-assets', 'gallery-preview-assets', 'internal-gallery-assets', '__pycache__']);
const PRIVATE_SHELLS = ['business-hub.html', 'dispatch.html', 'hub-login-setup.html', 'customer-portal.html', 'employee.html', 'copilot.html', 'quote.html', 'message-templates.html'];
// Bait for every rewrite the generator does: old analytics tags, a drawer without
// inert, a footer, .html links, lazy-load candidates and a title the SEO audit shortens.
const BAIT = `<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-SYNTHETIC"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());</script>
<title>Timnath Junk Removal & Garage Cleanout | Easy Garage Cleaning</title>
<link rel="stylesheet" href="/styles.css?v=synthetic">
<style>
.synthetic{color:red}


</style>
</head>
<body>
<nav class="nav" aria-label="Primary"></nav>
<aside class="nav-drawer" id="nav-drawer" aria-hidden="true"><a href="/about.html">About</a></aside>
<main><p>Text photos for a 5-minute quote.</p><img src="/synthetic.png" alt="Synthetic" width="1" height="1"></main>
<footer class="site-footer"></footer>
</body>
</html>
`;
const PLANTED = [
  '.claude/worktrees/x/index.html', '.claude/worktrees/x/blog/index.html', 'egc-platform/apps/web/index.html', 'node_modules/synthetic/docs/api.html',
  'tests/synthetic-fixture.html', 'docs/synthetic.html', 'functions/synthetic.html', 'tools/synthetic.html', 'crew/synthetic.html', 'client-login.html',
  // Local virtualenvs, framework/build caches, Lighthouse and QA output, and any other dot-directory.
  '.venv/lib/python3.12/site-packages/synthetic/index.html', 'venv/share/synthetic/doc.html', '.next/server/app/synthetic.html',
  '.turbo/cache/synthetic.html', '.cache/synthetic/index.html', '.lighthouseci/synthetic-report.html', 'test-results/synthetic-report.html',
  'field-qa/synthetic-report.html', '.synthetic-tool/blog/index.html', 'blog/.synthetic-drafts/index.html',
];

function snapshot(dir) {
  const files = new Map();
  (function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(relative(dir, full), readFileSync(full));
    }
  })(dir);
  return files;
}

function drift(before, after) {
  const changed = [];
  for (const [path, bytes] of before) if (!after.has(path)) changed.push(`deleted ${path}`); else if (!bytes.equals(after.get(path))) changed.push(`changed ${path}`);
  for (const path of after.keys()) if (!before.has(path)) changed.push(`created ${path}`);
  return changed.sort();
}

function python(cwd, args, env = {}) {
  const base = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete base.EGC_SITE_BUILD_DATE; delete base.SOURCE_DATE_EPOCH;
  return spawnSync('python3', args, { cwd, env: { ...base, ...env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 });
}

function build(site, buildDate = BUILD_DATE) {
  for (const args of [['_generate_site.py'], ['tools/gallery/publish-links.py']]) {
    const run = python(site, args, { EGC_SITE_BUILD_DATE: buildDate });
    assert.equal(run.status, 0, `${args[0]} failed: ${run.error?.message || ''}\n${run.stderr}`);
  }
}

test('the site build reproduces the checked-in pages, twice, without touching private surfaces', { skip, timeout: 900000 }, t => {
  const temp = mkdtempSync(join(tmpdir(), 'egc-site-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const site = join(temp, 'site');
  cpSync(root, site, { recursive: true, filter: source => source === root || !NOT_COPIED.has(basename(source)) });
  for (const path of PLANTED) { mkdirSync(dirname(join(site, path)), { recursive: true }); writeFileSync(join(site, path), BAIT); }
  const checkedIn = snapshot(site);

  const refused = python(site, ['_generate_site.py']);
  assert.notEqual(refused.status, 0, 'a non-interactive build without a fixed date must refuse to run');
  assert.match(refused.stderr, /EGC_SITE_BUILD_DATE/);
  assert.ok(refused.stderr.includes(`The checked-in pages use ${BUILD_DATE} (${BUILD_DATE_FILE})`), refused.stderr);
  assert.deepEqual(drift(checkedIn, snapshot(site)), [], 'a refused build must not write anything');

  build(site);
  const first = snapshot(site);
  const changed = drift(checkedIn, first);
  assert.deepEqual(changed, [], `generated output differs from the checked-in files (${changed.length}):\n${changed.slice(0, 20).join('\n')}\n${REBUILD_HINT}`);
  build(site);
  assert.deepEqual(drift(first, snapshot(site)), [], 'a second build must be byte-identical');

  for (const path of PLANTED) assert.equal(readFileSync(join(site, path), 'utf8'), BAIT, `${path} must never be rewritten`);
  for (const name of PRIVATE_SHELLS) {
    const html = readFileSync(join(site, name), 'utf8');
    assert.ok(html === checkedIn.get(name).toString('utf8'), `${name} was rewritten`);
    assert.doesNotMatch(html, /analytics-loader|googletagmanager|fbevents|clarity\.ms/, `${name} must not carry marketing analytics`);
  }
  const sitemap = readFileSync(join(site, 'sitemap.xml'), 'utf8');
  assert.equal(sitemap.split('<loc>https://easygaragecleaning.com/before-after</loc>').length - 1, 1);
  assert.match(sitemap, new RegExp(`<lastmod>${BUILD_DATE}</lastmod>`));
  const llms = readFileSync(join(site, 'llms.txt'), 'utf8');
  assert.match(llms, /^- https:\/\/easygaragecleaning\.com\/before-after$/m);
  assert.doesNotMatch(llms, /node_modules|\.claude|worktrees|egc-platform|synthetic|client-login|business-hub|\/dispatch|hub-login-setup|message-templates|\/employee|\/crew\/|venv|\.next|\.turbo|\.cache|lighthouse|test-results|field-qa/);
});

test('the recorded build date is the single source the drift check rebuilds with', { skip }, t => {
  assert.match(BUILD_DATE, /^\d{4}-\d{2}-\d{2}$/, `${BUILD_DATE_FILE} must hold {"buildDate": "YYYY-MM-DD"}`);
  assert.match(readFileSync(join(root, 'sitemap.xml'), 'utf8'), new RegExp(`<lastmod>${BUILD_DATE}</lastmod>`), `sitemap.xml was not built with ${BUILD_DATE}.\n${REBUILD_HINT}`);
  const temp = mkdtempSync(join(tmpdir(), 'egc-build-date-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'site-build.json');
  const record = (value, env = { EGC_SITE_BUILD_DATE: BUILD_DATE }) =>
    python(root, ['-c', `import sys, _generate_site as g; print(g.record_build_date(sys.argv[1], sys.argv[2]), g.recorded_build_date(sys.argv[2]))`, value, file], env);
  const missing = python(root, ['-c', 'import sys, _generate_site as g; print(g.recorded_build_date(sys.argv[1]))', file], { EGC_SITE_BUILD_DATE: BUILD_DATE });
  assert.equal(missing.stdout.trim(), 'None');
  assert.equal(record('2026-10-01').stdout.trim(), 'True 2026-10-01', 'a new build date is recorded');
  assert.equal(readFileSync(file, 'utf8'), '{\n  "buildDate": "2026-10-01"\n}\n');
  assert.equal(record('2026-10-01').stdout.trim(), 'False 2026-10-01', 'recording the same date again leaves the file alone');
  assert.equal(readFileSync(join(root, BUILD_DATE_FILE), 'utf8'), `{\n  "buildDate": "${BUILD_DATE}"\n}\n`, `${BUILD_DATE_FILE} is written by the build; keep its exact format`);
  writeFileSync(file, '{"buildDate": "yesterday"}');
  const invalid = python(root, ['-c', 'import sys, _generate_site as g; print(g.recorded_build_date(sys.argv[1]))', file], { EGC_SITE_BUILD_DATE: BUILD_DATE });
  assert.equal(invalid.stdout.trim(), 'None');
});

test('the build date comes only from EGC_SITE_BUILD_DATE or SOURCE_DATE_EPOCH outside a terminal', { skip }, () => {
  const today = env => python(root, ['-c', 'import _generate_site as g; print(g.TODAY)'], env);
  assert.equal(today({ EGC_SITE_BUILD_DATE: '2026-10-01' }).stdout.trim(), '2026-10-01');
  const epoch = 1790000000;
  assert.equal(today({ SOURCE_DATE_EPOCH: String(epoch) }).stdout.trim(), new Date(epoch * 1000).toISOString().slice(0, 10));
  assert.equal(today({ EGC_SITE_BUILD_DATE: '2026-10-01', SOURCE_DATE_EPOCH: String(epoch) }).stdout.trim(), '2026-10-01');
  for (const env of [{ EGC_SITE_BUILD_DATE: '2026-9-4' }, { EGC_SITE_BUILD_DATE: '2026-02-30' }, { SOURCE_DATE_EPOCH: 'yesterday' }, {}]) {
    const run = today(env);
    assert.notEqual(run.status, 0, JSON.stringify(env));
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /EGC_SITE_BUILD_DATE|SOURCE_DATE_EPOCH/);
  }
});

test('before-after.html is the server renderer output and the render script repairs drift', t => {
  assert.equal(readFileSync(join(root, 'before-after.html'), 'utf8'), renderPublicGallery(), 'run node scripts/render-before-after.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'egc-gallery-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const target = pathToFileURL(join(temp, '/'));
  assert.deepEqual(renderBeforeAfter(target, { check: true }), { changed: false, stale: true });
  writeFileSync(join(temp, 'before-after.html'), '<!doctype html><title>stale</title>');
  assert.deepEqual(renderBeforeAfter(target, { check: true }), { changed: false, stale: true });
  assert.equal(readFileSync(join(temp, 'before-after.html'), 'utf8'), '<!doctype html><title>stale</title>', 'check mode never writes');
  assert.deepEqual(renderBeforeAfter(target), { changed: true, stale: false });
  assert.equal(readFileSync(join(temp, 'before-after.html'), 'utf8'), renderPublicGallery());
  assert.deepEqual(renderBeforeAfter(target), { changed: false, stale: false });
});

test('the render script CLI runs when invoked through a symlinked checkout', t => {
  const temp = mkdtempSync(join(tmpdir(), 'egc-render-link-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const real = join(temp, 'real');
  for (const file of ['package.json', 'scripts/render-before-after.mjs', 'functions/before-after.js', 'functions/_lib/gallery-simple-data.js']) {
    mkdirSync(dirname(join(real, file)), { recursive: true });
    writeFileSync(join(real, file), readFileSync(join(root, file)));
  }
  writeFileSync(join(real, 'before-after.html'), '<!doctype html><title>stale</title>');
  const link = join(temp, 'link');
  symlinkSync(real, link, 'junction');
  const script = join(link, 'scripts', 'render-before-after.mjs');
  assert.equal(isEntryPoint(script, pathToFileURL(join(real, 'scripts', 'render-before-after.mjs')).href), true);
  assert.equal(isEntryPoint(join(link, 'package.json'), pathToFileURL(join(real, 'scripts', 'render-before-after.mjs')).href), false);
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint(join(temp, 'missing.mjs')), false);
  const node = args => spawnSync(process.execPath, args, { cwd: temp, encoding: 'utf8', timeout: 60000 });

  const stale = node([script, '--check']);
  assert.equal(stale.status, 1, 'check mode through a symlink must detect the stale page, not exit 0 silently');
  assert.match(stale.stderr, /before-after\.html is stale/);
  assert.equal(readFileSync(join(real, 'before-after.html'), 'utf8'), '<!doctype html><title>stale</title>');

  const write = node([script]);
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /re-rendered from functions\/before-after\.js/);
  assert.equal(readFileSync(join(real, 'before-after.html'), 'utf8'), renderPublicGallery());
  const current = node([script, '--check']);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /before-after\.html is current/);
});
