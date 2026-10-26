import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument } from './helpers/hub-dom.mjs';
const source=readFileSync(new URL('../employee-customer-requests.js',import.meta.url),'utf8');
function setup(fetcher){
 const document=createDocument(),context={document,AbortController,setTimeout,clearTimeout,fetch:fetcher,addEventListener(){}};context.window=context;
 vm.runInNewContext(source,context);const host=document.createElement('div');document.body.append(host);
 const calls=[];return {host,widget:context.EGCCustomerRequestsHome,ctx:{hubFetch:fetcher,go:screen=>calls.push(screen)},calls};
}
test('home distinguishes complete and partial counts and opens the registered review screen',async()=>{
 for(const complete of [true,false]){const f=setup(async()=>Response.json({ok:true,requests:[{},{}],complete}));await f.widget.mount(f.host,f.ctx);assert.match(f.host.textContent,complete?/2 awaiting/:/2\+ awaiting/);f.host.querySelector('button').click();assert.deepEqual(f.calls,['customer_visit_requests']);f.widget.unmount();}
});
test('home reports unavailable rather than zero and hides an unauthorized result',async()=>{
 let response=Response.json({ok:false},{status:503});const f=setup(async()=>response);await f.widget.mount(f.host,f.ctx);assert.match(f.host.textContent,/count unavailable/);response=Response.json({ok:false},{status:403});await f.widget.refresh();assert.equal(f.host.textContent,'');assert.equal(f.host.hidden,true);f.widget.unmount();
});
test('home drops a late response after unmount',async()=>{
 let finish;const f=setup(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.widget.mount(f.host,f.ctx);f.widget.unmount();finish(Response.json({ok:true,requests:[{}],complete:true}));await pending;assert.equal(f.host.textContent,'');
});
