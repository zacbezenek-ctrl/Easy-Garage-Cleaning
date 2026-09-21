import test from 'node:test';
import assert from 'node:assert/strict';
import {syncNativeNote} from '../functions/_lib/operations-note-sync.js';
import {verifyOperationsEnvelope} from '../functions/_lib/operations-envelope.js';
const env={EGC_OPERATIONS_API_ORIGIN:'https://synthetic.invalid',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:'isolated-native-note-key-01234567890123456789'};
const input={portalJobId:'synthetic-job',requestId:'stable-native-request',contactId:'provider-fixture',scope:'game_plan',title:'Synthetic internal brief',body:'Keep bicycle'};
test('native note bridge binds authenticated identity and stable payload, requires verified exact receipt',async()=>{
  let observed;const fetcher=async(url,options)=>{assert.equal(url.pathname,'/operations/rpc');observed=await verifyOperationsEnvelope(JSON.parse(options.body).envelope,env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET,'egc-operations');return Response.json({ok:true,authority:'employee_hub',portalJobId:input.portalJobId,noteId:'verified-note',outboxId:'durable-id',providerSync:'verified'});};
  const result=await syncNativeNote(env,{user:'verified-staff'},input,fetcher);assert.equal(result.note.id,'verified-note');assert.equal(observed.actor.id,'hub-note:verified-staff');assert.equal(observed.actor.kind,'integration');assert.equal(observed.request.body.requestId,input.requestId);assert.equal(observed.request.body.command,'provider.note.ensure');assert.equal(observed.request.body.providerContactId,input.contactId);
});
test('pending, wrong-record and malformed success never masquerade as a synchronized note',async()=>{
  for(const body of [{ok:false,error:'provider_note_pending',outboxId:'durable-id'},{ok:true,authority:'employee_hub',portalJobId:'wrong',noteId:'id',providerSync:'verified'},{ok:true,authority:'employee_hub',portalJobId:input.portalJobId,providerSync:'verified'}])await assert.rejects(syncNativeNote(env,{user:'verified-staff'},input,async()=>Response.json(body)),e=>/^provider_note_/.test(e.code));
});
test('missing stable identity fails before HTTP and private provider errors are never exposed',async()=>{
  let calls=0;await assert.rejects(syncNativeNote(env,{user:'staff'},{...input,requestId:null},async()=>{calls++;}),e=>e.code==='provider_note_stable_identity_required');assert.equal(calls,0);
  await assert.rejects(syncNativeNote(env,{user:'staff'},input,async()=>{throw new Error('private-token-123');}),e=>e.code==='provider_note_outcome_unknown'&&!e.message.includes('private-token'));
});
