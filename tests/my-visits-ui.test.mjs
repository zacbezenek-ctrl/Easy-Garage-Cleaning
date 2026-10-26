import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument } from './helpers/hub-dom.mjs';
const source=readFileSync(new URL('../my-visits.js',import.meta.url),'utf8'),html=readFileSync(new URL('../my-visits.html',import.meta.url),'utf8');
const dto={ok:true,customer:{firstName:'Synthetic'},jobs:[{jobId:'job-a',service:'<img src=x>',status:'scheduled',date:'2026-10-30',endDate:'2026-10-30',time:'09:30',endTime:'12:30',address:'100 Synthetic Street'}],requests:[],coverage:{complete:true},requestsComplete:true,today:'2026-10-24'};
async function page(respond,storage=new Map(),cryptoApi=crypto){
 const document=createDocument();document.readyState='complete';document.body.innerHTML=html;const create=document.createElement.bind(document);document.createElement=tag=>{const e=create(tag);if(tag==='form')e.reset=()=>e.querySelectorAll('input,textarea').forEach(i=>{i.value='';});return e;};
 const listeners={},calls=[],navigated=[];const context=vm.createContext({document,crypto:cryptoApi,TextEncoder,URLSearchParams,AbortController,setTimeout,clearTimeout,sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key),key:i=>[...storage.keys()][i],get length(){return storage.size;}},FormData:class{constructor(form){this.values=form.querySelectorAll('input,select').map(e=>[e.name,e.value]);}[Symbol.iterator](){return this.values[Symbol.iterator]();}},fetch:async(url,init)=>{calls.push({url,init});return respond?respond(url,init,calls):Response.json(dto);},location:{assign:url=>navigated.push(url)},addEventListener:(name,fn)=>(listeners[name]||=[]).push(fn)});context.window=context;vm.runInContext(source,context);const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};const until=async predicate=>{const deadline=performance.now()+3000;while(!predicate()){if(performance.now()>deadline)throw new Error('UI operation did not settle');await new Promise(resolve=>setImmediate(resolve));}};await settle();return {document,context,calls,navigated,listeners,storage,settle,until,root:document.getElementById('visits-content')};
}
test('My visits treats content as text and opens only through verified server action',async()=>{const p=await page((url,init)=>Response.json(init.method==='POST'?{ok:true,url:'https://untrusted.invalid'}:dto));assert.equal(p.root.querySelectorAll('img').length,0);p.root.querySelector('button').click();await p.settle();assert.deepEqual(p.navigated,['/customer-portal']);assert.equal(JSON.parse(p.calls.at(-1).init.body).action,'open_project');});
test('an uncertain change request retries the exact operation after double tap and reload without storing its text',async()=>{
 const delayedCrypto={randomUUID:()=>crypto.randomUUID(),subtle:{digest:async(...args)=>{await new Promise(resolve=>setTimeout(resolve,25));return crypto.subtle.digest(...args);}}};
 const storage=new Map();let posts=0;const responder=(url,init)=>{if(init.method==='POST'){posts++;throw new TypeError('Synthetic lost response');}return Response.json(dto);};
 async function submit(p){const f=p.root.querySelector('.visit-request form');f.querySelector('[name="preferredDate"]').value='2026-11-03';f.querySelector('[name="note"]').value='Private synthetic request text';f.dispatchEvent({type:'submit',preventDefault(){}});f.dispatchEvent({type:'submit',preventDefault(){}});await p.until(()=>!f.querySelector('button[type="submit"]').disabled);}
 const a=await page(responder,storage,delayedCrypto);await submit(a);assert.equal(posts,1);const first=a.calls.find(c=>c.init.method==='POST').init.body;assert.ok(storage.size);assert.doesNotMatch(JSON.stringify([...storage.values()]),/Private|synthetic request text/);
 const b=await page(responder,storage);await submit(b);assert.equal(posts,2);assert.equal(b.calls.find(c=>c.init.method==='POST').init.body,first);
});
test('signout clears private display immediately, suppresses refresh, and ignores an older load result',async()=>{
 let reads=0,finishRead,finishOut;const p=await page((url,init)=>{if(init.method==='POST')return new Promise(resolve=>{finishOut=resolve;});if(++reads===1)return Response.json(dto);return new Promise(resolve=>{finishRead=resolve;});});
 const loading=p.context.EGCMyVisits.reload();await p.settle();p.document.getElementById('visits-signout').click();await p.settle();assert.equal(p.root.textContent,'');await p.context.EGCMyVisits.reload();assert.equal(reads,2,'no refresh while signout is pending');finishRead(Response.json(dto));await loading;assert.equal(p.root.textContent,'');finishOut(Response.json({ok:true}));await p.settle();assert.deepEqual(p.navigated,['/client-login']);
});

test('failed signout keeps private data cleared and blocks reload until revocation retry succeeds',async()=>{
 let fail=true;const p=await page((url,init)=>{if(init.method==='POST'){if(fail)throw new Error('Synthetic revocation outage');return Response.json({ok:true});}return Response.json(dto);});
 p.document.getElementById('visits-signout').click();await p.settle();const calls=p.calls.length;
 assert.match(p.document.getElementById('visits-status').textContent,/could not be confirmed/);
 await p.context.EGCMyVisits.reload();assert.equal(p.calls.length,calls);assert.equal(p.root.textContent,'');
 fail=false;p.document.getElementById('visits-signout').click();await p.settle();assert.deepEqual(p.navigated,['/client-login']);
});
