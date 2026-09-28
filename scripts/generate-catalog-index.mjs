/**
 * Catalog index for conversation extraction (P3-02). The Railway platform cannot read Hub files at
 * runtime, so this script copies the model-facing part of the versioned garage catalog
 * (functions/_data/garage-catalog.json) into egc-platform/packages/ai/src/catalog-index.generated.json:
 * ids, names, categories, brands and tiers only. Prices, costs, sources and notes never leave the Hub.
 * Hidden items are left out. With no catalog file the index is empty, so catalogItemId is always null.
 *   node scripts/generate-catalog-index.mjs            report; exit 1 when the committed index drifted
 *   node scripts/generate-catalog-index.mjs --write    regenerate the committed index
 */
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateCatalog} from '../functions/_lib/catalog.js';

export const REPO_ROOT=fileURLToPath(new URL('..',import.meta.url));
export const CATALOG='functions/_data/garage-catalog.json';
export const INDEX='egc-platform/packages/ai/src/catalog-index.generated.json';
export const INDEX_KEYS=['id','name','category','brands','tiers'];

/** The model-facing index of one validated catalog, or an empty index when there is no catalog. */
export function buildCatalogIndex(catalog){
  if(catalog==null)return {catalogVersion:null,items:[]};
  validateCatalog(catalog);
  const items=catalog.items.filter(item=>item.availability!=='hidden').map(item=>({id:item.id,name:item.name,category:item.category,brands:item.brand?[item.brand]:[],tiers:item.tier?[item.tier]:[]}));
  return {catalogVersion:catalog.catalogVersion,items};
}
// One item per line keeps catalog changes reviewable in diffs.
export function renderCatalogIndex(index){
  const items=index.items.length?`[\n${index.items.map(item=>`    ${JSON.stringify(item)}`).join(',\n')}\n  ]`:'[]';
  return `{\n  "catalogVersion": ${JSON.stringify(index.catalogVersion)},\n  "items": ${items}\n}\n`;
}
export function readCatalog(root=REPO_ROOT){
  const path=join(root,CATALOG);
  return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
}
export const expectedCatalogIndex=(root=REPO_ROOT)=>renderCatalogIndex(buildCatalogIndex(readCatalog(root)));

function main(){
  const args=new Set(process.argv.slice(2)),expected=expectedCatalogIndex(),path=join(REPO_ROOT,INDEX);
  if(args.has('--write')){writeFileSync(path,expected);console.log(`wrote ${INDEX}`);return;}
  if(!existsSync(path)||readFileSync(path,'utf8')!==expected){console.log(`✗ ${INDEX} is stale; run node scripts/generate-catalog-index.mjs --write`);process.exitCode=1;return;}
  console.log(`${INDEX} matches ${CATALOG}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
