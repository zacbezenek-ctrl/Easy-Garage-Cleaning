import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPages } from './e2e/helpers/public-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://easygaragecleaning.com';

function staticTarget(pathname) {
  const path = resolve(root, '.' + decodeURIComponent(pathname));
  for (const candidate of [path, path + '.html', resolve(path, 'index.html')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

test('public navigation reaches existing local pages and fragment targets', () => {
  const failures = [];
  for (const path of publicPages()) {
    const html = readFileSync(resolve(root, '.' + path), 'utf8');
    for (const [, raw] of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
      const url = new URL(raw.replace(/&amp;/g, '&'), origin + path);
      if (!['http:', 'https:'].includes(url.protocol) || ![new URL(origin).host, 'www.easygaragecleaning.com'].includes(url.host)) continue;
      // API links are served by Pages Functions; this check owns static navigation only.
      if (url.pathname.startsWith('/api/')) continue;
      const target = staticTarget(url.pathname);
      if (!target) { failures.push(`${path}: ${raw} has no local target`); continue; }
      const fragment = decodeURIComponent(url.hash.slice(1));
      // HTML defines #top and an empty fragment as the top of the document.
      if (!fragment || fragment.toLowerCase() === 'top' || !target.endsWith('.html')) continue;
      const text = readFileSync(target, 'utf8');
      const ids = new Set([
        ...[...text.matchAll(/\sid=["']([^"']+)["']/gi)].map(match => match[1]),
        ...[...text.matchAll(/<a\b[^>]*\sname=["']([^"']+)["']/gi)].map(match => match[1]),
      ]);
      if (!ids.has(fragment)) failures.push(`${path}: ${raw} has no fragment target`);
    }
  }
  assert.deepEqual(failures, []);
});
