import {randomUUID} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {OperationsError,operationsService,signRequest,verifyRequest,authorize,type Actor,type Command,type OperationsService,type PortalJobReference} from "@egc/operations";
import {getDb} from "@egc/database";
import {InboundActionReconciler,type InboundPolicy} from "./inbound-actions.js";
import {syncPortalSchedule} from "./scheduling.js";
import {ensureProviderNote} from "./provider-notes.js";

export function portalAdapter(origin:string,key:string,workspace:string,fetcher:typeof fetch=fetch) {
  const url=new URL(origin);
  if(url.protocol!=="https:" || url.username || url.password || url.pathname!=="/" || url.search || url.hash)
    throw new Error("EGC_PORTAL_ORIGIN must be an HTTPS origin");
  async function read(actor:Actor,body:Command) {
    const envelope=signRequest({v:1,iss:"portal",aud:"egc-portal",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,request:{requestId:randomUUID(),body}},key);
    const response=await fetcher(new URL("/api/operations-portal",url),{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(15000)});
    const result=await response.json() as Record<string,unknown>;
    if(!response.ok){
      const code=typeof result.error==="string"&&/^(?:schedule|record|project|note|job|completion|operational_scope)_[a-z_]+$/.test(result.error)?result.error:"portal_authority_unavailable";
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
  if(!service && env.EGC_OPERATIONS_ENABLED==="true") {
    const workspace=env.EGC_OPERATIONS_WORKSPACE??"egc";
    const bridge=env.EGC_PORTAL_ORIGIN&&env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET?portalAdapter(env.EGC_PORTAL_ORIGIN,env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET,workspace):null;
    service=operationsService({workspace,...(bridge?{resolvePortalJob:bridge.resolve,resolveOwner:bridge.owner,portalRead:bridge.read,syncSchedule:(actor,command)=>syncPortalSchedule(actor,command,bridge.read,{env}),ensureProviderNote:(actor,command)=>ensureProviderNote(actor,command,bridge.read,{service:service!})}:{})});
    if(bridge){const actor:Actor={id:"inbound-response-reconciler",kind:"integration",role:"integration",workspace};inbound=new InboundActionReconciler(getDb(),service,async()=>await bridge.read(actor,{command:"portal.rules"}) as unknown as InboundPolicy,workspace);}
  }
  app.post("/operations/rpc",{bodyLimit:220000},async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(env.EGC_OPERATIONS_ENABLED!=="true"||!service)return reply.code(503).send({error:"operations_not_enabled"});
    try {
      const body=request.body as {envelope?:unknown}|null;
      const claims=verifyRequest(body?.envelope,{...(env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET?{portal:env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET}:{}),...(env.EGC_OPERATIONS_MCP_SIGNING_SECRET?{mcp:env.EGC_OPERATIONS_MCP_SIGNING_SECRET}:{})});
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
  if(inbound){let running=false;const tick=async()=>{if(running)return;running=true;try{const result=await inbound!.run();if(!result.ok)app.log.warn({code:"inbound_reconciliation_needs_attention"},"Inbound action reconciliation requires review; inspect operations status");}catch{app.log.warn({code:"inbound_reconciliation_unavailable"},"Inbound action reconciliation will retry");}finally{running=false;}};const timer=setInterval(()=>void tick(),60000);timer.unref();app.addHook("onReady",async()=>{void tick();});app.addHook("onClose",async()=>{clearInterval(timer);});}
}
