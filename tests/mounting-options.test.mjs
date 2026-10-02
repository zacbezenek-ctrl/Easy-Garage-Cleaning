import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createDocument} from './helpers/hub-dom.mjs';
import {projectCatalogOverview} from '../functions/_lib/catalog-store.js';
import {priceCatalogQuote} from '../functions/_lib/catalog-quote.js';
const source=readFileSync(new URL('../crew/mounting-options.js',import.meta.url),'utf8');
const catalog=JSON.parse(readFileSync(new URL('../functions/_data/garage-catalog.json',import.meta.url)));
const defaults=JSON.parse(readFileSync(new URL('../functions/_data/pricing-settings.defaults.json',import.meta.url)));
const state={catalog,publication:{version:catalog.catalogVersion},settings:{...defaults,mustSetBeforeCustomerUse:false},settingsState:{}};
const now=new Date('2026-09-30T18:00:00Z');
const overview={ok:true,enabled:true,...projectCatalogOverview(state,{internal:true,now})};
function harness(fetcher=async()=>Response.json(overview)){
 const document=createDocument(),context={document,Node:document.Node,Intl,AbortController,crypto,TextEncoder,setTimeout,clearTimeout,console,addEventListener(){},removeEventListener(){}};context.window=context;vm.runInNewContext(source,context);const host=document.createElement('section');document.body.append(host);return{document,context,host,api:context.EGCMountingOptions,fetcher};
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
test('mounting comparisons match existing server quotes across all eligible mounting products and quantities',()=>{
 const {api}=harness();let count=0;
 for(const item of catalog.items.filter(i=>api.groupIds(i).length&&i.availability==='active'&&i.kind==='product'&&i.priceVerified))for(const quantity of [1,2,7]){
  if(overview.prices[item.id].stale)continue;
  const result=api.comparePrice(overview,item,quantity),priced=priceCatalogQuote(state,{catalogVersion:catalog.catalogVersion,settingsVersion:state.settings.settingsVersion,items:[{id:'catalog-1',itemId:item.id,quantity,customerSupplied:false}]},now);
  assert.equal(result.total,priced.totalCents,item.id);assert.equal(result.materials+result.installation+result.other+result.minimum,result.total);count++;
 }
 assert.ok(count>100);
});
test('unapproved, stale, incomplete and invalid prices never become free or a numeric estimate',()=>{
 const {api}=harness(),item=catalog.items.find(i=>api.groupIds(i).length&&i.kind==='product'&&i.availability==='active'&&i.priceVerified);
 for(const edit of [o=>o.settings.readyForCustomers=false,o=>o.prices[item.id].stale=true,o=>delete o.prices[item.id].split,o=>o.prices[item.id].split.laborCents=null,o=>o.prices[item.id].unitCents++,o=>delete o.settings.values.minimumJobCents]){const data=structuredClone(overview);edit(data);assert.equal(api.comparePrice(data,item,1),null);}
 for(const q of [0,-1,1.5,10001,NaN])assert.equal(api.comparePrice(overview,item,q),null);
});
test('real UI compares alternatives, validates site fit, preserves customer context and only opens reviewed quote flow',{timeout:5000},async()=>{
 let resolveOpen;const nextOpen=()=>new Promise(resolve=>{resolveOpen=resolve;});
 const h=harness(),calls=[],changes=[],opens=[];h.context.EGCCatalogQuote={open:async options=>{opens.push(options);resolveOpen(options);}};
 const view=h.api.mount(h.host,{fetch:async(url,init)=>{calls.push({url,init});return Response.json(overview);},identity:'synthetic-owner',selections:[],onChange:s=>changes.push(s),quoteContext:()=>({draftScope:'walkthrough-synthetic',client:{name:'Synthetic customer',highlevel_contact_id:'synthetic-contact'}})});await flush();
 const compare=h.host.querySelectorAll('button').find(b=>b.textContent==='Compare');assert.ok(compare);compare.click();
 assert.equal(h.host.querySelectorAll('article').length,1);assert.deepEqual(h.host.querySelectorAll('dt').map(x=>x.textContent),['Materials','Installation','Packaging / disposal','Minimum charge adjustment','Option total']);
 let quote=h.host.querySelectorAll('button').find(b=>b.textContent==='Review installation quote');assert.ok(quote.hasAttribute('disabled'));quote.click();await flush();assert.equal(opens.length,0);
 const firstOpened=nextOpen();const fit=h.host.querySelector('input[type="checkbox"]');fit.checked=true;fit.dispatchEvent({type:'change'});h.host.querySelectorAll('button').find(b=>b.textContent==='Review installation quote').click();await firstOpened;await flush();assert.equal(opens.length,1);assert.equal(opens[0].initialClient.highlevel_contact_id,'synthetic-contact');assert.match(opens[0].draftScope,/^walkthrough-synthetic-/);assert.equal(opens[0].initialItems.length,1);assert.equal(opens[0].fixedSelection,true);assert.equal(changes.at(-1).length,1);assert.ok(calls.every(c=>c.url==='/api/catalog'&&!c.init.method));
 const quantity=h.host.querySelector('input[type="number"]');quantity.value='2';quantity.dispatchEvent({type:'change'});assert.ok(h.host.querySelectorAll('button').find(b=>b.textContent==='Review installation quote').hasAttribute('disabled'));assert.equal(changes.at(-1)[0].quantity,2);
 const secondOpened=nextOpen();const again=h.host.querySelector('input[type="checkbox"]');again.checked=true;again.dispatchEvent({type:'change'});h.host.querySelectorAll('button').find(b=>b.textContent==='Review installation quote').click();await secondOpened;await flush();assert.equal(opens[1].initialItems[0].quantity,2);assert.notEqual(opens[1].draftScope,opens[0].draftScope);
 h.host.querySelectorAll('button').find(b=>b.textContent==='Remove option').click();assert.equal(h.host.querySelectorAll('article').length,0);view.dispose();
});
test('role failure is explicit, retry works, disposed responses cannot replace newer navigation',async()=>{
 const h=harness();let attempts=0;
 const view=h.api.mount(h.host,{fetch:async()=>++attempts===1?Response.json({ok:false},{status:403}):Response.json(overview)});await flush();assert.match(h.host.textContent,/owner or manager/);h.host.querySelectorAll('button').find(b=>b.textContent==='Retry catalog').click();await flush();assert.match(h.host.textContent,/Compare/);view.dispose();
 let complete;const pending=h.api.mount(h.host,{fetch:()=>new Promise(resolve=>complete=resolve)});pending.dispose();h.host.textContent='New screen';complete(Response.json(overview));await flush();assert.equal(h.host.textContent,'New screen');
});
test('unreleased settings show options without amounts and never permit a quote',async()=>{
 const h=harness(),data=structuredClone(overview);data.settings.readyForCustomers=false;h.api.mount(h.host,{fetch:async()=>Response.json(data)});await flush();h.host.querySelectorAll('button').find(b=>b.textContent==='Compare').click();assert.match(h.host.textContent,/Needs pricing/);assert.doesNotMatch(h.host.textContent,/\$\d/);assert.ok(h.host.querySelectorAll('button').find(b=>b.textContent==='Review installation quote').hasAttribute('disabled'));
});
test('catalog composer seeds customer and option in an isolated walkthrough draft, preserving an existing saved selection',async()=>{
 const h=harness(),stored=new Map(),item=catalog.items.find(i=>h.api.groupIds(i).length&&i.kind==='product'&&i.availability==='active'&&i.priceVerified);
 const proto=Object.getPrototypeOf(h.document.createElement('dialog'));proto.showModal=function(){this.open=true;};proto.close=function(){this.open=false;};
 Object.assign(h.context,{crypto,setTimeout,clearTimeout,sessionStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k),get length(){return stored.size;},key:i=>[...stored.keys()][i]}});
 h.context.EGCQuoteDraft={createClient:()=>({pendingSave:async()=>null})};vm.runInNewContext(readFileSync(new URL('../employee-catalog-quote.js',import.meta.url),'utf8'),h.context);
 const options={overview,identity:'synthetic-owner',draftScope:'walkthrough-a',initialClient:{name:'Customer A',address:'Test address'},initialItems:[{id:'catalog-1',itemId:item.id,quantity:2,customerSupplied:false}]};
 let dialog=await h.context.EGCCatalogQuote.open(options);assert.equal(dialog.querySelector('input[name="name"]').value,'Customer A');assert.equal(dialog.querySelector('input[type="number"]').value,2);dialog.querySelector('button.cq-close').click();
 dialog=await h.context.EGCCatalogQuote.open({...options,draftScope:'walkthrough-b',initialClient:{name:'Customer B'}});assert.equal(dialog.querySelector('input[name="name"]').value,'Customer B');dialog.querySelector('button.cq-close').click();
 dialog=await h.context.EGCCatalogQuote.open({...options,initialClient:{name:'Do not overwrite draft'}});assert.equal(dialog.querySelector('input[name="name"]').value,'Customer A');assert.ok([...stored.keys()].some(k=>k.includes('walkthrough-a')));assert.ok([...stored.keys()].some(k=>k.includes('walkthrough-b')));dialog.querySelector('button.cq-close').click();
});
test('a site-reviewed mounting quote cannot silently replace reviewed product, quantity or customer',async()=>{
 const h=harness(),stored=new Map(),item=catalog.items.find(i=>h.api.groupIds(i).length&&i.kind==='product'&&i.availability==='active'&&i.priceVerified);
 const proto=Object.getPrototypeOf(h.document.createElement('dialog'));proto.showModal=function(){};proto.close=function(){};
 Object.assign(h.context,{sessionStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},EGCQuoteDraft:{createClient:()=>({pendingSave:async()=>null})}});
 vm.runInNewContext(readFileSync(new URL('../employee-catalog-quote.js',import.meta.url),'utf8'),h.context);
 let restored=false;const dialog=await h.context.EGCCatalogQuote.open({overview,identity:'owner',draftScope:'fixed-mount-test',fixedSelection:true,restoreFocus:()=>{restored=true;},initialClient:{name:'Reviewed customer'},initialItems:[{id:'catalog-1',itemId:item.id,quantity:2,customerSupplied:false}]});
 assert.equal(dialog.querySelectorAll('input[type="number"]').length,0);assert.equal(dialog.querySelectorAll('input[type="checkbox"]').length,0);assert.equal(dialog.querySelectorAll('button').filter(b=>['Add','Remove'].includes(b.textContent)).length,0);assert.ok(dialog.querySelector('input[name="name"]').hasAttribute('disabled'));assert.match(dialog.textContent,/Return to the walkthrough/);dialog.querySelector('.cq-close').click();assert.equal(restored,true);
});
