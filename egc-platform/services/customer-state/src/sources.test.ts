import {describe,it,expect} from 'vitest';
import {recordsFromSnapshot,type SourceBundle} from './sources.js';
import {readOccurrenceIdentity,resolveCustomerOccurrences} from './occurrences.js';
const bundle=(patch:Partial<SourceBundle>={}):SourceBundle=>({contact:{id:'customer-one',providerId:'provider-one'},lead:{id:'lead-one',createdAt:'2026-09-01T10:00:00Z'},walkthroughCalendarIds:['walkthrough-calendar'],jobCalendarIds:['job-calendar'],...patch});
const source=(b:SourceBundle,type:string)=>recordsFromSnapshot(b).find(r=>r.sourceType===type)!;
describe('structured booking lifecycle evidence',()=>{
 it('ingests provider cancellation under the exact appointment and work kind, never as an active booking',()=>{
  const record=source(bundle({appointments:[{id:'local-a',providerId:'provider-a',calendarId:'job-calendar',title:'SERVICE JOB',status:'cancelled',appointmentCreatedAt:'2026-09-10T10:00:00Z',appointmentStartAt:'2026-10-03T18:00:00Z',updatedAt:'2026-10-01T12:00:00Z',raw:{cancelledAt:'2026-09-30T18:00:00Z'}}]}),'appointment');
  expect(record.events).toHaveLength(1);expect(record.events![0]).toMatchObject({eventType:'appointment_cancelled',occurredAt:'2026-09-30T18:00:00.000Z',humanReviewNeeded:false,details:{occurrenceKind:'job',occurredAtVerified:true,lifecycleObservedAt:'2026-10-01T12:00:00.000Z'}});
  expect(readOccurrenceIdentity(record.events![0]!)?.aliases).toContainEqual({kind:'job',namespace:'provider_appointment',recordId:'provider-a'});
 });
 it('keeps unknown cancellation time honest and never uses the future scheduled time as its lifecycle time',()=>{
  const record=source(bundle({appointments:[{id:'local-a',providerId:'provider-a',calendarId:'walkthrough-calendar',status:'noshow',appointmentStartAt:'2026-10-03T18:00:00Z',updatedAt:'2026-10-01T12:00:00Z',raw:{}}]}),'appointment');
  expect(record.events![0]).toMatchObject({eventType:'no_show',occurredAt:'2026-10-01T12:00:00.000Z',details:{occurredAtVerified:false,occurrenceKind:'walkthrough'}});
 });
 it('keeps unknown-purpose terminal appointments in human review instead of inventing a walkthrough',()=>{
  const record=source(bundle({appointments:[{id:'local-a',providerId:'provider-a',calendarId:'unknown',status:'cancelled',title:'Interview',updatedAt:'2026-10-01T12:00:00Z',raw:{}}]}),'appointment');
  expect(record.events![0]).toMatchObject({eventType:'appointment_cancelled',humanReviewNeeded:true,details:{occurrenceKind:null}});expect(readOccurrenceIdentity(record.events![0]!)).toBeNull();
 });
 it('binds local job cancellation to its exact local/provider aliases',()=>{
  const record=source(bundle({jobs:[{id:'local-job',appointmentId:'local-a',status:'canceled',serviceType:'garage cleaning',cancelledAt:'2026-09-30T18:00:00Z'}],appointments:[{id:'local-a',providerId:'provider-a',status:'cancelled',calendarId:'job-calendar',raw:{}}]}),'job');
  expect(record.events![0]).toMatchObject({eventType:'appointment_cancelled',details:{occurrenceKind:'job',occurredAtVerified:true}});
  expect(readOccurrenceIdentity(record.events![0]!)?.aliases).toContainEqual({kind:'job',namespace:'local_job',recordId:'local-job'});
 });
 it('Hub no-show/cancellation cannot remain a scheduled or sold event and keeps its exact occurrence',()=>{
  for(const status of ['cancelled','no_show']){
   const record=source(bundle({portalRecords:[{id:'hub-one',highlevelContactId:'provider-one',kind:'job',status,startAt:'2026-10-03T18:00:00Z',cancelledAt:'2026-09-30T18:00:00Z',noShowAt:'2026-09-30T18:00:00Z',updatedAt:'2026-10-01T12:00:00Z'}]}),'portal_job');
   expect(record.events!.map(e=>e.eventType)).toEqual([status==='cancelled'?'appointment_cancelled':'no_show']);
   expect(readOccurrenceIdentity(record.events![0]!)).toMatchObject({kind:'job',authoritativePortalId:'hub-one'});
   expect(record.events![0]?.occurredAt).toBe('2026-09-30T18:00:00.000Z');
  }
 });
 it('does not attach leaked foreign-customer sources to the current customer occurrence',()=>{
  const foreign=source(bundle({portalRecords:[{id:'hub-one',highlevelContactId:'provider-one',kind:'job',status:'scheduled',startAt:'2026-10-03T18:00:00Z'}]}),'portal_job');
  const result=resolveCustomerOccurrences({contactId:'another-customer',leadId:'another-lead',records:[foreign]});
  expect(result.records).toEqual([]);expect(result.occurrences).toEqual([]);expect(result.issues).toContainEqual(expect.objectContaining({code:'occurrence_cross_customer_source',sourceIds:['hub-one']}));
 });
 it('preserves a verified historic accepted sale when the current Hub visit is cancelled',()=>{
  const record=source(bundle({portalRecords:[{id:'hub-one',highlevelContactId:'provider-one',kind:'job',status:'cancelled',soldAt:'2026-09-01T10:00:00Z',cancelledAt:'2026-09-30T18:00:00Z',financials:{quote:{at:'2026-09-01T10:00:00Z',amountCents:13900,source:'customer_approval'}}}]}),'portal_job');
  expect(record.events!.find(e=>e.eventType==='job_sold')).toMatchObject({occurredAt:'2026-09-01T10:00:00.000Z',valueCents:13900,valueVerified:true});
  expect(record.events!.some(e=>e.eventType==='appointment_cancelled')).toBe(true);expect(record.events!.some(e=>e.eventType==='job_scheduled')).toBe(false);
 });

});
