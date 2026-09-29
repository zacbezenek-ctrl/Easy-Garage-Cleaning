import type {FastifyInstance} from "fastify";
import {getDb,schema} from "@egc/database";
import {OperationsError,authorize,commandSchema,RECURRING_HORIZON_ACTOR,RECURRING_HORIZON_COMMAND,type Actor,type Command} from "@egc/operations";

/** Scheduled recurring-plan horizon (P1-DS-11), run inside egc-api. With
 * EGC_RECURRING_PLANS_ENABLED exactly "true" and the operations Hub bridge
 * configured, egc-api asks the Employee Hub, hourly, to add the visits every
 * active plan needs inside its horizon: recurring.extend_horizon as the
 * recurring-horizon-worker integration actor, signed by egc-api's existing
 * portal bridge (portalAdapter: v2 service keys or the legacy portal HMAC). No
 * other service holds a bridge signing secret for this run. The Hub is the
 * only writer: it checks its own flag, takes the clock from the signed
 * envelope and derives every visit's request id from the plan and date, so a
 * rerun, an overlapping deploy or a lost response never books a visit twice.
 * Only bounded aggregate counts are logged; no customer data leaves the Hub. */
export const RECURRING_HORIZON_INTERVAL_MS=60*60_000;
export const RECURRING_HORIZON_TIMEOUT_MS=25_000;
export class RecurringHorizonError extends Error {constructor(public code:string,public status=503){super(code);this.name="RecurringHorizonError";}}
export const recurringHorizonEnabled=(env:NodeJS.ProcessEnv)=>env.EGC_RECURRING_PLANS_ENABLED==="true";
/** egc-api's signed Hub bridge call (portalAdapter(...).read). */
export type PortalRead=(actor:Actor,body:Command,options?:{timeoutMs?:number})=>Promise<Record<string,unknown>>;
type HubCall=(body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const CODE=/^[a-z][a-z0-9_]{2,80}$/;
const COUNTS=["created","conflicts","adopted","updated","kept","priced","blocked","errors","attempts"] as const;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const count=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:0;

/** The one horizon command, through the bridge egc-api already signs with. */
export function recurringHorizonClient(read:PortalRead,workspace:string):HubCall{
  const actor:Actor={id:RECURRING_HORIZON_ACTOR,kind:"integration",role:"integration",workspace};
  return async body=>{
    const parsed=commandSchema.safeParse(body);
    if(!parsed.success||parsed.data.command!==RECURRING_HORIZON_COMMAND)throw new RecurringHorizonError("recurring_horizon_invalid",400);
    authorize(actor,parsed.data,workspace);
    let result:unknown;
    try{result=await read(actor,parsed.data,{timeoutMs:RECURRING_HORIZON_TIMEOUT_MS});}
    catch(error){
      // The bridge relays only allowlisted snake_case Hub codes; a network failure or timeout is unavailable.
      if(error instanceof OperationsError&&CODE.test(error.code))throw new RecurringHorizonError(error.code==="invalid_json_response"?"recurring_bridge_invalid_response":error.code,error.status>=500?503:error.status);
      throw new RecurringHorizonError("recurring_bridge_unavailable");
    }
    if(!record(result))throw new RecurringHorizonError("recurring_bridge_invalid_response");
    return result;
  };
}

export type RecurringHorizonSummary={enabled:boolean;complete:boolean;rounds:number;truncated:boolean}&Record<typeof COUNTS[number],number>;
/** Pages through every plan with work: each call is bounded by maxPlans and
 * limit on the Hub, and the tick stops after maxRounds calls. */
export async function runRecurringHorizon(call:HubCall,{maxRounds=12,maxPlans=10,limit=4}:{maxRounds?:number;maxPlans?:number;limit?:number}={}):Promise<RecurringHorizonSummary>{
  const summary:RecurringHorizonSummary={enabled:true,complete:false,rounds:0,truncated:false,created:0,conflicts:0,adopted:0,updated:0,kept:0,priced:0,blocked:0,errors:0,attempts:0};
  let after:string|null=null;
  while(summary.rounds<maxRounds){
    const result=await call({command:RECURRING_HORIZON_COMMAND,...(after?{after}:{}),maxPlans,limit});
    summary.rounds++;
    if(result.ok!==true||result.authority!=="employee_hub"||result.command!==RECURRING_HORIZON_COMMAND||typeof result.enabled!=="boolean")throw new RecurringHorizonError("recurring_bridge_invalid_response");
    if(!result.enabled)return {...summary,enabled:false,complete:true};
    if(typeof result.more!=="boolean"||!(result.after===null||typeof result.after==="string")||!record(result.totals))throw new RecurringHorizonError("recurring_bridge_invalid_response");
    for(const key of COUNTS)summary[key]+=count(result.totals[key]);
    if(!result.more)return {...summary,complete:result.complete===true};
    after=result.after as string|null;
  }
  return {...summary,truncated:true};
}

type Cursor=(key:string,value:string)=>Promise<unknown>;
const cursor:Cursor=async(key,value)=>getDb().insert(schema.syncCursors).values({key,cursor:value}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor:value,updatedAt:new Date()}});
type Logger=Pick<Console,"log"|"error">;
export type RecurringHorizonWorkerOptions={env?:NodeJS.ProcessEnv;intervalMs?:number;run:()=>Promise<RecurringHorizonSummary>;mark?:Cursor;logger?:Logger;now?:()=>Date};

/** Hourly loop. Off (no timer at all) unless the flag is on. */
export function startRecurringHorizonWorker({env=process.env,intervalMs=RECURRING_HORIZON_INTERVAL_MS,run,mark=cursor,logger=console,now=()=>new Date()}:RecurringHorizonWorkerOptions){
  if(!recurringHorizonEnabled(env))return ()=>{};
  let running=false,stopped=false;
  async function tick(){
    if(running||stopped)return;running=true;
    try{
      await mark("recurring_horizon:last_attempt",now().toISOString());
      const result=await run();
      await mark(result.complete?"recurring_horizon:last_success":"recurring_horizon:last_incomplete",now().toISOString());
      await mark("recurring_horizon:last_result",JSON.stringify({at:now().toISOString(),...result}));
      logger.log(JSON.stringify({event:"recurring_horizon_run",...result}));
    }catch(error){
      const code=error instanceof RecurringHorizonError&&CODE.test(error.code)?error.code:"recurring_horizon_failed";
      await mark("recurring_horizon:last_failure",JSON.stringify({at:now().toISOString(),code})).catch(()=>{});
      logger.error(`Recurring plan horizon run failed (${code}); the next hourly run retries safely.`);
    }finally{running=false;}
  }
  void tick();
  const timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();
  return ()=>{stopped=true;clearInterval(timer);};
}

/** Wires the hourly run into egc-api: it starts when the API is ready and stops
 * on close. Nothing is scheduled unless EGC_RECURRING_PLANS_ENABLED is "true". */
export function registerRecurringHorizon(app:FastifyInstance,{env,read,workspace,start=startRecurringHorizonWorker}:{env:NodeJS.ProcessEnv;read:PortalRead;workspace:string;start?:(options:RecurringHorizonWorkerOptions)=>()=>void}){
  if(!recurringHorizonEnabled(env))return false;
  const call=recurringHorizonClient(read,workspace);
  let stop:(()=>void)|null=null;
  app.addHook("onReady",async()=>{stop=start({env,run:()=>runRecurringHorizon(call),logger:{log:line=>app.log.info(line),error:line=>app.log.warn(line)}});});
  app.addHook("onClose",async()=>{stop?.();stop=null;});
  return true;
}
