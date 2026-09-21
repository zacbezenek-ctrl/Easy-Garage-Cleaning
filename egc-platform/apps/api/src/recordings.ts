import {createHash,randomUUID} from 'node:crypto';
import {and,desc,eq,inArray,isNull,lt,or,sql} from 'drizzle-orm';
import type {FastifyInstance} from 'fastify';
import {getDb,schema} from '@egc/database';
import {getObject,putObject} from '@egc/storage';
import {extractWalkthrough,transcribeWalkthrough} from '@egc/ai';
import {walkthroughExtractionSchema} from '@egc/schemas';
import {OperationsError,operationsService,type Actor} from '@egc/operations';
import {portalAdapter} from './operations.js';
import {fingerprint,MAX_AUDIO_BYTES,safeRecordingError,signRecordingEnvelope,stableUuid,verifyRecordingEnvelope,type RecordingClaims,type RecordingCommand} from './recording-contracts.js';
type Row=typeof schema.walkthroughs.$inferSelect;
type Identity={portalJobId:string;portalVisitId:string;portalCustomerId:string;portalProjectId:string|null;portalRevision:string;highlevelContactId:string|null;authority:'employee_hub'};
type Approval=Extract<RecordingCommand,{command:'recording.approve'}>;
export type RecordingDependencies={put:typeof putObject;get:typeof getObject;transcribe:typeof transcribeWalkthrough;extract:typeof extractWalkthrough};
const publicRow=(r:Row)=>{const{audioObjectKey,approvalPayload,audioSha256,...safe}=r;return{...safe,revision:r.updatedAt.toISOString(),pendingReview:r.status==='approval_pending'?(approvalPayload as {command?:unknown}|null)?.command??null:null,linkageExceptions:r.portalProjectId?[]:['project_link_not_established']};};

export class RecordingService{
  constructor(private env:NodeJS.ProcessEnv=process.env,private db=getDb(),private fetcher:typeof fetch=fetch,private io:RecordingDependencies={put:putObject,get:getObject,transcribe:transcribeWalkthrough,extract:extractWalkthrough}){}
  private get workspace(){return this.env.EGC_OPERATIONS_WORKSPACE??'egc';}
  private async portal(actor:Actor,body:Record<string,unknown>){
    const key=this.env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET??'',origin=new URL(this.env.EGC_PORTAL_ORIGIN??'https://invalid.invalid');
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.hostname==='invalid.invalid')throw new OperationsError('recording_bridge_not_configured',503);
    const envelope=signRecordingEnvelope({v:1,iss:'portal',aud:'egc-portal',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,request:{requestId:randomUUID(),body}},key);
    let response:Response;try{response=await this.fetcher(new URL('/api/operations-recording-approval',origin),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(20000)});}catch{throw new OperationsError('recording_approval_outcome_unknown',503);}
    const result=await response.json() as Record<string,unknown>;
    if(!response.ok){const code=typeof result.error==='string'&&/^recording_[a-z_]+$/.test(result.error)?result.error:'recording_source_unavailable';throw new OperationsError(code,response.status>=500?503:409);}
    return result;
  }
  async upload(claims:RecordingClaims,audio:Buffer,contentType:string){
    const command=claims.request.body;if(command.command!=='recording.upload')throw new OperationsError('invalid_recording_upload',400);
    if(!audio.length||audio.length>MAX_AUDIO_BYTES)throw new OperationsError('recording_size_invalid',400);
    if(!/^audio\/(webm|mp4|mpeg|wav|x-wav|ogg|aac|flac)(;.*)?$/i.test(contentType))throw new OperationsError('recording_audio_type_invalid',400);
    const audioSha256=createHash('sha256').update(audio).digest('hex');if(audioSha256!==command.audioSha256)throw new OperationsError('recording_upload_digest_mismatch',400);
    const existing=await this.db.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.workspaceId,this.workspace),eq(schema.walkthroughs.uploadRequestId,claims.request.requestId))).limit(1);
    let row=existing[0];
    if(row&&(row.audioSha256!==audioSha256||row.portalJobId!==command.portalJobId))throw new OperationsError('recording_upload_request_conflict',409);
    if(!row){
      const result=await this.portal(claims.actor,{command:'recording.resolve',portalJobId:command.portalJobId}),identity=result.identity as Identity;
      if(identity?.authority!=='employee_hub'||identity.portalJobId!==command.portalJobId||!identity.portalCustomerId||!identity.portalVisitId||!identity.portalRevision)throw new OperationsError('recording_identity_unverified',409);
      const [contact]=identity.highlevelContactId?await this.db.select({id:schema.contacts.id}).from(schema.contacts).where(and(eq(schema.contacts.provider,'ghl'),eq(schema.contacts.providerId,identity.highlevelContactId))).limit(1):[];
      const id=stableUuid(`recording:${this.workspace}:${claims.request.requestId}`),audioObjectKey=`recordings/${this.workspace}/${id}/audio`;
      const {authority,highlevelContactId,...links}=identity;
      await this.db.insert(schema.walkthroughs).values({id,workspaceId:this.workspace,...links,contactId:contact?.id??null,status:'uploading',uploadRequestId:claims.request.requestId,uploadedBy:claims.actor.id,audioObjectKey,audioContentType:contentType,audioFilename:'recording',audioBytes:audio.length,audioSha256}).onConflictDoNothing();
      row=await this.row(id);
      if(row.audioSha256!==audioSha256||row.portalJobId!==command.portalJobId)throw new OperationsError('recording_upload_request_conflict',409);
    }
    if(row.status!=='uploading'&&!(row.status==='failed'&&row.lastErrorCode==='recording_upload_failed'))return{ok:true,alreadySaved:true,recording:publicRow(row)};
    try{await this.io.put(row.audioObjectKey!,audio,contentType);await this.db.update(schema.walkthroughs).set({status:'uploaded',lastErrorCode:null,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),inArray(schema.walkthroughs.status,['uploading','failed'])));}catch{await this.db.update(schema.walkthroughs).set({status:'failed',lastErrorCode:'recording_upload_failed',updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.status,'uploading')));throw new OperationsError('recording_upload_failed',503);}
    return{ok:true,recording:publicRow(await this.row(row.id))};
  }
  private async row(id:string){const[row]=await this.db.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.id,id),eq(schema.walkthroughs.workspaceId,this.workspace))).limit(1);if(!row)throw new OperationsError('recording_not_found',404);return row;}
  async execute(c:RecordingClaims){const command=c.request.body;
    if(command.command==='recording.list'){const rows=await this.db.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.workspaceId,this.workspace),eq(schema.walkthroughs.portalJobId,command.portalJobId))).orderBy(desc(schema.walkthroughs.createdAt),desc(schema.walkthroughs.id)).limit(51).offset(command.offset);return{ok:true,recordings:rows.slice(0,50).map(publicRow),nextOffset:rows.length>50?command.offset+50:null};}
    if(command.command==='recording.upload')throw new OperationsError('recording_audio_required',400);
    const row=await this.row(command.recordingId);
    if(command.command==='recording.get')return{ok:true,recording:publicRow(row)};
    if(command.command==='recording.refresh_source'){
      if(!['owner','manager'].includes(c.actor.role))throw new OperationsError('human_manager_approval_required',403);
      if(row.status!=='draft'&&!(row.status==='approval_pending'&&row.lastErrorCode==='recording_source_revision_conflict'))throw new OperationsError('recording_review_refresh_not_safe',409);
      const result=await this.portal(c.actor,{command:'recording.resolve',portalJobId:row.portalJobId}),identity=result.identity as Identity;
      if(identity.portalCustomerId!==row.portalCustomerId||identity.portalVisitId!==row.portalVisitId||identity.portalProjectId!==row.portalProjectId)throw new OperationsError('recording_identity_changed',409);
      await this.db.update(schema.walkthroughs).set({status:'draft',portalRevision:identity.portalRevision,approvalPayload:null,approvalFingerprint:null,approvalRequestId:null,lastErrorCode:null,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.updatedAt,row.updatedAt)));
      return{ok:true,recording:publicRow(await this.row(row.id)),requiresNewReview:true};
    }
    if(command.command==='recording.retry'){
      if(row.status==='approval_pending')throw new OperationsError('recording_approval_retry_requires_original_review',409);
      if(['uploaded','processing','draft','approved'].includes(row.status))return{ok:true,alreadyQueuedOrProcessed:true,recording:publicRow(row)};
      if(row.status!=='failed'||row.lastErrorCode==='recording_upload_failed')throw new OperationsError('recording_retry_not_available',409);
      await this.db.update(schema.walkthroughs).set({status:'uploaded',lastErrorCode:null,processingLeaseUntil:null,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.status,'failed')));return{ok:true,recording:publicRow(await this.row(row.id))};
    }
    return this.approve(c.actor,c.request.requestId,command);
  }
  async processNext(){
    const now=new Date();
    const row=await this.db.transaction(async tx=>{
      const [r]=await tx.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.workspaceId,this.workspace),or(eq(schema.walkthroughs.status,'uploaded'),and(eq(schema.walkthroughs.status,'processing'),or(isNull(schema.walkthroughs.processingLeaseUntil),lt(schema.walkthroughs.processingLeaseUntil,now)))))).orderBy(schema.walkthroughs.createdAt).limit(1).for('update',{skipLocked:true});
      if(!r)return null;
      if(r.status==='processing'&&r.attemptCount>=5){await tx.update(schema.walkthroughs).set({status:'failed',lastErrorCode:'recording_processing_attempts_exhausted',processingLeaseUntil:null,updatedAt:now}).where(eq(schema.walkthroughs.id,r.id));return null;}
      const [claimed]=await tx.update(schema.walkthroughs).set({status:'processing',attemptCount:r.attemptCount+1,processingLeaseUntil:new Date(now.getTime()+15*60*1000),lastErrorCode:null,updatedAt:now}).where(eq(schema.walkthroughs.id,r.id)).returning();return claimed!;
    });
    if(!row)return false;
    try{
      const audio=await this.io.get(row.audioObjectKey!),transcript=await this.io.transcribe(audio,row.audioFilename??'recording',row.audioContentType??'audio/webm');
      const extraction=walkthroughExtractionSchema.parse(await this.io.extract(transcript));
      await this.db.update(schema.walkthroughs).set({transcript,extraction,status:'draft',processingLeaseUntil:null,lastErrorCode:null,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.attemptCount,row.attemptCount),eq(schema.walkthroughs.status,'processing')));
    }catch{await this.db.update(schema.walkthroughs).set({status:'failed',processingLeaseUntil:null,lastErrorCode:'recording_processing_failed',updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.attemptCount,row.attemptCount),eq(schema.walkthroughs.status,'processing')));}
    return true;
  }
  private async approve(actor:Actor,requestId:string,command:Approval){
    if(!['owner','manager'].includes(actor.role)||actor.kind!=='human')throw new OperationsError('human_manager_approval_required',403);
    const validationBridge=portalAdapter(this.env.EGC_PORTAL_ORIGIN!,this.env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET!,this.workspace,this.fetcher);
    for(const action of command.actions){if(action.dependencies.length)throw new OperationsError('recording_action_dependencies_not_supported',400);if(!await validationBridge.owner(action.assignedUserId))throw new OperationsError('recording_action_owner_unverified',409);}
    const hash=fingerprint({extraction:command.extraction,actions:command.actions});
    const row=await this.db.transaction(async tx=>{
      const[r]=await tx.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.id,command.recordingId),eq(schema.walkthroughs.workspaceId,this.workspace))).for('update');
      if(!r)throw new OperationsError('recording_not_found',404);
      if(!r.portalJobId||!r.portalVisitId||!r.portalCustomerId||!r.portalRevision)throw new OperationsError('recording_identity_unverified',409);
      if(['approved','approval_pending'].includes(r.status)){if(r.approvalFingerprint!==hash)throw new OperationsError('recording_approval_request_conflict',409);return r;}
      if(r.status!=='draft'||r.updatedAt.toISOString()!==command.revision)throw new OperationsError('recording_revision_conflict',409);
      for(const action of command.actions){if(action.portalJobId!==r.portalJobId||action.portalVisitId!==r.portalVisitId||action.jobId||action.contactId)throw new OperationsError('recording_action_identity_mismatch',409);}
      const[updated]=await tx.update(schema.walkthroughs).set({status:'approval_pending',approvalRequestId:requestId,approvalFingerprint:hash,approvalPayload:{actor,command},lastErrorCode:null,updatedAt:new Date()}).where(eq(schema.walkthroughs.id,r.id)).returning();return updated!;
    });
    if(row.status==='approved')return{ok:true,alreadyApplied:true,recording:publicRow(row)};
    const stored=row.approvalPayload as {actor:Actor;command:Approval};
    try{
      await this.portal(stored.actor,{command:'recording.apply',recordingId:row.id,requestId:row.approvalRequestId,fingerprint:hash,expectedRevision:row.portalRevision,portalJobId:row.portalJobId,portalVisitId:row.portalVisitId,portalCustomerId:row.portalCustomerId,portalProjectId:row.portalProjectId,extraction:stored.command.extraction});
      const bridge=portalAdapter(this.env.EGC_PORTAL_ORIGIN!,this.env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET!,this.workspace,this.fetcher),operations=operationsService({workspace:this.workspace,resolvePortalJob:bridge.resolve,resolveOwner:bridge.owner,portalRead:bridge.read});
      for(let i=0;i<stored.command.actions.length;i++){const action=stored.command.actions[i]!;await operations.execute(stored.actor,{command:'task.create',task:{...action,dedupeKey:`recording:${row.id}:action:${i}`,sourceEvidence:[...action.sourceEvidence,{source:'recording',id:row.id,excerpt:action.description.slice(0,2000)}]}},stableUuid(`recording:${row.id}:action:${i}`));}
      await this.db.transaction(async tx=>{const[current]=await tx.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.id,row.id)).for('update');if(current?.status==='approved')return;await tx.update(schema.walkthroughs).set({status:'approved',extraction:stored.command.extraction,approvedBy:stored.actor.id,approvedAt:new Date(),approvedRevision:row.portalRevision,lastErrorCode:null,updatedAt:new Date()}).where(eq(schema.walkthroughs.id,row.id));await tx.insert(schema.auditLogs).values({actor:stored.actor.id,action:'recording.approve',entity:'walkthrough',entityId:row.id,source:'employee_hub',newValue:{portalJobId:row.portalJobId,portalVisitId:row.portalVisitId,fingerprint:hash,actions:stored.command.actions.length}});});
      return{ok:true,recording:publicRow(await this.row(row.id))};
    }catch(error){await this.db.update(schema.walkthroughs).set({lastErrorCode:safeRecordingError(error),updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.status,'approval_pending')));throw error;}
  }
}

export async function registerRecordingRoutes(app:FastifyInstance,env:NodeJS.ProcessEnv=process.env,service?:RecordingService){
  const enabled=env.EGC_OPERATIONS_ENABLED==='true',s=service??(enabled?new RecordingService(env):undefined);
  function claims(token:unknown){if(!enabled||!s)throw new OperationsError('operations_not_enabled',503);return verifyRecordingEnvelope(token,{portal:env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET??'',mcp:env.EGC_OPERATIONS_MCP_SIGNING_SECRET??''},env.EGC_OPERATIONS_WORKSPACE??'egc');}
  function failure(error:unknown,reply:import('fastify').FastifyReply){return reply.code(error instanceof OperationsError?error.status:503).send({error:safeRecordingError(error),retryable:!(error instanceof OperationsError)||error.status>=500});}
  app.post('/recordings/rpc',{bodyLimit:220000},async(request,reply)=>{reply.header('Cache-Control','no-store');try{const c=claims((request.body as {envelope?:unknown})?.envelope);return await s!.execute(c);}catch(e){return failure(e,reply);}});
  app.post('/recordings/upload',async(request,reply)=>{reply.header('Cache-Control','no-store');try{let c:RecordingClaims|undefined,audio:Buffer|undefined,type='';for await(const part of request.parts({limits:{fileSize:MAX_AUDIO_BYTES,files:1,fields:1}})){if(part.type==='field'&&part.fieldname==='envelope')c=claims(part.value);else if(part.type==='file'&&part.fieldname==='audio'){if(!c)throw new OperationsError('recording_signature_required_first',401);audio=await part.toBuffer();type=part.mimetype;}}if(!c||!audio)throw new OperationsError('recording_audio_required',400);return reply.code(202).send(await s!.upload(c,audio,type));}catch(e){return failure(e,reply);}});
  if(enabled&&s){let running=false;const tick=async()=>{if(running)return;running=true;try{await s.processNext();}catch{app.log.warn({code:'recording_worker_unavailable'},'Recording processing will retry');}finally{running=false;}};const timer=setInterval(()=>void tick(),15000);timer.unref();app.addHook('onClose',async()=>{clearInterval(timer);});app.addHook('onReady',async()=>{void tick();});}
}
