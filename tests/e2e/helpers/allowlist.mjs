// Ratchet allowlist for tap-target and keyboard debt. A new violation fails; a
// fixed one also fails until it is removed here, so the list only ever shrinks.
// Refresh after an intentional change: EGC_E2E_UPDATE_ALLOWLIST=1 npx playwright test -c tests/e2e/playwright.config.mjs
import {mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const FILE=fileURLToPath(new URL('../mobile-allowlist.json',import.meta.url));
const PENDING=fileURLToPath(new URL('../../../test-results/e2e-allowlist/',import.meta.url));
export const updating=()=>process.env.EGC_E2E_UPDATE_ALLOWLIST==='1';
let cached;
export function allowlist(){return cached||=JSON.parse(readFileSync(FILE,'utf8'));}

// Multiset difference so repeated identical controls are counted, not collapsed.
export function difference(left,right){
 const remaining=new Map();for(const item of right)remaining.set(item,(remaining.get(item)||0)+1);
 return left.filter(item=>{const count=remaining.get(item)||0;if(count)remaining.set(item,count-1);return !count;});
}

export function ratchet(kind,key,observed,{list,update=updating(),pending=PENDING}={}){
 const sorted=[...observed].sort();
 if(update){mkdirSync(pending,{recursive:true});writeFileSync(join(pending,`${kind}__${key.replace(/[^A-Za-z0-9._-]+/g,'_')}.json`),JSON.stringify({kind,key,observed:sorted}));return {unexpected:[],fixed:[]};}
 const allowed=(list||allowlist())[kind]?.[key]||[];
 return {unexpected:difference(sorted,allowed),fixed:difference(allowed,sorted)};
}

// Replace only the keys observed in this run; keys that came back clean are deleted.
export function mergePending(file=FILE,pending=PENDING){
 let files=[];try{files=readdirSync(pending).filter(name=>name.endsWith('.json')).sort();}catch{return 0;}
 const current=JSON.parse(readFileSync(file,'utf8'));
 for(const name of files){
  const {kind,key,observed}=JSON.parse(readFileSync(join(pending,name),'utf8'));
  current[kind]||={};
  if(observed.length)current[kind][key]=observed;else delete current[kind][key];
 }
 for(const kind of Object.keys(current))if(current[kind]&&typeof current[kind]==='object'&&!Array.isArray(current[kind]))current[kind]=Object.fromEntries(Object.entries(current[kind]).sort(([a],[b])=>a.localeCompare(b)));
 writeFileSync(file,JSON.stringify(current,null,1)+'\n');
 rmSync(pending,{recursive:true,force:true});
 return files.length;
}

export default function mergeAllowlist(){if(updating())mergePending();}
