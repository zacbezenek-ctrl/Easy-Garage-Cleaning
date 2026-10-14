import test from 'node:test';
import assert from 'node:assert/strict';
import {FLAG_OFF_ENV,FLAG_OFF_JOBS,FLAG_OFF_REQUESTS,highLevelRequestLog} from './helpers/ghl-track-fixture.mjs';

for(const enabled of [false,true])for(const state of ['cancelled','no_show'])for(const linked of [false,true]){
 test(`saved ${state}, outbox ${enabled}, linked ${linked}: no re-confirmation, scheduled tags or notifications`,async t=>{
  const id='synthetic-terminal',appointmentId=linked?'synthetic-appointment':'';
  const job={...FLAG_OFF_JOBS['visit-cancel'],status:state,pipelineStatus:state,highlevelAppointmentId:appointmentId};
  const request={...FLAG_OFF_REQUESTS[0][1],job_id:id,appointment_id:appointmentId,idempotency_key:'synthetic-terminal-key'};
  const {responses:[result]}=await highLevelRequestLog(t,{...FLAG_OFF_ENV,EGC_GHL_TAG_OUTBOX:String(enabled)},{[id]:job},[['terminal retry',request]]);
  assert.equal(result.status,200);
  assert.equal(result.calls.some(call=>/\/tags$/.test(call.path)||call.path.startsWith('/opportunities')),false);
  const appointmentCalls=result.calls.filter(call=>call.path.startsWith('/calendars'));
  if(!linked)assert.deepEqual(appointmentCalls,[]);
  else{
   assert.equal(appointmentCalls.length,1);
   assert.equal(appointmentCalls[0].method,'PUT');
   assert.equal(appointmentCalls[0].body.appointmentStatus,state==='cancelled'?'cancelled':'noshow');
   assert.equal(appointmentCalls[0].body.toNotify,false);
  }
 });
}

test('legacy schedule with an unavailable saved Hub visit makes no calendar or tag writes',async t=>{
 const request={...FLAG_OFF_REQUESTS[0][1],job_id:'synthetic-missing'};
 const {responses:[result]}=await highLevelRequestLog(t,FLAG_OFF_ENV,{},[['unavailable visit',request]]);
 assert.equal(result.status,503);assert.equal(result.body.code,'SCHEDULE_SOURCE_UNAVAILABLE');
 assert.equal(result.calls.some(call=>call.path.startsWith('/calendars')||/\/tags$/.test(call.path)||call.path.startsWith('/opportunities')),false);
});
