import {getDb,schema} from '@egc/database';
import {SERVICE_ORIGINS,signServiceRequest} from '@egc/operations';

/** Signed trigger for the Hub's server-side messaging schedule. The Hub owns
 * every decision (approved templates, the owner's automation switches, quiet
 * hours and the claim-once send ledger); this loop only asks it to run one
 * bounded tick. Off unless EGC_MESSAGING_CRON_ENABLED=true. */
export const MESSAGING_CRON_PATH='/api/messaging-cron';
export const MESSAGING_CRON_ACTOR_ID='messaging-cron-worker';
const RESULT_CURSOR='messaging_cron:last_result';
const SUCCESS_CURSOR='messaging_cron:last_success';
type Env=Record<string,string|undefined>;
type Fetcher=(url:string,init:RequestInit)=>Promise<Response>;
type Recorder=(key:string,value:string)=>Promise<unknown>;
type Logger=Pick<Console,'error'>&Partial<Pick<Console,'info'>>;
export type MessagingCronStatus='completed'|'disabled'|'rejected'|'failed'|'unknown'|'not_configured';
export type MessagingCronResult={status:MessagingCronStatus;code:string;httpStatus:number|null;counts:Record<string,number|boolean|string|null>};
export type MessagingCronTick=(options:{env:Env;now:()=>number})=>Promise<MessagingCronResult>;

const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const flag=(value:unknown)=>typeof value==='boolean'?value:null;
const safeCode=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value)?value:'';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Aggregate counts only: never job ids, customer data, message text, envelopes or provider errors. */
export function messagingCronCounts(summary:unknown){
 const row=object(summary)?summary:{};
 return {scanned:count(row.scanned),due:count(row.due),attempted:count(row.attempted),sent:count(row.sent),limitReached:flag(row.limitReached),budgetExhausted:flag(row.budgetExhausted),dryRun:flag(row.dryRun),quietHours:row.deferred==='quiet_hours',paused:row.paused===true};
}

/** FUN-13 website-lead retry counts, only when the Hub ran a retry pass: counts and codes, never lead data. */
export function webLeadRetryCounts(webLeads:unknown){
 if(!object(webLeads))return {};
 return {webLeadsDue:count(webLeads.due),webLeadsAttempted:count(webLeads.attempted),webLeadsSynced:count(webLeads.synced),webLeadsFailed:count(webLeads.failed),webLeadsAbandoned:count(webLeads.abandoned),webLeadsHeld:count(webLeads.held),webLeadsPurged:count(webLeads.purged),webLeadsNotAttempted:count(webLeads.notAttempted),webLeadsDeferred:safeCode(webLeads.deferred)||null,webLeadsUnavailable:webLeads.error==='web_lead_retry_unavailable'};
}

/** One signed POST. A lost response is safe to leave: the next tick signs a
 * new request and the Hub's ledger never delivers a claimed message twice. */
export async function runMessagingCronTick({env=process.env,fetcher=fetch,sign=signServiceRequest,now=Date.now,requestId=()=>crypto.randomUUID(),timeoutMs=120_000}:{env?:Env;fetcher?:Fetcher;sign?:typeof signServiceRequest;now?:()=>number;requestId?:()=>string;timeoutMs?:number}={}):Promise<MessagingCronResult>{
 const workspace=env.EGC_OPERATIONS_WORKSPACE??'egc',body:Record<string,unknown>={command:'messaging.run',...(env.EGC_MESSAGING_CRON_DRY_RUN==='true'?{dryRun:true}:{})};
 let envelope:string;
 try{envelope=await sign({service:'api',rootSecret:env.API_BEARER_TOKEN??'',workspace,path:MESSAGING_CRON_PATH,actor:{id:MESSAGING_CRON_ACTOR_ID,kind:'integration',role:'integration',workspace},request:{requestId:requestId(),body},now:now()});}
 catch{return {status:'not_configured',code:'service_signing_not_configured',httpStatus:null,counts:{}};}
 let response:Response;
 try{response=await fetcher(SERVICE_ORIGINS.hub+MESSAGING_CRON_PATH,{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(timeoutMs)});}
 catch{return {status:'unknown',code:'hub_unreachable',httpStatus:null,counts:{}};}
 let payload:Record<string,unknown>={};
 try{const parsed:unknown=await response.json();if(object(parsed))payload=parsed;}catch{/* A non-JSON reply is classified by status only. */}
 const code=safeCode(payload.code),leads=webLeadRetryCounts(payload.webLeads);
 if(response.ok&&payload.ok===true)return {status:'completed',code:'',httpStatus:response.status,counts:{...messagingCronCounts(payload.summary),...leads}};
 if(response.status===409&&code==='messaging_cron_disabled')return {status:'disabled',code,httpStatus:409,counts:leads};
 return {status:response.status>=500?'failed':'rejected',code:code||`http_${response.status}`,httpStatus:response.status,counts:{}};
}

async function recordCursor(key:string,cursor:string){
 await getDb().insert(schema.syncCursors).values({key,cursor}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor,updatedAt:new Date()}});
}

export function startMessagingCronWorker({env=process.env,intervalMs=15*60_000,tick=options=>runMessagingCronTick(options),record=recordCursor,logger=console,now=Date.now}:{env?:Env;intervalMs?:number;tick?:MessagingCronTick;record?:Recorder;logger?:Logger;now?:()=>number}={}){
 if(env.EGC_MESSAGING_CRON_ENABLED!=='true')return ()=>{};
 let running=false,stopped=false;
 const run=async()=>{
  if(running||stopped)return;running=true;
  try{
   const result=await tick({env,now}),observedAt=new Date(now()).toISOString();
   const line={event:'messaging_cron',status:result.status,code:result.code,httpStatus:result.httpStatus,...result.counts,observedAt};
   await record(RESULT_CURSOR,JSON.stringify(line)).catch(()=>{});
   if(result.status==='completed')await record(SUCCESS_CURSOR,observedAt).catch(()=>{});
   logger.info?.(JSON.stringify(line));
   if(!['completed','disabled'].includes(result.status))logger.error('Messaging cron tick did not complete; inspect messaging_runs in the Hub.');
   if(Number(result.counts.webLeadsAbandoned)>0||result.counts.webLeadsUnavailable===true)logger.error('Website lead HighLevel retries were abandoned or unavailable; inspect web_lead_receipts in Firestore.');
  }catch{logger.error('Messaging cron tick failed; inspect messaging_runs in the Hub.');}
  finally{running=false;}
 };
 void run();const timer=setInterval(()=>void run(),intervalMs);timer.unref?.();
 return ()=>{stopped=true;clearInterval(timer);};
}
