import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {allowlist,difference,mergePending,ratchet} from './e2e/helpers/allowlist.mjs';
import {e2eWorkers} from './e2e/helpers/workers.mjs';

const TOUCH_PROJECTS=['iphone-375','android-pixel7'];

test('multiset difference counts repeated identical controls instead of collapsing them',()=>{
 assert.deepEqual(difference(['a','a','b','c'],['a','c']),['a','b']);
 assert.deepEqual(difference(['a'],['a','a']),[]);
 assert.deepEqual(difference([],['a']),[]);
});

test('ratchet fails new debt and fixed debt, and never lets the allowlist grow silently',()=>{
 const list={tapTargets:{'iphone-375 /x.html':['a "Call"','button "Close"','button "Close"']}};
 assert.deepEqual(ratchet('tapTargets','iphone-375 /x.html',['a "Call"','button "Close"','button "Close"'],{list,update:false}),{unexpected:[],fixed:[]});
 assert.deepEqual(ratchet('tapTargets','iphone-375 /x.html',['button "Close"','button "Close"','button "Close"','a "Call"'],{list,update:false}),{unexpected:['button "Close"'],fixed:[]});
 assert.deepEqual(ratchet('tapTargets','iphone-375 /x.html',['button "Close"'],{list,update:false}),{unexpected:[],fixed:['a "Call"','button "Close"']});
 assert.deepEqual(ratchet('tapTargets','iphone-375 /new.html',['button "Tiny"'],{list,update:false}),{unexpected:['button "Tiny"'],fixed:[]});
 assert.deepEqual(ratchet('keyboards','/x.html',[],{list,update:false}),{unexpected:[],fixed:[]});
});

test('update mode records observations and the merge replaces only observed keys',t=>{
 const root=mkdtempSync(join(tmpdir(),'egc-allowlist-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const file=join(root,'allowlist.json'),pending=join(root,'pending');
 writeFileSync(file,JSON.stringify({_comment:'kept',tapTargets:{'iphone-375 /kept.html':['a "Kept"'],'iphone-375 /fixed.html':['a "Old"']},keyboards:{}}));
 assert.deepEqual(ratchet('tapTargets','iphone-375 /fixed.html',[],{update:true,pending}),{unexpected:[],fixed:[]});
 ratchet('tapTargets','android-pixel7 /new page.html',['button "B"','button "A"'],{update:true,pending});
 ratchet('keyboards','hub:crew sign in',['input#p needs tel'],{update:true,pending});
 assert.equal(mergePending(file,pending),3);assert.equal(existsSync(pending),false);
 assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{_comment:'kept',tapTargets:{'android-pixel7 /new page.html':['button "A"','button "B"'],'iphone-375 /kept.html':['a "Kept"']},keyboards:{'hub:crew sign in':['input#p needs tel']}});
 assert.equal(mergePending(file,pending),0);
});

test('checked-in allowlist is sorted debt for touch projects only, with no empty entries',()=>{
 const list=allowlist();
 assert.deepEqual(Object.keys(list).sort(),['_comment','keyboards','tapTargets']);
 for(const [kind,entries] of Object.entries({tapTargets:list.tapTargets,keyboards:list.keyboards})){
  assert.deepEqual(Object.keys(entries),[...Object.keys(entries)].sort((a,b)=>a.localeCompare(b)),kind);
  for(const [key,items] of Object.entries(entries)){
   assert.ok(items.length,`${kind} ${key} is empty; delete it`);assert.deepEqual(items,[...items].sort(),`${kind} ${key} must be sorted`);
   if(kind==='tapTargets')assert.ok(TOUCH_PROJECTS.includes(key.split(' ')[0]),`${key} is not a touch project`);
   else assert.match(key,/^(\/[\w-]+\.html|hub:.+)$/);
  }
 }
});

test('EGC_E2E_WORKERS becomes a number for integers, stays a percentage otherwise and rejects anything else',()=>{
 assert.equal(e2eWorkers(undefined),'50%');assert.equal(e2eWorkers(''),'50%');assert.equal(e2eWorkers('  '),'50%');
 assert.equal(e2eWorkers('2'),2);assert.equal(e2eWorkers(' 12 '),12);assert.equal(e2eWorkers(3),3);
 assert.equal(e2eWorkers('25%'),'25%');assert.equal(e2eWorkers('100%'),'100%');
 for(const value of['0','-1','1.5','two','0%','150%','2 workers'])assert.throws(()=>e2eWorkers(value),/EGC_E2E_WORKERS must be a positive integer or a percentage/,value);
});
