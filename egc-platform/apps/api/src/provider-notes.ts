import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {GhlClient} from '@egc/ghl';
import {OperationsError,processNoteOutbox,type Actor,type Command,type OperationsService} from '@egc/operations';
type Json=Record<string,unknown>;
type NoteCommand=Extract<Command,{command:'provider.note.ensure'}>;
type Portal=(actor:Actor,command:Command)=>Promise<Json>;
type Provider=Pick<GhlClient,'getContact'|'getContactNotes'|'createContactNote'|'locationId'>;
const record=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function sixMonthCheckin(completedAt:string){const d=new Date(completedAt);if(!Number.isFinite(d.getTime()))throw new OperationsError('post_job_completion_time_required',409);const day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+6);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString();}
async function ensurePostJobFollowup(actor:Actor,command:NoteCommand,source:Json,portal:Portal,db:ReturnType<typeof getDb>,service:OperationsService){
  const job=record(source.job),completion=job.completedAt??record(record(source.financials).completion).at;
  if(job.type!=='job'||typeof completion!=='string'||!Number.isFinite(Date.parse(completion))||Date.parse(completion)>Date.now()+300000)throw new OperationsError('post_job_completion_time_required',409);
  const completedAt=new Date(completion).toISOString(),dedupeKey='post_job_6_month:'+command.portalJobId+':'+completedAt;
  const find=async()=>(await db.select({id:schema.tasks.id}).from(schema.tasks).where(and(eq(schema.tasks.workspaceId,actor.workspace),eq(schema.tasks.dedupeKey,dedupeKey))).limit(1))[0];
  const prior=await find();if(prior)return prior.id;
  const policy=await portal(actor,{command:'portal.rules'}),owner=record(policy.inboundResponse).ownerId;
  if(policy.authority!=='employee_hub'||typeof owner!=='string'||!owner)throw new OperationsError('post_job_followup_owner_unresolved',409);
  const hash=digest([actor.workspace,dedupeKey]),requestId=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  const system:Actor={id:'post-job-followup',kind:'integration',role:'integration',workspace:actor.workspace};
  try{const result=await service.execute(system,{command:'task.create',task:{title:'6-month garage check-in',description:'Ask how the completed garage system is holding up and whether maintenance would help. Review customer preferences before contacting them.',kind:'callback',priority:'medium',assignedUserId:owner,dueAt:sixMonthCheckin(completedAt),timeZone:'America/Denver',waitingOn:'none',portalJobId:command.portalJobId,portalVisitId:typeof job.sourceWalkthroughId==='string'?job.sourceWalkthroughId:null,completionCondition:'Record the check-in result or a documented decision not to contact the customer.',sourceEvidence:[{source:'portal_job',id:command.portalJobId,excerpt:'Job completion recorded at '+completedAt}],dedupeKey}},requestId);const task=record(result.task);if(typeof task.id!=='string')throw new OperationsError('post_job_followup_unverified',503);return task.id;}catch(error){const existing=await find();if(existing)return existing.id;throw error;}
}
/** One intent and verified receipt shared by native requests and scheduled workers. */
export async function ensureProviderNote(actor:Actor,command:NoteCommand,portal:Portal,options:{db?:ReturnType<typeof getDb>;provider?:Provider;service?:OperationsService}={}){
  const db=options.db??getDb(),provider=options.provider??GhlClient.fromEnv();
  const source=await portal(actor,{command:'portal.job',jobId:command.portalJobId}),job=record(source.job);
  if(source.authority!=='employee_hub'||job.id!==command.portalJobId||!['job','walkthrough'].includes(String(job.type)))throw new OperationsError('provider_note_source_unverified',409);
  if(job.highlevelContactId&&job.highlevelContactId!==command.providerContactId)throw new OperationsError('provider_note_contact_conflict',409);
  if(!job.highlevelContactId||!job.customerId){
    const response=await provider.getContact(command.providerContactId),contact=record(response.contact??response);
    if(contact.id!==command.providerContactId||contact.locationId&&contact.locationId!==provider.locationId)throw new OperationsError('provider_note_contact_conflict',409);
    const system:Actor={id:'note-link:'+actor.id,kind:'integration',role:'integration',workspace:actor.workspace};
    const linked=await portal(system,{command:'schedule.link_customer',portalVisitId:command.portalJobId,expectedRevision:String(job.revision),providerContact:contact});
    const visit=record(linked.visit);if(linked.authority!=='employee_hub'||visit.portalVisitId!==command.portalJobId||visit.highlevelContactId!==command.providerContactId||!visit.portalCustomerId)throw new OperationsError('provider_note_source_unverified',409);
  }
  const entityId='native-note:'+digest([actor.workspace,command.portalJobId,command.scope,command.requestId]),payloadHash=digest([command.providerContactId,command.title,command.body]);
  const type='ghl.contact_note.sync';
  await db.transaction(async tx=>{
    const created=await tx.insert(schema.outboxEvents).values({type,entityId,payload:{ghlContactId:command.providerContactId,noteBody:command.body,title:command.title,portalJobId:command.portalJobId,scope:command.scope,actorId:actor.id,payloadHash,_egcExecutionVersion:1}}).onConflictDoNothing().returning({id:schema.outboxEvents.id});
    if(created[0])await tx.insert(schema.auditLogs).values({actor:actor.id,action:'provider.note.authorized',entity:'outbox',entityId:created[0].id,newValue:{portalJobId:command.portalJobId,scope:command.scope,payloadHash},source:'operations'});
  });
  const find=async()=>(await db.select().from(schema.outboxEvents).where(and(eq(schema.outboxEvents.type,type),eq(schema.outboxEvents.entityId,entityId))).limit(1))[0];
  let event=await find();if(!event)throw new OperationsError('provider_note_intent_unavailable',503);
  if(event.payload.payloadHash!==payloadHash)throw new OperationsError('provider_note_request_conflict',409);
  if(event.processingStatus!=='processed'&&event.processingStatus!=='failed')await processNoteOutbox(provider,db,new Date(),event.id);
  event=await find();const noteId=event?.payload._egcVerifiedNoteId;
  if(event?.processingStatus==='processed'&&typeof noteId==='string'){
    let followupTaskId:string|undefined;
    if(command.scope==='post_job'){
      try{if(!options.service)throw new OperationsError('post_job_followup_unavailable',503);followupTaskId=await ensurePostJobFollowup(actor,command,source,portal,db,options.service);await db.update(schema.outboxEvents).set({payload:sql`jsonb_set(jsonb_set(${schema.outboxEvents.payload},'{_egcFollowupStatus}','"complete"'),'{_egcFollowupTaskId}',${JSON.stringify(followupTaskId)}::jsonb)`}).where(eq(schema.outboxEvents.id,event.id));}
      catch(error){await db.update(schema.outboxEvents).set({payload:sql`jsonb_set(${schema.outboxEvents.payload},'{_egcFollowupStatus}','"blocked"')`}).where(and(eq(schema.outboxEvents.id,event.id),sql`coalesce(${schema.outboxEvents.payload}->>'_egcFollowupStatus','')<>'complete'`));return{ok:false,error:error instanceof OperationsError&&['post_job_completion_time_required','post_job_followup_owner_unresolved'].includes(error.code)?error.code:'post_job_followup_unavailable',outboxId:event.id,providerSync:'verified',followupStatus:'blocked'};}
    }
    return{ok:true,authority:'employee_hub',portalJobId:command.portalJobId,noteId,outboxId:event.id,providerSync:'verified',...(followupTaskId?{followupTaskId}:{})};
  }
  return{ok:false,error:event?.processingStatus==='failed'?'provider_note_requires_review':'provider_note_pending',outboxId:event?.id??null,providerSync:event?.processingStatus??'unknown',retryMode:'same_request_reconcile_only'};
}
