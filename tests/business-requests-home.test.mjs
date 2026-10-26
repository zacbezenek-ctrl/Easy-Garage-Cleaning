import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument } from './helpers/hub-dom.mjs';
const source=readFileSync(new URL('../employee-business-requests.js',import.meta.url),'utf8');
function setup(requestJSON){
 const document=createDocument(),calls=[];
 const h=(tag,attrs,...children)=>{const node=document.createElement(tag);for(const[key,value]of Object.entries(attrs||{}))node.setAttribute(key,String(value));for(const child of children.flat(Infinity))if(child!=null)node.append(typeof child==='string'?document.createTextNode(child):child);return node;};
 const context={document,AbortController,EGCHubKit:{h,requestJSON,button:(label,fn)=>{const node=h('button',{},label);node.addEventListener('click',fn);return node;}},addEventListener(){}};context.window=context;
 vm.runInNewContext(source,context);const host=document.createElement('div');document.body.append(host);return{host,widget:context.EGCBusinessRequestsHome,ctx:{go:screen=>calls.push(screen)},calls};
}
test('business overview labels partial pagination and opens its authenticated queue',async()=>{
 for(const next of ['', 'more']){const f=setup(async()=>({ok:true,requests:[{}],next,limited:false}));await f.widget.mount(f.host,f.ctx);assert.match(f.host.textContent,next?/1\+ awaiting/:/1 awaiting/);f.host.querySelector('button').click();assert.deepEqual(f.calls,['business_requests']);f.widget.unmount();}
});
test('business overview never turns a storage failure into a zero count',async()=>{
 let error={status:503};const f=setup(async()=>{throw error;});await f.widget.mount(f.host,f.ctx);assert.match(f.host.textContent,/count unavailable/);error={status:403};await f.widget.refresh();assert.equal(f.host.hidden,true);assert.equal(f.host.textContent,'');f.widget.unmount();
});
