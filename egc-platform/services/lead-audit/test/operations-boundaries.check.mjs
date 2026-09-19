import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson, approvalFingerprint, buildDueWorkSnapshot, collectTaskPages, pageDueWork} from '../dist/operations-tests/operations-core.js';
const subject = changes => ({actionId:'synthetic',revision:1,recipient:'test@example.invalid',channel:'email',payload:{message:'test'},quoteRevision:null,jobRevision:null,conversationWatermark:'1',policyRevision:'1',sendWindowStart:'2026-09-18T08:00:00-06:00',sendWindowEnd:'2026-09-18T09:00:00-06:00',...changes});
const queue = changes => buildDueWorkSnapshot({id:'synthetic',generatedAt:'2026-09-18T08:00:00-06:00',dueBefore:'2026-09-19T00:00:00-06:00',timeZone:'America/Denver',tasks:[],coverage:[{source:'tasks',status:'fresh',complete:true,asOf:'2026-09-18T08:00:00-06:00'}],requiredSources:['tasks'],...changes});
test('sparse array cannot hide a missing index using an unrelated key',()=>{
 const a=['first']; a.length=2; a.extra='not an array index';
 assert.throws(()=>canonicalJson(a),/Sparse or decorated/);
});
test('array symbol metadata is rejected rather than silently discarded',()=>{
 const a=['first']; a[Symbol('hidden')]='value'; assert.throws(()=>canonicalJson(a),/Sparse or decorated/);
});
test('dense nested arrays serialize to valid stable JSON',()=>{
 const v=[null,true,0,'',[],{b:[1,2],a:'hello'}]; assert.deepEqual(JSON.parse(canonicalJson(v)),v);
});
test('equal or reversed approval windows are rejected at fingerprint creation',async()=>{
 for(const end of ['2026-09-18T08:00:00-06:00','2026-09-18T07:00:00-06:00'])
  await assert.rejects(approvalFingerprint(subject({sendWindowEnd:end})),/positive duration/);
});
test('equivalent timestamp offsets yield the same approval fingerprint',async()=>{
 assert.equal(await approvalFingerprint(subject()),await approvalFingerprint(subject({sendWindowStart:'2026-09-18T14:00:00Z',sendWindowEnd:'2026-09-18T15:00:00Z'})));
});
test('empty complete queue and empty incomplete queue remain distinguishable',()=>{
 assert.equal(queue().counts.totalDue,0); assert.equal(queue({coverage:[]}).counts.totalDue,null);
});
test('duplicate coverage names fail instead of overwriting coverage',()=>{
 const c={source:'tasks',status:'fresh',complete:true,asOf:'2026-09-18T14:00:00Z'};
 assert.throws(()=>queue({coverage:[c,c]}),/Duplicate or missing source/);
});
test('source page size overflow fails rather than dropping excess records',async()=>{
 await assert.rejects(collectTaskPages(async()=>[{id:'a'},{id:'b'}],1),/exceeded/);
});
test('exact page multiple requires an empty final page',async()=>{
 const rows=[{id:'a'},{id:'b'}]; let calls=0;
 const result=await collectTaskPages(async after=>{calls++; return after===null?rows:[];},2);
 assert.equal(result.length,2); assert.equal(calls,2);
});
test('pagination preserves snapshot identity even beyond final page',()=>{
 const q=queue(); const p=pageDueWork(q,100,100);
 assert.equal(p.snapshotId,q.id); assert.equal(p.items.length,0); assert.equal(p.nextOffset,null);
});
