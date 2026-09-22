import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Actor,Command} from '@egc/operations';
type Json=Record<string,unknown>;
const f=vi.hoisted(()=>({providers:[] as Json[],syncs:[] as Json[],events:[] as Json[],contacts:[] as Json[],writes:[] as Json[],reconcileCustomerState:vi.fn(),syncPortalSchedule:vi.fn()}));
vi.mock('@egc/customer-state',()=>({reconcileCustomerState:f.reconcileCustomerState,customerActivityPredicate:vi.fn(()=>true),customerRefreshOrder:vi.fn(()=>null)}));
vi.mock('./scheduling.js',()=>({syncPortalSchedule:f.syncPortalSchedule}));
vi.mock('@egc/operations',async()=>{const actual=await vi.importActual<typeof import('@egc/operations')>('@egc/operations');return {reconcileBookingSnapshot:actual.reconcileBookingSnapshot};});
vi.mock('@egc/database',()=>{
 const schema={appointments:{contactId:'appointment-contact'},contacts:{id:'contact-id',providerId:'provider-id',provider:'provider',createdAt:'contact-created'},syncCursors:{key:'cursor-key'},customerEvents:{contactId:'event-contact'}};
 const db={select:()=>({from:(table:unknown)=>{const rows=table===schema.appointments?f.providers:table===schema.syncCursors?f.syncs:table===schema.contacts?f.contacts:f.events;const query={innerJoin:async()=>rows,where:()=>query,orderBy:()=>query,limit:async()=>rows};return query;}}),insert:()=>({values:(row:Json)=>{f.writes.push(row);return {onConflictDoUpdate:async()=>undefined};}})};
 return {schema,getDb:()=>db};
});
import {reconcileHubBookings} from './booking-worker.js';
const now=new Date('2026-09-22T06:00:00Z');
const visit=(id='visit-one'):Json=>({id,kind:'walkthrough',status:'scheduled',highlevelContactId:'provider-contact-one',portalCustomerId:'portal-customer-one',startAt:'2026-09-25T21:00:00Z',endAt:'2026-09-25T21:30:00Z',address:'100 Synthetic Street',sourceRevision:'revision-1'});
const detail=(id='visit-one'):Json=>({authority:'employee_hub',job:{id,kind:'walkthrough',highlevelContactId:'provider-contact-one',createdAt:'2026-09-21T10:00:00Z',updatedAt:'2026-09-21T10:05:00Z'},financials:{}});
const evidence=(contactProviderIds=['provider-contact-one'],records:Json[]=[{...visit(),createdAt:'2026-09-21T10:00:00Z',financials:{}}],complete=true):Json=>({authority:'employee_hub',contactProviderIds,records,coverage:{complete,asOf:now.toISOString()}});
function portal(options:{coverage?:boolean;detail?:Json;nextOffset?:unknown;evidence?:Json}={}){return vi.fn(async(_actor:Actor,command:Command):Promise<Json>=>command.command==='calendar'?{authority:'employee_hub',items:[visit()],coverage:{complete:options.coverage??true},nextOffset:options.nextOffset??null}:command.command==='portal.evidence'?options.evidence??evidence(command.contactProviderIds,options.detail?[]:undefined,options.coverage??true):options.detail??detail());}
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(now);f.providers=[];f.syncs=[{cursor:now.toISOString()}];f.events=[];f.contacts=[{contactId:'contact-one',providerId:'provider-contact-one'}];f.writes=[];f.reconcileCustomerState.mockResolvedValue({inspected:1,failed:0});f.syncPortalSchedule.mockResolvedValue({ok:true});});
afterEach(()=>vi.useRealTimers());
describe('Hub booking worker source boundary',()=>{
 it('uses exact Hub job facts and invokes only durable sync with automations disabled',async()=>{const p=portal(),result=await reconcileHubBookings(p,{EGC_BOOKING_AUTO_RECONCILE:'true'});expect(result).toMatchObject({visits:1,portalComplete:true,providerComplete:true,repairs:1});expect(p).toHaveBeenCalledWith(expect.objectContaining({kind:'integration',workspace:'egc'}),{command:'portal.job',jobId:'visit-one'});expect(f.syncPortalSchedule).toHaveBeenCalledWith(expect.objectContaining({id:'booking-reconciler'}),{command:'schedule.sync_provider',portalVisitId:'visit-one',requestId:expect.stringMatching(/^reconcile:/),runAutomations:false},p,{env:{EGC_BOOKING_AUTO_RECONCILE:'true'}});const args=f.reconcileCustomerState.mock.calls[0]?.[0];expect(args.portalRecords).toEqual([expect.objectContaining({id:'visit-one',highlevelContactId:'provider-contact-one',kind:'walkthrough',status:'scheduled',createdAt:'2026-09-21T10:00:00Z',financials:{}})]);expect(args.portalRecords[0]).not.toHaveProperty('paidCents');expect(args.portalCoverage.complete).toBe(true);});
 it('defaults repairs to dry run while persisting diagnostics and canonical source facts',async()=>{const result=await reconcileHubBookings(portal(),{});expect(f.syncPortalSchedule).not.toHaveBeenCalled();expect(f.reconcileCustomerState).toHaveBeenCalledTimes(1);expect(f.writes).toHaveLength(1);expect(JSON.parse(String(f.writes[0]?.cursor)).dryRun).toBe(true);expect(result.portalComplete).toBe(true);});
 it('prevents repairs when any portal page declares incomplete coverage',async()=>{await reconcileHubBookings(portal({coverage:false}),{EGC_BOOKING_AUTO_RECONCILE:'true'});expect(f.syncPortalSchedule).not.toHaveBeenCalled();expect(f.reconcileCustomerState.mock.calls[0]?.[0].portalCoverage.complete).toBe(false);expect(JSON.parse(String(f.writes[0]?.cursor)).findings).toContainEqual(expect.objectContaining({code:'booking_source_coverage_incomplete',automaticRepair:false}));});
 it('prevents repairs when provider refresh is stale or missing',async()=>{for(const syncs of [[],[{cursor:'2026-09-22T05:40:00Z'}]]){f.syncs=syncs;const r=await reconcileHubBookings(portal(),{EGC_BOOKING_AUTO_RECONCILE:'true'});expect(r.providerComplete).toBe(false);}expect(f.syncPortalSchedule).not.toHaveBeenCalled();});
 it('does not use a different exact job result or attach its financials',async()=>{const p=portal({detail:{...detail('other-job'),financials:{payments:[{key:'wrong-customer',amountCents:90000}]}}});const result=await reconcileHubBookings(p,{EGC_BOOKING_AUTO_RECONCILE:'true'});expect(result.portalComplete).toBe(false);expect(f.syncPortalSchedule).not.toHaveBeenCalled();expect(f.reconcileCustomerState.mock.calls[0]?.[0].portalRecords).toEqual([]);});
 it('rejects conflicting contact identity between calendar and exact job before repair or revenue ingestion',async()=>{const d=detail();d.job={...(d.job as Json),highlevelContactId:'different-provider-contact'};d.financials={payments:[{key:'other-customer-money',amountCents:72500}]};const result=await reconcileHubBookings(portal({detail:d}),{EGC_BOOKING_AUTO_RECONCILE:'true'});expect(result.portalComplete).toBe(false);expect(f.syncPortalSchedule).not.toHaveBeenCalled();expect(f.reconcileCustomerState.mock.calls[0]?.[0].portalRecords).toEqual([]);});
 it('fetches all pages with stable offsets before deciding repairs',async()=>{const p=vi.fn(async(_actor:Actor,c:Command):Promise<Json>=>c.command==='calendar'?{authority:'employee_hub',items:c.offset===0?[visit('visit-one')]:[],coverage:{complete:true},nextOffset:c.offset===0?200:null}:c.command==='portal.evidence'?evidence(c.contactProviderIds):detail());await reconcileHubBookings(p,{});expect(p.mock.calls.filter(([,c])=>c.command==='calendar').map(([,c])=>c.command==='calendar'?c.offset:null)).toEqual([0,200]);expect(f.reconcileCustomerState).toHaveBeenCalledTimes(1);});
 it('stalled or malformed pagination fails before any provider repair',async()=>{await expect(reconcileHubBookings(portal({nextOffset:0}),{EGC_BOOKING_AUTO_RECONCILE:'true'})).rejects.toThrow('hub_calendar_pagination_stalled');await expect(reconcileHubBookings(portal({nextOffset:'200'}),{EGC_BOOKING_AUTO_RECONCILE:'true'})).rejects.toThrow('hub_calendar_pagination_stalled');expect(f.syncPortalSchedule).not.toHaveBeenCalled();expect(f.reconcileCustomerState).not.toHaveBeenCalled();expect(f.writes).toEqual([]);});
 it('marks coverage incomplete when the pagination bound is exhausted',async()=>{const p=vi.fn(async(_actor:Actor,c:Command):Promise<Json>=>{if(c.command!=='calendar')return evidence(['provider-contact-one'],[]);return {authority:'employee_hub',items:[],coverage:{complete:true},nextOffset:c.offset+200};});const result=await reconcileHubBookings(p,{EGC_BOOKING_AUTO_RECONCILE:'true'});expect(p.mock.calls.filter(([,c])=>c.command==='calendar')).toHaveLength(30);expect(result.portalComplete).toBe(false);expect(f.syncPortalSchedule).not.toHaveBeenCalled();});
 it('refuses a provider calendar substituted for the Hub and propagates unavailable detail before writes',async()=>{await expect(reconcileHubBookings(vi.fn(async()=>({authority:'ghl',items:[],coverage:{complete:true}})),{EGC_BOOKING_AUTO_RECONCILE:'true'})).rejects.toThrow('hub_calendar_unavailable');const p=vi.fn(async(_a:Actor,c:Command)=>{if(c.command==='calendar')return {authority:'employee_hub',items:[visit()],coverage:{complete:true}};throw new Error('portal unavailable');});await expect(reconcileHubBookings(p,{EGC_BOOKING_AUTO_RECONCILE:'true'})).rejects.toThrow('portal unavailable');expect(f.syncPortalSchedule).not.toHaveBeenCalled();expect(f.writes).toEqual([]);});
 it('imports unscheduled accepted and completed work from exact older active contacts independently of calendar',async()=>{
  f.contacts.push({contactId:'older-contact',providerId:'older-provider'});
  const paid={id:'unscheduled-paid-job',highlevelContactId:'older-provider',kind:'job',status:'completed',startAt:null,soldAt:'2026-09-20T12:00:00Z',completedAt:'2026-09-21T12:00:00Z',financials:{quote:{accepted:true,amountCents:13900,at:'2026-09-20T12:00:00Z'},payments:[{key:'receipt',amountCents:13900,at:'2026-09-21T13:00:00Z'}]}};
  const p=portal({evidence:evidence(['provider-contact-one','older-provider'],[paid])}),result=await reconcileHubBookings(p,{});
  expect(p).toHaveBeenCalledWith(expect.anything(),{command:'portal.evidence',contactProviderIds:['provider-contact-one','older-provider']});
  expect(result.portalEvidence).toMatchObject({complete:true,selectionComplete:true,reconciledContacts:2});
  expect(f.reconcileCustomerState).toHaveBeenCalledWith(expect.objectContaining({contactIds:['contact-one','older-contact'],portalRecords:[paid],portalCoverage:{complete:true,asOf:now.toISOString()}}));
  expect(f.syncPortalSchedule).not.toHaveBeenCalled();
 });
 it('rejects wrong, duplicate, or incomplete exact-contact response identity before ingesting its records',async()=>{
  for(const response of [evidence(['wrong-provider']),evidence(['provider-contact-one','provider-contact-one']),evidence(['provider-contact-one'],[{id:'foreign-job',highlevelContactId:'other',kind:'job',status:'paid'}])]){
   f.reconcileCustomerState.mockClear();const result=await reconcileHubBookings(portal({evidence:response}),{});
   expect(result.portalEvidence).toMatchObject({complete:false,error:'hub_evidence_unavailable_or_invalid'});
   const args=f.reconcileCustomerState.mock.calls[0]?.[0];expect(args.portalCoverage.complete).toBe(false);expect(args.portalRecords).toHaveLength(1);expect(args.portalRecords[0].id).toBe('visit-one');
  }
 });
 it('rejects malformed source dates, duplicate records, or unverified scalar types without retiring cached evidence',async()=>{
  const r={id:'paid',highlevelContactId:'provider-contact-one',kind:'job',status:'completed'};
  for(const records of [[{...r,paidAt:'not-a-date'}],[{...r,paidCents:'72500'}],[{...r,financials:[]}],[r,r]]){
   f.reconcileCustomerState.mockClear();await reconcileHubBookings(portal({evidence:evidence(['provider-contact-one'],records)}),{});
   const args=f.reconcileCustomerState.mock.calls[0]?.[0];expect(args.portalCoverage.complete).toBe(false);expect(args.portalRecords.every((x:Json)=>x.id!=='paid')).toBe(true);
  }
 });
 it('persists partial exact scan as incomplete and never asserts absence is authoritative',async()=>{
  const p=portal({evidence:evidence(['provider-contact-one'],[{id:'extra',highlevelContactId:'provider-contact-one',kind:'job',status:'accepted'}],false)});
  const result=await reconcileHubBookings(p,{});expect(result.portalEvidence.complete).toBe(false);
  const args=f.reconcileCustomerState.mock.calls[0]?.[0];expect(args.portalRecords.map((r:Json)=>r.id)).toEqual(['visit-one','extra']);expect(args.portalCoverage).toMatchObject({complete:false,error:'hub_evidence_coverage_incomplete'});
 });
 it('bounds exact contact selection at 500 and declares omitted coverage',async()=>{
  f.contacts=[...Array(501)].map((_,i)=>({contactId:`contact-${i}`,providerId:`provider-${i}`}));
  const p=vi.fn(async(_a:Actor,c:Command):Promise<Json>=>c.command==='calendar'?{authority:'employee_hub',items:[],coverage:{complete:true}}:c.command==='portal.evidence'?evidence(c.contactProviderIds,[]):{});
  const result=await reconcileHubBookings(p,{});expect(result.portalEvidence).toMatchObject({requestedContacts:500,reconciledContacts:500,selectionComplete:false,complete:true});
  expect(f.reconcileCustomerState.mock.calls[0]?.[0].contactIds).toHaveLength(500);expect(f.reconcileCustomerState.mock.calls[0]?.[0].portalCoverage.complete).toBe(true);
 });
 it('does not turn an empty or unmapped exact-contact scope into a bulk complete reconciliation',async()=>{
  f.contacts=[];await reconcileHubBookings(portal(),{});expect(f.reconcileCustomerState).not.toHaveBeenCalled();
  const saved=JSON.parse(String(f.writes[0]?.cursor));expect(saved.portalEvidence.unmappedCalendarContacts).toEqual(['provider-contact-one']);
 });
});
