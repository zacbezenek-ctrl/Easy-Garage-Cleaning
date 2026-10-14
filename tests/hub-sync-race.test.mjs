import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const attempt='2026-10-14T10:00:00.000Z';
const original={id:'synthetic-visit',type:'job',date:'2026-10-19',time:'09:00',endTime:'11:00',status:'scheduled',syncStatus:'syncing',syncAttempts:1,syncLastAttemptAt:attempt,syncIdempotencyKey:'schedule:original',customerId:'synthetic-customer'};
function fixture(current={...original}){
  let row=structuredClone(current),writes=0;
  const storage={getItem:()=>null};
  const context={crypto,console,URLSearchParams,Date,Intl,Promise,Set,Map,Error,JSON,sessionStorage:storage,localStorage:storage,navigator:{},location:{pathname:'/employee',search:''},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},addEventListener(){},jobsCache:[{...row}],document:{readyState:'loading',hidden:false,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}}};
  context.window=context;
  context.db={collection:()=>({doc:()=>({})}),runTransaction:async fn=>fn({get:async()=>({exists:Boolean(row),data:()=>row}),set:(_ref,patch)=>{writes++;row={...row,...patch}}})};
  const source=readFileSync(new URL('../employee-suite.js',import.meta.url),'utf8').replace(/\}\)\(\);\s*$/,'globalThis.patchSync=patchSyncedJob;})();');
  vm.runInNewContext(source,context);
  return{patch:(update,options={})=>context.patchSync(original.id,update,{...original,syncAttempts:0},{attemptedAt:attempt,...options}),row:()=>row,writes:()=>writes,context};
}

test('late success cannot mark a rescheduled visit synced or attach its old provider ID',async()=>{
  const f=fixture({...original,time:'13:00',endTime:'15:00',syncStatus:'pending',syncIdempotencyKey:'schedule:moved'});
  assert.equal(await f.patch({syncStatus:'synced',highlevelAppointmentId:'old-event'}),false);
  assert.equal(f.writes(),0);assert.equal(f.row().syncStatus,'pending');assert.equal(f.row().highlevelAppointmentId,undefined);
  assert.equal(f.context.jobsCache[0].time,'13:00');
});
test('late failure cannot overwrite a worker-verified appointment',async()=>{
  const f=fixture({...original,syncStatus:'synced',highlevelAppointmentId:'verified-event'});
  assert.equal(await f.patch({syncStatus:'error',syncError:'timeout'},{failure:true}),false);
  assert.equal(f.writes(),0);assert.equal(f.row().syncStatus,'synced');
});
test('an older page attempt cannot overwrite a newer retry even for unchanged schedule',async()=>{
  for(const failure of [false,true]){
    const f=fixture({...original,syncLastAttemptAt:'2026-10-14T10:01:00.000Z'});
    assert.equal(await f.patch({syncStatus:failure?'error':'synced'},{failure}),false);assert.equal(f.writes(),0);
  }
});
test('cancellation, legacy no-key moves, drift and deleted visits retain their state',async()=>{
  for(const row of [{...original,status:'cancelled'}, {...original,syncIdempotencyKey:undefined,time:'14:00'}, {...original,syncStatus:'pending',syncError:'schedule_provider_drift'},null]){
    const f=fixture(row);assert.equal(await f.patch({syncStatus:'synced'}),false);assert.equal(f.writes(),0);
  }
});
test('same-intent link bookkeeping does not prevent success and real failure still queues retry',async()=>{
  const f=fixture({...original,updatedAt:'2026-10-14T10:00:01Z',projectId:'linked-project',highlevelContactId:'verified-contact'});
  assert.equal(await f.patch({syncStatus:'synced'}),true);assert.equal(f.writes(),1);
  const failed=fixture();assert.equal(await failed.patch({syncStatus:'error',syncNextRetryAt:'later'},{failure:true}),true);
  assert.equal(failed.row().syncStatus,'error');
});
test('starting an attempt refuses a stale cached schedule but permits a current drift retry',async()=>{
  const moved=fixture({...original,syncIdempotencyKey:'schedule:new'});
  assert.equal(await moved.patch({syncStatus:'syncing'},{starting:true}),false);
  const drift=fixture({...original,syncAttempts:0,syncStatus:'pending',syncError:'schedule_provider_drift'});
  assert.equal(await drift.patch({syncStatus:'syncing',syncError:''},{starting:true}),true);
});

test('two page attempts starting in the same millisecond cannot both claim the same attempt counter',async()=>{
 const f=fixture({...original,syncAttempts:0,syncStatus:'pending'});
 assert.equal(await f.patch({syncStatus:'syncing',syncAttempts:1},{starting:true}),true);
 assert.equal(await f.patch({syncStatus:'syncing',syncAttempts:1},{starting:true}),false);
 assert.equal(f.writes(),1);
});
