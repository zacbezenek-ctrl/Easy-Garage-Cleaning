import type {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {getCanonicalReport,getCustomerTimeline,getCustomerStateDiagnostics,reconcileCustomerState,recordUserConfirmedOutcome} from '@egc/customer-state';
import {conversionStatus,previewConversions} from '@egc/meta-conversions';
import {oauthSecurityMetadata,READ_SCOPE,WRITE_SCOPE} from './oauth.js';
import {operationsPrincipal} from './operations.js';

export const CUSTOMER_STATE_WRITE_TOOLS=['egc.reconcile_customer_state','egc.record_user_confirmed_outcome'] as const;
const read={annotations:{readOnlyHint:true,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE])};
const write={annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true},...oauthSecurityMetadata([READ_SCOPE,WRITE_SCOPE])};
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value,null,2)}],structuredContent:{result:value}});
const iso=z.string().datetime({offset:true});
export function reportWindow(days:number,from?:string,to?:string){const until=to??new Date().toISOString(),since=from??new Date(Date.parse(until)-days*86400000).toISOString();if(!Number.isFinite(Date.parse(since))||!Number.isFinite(Date.parse(until))||since>=until)throw new Error('invalid_report_window');return {since,until};}
export async function canonicalOperationalReport(input:{days?:number|undefined;from?:string|undefined;to?:string|undefined;cohortFrom?:string|undefined;cohortTo?:string|undefined;refresh?:boolean|undefined}={}){
 const window=reportWindow(input.days??7,input.from,input.to);
 const report=await getCanonicalReport({...window,...(input.cohortFrom?{cohortSince:input.cohortFrom}:{}),...(input.cohortTo?{cohortUntil:input.cohortTo}:{}),refresh:input.refresh??true});
 return {...report,reportingRule:'Period activity uses event occurrence time. Cohort conversions use lead creation windows. Confirmed outcomes without a verified occurrence time are shown separately, never retimed.',walkthroughAuthority:'employee_hub'};
}
export async function canonicalFunnel(days:number){
 const report=await canonicalOperationalReport({days});
 const metaWindow=Math.min(days,90);
 const meta={status:await conversionStatus({days:metaWindow,limit:500}),preview:await previewConversions({days:metaWindow,limit:500})};
 const metrics=report.cohort.metrics,total=report.cohort.denominator;
 const bookedIds=new Set([...(metrics.walkthroughsVerballyBooked?.contactIds??[]),...(metrics.walkthroughsFormallyBooked?.contactIds??[])]);
 const contacted=new Set(metrics.twoWayContacts?.contactIds??[]);
 const states=new Map<string,number>();for(const c of report.customers.filter(c=>c.leadCreatedAt>=report.cohort.window.since&&c.leadCreatedAt<report.cohort.window.until))states.set(c.state,(states.get(c.state)??0)+1);
 return {...report,days,total,meta,states:[...states].map(([state,count])=>({state,count})),counts:{humanOutreach:metrics.humanOutreach?.numerator??0,customerResponse:metrics.twoWayContacts?.numerator??0,twoWayContact:contacted.size,booked:bookedIds.size,bookedAfterTwoWayContact:[...bookedIds].filter(id=>contacted.has(id)).length},leadToBookedRate:total?bookedIds.size/total:null,twoWayContactRate:total?contacted.size/total:null,bookedRate:total?bookedIds.size/total:null,definition:'Booked includes separately enumerated verbal commitments and formal Hub/provider records; video opportunities are a separate pipeline.'};
}
export function registerCustomerStateTools(server:McpServer){
 server.registerTool('egc.operational_report',{description:'Canonical EGC operational report for Morning Command, EOD, weekly and monthly reporting. Separates event-period activity from lead-cohort metrics with numerator, denominator, maturity and evidence for every conversion. Distinguishes walkthrough, video quote and direct-job pipelines, user-confirmed truth, provider lag and coverage failures.',inputSchema:z.object({days:z.number().int().min(1).max(365).default(7),from:iso.optional(),to:iso.optional(),cohortFrom:iso.optional(),cohortTo:iso.optional()}),...read},async args=>result(await canonicalOperationalReport(args)));
 server.registerTool('egc.customer_timeline',{description:'Read canonical evidence, rich customer state, source-linked call/text events, original attribution and user-confirmed assertions for one exact contact. Provider lag is separate from operational truth.',inputSchema:z.object({contactId:z.string().uuid()}),...read},async args=>result(await getCustomerTimeline(args)));
 server.registerTool('egc.customer_state_diagnostics',{description:'Read unresolved customer-state discrepancies, transcript extraction failures, video quote actions, provider booking gaps, unverified revenue and Meta accepted/pending/failed events and cursor.',inputSchema:z.object({}),...read},async()=>result({customers:await getCustomerStateDiagnostics(),meta:await conversionStatus({days:7,limit:100})}));
 server.registerTool('egc.reconcile_customer_state',{description:'Idempotently reconstruct recent/active customer state from calls/transcripts, messages, records, notes and durable user-confirmed assertions. Persists evidence with exact source references. Does not message customers, create appointments, charge payments or send Meta events.',inputSchema:z.object({contactIds:z.array(z.string().uuid()).max(500).optional(),since:iso.optional(),until:iso.optional(),useAI:z.boolean().default(true),maxContacts:z.number().int().min(1).max(500).default(200)}),...write},async args=>result(await reconcileCustomerState({useAI:args.useAI,maxContacts:args.maxContacts,...(args.contactIds?{contactIds:args.contactIds}:{}),...(args.since?{since:args.since}:{}),...(args.until?{until:args.until}:{})})));
 server.registerTool('egc.record_user_confirmed_outcome',{description:'Persist an exact user-confirmed operational fact as an auditable overlay. Requires exact contact, asserted field, original user text and source reference. Does not silently overwrite provider records. Omit occurrence time if unknown; amounts may be supplied only if explicitly verified for this exact customer.',inputSchema:z.object({contactId:z.string().uuid(),field:z.string().min(1).max(100),value:z.unknown(),exactText:z.string().min(3).max(12000),sourceReference:z.string().min(3).max(2000),assertedAt:iso.optional(),occurredAt:iso.optional(),valueCents:z.number().int().nonnegative().optional(),currency:z.literal('USD').optional()}),...write},async args=>{
  const actor=operationsPrincipal.getStore();if(!actor)throw new Error('verified_principal_required');
  return result(await recordUserConfirmedOutcome({contactId:args.contactId,field:args.field,value:args.value,exactText:args.exactText,sourceReference:args.sourceReference,actorId:actor.id,...(args.assertedAt?{assertedAt:args.assertedAt}:{}),...(args.occurredAt?{occurredAt:args.occurredAt}:{}),...(args.valueCents!==undefined?{valueCents:args.valueCents}:{}),...(args.currency?{currency:args.currency}:{})}));
 });
}
