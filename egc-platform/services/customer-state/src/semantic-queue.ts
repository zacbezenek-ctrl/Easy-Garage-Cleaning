import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {asRecord,hash,EXTRACTOR_VERSION,exclusionReasons} from './core.js';
import {customerActivityPredicate} from './selection.js';
import type {Json,ReconcileOptions} from './types.js';

export interface SemanticCursor {
  status:'processing'|'complete'|'partial'|'failed'|'waiting_for_transcripts';
  attemptedAt:string;completedAt?:string;nextAttemptAt:string;attemptCount:number;failureCount:number;
  workKey:string;leaseToken?:string;leaseUntil?:string;errors?:string[];elapsedMs?:number;
}
export interface SemanticCandidate {
  contactId:string;leadCreatedAt:string;lastActivityAt:string;material:boolean;complete:boolean;
  workKey:string;pendingSourceCount:number;missingTranscriptCount:number;cursor:SemanticCursor|null;
}
const due=(candidate:SemanticCandidate,now:number)=>{
  const cursor=candidate.cursor;if(cursor?.status==='processing'&&Date.parse(cursor.leaseUntil??'')>now)return false;
  return !cursor||cursor.workKey!==candidate.workKey||!Number.isFinite(Date.parse(cursor.nextAttemptAt))||Date.parse(cursor.nextAttemptAt)<=now;
};
/** Reserve every fourth slot for oldest-attempt work outside the high-priority
 * queue. Read refresh timestamps do not participate in this scheduling order. */
export function selectSemanticWork(candidates:SemanticCandidate[],now:Date,limit=12) {
  const at=now.valueOf(),eligible=candidates.filter(c=>due(c,at));
  const oldest=(a:SemanticCandidate,b:SemanticCandidate)=>Date.parse(a.cursor?.attemptedAt??a.leadCreatedAt)-Date.parse(b.cursor?.attemptedAt??b.leadCreatedAt)||b.lastActivityAt.localeCompare(a.lastActivityAt)||a.contactId.localeCompare(b.contactId);
  const recent=(c:SemanticCandidate)=>Date.parse(c.lastActivityAt)>=at-7*86400000||Date.parse(c.leadCreatedAt)>=at-7*86400000;
  const priority=[...eligible].sort((a,b)=>Number(a.complete)-Number(b.complete)||Number(recent(b))-Number(recent(a))||Number(b.material)-Number(a.material)||oldest(a,b));
  const fair=[...eligible].sort(oldest),selected:SemanticCandidate[]=[];
  while(selected.length<limit&&selected.length<eligible.length){const queue=selected.length%4===3?fair:priority;const next=queue.find(c=>!selected.includes(c));if(next)selected.push(next);}
  return selected;
}
export function semanticRetryDelay(errors:string[],failureCount:number,complete:boolean,missingTranscripts=false) {
  if(complete)return 30*60_000;
  if(errors.length&&errors.every(e=>e==='semantic_batch_budget_deferred'))return 15_000;
  if(missingTranscripts&&!errors.length)return 5*60_000;
  if(errors.some(e=>/http_429|code=(?:rate_limit_exceeded|insufficient_quota)/.test(e)))return Math.min(6*60*60_000,5*60_000*2**Math.min(7,Math.max(0,failureCount-1)));
  if(errors.some(e=>/http_(400|401|403|404)/.test(e)))return Math.min(60*60_000,5*60_000*2**Math.min(4,Math.max(0,failureCount-1)));
  return Math.min(30*60_000,30_000*2**Math.min(6,Math.max(0,failureCount-1)));
}
const providerBackoffDelay=(errors:string[])=>errors.some(e=>/code=insufficient_quota/.test(e))?6*60*60_000:errors.some(e=>/http_429|code=rate_limit_exceeded/.test(e))?30*60_000:0;
type QueueCandidates={candidates:SemanticCandidate[];truncated:boolean;providerBackoffUntil?:string|null};
export async function semanticQueueCandidates(since:Date):Promise<QueueCandidates> {
  const db=getDb();
  const rows=await db.select({contactId:schema.contacts.id,leadCreatedAt:schema.leads.createdAt,tags:schema.contacts.tags,raw:schema.contacts.raw,source:schema.contacts.source,state:schema.customerStateSnapshots.state,coverage:schema.customerStateSnapshots.coverage,lastReconciledAt:schema.customerStateSnapshots.lastReconciledAt,cursor:schema.syncCursors.cursor,
    lastActivityAt:sql<string>`greatest(${schema.leads.createdAt},coalesce((select max(m.occurred_at) from messages m where m.contact_id=${schema.contacts.id}),${schema.leads.createdAt}),coalesce((select max(c.started_at) from calls c where c.contact_id=${schema.contacts.id}),${schema.leads.createdAt}))::text`,
    evidenceFingerprint:sql<string>`coalesce((select md5(string_agg(e.id||e.source_hash||e.status,',' order by e.id)) from customer_evidence e where e.contact_id=${schema.contacts.id} and e.status<>'complete'),'none')`
  }).from(schema.leads).innerJoin(schema.contacts,eq(schema.contacts.id,schema.leads.contactId)).leftJoin(schema.customerStateSnapshots,eq(schema.customerStateSnapshots.contactId,schema.contacts.id)).leftJoin(schema.syncCursors,sql`${schema.syncCursors.key}='customer_state:semantic:'||${schema.contacts.id}::text`).where(customerActivityPredicate(since)).orderBy(sql`${schema.leads.createdAt} desc`).limit(2001);
  const [queue]=await db.select({cursor:schema.syncCursors.cursor}).from(schema.syncCursors).where(eq(schema.syncCursors.key,'customer_state:semantic_queue')).limit(1);
  let providerBackoffUntil:string|null=null;
  try{const parsed=queue?.cursor?JSON.parse(queue.cursor) as Json:null;if(parsed&&typeof parsed.providerBackoffUntil==='string'&&Number.isFinite(Date.parse(parsed.providerBackoffUntil)))providerBackoffUntil=parsed.providerBackoffUntil;}catch{/* Malformed queue diagnostics must never suppress extraction indefinitely. */}
  return {truncated:rows.length>2000,providerBackoffUntil,candidates:rows.slice(0,2000).filter(row=>!exclusionReasons(row).includes('test_internal_or_vendor')).map(row=>{
    const extraction=asRecord(row.coverage?.extraction),calls=asRecord(row.coverage?.calls),lastActivityAt=new Date(row.lastActivityAt).toISOString();
    let cursor:SemanticCursor|null=null;try{if(row.cursor)cursor=JSON.parse(row.cursor) as SemanticCursor;}catch{/* Reconstruct a corrupt scheduling cursor, never business evidence. */}
    const stale=!row.lastReconciledAt||new Date(lastActivityAt)>row.lastReconciledAt;
    return {contactId:row.contactId,leadCreatedAt:row.leadCreatedAt.toISOString(),lastActivityAt,material:Boolean(row.state&&!['NEW_LEAD','OUTREACH_ATTEMPTED','LOST','DO_NOT_CONTACT'].includes(row.state)),complete:extraction.complete===true&&!stale,pendingSourceCount:Array.isArray(extraction.partialSourceIds)?extraction.partialSourceIds.length:stale?1:0,missingTranscriptCount:Array.isArray(calls.missingTranscriptIds)?calls.missingTranscriptIds.length:0,workKey:hash(`${EXTRACTOR_VERSION}:${process.env.CUSTOMER_EVIDENCE_MODEL??'gpt-5.6-luna'}:${lastActivityAt}:${row.evidenceFingerprint}`),cursor};
  })};
}
export async function claimSemanticWork(candidate:SemanticCandidate,now:Date,leaseMs=240_000):Promise<SemanticCursor|null> {
  const db=getDb(),key=`customer_state:semantic:${candidate.contactId}`;
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [row]=await tx.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,key));let current:SemanticCursor|null=null;try{if(row?.cursor)current=JSON.parse(row.cursor) as SemanticCursor;}catch{}
    if(!due({...candidate,cursor:current},now.valueOf()))return null;
    const cursor:SemanticCursor={status:'processing',attemptedAt:now.toISOString(),nextAttemptAt:new Date(now.valueOf()+leaseMs).toISOString(),leaseUntil:new Date(now.valueOf()+leaseMs).toISOString(),leaseToken:randomUUID(),attemptCount:(current?.attemptCount??0)+1,failureCount:current?.failureCount??0,workKey:candidate.workKey,...(current?.completedAt?{completedAt:current.completedAt}:{})};
    const value={key,cursor:JSON.stringify(cursor),updatedAt:now};await tx.insert(schema.syncCursors).values(value).onConflictDoUpdate({target:schema.syncCursors.key,set:value});return cursor;
  });
}
export async function finishSemanticWork(candidate:SemanticCandidate,claim:SemanticCursor,result:{complete:boolean;errors:string[];missingTranscripts:boolean;failed:boolean},now:Date) {
  const failureCount=result.complete?0:claim.failureCount+1,delay=semanticRetryDelay(result.errors,failureCount,result.complete,result.missingTranscripts);
  const cursor:SemanticCursor={status:result.complete?'complete':result.failed?'failed':result.missingTranscripts&&!result.errors.length?'waiting_for_transcripts':'partial',attemptedAt:claim.attemptedAt,nextAttemptAt:new Date(now.valueOf()+delay).toISOString(),attemptCount:claim.attemptCount,failureCount,workKey:claim.workKey,errors:result.errors,elapsedMs:Math.max(0,now.valueOf()-Date.parse(claim.attemptedAt)),...(result.complete?{completedAt:now.toISOString()}:claim.completedAt?{completedAt:claim.completedAt}:{})};
  const updated=await getDb().update(schema.syncCursors).set({cursor:JSON.stringify(cursor),updatedAt:now}).where(and(eq(schema.syncCursors.key,`customer_state:semantic:${candidate.contactId}`),sql`${schema.syncCursors.cursor}::jsonb->>'leaseToken'=${claim.leaseToken??''}`)).returning({key:schema.syncCursors.key});
  return updated.length>0;
}
type Reconciler=(options:ReconcileOptions)=>Promise<{failed:number;results:Array<{contactId:string;coverage?:Json;error?:string}>}>;
const saveSemanticProgress=async(value:Json)=>{const row={key:'customer_state:semantic_queue',cursor:JSON.stringify(value),updatedAt:new Date()};await getDb().insert(schema.syncCursors).values(row).onConflictDoUpdate({target:schema.syncCursors.key,set:row});};
export async function runSemanticQueue(reconcile:Reconciler,options:{since?:Date;limit?:number;concurrency?:number;deadlineMs?:number;stopped?:()=>boolean}={},deps={candidates:semanticQueueCandidates,claim:claimSemanticWork,finish:finishSemanticWork,now:()=>new Date(),progress:saveSemanticProgress}) {
  const start=deps.now(),snapshot=await deps.candidates(options.since??new Date(start.valueOf()-30*86400000)),{candidates,truncated}=snapshot;
  let providerBackoffUntil=typeof snapshot.providerBackoffUntil==='string'&&Date.parse(snapshot.providerBackoffUntil)>start.valueOf()?snapshot.providerBackoffUntil:null;
  const selected=providerBackoffUntil?[]:selectSemanticWork(candidates,start,Math.max(1,Math.min(20,options.limit??12))),concurrency=Math.max(1,Math.min(3,options.concurrency??3));
  let next=0,inspected=0,completed=0,partialCustomers=0,failed=0,deferred=0;const results:Array<{contactId:string;complete:boolean;errors:string[]}>=[];
  let progress=Promise.resolve();
  const publish=(status:string)=>{const finished=new Set(results.filter(r=>r.complete).map(r=>r.contactId));const state={status,startedAt:start.toISOString(),updatedAt:deps.now().toISOString(),selected:selected.length,inspected,completed,partialCustomers,failed,deferred,pending:candidates.filter(c=>!c.complete&&!finished.has(c.contactId)).length,remainingInChunk:selected.length-next,totalCandidates:candidates.length,truncated,providerBackoffUntil};progress=progress.then(()=>deps.progress(state));return progress;};
  if(providerBackoffUntil){await publish('provider_backoff');return {startedAt:start.toISOString(),finishedAt:deps.now().toISOString(),selected:0,inspected:0,completed:0,partialCustomers:0,failed:0,deferred:0,pending:candidates.filter(c=>!c.complete).length,truncated,complete:false,providerBackoffUntil,results};}
  await publish('processing');
  const worker=async()=>{while(next<selected.length){if(providerBackoffUntil||options.stopped?.()||deps.now().valueOf()-start.valueOf()>=(options.deadlineMs??150_000))return;const candidate=selected[next++]!,claim=await deps.claim(candidate,deps.now());if(!claim){deferred++;continue;}inspected++;
    await publish('processing');
    try{const result=await reconcile({contactIds:[candidate.contactId],useAI:true,maxContacts:1,semanticMaxBatches:1,semanticTimeoutMs:75_000}),row=result.results.find(r=>r.contactId===candidate.contactId),extraction=asRecord(row?.coverage?.extraction),calls=asRecord(row?.coverage?.calls),complete=!result.failed&&extraction.complete===true,errors=Array.isArray(extraction.errors)?extraction.errors.filter((e):e is string=>typeof e==='string'):[];
      const hadFailure=result.failed>0||!row;if(hadFailure){failed++;errors.push('customer_reconciliation_failed');}else if(complete)completed++;else partialCustomers++;
      await deps.finish(candidate,claim,{complete,errors,missingTranscripts:Array.isArray(calls.missingTranscriptIds)&&calls.missingTranscriptIds.length>0,failed:hadFailure},deps.now());results.push({contactId:candidate.contactId,complete,errors});
      const providerDelay=providerBackoffDelay(errors);if(providerDelay){const until=new Date(deps.now().valueOf()+providerDelay).toISOString();if(!providerBackoffUntil||Date.parse(until)>Date.parse(providerBackoffUntil))providerBackoffUntil=until;}
    }catch{failed++;await deps.finish(candidate,claim,{complete:false,errors:['customer_reconciliation_failed'],missingTranscripts:false,failed:true},deps.now());results.push({contactId:candidate.contactId,complete:false,errors:['customer_reconciliation_failed']});}
    await publish('processing');
  }};
  await Promise.all(Array.from({length:concurrency},worker));
  const completedIds=new Set(results.filter(r=>r.complete).map(r=>r.contactId)),pending=candidates.filter(c=>!c.complete&&!completedIds.has(c.contactId)).length;
  await publish('chunk_finished');
  return {startedAt:start.toISOString(),finishedAt:deps.now().toISOString(),selected:selected.length,inspected,completed,partialCustomers,failed,deferred:deferred+selected.length-next,pending,truncated,complete:!truncated&&pending===0&&!failed&&!partialCustomers,providerBackoffUntil,results};
}
