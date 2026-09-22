import {createHash} from 'node:crypto';
import {and,eq,gte,or,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {GhlClient} from '@egc/ghl';

type Json=Record<string,unknown>;
type Provider=Pick<GhlClient,'downloadCallTranscript'|'getCallTranscript'>;
export type ParsedTranscript={text:string;segments:Json[];contentHash:string};
export type TranscriptRetryState={status:'complete'|'pending'|'failed';attemptCount:number;attemptedAt:string;nextAttemptAt:string|null;error:string|null;contentHash?:string};
export type TranscriptCandidate={callId:string;providerMessageId:string;contactId:string;existingText:string|null;retry:TranscriptRetryState|null};
export interface TranscriptRecoveryStore {
 listCandidates(since:Date,limit:number):Promise<TranscriptCandidate[]>;
 persist(callId:string,transcript:ParsedTranscript):Promise<boolean>;
 saveRetry(callId:string,state:TranscriptRetryState):Promise<void>;
 saveRun(result:Json):Promise<void>;
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const object=(value:unknown):Json=>value&&typeof value==='object'&&!Array.isArray(value)?value as Json:{};
const unavailable=/^(?:(?:null|undefined)[.!\s]*$|(?:no transcript(?:ion)?(?: found| available)?|transcript(?:ion)? (?:not found|unavailable|pending|processing)|failed to (?:retrieve|fetch|download) transcript|not found|unauthorized|forbidden|internal server error|service unavailable)(?:$|[.!:\s]))/i;
function usableText(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const text=value.replace(/^\uFEFF/,'').trim();
 return !text||unavailable.test(text)||/^<(?:!doctype|html|head|body)\b/i.test(text)?null:text;
}
/** Only transcript-bearing fields are interpreted. HTTP error bodies and provider
 * status messages must never become customer evidence. */
export function parseProviderTranscript(payload:unknown,depth=0):ParsedTranscript|null{
 if(depth>5)return null;
 if(typeof payload==='string'){
  const text=usableText(payload);if(!text)return null;
  if(/^[\[{]/.test(text)){try{return parseProviderTranscript(JSON.parse(text),depth+1);}catch{return null;}}
  return {text,segments:[],contentHash:hash(text)};
 }
 if(Array.isArray(payload)){
  const parts=payload.map(p=>parseProviderTranscript(p,depth+1)).filter((v):v is ParsedTranscript=>v!==null);
  if(!parts.length)return null;
  const text=parts.map(p=>p.text).join('\n');return {text,segments:parts.flatMap(p=>p.segments.length?p.segments:[{text:p.text}]),contentHash:hash(text)};
 }
 const row=object(payload);
 if(row.error!==undefined||row.success===false||(typeof row.statusCode==='number'&&row.statusCode>=400))return null;
 for(const field of ['transcript','transcription','text'])if(row[field]!==undefined){
  const part=parseProviderTranscript(row[field],depth+1);if(part){const segment:Json={text:part.text};for(const key of ['speaker','speakerId','startTime','endTime','start','end'])if(typeof row[key]==='string'||typeof row[key]==='number')segment[key]=row[key];return {...part,segments:part.segments.length?part.segments:[segment]};}
 }
 for(const field of ['segments','transcripts','transcriptions','data','result'])if(row[field]!==undefined){const part=parseProviderTranscript(row[field],depth+1);if(part)return part;}
 return null;
}

export async function persistProviderTranscript(callId:string,payload:unknown){
 const transcript=parseProviderTranscript(payload);if(!transcript)return false;
 const db=getDb(),[old]=await db.select({text:schema.callTranscripts.text}).from(schema.callTranscripts).where(eq(schema.callTranscripts.callId,callId)).limit(1);
 if(old?.text===transcript.text&&parseProviderTranscript(old.text)?.contentHash===transcript.contentHash)return false;
 const values={callId,text:transcript.text,segments:transcript.segments,providerPayload:{source:'ghl_provider_transcript',contentHash:transcript.contentHash},updatedAt:new Date()};
 await db.insert(schema.callTranscripts).values(values).onConflictDoUpdate({target:schema.callTranscripts.callId,set:values,setWhere:sql`${schema.callTranscripts.text} is distinct from excluded.text`});
 return true;
}
function retryState(value:string|null|undefined):TranscriptRetryState|null{
 try{const row=JSON.parse(value??'null');return row&&typeof row==='object'&&Number.isSafeInteger(row.attemptCount)&&row.attemptCount>=0?row:null;}catch{return null;}
}
export function transcriptRecoveryStore():TranscriptRecoveryStore{
 const db=getDb(),save=async(key:string,cursor:string)=>{await db.insert(schema.syncCursors).values({key,cursor}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor,updatedAt:new Date()}});};
 return {
  async listCandidates(since,limit){
   // Failed/placeholder rows are recoverable too. Old calls on active customer
   // projections remain eligible even after acquisition ages out of the window.
   const rows=await db.select({callId:schema.calls.id,providerMessageId:schema.calls.providerMessageId,contactId:schema.calls.contactId,existingText:schema.callTranscripts.text,cursor:schema.syncCursors.cursor}).from(schema.calls)
    .leftJoin(schema.callTranscripts,eq(schema.callTranscripts.callId,schema.calls.id))
    .leftJoin(schema.syncCursors,eq(schema.syncCursors.key,sql`'customer_state:call_transcript:' || ${schema.calls.id}::text`))
    .where(and(or(gte(schema.calls.startedAt,since),sql`exists(select 1 from customer_state_snapshots s where s.contact_id=${schema.calls.contactId} and s.snapshot->>'pipelineDisposition'='active')`),
     sql`(${schema.callTranscripts.id} is null or trim(${schema.callTranscripts.text})='' or ${schema.callTranscripts.text} ~* '^(null|undefined|no transcript|transcript(ion)? (not found|unavailable|pending|processing)|failed to (retrieve|fetch|download) transcript|not found|unauthorized|forbidden|internal server error|service unavailable|<|\\{|\\[)')`))
    .orderBy(sql`${schema.syncCursors.updatedAt} asc nulls first`,schema.calls.startedAt).limit(limit);
   return rows.map(r=>({...r,retry:retryState(r.cursor)}));
  },
  persist:(callId,t)=>persistProviderTranscript(callId,t.segments.length?t.segments:t.text),
  saveRetry:(callId,state)=>save(`customer_state:call_transcript:${callId}`,JSON.stringify(state)),
  saveRun:result=>save('customer_state:call_transcripts',JSON.stringify(result))
 };
}
function failureReason(error:unknown){const status=object(error).status;return status===401||status===403?'provider_permission_denied':status===429?'provider_rate_limited':status===404?'transcript_not_available':typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<=599?`provider_http_${status}`:'provider_transient_error';}
function retryDelay(attempt:number,error:string){return error==='provider_permission_denied'?6*3600000:Math.min(6*3600000,5*60000*2**Math.min(8,Math.max(0,attempt-1)));}
export async function recoverCallTranscripts({provider=GhlClient.fromEnv(),store=transcriptRecoveryStore(),now=new Date(),limit=200}:{provider?:Provider;store?:TranscriptRecoveryStore;now?:Date;limit?:number}={}){
 const max=Math.max(1,Math.min(500,Math.floor(limit))),rows=await store.listCandidates(new Date(now.valueOf()-30*86400000),max+1);
 let attempted=0,recovered=0,unchanged=0,deferred=0,failed=0,unavailableCount=0;
 const errorCounts:Record<string,number>={};
 for(const call of rows.slice(0,max)){
  const existing=parseProviderTranscript(call.existingText);
  if(existing){
   // Older imports may have stored a JSON envelope as plain text. Canonicalize
   // those rows once so they cannot occupy the bounded recovery queue forever.
   if(call.existingText?.trim()!==existing.text){if(await store.persist(call.callId,existing))recovered++;else unchanged++;await store.saveRetry(call.callId,{status:'complete',attemptCount:call.retry?.attemptCount??0,attemptedAt:now.toISOString(),nextAttemptAt:null,error:null,contentHash:existing.contentHash});}
   else unchanged++;
   continue;
  }
  if(call.retry?.nextAttemptAt&&Date.parse(call.retry.nextAttemptAt)>now.valueOf()){deferred++;continue;}
  attempted++;const attemptCount=(call.retry?.attemptCount??0)+1;let transcript:ParsedTranscript|null=null,error='transcript_not_available';
  try{transcript=parseProviderTranscript(await provider.downloadCallTranscript(call.providerMessageId));}catch(caught){error=failureReason(caught);}
  if(!transcript&&!['provider_permission_denied','provider_rate_limited'].includes(error)){
   try{transcript=parseProviderTranscript(await provider.getCallTranscript(call.providerMessageId));}catch(caught){error=failureReason(caught);}
  }
  if(transcript){
   const changed=await store.persist(call.callId,transcript);if(changed)recovered++;else unchanged++;
   await store.saveRetry(call.callId,{status:'complete',attemptCount,attemptedAt:now.toISOString(),nextAttemptAt:null,error:null,contentHash:transcript.contentHash});
  }else{
   errorCounts[error]=(errorCounts[error]??0)+1;
   if(error==='transcript_not_available')unavailableCount++;else failed++;
   await store.saveRetry(call.callId,{status:error==='transcript_not_available'?'pending':'failed',attemptCount,attemptedAt:now.toISOString(),nextAttemptAt:new Date(now.valueOf()+retryDelay(attemptCount,error)).toISOString(),error});
  }
 }
 const result={asOf:now.toISOString(),inspected:Math.min(rows.length,max),truncated:rows.length>max,attempted,recovered,unchanged,deferred,failed,unavailable:unavailableCount,errorCounts};await store.saveRun(result);return result;
}
export function startCallTranscriptWorker({intervalMs=2*60000,recover=recoverCallTranscripts,logger=console}:{intervalMs?:number;recover?:typeof recoverCallTranscripts;logger?:Pick<Console,'log'|'error'>}={}){
 let running=false,stopped=false;const tick=async()=>{if(running||stopped)return;running=true;try{logger.log(JSON.stringify({event:'call_transcript_recovery',...await recover()}));}catch{logger.error('Call transcript recovery failed; inspect source coverage diagnostics.');}finally{running=false;}};
 void tick();const timer=setInterval(()=>void tick(),intervalMs);return()=>{stopped=true;clearInterval(timer);};
}
