import {createHash,randomUUID} from 'node:crypto';
import {and,desc,eq,inArray,isNull,lt,or,sql} from 'drizzle-orm';
import type {FastifyInstance} from 'fastify';
import {getDb,schema} from '@egc/database';
import {getObject,putObject} from '@egc/storage';
import {conversationExtractionSchema,extractConversation,extractWalkthrough,loadCatalogIndex,transcribeWalkthrough,walkthroughExtractionFromConversation} from '@egc/ai';
import {walkthroughExtractionSchema} from '@egc/schemas';
import {OperationsError,operationsService,SERVICE_ORIGINS,type Actor} from '@egc/operations';
import {recordingTaskProposals} from './conversation-tasks.js';
import {recordingFailureDiagnostic} from './recording-diagnostics.js';
import {portalAdapter} from './operations.js';
import {authorizeRecordingClaims,fingerprint,MAX_AUDIO_BYTES,MAX_RECORDING_ENVELOPE_CHARS,MAX_TRANSCRIPT_BYTES,RecordingIssuerRefusal,safeRecordingError,signRecordingEnvelope,stableUuid,verifyRecordingEnvelope,verifiedHubRecordingClaims,type RecordingClaims,type RecordingCommand} from './recording-contracts.js';
import {auditLogWriter,recordIssuerRefusal,serviceAuthEnabled,signApiServiceRequest,verifyHubServiceClaims,tokenVersion,type AuditRow} from './service-bridge.js';
type Row=typeof schema.walkthroughs.$inferSelect;
type Identity={portalJobId:string;portalVisitId:string;portalCustomerId:string;portalProjectId:string|null;portalRevision:string;highlevelContactId:string|null;authority:'employee_hub'};
type Approval=Extract<RecordingCommand,{command:'recording.approve'}>;
const TRANSCRIPT_CONTENT_TYPE='text/plain; charset=utf-8';
const isTranscriptRow=(row:Row)=>row.audioContentType===TRANSCRIPT_CONTENT_TYPE&&row.audioObjectKey===null;
export type RecordingDependencies={put:typeof putObject;get:typeof getObject;transcribe:typeof transcribeWalkthrough;extract:typeof extractWalkthrough;conversation?:typeof extractConversation;catalog?:typeof loadCatalogIndex};
// v2 rows keep the reviewed walkthrough shape in `extraction` (what the review screen edits and approves) and the
// evidence-validated conversation proposals beside it; the DTO lifts them out with their Action Center task drafts.
// Once a review is approved or pending, its tasks exist or are being created, so proposedTasks is empty.
const hasConversation=(extraction:unknown):extraction is {conversation:unknown}=>typeof extraction==='object'&&extraction!==null&&Object.hasOwn(extraction,'conversation');
const conversationView=(r:Row)=>{if(!hasConversation(r.extraction))return{};const{conversation,...extraction}=r.extraction,parsed=conversationExtractionSchema.safeParse(conversation),reviewed=r.status==='approved'||r.status==='approval_pending';return{extraction,conversation:parsed.success?parsed.data:null,proposedTasks:parsed.success&&!reviewed?recordingTaskProposals(parsed.data,r):[]};};
const publicRow=(r:Row)=>{const{audioObjectKey,approvalPayload,audioSha256,...safe}=r;return{...safe,...conversationView(r),sourceKind:isTranscriptRow(r)?'transcript':'audio',sourceFilename:r.audioFilename,sourceBytes:r.audioBytes,revision:r.updatedAt.toISOString(),pendingReview:r.status==='approval_pending'?(approvalPayload as {command?:unknown}|null)?.command??null:null,linkageExceptions:r.portalProjectId?[]:['project_link_not_established']};};

export class RecordingService{
  constructor(private env:NodeJS.ProcessEnv=process.env,private db=getDb(),private fetcher:typeof fetch=fetch,private io:RecordingDependencies={put:putObject,get:getObject,transcribe:transcribeWalkthrough,extract:extractWalkthrough,conversation:extractConversation,catalog:loadCatalogIndex}){}
  private get workspace(){return this.env.EGC_OPERATIONS_WORKSPACE??'egc';}
  private async portal(actor:Actor,body:Record<string,unknown>){
    const key=this.env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET??'',origin=new URL(this.env.EGC_PORTAL_ORIGIN??'https://invalid.invalid');
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.hostname==='invalid.invalid')throw new OperationsError('recording_bridge_not_configured',503);
    if(serviceAuthEnabled(this.env)&&origin.origin!==SERVICE_ORIGINS.hub)throw new OperationsError('service_origin_not_trusted',503);
    const requestId=randomUUID(),path='/api/operations-recording-approval';
    const envelope=serviceAuthEnabled(this.env)?await signApiServiceRequest(actor,body,path,requestId,this.env):signRecordingEnvelope({v:1,iss:'portal',aud:'egc-portal',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,request:{requestId,body}},key);
    let response:Response;try{response=await this.fetcher(new URL('/api/operations-recording-approval',origin),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(20000)});}catch{throw new OperationsError('recording_approval_outcome_unknown',503);}
    const result=await response.json() as Record<string,unknown>;
    if(!response.ok){const code=typeof result.error==='string'&&/^recording_[a-z_]+$/.test(result.error)?result.error:'recording_source_unavailable';throw new OperationsError(code,response.status>=500?503:409);}
    return result;
  }
  private async resolveSource(actor:Actor,portalJobId:string){
    const result=await this.portal(actor,{command:'recording.resolve',portalJobId}),identity=result.identity as Identity;
    if(identity?.authority!=='employee_hub'||identity.portalJobId!==portalJobId||!identity.portalCustomerId||!identity.portalVisitId||!identity.portalRevision)throw new OperationsError('recording_identity_unverified',409);
    return identity;
  }
  private assertCurrentSource(row:Row,identity:Identity){
    // A visit can gain its exact project link after capture. Keep reads and manager refresh
    // available while the job, visit and customer remain the same; approval still uses the
    // stored revision and project in the Hub's compare-and-swap apply.
    if(row.portalJobId!==identity.portalJobId||row.portalVisitId!==identity.portalVisitId||row.portalCustomerId!==identity.portalCustomerId)throw new OperationsError('recording_identity_changed',409);
  }
  async upload(claims:RecordingClaims,audio:Buffer,contentType:string){
    authorizeRecordingClaims(claims,this.workspace);
    const command=claims.request.body;if(command.command!=='recording.upload')throw new OperationsError('invalid_recording_upload',400);
    if(!audio.length||audio.length>MAX_AUDIO_BYTES)throw new OperationsError('recording_size_invalid',400);
    if(!/^audio\/(webm|mp4|mpeg|wav|x-wav|ogg|aac|flac)(;.*)?$/i.test(contentType))throw new OperationsError('recording_audio_type_invalid',400);
    const audioSha256=createHash('sha256').update(audio).digest('hex');if(audioSha256!==command.audioSha256)throw new OperationsError('recording_upload_digest_mismatch',400);
    const identity=await this.resolveSource(claims.actor,command.portalJobId);
    const existing=await this.db.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.workspaceId,this.workspace),eq(schema.walkthroughs.uploadRequestId,claims.request.requestId))).limit(1);
    let row=existing[0];
    if(row&&(row.audioSha256!==audioSha256||row.portalJobId!==command.portalJobId||row.uploadedBy!==claims.actor.id||isTranscriptRow(row)))throw new OperationsError('recording_upload_request_conflict',409);
    if(row)this.assertCurrentSource(row,identity);
    if(!row){
      const [contact]=identity.highlevelContactId?await this.db.select({id:schema.contacts.id}).from(schema.contacts).where(and(eq(schema.contacts.provider,'ghl'),eq(schema.contacts.providerId,identity.highlevelContactId))).limit(1):[];
      const id=stableUuid(`recording:${this.workspace}:${claims.request.requestId}`),audioObjectKey=`recordings/${this.workspace}/${id}/audio`;
      const {authority,highlevelContactId,...links}=identity;
      await this.db.insert(schema.walkthroughs).values({id,workspaceId:this.workspace,...links,contactId:contact?.id??null,status:'uploading',uploadRequestId:claims.request.requestId,uploadedBy:claims.actor.id,audioObjectKey,audioContentType:contentType,audioFilename:'recording',audioBytes:audio.length,audioSha256}).onConflictDoNothing();
      row=await this.row(id);
      if(row.audioSha256!==audioSha256||row.portalJobId!==command.portalJobId||row.uploadedBy!==claims.actor.id||isTranscriptRow(row))throw new OperationsError('recording_upload_request_conflict',409);
      this.assertCurrentSource(row,identity);
    }
    if(row.status!=='uploading'&&!(row.status==='failed'&&row.lastErrorCode==='recording_upload_failed'))return{ok:true,alreadySaved:true,recording:publicRow(row)};
    try{await this.io.put(row.audioObjectKey!,audio,contentType);await this.db.update(schema.walkthroughs).set({status:'uploaded',lastErrorCode:null,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),inArray(schema.walkthroughs.status,['uploading','failed'])));}catch{await this.db.update(schema.walkthroughs).set({status:'failed',lastErrorCode:'recording_upload_failed',updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.status,'uploading')));throw new OperationsError('recording_upload_failed',503);}
    return{ok:true,recording:publicRow(await this.row(row.id))};
  }
  async saveTranscript(claims:RecordingClaims){
    authorizeRecordingClaims(claims,this.workspace);
    const command=claims.request.body;if(command.command!=='recording.transcript')throw new OperationsError('invalid_recording_transcript',400);
    const bytes=Buffer.byteLength(command.transcript,'utf8');
    if(!command.transcript.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command.transcript))throw new OperationsError('recording_transcript_invalid',400);
    if(bytes>MAX_TRANSCRIPT_BYTES)throw new OperationsError('recording_transcript_size_invalid',413);
    const identity=await this.resolveSource(claims.actor,command.portalJobId);
    const digest=createHash('sha256').update(command.transcript,'utf8').digest('hex');
    const filename=command.filename??null;
    const [existing]=await this.db.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.workspaceId,this.workspace),eq(schema.walkthroughs.uploadRequestId,claims.request.requestId))).limit(1);
    if(existing){
      if(!isTranscriptRow(existing)||existing.audioSha256!==digest||existing.portalJobId!==command.portalJobId||existing.audioFilename!==filename||existing.uploadedBy!==claims.actor.id)throw new OperationsError('recording_upload_request_conflict',409);
      this.assertCurrentSource(existing,identity);
      return{ok:true,alreadySaved:true,recording:publicRow(existing)};
    }
    const [contact]=identity.highlevelContactId?await this.db.select({id:schema.contacts.id}).from(schema.contacts).where(and(eq(schema.contacts.provider,'ghl'),eq(schema.contacts.providerId,identity.highlevelContactId))).limit(1):[];
    const id=stableUuid(`recording:${this.workspace}:${claims.request.requestId}`),{authority,highlevelContactId,...links}=identity;
    await this.db.insert(schema.walkthroughs).values({id,workspaceId:this.workspace,...links,contactId:contact?.id??null,status:'uploaded',uploadRequestId:claims.request.requestId,uploadedBy:claims.actor.id,audioObjectKey:null,audioContentType:TRANSCRIPT_CONTENT_TYPE,audioFilename:filename,audioBytes:bytes,audioSha256:digest,transcript:command.transcript}).onConflictDoNothing();
    const row=await this.row(id);
    if(!isTranscriptRow(row)||row.audioSha256!==digest||row.portalJobId!==command.portalJobId||row.audioFilename!==filename||row.uploadedBy!==claims.actor.id)throw new OperationsError('recording_upload_request_conflict',409);
    this.assertCurrentSource(row,identity);
    return{ok:true,recording:publicRow(row)};
  }
  private async row(id:string){const[row]=await this.db.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.id,id),eq(schema.walkthroughs.workspaceId,this.workspace))).limit(1);if(!row)throw new OperationsError('recording_not_found',404);return row;}
  async execute(c:RecordingClaims){const command=c.request.body;
    authorizeRecordingClaims(c,this.workspace);
    if(command.command==='recording.list'){const identity=await this.resolveSource(c.actor,command.portalJobId);const rows=await this.db.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.workspaceId,this.workspace),eq(schema.walkthroughs.portalJobId,command.portalJobId))).orderBy(desc(schema.walkthroughs.createdAt),desc(schema.walkthroughs.id)).limit(51).offset(command.offset);for(const row of rows)this.assertCurrentSource(row,identity);return{ok:true,recordings:rows.slice(0,50).map(publicRow),nextOffset:rows.length>50?command.offset+50:null};}
    if(command.command==='recording.upload')throw new OperationsError('recording_audio_required',400);
    if(command.command==='recording.transcript')return this.saveTranscript(c);
    const row=await this.row(command.recordingId);
    if(!row.portalJobId)throw new OperationsError('recording_identity_unverified',409);
    const identity=await this.resolveSource(c.actor,row.portalJobId);
    this.assertCurrentSource(row,identity);
    if(command.command==='recording.get')return{ok:true,recording:publicRow(row)};
    if(command.command==='recording.refresh_source'){
      if(!['owner','manager'].includes(c.actor.role))throw new OperationsError('human_manager_approval_required',403);
      if(row.status!=='draft'&&!(row.status==='approval_pending'&&row.lastErrorCode==='recording_source_revision_conflict'))throw new OperationsError('recording_review_refresh_not_safe',409);
      await this.db.update(schema.walkthroughs).set({status:'draft',portalProjectId:identity.portalProjectId,portalRevision:identity.portalRevision,approvalPayload:null,approvalFingerprint:null,approvalRequestId:null,lastErrorCode:null,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.updatedAt,row.updatedAt)));
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
  async processNext(onFailure:(details:ReturnType<typeof recordingFailureDiagnostic>&{event:string;stage:string;attempt:number;sourceKind:string})=>void=()=>{}){
    const now=new Date();
    const row=await this.db.transaction(async tx=>{
      const [r]=await tx.select().from(schema.walkthroughs).where(and(eq(schema.walkthroughs.workspaceId,this.workspace),or(eq(schema.walkthroughs.status,'uploaded'),and(eq(schema.walkthroughs.status,'processing'),or(isNull(schema.walkthroughs.processingLeaseUntil),lt(schema.walkthroughs.processingLeaseUntil,now)))))).orderBy(schema.walkthroughs.createdAt).limit(1).for('update',{skipLocked:true});
      if(!r)return null;
      if(r.status==='processing'&&r.attemptCount>=5){await tx.update(schema.walkthroughs).set({status:'failed',lastErrorCode:'recording_processing_attempts_exhausted',processingLeaseUntil:null,updatedAt:now}).where(eq(schema.walkthroughs.id,r.id));return null;}
      const [claimed]=await tx.update(schema.walkthroughs).set({status:'processing',attemptCount:r.attemptCount+1,processingLeaseUntil:new Date(now.getTime()+15*60*1000),lastErrorCode:null,updatedAt:now}).where(eq(schema.walkthroughs.id,r.id)).returning();return claimed!;
    });
    if(!row)return false;
    let stage=isTranscriptRow(row)?'extraction':'transcription';
    try{
      const transcript=isTranscriptRow(row)?row.transcript:await this.io.transcribe(await this.io.get(row.audioObjectKey!),row.audioFilename??'recording',row.audioContentType??'audio/webm');
      if(!transcript)throw new OperationsError('recording_transcript_missing',409);
      stage='extraction';
      const {extraction,extractionVersion}=isTranscriptRow(row)||this.env.EGC_EXTRACTION_V2==='true'?await this.extractConversation(row,transcript):await this.extractWalkthrough(transcript);
      stage='save_draft';
      await this.db.update(schema.walkthroughs).set({transcript,extraction,extractionVersion,status:'draft',processingLeaseUntil:null,lastErrorCode:null,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.attemptCount,row.attemptCount),eq(schema.walkthroughs.status,'processing')));
    }catch(error){
      let diagnostic:ReturnType<typeof recordingFailureDiagnostic>={code:'processing_failed'};
      try{diagnostic=recordingFailureDiagnostic(error);}catch{}
      const lastErrorCode=diagnostic.code==='credit_balance_exhausted'&&diagnostic.status===429?'recording_ai_credits_exhausted':'recording_processing_failed';
      await this.db.update(schema.walkthroughs).set({status:'failed',processingLeaseUntil:null,lastErrorCode,updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.attemptCount,row.attemptCount),eq(schema.walkthroughs.status,'processing')));
      // Only the fixed credit recovery category is stored; provider details stay in safe server diagnostics.
      try{onFailure({event:'recording_processing_failed',stage,attempt:row.attemptCount,sourceKind:isTranscriptRow(row)?'transcript':'audio',...diagnostic});}catch{}
    }
    return true;
  }
  private async extractWalkthrough(transcript:string){return{extraction:walkthroughExtractionSchema.parse(await this.io.extract(transcript)),extractionVersion:1};}
  // EGC_EXTRACTION_V2: proposals are drafts for review. Nothing here creates a task, assigns an owner or due time, or sends.
  private async extractConversation(row:Row,transcript:string){
    const catalog=(this.io.catalog??loadCatalogIndex)();
    const result=await(this.io.conversation??extractConversation)(transcript,{catalog:catalog.items,catalogVersion:catalog.catalogVersion,context:{sourceKind:isTranscriptRow(row)?'visit_transcript':'visit_recording',occurredAt:row.createdAt.toISOString()}});
    // Too long for v2: the walkthrough extraction (the flag-off path) keeps the recording reviewable instead of failing it for good.
    if(!result.ok&&result.code==='conversation_transcript_too_large')return this.extractWalkthrough(transcript);
    if(!result.ok)throw new OperationsError(result.code,result.retryable?503:422);
    return{extraction:{...walkthroughExtractionFromConversation(result.extraction),conversation:result.extraction},extractionVersion:2};
  }
  private async approve(actor:Actor,requestId:string,command:Approval){
    if(!['owner','manager'].includes(actor.role)||actor.kind!=='human')throw new OperationsError('human_manager_approval_required',403);
    const validationBridge=portalAdapter(this.env.EGC_PORTAL_ORIGIN!,this.env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET??'',this.workspace,this.fetcher,this.env);
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
      const bridge=portalAdapter(this.env.EGC_PORTAL_ORIGIN!,this.env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET??'',this.workspace,this.fetcher,this.env),operations=operationsService({workspace:this.workspace,resolvePortalJob:bridge.resolve,resolveOwner:bridge.owner,portalRead:bridge.read});
      for(let i=0;i<stored.command.actions.length;i++){const action=stored.command.actions[i]!;await operations.execute(stored.actor,{command:'task.create',task:{...action,dedupeKey:`recording:${row.id}:action:${i}`,sourceEvidence:[...action.sourceEvidence,{source:'recording',id:row.id,excerpt:action.description.slice(0,2000)}]}},stableUuid(`recording:${row.id}:action:${i}`));}
      await this.db.transaction(async tx=>{const[current]=await tx.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.id,row.id)).for('update');if(current?.status==='approved')return;const approved=hasConversation(current?.extraction)?{...stored.command.extraction,conversation:current.extraction.conversation}:stored.command.extraction;await tx.update(schema.walkthroughs).set({status:'approved',extraction:approved,approvedBy:stored.actor.id,approvedAt:new Date(),approvedRevision:row.portalRevision,lastErrorCode:null,updatedAt:new Date()}).where(eq(schema.walkthroughs.id,row.id));await tx.insert(schema.auditLogs).values({actor:stored.actor.id,action:'recording.approve',entity:'walkthrough',entityId:row.id,source:'employee_hub',newValue:{portalJobId:row.portalJobId,portalVisitId:row.portalVisitId,fingerprint:hash,actions:stored.command.actions.length}});});
      return{ok:true,recording:publicRow(await this.row(row.id))};
    }catch(error){await this.db.update(schema.walkthroughs).set({lastErrorCode:safeRecordingError(error),updatedAt:new Date()}).where(and(eq(schema.walkthroughs.id,row.id),eq(schema.walkthroughs.status,'approval_pending')));throw error;}
  }
}

export async function registerRecordingRoutes(app:FastifyInstance,env:NodeJS.ProcessEnv=process.env,service?:RecordingService,audit:(row:AuditRow)=>Promise<unknown>=auditLogWriter){
  const enabled=env.EGC_OPERATIONS_ENABLED==='true',s=service??(enabled?new RecordingService(env):undefined);
  async function verified(token:unknown,path:string){if(serviceAuthEnabled(env)&&tokenVersion(token,path==='/recordings/rpc'?MAX_RECORDING_ENVELOPE_CHARS:220_000)===2)return verifiedHubRecordingClaims(await verifyHubServiceClaims(token,path,env),env.EGC_OPERATIONS_WORKSPACE??'egc');return verifyRecordingEnvelope(token,{portal:serviceAuthEnabled(env)?'':env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET??'',mcp:env.EGC_OPERATIONS_MCP_SIGNING_SECRET??''},env.EGC_OPERATIONS_WORKSPACE??'egc');}
  // BRIDGE-ADOPT-AUTHZ: an unbound integration actor is logged and audited like /operations/rpc before the refusal is returned.
  async function claims(token:unknown,path:string){if(!enabled||!s)throw new OperationsError('operations_not_enabled',503);try{return await verified(token,path);}catch(e){if(e instanceof RecordingIssuerRefusal){const c=e.claims;await recordIssuerRefusal(app.log,audit,e,{issuer:e.issuer,actor:c.actor,command:c.request.body.command,requestId:c.request.requestId,entity:'recording_request',source:'recordings'});}throw e;}}
  function failure(error:unknown,reply:import('fastify').FastifyReply){return reply.code(error instanceof OperationsError?error.status:503).send({error:safeRecordingError(error),retryable:!(error instanceof OperationsError)||error.status>=500});}
  app.post('/recordings/rpc',{bodyLimit:MAX_RECORDING_ENVELOPE_CHARS+10_000},async(request,reply)=>{reply.header('Cache-Control','no-store');try{const c=await claims((request.body as {envelope?:unknown})?.envelope,'/recordings/rpc');return await s!.execute(c);}catch(e){return failure(e,reply);}});
  app.post('/recordings/upload',async(request,reply)=>{reply.header('Cache-Control','no-store');try{let c:RecordingClaims|undefined,audio:Buffer|undefined,type='';for await(const part of request.parts({limits:{fileSize:MAX_AUDIO_BYTES,files:1,fields:1}})){if(part.type==='field'&&part.fieldname==='envelope')c=await claims(part.value,'/recordings/upload');else if(part.type==='file'&&part.fieldname==='audio'){if(!c)throw new OperationsError('recording_signature_required_first',401);audio=await part.toBuffer();type=part.mimetype;}}if(!c||!audio)throw new OperationsError('recording_audio_required',400);return reply.code(202).send(await s!.upload(c,audio,type));}catch(e){return failure(e,reply);}});
  if(enabled&&env.EGC_EXTRACTION_V2==='true'){const skipped=loadCatalogIndex().skippedItems;if(skipped)app.log.warn({code:'catalog_index_items_skipped',count:skipped},'Catalog index items were left out; their mentions get no catalogItemId');}
  if(enabled&&s){let running=false;const tick=async()=>{if(running)return;running=true;try{await s.processNext(details=>app.log.warn(details,'Recording draft could not be prepared'));}catch{app.log.warn({code:'recording_worker_unavailable'},'Recording processing will retry');}finally{running=false;}};const timer=setInterval(()=>void tick(),15000);timer.unref();app.addHook('onClose',async()=>{clearInterval(timer);});app.addHook('onReady',async()=>{void tick();});}
}
