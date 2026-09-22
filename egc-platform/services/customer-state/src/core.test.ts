import { describe,it,expect } from "vitest";
import { assertionEvents,assertionReconciled,buildCanonicalEvents,buildReport,captureOriginalAttribution,canonicalEventId,exclusionReasons,extractEvidence,projectCustomer,validateUserConfirmedOutcome,paginateEventEvidence,type SourceRecord,type OperationalAssertion,type EvidenceEvent } from "./core.js";
import { recordsFromSnapshot,usableTranscriptText } from "./sources.js";
import { validateExtractedEvent } from "./extractor.js";
const at="2026-09-21T18:00:00.000Z",contactId="contact-1",leadId="lead-1";
const source=(text:string,patch:Partial<SourceRecord>={}):SourceRecord=>({sourceType:"message",sourceRecordId:"message-1",contactId,leadId,occurredAt:at,text,direction:"inbound",actorType:"customer",...patch});
const ev=(eventType:EvidenceEvent["eventType"],patch:Partial<EvidenceEvent>={}):EvidenceEvent=>({eventType,confidence:1,supportingText:`Evidence of ${eventType}`,humanReviewNeeded:false,nextAction:null,...patch});
const projection=(records:SourceRecord[],patch:Partial<Parameters<typeof projectCustomer>[0]>={})=>projectCustomer({contactId,leadId,customerName:"Customer",leadCreatedAt:"2026-09-16T12:00:00.000Z",events:buildCanonicalEvents(records),...patch});
const assertion=(patch:Partial<OperationalAssertion>={}):OperationalAssertion=>({id:"assertion-1",contactId,field:"job_sold",value:true,exactText:"Annette closed and revenue collected.",sourceReference:"conversation:user-message",actorId:"zac",assertedAt:at,occurredAt:at,status:"pending_reconciliation",...patch});

describe("conversation evidence",()=>{
  it("extracts explicit customer walkthrough agreement from transcript",()=>{
    const transcript=source("Agent: I can do the walkthrough Tuesday at 2:15.\nCustomer: Tuesday at 2:15 works. My address is 100 Main Street.",{sourceType:"call_transcript",direction:"outbound",actorType:"human"});
    const events=extractEvidence(transcript);expect(events.map(e=>e.eventType)).toContain("walkthrough_verbally_booked");expect(events.map(e=>e.eventType)).toContain("two_way_contact");
    expect(projection([transcript]).state).toBe("WALKTHROUGH_VERBALLY_BOOKED");
  });
  it("keeps video commitment distinct from media receipt",()=>{
    const s=source("Customer: I'll send you a video of my garage.",{sourceType:"call_transcript"});
    expect(extractEvidence(s).map(e=>e.eventType)).toContain("video_quote_customer_agreed");expect(extractEvidence(s).map(e=>e.eventType)).not.toContain("video_quote_received");
    expect(projection([s]).videoQuoteStage).toBe("customer_agreed");
  });
  it("combines SMS agreed time and address with prior walkthrough proposal",()=>{
    const prior=source("For your walkthrough, Tuesday at 2:15?",{sourceRecordId:"proposal",occurredAt:"2026-09-21T17:00:00.000Z",direction:"outbound",actorType:"human"});
    const s=source("Tuesday at 2:15 works. 1450 Oak Street.");
    expect(extractEvidence(s,[prior]).map(e=>e.eventType)).toContain("walkthrough_verbally_booked");
  });
  it("does not book a proposed time or a conditional customer agreement",()=>{
    const proposal=source("Would Tuesday at 2:15 work for the walkthrough?",{direction:"outbound",actorType:"human"});
    const maybe=source("If the price is okay, Tuesday at 2:15 works for a walkthrough.");
    for(const s of [proposal,maybe])expect(extractEvidence(s).map(e=>e.eventType)).not.toContain("walkthrough_verbally_booked");
  });
  it("price explicitly accepted is high intent without pretending job sold",()=>{
    const p=projection([source("The price range is fine with me.")]);expect(p.intentStage).toBe("high_intent");expect(p.state).toBe("PRICE_EXPECTATION_ACCEPTED");
  });
  it("video attachment advances received only in quote context",()=>{
    const prior=source("Please send a video for the quote.",{sourceRecordId:"request",occurredAt:"2026-09-21T17:00:00.000Z",direction:"outbound",actorType:"human"});
    const media=source("Here you go",{raw:{attachments:[{contentType:"video/mp4",url:"https://example.test/video"}]}});
    expect(extractEvidence(media,[prior]).map(e=>e.eventType)).toContain("video_quote_received");expect(extractEvidence(media,[]).map(e=>e.eventType)).not.toContain("video_quote_received");
  });
  it("accepted concrete quote supports sold even before CRM catchup",()=>{
    const quote=source("The quote is $450 for the removal.",{sourceRecordId:"quote",occurredAt:"2026-09-21T17:00:00.000Z",direction:"outbound",actorType:"human"});
    const accepted=source("I accept the quote. Go ahead.");const events=extractEvidence(accepted,[quote]);expect(events.map(e=>e.eventType)).toContain("job_sold");
    expect(events.find(e=>e.eventType==="job_sold")?.valueCents).toBe(45000);
  });
  it("completed call status alone never means two way",()=>{
    expect(extractEvidence(source("",{sourceType:"call",direction:"outbound",actorType:"human",raw:{status:"completed",meta:{call:{status:"completed",duration:200}}}})).map(e=>e.eventType)).toEqual(["human_outreach"]);
  });
  it("screening and voicemail do not create sales/customer evidence",()=>{
    const transcript=source("Hi. If you record your name and reason for calling, I'll see if this person is available. This person is not available. Hey Kimberly, this is Tyler. Please call me for a walkthrough Tuesday at 2:15.",{sourceType:"call_transcript",direction:"outbound",actorType:"human"});
    expect(extractEvidence(transcript).map(e=>e.eventType)).toEqual(["human_outreach"]);
  });
  it("automation requests are not video quote sales opportunities",()=>{
    expect(extractEvidence(source("Send photos for your junk removal quote",{direction:"outbound",actorType:"automation"})).map(e=>e.eventType)).not.toContain("video_quote_requested");
  });
  it("semantic output must quote its own source and verify customer commitment",()=>{
    const s=source("Tuesday at 2:15 works.");
    expect(validateExtractedEvent({eventType:"walkthrough_verbally_booked",supportingText:"Totally fabricated",confidence:1,customerCommitmentVerified:true},s)).toBeNull();
    const event=validateExtractedEvent({eventType:"walkthrough_verbally_booked",supportingText:s.text,confidence:.99,customerCommitmentVerified:false},s);expect(event?.humanReviewNeeded).toBe(true);
  });
  it("semantic extraction cannot fabricate collected money from a conversation",()=>{
    expect(validateExtractedEvent({eventType:"revenue_collected",supportingText:"I will pay $450",confidence:1,customerCommitmentVerified:true},source("I will pay $450"))).toBeNull();
  });
  it("retrospective completed visit advances truth without fabricating its time",()=>{
    const s=source("Thanks for coming over for the walkthrough yesterday.");
    const e=validateExtractedEvent({eventType:"walkthrough_completed",supportingText:s.text,confidence:.95,customerCommitmentVerified:true,humanReviewNeeded:false},s);
    expect(e?.humanReviewNeeded).toBe(false);expect(e?.details?.occurredAtVerified).toBe(false);
  });
  it("bare revised written price links to the immediately accepted quote, not an earlier ballpark",()=>{
    const quote=source("We have a truck there on September 27th. If you book that day I can come down to 139",{sourceRecordId:"quote-revision",occurredAt:"2026-09-21T17:00:00.000Z",direction:"outbound",actorType:"human"});
    const accepted=source("We can do that");const events=extractEvidence(accepted,[quote]);expect(events.find(e=>e.eventType==="job_sold")?.valueCents).toBe(13900);
    expect(extractEvidence(source("That works"),[source("Would 3:30 work?",{sourceRecordId:"time",direction:"outbound",actorType:"human",occurredAt:"2026-09-21T17:00:00.000Z"})]).some(e=>e.eventType==="job_sold")).toBe(false);
  });
  it("body-empty inbound quote media is received evidence",()=>{
    const prior=source("Please send a photo for the quote.",{sourceRecordId:"request",occurredAt:"2026-09-21T17:00:00.000Z",direction:"outbound",actorType:"human"});
    expect(extractEvidence(source("",{raw:{attachments:["https://example.test/customer.jpg"]}}),[prior]).some(e=>e.eventType==="video_quote_received")).toBe(true);
  });
});

describe("durable ledger and operational truth",()=>{
  it("requires exact assertion semantics rather than JavaScript truthiness",()=>{
    for(const value of [false,"false","true",0,1,null,{},[]])expect(()=>validateUserConfirmedOutcome({field:"job_sold",value})).toThrow();
    expect(validateUserConfirmedOutcome({field:"job_sold",value:true}).value).toBe(true);
    expect(()=>validateUserConfirmedOutcome({field:"state",value:"something good"})).toThrow();
  });
  it("money-field assertions derive verified cents and reject conflicting or invalid amounts",()=>{
    expect(validateUserConfirmedOutcome({field:"collected_revenue_cents",value:72500})).toEqual({field:"collected_revenue_cents",value:72500,valueCents:72500,currency:"USD"});
    for(const value of [-1,7.2,"72500",true,Infinity,Number.MAX_SAFE_INTEGER])expect(()=>validateUserConfirmedOutcome({field:"sold_revenue_cents",value})).toThrow();
    expect(()=>validateUserConfirmedOutcome({field:"sold_revenue_cents",value:72500,valueCents:65000})).toThrow("asserted_money_value_conflict");
    const events=assertionEvents(assertion({field:"sold_revenue_cents",value:72500}));expect(events[0]?.valueCents).toBe(72500);expect(events[0]?.valueVerified).toBe(true);
  });
  it("collapses mirrored events across sources with a deterministic identity",()=>{
    const a=source("",{sourceType:"opportunity",events:[ev("job_sold")]}),b=source("",{sourceType:"portal_job",sourceRecordId:"portal-1",events:[ev("job_sold")]});
    const events=buildCanonicalEvents([a,b]);expect(events).toHaveLength(1);expect(events[0]?.evidence).toHaveLength(2);expect(buildCanonicalEvents([b,a])[0]?.eventId).toBe(events[0]?.eventId);
    expect(canonicalEventId(contactId,leadId,"job_sold","changed-id")).toBe(events[0]?.eventId);
  });
  it("does not collapse separate outreach attempts",()=>{
    const events=buildCanonicalEvents([source("a",{sourceRecordId:"a",events:[ev("human_outreach")]}),source("b",{sourceRecordId:"b",events:[ev("human_outreach")]})]);expect(events).toHaveLength(2);
  });
  it("user confirmed sale overrides stale provider state and reconciles without duplicate",()=>{
    const a=assertion(),user=source(a.exactText,{sourceType:"user_confirmed",sourceRecordId:a.id,events:assertionEvents(a)});
    expect(projection([user],{assertions:[a]}).state).toBe("JOB_SOLD");expect(projection([user],{assertions:[a]}).discrepancies.some(d=>d.code==="user_confirmed_awaiting_backend")).toBe(true);
    const provider=source("won",{sourceType:"opportunity",sourceRecordId:"won",events:[ev("job_sold")]});
    expect(assertionReconciled(a,buildCanonicalEvents([provider]))).toBe(true);expect(buildCanonicalEvents([provider,user])).toHaveLength(1);
  });
  it("user-confirmed negative walkthrough is not an unresolved positive prospect",()=>{
    const a=assertion({field:"walkthrough_outcome",value:"negative",exactText:"Katrina walkthrough went badly"});const booked=source("booked",{events:[ev("walkthrough_booked")]});
    const p=projection([booked,source(a.exactText,{sourceType:"user_confirmed",events:assertionEvents(a)})],{assertions:[a]});expect(p.pipelineDisposition).toBe("negative_outcome");expect(p.intentStage).toBe("inactive");expect(p.state).not.toBe("LOST");
  });
  it("retains original attribution after provider source changes",()=>{
    const original=captureOriginalAttribution({source:"Facebook",raw:{attributionSource:{source:"facebook",campaignId:"12345",adId:"67890",utmContent:"Hook 1"}}});
    expect(captureOriginalAttribution({source:"Google",raw:{attributionSource:{source:"google"},lastAttributionSource:{adId:"new"}}},original)).toEqual(original);
  });
  it("excludes marked test/internal/vendor/DNC from Meta eligibility without guessing names",()=>{
    expect(exclusionReasons({tags:["egc-test"]})).toContain("test_internal_or_vendor");expect(exclusionReasons({raw:{isVendor:true}})).toContain("test_internal_or_vendor");expect(exclusionReasons({doNotContact:true})).toContain("do_not_contact");expect(exclusionReasons({raw:{name:"Testa"}})).toEqual([]);
  });
  it("unknown event time cannot overwrite earlier verified transcript time",()=>{
    const known=source("accepted",{events:[ev("job_sold")]}),unknown=source("won",{sourceType:"job",sourceRecordId:"job",occurredAt:"2026-09-20T10:00:00.000Z",events:[ev("job_sold",{details:{occurredAtVerified:false}})]});
    const [e]=buildCanonicalEvents([known,unknown]);expect(e?.occurredAt).toBe(at);expect(e?.details.occurredAtVerified).toBe(true);
  });
  it("weak earlier evidence cannot move a later verified milestone into the wrong period",()=>{
    const weak=source("maybe",{sourceRecordId:"earlier",occurredAt:"2026-09-20T10:00:00.000Z",events:[ev("walkthrough_booked",{confidence:.5,humanReviewNeeded:true})]}),verified=source("booked",{sourceType:"appointment",sourceRecordId:"provider",events:[ev("walkthrough_booked")]});
    expect(buildCanonicalEvents([weak,verified])[0]?.occurredAt).toBe(at);
  });
  it("surfaces exact follow-up commitments without displacing an existing booking",()=>{
    const followup=source("Call Tuesday",{events:[ev("follow_up_commitment",{nextAction:"Call Tuesday at 10 AM",details:{deadline:"2026-09-22T16:00:00Z"}})]});
    expect(projection([followup]).state).toBe("FOLLOW_UP_PENDING");expect(projection([followup]).nextRequiredAction).toBe("Call Tuesday at 10 AM");
    const booked=source("booked",{sourceRecordId:"booking",events:[ev("walkthrough_booked")]});expect(projection([booked,followup]).state).toBe("WALKTHROUGH_BOOKED");expect(projection([booked,followup]).followUpCommitment?.deadline).toBe("2026-09-22T16:00:00Z");
  });
  it("requires an explicit subsequent recommitment to reactivate a negative outcome and keeps DNC",()=>{
    const negative=source("declined",{sourceRecordId:"lost",events:[ev("lost")]}),attempt=source("followup",{sourceRecordId:"attempt",occurredAt:"2026-09-21T19:00:00.000Z",events:[ev("human_outreach")]}),rebooked=source("Please book Tuesday",{sourceRecordId:"rebooked",occurredAt:"2026-09-21T20:00:00.000Z",events:[ev("walkthrough_verbally_booked")]});
    expect(projection([negative,attempt]).state).toBe("LOST");expect(projection([negative,attempt,rebooked]).state).toBe("WALKTHROUGH_VERBALLY_BOOKED");
    expect(projection([negative,rebooked,source("Stop",{sourceRecordId:"dnc",events:[ev("do_not_contact")]})]).state).toBe("DO_NOT_CONTACT");
  });
});

describe("report denominators and value",()=>{
  it("separates today's activity from today's lead cohort",()=>{
    const records=[source("created",{occurredAt:"2026-09-16T12:00:00.000Z",events:[ev("lead_created")]}),source("booked",{events:[ev("walkthrough_booked")]})];
    const events=buildCanonicalEvents(records),customer=projection(records);
    const report=buildReport({events,customers:[customer],since:"2026-09-21T00:00:00Z",until:"2026-09-22T00:00:00Z"});
    expect(report.periodActivity.walkthroughsFormallyBooked?.count).toBe(1);expect(report.cohort.metrics.walkthroughsFormallyBooked?.numerator).toBe(0);expect(report.cohort.denominator).toBe(0);
  });
  it("never reports an unverified value as zero revenue",()=>{
    const records=[source("sold",{events:[ev("job_sold",{valueCents:50000,valueVerified:false,currency:"USD"})]})],events=buildCanonicalEvents(records);
    expect(events[0]?.valueCents).toBeNull();const r=buildReport({events,customers:[projection(records)],since:"2026-09-21T00:00:00Z",until:"2026-09-22T00:00:00Z"});expect(r.soldRevenue.valueCents).toBeNull();expect(r.soldRevenue.knownSubtotalCents).toBe(0);
  });
  it("unknown historic occurrence is cohort truth but not invented period activity",()=>{
    const a=assertion({occurredAtVerified:false}),records=[source(a.exactText,{sourceType:"user_confirmed",events:assertionEvents(a)})];
    const report=buildReport({events:buildCanonicalEvents(records),customers:[projection(records)],since:"2026-09-21T00:00:00Z",until:"2026-09-22T00:00:00Z",cohortSince:"2026-09-16T00:00:00Z"});
    expect(report.periodActivity.jobsSold?.count).toBe(0);expect(report.cohort.metrics.jobsSold?.numerator).toBe(1);expect(report.confirmedOutcomesWithUnknownTime).toHaveLength(1);
    expect(report.soldRevenue.valueCents).toBeNull();expect(report.soldRevenue.unknownOccurrenceCount).toBe(1);expect(report.soldRevenue.unknownValueCount).toBe(1);expect(report.soldRevenue.knownSubtotalCents).toBe(0);
  });
  it("bounded evidence pages retain every event and source ID without changing counts",()=>{
    const records=Array.from({length:7},(_,i)=>source(`Outreach ${i}`,{sourceRecordId:`attempt-${i}`,events:[ev('human_outreach')]}));records.push(source('accepted',{sourceRecordId:'sale',events:[ev('job_sold')]}));
    const events=buildCanonicalEvents(records),first=paginateEventEvidence(events,0,3),all=[];expect(first.events[0]?.eventType).toBe('job_sold');
    for(let offset=0;offset<events.length;offset+=3)all.push(...paginateEventEvidence(events,offset,3).events);
    expect(new Set(all.map(e=>e.eventId))).toEqual(new Set(events.map(e=>e.eventId)));expect(new Set(all.flatMap(e=>e.evidence.map(r=>r.sourceRecordId)))).toEqual(new Set(records.map(r=>r.sourceRecordId)));
  });
  it("bounds report excerpts while keeping original transcript evidence and its pointer",()=>{
    const text='Customer dialogue '.repeat(2000),record=source(text,{sourceType:'call_transcript',sourceRecordId:'long-call',sourcePointer:'call_transcripts:exact-record',events:[ev('human_outreach',{supportingText:text})]});
    const [event]=buildCanonicalEvents([record]);expect(event?.evidence[0]?.excerpt.length).toBe(180);expect(event?.evidence[0]?.excerptTruncated).toBe(true);expect(event?.evidence[0]?.sourcePointer).toBe('call_transcripts:exact-record');expect(record.events?.[0]?.supportingText).toBe(text);
  });
});

describe("source adapters",()=>{
  it("keeps provider errors/placeholders out of transcript coverage until recovery normalizes them",()=>{
    for(const text of ['No transcription found for this message.','Transcript pending','<html>Unauthorized</html>','{"error":"forbidden"}'])expect(usableTranscriptText(text)).toBe('');
    expect(usableTranscriptText('[00:01] Customer: Tuesday works.')).toBe('[00:01] Customer: Tuesday works.');
  });
  const base={contact:{id:contactId,providerId:"ghl-1"},lead:{id:leadId,createdAt:at}};
  it("never equates a local deposit/price field with money collected",()=>{
    const events=buildCanonicalEvents(recordsFromSnapshot({...base,jobs:[{id:"job",status:"scheduled",serviceType:"cleaning",priceCents:50000,depositCents:20000,createdAt:at,scheduledAt:at}]}));
    expect(events.some(e=>e.eventType==="revenue_collected")).toBe(false);expect(events.find(e=>e.eventType==="job_sold")?.valueCents).toBeNull();
  });
  it("a won CRM opportunity does not verify its estimated monetary value",()=>{
    const events=buildCanonicalEvents(recordsFromSnapshot({...base,opportunities:[{id:"opp",status:"won",wonAt:at,monetaryValueCents:250000}]}));
    expect(events.find(e=>e.eventType==="job_sold")?.valueCents).toBeNull();expect(events.find(e=>e.eventType==="job_sold")?.valueVerified).toBe(false);expect(events.find(e=>e.eventType==="job_sold")?.occurredAt).toBe(at);
  });
  it("deleted provider notes retire their interpretations without deleting source audit",()=>{
    const records=recordsFromSnapshot({...base,providerNotes:[{providerId:"note-1",raw:{body:"Customer accepted the quote",dateAdded:at,egcDeleted:true}}]});
    const note=records.find(r=>r.sourceType==="provider_note");expect(note?.events).toEqual([]);expect(note?.text).toBe("");expect(note?.sourcePointer).toBe("ghl_contact_note:note-1");
  });
  it("counts explicit accepted Hub quotes before a service is scheduled",()=>{
    for(const status of ["quote_sent","draft"]){const events=buildCanonicalEvents(recordsFromSnapshot({...base,portalRecords:[{id:"accepted-unscheduled",highlevelContactId:"ghl-1",kind:"job",status,createdAt:at,financials:{quote:{at,amountCents:45000,source:"customer_approval"}}}]}));expect(events.find(e=>e.eventType==="job_sold")?.valueCents).toBe(45000);expect(events.some(e=>e.eventType==="job_scheduled")).toBe(false);}
  });
  it("sums unique customer receipt keys, excludes unverified miscellaneous payments, keeps exact time",()=>{
    const events=buildCanonicalEvents(recordsFromSnapshot({...base,portalRecords:[{id:"portal-job",highlevelContactId:"ghl-1",kind:"job",status:"paid",createdAt:at,financials:{payments:[{key:"receipt-1",at,amountCents:15000},{key:"receipt-1",at,amountCents:15000},{key:"receipt-2",at,amountCents:35000}],staffPayments:[{key:"crew-pay",at,amountCents:10000}]}}]}));
    expect(events.filter(e=>e.eventType==="revenue_collected").reduce((sum,e)=>sum+(e.valueCents??0),0)).toBe(50000);
    expect(events.filter(e=>e.eventType==="revenue_collected")).toHaveLength(2);
  });
  it("counts exact verified staff-recorded customer receipts while disclosing incomplete history",()=>{
    const records=recordsFromSnapshot({...base,portalRecords:[{id:"portal-job",highlevelContactId:"ghl-1",kind:"job",status:"paid",createdAt:at,financials:{staffPayments:[{key:"cash-1",at,amountCents:72500,source:"staff_recorded_customer_receipt",verified:true,reference:"cash-confirmation-1",recordedBy:"owner",paymentMethod:"cash"}],exceptions:["payment_history_incomplete"]}}]}),events=buildCanonicalEvents(records);
    const receipt=events.find(e=>e.eventType==="revenue_collected");expect(receipt?.valueCents).toBe(72500);expect(receipt?.details.recordedBy).toBe("owner");
    const report=buildReport({events,customers:[projection(records)],since:"2026-09-21T00:00:00Z",until:"2026-09-22T00:00:00Z"});
    expect(report.collectedRevenue.knownSubtotalCents).toBe(72500);expect(report.collectedRevenue.valueCents).toBeNull();
  });
  it("does not double-count staff mirrors or send conflicting receipt amounts",()=>{
    const events=buildCanonicalEvents(recordsFromSnapshot({...base,portalRecords:[{id:"portal-job",highlevelContactId:"ghl-1",kind:"job",status:"paid",createdAt:at,financials:{payments:[{key:"pi_one",at,amountCents:15000},{key:"conflict",at,amountCents:20000},{key:"conflict",at,amountCents:30000}],staffPayments:[{key:"staff-one",at,amountCents:15000,source:"staff_recorded_customer_receipt",verified:true,reference:"pi_one",recordedBy:"owner",paymentMethod:"cash"}]}}]}));
    expect(events.filter(e=>e.eventType==="revenue_collected")).toHaveLength(1);expect(events.find(e=>e.eventType==="revenue_collected")?.valueCents).toBe(15000);
  });
  it("cancelled duplicate appointments are excluded and active mirror is counted once",()=>{
    const appointment={contactId,id:"appt-1",providerId:"provider-1",status:"confirmed",calendarId:"walk",appointmentCreatedAt:at,appointmentStartAt:at};
    const events=buildCanonicalEvents(recordsFromSnapshot({...base,walkthroughCalendarIds:["walk"],appointments:[appointment,{...appointment,id:"appt-2",providerId:"duplicate",status:"cancelled"}]}));expect(events.filter(e=>e.eventType==="walkthrough_booked")).toHaveLength(1);
  });
  it("a job linked to a walkthrough calendar is not a sold service job",()=>{
    const events=buildCanonicalEvents(recordsFromSnapshot({...base,walkthroughCalendarIds:["walk"],appointments:[{id:"appt",calendarId:"walk",status:"confirmed",appointmentCreatedAt:at,appointmentStartAt:at}],jobs:[{id:"job",serviceType:"Full Garage Transformation",status:"scheduled",appointmentId:"appt",createdAt:at,scheduledAt:at}]}));
    expect(events.some(e=>e.eventType==="job_sold")).toBe(false);
  });
  it("an explicit service calendar takes precedence over a stale walkthrough title",()=>{
    const events=buildCanonicalEvents(recordsFromSnapshot({...base,walkthroughCalendarIds:["walk"],jobCalendarIds:["service"],appointments:[{id:"appt",calendarId:"service",title:"Synthetic garage walkthrough",status:"confirmed",appointmentCreatedAt:at,appointmentStartAt:at}],jobs:[{id:"job",serviceType:"Full Garage Transformation",status:"scheduled",appointmentId:"appt",createdAt:at,scheduledAt:at}]}));
    expect(events.some(e=>e.eventType==="job_sold")).toBe(true);expect(events.some(e=>e.eventType==="walkthrough_booked")).toBe(false);
  });
  it("cash receipts stay in the period they actually occurred and mirrored receipt keys dedupe",()=>{
    const receipts=[{key:"one",at:"2026-09-20T12:00:00Z",amountCents:10000},{key:"two",at:"2026-09-21T12:00:00Z",amountCents:30000}];
    const portal={id:"p1",highlevelContactId:"ghl-1",kind:"job" as const,status:"paid",createdAt:at,financials:{payments:receipts}};
    const records=recordsFromSnapshot({...base,portalRecords:[portal,{...portal,id:"mirror"}]}),events=buildCanonicalEvents(records),customer=projection(records);
    const report=buildReport({events,customers:[customer],since:"2026-09-21T00:00:00Z",until:"2026-09-22T00:00:00Z"});
    expect(events.filter(e=>e.eventType==="revenue_collected")).toHaveLength(2);expect(report.collectedRevenue.valueCents).toBe(30000);
  });
});
