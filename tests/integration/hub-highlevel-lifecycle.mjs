// Run with: node --experimental-transform-types --test --test-isolation=none tests/integration/hub-highlevel-lifecycle.mjs
// Real Hub scheduling and provider reliability code; in-memory persistence and provider only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mutateDispatch} from '../../functions/_lib/dispatch-service.js';
import {resolveScheduledVisit,bindScheduledProvider} from '../../functions/_lib/operations-scheduling.js';
import {ReliableAppointments,AppointmentOperationError} from '../../egc-platform/services/operations/src/appointment-reliability.ts';

const now='2026-10-14T10:00:00.000Z';
const actor={id:'synthetic',kind:'integration',role:'integration',workspace:'synthetic'};
const manager={user:'zacb',displayName:'Synthetic Owner',role:'owner',businessAccess:true};
function fixture(){
 const rows=new Map([['customers/synthetic-customer',{id:'synthetic-customer',name:'Synthetic Customer',address:'100 Synthetic Street',highlevelContactId:'synthetic-contact',revision:'customer-r1'}]]);
 let revision=0,writes=0,loseResponse=false;
 const all=c=>[...rows.entries()].filter(([k])=>k.startsWith(c+'/')).map(([,v])=>structuredClone(v));
 const store={jobs:async()=>all('jobs'),resources:async()=>[],customers:async()=>all('customers'),roster:async()=>[{id:'synthetic-crew',name:'Synthetic Crew',role:'crew'}],read:async(c,id)=>structuredClone(rows.get(c+'/'+id)||null),commit:async changes=>{
  for(const w of changes){const row=rows.get(w.collection+'/'+w.id);if(w.revision?row?.revision!==w.revision:Boolean(row))throw Error('synthetic_revision_conflict');}
  for(const w of changes)if(!w.verify)rows.set(w.collection+'/'+w.id,{...rows.get(w.collection+'/'+w.id),...structuredClone(w.patch),id:w.id,revision:'r'+(++revision)});
 }};
 const ledger=new Map(),events=new Map();
 const operations={reserve:async intent=>{
  const prior=[...ledger.values()].find(o=>o.operationKey===intent.operationKey);
  if(prior){if(prior.payloadHash!==intent.payloadHash)throw new AppointmentOperationError('appointment_idempotency_payload_conflict');return {...prior};}
  const row={...intent,id:randomUUID(),status:'pending',response:null,lastError:null,attemptCount:0,leaseExpiresAt:null};ledger.set(row.id,row);return {...row};
 },get:async id=>({...ledger.get(id)}),claim:async(op,at)=>{
  const row=ledger.get(op.id);if(!['pending','failed'].includes(row.status))return false;
  if([...ledger.values()].some(o=>o.id!==op.id&&o.resourceKey===op.resourceKey&&['in_flight','unknown'].includes(o.status)))throw new AppointmentOperationError('appointment_resource_has_unresolved_operation');
  Object.assign(row,{status:'in_flight',attemptCount:row.attemptCount+1,leaseExpiresAt:new Date(at.getTime()+120000)});return true;
 },finish:async(id,status,data)=>{const row=ledger.get(id);if(row.status==='accepted'&&status!=='accepted')return;Object.assign(row,{status,...data,...(status==='in_flight'?{}:{leaseExpiresAt:null})});}};
 const provider={locationId:'synthetic-location',getCalendarEvents:async()=>({events:[...events.values()]}),getAppointment:async id=>({event:structuredClone(events.get(id))}),createAppointment:async payload=>{
  writes++;const event={...payload,id:'synthetic-appointment'};events.set(event.id,event);if(loseResponse){loseResponse=false;throw Error('synthetic_response_lost');}return{event};
 },updateAppointment:async(id,payload)=>{writes++;const event={...events.get(id),...payload,id};events.set(id,event);return{event};}};
 const sender=new ReliableAppointments(operations,provider);
 const mutate=input=>mutateDispatch(store,manager,{requestId:randomUUID(),...input},now);
 async function mirror(id,key){
  const {visit}=await resolveScheduledVisit(store,id);
  const status=['cancelled','canceled'].includes(visit.status)?'cancelled':['completed','paid','invoiced'].includes(visit.status)?'showed':'confirmed';
  const payload={title:visit.title,startTime:visit.startTime,endTime:visit.endTimeInstant,address:visit.address,appointmentStatus:status,toNotify:false};
  const context={portalVisitId:id,contactProviderId:visit.highlevelContactId};
  const result=visit.highlevelAppointmentId?await sender.update(visit.highlevelAppointmentId,payload,context,key):await sender.create({...payload,calendarId:'synthetic-calendar',contactId:visit.highlevelContactId},context,null,key);
  const latest=rows.get('jobs/'+id);
  await bindScheduledProvider(store,actor,{portalVisitId:id,expectedRevision:latest.revision,operationId:result.operationId,event:result.event},now);
  return result;
 }
 return{rows,events,ledger,mutate,mirror,writes:()=>writes,loseResponse:()=>{loseResponse=true}};
}

test('synthetic booking, recovered create, replay, crew assignment, reschedule, cancel and restore keep one exact appointment',async()=>{
 const f=fixture();
 const created=await f.mutate({action:'schedule.create',customerId:'synthetic-customer',kind:'job',changes:{date:'2026-10-19',time:'09:00',endTime:'11:00',assignedCrew:['synthetic-crew'],jobInstructions:'Synthetic fixture only',notify:false}});
 const id=created.job.id;
 assert.deepEqual(created.job.assignedCrew,['synthetic-crew']);
 f.loseResponse();const first=await f.mirror(id,'synthetic-create');assert.equal(first.source,'provider-recovery');
 await f.mirror(id,'synthetic-linked-replay');assert.equal(f.writes(),1);assert.equal(f.events.size,1);
 let current=f.rows.get('jobs/'+id);
 await f.mutate({action:'schedule.update',jobId:id,expectedRevision:current.revision,changes:{date:'2026-12-02',time:'09:00',endTime:'11:00'}});
 await f.mirror(id,'synthetic-reschedule');assert.equal(f.events.get('synthetic-appointment').startTime,'2026-12-02T16:00:00.000Z');
 current=f.rows.get('jobs/'+id);
 await f.mutate({action:'schedule.cancel',jobId:id,expectedRevision:current.revision,cancellationReason:'Synthetic test cancellation',changes:{}});
 await f.mirror(id,'synthetic-cancel');assert.equal(f.events.get('synthetic-appointment').appointmentStatus,'cancelled');
 current=f.rows.get('jobs/'+id);
 await f.mutate({action:'schedule.restore',jobId:id,expectedRevision:current.revision,changes:{}});
 await f.mirror(id,'synthetic-restore');assert.equal(f.events.get('synthetic-appointment').appointmentStatus,'confirmed');
 assert.equal(f.events.size,1);assert.equal(f.writes(),4);assert.equal(f.rows.get('jobs/'+id).syncStatus,'synced');
 assert.ok([...f.events.values()].every(event=>event.toNotify===false));
});

test('synthetic completed, invoice and payment states only mirror attendance and never collect money',async()=>{
 const f=fixture();
 const {job}=await f.mutate({action:'schedule.create',customerId:'synthetic-customer',kind:'job',changes:{date:'2026-10-19',time:'09:00',endTime:'11:00',assignedCrew:['synthetic-crew'],jobInstructions:'Synthetic fixture only',notify:false}});
 await f.mirror(job.id,'synthetic-status-create');
 for(const status of ['completed','invoiced','paid']){
  // Simulate a separately persisted Hub status; no invoice/payment API is called.
  const key='jobs/'+job.id;f.rows.set(key,{...f.rows.get(key),status,pipelineStatus:status});
  await f.mirror(job.id,'synthetic-status-'+status);
  const event=f.events.get('synthetic-appointment');assert.equal(event.appointmentStatus,'showed');
  for(const field of ['amount','payment','invoice','charge','currency'])assert.equal(event[field],undefined);
 }
 assert.equal(f.events.size,1);assert.equal(f.writes(),2,'unchanged showed status needs no further provider writes');
});
