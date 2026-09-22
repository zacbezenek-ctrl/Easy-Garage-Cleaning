import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {getCanonicalReport,getOperationalEventEvidence,getCustomerTimeline,getCustomerStateDiagnostics,reconcileCustomerState} from '@egc/customer-state';
import {z} from 'zod';
const iso=z.string().datetime({offset:true});
const queryInteger=z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const pageOffset=queryInteger.default(0),pageLimit=queryInteger.pipe(z.number().int().min(1).max(200)).default(100);
const validWindow=(v:{since:string;until:string;cohortSince?:string|undefined;cohortUntil?:string|undefined})=>Date.parse(v.since)<Date.parse(v.until)&&Date.parse(v.cohortSince??v.since)<Date.parse(v.cohortUntil??v.until);
const window=z.object({since:iso,until:iso,cohortSince:iso.optional(),cohortUntil:iso.optional(),evidenceOffset:pageOffset,evidenceLimit:pageLimit}).strict().refine(validWindow);
const eventId=z.string().regex(/^egcev_[a-f0-9]{64}$/);
const events=z.object({since:iso,until:iso,offset:pageOffset,limit:pageLimit,eventIds:z.union([eventId.transform(id=>[id]),z.array(eventId).max(200)]).optional()}).strict().refine(validWindow);
const reconcile=z.object({contactIds:z.array(z.string().uuid()).max(500).optional(),since:iso.optional(),until:iso.optional(),useAI:z.boolean().default(true),maxContacts:z.number().int().min(1).max(500).default(200)}).strict();

export async function registerIntelligenceRoutes(app:FastifyInstance,authenticate:(request:FastifyRequest,reply:FastifyReply)=>Promise<void>){
 app.get('/intelligence/report',{preHandler:authenticate},async(request,reply)=>{
  const input=window.safeParse(request.query);if(!input.success)return reply.code(400).send({error:'invalid_report_window'});
  const v=input.data;
  try{return await getCanonicalReport({since:v.since,until:v.until,...(v.cohortSince?{cohortSince:v.cohortSince}:{}),...(v.cohortUntil?{cohortUntil:v.cohortUntil}:{}),evidenceOffset:v.evidenceOffset,evidenceLimit:v.evidenceLimit,refresh:true});}catch{return reply.code(503).send({error:'canonical_report_unavailable'});}
 });
 app.get('/intelligence/events',{preHandler:authenticate},async(request,reply)=>{
  const input=events.safeParse(request.query);if(!input.success)return reply.code(400).send({error:'invalid_event_evidence_request'});
  const v=input.data;
  try{return await getOperationalEventEvidence({since:v.since,until:v.until,offset:v.offset,limit:v.limit,...(v.eventIds!==undefined?{eventIds:v.eventIds}:{})});}catch{return reply.code(503).send({error:'event_evidence_unavailable'});}
 });
 app.get('/intelligence/customer/:contactId',{preHandler:authenticate},async(request,reply)=>{
  const input=z.object({contactId:z.string().uuid()}).safeParse(request.params);if(!input.success)return reply.code(400).send({error:'invalid_contact'});
  try{return await getCustomerTimeline(input.data);}catch{return reply.code(503).send({error:'customer_timeline_unavailable'});}
 });
 app.get('/intelligence/diagnostics',{preHandler:authenticate},async(_request,reply)=>{
  try{return await getCustomerStateDiagnostics();}catch{return reply.code(503).send({error:'customer_diagnostics_unavailable'});}
 });
 app.post('/intelligence/reconcile',{preHandler:authenticate,bodyLimit:64000},async(request,reply)=>{
  const input=reconcile.safeParse(request.body??{});if(!input.success)return reply.code(400).send({error:'invalid_reconciliation_request'});
  const v=input.data;
  try{return await reconcileCustomerState({useAI:v.useAI,maxContacts:v.maxContacts,...(v.contactIds?{contactIds:v.contactIds}:{}),...(v.since?{since:v.since}:{}),...(v.until?{until:v.until}:{})});}catch{return reply.code(503).send({error:'customer_reconciliation_unavailable'});}
 });
}
