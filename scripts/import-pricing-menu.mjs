/**
 * Pricing menu import (WP14b). Reads the owner's pricing workbook exported as CSV (one file per sheet) and writes
 * the public product data the estimator quote builder prices from:
 *   functions/_data/pricing-menu.json   the menu (source of truth, reviewed in diffs)
 *   functions/_data/pricing-menu.js     the same JSON as a plain module the Worker bundles (no JSON import attributes)
 * Only two sheets are read, and from them only allowlisted columns:
 *   Visual_products.csv  product name, Home Depot internet SKU, units per pack, public retail per pack (the goods cost
 *                        basis, like garage-catalog.json retailPriceHighCents), category, product / source / photo
 *                        URLs, per-order pack limit, fit warnings with every sentence that states a dollar amount
 *                        removed (sales logins read them; the cost basis is internal), retail evidence and the
 *                        approval status
 *   Item_menu.csv        item id, group, name, unit, owner-approval status, the approved amount of an APPROVED row
 *                        only, and its scope note with any sentence about money, margin or commission removed
 * The repository is public: margins, proposed or historical selling prices, commission, CAC, wage and labor
 * numbers are never read, and no other sheet (Inputs, Owner review, Garage, Junk, Sensitivity, Approvals, Actual
 * jobs, ...) is opened. Every product is imported as DRAFT; a service is approved only when the sheet says
 * "Approved" (today, by the owner decision of 2026-10-21: the full truck $1,000 and the quarter, half and three-quarter
 * loads $250, $500 and $750; the workbook still says $750 for the truck and has the loads pending, so update its
 * EGC-023..EGC-026 rows before re-importing or the import puts the old prices back). The draft amounts of service items come from the walkthrough price
 * tables at request time (functions/_lib/pricing-config.js), never from the workbook. The prices the owner approved
 * in code (menu.approvals: every draft price of menu 2026-10-16.2, by the owner decision of 2026-10-30) are not in the
 * workbook: a re-import carries them over from the committed menu, and an item the re-import changes (name, unit, pack or
 * price basis: menuItemIdentity) no longer matches its approval and is a draft again.
 *   node scripts/import-pricing-menu.mjs --from <csv folder>            report what would change; exit 1 when stale
 *   node scripts/import-pricing-menu.mjs --from <csv folder> --write    write the JSON and the module
 *   node scripts/import-pricing-menu.mjs --check                        the module matches the JSON and it validates
 * Options: --menu-version YYYY-MM-DD.N (default <evidence date>.1), --evidence-date YYYY-MM-DD (default 2026-10-16).
 */
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePricingMenu} from '../functions/_lib/composite-quote.js';

export const REPO_ROOT=fileURLToPath(new URL('..',import.meta.url));
export const MENU_JSON='functions/_data/pricing-menu.json',MENU_MODULE='functions/_data/pricing-menu.js';
export const EVIDENCE_DATE='2026-10-16';
export const SHEETS={products:'Visual_products.csv',items:'Item_menu.csv'};
const DRAFT_STATUS='DRAFT PRODUCT; pricing and installation scope not approved';

// Workbook product categories -> builder step and group (functions/_lib/composite-quote.js BUILDER_SECTIONS).
export const CATEGORY_GROUPS={
  'Shelving':['shelving','shelving'],'Overhead storage':['storage','overhead'],'Hooks & racks':['storage','hooks-racks'],'Track system':['storage','track-systems'],
  'Bins & totes':['storage','bins-totes'],'Totes':['storage','bins-totes'],'Cabinets & workbenches':['storage','cabinets-workbenches'],'Bike storage':['storage','bike-storage'],
  'Small-parts organizers':['storage','small-parts'],'Pegboards & accessories':['storage','pegboards'],
};
// Item_menu rows the builder quotes, by item id: removal-step group, line category, and where the draft amount
// comes from (a walkthrough price table key, or a fraction of the full-truck price). Rows not listed here are not
// imported: Labor (a planning benchmark, not a line), the minimum-load options (policy pending), and the generic
// Storage rows (shelving and storage are quoted from Visual_products SKUs).
const W=(table,key)=>({kind:'walkthrough',table,key}),J=fraction=>({kind:'junk',fraction});
export const ITEM_BASIS={
  'EGC-002':['cleaning-base','service',W('sizeBase','1'),'1'],'EGC-003':['cleaning-base','service',W('sizeBase','2'),'2'],'EGC-004':['cleaning-base','service',W('sizeBase','3'),'3'],'EGC-005':['cleaning-base','service',W('sizeBase','other'),'other'],
  'EGC-006':['cleaning','service',W('services','pressure_wash')],
  'EGC-007':['cleaning','service',W('deep_clean','1'),'1'],'EGC-008':['cleaning','service',W('deep_clean','2'),'2'],'EGC-009':['cleaning','service',W('deep_clean','3'),'3'],'EGC-010':['cleaning','service',W('deep_clean','other'),'other'],
  'EGC-011':['cleaning','service',W('hazards','Pest waste')],'EGC-012':['cleaning','service',W('services','mouse_trapping')],
  'EGC-023':['junk','removal',J(0.25)],'EGC-024':['junk','removal',J(0.5)],'EGC-025':['junk','removal',J(0.75)],'EGC-026':['junk','removal',J(1)],
  'EGC-027':['special','removal',W('special','Mattress')],'EGC-028':['special','removal',W('special','Box spring')],'EGC-029':['special','removal',W('special','Couch / sofa / loveseat')],
  'EGC-030':['special','removal',W('special','Sectional')],'EGC-031':['special','removal',W('special','Recliner / armchair')],'EGC-032':['special','removal',W('special','Dresser / armoire / desk')],
  'EGC-033':['special','removal',W('special','Refrigerator / freezer')],'EGC-034':['special','removal',W('special','Washer')],'EGC-035':['special','removal',W('special','Dryer')],
  'EGC-036':['special','removal',W('special','Water heater')],'EGC-037':['special','removal',W('special','Appliances')],'EGC-038':['special','removal',W('special','BBQ grill')],
  'EGC-039':['special','removal',W('special','Electronics')],'EGC-040':['special','removal',W('special','Tires')],'EGC-041':['special','removal',W('special','Paint / chemicals')],
  'EGC-042':['special','removal',W('special','Treadmill / elliptical')],'EGC-043':['special','removal',W('special','Home gym / weight set')],'EGC-044':['special','removal',W('special','Very heavy items')],
  'EGC-045':['special','removal',W('special','Piano / safe')],'EGC-046':['special','removal',W('special','Hot tub / spa')],
  'EGC-047':['access','removal',W('access','Long carry')],'EGC-048':['access','removal',W('access','Stairs')],
};
const UNITS={job:'job',load:'load',item:'item',bundle:'bundle',unit:'item'};
// A scope-note sentence that mentions money, margin, markup, commission, wages or acquisition cost is dropped.
const SENSITIVE=/\$|\d\s*%|margin|mark-?up|commission|\bcac\b|wage|payroll|contribution|\bx\s?\d|cost\s*\/|\/\s*0?\.\d|benchmark|proposed price|old proposed/i;

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Returns rows of strings. */
export function parseCsv(text){
  const rows=[];let row=[],field='',quoted=false;
  const source=String(text).replace(/^﻿/,'');
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(quoted){if(c==='"'){if(source[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=c;continue;}
    if(c==='"'&&field==='')quoted=true;
    else if(c===',')row.push(field),field='';
    else if(c==='\n'||c==='\r'){if(c==='\r'&&source[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';}
    else field+=c;
  }
  if(quoted)throw new Error('CSV ends inside a quoted field');
  if(field!==''||row.length)row.push(field),rows.push(row);
  return rows;
}

// The header row is the first row that names every required column; only those columns are ever read.
function table(rows,required,sheet){
  const at=rows.findIndex(row=>required.every(name=>row.map(cell=>cell.trim()).includes(name)));
  if(at<0)throw new Error(`${sheet}: no header row with ${required.join(', ')}`);
  const header=rows[at].map(cell=>cell.trim()),index=Object.fromEntries(required.map(name=>[name,header.indexOf(name)]));
  return rows.slice(at+1).map((row,offset)=>({line:at+offset+2,get:name=>String(row[index[name]]??'').trim()}));
}
const oneLine=value=>String(value||'').replace(/\s+/g,' ').trim();
function cents(value,where){
  if(!/^\d+(?:\.\d{1,2})?$/.test(value))throw new Error(`${where}: "${value}" is not a dollar amount`);
  return Math.round(Number(value)*100);
}
function whole(value,where){
  const n=Number(value);
  if(!/^\d+(?:\.0+)?$/.test(value)||!Number.isSafeInteger(n)||n<1)throw new Error(`${where}: "${value}" is not a whole number`);
  return n;
}
function url(value,where,{optional=false}={}){
  if(!value&&optional)return null;
  let parsed;try{parsed=new URL(value);}catch{throw new Error(`${where}: "${value.slice(0,80)}" is not a URL`);}
  if(parsed.protocol!=='https:')throw new Error(`${where}: URL must be https`);
  return value;
}
const sentences=value=>oneLine(value).split(/(?<=[.;!?])\s+/).filter(Boolean);
export const scrubNote=value=>{const kept=sentences(value).filter(sentence=>!SENSITIVE.test(sentence)).join(' ').slice(0,600).trim();return kept||null;};
// Fit warnings reach sales logins and the job breakdown: a sentence stating a dollar amount (a retail price, which is
// the goods cost basis) is dropped; sizes, weights and fit notes stay.
const MONEY=/\$\s?\d|\d\s?(?:dollars?|usd)\b|\d\s?¢/i;
export const scrubWarnings=value=>{const kept=sentences(value).filter(sentence=>!MONEY.test(sentence)).join(' ').slice(0,1000).trim();return kept||null;};

const PRODUCT_COLUMNS=['Product / pack','Internet SKU','Units per pack','Retail per pack','Product / price source','Fit / sourcing warnings','Photo URL','Per-order pack limit','Category','Retail evidence / date','Offering / approval status','Product URL'];
const ITEM_COLUMNS=['Item ID','Group','Item','Unit','Owner approval','Direct estimator price','Inclusions / exclusions'];

/** Product rows of Visual_products.csv. A row without an internet SKU is a sheet note and is skipped. */
export function importProducts(text,{evidenceDate=EVIDENCE_DATE}={}){
  const products=[];
  for(const row of table(parseCsv(text),PRODUCT_COLUMNS,SHEETS.products)){
    const sku=row.get('Internet SKU'),where=`${SHEETS.products} line ${row.line}`;
    if(!sku)continue;
    if(!/^\d{6,12}$/.test(sku))throw new Error(`${where}: internet SKU "${sku}" is not 6 to 12 digits`);
    if(row.get('Offering / approval status')!==DRAFT_STATUS)throw new Error(`${where}: status "${row.get('Offering / approval status')}" is not the draft status; no approval is inferred from an import`);
    const mapped=CATEGORY_GROUPS[row.get('Category')];
    if(!mapped)throw new Error(`${where}: category "${row.get('Category')}" has no builder step`);
    const limit=row.get('Per-order pack limit'),warnings=scrubWarnings(row.get('Fit / sourcing warnings'));
    products.push({id:`hd-${sku}`,sku,retailer:'The Home Depot',name:oneLine(row.get('Product / pack')).slice(0,160),section:mapped[0],group:mapped[1],
      unitsPerPack:whole(row.get('Units per pack'),`${where} units per pack`),retailPerPackCents:cents(row.get('Retail per pack'),`${where} retail per pack`),
      perOrderPackLimit:!limit||/^not stated$/i.test(limit)?null:whole(limit,`${where} per-order pack limit`),
      productUrl:url(row.get('Product URL')||row.get('Product / price source'),`${where} product URL`),photoUrl:url(row.get('Photo URL'),`${where} photo URL`,{optional:true}),
      fitWarnings:warnings,
      evidence:{checkedOn:evidenceDate,sourceUrl:url(row.get('Product / price source')||row.get('Product URL'),`${where} price source`),note:oneLine(row.get('Retail evidence / date')).slice(0,300)||'Public retail price'},
      status:'draft'});
  }
  return {products};
}

/** Service and junk rows of Item_menu.csv that the builder quotes (ITEM_BASIS). */
export function importServices(text){
  const services=[],skipped=[];
  for(const row of table(parseCsv(text),ITEM_COLUMNS,SHEETS.items)){
    const menuId=row.get('Item ID'),where=`${SHEETS.items} line ${row.line}`;
    if(!/^EGC-\d{3}$/.test(menuId))continue;
    const basis=ITEM_BASIS[menuId];
    if(!basis){skipped.push(menuId);continue;}
    const [group,category,price,garageSize]=basis,unit=UNITS[row.get('Unit').toLowerCase()];
    if(!unit)throw new Error(`${where}: unit "${row.get('Unit')}" is not job, load, item or bundle`);
    const approved=/^approved$/i.test(row.get('Owner approval'));
    if(!approved&&!/^pending$/i.test(row.get('Owner approval')))throw new Error(`${where}: owner approval "${row.get('Owner approval')}" is neither Approved nor Pending`);
    const note=scrubNote(row.get('Inclusions / exclusions'));
    services.push({id:menuId.toLowerCase(),menuId,section:'removal',category,group,name:oneLine(row.get('Item')).slice(0,160),unit,basis:price,...(garageSize?{garageSize}:{}),
      status:approved?'approved':'draft',...(approved?{approvedPriceCents:cents(row.get('Direct estimator price'),`${where} approved price`),approval:`Owner-approved amount (pricing workbook ${menuId}, ${row.get('Group')}).`}:{}),
      ...(note?{scopeNote:note}:{})});
  }
  return {services,skipped};
}

export function buildPricingMenu({productsCsv,itemsCsv},{evidenceDate=EVIDENCE_DATE,menuVersion=`${evidenceDate}.1`,approvals}={}){
  const {products}=importProducts(productsCsv,{evidenceDate}),{services,skipped}=importServices(itemsCsv);
  const menu={schemaVersion:1,menuVersion,generatedOn:menuVersion.slice(0,10),currency:'USD',status:'draft',
    source:`Owner pricing workbook export (${SHEETS.products}, ${SHEETS.items}) imported by scripts/import-pricing-menu.mjs. Public product data and item identity only.`,
    priceBasis:`retailPerPackCents is The Home Depot public retail price per purchase pack checked ${evidenceDate} (no local store, or the site's default store): the goods cost basis, like garage-catalog.json retailPriceHighCents. It is not an EGC invoice, landed cost or Fort Collins price; tax, shipping, landed extras and installation are excluded. Goods sell at cost x the goodsMarkup pricing setting. Every product and every service without an owner-approved amount is a DRAFT.`,
    products,services};
  // The owner's approvals in code, carried over for the items still on the menu (an item the menu now approves at a
  // fixed amount keeps that amount instead).
  const ids=new Set([...products.map(item=>item.id),...services.filter(item=>item.status!=='approved').map(item=>item.id)]);
  if(approvals)menu.approvals={...approvals,items:Object.fromEntries(Object.entries(approvals.items||{}).filter(([id])=>ids.has(id)))};
  validatePricingMenu(menu);
  return {menu,report:{products:products.length,services:services.length,approved:services.filter(service=>service.status==='approved').map(service=>service.menuId),itemsNotImported:skipped}};
}

export const renderMenuJson=menu=>`${JSON.stringify(menu,null,1)}\n`;
export function renderMenuModule(jsonText){
  return ['// Generated from functions/_data/pricing-menu.json by scripts/import-pricing-menu.mjs. Do not edit: re-import the',
    '// owner workbook export (node scripts/import-pricing-menu.mjs --from <folder> --write); tests fail while this is stale.',
    `export const PRICING_MENU_JSON = ${JSON.stringify(JSON.stringify(JSON.parse(jsonText)))};`,''].join('\n');
}
export function checkCommitted(root=REPO_ROOT){
  const jsonPath=join(root,MENU_JSON),modulePath=join(root,MENU_MODULE);
  if(!existsSync(jsonPath)||!existsSync(modulePath))return {ok:false,problem:`${MENU_JSON} or ${MENU_MODULE} is missing`};
  const json=readFileSync(jsonPath,'utf8');
  try{validatePricingMenu(JSON.parse(json));}catch(error){return {ok:false,problem:error.message};}
  if(readFileSync(modulePath,'utf8')!==renderMenuModule(json))return {ok:false,problem:`${MENU_MODULE} is stale; run node scripts/import-pricing-menu.mjs --check after re-importing`};
  return {ok:true};
}

function option(args,name){const at=args.indexOf(name);return at>=0?args[at+1]:undefined;}
function main(){
  const args=process.argv.slice(2);
  if(args.includes('--check')){const result=checkCommitted();console.log(result.ok?`${MENU_JSON} validates and ${MENU_MODULE} matches it`:`✗ ${result.problem}`);if(!result.ok)process.exitCode=1;return;}
  const from=option(args,'--from');
  if(!from){console.error('Usage: node scripts/import-pricing-menu.mjs --from <csv folder> [--write] [--menu-version YYYY-MM-DD.N] [--evidence-date YYYY-MM-DD] | --check');process.exitCode=2;return;}
  const evidenceDate=option(args,'--evidence-date')||EVIDENCE_DATE,menuVersion=option(args,'--menu-version')||`${evidenceDate}.1`;
  const jsonPath=join(REPO_ROOT,MENU_JSON),modulePath=join(REPO_ROOT,MENU_MODULE),approvals=existsSync(jsonPath)?JSON.parse(readFileSync(jsonPath,'utf8')).approvals:undefined;
  const {menu,report}=buildPricingMenu({productsCsv:readFileSync(join(from,SHEETS.products),'utf8'),itemsCsv:readFileSync(join(from,SHEETS.items),'utf8')},{evidenceDate,menuVersion,approvals});
  const json=renderMenuJson(menu),module=renderMenuModule(json);
  const current=existsSync(jsonPath)&&readFileSync(jsonPath,'utf8')===json&&existsSync(modulePath)&&readFileSync(modulePath,'utf8')===module;
  console.log(`${report.products} draft products, ${report.services} service items (approved: ${report.approved.join(', ')||'none'}); not imported: ${report.itemsNotImported.join(', ')||'none'}`);
  if(args.includes('--write')){if(!current){writeFileSync(jsonPath,json);writeFileSync(modulePath,module);}console.log(current?`${MENU_JSON} is already current`:`wrote ${MENU_JSON} and ${MENU_MODULE}`);return;}
  console.log(current?`${MENU_JSON} matches the export`:`✗ ${MENU_JSON} differs from the export; run with --write`);
  if(!current)process.exitCode=1;
}
const entry=()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}};
if(entry())main();
