import {runCustomerSemanticQueue,recordUserConfirmedOutcome} from '@egc/customer-state';
import {validateUserConfirmedOutcome} from '@egc/customer-state/core';
import {getDb,schema} from '@egc/database';

/** Operator-supplied assertions are data, not hard-coded customer exceptions.
 * Deterministic assertion IDs make restart/redeployment idempotent. */
export async function importConfirmedOutcomes(env:NodeJS.ProcessEnv=process.env){
 if(!env.EGC_USER_CONFIRMED_BOOTSTRAP_JSON)return {imported:0};
 let input:unknown;try{input=JSON.parse(env.EGC_USER_CONFIRMED_BOOTSTRAP_JSON);}catch{throw new Error('invalid_confirmation_bootstrap');}
 if(!Array.isArray(input)||input.length>100)throw new Error('invalid_confirmation_bootstrap');
 const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
 const iso=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
 // Validate the complete batch before persisting any entry. Values cannot supply
 // an actor; every imported assertion is attributed to this verified channel.
 for(const value of input){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.contactId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.contactId)||!text(value.field,100)||!Object.hasOwn(value,'value')||!text(value.exactText,12000)||!text(value.sourceReference,2000)||['assertedAt','occurredAt'].some(key=>value[key]!==undefined&&!iso(value[key]))||(value.valueCents!==undefined&&(!Number.isSafeInteger(value.valueCents)||value.valueCents<0||value.valueCents>2147483647))||(value.currency!==undefined&&value.currency!=='USD')||(value.idempotencyKey!==undefined&&!text(value.idempotencyKey,200)))throw new Error('invalid_confirmation_bootstrap');
  try{validateUserConfirmedOutcome(value);}catch{throw new Error('invalid_confirmation_bootstrap');}
 }
 for(const value of input){
  await recordUserConfirmedOutcome({...value,actorId:'authorized-user-confirmation-import'});
 }
 return {imported:input.length};
}

export function startCustomerStateWorker({reconcile=runCustomerSemanticQueue,intervalMs=60_000,logger=console,env=process.env}:{reconcile?:typeof runCustomerSemanticQueue;intervalMs?:number;logger?:Pick<Console,'log'|'error'>;env?:NodeJS.ProcessEnv}={}){
 let running=false,stopped=false,bootstrapped=false;
 const cursor=async(key:string,value:string)=>getDb().insert(schema.syncCursors).values({key,cursor:value}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor:value,updatedAt:new Date()}});
 async function tick(){
  if(running||stopped)return;running=true;
  try{
   if(!bootstrapped){await importConfirmedOutcomes(env);bootstrapped=true;}
   await cursor('customer_state:last_attempt',new Date().toISOString());
   const result=await reconcile({since:new Date(Date.now()-30*86400000),limit:12,concurrency:3,deadlineMs:150_000,stopped:()=>stopped});
   await cursor(result.failed||result.truncated||result.partialCustomers||result.pending>0||result.complete===false?'customer_state:last_failure':'customer_state:last_success',new Date().toISOString());
   const completeSemantic=result.complete===true&&!result.failed&&!result.truncated&&result.pending===0;
   if(completeSemantic)await cursor('customer_state:last_complete_extraction',new Date().toISOString());
   const aggregate=Object.fromEntries(Object.entries(result).filter(([,v])=>typeof v==='number'||typeof v==='boolean'));
   logger.log(JSON.stringify({event:'customer_state_reconciled',...aggregate}));
  }catch{await cursor('customer_state:last_failure',new Date().toISOString()).catch(()=>{});logger.error('Customer state reconciliation failed; inspect canonical diagnostics.');}
  finally{running=false;}
 }
 void tick();const timer=setInterval(()=>void tick(),intervalMs);return()=>{stopped=true;clearInterval(timer);};
}
