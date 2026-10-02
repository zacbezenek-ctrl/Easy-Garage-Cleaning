import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const window={addEventListener(){}};
vm.runInNewContext(readFileSync(new URL('../employee-operations.js',import.meta.url),'utf8'),{window,URL,Intl,console});
const {model,sourceUrl}=window.EGCActionCenter.bookingReview;
const wrap=value=>({meta:{cursors:[{key:'customer_state:booking_reconciliation',cursor:JSON.stringify(value),updatedAt:'2026-10-02T15:00:00Z'}]}});
test('missing, malformed and incomplete booking snapshots never look all clear',()=>{
 for(const input of [{},wrap(null),wrap({}),wrap({findings:[null]}),wrap({findings:[{code:'test'}]}),{meta:{cursors:[{key:'customer_state:booking_reconciliation',cursor:'broken'}]}}]){const r=model(input);assert.equal(r.available,false);assert.ok(r.error);}
});
test('nested persisted findings retain unresolved commitments, source references and unknown times',()=>{
 const commitment={contactId:'synthetic-contact',kind:null,startAt:null,timeMention:'next Friday',humanReviewNeeded:true,reviewReasons:['schedule_time_unresolved'],sourceReferences:[{sourceType:'call_transcript',sourceRecordId:'synthetic-call',excerpt:'Friday works'}]};
 const r=model(wrap({coverage:{portalComplete:true,providerComplete:false},findings:[{code:'booking_reconciled',status:'fully_reconciled'},{code:'booking_commitment_requires_review',status:'reconciliation_needed',commitment}]}));
 assert.equal(r.available,true);assert.equal(r.coverageComplete,false);assert.equal(r.findings.length,1);assert.equal(r.findings[0].commitment.startAt,null);assert.equal(r.findings[0].commitment.timeMention,'next Friday');assert.equal(r.findings[0].commitment.sourceReferences[0].sourceRecordId,'synthetic-call');
});
test('only canonical credential-free HTTPS source pointers become links',()=>{
 assert.equal(sourceUrl('https://app.gohighlevel.com/v2/location/example/contacts/detail/example'),'https://app.gohighlevel.com/v2/location/example/contacts/detail/example');
 for(const value of [null,undefined,'javascript:alert(1)','http://example.com/','https://user:password@example.com/','https://example.com/\n','https://example.com/\u200b'])assert.equal(sourceUrl(value),null,String(value));
});
import {createDocument} from './helpers/hub-dom.mjs';
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
test('real module renders review cards and evidence navigation without a scheduling write',async()=>{
 const document=createDocument(),proto=Object.getPrototypeOf(document.createElement('div'));proto.showModal=function(){this.open=true;};proto.close=function(){this.open=false;};
 const host=document.createElement('main');document.body.append(host);const calls=[];
 const finding={code:'booking_commitment_requires_review',status:'reconciliation_needed',nextAction:'Confirm the agreed date.',commitment:{contactId:'synthetic-contact',kind:null,startAt:null,timeMention:'next Friday',evidence:'Friday works <img src=x>',reviewReasons:['schedule_time_unresolved'],sourceReferences:[{sourceType:'call_transcript',sourceRecordId:'synthetic-call',excerpt:'Friday works',sourcePointer:'javascript:alert(1)'}]}};
 const diagnostics=wrap({coverage:{portalComplete:true,providerComplete:false},findings:Array.from({length:52},(_,index)=>({...finding,id:String(index)}))});
 const context={document,Node:document.Node,URL,Intl,console,AbortController,crypto,setTimeout,clearTimeout,addEventListener(){},fetch:async(url,init={})=>{
  if(!init.method)return Response.json({enabled:true,actor:{id:'synthetic-owner',role:'owner'},owners:[]});
  const c=JSON.parse(init.body).body;calls.push(c);
  return Response.json(c.command==='intelligence.diagnostics'?diagnostics:c.command==='intelligence.report'?{generatedAt:new Date().toISOString(),pipelines:{}}:c.command==='intelligence.customer'?{events:[{eventType:'booking_commitment',occurredAt:new Date().toISOString(),evidence:[{sourceType:'call_transcript',sourceRecordId:'synthetic-call',excerpt:'Original source opened'}]}]}:{items:[],total:0,nextOffset:null});
 }};context.window=context;vm.runInNewContext(readFileSync(new URL('../employee-operations.js',import.meta.url),'utf8'),context);await context.EGCActionCenter.mount(host);
 host.querySelectorAll('button').find(b=>b.textContent==='Sales evidence').click();await flush();
 const review=host.querySelector('[data-booking-review]');assert.ok(review);assert.match(review.textContent,/Booking commitments to review · 52/);assert.match(review.textContent,/Visit date and time need confirmation/);assert.match(review.textContent,/Original time wording: next Friday/);assert.match(review.textContent,/coverage is incomplete/);assert.match(review.textContent,/<img src=x>/);assert.equal(review.querySelectorAll('img').length,0);assert.equal(review.querySelectorAll('a').length,0);
 assert.equal(review.querySelectorAll('article').length,50);review.querySelectorAll('button').find(b=>b.textContent.startsWith('Show next')).click();assert.equal(review.querySelectorAll('article').length,52);assert.equal(review.querySelectorAll('button').filter(b=>b.textContent.startsWith('Show next')).length,0);
 review.querySelectorAll('button').find(b=>b.textContent==='Customer evidence').click();await flush();assert.match(document.body.querySelector('dialog').textContent,/Original source opened/);assert.equal(calls.at(-1).contactId,'synthetic-contact');assert.ok(calls.every(c=>['queue','intelligence.report','intelligence.diagnostics','intelligence.customer'].includes(c.command)));context.EGCActionCenter.unmount();
});

test('future or old snapshot times never pass the freshness gate',()=>{
 const d=wrap({findings:[],coverage:{portalComplete:true,providerComplete:true}}),at=Date.parse('2026-10-02T15:00:00Z');
 assert.equal(model(d,at).fresh,true);assert.equal(model(d,at-120000).fresh,false);assert.equal(model(d,at+16*60000).fresh,false);
});
