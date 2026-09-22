import type {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {formatOperationalBriefing,getCanonicalReport,getOperationalEventEvidence,getCustomerTimeline,getCustomerStateDiagnostics,reconcileCustomerState,recordUserConfirmedOutcome} from '@egc/customer-state';
import {conversionStatus,previewConversions} from '@egc/meta-conversions';
import {oauthSecurityMetadata,READ_SCOPE,WRITE_SCOPE} from './oauth.js';
import {operationsPrincipal} from './operations.js';

export const CUSTOMER_STATE_WRITE_TOOLS=['egc.reconcile_customer_state','egc.record_user_confirmed_outcome'] as const;
const read={annotations:{readOnlyHint:true,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE])};
const write={annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true},...oauthSecurityMetadata([READ_SCOPE,WRITE_SCOPE])};
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value,null,2)}],structuredContent:{result:value}});
const iso=z.string().datetime({offset:true});
const offset=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),limit=z.number().int().min(1).max(200);
const eventId=z.string().regex(/^egcev_[a-f0-9]{64}$/);
function compactMetaRead<T extends object>(value:T,tool:'meta.conversions.status'|'meta.conversions.preview',days:number,cohortIds:Set<string>){
 const original=value as Record<string,unknown>,output:Record<string,unknown>={...original},detailPages:Record<string,unknown>={};
 const sample=(key:string,rows:unknown[])=>{detailPages[key]={returnedByService:rows.length,shown:Math.min(20,rows.length),omitted:Math.max(0,rows.length-20),presentationTruncated:rows.length>20};return rows.slice(0,20);};
 for(const key of ['pending','failures','recentAccepted','leads','events'])if(Array.isArray(original[key]))output[key]=sample(key,original[key]);
 if(original.canonicalCoverage&&typeof original.canonicalCoverage==='object'){
  const coverage={...original.canonicalCoverage as Record<string,unknown>};
  for(const key of ['missingCustomers','excludedCustomers','sourceExtractionHeldEvents'])if(Array.isArray(coverage[key])){
   const rows=coverage[key] as Array<{contactId?:string}>;
   coverage[`${key}Count`]=rows.length;coverage[key]=sample(`canonicalCoverage.${key}`,rows);
   if(key==='missingCustomers')coverage.missingCustomersScope={inventory:'inventory_all_leads',currentReportCohort:rows.filter(row=>row.contactId&&cohortIds.has(row.contactId)).length,outsideCurrentReportCohort:rows.filter(row=>!row.contactId||!cohortIds.has(row.contactId)).length,qualification:'Missing canonical snapshots across discovery inventory; outside-cohort records may contain current activity and are not all current-cohort failures.'};
  }
  output.canonicalCoverage=coverage;
 }
 const range=tool==='meta.conversions.status'&&original.cohort&&typeof original.cohort==='object'?original.cohort as Record<string,unknown>:original;
 return {...output,presentation:'compact_meta_diagnostics',detailPages,detailRetrieval:{tool,input:{days,...(typeof range.from==='string'?{from:range.from}:{}),...(typeof range.to==='string'?{to:range.to}:{}),limit:100},limitation:'Read tool returns at most 100 event/lead detail rows and has no offset pagination. Narrow the time window when its response is truncated; this briefing does not claim complete detail retrieval. Canonical coverage inventory may span older leads.'}};
}
export function reportWindow(days:number,from?:string,to?:string){const until=to??new Date().toISOString(),end=Date.parse(until);if(!Number.isFinite(end)||!Number.isInteger(days)||days<1||days>365)throw new Error('invalid_report_window');const since=from??new Date(end-days*86400000).toISOString();if(!Number.isFinite(Date.parse(since))||Date.parse(since)>=end)throw new Error('invalid_report_window');return {since,until};}
export async function canonicalOperationalReport(input:{days?:number|undefined;from?:string|undefined;to?:string|undefined;cohortFrom?:string|undefined;cohortTo?:string|undefined;refresh?:boolean|undefined;evidenceOffset?:number|undefined;evidenceLimit?:number|undefined}={}){
 const window=reportWindow(input.days??7,input.from,input.to);
 reportWindow(7,input.cohortFrom??window.since,input.cohortTo??window.until);
 const report=await getCanonicalReport({...window,...(input.cohortFrom?{cohortSince:input.cohortFrom}:{}),...(input.cohortTo?{cohortUntil:input.cohortTo}:{}),evidenceOffset:offset.parse(input.evidenceOffset??0),evidenceLimit:limit.parse(input.evidenceLimit??100),refresh:input.refresh??true});
 return {...report,reportingRule:'Period activity uses event occurrence time. Cohort conversions use lead creation windows. Confirmed outcomes without a verified occurrence time are shown separately, never retimed.',walkthroughAuthority:'employee_hub'};
}
export async function canonicalFunnel(days:number){
 const report=await canonicalOperationalReport({days});
 const metaWindow=Math.min(days,90);
 const metrics=report.cohort.metrics,total=report.cohort.denominator;
 const cohortIds=new Set(metrics.leads?.contactIds??report.customers.filter(c=>c.leadCreatedAt>=report.cohort.window.since&&c.leadCreatedAt<report.cohort.window.until).map(c=>c.contactId));
 const meta={status:compactMetaRead(await conversionStatus({days:metaWindow,limit:500}),'meta.conversions.status',metaWindow,cohortIds),preview:compactMetaRead(await previewConversions({days:metaWindow,limit:500}),'meta.conversions.preview',metaWindow,cohortIds)};
 const bookedIds=new Set([...(metrics.walkthroughsVerballyBooked?.contactIds??[]),...(metrics.walkthroughsFormallyBooked?.contactIds??[])]);
 const contacted=new Set(metrics.twoWayContacts?.contactIds??[]);
 const states=new Map<string,number>();for(const c of report.customers.filter(c=>c.leadCreatedAt>=report.cohort.window.since&&c.leadCreatedAt<report.cohort.window.until))states.set(c.state,(states.get(c.state)??0)+1);
 return formatOperationalBriefing({...report,days,total,meta,states:[...states].map(([state,count])=>({state,count})),counts:{humanOutreach:metrics.humanOutreach?.numerator??0,customerResponse:metrics.twoWayContacts?.numerator??0,twoWayContact:contacted.size,booked:bookedIds.size,bookedAfterTwoWayContact:[...bookedIds].filter(id=>contacted.has(id)).length},leadToBookedRate:total?bookedIds.size/total:null,twoWayContactRate:total?contacted.size/total:null,bookedRate:total?bookedIds.size/total:null,definition:'Booked includes separately enumerated verbal commitments and formal Hub/provider records; video opportunities are a separate pipeline.'});
}
export function registerCustomerStateTools(server:McpServer){
 server.registerTool('egc.operational_report',{description:'Canonical EGC operational briefing for Morning Command, EOD, weekly and monthly reporting. Separates event-period activity from lead-cohort metrics with numerator, denominator, maturity and evidence for every conversion. Distinguishes walkthrough, video quote and direct-job pipelines, user-confirmed truth, provider lag and coverage failures. Evidence is paginated; retrieve every remaining source using egc.operational_event_evidence and the returned nextOffset.',inputSchema:z.object({days:z.number().int().min(1).max(365).default(7),from:iso.optional(),to:iso.optional(),cohortFrom:iso.optional(),cohortTo:iso.optional(),evidenceOffset:offset.default(0),evidenceLimit:limit.default(100)}).strict(),...read},async args=>result(formatOperationalBriefing(await canonicalOperationalReport(args))));
 server.registerTool('egc.operational_event_evidence',{description:'Read a bounded page of original canonical events and full source evidence without repeating the operational report. Follow page.nextOffset until null. Exact eventIds (up to 200) retrieve those counted events, including confirmed outcomes with unknown occurrence time, independently of the period; their time-verification labels are preserved. This read does not extract, reconcile, or send events.',inputSchema:z.object({since:iso,until:iso,offset:offset.default(0),limit:limit.default(100),eventIds:z.array(eventId).max(200).optional()}).strict(),...read},async args=>{reportWindow(7,args.since,args.until);return result(await getOperationalEventEvidence({since:args.since,until:args.until,offset:args.offset,limit:args.limit,...(args.eventIds!==undefined?{eventIds:args.eventIds}:{})}));});
 server.registerTool('egc.customer_timeline',{description:'Read canonical evidence, rich customer state, source-linked call/text events, original attribution and user-confirmed assertions for one exact contact. Provider lag is separate from operational truth.',inputSchema:z.object({contactId:z.string().uuid()}),...read},async args=>result(await getCustomerTimeline(args)));
 server.registerTool('egc.customer_state_diagnostics',{description:'Read unresolved customer-state discrepancies, transcript extraction failures, video quote actions, provider booking gaps, unverified revenue and Meta accepted/pending/failed events and cursor.',inputSchema:z.object({}),...read},async()=>result({customers:await getCustomerStateDiagnostics(),meta:await conversionStatus({days:7,limit:100})}));
 server.registerTool('egc.reconcile_customer_state',{description:'Idempotently reconstruct recent/active customer state from calls/transcripts, messages, records, notes and durable user-confirmed assertions. Persists evidence with exact source references. Does not message customers, create appointments, charge payments or send Meta events.',inputSchema:z.object({contactIds:z.array(z.string().uuid()).max(500).optional(),since:iso.optional(),until:iso.optional(),useAI:z.boolean().default(true),maxContacts:z.number().int().min(1).max(500).default(200)}),...write},async args=>result(await reconcileCustomerState({useAI:args.useAI,maxContacts:args.maxContacts,...(args.contactIds?{contactIds:args.contactIds}:{}),...(args.since?{since:args.since}:{}),...(args.until?{until:args.until}:{})})));
 server.registerTool('egc.record_user_confirmed_outcome',{description:'Persist an exact user-confirmed operational fact as an auditable overlay. Requires exact contact, asserted field, original user text and source reference. Does not silently overwrite provider records. Omit occurrence time if unknown; amounts may be supplied only if explicitly verified for this exact customer.',inputSchema:z.object({contactId:z.string().uuid(),field:z.string().min(1).max(100),value:z.unknown(),exactText:z.string().min(3).max(12000),sourceReference:z.string().min(3).max(2000),assertedAt:iso.optional(),occurredAt:iso.optional(),valueCents:z.number().int().nonnegative().optional(),currency:z.literal('USD').optional()}),...write},async args=>{
  const actor=operationsPrincipal.getStore();if(!actor)throw new Error('verified_principal_required');
  return result(await recordUserConfirmedOutcome({contactId:args.contactId,field:args.field,value:args.value,exactText:args.exactText,sourceReference:args.sourceReference,actorId:actor.id,...(args.assertedAt?{assertedAt:args.assertedAt}:{}),...(args.occurredAt?{occurredAt:args.occurredAt}:{}),...(args.valueCents!==undefined?{valueCents:args.valueCents}:{}),...(args.currency?{currency:args.currency}:{})}));
 });
}
