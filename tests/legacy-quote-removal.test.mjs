import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// M15: /quote?id= contract links are retired (quote.html only offers a fresh
// portal link) and the legacy `quotes` collection has no browser access.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFileSync(join(root, name), 'utf8');
const SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', '.pnpm-store', '.next', '.turbo', '.wrangler', 'dist', 'test-results', 'tests', 'docs']);
const CODE = new Set(['.html', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py']);

function codeFiles(dir = root, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) codeFiles(join(dir, entry.name), files); }
    else if (entry.isFile() && CODE.has(extname(entry.name))) files.push(join(dir, entry.name));
  }
  return files;
}

// Returns [path, body] for each `match` block, with braces balanced.
function matchBlocks(rules) {
  const blocks = [];
  for (const found of rules.matchAll(/match\s+(\S+)\s*\{/g)) {
    let depth = 1, index = found.index + found[0].length;
    for (; depth && index < rules.length; index++) depth += rules[index] === '{' ? 1 : rules[index] === '}' ? -1 : 0;
    blocks.push([found[1], rules.slice(found.index + found[0].length, index - 1)]);
  }
  return blocks;
}
const ownAllows = body => [...body.replace(/match\s+\S+\s*\{[\s\S]*$/, '').matchAll(/allow\s+([a-z,\s]+?)\s*:\s*if\s+([^;]+);/g)].map(match => ({ operations: match[1].split(',').map(value => value.trim()), condition: match[2].trim() }));

test('no source generates retired /quote?id= links or writes the legacy quotes collection', () => {
  const files = codeFiles();
  assert.ok(files.some(file => file.endsWith('employee.html')), 'the scan must include the Employee Hub');
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (/quote\?id=/.test(source)) offenders.push(`${relative(root, file)}: /quote?id= link`);
    if (/collection\(\s*(?:\w+\s*,\s*)?['"`]quotes['"`]\s*\)|\bdoc\(\s*\w+\s*,\s*['"`]quotes['"`]|['"`]quotes\/[^'"`]*['"`]|documents\/quotes\b|collection\s*:\s*['"`]quotes['"`]/.test(source)) offenders.push(`${relative(root, file)}: quotes collection access`);
  }
  assert.deepEqual(offenders, []);
  assert.match(read('quote.html'), /This estimate link has been retired\./, 'old links land on the retirement page');
  assert.doesNotMatch(read('quote.html'), /firebase|firestore|\/api\//i, 'the retirement page must not read quote records');
});

test('firestore rules grant no client access to legacy quote records', () => {
  const rules = read('firestore.rules');
  const blocks = matchBlocks(rules);
  const quotes = blocks.filter(([path]) => path === '/quotes/{documentId}');
  assert.equal(quotes.length, 1, 'the retired collection stays documented explicitly');
  const allows = ownAllows(quotes[0][1]);
  assert.deepEqual(allows, [{ operations: ['read', 'write'], condition: 'false' }]);
  // Any other rule that could match /quotes/{id} (a wildcard first segment) must deny too.
  for (const [path, body] of blocks) {
    if (path === '/databases/{database}/documents' || !/^\/\{[^}]+\}/.test(path)) continue;
    for (const allow of ownAllows(body)) assert.equal(allow.condition, 'false', `${path} must not open legacy quotes`);
  }
  assert.ok(blocks.some(([path]) => path === '/{document=**}'), 'the deny-all catch-all remains');
});
