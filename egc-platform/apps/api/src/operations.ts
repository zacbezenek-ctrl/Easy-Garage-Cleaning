import {randomUUID} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {OperationsError,operationsService,signRequest,authorize,SERVICE_ORIGINS,type Actor,type Command,type OperationsService,type PortalJobReference} from "@egc/operations";
import {getDb,schema} from "@egc/database";
import {InboundActionReconciler,type InboundPolicy} from "./inbound-actions.js";
import {syncPortalSchedule} from "./scheduling.js";
import {ensureProviderNote} from "./provider-notes.js";
import {getCanonicalReport,getCustomerTimeline,getCustomerStateDiagnostics} from '@egc/customer-state';
import {reconcileHubBookings} from './booking-worker.js';
import {serviceAuthEnabled,signApiServiceRequest,verifyOperationsClaims} from './service-bridge.js';
import {reconciliationDiagnostic,safeReconciliationCode} from './reconciliation-diagnostics.js';

export function portalAdapter(origin:string,key:string,workspace:string,fetcher:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env) {
  const url=new URL(origin);
  if(url.protocol!=="https:" || url.username || url.password || url.pathname!=="/" || url.search || url.hash)
    throw new Error("EGC_PORTAL_ORIGIN must be an HTTPS origin");
  if(serviceAuthEnabled(env)&&url.origin!==SERVICE_ORIGINS.hub)throw new OperationsError('service_origin_not_trusted',503);
  async function read(actor:Actor,body:Command) {
    const requestId=randomUUID(),path='/api/operations-portal';
    const envelope=serviceAuthEnabled(env)?await signApiServiceRequest(actor,body,path,requestId,env):signRequest({v:1,iss:"portal",aud:"egc-portal",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,request:{requestId,body}},key);
    const response=await fetcher(new URL("/api/operations-portal",url),{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(15000)});
    let result:Record<string,unknown>;
    try{result=await response.json() as Record<string,unknown>;}catch{throw new OperationsError('invalid_json_response',503,{upstreamStatus:response.status});}
    if(!response.ok){
      const code=safeReconciliationCode(result.error)??(typeof result.error==="string"&&/^(?:schedule|record|project|note|job|completion|operational_scope)_[a-z_]+$/.test(result.error)?result.error:"portal_authority_unavailable");
      throw new OperationsError(code,response.status>=500?503:response.status,{upstreamStatus:response.status});
    }
    return result;
  }
  const integration:Actor={id:"operations-api",kind:"integration",role:"integration",workspace};
  return {read,owner:async(id:string)=>{const r=await read(integration,{command:"portal.members"});return r.authority==="employee_hub"&&Array.isArray(r.members)&&r.members.some((m:unknown)=>typeof m==="object"&&m!==null&&(m as {id?:unknown}).id===id);},resolve:async(id:string):Promise<PortalJobReference>=>{
    const result=await read({id:"operations-api",kind:"integration",role:"integration",workspace},{command:"portal.job",jobId:id});
    const job=result.job as PortalJobReference|undefined;
    if(result.authority!=="employee_hub" || !job || job.id!==id || typeof job.revision!=="string")throw new OperationsError("portal_identity_unverified",409);
    return job;
  }};
}
export async function registerOperationsRoutes(app:FastifyInstance,options:{service?:OperationsService;env?:NodeJS.ProcessEnv}={}) {
  const env=options.env??process.env;
  let service=options.service;
  let inbound:InboundActionReconciler|undefined;
  let bookingTick:(()=>Promise<unknown>)|undefined;
  if(!service && env.EGC_OPERATIONS_ENABLED==="true") {
    const workspace=env.EGC_OPERATIONS_WORKSPACE??"egc";
    const bridge=env.EGC_PORTAL_ORIGIN&&(env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET||serviceAuthEnabled(env))?portalAdapter(env.EGC_PORTAL_ORIGIN,env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET??'',workspace,fetch,env):null;
    service=operationsService({workspace,canonicalRead:async(_actor,command)=>{
      if(command.command==='intelligence.report')return getCanonicalReport({since:command.since,until:command.until,...(command.cohortSince?{cohortSince:command.cohortSince}:{}),...(command.cohortUntil?{cohortUntil:command.cohortUntil}:{}),refresh:true});
      if(command.command==='intelligence.customer')return getCustomerTimeline({contactId:command.contactId});
      return getCustomerStateDiagnostics();
    },...(bridge?{resolvePortalJob:bridge.resolve,resolveOwner:bridge.owner,portalRead:bridge.read,syncSchedule:(actor,command)=>syncPortalSchedule(actor,command,bridge.read,{env}),ensureProviderNote:(actor,command)=>ensureProviderNote(actor,command,bridge.read,{service:service!})}:{})});
    if(bridge)bookingTick=()=>reconcileHubBookings(bridge.read,env);
    if(bridge){const actor:Actor={id:"inbound-response-reconciler",kind:"integration",role:"integration",workspace};inbound=new InboundActionReconciler(getDb(),service,async()=>await bridge.read(actor,{command:"portal.rules"}) as unknown as InboundPolicy,workspace);}
  }
  if(bookingTick){let running=false;const mark=async(key:string,value?:string)=>{const now=new Date(),cursor=value??now.toISOString();await getDb().insert(schema.syncCursors).values({key,cursor}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor,updatedAt:now}});};const tick=async()=>{if(running)return;running=true;try{await mark('customer_state:last_booking_attempt');await bookingTick!();await mark('customer_state:last_booking_success');}catch(error){const failure=reconciliationDiagnostic(error);await mark('customer_state:last_booking_failure').catch(()=>{});await mark('customer_state:last_booking_error',JSON.stringify({at:new Date().toISOString(),...failure})).catch(()=>{});app.log.warn({code:'booking_reconciliation_unavailable',...failure},'Hub booking reconciliation needs attention');}finally{running=false;}};const timer=setInterval(()=>void tick(),5*60000);timer.unref();app.addHook('onReady',async()=>{void tick();});app.addHook('onClose',async()=>{clearInterval(timer);});}
  app.post("/operations/rpc",{bodyLimit:220000},async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(env.EGC_OPERATIONS_ENABLED!=="true"||!service)return reply.code(503).send({error:"operations_not_enabled"});
    try {
      const body=request.body as {envelope?:unknown}|null;
      const claims=await verifyOperationsClaims(body?.envelope,env);
      if(claims.request.body.command==="inbound.reconcile"){
        authorize(claims.actor,claims.request.body,env.EGC_OPERATIONS_WORKSPACE??"egc");if(!inbound)throw new OperationsError("inbound_reconciliation_not_configured",503);
        const command=claims.request.body;return reply.send(await inbound.run({limit:command.limit,...(command.lookbackDays?{lookbackDays:command.lookbackDays}:{})}));
      }
      const result=await service.execute(claims.actor,claims.request.body,claims.request.requestId);
      return reply.send(result);
    }catch(e) {
      if(e instanceof OperationsError)return reply.code(e.status).send({error:e.code,...e.details});
      // Never return SQL, signed request data, credentials, or a false empty queue.
      request.log.error({code:"operations_failed",errorName:e instanceof Error?e.name:"unknown"},"Operations request failed");
      return reply.code(503).send({error:"operations_unavailable",retryable:true});
    }
  });
  if(inbound){let running=false;const tick=async()=>{if(running)return;running=true;try{const result=await inbound!.run();if(!result.ok)app.log.warn({code:"inbound_reconciliation_needs_attention",...('failure' in result?result.failure:null)},"Inbound action reconciliation requires review; inspect operations status");}catch(error){app.log.warn({code:"inbound_reconciliation_unavailable",...reconciliationDiagnostic(error,'inbound_activation')},"Inbound action reconciliation will retry");}finally{running=false;}};const timer=setInterval(()=>void tick(),60000);timer.unref();app.addHook("onReady",async()=>{void tick();});app.addHook("onClose",async()=>{clearInterval(timer);});}
}
