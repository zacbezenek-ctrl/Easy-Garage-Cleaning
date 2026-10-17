import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../lp.js',import.meta.url),'utf8');
function page({confirmation=false,storage=new Map(),ok=true,success=true}={}) {
 const events=[],relays=[],requests=[],status={},button={textContent:'Request',disabled:false};let submit;
 const form={action:'https://api.web3forms.com/submit',reportValidity:()=>true,querySelector:()=>button,appendChild:()=>{},getAttribute:n=>n==='data-meta-lead'?'lp_garage_turnaround':null,addEventListener:(type,fn)=>{submit=fn;}};
 const location={origin:'https://example.test',pathname:confirmation?'/lp-thank-you':'/free-garage-walkthrough',assign:url=>events.push(['redirect',url])};
 const context={location,URL,Date,JSON,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{querySelectorAll:()=>confirmation?[]:[form],createElement:()=>Object.assign(status,{setAttribute(){}})},FormData:class{get(){return 'https://example.test/lp-thank-you?lp=garage-turnaround'}delete(){}},fetch:async()=>{requests.push('fallback');return{ok,json:async()=>({success})}},window:{gtag:(...a)=>events.push(['google',...a]),fbq:(...a)=>events.push(['meta',...a]),EGCLeadCapture:{relay:()=>{relays.push('crm');return 'inquiry-123';}}}};
 vm.runInNewContext(script,context);
 return {events,relays,requests,status,button,storage,submit:()=>submit({preventDefault(){}})};
}
test('accepted request captures once and counts on confirmation, not submit or reload',async()=>{
 const p=page();await Promise.all([p.submit(),p.submit()]);assert.equal(p.requests.length,1);assert.equal(p.relays.length,1);assert.equal(p.events.filter(e=>e[0]==='google').length,0);
 const c=page({confirmation:true,storage:p.storage});assert.equal(c.events.filter(e=>e[0]==='google').length,1);assert.equal(c.events.find(e=>e[0]==='meta')[4].eventID,'inquiry-123');
 assert.equal(page({confirmation:true,storage:p.storage}).events.length,0);
});
test('provider rejection leaves a recoverable form and no false conversion or CRM relay',async()=>{
 const p=page({ok:false});await p.submit();assert.equal(p.relays.length,0);assert.equal(p.storage.size,0);assert.equal(p.events.length,0);assert.equal(p.button.disabled,false);assert.match(p.status.textContent,/could not be confirmed/);await p.submit();assert.equal(p.requests.length,2);
});
test('HTTP success with unsuccessful body and direct confirmation visits do not count',async()=>{
 const p=page({success:false});await p.submit();assert.equal(p.relays.length,0);assert.equal(p.events.length,0);assert.equal(page({confirmation:true}).events.length,0);
});
test('paid pages retain consent choice, request semantics, attribution fields, and local assets',()=>{
 for(const name of ['free-garage-walkthrough.html','garage-cleanout-walkthrough.html']){
  const html=readFileSync(new URL('../'+name,import.meta.url),'utf8');assert.match(html,/noindex/);assert.match(html,/name="serviceZip" required/);assert.match(html,/name="email"/);assert.doesNotMatch(html,/name="sms_consent"[^>]*required/);assert.doesNotMatch(html,/leadconnectorhq.com\/widget/);assert.match(html,/utm_source/);
  for(const match of html.matchAll(/(?:src|href)="(\/[^"?#]+)(?:[^" ]*)"/g)){const path=match[1];if(path.endsWith('.js')||path.endsWith('.css')||path.endsWith('.png')||path.endsWith('.jpg'))assert.doesNotThrow(()=>readFileSync(new URL('..'+path,import.meta.url)),path);}
 }
});
