/**
 * Walkthrough services module (PRICE-SCRUB). functions/_data/garage-catalog.json stays the single
 * source of the legacy walkthrough service prices and minutes; this writes the slice the Worker
 * prices with (the legacy service items) to functions/_data/walkthrough-services.js as a plain ES
 * module. Pages bundles plain modules on every Wrangler version, while a JSON import needs import
 * attributes that Wrangler 3 (esbuild 0.17) leaves as a runtime import() the Worker cannot resolve.
 * It also keeps the 600KB catalog out of the Worker. tests/pricing-config.test.mjs fails when the
 * module no longer matches the catalog.
 *   node scripts/generate-walkthrough-services.mjs            report; exit 1 when the module is stale
 *   node scripts/generate-walkthrough-services.mjs --write    regenerate the module from the catalog
 */
import {readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validateCatalog} from '../functions/_lib/catalog.js';

export const CATALOG=fileURLToPath(new URL('../functions/_data/garage-catalog.json',import.meta.url));
export const MODULE=fileURLToPath(new URL('../functions/_data/walkthrough-services.js',import.meta.url));
export const readCatalog=(path=CATALOG)=>JSON.parse(readFileSync(path,'utf8'));

// Every catalog service item with legacy walkthrough terms, in catalog order, with only the
// fields the walkthrough prices from (availability decides at request time, as before).
export const walkthroughServiceSlice=catalog=>validateCatalog(catalog).items.filter(item=>item.kind==='service'&&item.legacy)
  .map(({id,kind,availability,fixedPriceCents,legacy})=>({id,kind,availability,fixedPriceCents,legacy}));

export function renderWalkthroughServices(catalog){
  const items=walkthroughServiceSlice(catalog);
  if(!items.length)throw new Error('The garage catalog has no legacy walkthrough service items.');
  return ['// Generated from functions/_data/garage-catalog.json by scripts/generate-walkthrough-services.mjs.',
    '// Do not edit: change the catalog, then run `node scripts/generate-walkthrough-services.mjs --write`.',
    '// The legacy walkthrough service items /api/pricing-config prices with, as a plain module so every',
    '// Pages bundler includes them without JSON import attributes.',
    'export const WALKTHROUGH_SERVICE_ITEMS = [',...items.map(item=>`  ${JSON.stringify(item)},`),'];',''].join('\n');
}

function main(){
  const write=process.argv.includes('--write'),text=renderWalkthroughServices(readCatalog()),current=existsSync(MODULE)&&readFileSync(MODULE,'utf8')===text;
  if(write&&!current)writeFileSync(MODULE,text);
  console.log(write?(current?'functions/_data/walkthrough-services.js is already current':'wrote functions/_data/walkthrough-services.js'):current?'functions/_data/walkthrough-services.js matches the catalog':'  ✗ functions/_data/walkthrough-services.js is stale; run node scripts/generate-walkthrough-services.mjs --write');
  if(!write&&!current)process.exitCode=1;
}
const entry=()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}};
if(entry())main();
