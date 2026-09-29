import type {FastifyInstance} from "fastify";
import type {Actor} from "@egc/operations";

/** Server-driven HighLevel calendar mirror (P1-DS-02). Each tick asks the Hub for the
 * due operations-owned visits (schedule.sync_due, which is also the worker's check-in),
 * runs the existing schedule.sync_provider for each one with automations off (a calendar
 * mirror, never a customer message) and hands every failure back to the Hub
 * (schedule.sync_failed), which owns the backoff. The requestId is the Hub's mirror key
 * for the current change (never the page's visit key or an MCP requestId), so a
 * rerun replays the provider ledger instead of writing again. Off unless
 * EGC_SCHEDULE_SYNC_WORKER=true. Type-only imports keep this module loadable by the
 * root Hub tests. */
type Json=Record<string,unknown>;
type Env=Record<string,string|undefined>;
type Logger=Pick<Console,"error">&Partial<Pick<Console,"info">>;
type Item={portalVisitId:string;requestId:string;expectedRevision:string};
export type ScheduleSyncExecute=(actor:Actor,body:Json,requestId:string)=>Promise<Json>;
export type ScheduleSyncStatus="completed"|"disabled"|"rejected"|"failed";
/** The Hub's queue state at selection: owned visits awaiting a mirror, those waiting out a
 * backoff, those parked for a manager's Retry, and the age of the oldest failure (null if none). */
export type ScheduleSyncBacklog={owned:number;backingOff:number;parked:number;oldestFailureMinutes:number|null};
export type ScheduleSyncResult={status:ScheduleSyncStatus;code:string;counts:Record<string,number|boolean>;backlog?:ScheduleSyncBacklog};
export type ScheduleSyncTick=(options:{now:()=>number})=>Promise<ScheduleSyncResult>;
/** Must equal SCHEDULE_SYNC_WORKER_ID in @egc/operations contracts (checked by a test). */
export const SCHEDULE_SYNC_WORKER_ACTOR_ID="schedule-sync-worker";
export const SCHEDULE_SYNC_BATCH_LIMIT=25;
const RESULT_CURSOR="schedule_sync:last_result",SUCCESS_CURSOR="schedule_sync:last_success";
const DISABLED="schedule_sync_queue_disabled";
// The visit changed after selection (its mirror landed or it was rescheduled); the next tick re-reads it.
const CHANGED_SINCE_SELECTION=new Set(["schedule_revision_conflict","schedule_sync_changed_since_selection"]);
// The provider held a different schedule than the Hub when the sync tried to bind, or no longer
// held the bound event when the sync read it back (schedule_provider_drift): a concurrent writer
// won a race and the Hub re-queued the visit under a drift key. Never benign.
const STATE_CONFLICTS:ReadonlySet<string>=new Set(["schedule_provider_state_conflict","schedule_provider_drift"]);
const safeCode=(value:unknown)=>typeof value==="string"&&/^[a-z][a-z0-9_]{0,63}$/.test(value)?value:"";
const object=(value:unknown):value is Json=>!!value&&typeof value==="object"&&!Array.isArray(value);
function failureOf(error:unknown){const e:Json=object(error)?error:{};return {code:safeCode(e.code),status:typeof e.status==="number"?e.status:null};}
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):0;
function backlogOf(result:Json,at:number):ScheduleSyncBacklog{
 const counts=object(result.counts)?result.counts:{},since=typeof result.oldestFailureAt==="string"?Date.parse(result.oldestFailureAt):Number.NaN;
 return {owned:count(counts.owned),backingOff:count(counts.backingOff),parked:count(counts.parked),oldestFailureMinutes:Number.isFinite(since)?Math.max(0,Math.floor((at-since)/60000)):null};
}

/** The Hub's answer is checked item by item; anything unverifiable stops the tick. */
function dueItems(result:Json,limit:number):Item[]|null{
 if(result.ok!==true||result.authority!=="employee_hub"||!Array.isArray(result.items)||result.items.length>limit)return null;
 const items:Item[]=[],seen=new Set<string>();
 for(const value of result.items){
  if(!object(value)||typeof value.portalVisitId!=="string"||!/^[A-Za-z0-9_-]{1,180}$/.test(value.portalVisitId)||/^(_egc_|secure_)/.test(value.portalVisitId)||seen.has(value.portalVisitId))return null;
  if(typeof value.requestId!=="string"||!/^[A-Za-z0-9:._-]{1,250}$/.test(value.requestId)||typeof value.expectedRevision!=="string"||!value.expectedRevision||value.expectedRevision.length>200)return null;
  seen.add(value.portalVisitId);items.push({portalVisitId:value.portalVisitId,requestId:value.requestId,expectedRevision:value.expectedRevision});
 }
 return items;
}

/** One bounded pass, sequential, stopping new syncs after deadlineMs. Aggregate counts only.
 * The Hub flag turned off mid-tick stops the pass at the next recorded failure (sync_failed
 * answers schedule_sync_queue_disabled); schedule.sync_provider never reads the flag, so the
 * selected visits that sync cleanly before that still sync, under the mirror's own key. */
export async function runScheduleSyncTick({execute,workspace="egc",limit=SCHEDULE_SYNC_BATCH_LIMIT,now=Date.now,requestId=()=>crypto.randomUUID(),deadlineMs=100_000}:{execute:ScheduleSyncExecute;workspace?:string;limit?:number;now?:()=>number;requestId?:()=>string;deadlineMs?:number}):Promise<ScheduleSyncResult>{
 const actor:Actor={id:SCHEDULE_SYNC_WORKER_ACTOR_ID,kind:"integration",role:"integration",workspace},started=now();
 let items:Item[]|null,due=0,complete=false,heartbeat=false,backlog:ScheduleSyncBacklog;
 try{
  const result=await execute(actor,{command:"schedule.sync_due",limit},requestId());
  items=dueItems(result,limit);
  complete=object(result.coverage)&&result.coverage.complete===true;
  heartbeat=result.heartbeat===true;
  due=object(result.counts)&&Number.isSafeInteger(result.counts.due)?Number(result.counts.due):items?.length??0;
  backlog=backlogOf(result,started);
 }catch(error){
  const {code,status}=failureOf(error);
  if(code===DISABLED)return {status:"disabled",code,counts:{}};
  return {status:status!==null&&status<500?"rejected":"failed",code:code||"schedule_sync_queue_unavailable",counts:{}};
 }
 if(!items)return {status:"failed",code:"schedule_sync_queue_unverified",counts:{}};
 const counts={due,selected:items.length,synced:0,notNeeded:0,failed:0,conflicts:0,stateConflicts:0,unrecorded:0,deferred:0,complete,heartbeat};
 for(const [index,item] of items.entries()){
  if(now()-started>=deadlineMs){counts.deferred=items.length-index;break;}
  let code:string;
  try{
   const result=await execute(actor,{command:"schedule.sync_provider",portalVisitId:item.portalVisitId,requestId:item.requestId,runAutomations:false},requestId());
   const exact=result.ok===true&&result.authority==="employee_hub"&&result.portalVisitId===item.portalVisitId;
   if(exact&&result.providerSync==="verified"){counts.synced++;continue;}
   if(exact&&result.providerSync==="not_needed"){counts.notNeeded++;continue;}
   code="schedule_provider_response_unverified";
  }catch(error){code=failureOf(error).code||"schedule_provider_sync_unavailable";}
  if(STATE_CONFLICTS.has(code))counts.stateConflicts++;
  const id=requestId();
  try{await execute(actor,{command:"schedule.sync_failed",requestId:id,portalVisitId:item.portalVisitId,expectedRevision:item.expectedRevision,syncRequestId:item.requestId,code},id);counts.failed++;}
  catch(error){
   const failure=failureOf(error);
   if(failure.code===DISABLED){counts.deferred=items.length-index;return {status:"disabled",code:DISABLED,counts,backlog};}
   if(failure.status===409&&CHANGED_SINCE_SELECTION.has(failure.code)){if(!STATE_CONFLICTS.has(code))counts.conflicts++;continue;}
   // Without a recorded backoff every item would be retried at once next tick, so stop here.
   counts.unrecorded++;counts.deferred=items.length-index-1;break;
  }
 }
 return {status:"completed",code:"",counts,backlog};
}

/** What the owner should look at after a tick; empty when nothing needs attention. */
export function scheduleSyncAlerts(result:ScheduleSyncResult):string[]{
 const c=result.counts,alerts:string[]=[];
 if(!["completed","disabled"].includes(result.status))alerts.push("the tick did not complete");
 if(c.unrecorded)alerts.push("a failure could not be recorded");
 if(c.complete===false)alerts.push("the queue scan was capped, so some visits were not considered");
 if(Number(c.selected)>0&&c.failed===c.selected)alerts.push("every selected sync failed");
 if(Number(c.stateConflicts)>0)alerts.push("HighLevel held a different schedule than the Hub");
 if(result.backlog&&result.backlog.parked>0)alerts.push("visits stopped retrying and need a manager's Retry in the Hub");
 return alerts;
}

export function startScheduleSyncWorker({env=process.env,tick,record,logger=console,intervalMs=120_000,now=Date.now}:{env?:Env;tick:ScheduleSyncTick;record:(key:string,value:string)=>Promise<unknown>;logger?:Logger;intervalMs?:number;now?:()=>number}){
 if(env.EGC_SCHEDULE_SYNC_WORKER!=="true")return ()=>{};
 let running=false,stopped=false;
 const run=async()=>{
  if(running||stopped)return;running=true;
  try{
   const result=await tick({now}),observedAt=new Date(now()).toISOString();
   const line={event:"schedule_sync",status:result.status,code:result.code,...result.counts,...(result.backlog?{backlog:result.backlog}:{}),observedAt};
   await record(RESULT_CURSOR,JSON.stringify(line)).catch(()=>{});
   if(result.status==="completed")await record(SUCCESS_CURSOR,observedAt).catch(()=>{});
   logger.info?.(JSON.stringify(line));
   const alerts=scheduleSyncAlerts(result);
   if(alerts.length)logger.error(`Schedule sync needs attention: ${alerts.join("; ")}. Inspect schedule_sync:last_result.`);
  }catch{logger.error("Schedule sync tick failed; inspect schedule_sync:last_result.");}
  finally{running=false;}
 };
 void run();const timer=setInterval(()=>void run(),intervalMs);timer.unref?.();
 return ()=>{stopped=true;clearInterval(timer);};
}

/** API wiring: starts on onReady, stops on onClose. `execute` is OperationsService.execute
 * over the Hub bridge; without it the flag only logs that the loop cannot run. */
export function registerScheduleSyncWorker(app:Pick<FastifyInstance,"addHook"|"log">,{env,execute,record,intervalMs}:{env:Env;execute:ScheduleSyncExecute|undefined;record:(key:string,value:string)=>Promise<unknown>;intervalMs?:number}){
 if(env.EGC_SCHEDULE_SYNC_WORKER!=="true")return;
 if(!execute){app.log.warn({code:"schedule_sync_worker_not_configured"},"EGC_SCHEDULE_SYNC_WORKER is on but operations or the Hub bridge is not configured");return;}
 const workspace=env.EGC_OPERATIONS_WORKSPACE??"egc";
 let stop=()=>{};
 app.addHook("onReady",async()=>{stop=startScheduleSyncWorker({env,tick:({now})=>runScheduleSyncTick({execute,workspace,now}),record,logger:{info:line=>app.log.info(line),error:message=>app.log.error(message)},...(intervalMs?{intervalMs}:{})});});
 app.addHook("onClose",async()=>{stop();});
}
