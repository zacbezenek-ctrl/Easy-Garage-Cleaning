import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';import{randomUUID}from'node:crypto';
const context={window:{},crypto:{randomUUID}};vm.runInNewContext(readFileSync(new URL('../crew/walkthrough-review.js',import.meta.url),'utf8'),context);
test('editing reviewed details requires the relevant staff confirmations again',()=>{
 const data={customerConfirmed:true,addressConfirmed:true,pricingReviewed:true};context.window.EGCWalkthroughReview.updateData(data,'address','Different address');assert.equal(data.addressConfirmed,false);assert.equal(data.customerConfirmed,true);context.window.EGCWalkthroughReview.updateData(data,'scopeSummary','New scope');assert.equal(data.pricingReviewed,false);assert.equal(data.boundariesReviewed,false);
});
test('resuming partial work preserves new base fields but never changes a finalized snapshot',()=>{
 const resume=context.window.EGCWalkthroughReview.resumeData;
 assert.deepEqual(JSON.parse(JSON.stringify(resume({address:'New base'}, {revision:1,stage:'draft',draft:{customerName:'Saved'}},{baseRevision:1,data:{customerName:'Local'}}))),{address:'New base',customerName:'Local'});
 assert.deepEqual(JSON.parse(JSON.stringify(resume({address:'Changed'}, {revision:2,stage:'finalized',draft:{address:'Frozen'}},{baseRevision:2,data:{address:'Local'}}))),{address:'Frozen'});
});
test('unknown save outcome remains frozen and is retried with identical payload after reload',async()=>{
 const rows=new Map(),storage={getItem:k=>rows.get(k),setItem:(k,v)=>rows.set(k,v)},sent=[];let lost=true;
 const options={storage,actor:'rep',jobId:'w1',fetcher:async(url,init)=>{const body=JSON.parse(init.body);sent.push(body);if(lost){lost=false;throw new Error('lost');}return Response.json({ok:true,review:{revision:1,draft:body.data}});}};
 const a=context.window.EGCWalkthroughReview.requestClient(options);await assert.rejects(a.send('save',{customerName:'Original'},0));
 const b=context.window.EGCWalkthroughReview.requestClient(options);await b.send('save',{customerName:'Edited later'},0);assert.deepEqual(sent[0],sent[1]);assert.equal(b.read().pending,undefined);assert.equal(b.read().data.customerName,'Original');
 const other=context.window.EGCWalkthroughReview.requestClient({...options,actor:'other'});assert.deepEqual(Object.keys(other.read()),[]);
});
test('corrupt local recovery state prevents a new request rather than losing an unknown save',async()=>{
 let calls=0;const client=context.window.EGCWalkthroughReview.requestClient({actor:'rep',jobId:'w1',storage:{getItem:()=>'{bad',setItem:()=>assert.fail('must not overwrite recovery')},fetcher:async()=>{calls++;}});await assert.rejects(client.send('save',{},0),/unreadable/);assert.equal(calls,0);
});
