import {getDb,schema} from '@egc/database';
import {SERVICE_ORIGINS,signServiceRequest} from '@egc/operations';

/** GHL-TRACK-1: signed trigger for the Hub's HighLevel tag outbox drain. The Hub
 * owns every decision (which entries are due, the claim, the backoff and the
 * parking); this loop only asks it to run one bounded pass every 2 minutes. It
 * never talks to HighLevel itself. Each completed pass is also the worker's
 * check-in on the Hub: when none arrives for 10 minutes the Hub's Command center
 * says the tag worker has stopped. Off unless EGC_GHL_TAG_DRAIN_ENABLED=true. */
export const GHL_TAG_DRAIN_PATH='/api/ghl-tag-drain';
/** Must equal GHL_TAG_WORKER_ID in functions/api/ghl-tag-drain.js. */
export const GHL_TAG_WORKER_ACTOR_ID='ghl-tag-worker';
export const GHL_TAG_DRAIN_INTERVAL_MS=2*60_000;
const RESULT_CURSOR='ghl_tag_drain:last_result';
const SUCCESS_CURSOR='ghl_tag_drain:last_success';
type Env=Record<string,string|undefined>;
type Fetcher=(url:string,init:RequestInit)=>Promise<Response>;
type Recorder=(key:string,value:string)=>Promise<unknown>;
type Logger=Pick<Console,'error'>&Partial<Pick<Console,'info'>>;
export type GhlTagDrainStatus='completed'|'disabled'|'rejected'|'failed'|'unknown'|'not_configured';
export type GhlTagDrainResult={status:GhlTagDrainStatus;code:string;httpStatus:number|null;counts:Record<string,number|boolean|null>};
export type GhlTagDrainTick=(options:{env:Env;now:()=>number})=>Promise<GhlTagDrainResult>;

const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const safeCode=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value)?value:'';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Counts only: never job ids, contact ids, tags or provider errors. */
export function ghlTagDrainCounts(summary:unknown){
 const row=object(summary)?summary:{};
 return {due:count(row.due),attempted:count(row.attempted),done:count(row.done),waiting:count(row.waiting),retrying:count(row.retrying),parked:count(row.parked),skipped:count(row.skipped),busy:count(row.busy),truncated:typeof row.truncated==='boolean'?row.truncated:null};
}

/** One signed POST. A lost response is safe to leave: the Hub claims each entry before
 * HighLevel is called, and the next tick signs a new request. */
export async function runGhlTagDrainTick({env=process.env,fetcher=fetch,sign=signServiceRequest,now=Date.now,requestId=()=>crypto.randomUUID(),timeoutMs=90_000}:{env?:Env;fetcher?:Fetcher;sign?:typeof signServiceRequest;now?:()=>number;requestId?:()=>string;timeoutMs?:number}={}):Promise<GhlTagDrainResult>{
 const workspace=env.EGC_OPERATIONS_WORKSPACE??'egc';
 let envelope:string;
 try{envelope=await sign({service:'api',rootSecret:env.API_BEARER_TOKEN??'',workspace,path:GHL_TAG_DRAIN_PATH,actor:{id:GHL_TAG_WORKER_ACTOR_ID,kind:'integration',role:'integration',workspace},request:{requestId:requestId(),body:{command:'ghl_tags.drain'}},now:now()});}
 catch{return {status:'not_configured',code:'service_signing_not_configured',httpStatus:null,counts:{}};}
 let response:Response;
 try{response=await fetcher(SERVICE_ORIGINS.hub+GHL_TAG_DRAIN_PATH,{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(timeoutMs)});}
 catch{return {status:'unknown',code:'hub_unreachable',httpStatus:null,counts:{}};}
 let payload:Record<string,unknown>={};
 try{const parsed:unknown=await response.json();if(object(parsed))payload=parsed;}catch{/* A non-JSON reply is classified by status only. */}
 const code=safeCode(payload.code);
 if(response.ok&&payload.ok===true)return {status:'completed',code:'',httpStatus:response.status,counts:ghlTagDrainCounts(payload.summary)};
 if(response.status===409&&code==='ghl_tag_outbox_disabled')return {status:'disabled',code,httpStatus:409,counts:{}};
 return {status:response.status>=500?'failed':'rejected',code:code||`http_${response.status}`,httpStatus:response.status,counts:{}};
}

async function recordCursor(key:string,cursor:string){
 await getDb().insert(schema.syncCursors).values({key,cursor}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor,updatedAt:new Date()}});
}

export function startGhlTagWorker({env=process.env,intervalMs=GHL_TAG_DRAIN_INTERVAL_MS,tick=options=>runGhlTagDrainTick(options),record=recordCursor,logger=console,now=Date.now}:{env?:Env;intervalMs?:number;tick?:GhlTagDrainTick;record?:Recorder;logger?:Logger;now?:()=>number}={}){
 if(env.EGC_GHL_TAG_DRAIN_ENABLED!=='true')return ()=>{};
 let running=false,stopped=false;
 const run=async()=>{
  if(running||stopped)return;running=true;
  try{
   const result=await tick({env,now}),observedAt=new Date(now()).toISOString();
   const line={event:'ghl_tag_drain',status:result.status,code:result.code,httpStatus:result.httpStatus,...result.counts,observedAt};
   await record(RESULT_CURSOR,JSON.stringify(line)).catch(()=>{});
   if(result.status==='completed')await record(SUCCESS_CURSOR,observedAt).catch(()=>{});
   logger.info?.(JSON.stringify(line));
   if(!['completed','disabled'].includes(result.status))logger.error('HighLevel tag drain tick did not complete; inspect ghlTagOutbox in the Hub.');
   else if(Number(result.counts.parked)>0)logger.error('HighLevel tag outbox entries were parked; a manager can retry them from the Hub Command center.');
  }catch{logger.error('HighLevel tag drain tick failed; inspect ghlTagOutbox in the Hub.');}
  finally{running=false;}
 };
 void run();const timer=setInterval(()=>void run(),intervalMs);timer.unref?.();
 return ()=>{stopped=true;clearInterval(timer);};
}
