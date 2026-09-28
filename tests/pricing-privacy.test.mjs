import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './source-files.mjs';

// PRICE-SCRUB security invariant: internal price tables, pay and targets never ship as
// browser code. The site serves the repository root, except what the edge middleware
// keeps private (functions/, tests/, docs/, scripts/, tooling and deploy configs), so every
// other text file here is readable by anyone who can reach it. Public marketing prices
// (pricing.html ranges, Garage Guard plans) are public by design and match none of these.
// EGC_PRICING_SCAN_ROOT points the scan at another checkout (e.g. the pre-change tree).
const ROOT = process.env.EGC_PRICING_SCAN_ROOT ? resolve(process.env.EGC_PRICING_SCAN_ROOT) : fileURLToPath(new URL('..', import.meta.url));
const PRIVATE = /^(?:(?:auth-verifier|contracts|docs|scripts|tests|egc-platform|functions|tools|\.github|\.claude|node_modules)(?:\/|$)|_|package(?:-lock)?\.json$|README\.md$|firebase[^/]*\.json$|firestore\.rules$|pnpm-|\.env|(?:sop|tyler-contract)\.html$)|\.py$/i;
const SERVED = /\.(?:html?|m?js|css|json|txt|xml|webmanifest)$/i;

export function servedFiles(root = ROOT) {
  return sourceFiles(root).map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')).filter(path => SERVED.test(path) && !PRIVATE.test(path)).sort();
}

// Exact fragments of the tables, pay rules and targets this unit moved server-side.
export const KNOWN_INTERNAL = [
  '{1:450,2:650,3:850,other:1100}', '{light:.75,medium:1,full:1.35,packed:1.7}', 'Number(S.loads||0)*1000', "'Mattress':45", "'Piano / safe':150", "'Very heavy items':100",
  '{1:125,2:220,3:320,other:420}', '{metal:499,wood:449,plastic:349}', "'Storage tote',21.5", 'Math.max(450,Math.round(n/25)*25)', '{light:0,medium:30,full:60,packed:120}', '{1:60,2:90,3:120,other:150}',
  '2026-09-pest200-traps250', '$1,000 per full', 'Pest waste (+$200)', 'mouse trapping (+$250)', '+$400 for a one-car',
  '$20/hr crew', '$23/hr lead', '$20/crew-hour', 'crewHours*20', '2,250+', 'rental cost/job. Track',
  'paid.length * 30', 'fastLeads.length * 3', "Tyler's Payout", '<span class="bdg paid">$30</span>',
  'total = 150', 'cy * 35', 'fl * 20', 'low * 1.18', 'FREE_MILES', 'PRICE_PER_MILE',
  'Partner service savings', 'Coordinated properties<small>', 'Discounts do not stack', '<strong>10%</strong>', '<strong>15%</strong>',
  '$50 EGC gift card',
];

// Keys that make a numeric object literal a walkthrough price or minute table.
const TABLE_KEYS = new Set(['1', '2', '3', 'other', 'light', 'medium', 'full', 'packed', 'metal', 'wood', 'plastic', 'mattress', 'tires', 'electronics', 'appliances', 'refrigerator / freezer', 'paint / chemicals', 'piano / safe', 'very heavy items', 'long carry', 'stairs', 'crew', 'lead']);
const NUMERIC_OBJECT = /\{\s*(?:(?:'[^'\n]{1,40}'|"[^"\n]{1,40}"|[A-Za-z0-9_]+)\s*:\s*-?\d*\.?\d+\s*,\s*){2,}(?:'[^'\n]{1,40}'|"[^"\n]{1,40}"|[A-Za-z0-9_]+)\s*:\s*-?\d*\.?\d+\s*\}/g;
const PRICE_ENTRY = /\bprice\s*:\s*\d/g;
const UNIT_RATE = /\$\d[\d,]*(?:\.\d+)?\s*(?:\/\s*|per\s+)(?:hr|hour|crew[- ]hour|cubic yard|yd|floor|mi|mile|truckload|full load|load)\b/gi;
const TARGET = /\$\d[\d,]*\+?\s*target|target:\s*\$\d/gi;

export function findings(text) {
  const out = [];
  for (const fragment of KNOWN_INTERNAL) if (text.includes(fragment)) out.push(`internal constant ${JSON.stringify(fragment)}`);
  for (const match of text.matchAll(NUMERIC_OBJECT)) {
    const keys = [...match[0].matchAll(/(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+))\s*:/g)].map(key => (key[1] ?? key[2] ?? key[3]).toLowerCase());
    if (keys.filter(key => TABLE_KEYS.has(key)).length >= 2) out.push(`price-table shape ${match[0].slice(0, 80)}`);
  }
  for (const pattern of [PRICE_ENTRY, UNIT_RATE, TARGET]) for (const match of text.matchAll(pattern)) out.push(`price shape ${JSON.stringify(match[0])}`);
  return out;
}

test('the scan covers what the site serves: pages, scripts and crew tools, never functions/ or tests/', () => {
  const files = servedFiles();
  for (const path of ['index.html', 'pricing.html', 'employee.html', 'employee-suite.js', 'business-hub.js', 'crew/gameplan.html', 'crew/postjob.html', 'crew/walkthrough-pricing.js', 'employee-pricing.js']) assert.ok(files.includes(path), path);
  assert.deepEqual(files.filter(path => /^(?:functions|tests|docs|scripts|egc-platform|tools)\//.test(path) || path.startsWith('_')), []);
  assert.ok(files.length > 100, 'the whole static site is scanned');
});

test('the detectors catch every moved constant and table shape, and ignore public prices and ordinary numbers', () => {
  const internal = [
    "const size={1:450,2:650,3:850,other:1100}[S.garageSize]||650", "{'Mattress':45,'Refrigerator / freezer':60,'Tires':50}", "{ id:'fridge', name:'Refrigerator', price:60 }",
    "['Crew standard','$20/hr crew; $23/hr lead baseline.']", 'labor=Number(costs.labor??(crewHours?crewHours*20:0))', 'const jobPay  = paid.length * 30;',
    'if (cy > 0) { total += cy * 35; }', '($35 per cubic yard)', '+$20 per floor', "['Average ticket',c.aov,'Target: $2,250+']",
    '<strong>10%</strong><p>Partner service savings', "there's a $50 EGC gift card in it", '{light:0,medium:30,full:60,packed:120}', '$1/mi beyond 25 mi',
  ];
  for (const snippet of internal) assert.ok(findings(snippet).length > 0, snippet);
  const ordinary = [
    '<p>Most garages run $250–400; larger projects $650+.</p>', 'Garage Guard — $800/yr: four visits a year', '{weekly:8,biweekly:6,monthly:6,quarterly:4}',
    '{min:0,max:180,step:5}', '{completed:0,paid:1,scheduled:2}', "S.loads={1:'1',2:'1.5',3:'2',other:'2.5'}[value]", '50% deposit due upfront', 'Unused visits convert to $100 EGC gift cards',
    "`${money(PRICING.perLoad)} per full truckload`", 'Math.max(P.minimum,Math.round(n/P.roundTo)*P.roundTo)',
  ];
  for (const snippet of ordinary) assert.deepEqual(findings(snippet), [], snippet);
});

test('no browser-delivered file contains internal price tables, pay rules or targets', () => {
  const leaks = servedFiles().flatMap(path => findings(readFileSync(join(ROOT, path), 'utf8')).map(finding => `${path}: ${finding}`));
  assert.deepEqual(leaks, [], 'move these to functions/_lib/pricing-config.js and serve them by role from /api/pricing-config');
});
