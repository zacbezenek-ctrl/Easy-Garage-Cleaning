// Static-hosting fallback for /before-after. functions/before-after.js is the
// only source; this file never edits the markup, it writes renderPublicGallery().
//   node scripts/render-before-after.mjs          write before-after.html
//   node scripts/render-before-after.mjs --check  exit 1 when the fallback is stale
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPublicGallery } from '../functions/before-after.js';

export function renderBeforeAfter(root = new URL('../', import.meta.url), { check = false } = {}) {
  const target = new URL('before-after.html', root);
  const html = renderPublicGallery();
  let current = null;
  try { current = readFileSync(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current === html) return { changed: false, stale: false };
  if (check) return { changed: false, stale: true };
  writeFileSync(target, html);
  return { changed: true, stale: false };
}

// Node resolves symlinks in import.meta.url but not in argv[1]; compare real paths so a
// symlinked checkout never turns the CLI (and --check) into a silent no-op.
export function isEntryPoint(argv1 = process.argv[1], self = import.meta.url) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(self)); } catch { return false; }
}

if (isEntryPoint()) {
  const check = process.argv.includes('--check');
  const result = renderBeforeAfter(undefined, { check });
  if (result.stale) {
    console.error('before-after.html is stale; run node scripts/render-before-after.mjs');
    process.exit(1);
  }
  console.log(result.changed ? 'before-after.html re-rendered from functions/before-after.js' : 'before-after.html is current');
}
