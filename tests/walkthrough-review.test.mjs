import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {normalizeWalkthroughReview,walkthroughReviewGaps,readWalkthroughReview,saveWalkthroughReview} from '../functions/_lib/walkthrough-review.js';
import {walkthroughCaptureHandlers} from '../functions/api/walkthrough-capture.js';
const owner={user:'zacb',role:'owner',businessAccess:true},sales={user:'rep',role:'sales',staffRoles:['sales']},env={EGC_STAFF_ROLE_PERMISSIONS:'true'},now='2026-10-14T17:00:00Z';
const complete=()=>({customerName:'Synthetic Customer',address:'123 Test Lane',serviceType:'organization',scopeSummary:'Organize the existing bins',customerConfirmed:true,addressConfirmed:true,accessReviewed:true,boundariesReviewed:true,decisionsReviewed:true,hazardsReviewed:true,damageReviewed:true,measurementsReviewed:true,measurementsNeeded:false,equipmentReviewed:true,questionsReviewed:true,pricingReviewed:true,exclusions:'None',crewSize:2,estimatedDurationMin:90,photoUnavailableReason:'Customer declined photographs',pricingStatus:'needs_quote',pricingReviewNote:'Quote to follow after stock is checked',handoffNotes:'Keep bins labelled and leave walkway clear'});
function fixture(){const rows=new Map([['customers/c1',{id:'c1',revision:'c0',name:'Synthetic Customer',address:'123 Test Lane'}],['jobs/w1',{id:'w1',revision:'r0',type:'walkthrough',customerId:'c1',assignedCrew:['rep']}]]);let n=0,lose=false;const commits=[];const store={read:async(c,id)=>structuredClone(rows.get(c+'/'+id)||null),commit:async writes=>{for(const w of writes){const old=rows.get(w.collection+'/'+w.id);if(w.revision?old?.revision!==w.revision:!!old)throw new Error('conflict');}commits.push(writes);for(const w of writes)if(!w.verify)rows.set(w.collection+'/'+w.id,{...rows.get(w.collection+'/'+w.id),...structuredClone(w.patch),id:w.id,revision:'r'+ ++n});if(lose){lose=false;throw new Error('lost reply');}}};return{rows,store,commits,lose:()=>{lose=true;},input:(action='save',data={},extra={})=>({jobId:'w1',action,data,requestId:randomUUID(),expectedRevision:rows.get('jobs/w1').walkthroughReview?.revision||0,...extra})};}
test('partial drafts allow missing fields; malformed and approval/payment fields are refused',()=>{
 assert.deepEqual(normalizeWalkthroughReview({}),{});
 for(const d of [{signature:'fake'},{terms_accepted:true},{price:100},{crewSize:0},{hazards:[{}]},{customerConfirmed:'yes'}])assert.throws(()=>normalizeWalkthroughReview(d));
 const gaps=walkthroughReviewGaps(complete());assert.deepEqual(gaps,[]);
 assert.ok(walkthroughReviewGaps({...complete(),serviceType:'junk_removal'}).some(x=>x.field==='removeItems'));
 assert.ok(walkthroughReviewGaps({...complete(),measurementsNeeded:true}).some(x=>x.field==='measurements'));
 assert.ok(walkthroughReviewGaps({...complete(),finish:['shelving']}).some(x=>x.field==='shelfQty'));
 assert.ok(walkthroughReviewGaps({...complete(),hazards:['Unstable stacks']}).some(x=>x.field==='hazardPlan'));
});
test('interrupted/repeated saves replay without losing data or making a second revision',async()=>{
 const f=fixture(),input=f.input('save',{customerName:'Partial'});f.lose();const first=await saveWalkthroughReview(f.store,owner,input,now,{env});
 assert.equal(first.review.revision,1);assert.equal(first.replayed,true);const replay=await saveWalkthroughReview(f.store,owner,input,now,{env});assert.equal(replay.review.revision,1);assert.equal(f.commits.length,1);
 await assert.rejects(saveWalkthroughReview(f.store,owner,{...input,data:{customerName:'Other'}},now,{env}),e=>e.code==='walkthrough_review_idempotency_conflict');
 await assert.rejects(saveWalkthroughReview(f.store,owner,f.input('save',{}, {expectedRevision:0}),now,{env}),e=>e.code==='walkthrough_review_revision_conflict');
});
test('an unconfirmed commit is not misreported as a definite conflict',async()=>{
 const f=fixture();f.store.commit=async()=>{throw Object.assign(new Error('connection lost'),{code:'dispatch_outcome_unknown'});};
 await assert.rejects(saveWalkthroughReview(f.store,owner,f.input('save',{customerName:'Kept'}),now,{env}),e=>e.status===503&&e.code==='walkthrough_review_outcome_unknown');
});
test('finalization explains gaps, freezes its receipt snapshot and allows reasoned amendments',async()=>{
 const f=fixture();await assert.rejects(saveWalkthroughReview(f.store,owner,f.input('finalize',{}),now,{env}),e=>e.details.gaps.length>5);assert.equal(f.commits.length,0);
 const finalInput=f.input('finalize',complete()),final=await saveWalkthroughReview(f.store,owner,finalInput,now,{env});assert.equal(final.review.stage,'finalized');
 await assert.rejects(saveWalkthroughReview(f.store,owner,f.input('save',{handoffNotes:'edit'}),now,{env}),e=>e.code==='walkthrough_review_amend_required');
 await assert.rejects(saveWalkthroughReview(f.store,owner,f.input('amend',{}, {reason:''}),now,{env}));
 await saveWalkthroughReview(f.store,owner,f.input('amend',{}, {reason:'Customer requested a different bin location'}),now,{env});
 const next=await saveWalkthroughReview(f.store,owner,f.input('finalize',{handoffNotes:'Use left wall'}),now,{env});assert.equal(next.review.revision,3);
 assert.equal(f.rows.get('quoteDraftOperations/'+finalInput.requestId).finalizedSnapshot.handoffNotes,complete().handoffNotes);
 assert.equal(f.rows.get('jobs/w1').signature,undefined);assert.equal(f.rows.get('jobs/w1').customerApproval,undefined);
});
test('only assigned quote authors or managers can read and save private capture',async()=>{
 const f=fixture();assert.equal((await readWalkthroughReview(f.store,sales,'w1',{env})).review.revision,0);
 for(const actor of [null,{user:'crew',role:'crew'},{user:'other-rep',role:'sales',staffRoles:['sales']}])await assert.rejects(readWalkthroughReview(f.store,actor,'w1',{env}),e=>[401,403].includes(e.status));
 const handler=walkthroughCaptureHandlers({session:async()=>owner,storage:()=>f.store});const response=await handler.post({request:new Request('https://easygaragecleaning.com/api/walkthrough-capture',{method:'POST',headers:{Origin:'https://other.invalid','Content-Type':'application/json'},body:'{}'}),env});assert.equal(response.status,403);assert.equal(f.commits.length,0);
});
test('finalization refuses mismatched canonical identity/address without changing records',async()=>{
 for(const change of [{customerName:'Another person'},{address:'Wrong property'}]){const f=fixture();await assert.rejects(saveWalkthroughReview(f.store,owner,f.input('finalize',{...complete(),...change}),now,{env}),e=>e.code==='walkthrough_review_incomplete');assert.equal(f.commits.length,0);}
});
test('finalized capture links exact server quote revision and prepares only an internal operational sync',async()=>{
 const f=fixture();f.rows.set('jobs/q1',{id:'q1',revision:'qrev',type:'job',customerId:'c1',sourceWalkthroughId:'w1',highlevelContactId:'contact-1',quoteDraft:{version:1},estimate:{number:'EST1',revision:4,amount:900,depositRequired:450,lineItems:[],scope:'Quoted work'}});
 const result=await saveWalkthroughReview(f.store,owner,f.input('finalize',{...complete(),quoteJobId:'q1',pricingStatus:'quote_saved',pricingReviewNote:'Private override analysis $99',handoffNotes:'Move 3 bins ($20)'}),now,{env});
 assert.equal(result.review.latestFinalized.quote.revision,4);const q=f.rows.get('jobs/q1');assert.equal(q.estimate.revision,4);assert.equal(q.walkthroughCaptureSync.status,'pending');assert.doesNotMatch(q.walkthroughCaptureSync.body,/Private override|\$20/);
 q.estimate.amount=950;assert.equal((await readWalkthroughReview(f.store,owner,'w1',{env})).pricingChanged,true);
});
