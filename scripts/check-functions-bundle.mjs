/**
 * Pages Functions bundle check (PRICE-SCRUB). Read-only. Run it on the Worker that
 * `wrangler pages functions build functions --outfile <bundle.js>` produces with the Wrangler
 * version Pages deploys with, passing the build output too:
 *   node scripts/check-functions-bundle.mjs <bundle.js> [<build.log>]
 * It fails (exit 1) when the bundler left a runtime import() of a module path in the Worker (a
 * Worker has no files to import, so that request fails at runtime: Wrangler 3 does this with JSON
 * import attributes), when the build log reports an unsupported dynamic import, or when the
 * walkthrough service prices /api/pricing-config serves are missing from the bundle.
 */
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {WALKTHROUGH_SERVICE_ITEMS} from '../functions/_data/walkthrough-services.js';

const RUNTIME_IMPORT=/\bimport\(\s*(["'`])([^"'`\n]{1,300})\1/g;
const LOG_PROBLEM=/\[(?:unsupported-dynamic-import|unsupported-require-call|ERROR)\]/;
const plainText=text=>String(text||'').replace(/\u001b\[[0-9;]*m/g,'');

export function bundleProblems(bundle,log=''){
  const problems=[],text=String(bundle||'');
  if(!text.trim())return ['the bundle is empty'];
  for(const match of text.matchAll(RUNTIME_IMPORT))problems.push(`runtime import(${JSON.stringify(match[2])}) was left in the bundle`);
  for(const line of plainText(log).split('\n'))if(LOG_PROBLEM.test(line))problems.push(`build log: ${line.trim().slice(0,200)}`);
  for(const item of WALKTHROUGH_SERVICE_ITEMS)if(!text.includes(item.id))problems.push(`walkthrough service ${item.id} is missing from the bundle`);
  return problems;
}

function main(){
  const [bundlePath,logPath]=process.argv.slice(2);
  if(!bundlePath){console.error('usage: node scripts/check-functions-bundle.mjs <bundle.js> [<build.log>]');process.exitCode=2;return;}
  const problems=bundleProblems(readFileSync(bundlePath,'utf8'),logPath?readFileSync(logPath,'utf8'):'');
  for(const problem of problems)console.log(`  ✗ ${problem}`);
  console.log(problems.length?`${problems.length} problem(s) in the Pages Functions bundle`:`Pages Functions bundle ok: no runtime imports, ${WALKTHROUGH_SERVICE_ITEMS.length} walkthrough services bundled`);
  if(problems.length)process.exitCode=1;
}
const entry=()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}};
if(entry())main();
