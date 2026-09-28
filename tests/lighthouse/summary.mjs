/* Markdown baseline table from a Lighthouse CI filesystem upload (manifest.json) for the workflow step summary. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CATEGORIES = Object.freeze([['performance', 'Performance'], ['accessibility', 'Accessibility']]);
const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), mid = sorted.length >> 1; return !sorted.length ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

export function pageScores(manifest, paths = []) {
  const pages = new Map(paths.map(path => [path, []]));
  for (const run of Array.isArray(manifest) ? manifest : []) {
    let path;
    try { path = new URL(run.url).pathname; } catch { continue; }
    if (!pages.has(path)) pages.set(path, []);
    pages.get(path).push(run.summary || {});
  }
  return [...pages].map(([path, runs]) => ({ path, runs: runs.length, ...Object.fromEntries(CATEGORIES.map(([id]) => [id, median(runs.map(summary => summary[id]))])) }));
}

// A page counts as measured only when every category has a score; below-threshold counts use measured pages alone, so a
// partial collect reads as "not measured" instead of inflating the failures. `pending` lists required pages not shipped yet.
export function summarize(manifest, { minScore = 0.9, enforce = false, paths = [], pending = [] } = {}) {
  const rows = pageScores(manifest, paths), threshold = Math.round(minScore * 100), recorded = rows.some(row => row.runs > 0);
  const cell = score => score == null ? 'not measured' : score >= minScore ? String(Math.round(score * 100)) : `**${Math.round(score * 100)}** (below ${threshold})`;
  const measured = rows.filter(row => CATEGORIES.every(([id]) => row[id] != null)), unmeasured = rows.filter(row => !measured.includes(row));
  const below = measured.filter(row => CATEGORIES.some(([id]) => row[id] < minScore)).length;
  const missing = pending.filter(path => !rows.some(row => row.path === path));
  const list = items => items.map(path => `\`${path}\``).join(', ');
  return [
    '### Lighthouse mobile scores (median of runs, 375x812, simulated throttling)', '',
    enforce ? `Enforced: every page must score at least ${threshold}.` : `Warn-only: set the LIGHTHOUSE_ENFORCE repository variable to 'true' to fail the check below ${threshold}.`, '',
    `| Page | ${CATEGORIES.map(([, label]) => label).join(' | ')} | Runs |`, `| --- | ${CATEGORIES.map(() => '---:').join(' | ')} | ---: |`,
    ...rows.map(row => `| \`${row.path}\` | ${CATEGORIES.map(([id]) => cell(row[id])).join(' | ')} | ${row.runs} |`),
    ...missing.map(path => `| \`${path}\` | ${CATEGORIES.map(() => 'not measured (page missing)').join(' | ')} | 0 |`), '',
    recorded ? `${below} of ${measured.length} measured page(s) below ${threshold} in at least one category.` : 'No Lighthouse runs were recorded.',
    ...(recorded && unmeasured.length ? [`${unmeasured.length} page(s) not measured in every category: ${list(unmeasured.map(row => row.path))}.`] : []),
    ...(missing.length ? [`${missing.length} required page(s) missing from this checkout and not measured: ${list(missing)}.`] : []), '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = createRequire(import.meta.url)('./lighthouserc.cjs'), file = process.argv[2] || join(config.reportDir, 'manifest.json');
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  process.stdout.write(summarize(manifest, { minScore: config.minScore, enforce: process.env.LIGHTHOUSE_ENFORCE === 'true', paths: config.paths, pending: config.pending }));
}
