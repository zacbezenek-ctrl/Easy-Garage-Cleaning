import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerMessageAlertStorage, ALERT_LIST_LIMIT } from '../functions/_lib/customer-message-alerts.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { customerMessageHandlers } from '../functions/api/customer-messages.js';

const missingIndex = () => Response.json({error:{status:'FAILED_PRECONDITION',message:'The query requires an index.'}},{status:400});
const row = (n, at) => ({document:{name:`projects/demo-inbox/databases/(default)/documents/customerMessageAlerts/cma_${String(n).padStart(40,'0')}`,updateTime:'2026-10-21T15:00:00.000000Z',fields:encodeFirestoreFields({status:'open',jobId:`synthetic-${n}`,lastMessageAt:at,body:'Synthetic message'})}});
function fixture(rows, first=missingIndex) {
  const calls=[];
  const store=customerMessageAlertStorage({},async (_env,url,init)=>{
    assert.ok(url.endsWith(':runQuery'), 'recovery never writes');
    const query=JSON.parse(init.body).structuredQuery;calls.push(query);
    return calls.length===1?first():Response.json(rows);
  });
  return {store,calls};
}
test('an unbuilt composite index still shows a complete small inbox, newest first',async()=>{
  const {store,calls}=fixture([row(1,'2026-10-20T10:00:00Z'),row(2,'2026-10-21T10:00:00Z')]);
  const result=await store.open();
  assert.equal(result.complete,true);
  assert.deepEqual(result.rows.map(r=>r.jobId),['synthetic-2','synthetic-1']);
  assert.equal(calls.length,2);
  assert.equal(calls[0].limit,ALERT_LIST_LIMIT+1);
  assert.equal(calls[1].limit,ALERT_LIST_LIMIT+1);
  assert.equal(Object.hasOwn(calls[1],'orderBy'),false);
  assert.deepEqual(calls[1].where,{fieldFilter:{field:{fieldPath:'status'},op:'EQUAL',value:{stringValue:'open'}}});
});
test('a confirmed empty fallback returns an empty complete inbox',async()=>{
  const {store}=fixture([{readTime:'2026-10-21T15:00:00Z'}]);
  assert.deepEqual(await store.open(),{rows:[],complete:true});
});
test('a truncated unordered inbox requires setup instead of silently hiding newer messages',async()=>{
  const {store}=fixture(Array.from({length:ALERT_LIST_LIMIT+1},(_,i)=>row(i,'2026-10-21T10:00:00Z')));
  const handlers=customerMessageHandlers({session:async()=>({user:'ZacB',role:'owner',businessAccess:true}),storage:()=>store,now:()=>new Date('2026-10-21T15:00:00Z')});
  const response=await handlers.get({request:new Request('https://example.invalid/api/customer-messages'),env:{}});
  assert.equal(response.status,503);
  const data=await response.json();
  assert.equal(data.code,'customer_messages_index_required');
  assert.match(data.error,/deploy firestore.indexes.json/);
  assert.equal(Object.hasOwn(data,'messages'),false);
});
for(const status of [403,429,500]) test(`provider ${status} is never treated as an index error`,async()=>{
  const {store,calls}=fixture([],()=>Response.json({error:{status:'PERMISSION_DENIED',message:'Access denied'}},{status}));
  await assert.rejects(store.open(),{code:'customer_messages_unavailable'});
  assert.equal(calls.length,1);
});
test('a failed fallback remains an error rather than an empty success',async()=>{
  let count=0;
  const store=customerMessageAlertStorage({},async()=>++count===1?missingIndex():Response.json({error:{}},{status:503}));
  await assert.rejects(store.open(),{code:'customer_messages_unavailable'});
});
test('unverifiable fallback rows are rejected',async()=>{
  const {store}=fixture([{document:{name:'invalid',fields:{}}}]);
  await assert.rejects(store.open(),{code:'customer_messages_incomplete'});
});
test('customer inbox and outbound automation navigation have distinct labels',()=>{
  const suite=readFileSync(new URL('../employee-suite.js',import.meta.url),'utf8');
  assert.match(suite,/\['CLIENT WORK','communications','Customer automations'\]/);
  assert.match(suite,/head\('CUSTOMER EXPERIENCE','Customer automations'/);
  assert.doesNotMatch(suite,/\['CLIENT WORK','communications','Customer messages'\]/);
});
