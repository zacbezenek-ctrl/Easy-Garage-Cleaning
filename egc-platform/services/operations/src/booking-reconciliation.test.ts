import {describe,it,expect,vi} from "vitest";
import {diagnoseBookingReconciliation,reconcileBookingSnapshot,type BookingSnapshot,type BookingVisit,type BookingProviderEvent} from "./booking-reconciliation.js";
const visit=(changes:Partial<BookingVisit>={}):BookingVisit=>({id:"hub-visit",kind:"walkthrough",status:"scheduled",highlevelContactId:"contact",portalCustomerId:"customer",startAt:"2026-09-22T20:15:00Z",endAt:"2026-09-22T21:15:00Z",address:"Synthetic address",...changes});
const appointment=(changes:Partial<BookingProviderEvent>={}):BookingProviderEvent=>({id:"provider-event",contactProviderId:"contact",calendarId:"walkthrough",status:"confirmed",startAt:"2026-09-22T20:15:00Z",endAt:"2026-09-22T21:15:00Z",...changes});
const snapshot=(visits:BookingVisit[]=[visit()],appointments:BookingProviderEvent[]=[]):BookingSnapshot=>({visits,appointments,coverage:{portalComplete:true,providerComplete:true}});
describe("Hub-first booking reconciliation",()=>{
 it("saved Hub visit counts as scheduled while provider synchronization is pending",()=>{const result=diagnoseBookingReconciliation(snapshot());expect(result.authority).toBe("employee_hub");expect(result.findings[0]).toMatchObject({code:"hub_visit_provider_pending",portalVisitId:"hub-visit",automaticRepair:true});});
 it("verbal agreement stays positive evidence and requires a Hub write before any provider create",async()=>{const data={...snapshot([],[]),verbalBookings:[{eventId:"transcript-agreed",contactId:"internal",contactProviderId:"contact",kind:"walkthrough" as const,startAt:"2026-09-22T20:15:00Z",occurredAt:"2026-09-21T18:00:00Z",evidence:"Tuesday at 2:15 works; address supplied"}]};const syncVisit=vi.fn();const result=await reconcileBookingSnapshot(data,{syncVisit,dryRun:false});expect(result.findings[0]).toMatchObject({status:"verbally_booked_provider_pending",automaticRepair:false,evidenceIds:["transcript-agreed"]});expect(syncVisit).not.toHaveBeenCalled();});
 it("exact provider booking is linked instead of created again",()=>{const result=diagnoseBookingReconciliation(snapshot([visit()],[appointment()]));expect(result.findings).toHaveLength(1);expect(result.findings[0]).toMatchObject({code:"provider_booking_missing_hub_link",automaticRepair:true,status:"provider_booking_confirmed"});});
 it("provider booking without authoritative Hub visit is visible and cannot be auto-created",()=>{expect(diagnoseBookingReconciliation(snapshot([],[appointment()])).findings[0]).toMatchObject({code:"provider_booking_missing_hub_visit",automaticRepair:false});});
 it("fully synchronized records are explicitly reported",()=>{expect(diagnoseBookingReconciliation(snapshot([visit({highlevelAppointmentId:"provider-event"})],[appointment()])).findings[0]).toMatchObject({status:"fully_reconciled",automaticRepair:false});});
 it("native Hub records with exact provider identity can be verified and customer-linked through the durable callback",()=>{expect(diagnoseBookingReconciliation(snapshot([visit({portalCustomerId:null})])).findings[0]).toMatchObject({code:"hub_visit_provider_pending",automaticRepair:true});expect(diagnoseBookingReconciliation(snapshot([visit({portalCustomerId:null,highlevelAppointmentId:"provider-event"})],[appointment()])).findings[0]).toMatchObject({code:"hub_customer_link_missing",automaticRepair:true});expect(diagnoseBookingReconciliation(snapshot([visit({portalCustomerId:null,highlevelContactId:null})])).findings[0]?.automaticRepair).toBe(false);});
 it("never interprets a missing provider mirror as permission to recreate its known ID",()=>{expect(diagnoseBookingReconciliation(snapshot([visit({highlevelAppointmentId:"provider-event"})],[])).findings[0]).toMatchObject({code:"linked_provider_appointment_missing",automaticRepair:false});});
 it("Annette and James cancelled duplicate cleanup remains correct across calendars",()=>{const appointments=[appointment(),appointment({id:"cancelled-a",status:"cancelled"}),appointment({id:"cancelled-b",calendarId:"jobs",status:"cancelled"})];const result=diagnoseBookingReconciliation(snapshot([visit({highlevelAppointmentId:"provider-event"})],appointments));expect(result.findings).toHaveLength(1);expect(result.findings[0]?.status).toBe("fully_reconciled");});
 it("duplicate active provider or Hub records are surfaced with no automatic writes",()=>{const result=diagnoseBookingReconciliation(snapshot([visit()],[appointment(),appointment({id:"duplicate",calendarId:"jobs"})]));expect(result.findings[0]).toMatchObject({code:"duplicate_provider_appointments",automaticRepair:false,status:"duplicate_suspected"});expect(diagnoseBookingReconciliation(snapshot([visit(),visit({id:"duplicate-hub"})],[])).findings.every(f=>f.status==="duplicate_suspected")).toBe(true);});
 it("never revives a cancelled provider appointment because of a stale active Hub mirror",()=>{expect(diagnoseBookingReconciliation(snapshot([visit({highlevelAppointmentId:"provider-event"})],[appointment({status:"cancelled"})])).findings[0]).toMatchObject({code:"provider_cancelled_while_hub_active",automaticRepair:false});});
 it("propagates saved Hub cancellation/completion/noshow through exact known links",()=>{for(const status of ["cancelled","completed","noshow"]){const result=diagnoseBookingReconciliation(snapshot([visit({status,highlevelAppointmentId:"provider-event"})],[appointment()]));expect(result.findings[0]?.automaticRepair).toBe(true);}});
 it("terminal visits without provider records never create new appointments",()=>{for(const status of ["cancelled","noshow"]){expect(diagnoseBookingReconciliation(snapshot([visit({status})],[])).findings[0]).toMatchObject({code:"terminal_hub_visit_without_provider",automaticRepair:false});}});
 it("missing address and ambiguous/invalid times remain explicit exceptions",()=>{expect(diagnoseBookingReconciliation(snapshot([visit({address:""})])).findings[0]?.code).toBe("hub_address_missing");expect(diagnoseBookingReconciliation(snapshot([visit({startAt:null})])).findings[0]?.code).toBe("hub_schedule_time_invalid");});
 it("partial source coverage disables all automatic repairs",()=>{const s=snapshot();s.coverage.providerComplete=false;expect(diagnoseBookingReconciliation(s).findings.every(f=>!f.automaticRepair)).toBe(true);});
 it("bounded worker uses stable request identity and suppresses customer automations",async()=>{const syncVisit=vi.fn().mockResolvedValue({});const a=await reconcileBookingSnapshot(snapshot(),{syncVisit,dryRun:false});await reconcileBookingSnapshot(snapshot(),{syncVisit,dryRun:false});expect(a.results[0]?.status).toBe("reconciled");expect(syncVisit.mock.calls[0]).toEqual(syncVisit.mock.calls[1]);expect(syncVisit.mock.calls[0]?.[0]).toMatchObject({portalVisitId:"hub-visit",runAutomations:false});});
 it("worker defaults to dry run and redacts raw provider failures",async()=>{const syncVisit=vi.fn().mockRejectedValue(new Error("Bearer private-token"));expect((await reconcileBookingSnapshot(snapshot(),{syncVisit})).results[0]?.status).toBe("would_reconcile");expect(syncVisit).not.toHaveBeenCalled();const result=await reconcileBookingSnapshot(snapshot(),{syncVisit,dryRun:false});expect(result.results[0]).toMatchObject({status:"blocked",errorCode:"booking_reconciliation_unavailable"});expect(JSON.stringify(result)).not.toContain("private-token");});
});

describe('booking commitment review and cancellation safety',()=>{
 const commitment=(changes:Record<string,unknown>={})=>({eventId:'agreed-text',contactId:'local-contact',contactProviderId:'contact',kind:'walkthrough' as const,startAt:null,evidence:'Friday at 4 works; 100 Synthetic Street',occurredAt:'2026-10-01T18:00:00Z',timeMention:'Friday at 4',sourceReferences:[{sourceType:'message',sourceRecordId:'text-one',excerpt:'Friday at 4 works'}],...changes});
 it('never suppresses an undated agreement behind any old active visit or a null contact match',()=>{
  for(const v of [visit(),visit({highlevelContactId:null})]){
   const result=diagnoseBookingReconciliation({...snapshot([v]),verbalBookings:[commitment()]});
   expect(result.findings).toContainEqual(expect.objectContaining({code:'verbal_booking_missing_hub_visit',automaticRepair:false,commitment:expect.objectContaining({startAt:null,timeMention:'Friday at 4',reviewReasons:['schedule_time_unresolved']})}));
  }
 });
 it('surfaces review-needed commitments with exact source references without any scheduling write',async()=>{
  const syncVisit=vi.fn(),result=await reconcileBookingSnapshot({...snapshot([],[]),verbalBookings:[commitment({humanReviewNeeded:true})]},{syncVisit,dryRun:false});
  expect(result.findings[0]).toMatchObject({code:'booking_commitment_requires_review',automaticRepair:false,commitment:{humanReviewNeeded:true,sourceReferences:[{sourceType:'message',sourceRecordId:'text-one',excerpt:'Friday at 4 works'}]}});expect(syncVisit).not.toHaveBeenCalled();
 });
 it('keeps generic agreed times untyped and folds them into a same-source typed commitment',()=>{
  const typed=commitment(),generic=commitment({eventId:'agreed-time',kind:null});
  expect(diagnoseBookingReconciliation({...snapshot([],[]),verbalBookings:[generic]}).findings[0]).toMatchObject({code:'booking_commitment_requires_review',commitment:{kind:null}});
  expect(diagnoseBookingReconciliation({...snapshot([],[]),verbalBookings:[generic,typed]}).findings).toHaveLength(1);
 });
 it('later cancellation makes an old commitment review-needed, without hiding an independent exact occurrence',()=>{
  const result=diagnoseBookingReconciliation({...snapshot([],[]),verbalBookings:[commitment({occurrenceId:'visit-one'}),commitment({eventId:'independent',occurrenceId:'visit-two'})],commitmentOutcomes:[{contactId:'local-contact',occurrenceId:'visit-one',eventType:'appointment_cancelled',occurredAt:'2026-10-02T12:00:00Z'}]});
  expect(result.findings[0]).toMatchObject({code:'booking_commitment_requires_review',commitment:{reviewReasons:expect.arrayContaining(['later_terminal_evidence_requires_review'])}});expect(result.findings[1]?.code).toBe('verbal_booking_missing_hub_visit');
 });
 it('does not automatically recreate an unlinked cancelled/no-show provider appointment',async()=>{
  for(const status of ['cancelled','noshow']){
   const syncVisit=vi.fn(),result=await reconcileBookingSnapshot(snapshot([visit()],[appointment({status})]),{syncVisit,dryRun:false});
   expect(result.findings[0]).toMatchObject({code:'unlinked_terminal_provider_appointment',automaticRepair:false});expect(syncVisit).not.toHaveBeenCalled();
  }
 });
 it('does not mirror unknown or draft Hub states as confirmed appointments',()=>{
  for(const status of ['draft','unknown','invalid','deleted'])expect(diagnoseBookingReconciliation(snapshot([visit({status})])).findings[0]).toMatchObject({code:'hub_visit_status_unresolved',automaticRepair:false});
 });
 it('uses changed customer and calendar in durable request identity',async()=>{
  const syncVisit=vi.fn();await reconcileBookingSnapshot(snapshot(),{syncVisit,dryRun:false});await reconcileBookingSnapshot(snapshot([visit({highlevelContactId:'corrected-contact',highlevelCalendarId:'job-calendar',sourceRevision:'revision-2'})]),{syncVisit,dryRun:false});expect(syncVisit.mock.calls[0]?.[0].requestId).not.toBe(syncVisit.mock.calls[1]?.[0].requestId);
 });
 it('does not interpret date-only, invalid calendar days, or timezone-less evidence as exact booking time',()=>{
  for(const startAt of ['2026-10-02','2026-10-02T16:00:00','2026-02-30T16:00:00Z']){
   const result=diagnoseBookingReconciliation({...snapshot([],[]),verbalBookings:[commitment({startAt})]});
   expect(result.findings[0]?.commitment).toMatchObject({startAt:null,reviewReasons:['schedule_time_unresolved']});
  }
 });

});
