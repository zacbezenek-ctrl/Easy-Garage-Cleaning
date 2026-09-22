import { createHash } from "node:crypto";
import {occurrenceMetric,occurrenceMetricRows} from './occurrence-report.js';
import { EVENT_TYPES, OPERATIONAL_STATES, type CanonicalEvent, type CustomerEventType, type CustomerProjection, type EvidenceEvent, type EvidenceRef, type Json, type OperationalAssertion, type OperationalState, type SourceRecord } from "./types.js";
export * from "./types.js";
export const EXTRACTOR_VERSION = "customer-evidence-1";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const asRecord = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
export const validDate = (v: unknown): string | null => (v instanceof Date || typeof v === "string") && Number.isFinite(new Date(v).valueOf()) ? new Date(v).toISOString() : null;
const clean = (v: string) => v.replace(/[’‘]/g,"'").replace(/\s+/g," ").trim();
const money = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647;

/** Milestones are once per acquisition lead. Repeated communications are occurrences.
 * A provider mirror, later user assertion, or corrected transcript never makes a new sale.
 */
export function canonicalEventId(contactId: string, leadId: string | null | undefined, eventType: CustomerEventType, sourceRecordId?: string) {
  const recurring = ["human_outreach", "customer_response", "two_way_contact", "follow_up_commitment", "appointment_cancelled", "no_show", "address_supplied", "appointment_time_agreed", "price_expectation_given", "payment_discussed"].includes(eventType) || (eventType === "revenue_collected" && sourceRecordId?.startsWith("receipt:"));
  return `egcev_${hash(`egc:customer:${contactId}:lead:${leadId ?? "unknown"}:event:${eventType}${recurring ? `:record:${sourceRecordId ?? "unknown"}` : ""}`)}`;
}

/** Persist only original attribution, never latest contact acquisition fields. */
export function captureOriginalAttribution(input: { raw?: Json; source?: string | null; leadCreatedAt?: string }, existing?: Json | null): Json {
  if (existing) return existing;
  const raw = input.raw ?? {}, initial = asRecord(raw.attributionSource);
  const initialExists = Object.keys(initial).length > 0;
  const selected = initialExists ? initial : raw;
  const keys = ["source","medium","utmSource","utm_source","utmMedium","utm_medium","sessionSource","session_source","campaign","campaignId","campaign_id","campaignName","adId","ad_id","adName","adSetId","adsetId","adset_id","adSetName","creativeId","creative_id","hookId","bodyId","utmContent","utm_content","fbclid","fbc","fbp","_fbc","_fbp","url","landingPage","referrer","facebookLeadId","facebook_lead_id","fbLeadId","fb_lead_id","metaLeadId","meta_lead_id","leadgen_id"];
  const captured: Json = {};
  for (const key of keys) if (typeof selected[key] === "string" && selected[key]) captured[key] = selected[key];
  // Only root capture identifiers, never lastAttributionSource.
  for (const key of ["fbc","fbp","_fbc","_fbp","fbclid","facebookLeadId","facebook_lead_id","fbLeadId","metaLeadId","leadgen_id"]) if (!captured[key] && typeof raw[key] === "string") captured[key] = raw[key];
  return { ...captured, source: captured.source ?? captured.utmSource ?? captured.medium ?? input.source ?? null,
    attributionSource: captured, provenance: initialExists ? "provider_initial_attribution" : "first_observed_root_attribution",
    originalSourceUncertain: !initialExists, leadCreatedAt: input.leadCreatedAt ?? null };
}

export function exclusionReasons(input: { tags?: string[]; raw?: Json; source?: string | null; doNotContact?: boolean }) {
  const raw = input.raw ?? {}, tags = (input.tags ?? []).map(t=>t.toLowerCase());
  const reasons: string[] = [];
  if (tags.some(t=>["egc-test","test","test-lead","internal","egc-internal","vendor","supplier"].includes(t)) || ["isTest","is_test","isTestLead","is_test_lead","isInternal","isVendor"].some(k=>raw[k]===true) || input.source?.toLowerCase()==="egc synthetic routing validation") reasons.push("test_internal_or_vendor");
  if (input.doNotContact || raw.dnd === true || tags.some(t=>["dnc","do-not-contact","do not contact"].includes(t))) reasons.push("do_not_contact");
  return reasons;
}

export function isVoicemailOrScreening(text: string) {
  return /(?:please (?:leave|record) (?:your |a |an )?(?:message|name)|after the (?:tone|beep)|not available|couldn't get to your call|can(?:not|'t) come to the phone|see if this person is available|mailbox|call has been forwarded|leave me a message)/i.test(text);
}
const address = /\b\d{1,6}\s+(?:[a-z0-9]+[ .-]+){0,6}(?:street|st\b|avenue|ave\b|road|rd\b|drive|dr\b|lane|ln\b|court|ct\b|way\b|circle|cir\b|boulevard|blvd\b|place|pl\b|trail|terrace|parkway)/i;
const timeMention = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b.{0,40}\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|morning|afternoon|noon)|\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i;
const acceptance = /\b(?:works(?: for me| for us)?|sounds good|that(?:'s| is) (?:fine|great|good|okay|ok|acceptable)|(?:I|we)(?:'ll| will| can| would like to| want to) (?:do|take|book|schedule|send|accept)|let(?:'s| us) (?:do|book|schedule)|yes|agreed)\b/i;
const negative = /\b(?:not interested|no longer interested|don't (?:want|need)|do not (?:want|need)|decline|cancel(?:led|ed|ation)?|can't|cannot|won't|not (?:ready|sure)|maybe|if)\b/i;
const walkthroughContext = /walk\s*through|walkthrough|in.person (?:quote|estimate)|come (?:out|over|by)|stop (?:out|over|by)|take a look/i;
const videoContext = /video|photos?|pictures?/i;
const priceContext = /(?:\$\s*\d|\b\d[\d,]*\s*dollars?\b|\bprice range\b|\bquoted?\b|\bestimate\b|\bcost\b)/i;
function explicitQuoteCents(text:string):number|null {
  if(/(?:starts? at|typically|usually|normally|between|range|rough|ballpark|around|\bper\b|\/hr|\/hour|plus|additional|tax|discount|\d\s*[-–]\s*\$?\d)/i.test(text))return null;
  const monetary=[...text.matchAll(/(?:\$\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*\$)/g)].map(m=>Math.round(Number((m[1]??m[2])!.replace(/,/g,""))*100));
  // Spoken-style written revision: "I can come down to 139" has an explicit
  // monetary predicate. Dates and addresses alone never match this branch.
  const revised=text.match(/(?:come down to|(?:price|quote|total) (?:is|would be)|do (?:it|that|the (?:job|pickup)) for)\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
  if(monetary.length===1&&money(monetary[0]))return monetary[0]!;
  if(!monetary.length&&revised){const cents=Math.round(Number(revised[1]!.replace(/,/g,""))*100);if(money(cents))return cents;}
  return null;
}

/** Conservative local extraction, including source roles and nearby context. Anything
 * requiring dialogue interpretation is completed by the structured extractor or flagged.
 */
export function extractEvidence(record: SourceRecord, history: SourceRecord[] = []): EvidenceEvent[] {
  if (record.events) return record.events;
  const text = clean(record.text), events: EvidenceEvent[] = [];
  const before = history.filter(r=>r.sourceRecordId !== record.sourceRecordId && r.occurredAt <= record.occurredAt && new Date(record.occurredAt).valueOf()-new Date(r.occurredAt).valueOf() < 3*86_400_000).slice(-12);
  const prior = before.map(r=>clean(r.text)).join("\n");
  const add = (eventType: CustomerEventType, supportingText = record.text, confidence = .96, nextAction: string | null = null, details: Json = {}) => {
    if (!events.some(e=>e.eventType===eventType)) events.push({eventType, confidence, supportingText, humanReviewNeeded:false, nextAction, details});
  };
  if (["failed","undelivered","cancelled"].includes(String(record.raw?.status ?? "").toLowerCase())) return [];
  if ((record.sourceType === "call" || record.sourceType === "call_transcript" || record.sourceType === "message") && record.direction === "outbound" && record.actorType === "human") add("human_outreach",record.text || "Human outbound attempt; no customer-contact inference",1);
  const sms = record.sourceType === "message";
  const customer = sms && record.direction === "inbound" && record.actorType === "customer";
  const human = sms && record.direction === "outbound" && record.actorType === "human";
  const attachmentValues = Array.isArray(record.raw?.attachments) ? record.raw.attachments : [];
  const mediaAttachments = attachmentValues.filter(a=>typeof a === "string" ? /\.(?:jpe?g|png|heic|mov|mp4|webp)(?:[?#]|$)/i.test(a) : /^(?:image|video)\//.test(String(asRecord(a).contentType ?? asRecord(a).mimeType ?? "")));
  if(customer && (mediaAttachments.length>0||/^(?:image|video)\//.test(String(record.raw?.contentType??""))) && videoContext.test(`${prior}\n${text}`))add("video_quote_received",record.text || "Inbound quote media attachment",1,"Review the received media and prepare the quote",{attachments:attachmentValues});
  if(!text && !attachmentValues.length)return events;
  if (customer) {
    add("customer_response",record.text || "Customer inbound media attachment",1);
    const precedingHuman = before.some(r=>r.sourceType === "message" && r.direction === "outbound" && r.actorType === "human" && r.text.trim());
    if(precedingHuman) add("two_way_contact",record.text,1);
  }
  if (human && before.some(r=>r.sourceType === "message" && r.direction === "inbound" && r.actorType === "customer" && r.text.trim())) add("two_way_contact",record.text,1);
  if(record.sourceType === "call_transcript" && isVoicemailOrScreening(text)) return events;
  // Explicit customer speaker labels are safe for deterministic rules; unlabelled
  // provider transcripts need semantic speaker/commitment extraction.
  const customerLines = record.sourceType === "call_transcript" ? record.text.split(/\n/).filter(l=>/^(?:\d{1,2}:\d{2}:?\s*)?(?:customer|client|lead)\s*:/i.test(l)).join("\n") : "";
  const subject = customer ? text : clean(customerLines);
  if(customerLines) {
    add("customer_response",customerLines);
    if(/(?:agent|representative|zac|zach|tyler|employee)\s*:/i.test(record.text)) add("two_way_contact",customerLines);
  }
  const context = `${prior}\n${text}`;
  if(subject) {
    if(/\b(?:stop|unsubscribe)\b/i.test(subject) && subject.length < 35 || /(?:do not|don't|stop) (?:contact|text|call)(?:ing)? (?:me|us)/i.test(subject)) add("do_not_contact", customerLines || record.text,1,"Honor do-not-contact preferences");
    if(/(?:not|no longer) interested|(?:don't|do not) (?:want|need) (?:the |your |this )?(?:service|work|quote)|declin(?:e|ing) (?:the |your )?(?:quote|estimate)/i.test(subject)) add("lost",customerLines || record.text,.99,"Close the active sales follow-up");
    if(address.test(subject)) add("address_supplied",customerLines || record.text,.99);
    if(timeMention.test(subject) && acceptance.test(subject) && !negative.test(subject)) {
      add("appointment_time_agreed",customerLines || record.text,.98,"Confirm the agreed appointment in EGC Portal",{timeMention:subject.match(timeMention)?.[0] ?? null});
      if(walkthroughContext.test(context) || address.test(context)) add("walkthrough_verbally_booked",customerLines || record.text,.97,"Create or reconcile this walkthrough through EGC Portal",{timeMention:subject.match(timeMention)?.[0] ?? null});
    }
    if(!negative.test(subject) && /(?:price|range|cost|\$\s*\d).{0,45}(?:fine|acceptable|works|good|okay|ok)|(?:fine|acceptable|okay|ok).{0,20}(?:price|range|cost)/i.test(subject)) add("price_expectation_accepted",customerLines || record.text,.97,"Complete the agreed quote or scheduling step");
    if(!negative.test(subject) && /(?:I|we)(?:'ll| will| can| am going to| are going to).{0,35}(?:send|text|take|record|do|get).{0,40}(?:video|photos?|pictures?)/i.test(subject)) add("video_quote_customer_agreed",customerLines || record.text,.97,"Wait for the promised media; follow up at the agreed deadline");
    const precedingHuman=before.filter(r=>r.sourceType==="message"&&r.direction==="outbound"&&r.actorType==="human").at(-1);
    const exactPreviousQuote=precedingHuman&&explicitQuoteCents(precedingHuman.text)!==null;
    if(!negative.test(subject) && ((/(?:I|we) (?:accept|approve)(?:ed)? (?:the |your )?(?:quote|estimate)|(?:go ahead|let's do it|book (?:it|the job))/.test(subject.toLowerCase()) && priceContext.test(context)) || (exactPreviousQuote&&/^(?:we can do that|I can do that|that works(?: for (?:me|us))?|let's do that)[.! ]*$/i.test(subject)))) {
      add("job_verbally_accepted",customerLines || record.text,.98,"Reconcile accepted work with EGC Portal and the CRM");
      add("job_sold",customerLines || record.text,.97,"Record the accepted work and verified price in EGC Portal");
    }
    if(/(?:need to|want to|please) cancel.{0,40}(?:appointment|walkthrough|visit)|(?:appointment|walkthrough|visit).{0,30}cancel/i.test(subject)) add("appointment_cancelled",customerLines || record.text,.98,"Reconcile cancellation in EGC Portal");
  }
  if(human && /(?:got you|have you|you're|you are) (?:all )?(?:booked|scheduled|on (?:the|our) calendar)/i.test(text) && walkthroughContext.test(context) && !negative.test(text)) add("walkthrough_verbally_booked",record.text,.96,"Verify EGC Portal appointment and provider sync");
  if(human && /(?:send|text|upload).{0,45}(?:video|photos?|pictures?)/i.test(text)) add("video_quote_requested",record.text,.98,"Await customer media for the quote");
  // A scoped pickup request followed by two explicit scheduling prices is a
  // delivered quote, but neither option is a verified accepted sale value.
  const scopedPickup=before.filter(r=>r.sourceType==='message'&&r.direction==='inbound'&&r.actorType==='customer'&&/(?:pick\s*up|pickup|remove|haul|take away|charge to take)/i.test(r.text)&&/(?:bed|frame|mattress|couch|sofa|dresser|refrigerator|fridge|appliance|table|chairs?|piano|treadmill|furniture)/i.test(r.text)).at(-1);
  if(human&&scopedPickup&&/normally.{0,25}(?:at|charge|cost).{0,8}\$?\s*\d[\d,]*(?:\.\d{1,2})?\s+for that.{0,25}but if you book.{0,100}(?:at|charge|cost).{0,8}\$\s*\d/i.test(text))add('quote_delivered',record.text,.98,'Ask which scheduling price option the customer wants',{verifiedScopedQuote:true,conditionalPriceOptions:true,scopeSourceRecordId:scopedPickup.sourceRecordId});
  if(human && /(?:quote|estimate|total|price).{0,35}\$\s*\d|\$\s*\d[\d,.]*.{0,50}(?:for (?:the|your)|all.in|total)|\d\s*\$.{0,30}(?:for|pickup)|come down to\s*\d/i.test(text) && !/(?:starts? at|typically|usually|between|range|rough|ballpark)/i.test(text)) {
    add("quote_delivered",record.text,.95,"Confirm the customer's decision on the delivered quote");
    const cents=explicitQuoteCents(text);
    if(cents!==null){const quote=events.find(e=>e.eventType==="quote_delivered")!;quote.valueCents=cents;quote.valueVerified=true;quote.currency="USD";}
  }
  const sold=events.find(e=>e.eventType==="job_sold");
  if(sold){const latestQuote=[...before].reverse().find(r=>r.sourceType==="message"&&r.direction==="outbound"&&r.actorType==="human"&&explicitQuoteCents(r.text)!==null);if(latestQuote){const {events:_cached,...quoteSource}=latestQuote;const quoted=extractEvidence(quoteSource,[]).find(e=>e.eventType==="quote_delivered"&&e.valueVerified);if(quoted){sold.valueCents=quoted.valueCents!;sold.currency=quoted.currency!;sold.valueVerified=true;sold.details={...sold.details,quoteSourceRecordId:latestQuote.sourceRecordId,quoteEvidence:quoted.supportingText};}}}
  return events;
}

export function validateUserConfirmedOutcome(input:{field:string;value:unknown;valueCents?:number|null;currency?:string|null}) {
  if(typeof input.field!=="string"||!input.field.trim())throw new Error("unsupported_asserted_field_or_value");
  const field=input.field.trim().toLowerCase(),value=input.value;
  let valueCents=input.valueCents??null;
  if(valueCents!==null&&!money(valueCents))throw new Error("invalid_verified_value");
  if(["sold_revenue_cents","collected_revenue_cents"].includes(field)) {
    if(!money(value))throw new Error("asserted_money_requires_safe_integer_cents");
    if(valueCents!==null&&valueCents!==value)throw new Error("asserted_money_value_conflict");
    valueCents=value as number;
  } else if(["operational_state","state"].includes(field)) {
    if(typeof value!=="string"||!(OPERATIONAL_STATES as readonly string[]).includes(value))throw new Error("unsupported_asserted_state");
  } else if(["walkthrough_outcome","walkthrough.outcome"].includes(field)) {
    if(!["negative","went_badly","unsuccessful"].includes(String(value)))throw new Error("unsupported_walkthrough_outcome");
  } else if((EVENT_TYPES as readonly string[]).includes(field)) {
    if(value!==true)throw new Error("asserted_milestone_requires_true_boolean");
  } else throw new Error("unsupported_asserted_field_or_value");
  const currency=valueCents===null?null:input.currency??"USD";
  if(currency!==null&&!/^[A-Z]{3}$/.test(currency))throw new Error("invalid_currency");
  return {field,value,valueCents,currency};
}

export function assertionEvents(assertion: OperationalAssertion): EvidenceEvent[] {
  if(assertion.status === "superseded") return [];
  const validated=validateUserConfirmedOutcome(assertion),field=validated.field;
  let types: CustomerEventType[] = [];
  if((EVENT_TYPES as readonly string[]).includes(field)) types=[field as CustomerEventType];
  if(["walkthrough_outcome","walkthrough.outcome"].includes(field) && ["negative","went_badly","unsuccessful"].includes(String(assertion.value))) types=["walkthrough_completed","walkthrough_negative_outcome"];
  if(["operational_state","state"].includes(field)) {
    const mapping: Record<OperationalState,CustomerEventType> = {NEW_LEAD:"lead_created",OUTREACH_ATTEMPTED:"human_outreach",TWO_WAY_CONTACT:"two_way_contact",QUALIFIED:"qualified",PRICE_EXPECTATION_ACCEPTED:"price_expectation_accepted",VIDEO_QUOTE_PENDING_CUSTOMER:"video_quote_customer_agreed",VIDEO_QUOTE_RECEIVED:"video_quote_received",VIDEO_QUOTE_IN_PROGRESS:"video_quote_in_progress",QUOTE_DELIVERED:"quote_delivered",WALKTHROUGH_VERBALLY_BOOKED:"walkthrough_verbally_booked",WALKTHROUGH_BOOKED:"walkthrough_booked",WALKTHROUGH_COMPLETED:"walkthrough_completed",FOLLOW_UP_PENDING:"follow_up_commitment",CUSTOMER_DECIDING:"customer_deciding",JOB_VERBALLY_ACCEPTED:"job_verbally_accepted",JOB_SOLD:"job_sold",JOB_SCHEDULED:"job_scheduled",JOB_COMPLETED:"job_completed",CASH_COLLECTED:"revenue_collected",LOST:"lost",DO_NOT_CONTACT:"do_not_contact"};
    const event = mapping[String(assertion.value) as OperationalState];
    if(event) types=[event];
  }
  if(["sold_revenue_cents","collected_revenue_cents"].includes(field)) types=[field === "sold_revenue_cents" ? "job_sold" : "revenue_collected"];
  return types.map(eventType=>({eventType,confidence:1,supportingText:assertion.exactText,humanReviewNeeded:false,nextAction:assertion.status === "reconciled" ? null : "Reconcile the user-confirmed outcome with backend records",occurredAt:assertion.occurredAt,
    details:{assertionId:assertion.id,assertedField:assertion.field,assertedValue:assertion.value,sourceReference:assertion.sourceReference,assertedAt:assertion.assertedAt,occurredAtVerified:assertion.occurredAtVerified ?? true},
    ...(validated.valueCents!==null ? {valueCents:validated.valueCents,currency:validated.currency!,valueVerified:true} : {})}));
}

export function buildCanonicalEvents(records: SourceRecord[], attribution: Json = {}): CanonicalEvent[] {
  const events = new Map<string,CanonicalEvent>();
  const sorted = [...records].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt) || a.sourceRecordId.localeCompare(b.sourceRecordId));
  for(const record of sorted) for(const event of record.events ?? extractEvidence(record,sorted)) {
    if(!(EVENT_TYPES as readonly string[]).includes(event.eventType) || !validDate(event.occurredAt ?? record.occurredAt)) continue;
    const occurrence=typeof event.details?.paymentReceiptKey === "string"?`receipt:${event.details.paymentReceiptKey}`:record.sourceRecordId;
    const occurrenceId=typeof event.details?.occurrenceId==='string'?event.details.occurrenceId:null;
    const retainedId=typeof event.details?.canonicalEventId==='string'&&/^egcev_[a-f0-9]{64}$/.test(event.details.canonicalEventId)?event.details.canonicalEventId:null;
    const eventId = retainedId??(occurrenceId&&!event.details?.paymentReceiptKey?`egcev_${hash(`egc:occurrence:${occurrenceId}:event:${event.eventType}`)}`:canonicalEventId(record.contactId,record.leadId,event.eventType,occurrence));
    const occurredAt = validDate(event.occurredAt ?? record.occurredAt)!;
    const excerptLimit=event.eventType==='human_outreach'?180:1600;
    const evidence: EvidenceRef = {sourceType:record.sourceType,sourceRecordId:record.sourceRecordId,occurredAt,excerpt:event.supportingText.slice(0,excerptLimit),...(event.supportingText.length>excerptLimit?{excerptTruncated:true}:{}),confidence:event.confidence,humanReviewNeeded:event.humanReviewNeeded,sourcePointer:record.sourcePointer??`${record.sourceType}:${record.sourceRecordId}`};
    const previous = events.get(eventId), trusted = !event.humanReviewNeeded && event.confidence >= .85;
    const timeVerified=event.details?.occurredAtVerified!==false,previousTimeVerified=previous?.details.occurredAtVerified!==false;
    const previousTrusted=Boolean(previous&&!previous.humanReviewNeeded&&previous.confidence>=.85),timeRank=Number(trusted)*2+Number(timeVerified),previousTimeRank=Number(previousTrusted)*2+Number(previousTimeVerified);
    const selectPreviousTime=Boolean(previous&&(previousTimeRank>timeRank||(previousTimeRank===timeRank&&previous.occurredAt<occurredAt)));
    const selectedTime=selectPreviousTime?previous!.occurredAt:occurredAt,selectedTimeVerified=selectPreviousTime?previousTimeVerified:timeVerified;
    const verifiedValue = trusted && event.valueVerified === true && money(event.valueCents) && /^[A-Z]{3}$/.test(event.currency ?? "");
    const replacement = !previous || (record.sourceType === "user_confirmed" && previous.source !== "user_confirmed") || (previous.humanReviewNeeded && trusted) || (previous.source !== "user_confirmed" && event.confidence > previous.confidence);
    events.set(eventId,{
      eventId,contactId:record.contactId,leadId:record.leadId ?? null,eventType:event.eventType,...(occurrenceId?{occurrenceId}:{}),
      opportunityId:record.opportunityId ?? previous?.opportunityId ?? null,appointmentId:record.appointmentId ?? previous?.appointmentId ?? null,jobId:record.jobId ?? previous?.jobId ?? null,
      occurredAt:selectedTime,
      source:replacement?record.sourceType:previous!.source,confidence:Math.max(event.confidence,previous?.confidence ?? 0),
      humanReviewNeeded: previous ? previous.humanReviewNeeded && event.humanReviewNeeded : event.humanReviewNeeded,
      evidence:[...(previous?.evidence ?? []),evidence].filter((e,i,a)=>a.findIndex(x=>x.sourceType===e.sourceType && x.sourceRecordId===e.sourceRecordId && x.excerpt===e.excerpt)===i),
      nextAction:replacement?event.nextAction:previous!.nextAction,details:{...(previous?.details ?? {}),...(event.details ?? {}),occurredAtVerified:selectedTimeVerified},attribution,
      valueCents:verifiedValue ? event.valueCents! : previous?.valueCents ?? null,currency:verifiedValue?event.currency!:previous?.currency ?? null,valueVerified:verifiedValue || previous?.valueVerified === true,
      syncState:previous?.syncState ?? "pending"
    });
  }
  return [...events.values()].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
}

const stageMap: Partial<Record<CustomerEventType,OperationalState>> = {
  lead_created:"NEW_LEAD",human_outreach:"OUTREACH_ATTEMPTED",customer_response:"TWO_WAY_CONTACT",two_way_contact:"TWO_WAY_CONTACT",qualified:"QUALIFIED",price_expectation_accepted:"PRICE_EXPECTATION_ACCEPTED",
  video_quote_requested:"VIDEO_QUOTE_PENDING_CUSTOMER",video_quote_customer_agreed:"VIDEO_QUOTE_PENDING_CUSTOMER",video_quote_received:"VIDEO_QUOTE_RECEIVED",video_quote_in_progress:"VIDEO_QUOTE_IN_PROGRESS",quote_prepared:"VIDEO_QUOTE_IN_PROGRESS",quote_delivered:"QUOTE_DELIVERED",customer_deciding:"CUSTOMER_DECIDING",
  walkthrough_verbally_booked:"WALKTHROUGH_VERBALLY_BOOKED",walkthrough_booked:"WALKTHROUGH_BOOKED",walkthrough_showed:"WALKTHROUGH_COMPLETED",walkthrough_completed:"WALKTHROUGH_COMPLETED",
  job_verbally_accepted:"JOB_VERBALLY_ACCEPTED",job_sold:"JOB_SOLD",job_scheduled:"JOB_SCHEDULED",job_completed:"JOB_COMPLETED",revenue_collected:"CASH_COLLECTED"
};
const rank: Record<string,number> = {NEW_LEAD:0,OUTREACH_ATTEMPTED:1,TWO_WAY_CONTACT:2,QUALIFIED:3,PRICE_EXPECTATION_ACCEPTED:4,VIDEO_QUOTE_PENDING_CUSTOMER:5,VIDEO_QUOTE_RECEIVED:6,VIDEO_QUOTE_IN_PROGRESS:7,WALKTHROUGH_VERBALLY_BOOKED:8,WALKTHROUGH_BOOKED:9,WALKTHROUGH_COMPLETED:10,QUOTE_DELIVERED:11,CUSTOMER_DECIDING:12,JOB_VERBALLY_ACCEPTED:13,JOB_SOLD:14,JOB_SCHEDULED:15,JOB_COMPLETED:16,CASH_COLLECTED:17};
const nextActions: Record<OperationalState,string> = {
  NEW_LEAD:"Make the first human contact",OUTREACH_ATTEMPTED:"Follow up with the customer",TWO_WAY_CONTACT:"Qualify the service and agree the next step",QUALIFIED:"Arrange an EGC Portal walkthrough or video quote",PRICE_EXPECTATION_ACCEPTED:"Confirm the agreed appointment or quote step",VIDEO_QUOTE_PENDING_CUSTOMER:"Obtain the promised customer photos or video",VIDEO_QUOTE_RECEIVED:"Review customer media and prepare the quote",VIDEO_QUOTE_IN_PROGRESS:"Finish and send the quote",QUOTE_DELIVERED:"Obtain the customer's decision",WALKTHROUGH_VERBALLY_BOOKED:"Create or reconcile the agreed walkthrough through EGC Portal",WALKTHROUGH_BOOKED:"Complete the walkthrough through EGC Portal",WALKTHROUGH_COMPLETED:"Record the outcome and deliver the quote",FOLLOW_UP_PENDING:"Review the recorded outcome before further follow-up",CUSTOMER_DECIDING:"Follow up at the agreed decision deadline",JOB_VERBALLY_ACCEPTED:"Record the accepted work in EGC Portal and reconcile CRM closed-won",JOB_SOLD:"Schedule the accepted job through EGC Portal",JOB_SCHEDULED:"Complete the scheduled work",JOB_COMPLETED:"Verify payment and record collected revenue",CASH_COLLECTED:"Confirm completed service and reconcile payment records",LOST:"No active sales follow-up",DO_NOT_CONTACT:"Honor do-not-contact preferences"
};

export function projectCustomer(input:{contactId:string;leadId?:string|null;customerName?:string|null;leadCreatedAt:string;events:CanonicalEvent[];assertions?:OperationalAssertion[];exclusionReasons?:string[];providerAppointmentCount?:number;missingJobLink?:boolean;missingTranscriptIds?:string[]}):CustomerProjection {
  const trusted=input.events.filter(e=>!e.humanReviewNeeded && e.confidence>=.85).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
  const has=(t:CustomerEventType)=>trusted.some(e=>e.eventType===t);
  let state:OperationalState="NEW_LEAD";
  for(const event of trusted) {const next=stageMap[event.eventType];if(next && (rank[next] ?? 0)>(rank[state] ?? 0))state=next;}
  // An inbound reply alone is contact evidence, not a two-way conversation.
  if(state==="TWO_WAY_CONTACT" && !has("two_way_contact"))state=has("human_outreach")?"OUTREACH_ATTEMPTED":"NEW_LEAD";
  const followUp=trusted.filter(e=>e.eventType==="follow_up_commitment").at(-1);
  if(followUp&&(rank[state]??0)<=rank.QUALIFIED!)state="FOLLOW_UP_PENDING";
  const latestEvidenceTime=(e:CanonicalEvent)=>e.evidence.filter(r=>!r.humanReviewNeeded&&r.confidence>=.85).reduce((at,r)=>r.occurredAt>at?r.occurredAt:at,e.occurredAt);
  const lastTerminal=trusted.filter(e=>["lost","do_not_contact","walkthrough_negative_outcome","appointment_cancelled","no_show"].includes(e.eventType)).sort((a,b)=>latestEvidenceTime(a).localeCompare(latestEvidenceTime(b))).at(-1);
  const recommitmentTypes=new Set(["video_quote_customer_agreed","video_quote_received","walkthrough_verbally_booked","walkthrough_booked","job_verbally_accepted","job_sold","job_scheduled"]);
  const laterRecommitment=lastTerminal&&trusted.some(e=>recommitmentTypes.has(e.eventType)&&latestEvidenceTime(e)>latestEvidenceTime(lastTerminal));
  let disposition:CustomerProjection["pipelineDisposition"]=has("job_sold")||has("revenue_collected")?"converted":"active";
  if(lastTerminal && !laterRecommitment && !has("job_sold") && !has("revenue_collected")) {
    if(lastTerminal.eventType==="lost"){state="LOST";disposition="lost";}
    else if(lastTerminal.eventType==="walkthrough_negative_outcome"){state="FOLLOW_UP_PENDING";disposition="negative_outcome";}
    else if(["appointment_cancelled","no_show"].includes(lastTerminal.eventType)){state="FOLLOW_UP_PENDING";}
  }
  if(has("do_not_contact") || input.exclusionReasons?.includes("do_not_contact")){state="DO_NOT_CONTACT";disposition="do_not_contact";}
  const assertions=input.assertions??[], discrepancies:CustomerProjection["discrepancies"]=[];
  for(const reason of new Set(trusted.flatMap(e=>Array.isArray(e.details.financialExceptions)?e.details.financialExceptions.filter((r):r is string=>typeof r==="string"):[])))discrepancies.push({code:reason,detail:`EGC Portal financial evidence requires reconciliation: ${reason}`,sourceIds:trusted.filter(e=>Array.isArray(e.details.financialExceptions)&&e.details.financialExceptions.includes(reason)).map(e=>e.eventId)});
  for(const a of assertions.filter(a=>a.status==="pending_reconciliation"))discrepancies.push({code:"user_confirmed_awaiting_backend",detail:`User-confirmed ${a.field}=${JSON.stringify(a.value)}; backend has not independently reconciled`,sourceIds:[a.id]});
  if(has("walkthrough_verbally_booked")&&!has("walkthrough_booked")&&disposition==="active")discrepancies.push({code:"verbally_booked_provider_missing",detail:"Walkthrough agreed in call/text; provider appointment pending",sourceIds:trusted.filter(e=>e.eventType==="walkthrough_verbally_booked").map(e=>e.eventId)});
  if(has("job_sold")&&!trusted.some(e=>e.eventType==="job_sold" && e.evidence.some(r=>["opportunity","job","portal_job"].includes(r.sourceType))))discrepancies.push({code:"accepted_job_awaiting_crm",detail:"Accepted job evidenced outside normalized CRM/job records",sourceIds:trusted.filter(e=>e.eventType==="job_sold").map(e=>e.eventId)});
  if(input.missingJobLink)discrepancies.push({code:"provider_missing_job_link",detail:"Provider booking is missing its EGC job link",sourceIds:[]});
  if((input.providerAppointmentCount??0)>1)discrepancies.push({code:"duplicate_appointment_suspected",detail:"Multiple active provider appointments share a customer and start time",sourceIds:[]});
  if(has("job_completed")&&!has("revenue_collected"))discrepancies.push({code:"closed_without_payment_evidence",detail:"Completed work has no verified collected-revenue evidence",sourceIds:[]});
  if(input.missingTranscriptIds?.length)discrepancies.push({code:"transcript_unavailable",detail:"Recent recorded calls are missing extractable transcripts",sourceIds:input.missingTranscriptIds});
  let pipeline:CustomerProjection["pipeline"]="unclassified";
  const video=trusted.filter(e=>e.eventType.startsWith("video_quote_"));
  const walk=trusted.filter(e=>e.eventType.startsWith("walkthrough_"));
  if(walk.length)pipeline="walkthrough";
  if(video.length && (!walk.length || video.at(-1)!.occurredAt>walk.at(-1)!.occurredAt))pipeline="video_quote";
  if(pipeline==="unclassified"&&(has("quote_delivered")||has("job_sold")||has("job_verbally_accepted")))pipeline="direct_job";
  let videoQuoteStage:CustomerProjection["videoQuoteStage"]=null;
  if(video.length){videoQuoteStage="requested";for(const [type,stage] of [["video_quote_customer_agreed","customer_agreed"],["video_quote_received","media_received"],["video_quote_in_progress","estimator_review"],["quote_prepared","quote_prepared"],["quote_delivered","quote_sent"],["customer_deciding","customer_deciding"],["job_sold","accepted"],["lost","lost"]] as const)if(has(type))videoQuoteStage=stage;}
  let intentStage:CustomerProjection["intentStage"]=has("two_way_contact")||has("customer_response")?"engaged":"unengaged";
  if(has("qualified"))intentStage="qualified";
  if(["price_expectation_accepted","appointment_time_agreed","walkthrough_verbally_booked","walkthrough_booked","video_quote_received"].some(t=>has(t as CustomerEventType)))intentStage="high_intent";
  if(has("job_verbally_accepted"))intentStage="accepted";
  if(has("job_sold")||has("revenue_collected"))intentStage="converted";
  if(["negative_outcome","lost","do_not_contact"].includes(disposition))intentStage="inactive";
  const supporting=trusted.filter(e=>stageMap[e.eventType]===state || (state==="FOLLOW_UP_PENDING"&&(e===lastTerminal||e===followUp)));
  const reconciliationStatus:CustomerProjection["reconciliationStatus"]=(input.providerAppointmentCount??0)>1?"duplicate_suspected":discrepancies.some(d=>d.code==="verbally_booked_provider_missing")?"verbally_booked_provider_pending":discrepancies.length?"reconciliation_needed":has("walkthrough_booked")?"provider_booking_confirmed":"fully_reconciled";
  return {contactId:input.contactId,leadId:input.leadId??null,customerName:input.customerName??null,leadCreatedAt:input.leadCreatedAt,state,intentStage,pipeline,videoQuoteStage,pipelineDisposition:disposition,reconciliationStatus,
    supportingEvidence:supporting.flatMap(e=>e.evidence),nextRequiredAction:state==="FOLLOW_UP_PENDING"&&disposition==="active"&&followUp?.nextAction?followUp.nextAction:nextActions[state],followUpCommitment:followUp?{occurredAt:followUp.occurredAt,deadline:followUp.details.deadline??followUp.details.followUpDeadline??followUp.details.deadlineMention??null,action:followUp.nextAction,evidence:followUp.evidence}:null,humanReviewNeeded:input.events.some(e=>e.humanReviewNeeded)||discrepancies.length>0,
    discrepancies,excluded:(input.exclusionReasons??[]).includes("test_internal_or_vendor"),exclusionReasons:input.exclusionReasons??[],eventIds:input.events.map(e=>e.eventId),lastEventAt:input.events.at(-1)?.occurredAt??input.leadCreatedAt};
}

export function assertionReconciled(assertion:OperationalAssertion, providerEvents:CanonicalEvent[]) {
  const requested=assertionEvents(assertion);if(!requested.length)return false;
  if(requested.length===1&&requested[0]!.eventType==="revenue_collected"&&requested[0]!.valueVerified){const payments=providerEvents.filter(e=>e.eventType==="revenue_collected"&&!e.humanReviewNeeded&&e.valueVerified&&e.evidence.some(r=>r.sourceType==="portal_payment"||r.sourceType==="portal_job"));return payments.length>0&&payments.reduce((n,e)=>n+(e.valueCents??0),0)===requested[0]!.valueCents;}
  return requested.every(request=>providerEvents.some(event=>event.eventType===request.eventType && !event.humanReviewNeeded && event.evidence.some(e=>["appointment","opportunity","job","portal_visit","portal_job","portal_payment","walkthrough"].includes(e.sourceType)) && (!request.valueVerified || (event.valueVerified && event.valueCents===request.valueCents))));
}

export const REPORT_METRICS:Record<string,CustomerEventType[]> = {
  leads:["lead_created"],humanContacts:["two_way_contact"],humanOutreach:["human_outreach"],twoWayContacts:["two_way_contact"],qualified:["qualified","price_expectation_accepted"],priceExpectationsAccepted:["price_expectation_accepted"],
  videoQuoteOpportunities:["video_quote_requested","video_quote_customer_agreed"],videoQuotesReceived:["video_quote_received"],quotesDelivered:["quote_delivered"],walkthroughsVerballyBooked:["walkthrough_verbally_booked"],walkthroughsFormallyBooked:["walkthrough_booked"],walkthroughsCompleted:["walkthrough_completed","walkthrough_showed"],jobsVerballyAccepted:["job_verbally_accepted"],jobsSold:["job_sold"],jobsCompleted:["job_completed"],cashCollected:["revenue_collected"]
};

export function paginateEventEvidence(events:CanonicalEvent[],offset=0,limit=100) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('invalid_evidence_page');
  const basic=new Set(['lead_created','human_outreach','customer_response','address_supplied','appointment_time_agreed','price_expectation_given','payment_discussed']);
  const priority=(event:CanonicalEvent)=>basic.has(event.eventType)?2:event.eventType==='two_way_contact'?1:0;
  const ordered=[...events].sort((a,b)=>priority(a)-priority(b)||a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId));
  const page=ordered.slice(offset,offset+limit);
  return {events:page,page:{offset,limit,total:ordered.length,nextOffset:offset+page.length<ordered.length?offset+page.length:null,order:'material_business_events_then_two_way_then_basic_activity',fullSource:'customer_timeline_and_original_source_pointer'}};
}
export function buildReport(input:{events:CanonicalEvent[];customers:CustomerProjection[];since:string;until:string;cohortSince?:string;cohortUntil?:string;asOf?:string;leadRoster?:Array<{contactId:string;leadCreatedAt:string;excluded:boolean}>}) {
  const since=validDate(input.since),until=validDate(input.until),cohortSince=validDate(input.cohortSince??input.since),cohortUntil=validDate(input.cohortUntil??input.until);
  if(!since||!until||!cohortSince||!cohortUntil||since>=until||cohortSince>=cohortUntil)throw new Error("invalid_report_window");
  const asOf=validDate(input.asOf??new Date())!;
  const customers=input.customers.filter(c=>!c.excluded),allowed=new Set(customers.map(c=>c.contactId));
  const trusted=input.events.filter(e=>allowed.has(e.contactId)&&!e.humanReviewNeeded&&e.confidence>=.85&&e.occurredAt<until);
  const roster=input.leadRoster??input.customers;
  const activity=trusted.filter(e=>e.occurredAt>=since && e.details.occurredAtVerified !== false),cohort=roster.filter(c=>!c.excluded&&c.leadCreatedAt>=cohortSince && c.leadCreatedAt<cohortUntil),cohortIds=new Set(cohort.map(c=>c.contactId));
  const periodActivity:Record<string,{count:number;unit:string;eventIds:string[];contactIds:string[]}>= {};
  const cohortMetrics:Record<string,{numerator:number;denominator:number;rate:number|null;window:{since:string;until:string};observedThrough:string;contactIds:string[]}>= {};
  for(const [name,types] of Object.entries(REPORT_METRICS)) {
    const matches=activity.filter(e=>types.includes(e.eventType)),ids=[...new Set(matches.map(e=>e.contactId))];
    periodActivity[name]={count:ids.length,unit:"distinct_customers",...occurrenceMetric(matches,types),eventIds:matches.map(e=>e.eventId),contactIds:ids};
    const converted=[...new Set(trusted.filter(e=>cohortIds.has(e.contactId)&&types.includes(e.eventType)).map(e=>e.contactId))];
    cohortMetrics[name]={numerator:converted.length,denominator:cohort.length,rate:cohort.length?converted.length/cohort.length:null,window:{since:cohortSince,until:cohortUntil},observedThrough:until,contactIds:converted};
  }
  if(input.leadRoster){
    // Creation records are complete even when extraction failed for a customer.
    // Keep the true denominator and disclose missing reconciliation separately.
    const periodLeads=roster.filter(c=>!c.excluded&&c.leadCreatedAt>=since&&c.leadCreatedAt<until).map(c=>c.contactId);
    periodActivity.leads={...periodActivity.leads!,count:periodLeads.length,contactIds:periodLeads};
    cohortMetrics.leads={...cohortMetrics.leads!,numerator:cohort.length,rate:cohort.length?1:null,contactIds:[...cohortIds]};
  }
  const revenue=(type:CustomerEventType)=>{
    const allRows=activity.filter(e=>e.eventType===type),rows=occurrenceMetricRows(allRows),undated=occurrenceMetricRows(trusted.filter(e=>e.eventType===type&&e.details.occurredAtVerified===false));
    const unallocated=allRows.filter(e=>!rows.includes(e)&&e.valueVerified);
    const known=rows.filter(e=>e.valueVerified&&e.currency==="USD"),knownSubtotalCents=known.reduce((n,e)=>n+(e.valueCents??0),0);
    const incomplete=type==="revenue_collected"&&trusted.some(e=>e.details.revenueCoverageIncomplete===true),unknownValue=[...rows,...undated].filter(e=>!e.valueVerified||e.currency!=="USD");
    return {valueCents:known.length===rows.length&&!incomplete&&!undated.length&&!unallocated.length?knownSubtotalCents:null,knownSubtotalCents,currency:"USD",basis:type==="revenue_collected"?"verified_gross_customer_receipts":"accepted_customer_work",coverageIncomplete:incomplete||undated.length>0||unallocated.length>0,verifiedEvents:known.length,missingValue:unknownValue.map(e=>e.eventId),unknownValueCount:unknownValue.length,unknownOccurrenceCount:undated.length,unknownOccurrenceEvents:undated.map(e=>({eventId:e.eventId,contactId:e.contactId,valueCents:e.valueVerified?e.valueCents:null,currency:e.valueVerified?e.currency:null})),unallocatedVerifiedEvents:unallocated.map(e=>({eventId:e.eventId,contactId:e.contactId,valueCents:e.valueCents,currency:e.currency})),qualification:undated.length?"Confirmed outcomes have unknown occurrence time; they are not assigned to this period, so a complete period total is unavailable.":unallocated.length?"Verified amounts remain unassigned to exact work; they are disclosed separately and are not added to known jobs.":incomplete?"Payment history is incomplete; the verified dated subtotal is not a complete total.":unknownValue.length?"Some dated outcomes have unverified amounts; only the verified subtotal is known.":"Verified dated outcomes in this period."};
  };
  const active=customers.filter(c=>c.pipelineDisposition==="active");
  return {authority:"canonical_customer_event_ledger",generatedAt:asOf,period:{since,until,boundaries:"inclusive_start_exclusive_end"},periodActivity,
    soldRevenue:revenue("job_sold"),collectedRevenue:revenue("revenue_collected"),cohort:{window:{since:cohortSince,until:cohortUntil},denominator:cohort.length,observedThrough:until,
      maturity:{youngestLeadAgeDays:cohort.length?Math.max(0,Math.min(...cohort.map(c=>(new Date(until).valueOf()-new Date(c.leadCreatedAt).valueOf())/86_400_000))):null,oldestLeadAgeDays:cohort.length?Math.max(...cohort.map(c=>(new Date(until).valueOf()-new Date(c.leadCreatedAt).valueOf())/86_400_000)):null,label:"observed_so_far_not_final_close_rate"},metrics:cohortMetrics},
    pipelines:{walkthrough:active.filter(c=>c.pipeline==="walkthrough"),videoQuote:active.filter(c=>c.pipeline==="video_quote"),directJob:active.filter(c=>c.pipeline==="direct_job")},customers,
    countedEvents:activity,confirmedOutcomesWithUnknownTime:trusted.filter(e=>e.details.occurredAtVerified === false),reviewRequiredEvents:input.events.filter(e=>e.humanReviewNeeded&&allowed.has(e.contactId)),excludedCustomers:input.customers.filter(c=>c.excluded).map(c=>({contactId:c.contactId,reasons:c.exclusionReasons}))};
}
