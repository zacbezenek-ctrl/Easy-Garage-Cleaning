import {customerTimeline,type PortalTimelineEvent} from "./timeline.js";
import {operationalHealth} from "./health.js";
import {createHash,randomUUID} from "node:crypto";
import {and,asc,desc,eq,gt,gte,inArray,isNull,lt,ne,notInArray,or,sql} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
import {buildDueWorkSnapshot,collectTaskPages,pageDueWork,type QueueSnapshot,type SourceCoverage,type WaitingOn} from "@egc/lead-audit/operations-core";
import {authorize,commandSchema,OperationsError,WRITE_COMMANDS,type Actor,type Command} from "./contracts.js";
import {assertCompletion,assertEditable,assertTiming,digest,jsonRecord} from "./policy.js";

type Db=ReturnType<typeof getDb>;
type Tx=Parameters<Parameters<Db["transaction"]>[0]>[0];
type Task=typeof schema.tasks.$inferSelect;
const active=["open","in_progress","blocked"];
export interface PortalJobReference {
  id:string; revision:string; type:string; highlevelContactId:string|null;
  sourceWalkthroughId:string|null; customer:string|null; status:string;
}
export interface OperationsConfiguration {
  workspace:string;
  now?:()=>Date;
  resolvePortalJob?:(id:string)=>Promise<PortalJobReference>;
  resolveOwner?:(id:string)=>Promise<boolean>;
  portalRead?:(actor:Actor,command:Command)=>Promise<Record<string,unknown>>;
  syncSchedule?:(actor:Actor,command:Extract<Command,{command:"schedule.sync_provider"}>)=>Promise<Record<string,unknown>>;
  ensureProviderNote?:(actor:Actor,command:Extract<Command,{command:"provider.note.ensure"}>)=>Promise<Record<string,unknown>>;
  canonicalRead?:(actor:Actor,command:Extract<Command,{command:"intelligence.report"|"intelligence.diagnostics"|"intelligence.customer"}>)=>Promise<Record<string,unknown>>;
}

/** One service over the existing task records. All public adapters must authenticate
 * a principal before calling execute. Writes are idempotent in the SAME transaction
 * as their task changes, audit records and exact approvals. No provider send occurs.
 */
export class OperationsService {
  constructor(private db:Db, private config:OperationsConfiguration) {}
  private now() {return this.config.now?.() ?? new Date();}
  async execute(actor:Actor,raw:unknown,requestId:string):Promise<Record<string,unknown>> {
    const parsed=commandSchema.safeParse(raw);
    if (!parsed.success) throw new OperationsError("invalid_command",400,{issues:parsed.error.issues.map(i=>({path:i.path,message:i.message}))});
    const command=parsed.data;
    authorize(actor,command,this.config.workspace);
    // Adoption proof is produced by the backend's exact-source verifier. Public
    // RPC/MCP callers cannot supply proof or bypass that verifier via this service.
    if(command.command==='schedule.adopt')throw new OperationsError('schedule_adoption_internal_only',403);
    if(command.command==="intelligence.report"||command.command==="intelligence.diagnostics"||command.command==="intelligence.customer"){
      if(!this.config.canonicalRead)throw new OperationsError("canonical_customer_state_unavailable",503);
      return this.config.canonicalRead(actor,command);
    }
    if(command.command==="provider.note.ensure"){
      if(!this.config.ensureProviderNote)throw new OperationsError("provider_note_bridge_unavailable",503);
      return this.config.ensureProviderNote(actor,command);
    }
    const portalEvents:PortalTimelineEvent[]=[];
    if(command.command==="schedule.sync_provider"){
      if(!this.config.syncSchedule)throw new OperationsError("schedule_provider_sync_unavailable",503);
      return this.config.syncSchedule(actor,command);
    }
    if(command.command==="history" && command.portalJobId) {
      if(!this.config.resolvePortalJob)throw new OperationsError("portal_authority_unavailable",503);
      const record=await this.config.resolvePortalJob(command.portalJobId);
      if(!record.highlevelContactId)throw new OperationsError("portal_customer_link_unresolved",409);
      const [contact]=await this.db.select({id:schema.contacts.id}).from(schema.contacts).where(and(eq(schema.contacts.provider,"ghl"),eq(schema.contacts.providerId,record.highlevelContactId))).limit(1);
      if(!contact)throw new OperationsError("portal_customer_not_reconciled",409);
      if(command.contactId && command.contactId!==contact.id)throw new OperationsError("portal_contact_mismatch",409);
      command.contactId=contact.id;
      if(this.config.portalRead){
        const detail=await this.config.portalRead(actor,{command:"portal.job",jobId:command.portalJobId});
        const job=detail.job as Record<string,unknown>|undefined,finance=detail.financials as Record<string,unknown>|undefined;
        if(!job||job.id!==command.portalJobId||job.highlevelContactId!==record.highlevelContactId)throw new OperationsError("portal_identity_changed",409);
        for(const value of Array.isArray(finance?.timeline)?finance.timeline:[]){const e=value as PortalTimelineEvent;if(e&&typeof e.id==="string"&&typeof e.kind==="string"&&typeof e.at==="string"&&Number.isFinite(Date.parse(e.at)))portalEvents.push({...e,id:"hub:"+e.id,data:{...e.data,authority:"employee_hub",association:"exact_portal_record"}});}
        for(const value of Array.isArray(job.operationNotes)?job.operationNotes:[]){const n=value as Record<string,unknown>;if(typeof n.createdAt==="string"&&Number.isFinite(Date.parse(n.createdAt)))portalEvents.push({id:"hub-note:"+String(n.id),kind:"job_note",at:n.createdAt,data:{body:n.body,actor:n.actorId,portalJobId:job.id,projectId:job.projectId,supersedes:n.supersedes,authority:"employee_hub",association:"exact_portal_record"}});}
        if(job.type==="walkthrough"&&typeof job.completedAt==="string"&&Number.isFinite(Date.parse(job.completedAt)))portalEvents.push({id:"hub-walkthrough:"+String(job.id),kind:"walkthrough_completed",at:job.completedAt,data:{portalVisitId:job.id,authority:"employee_hub",association:"exact_visit"}});
      }
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new OperationsError("request_id_required",400);
    if (["portal.note.add","portal.job.edit","portal.project.ensure","calendar","portal.job","portal.evidence","portal.members","portal.revenue","portal.rules","schedule.resolve","schedule.mutate","schedule.bind_provider","schedule.link_customer"].includes(command.command)) {
      if (!this.config.portalRead) throw new OperationsError("portal_authority_unavailable",503);
      return this.config.portalRead(actor,command);
    }
    const requestDigest=digest({actor:{id:actor.id,kind:actor.kind,role:actor.role,workspace:actor.workspace},command});
    // Recover completed retries before calling any optional upstream identity adapter.
    // The transactional check below is still required for competing first attempts.
    if(WRITE_COMMANDS.has(command.command)) {
      const [prior]=await this.db.select().from(schema.operationRequests).where(and(eq(schema.operationRequests.workspaceId,actor.workspace),eq(schema.operationRequests.actorId,actor.id),eq(schema.operationRequests.requestId,requestId))).limit(1);
      if(prior) {if(prior.digest!==requestDigest)throw new OperationsError("idempotency_key_payload_conflict",409);return {...prior.response,replayed:true};}
    }
    const owner=command.command==="task.create"?command.task.assignedUserId:command.command==="task.edit"?command.changes.assignedUserId:undefined;
    if(owner && (!this.config.resolveOwner || !await this.config.resolveOwner(owner)))throw new OperationsError("owner_not_verified",409);
    let portal:PortalJobReference|null=null;
    if (command.command === "task.create" && command.task.portalJobId) {
      if (!this.config.resolvePortalJob) throw new OperationsError("portal_identity_adapter_unavailable",503);
      portal=await this.config.resolvePortalJob(command.task.portalJobId);
      if (portal.id !== command.task.portalJobId || !portal.revision) throw new OperationsError("portal_identity_unverified",409);
      if (command.task.portalVisitId && command.task.portalVisitId !== (portal.type === "walkthrough" ? portal.id : portal.sourceWalkthroughId))
        throw new OperationsError("portal_visit_job_mismatch",409);
    }
    if (!WRITE_COMMANDS.has(command.command)) {
      return this.db.transaction(tx=>this.read(tx,actor,command,portalEvents),{isolationLevel:"repeatable read",accessMode:"read only"});
    }
    return this.db.transaction(async tx=>{
      // Serialize retries of one authenticated logical request. Different request IDs
      // still contend on the task row and its required revision, not on a global lock.
      const lockKey=`operations:${actor.workspace}:${actor.id}:${requestId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey},0))`);
      const [prior]=await tx.select().from(schema.operationRequests).where(and(
        eq(schema.operationRequests.workspaceId,actor.workspace),eq(schema.operationRequests.actorId,actor.id),eq(schema.operationRequests.requestId,requestId))).limit(1);
      if (prior) {
        if (prior.digest!==requestDigest) throw new OperationsError("idempotency_key_payload_conflict",409);
        return {...prior.response,replayed:true};
      }
      await tx.execute(sql`select set_config('egc.operations_actor',${actor.id},true),set_config('egc.operations_actor_kind',${actor.kind},true)`);
      const result=await this.write(tx,actor,command,portal);
      const response=jsonRecord(result);
      await tx.insert(schema.operationRequests).values({workspaceId:actor.workspace,actorId:actor.id,requestId,digest:requestDigest,response});
      return response;
    });
  }
  private async task(tx:Tx,actor:Actor,id:string,lock=false):Promise<Task> {
    const query=tx.select().from(schema.tasks).where(and(eq(schema.tasks.id,id),eq(schema.tasks.workspaceId,actor.workspace))).limit(1);
    const [task]=lock ? await query.for("update") : await query;
    if (!task) throw new OperationsError("task_not_found",404);
    return task;
  }
  private assertRevision(task:Task,revision:number) {
    if (task.revision!==revision) throw new OperationsError("task_revision_conflict",409,{taskId:task.id,currentRevision:task.revision});
  }
  private async context(tx:Tx,task:Task,ignoreProviderMessageId?:string) {
    if (!task.contactId) return {contactId:null,lastMessage:null,lastCall:null,contactRestricted:null};
    const [message]=await tx.select({id:schema.messages.id,at:schema.messages.updatedAt,body:schema.messages.body,direction:schema.messages.direction})
      .from(schema.messages).where(and(eq(schema.messages.contactId,task.contactId),ignoreProviderMessageId?ne(schema.messages.providerId,ignoreProviderMessageId):undefined)).orderBy(desc(schema.messages.updatedAt),desc(schema.messages.id)).limit(1);
    const [call]=await tx.select({id:schema.calls.id,at:schema.calls.updatedAt,status:schema.calls.status})
      .from(schema.calls).where(eq(schema.calls.contactId,task.contactId)).orderBy(desc(schema.calls.updatedAt),desc(schema.calls.id)).limit(1);
    const [lead]=await tx.select({restricted:schema.leads.doNotContact}).from(schema.leads).where(eq(schema.leads.contactId,task.contactId)).limit(1);
    return jsonRecord({contactId:task.contactId,lastMessage:message??null,lastCall:call??null,contactRestricted:lead?.restricted??null});
  }
  private async preview(tx:Tx,task:Task,ignoreProviderMessageId?:string) {
    const {updatedAt:_,approvalStatus:__,...content}=task;
    const subject=jsonRecord({task:content,conversation:await this.context(tx,task,ignoreProviderMessageId),scope:"draft_review",policy:"operations-draft-review-v1"});
    return {subject,hash:digest(subject)};
  }
  private async event(tx:Tx,actor:Actor,task:Task|null,type:string,evidence:Record<string,unknown>={}) {
    await tx.insert(schema.operationEvents).values({workspaceId:actor.workspace,taskId:task?.id??null,revision:task?.revision??null,
      type,actorId:actor.id,actorKind:actor.kind,source:"operations",evidence:jsonRecord(evidence),occurredAt:this.now()});
  }
  private async read(tx:Tx,actor:Actor,command:Command,portalEvents:PortalTimelineEvent[]=[]):Promise<Record<string,unknown>> {
    switch(command.command) {
      case "status": return {ok:true,contractVersion:1,workspace:actor.workspace,actor,health:await operationalHealth(tx,actor.workspace),
        capabilities:{tasks:true,exactDraftApprovals:true,persistedBriefs:true,externalExecution:false,portalIdentity:Boolean(this.config.resolvePortalJob)},
        tenancy:"single-workspace-deployment",release:process.env.RAILWAY_GIT_COMMIT_SHA??process.env.EGC_RELEASE_SHA??null,externalExecutionReason:"Action draft review never sends. Explicitly authorized messaging and scheduling use separate durable execution tools."};
      case "queue": {
        const now=this.now();
        const attention=sql<Date>`case when ${schema.tasks.waitingOn} in ('customer','provider') then ${schema.tasks.reviewAt} else ${schema.tasks.dueAt} end`;
        const conditions=[eq(schema.tasks.workspaceId,actor.workspace),inArray(schema.tasks.status,active)];
        if (command.owner) conditions.push(eq(schema.tasks.assignedUserId,command.owner));
        // SQL expressions lack a column's Date encoder; bind ISO strings so the
        // postgres driver receives valid timestamp parameters in every queue view.
        if (command.view==="due") conditions.push(or(lt(attention,command.dueBefore),isNull(attention))!);
        if (command.view==="overdue") conditions.push(lt(attention,now.toISOString()));
        if (command.view==="approvals") conditions.push(or(inArray(schema.tasks.approvalStatus,["pending","invalidated"]),and(eq(schema.tasks.approvalStatus,"approved"),sql`not exists(select 1 from ${schema.operationApprovals} where ${schema.operationApprovals.taskId}=${schema.tasks.id} and ${schema.operationApprovals.taskRevision}=${schema.tasks.revision} and ${schema.operationApprovals.expiresAt}>${now.toISOString()})`))!);
        if (command.view==="blocked") conditions.push(eq(schema.tasks.status,"blocked"));
        if (command.view==="waiting") conditions.push(inArray(schema.tasks.waitingOn,["customer","provider"]));
        if (command.view==="ownerless") conditions.push(or(isNull(schema.tasks.assignedUserId),eq(schema.tasks.assignedUserId,""))!);
        const predicate=and(...conditions);
        const [count]=await tx.select({n:sql<number>`count(*)::int`}).from(schema.tasks).where(predicate);
        const rows=await tx.select().from(schema.tasks).where(predicate).orderBy(asc(attention),asc(schema.tasks.id)).limit(command.limit).offset(command.offset);
        return {ok:true,items:rows,total:count?.n??0,offset:command.offset,nextOffset:command.offset+rows.length<(count?.n??0)?command.offset+rows.length:null,
          asOf:now.toISOString(),consistency:"repeatable-read-for-this-page",coverage:{registeredTasks:"complete",inferredCommitments:"not_complete",portalCalendar:"separate_authority"}};
      }
      case "task.get": {
        const task=await this.task(tx,actor,command.taskId);
        const preview=await this.preview(tx,task);
        const approvals=await tx.select().from(schema.operationApprovals).where(and(eq(schema.operationApprovals.workspaceId,actor.workspace),eq(schema.operationApprovals.taskId,task.id))).orderBy(desc(schema.operationApprovals.createdAt)).limit(50);
        const history=await tx.select().from(schema.operationEvents).where(and(eq(schema.operationEvents.workspaceId,actor.workspace),eq(schema.operationEvents.taskId,task.id))).orderBy(desc(schema.operationEvents.occurredAt),desc(schema.operationEvents.id)).limit(100);
        const approval=approvals.find(a=>a.taskRevision===task.revision && a.fingerprint===preview.hash && a.expiresAt>this.now());
        return {ok:true,task,previewHash:preview.hash,approvalScope:"draft_review",effectiveApproval:task.approvalStatus==="approved"?(approval?"approved":"invalidated_or_expired"):task.approvalStatus,
          approvals,history,historyLimit:100,historyMayHaveMore:history.length===100,externalExecution:false};
      }
      case "brief.latest": {
        const [brief]=await tx.select({id:schema.operationBriefs.id}).from(schema.operationBriefs).where(eq(schema.operationBriefs.workspaceId,actor.workspace)).orderBy(desc(schema.operationBriefs.generatedAt)).limit(1);
        if (!brief) return {ok:true,brief:null};
        return this.read(tx,actor,{command:"brief.get",briefId:brief.id,offset:command.offset,limit:command.limit});
      }
      case "brief.get": {
        const [brief]=await tx.select().from(schema.operationBriefs).where(and(eq(schema.operationBriefs.id,command.briefId),eq(schema.operationBriefs.workspaceId,actor.workspace))).limit(1);
        if (!brief) throw new OperationsError("brief_not_found",404);
        const snapshot=brief.snapshot as unknown as QueueSnapshot & {approvalStates?:Record<string,string>};
        const page=pageDueWork(snapshot,command.offset,command.limit);
        const current=page.items.length?await tx.select({id:schema.tasks.id,revision:schema.tasks.revision,status:schema.tasks.status,approvalStatus:schema.tasks.approvalStatus})
          .from(schema.tasks).where(and(eq(schema.tasks.workspaceId,actor.workspace),inArray(schema.tasks.id,page.items.map(i=>i.id)))):[];
        const byId=new Map(current.map(t=>[t.id,t]));
        return {ok:true,brief:{...page,timeZone:brief.timeZone,generatedBy:brief.generatedBy},changes:page.items.flatMap(item=>{
          const live=byId.get(item.id);
          return !live || live.revision!==item.revision || (snapshot.approvalStates?.[item.id]!==undefined && snapshot.approvalStates[item.id]!==live.approvalStatus) ? [{taskId:item.id,snapshotRevision:item.revision,current:live??null}]:[];
        }),note:"Snapshot membership does not change. Review current task details before approving."};
      }
      case "history": {
        if(!command.contactId)throw new OperationsError("contact_link_required",409);
        const [contact]=await tx.select({id:schema.contacts.id,name:schema.contacts.name}).from(schema.contacts).where(eq(schema.contacts.id,command.contactId)).limit(1);
        if (!contact) throw new OperationsError("contact_not_found",404);
        return {ok:true,contact,...await customerTimeline(tx,command.contactId,actor.workspace,command.offset,command.limit,portalEvents)};
      }
      default:throw new OperationsError("unsupported_read",400);
    }
  }
  private async write(tx:Tx,actor:Actor,command:Command,portal:PortalJobReference|null):Promise<Record<string,unknown>> {
    if(command.command==="task.create") {
      const input=command.task;
      if(actor.role==="sales" && input.assignedUserId!==actor.id) throw new OperationsError("assignment_requires_manager",403);
      let contactId=input.contactId;
      if(portal?.highlevelContactId) {
        const [mapped]=await tx.select({id:schema.contacts.id}).from(schema.contacts).where(and(eq(schema.contacts.provider,"ghl"),eq(schema.contacts.providerId,portal.highlevelContactId))).limit(1);
        if(contactId && mapped?.id!==contactId) throw new OperationsError("portal_contact_mismatch",409);
        contactId=mapped?.id??null;
      }
      if(contactId) {
        const [contact]=await tx.select({id:schema.contacts.id}).from(schema.contacts).where(eq(schema.contacts.id,contactId)).limit(1);
        if(!contact) throw new OperationsError("contact_not_found",404);
      }
      if(input.jobId) {
        const [job]=await tx.select().from(schema.jobs).where(eq(schema.jobs.id,input.jobId)).limit(1);
        if(!job || (contactId && contactId!==job.contactId)) throw new OperationsError("platform_job_contact_mismatch",409);
        contactId=job.contactId;
        // Source-qualified portal and PostgreSQL job IDs require a proven bridge; never infer equivalence.
        if(input.portalJobId) throw new OperationsError("cross_store_job_mapping_not_verified",409);
      }
      if(input.dependencies.length) {
        const rows=await tx.select({id:schema.tasks.id}).from(schema.tasks).where(and(eq(schema.tasks.workspaceId,actor.workspace),inArray(schema.tasks.id,input.dependencies)));
        if(new Set(input.dependencies).size!==input.dependencies.length || rows.length!==input.dependencies.length) throw new OperationsError("invalid_dependencies",400);
      }
      if(input.dedupeKey) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`task-dedupe:${actor.workspace}:${input.dedupeKey}`},0))`);
        const [duplicate]=await tx.select({id:schema.tasks.id}).from(schema.tasks).where(and(eq(schema.tasks.workspaceId,actor.workspace),eq(schema.tasks.dedupeKey,input.dedupeKey))).limit(1);
        if(duplicate) throw new OperationsError("task_already_exists",409,{taskId:duplicate.id});
      }
      const [task]=await tx.insert(schema.tasks).values({workspaceId:actor.workspace,title:input.title,description:input.description,kind:input.kind,
        priority:input.priority,assignedUserId:input.assignedUserId,dueAt:new Date(input.dueAt),timeZone:input.timeZone,waitingOn:input.waitingOn,
        reviewAt:input.reviewAt?new Date(input.reviewAt):null,portalJobId:input.portalJobId,portalVisitId:input.portalVisitId,portalRevision:portal?.revision??null,
        contactId,jobId:input.jobId,completionCondition:input.completionCondition,sourceEvidence:input.sourceEvidence,dependencies:input.dependencies,
        draftPayload:input.draft?jsonRecord(input.draft):null,dedupeKey:input.dedupeKey??null,approvalStatus:input.kind==="followup_message"?"pending":"not_required",
        source:"operations",status:"open",createdAt:this.now(),updatedAt:this.now()}).returning();
      if(!task) throw new OperationsError("task_create_failed",500);
      await this.event(tx,actor,task,"task.created",{task,portalReference:portal});
      return {ok:true,task,portalReference:portal};
    }
    if(command.command==="tasks.approve") {
      if(new Set(command.items.map(i=>i.taskId)).size!==command.items.length) throw new OperationsError("duplicate_batch_task",400);
      const expiresAt=new Date(command.expiresAt),now=this.now();
      if(expiresAt<=now || expiresAt.valueOf()>now.valueOf()+24*60*60*1000) throw new OperationsError("approval_expiry_must_be_within_24_hours",400);
      const approvals=[];
      // Stable lock order prevents reversed batch deadlocks. The whole batch commits or none does.
      for(const item of [...command.items].sort((a,b)=>a.taskId.localeCompare(b.taskId))) {
        const task=await this.task(tx,actor,item.taskId,true);
        this.assertRevision(task,item.revision);assertEditable(actor,task);assertTiming(task);
        if(task.kind!=="followup_message" || !task.draftPayload) throw new OperationsError("task_has_no_message_draft",409);
        if(task.status==="blocked") throw new OperationsError("blocked_task_requires_review",409);
        if(new Date(String(task.draftPayload.sendWindowEnd))<=now)throw new OperationsError("draft_window_expired",409);
        const preview=await this.preview(tx,task);
        if(preview.hash!==item.previewHash) throw new OperationsError("approval_preview_changed",409,{taskId:task.id});
        const [existing]=await tx.select().from(schema.operationApprovals).where(and(eq(schema.operationApprovals.workspaceId,actor.workspace),eq(schema.operationApprovals.taskId,task.id),eq(schema.operationApprovals.taskRevision,task.revision),eq(schema.operationApprovals.fingerprint,preview.hash),gt(schema.operationApprovals.expiresAt,now))).orderBy(desc(schema.operationApprovals.expiresAt)).limit(1);
        if(existing && task.approvalStatus==="approved") {approvals.push(existing);continue;}
        const [approval]=await tx.insert(schema.operationApprovals).values({workspaceId:actor.workspace,taskId:task.id,taskRevision:task.revision,fingerprint:preview.hash,snapshot:preview.subject,actorId:actor.id,expiresAt,createdAt:now}).returning();
        if(!approval) throw new OperationsError("approval_save_failed",503);
        await tx.update(schema.tasks).set({approvalStatus:"approved",updatedAt:now}).where(eq(schema.tasks.id,task.id));
        await this.event(tx,actor,task,"draft.approved",{approvalId:approval.id,expiresAt,scope:"draft_review",externalExecution:false});
        approvals.push(approval);
      }
      return {ok:true,approvals,scope:"draft_review",externalExecution:false};
    }
    if(command.command==="brief.create") {
      const now=this.now();
      if(new Date(command.dueBefore)<=now) throw new OperationsError("brief_cutoff_must_be_future",400);
      // Locking the canonical table in SHARE mode gives this stored brief one stable
      // dataset even under READ COMMITTED; operational writes wait until snapshot save.
      // Production scale gate: replace this bounded single-workspace snapshot with a
      // dedicated repeatable-read snapshot transaction before very large deployments.
      await tx.execute(sql`lock table ${schema.tasks} in share mode`);
      let observed=0;
      const rows=await collectTaskPages(async(after,size)=>{
        observed+=size; if(observed>50250)throw new OperationsError("brief_capacity_requires_partitioning",503);
        const conditions=[eq(schema.tasks.workspaceId,actor.workspace),notInArray(schema.tasks.status,["completed","cancelled","superseded"])];
        if(after)conditions.push(gt(schema.tasks.id,after));
        return tx.select().from(schema.tasks).where(and(...conditions)).orderBy(asc(schema.tasks.id)).limit(size);
      });
      if(rows.length>50000)throw new OperationsError("brief_capacity_requires_partitioning",503);
      const snapshot=buildDueWorkSnapshot({id:randomUUID(),generatedAt:now,dueBefore:command.dueBefore,timeZone:command.timeZone,
        tasks:rows.map(t=>({...t,waitingOn:t.waitingOn as WaitingOn})),
        requiredSources:["canonical_tasks","portal_project_coverage","communication_obligations"],coverage:[
          {source:"canonical_tasks",status:"fresh",complete:true,asOf:now},
          {source:"portal_project_coverage",status:"unknown",complete:false,asOf:null},
          {source:"communication_obligations",status:"unknown",complete:false,asOf:null}
        ]});
      await tx.insert(schema.operationBriefs).values({id:snapshot.id,workspaceId:actor.workspace,generatedBy:actor.id,generatedAt:now,timeZone:command.timeZone,snapshot:jsonRecord({...snapshot,approvalStates:Object.fromEntries(rows.map(t=>[t.id,t.approvalStatus]))})});
      await this.event(tx,actor,null,"brief.created",{briefId:snapshot.id,counts:snapshot.counts});
      return {ok:true,briefId:snapshot.id,generatedAt:now,counts:snapshot.counts,coverage:snapshot.coverage};
    }
    if(!("taskId" in command) || !("revision" in command))throw new OperationsError("unsupported_write",400);
    const task=await this.task(tx,actor,command.taskId,true);
    this.assertRevision(task,command.revision);assertEditable(actor,task);
    const now=this.now();
    let patch:Partial<typeof schema.tasks.$inferInsert>={updatedAt:now};
    let note:Record<string,unknown>={};
    if(command.command==="task.edit") {
      const c=command.changes;
      const {dueAt,reviewAt,draft,...simple}=c;
      // Optional Zod fields may be explicitly undefined in internal TypeScript calls.
      // Omit them instead of replacing a required persisted field with undefined.
      for (const [key,value] of Object.entries(simple)) {
        if(value !== undefined) Object.assign(patch,{[key]:value});
      }
      if(dueAt!==undefined)patch.dueAt=new Date(dueAt);
      if(reviewAt!==undefined)patch.reviewAt=reviewAt?new Date(reviewAt):null;
      if(draft!==undefined)patch.draftPayload=draft?jsonRecord(draft):null;
      if(actor.role==="sales" && c.assignedUserId && c.assignedUserId!==actor.id)throw new OperationsError("assignment_requires_manager",403);
      const next={...task,...patch};
      assertTiming(next as Task);
      if(task.kind==="followup_message" && !next.draftPayload)throw new OperationsError("message_draft_required",400);
      if(task.kind!=="followup_message" && next.draftPayload)throw new OperationsError("unexpected_message_draft",400);
      note={changes:jsonRecord(c)};
    } else if(command.command==="task.snooze") {
      const until=new Date(command.until);
      if(until<=now)throw new OperationsError("snooze_must_be_future",400);
      patch= {...patch,...(["customer","provider"].includes(task.waitingOn)?{reviewAt:until}:{dueAt:until})};
      note={reason:command.reason,until};
    } else if(command.command==="task.complete_from_message") {
      if(task.kind!=="followup_message"||!task.draftPayload||!task.contactId||task.status==="blocked"||!["approved","invalidated"].includes(task.approvalStatus))throw new OperationsError("message_task_not_ready_for_completion",409);
      const [execution]=await tx.select().from(schema.communicationExecutions).where(and(eq(schema.communicationExecutions.id,command.executionId),eq(schema.communicationExecutions.contactId,task.contactId))).for("update");
      if(!execution||execution.status!=="accepted"||!execution.providerMessageId||execution.response?.delivered!==true||!execution.verifiedAt||execution.verifiedAt.valueOf()<now.valueOf()-300000||execution.verifiedAt>now)throw new OperationsError("message_delivery_not_freshly_verified",409);
      const [used]=await tx.select({id:schema.operationEvents.id}).from(schema.operationEvents).where(and(eq(schema.operationEvents.type,"task.complete_from_message"),sql`${schema.operationEvents.evidence}->>'executionId'=${execution.id}`)).limit(1);
      if(used)throw new OperationsError("message_execution_already_completed_task",409);
      const evidence=execution.response.matchEvidence as Record<string,unknown>|undefined,draft=task.draftPayload;
      const occurredAt=typeof evidence?.occurredAt==="string"?new Date(evidence.occurredAt):null;
      const bodyHash=createHash("sha256").update(String(draft.body)).digest("hex");
      if(!evidence||evidence.version!==1||evidence.payloadHash!==execution.payloadHash||evidence.bodyHash!==bodyHash||evidence.channel!==draft.channel||evidence.recipient!==draft.recipient||(draft.channel==="email"&&evidence.subject!==draft.subject)||!occurredAt||!Number.isFinite(occurredAt.valueOf())||occurredAt>now||occurredAt<new Date(String(draft.sendWindowStart))||occurredAt>new Date(String(draft.sendWindowEnd)))throw new OperationsError("message_draft_delivery_mismatch",409);
      const [contact]=await tx.select().from(schema.contacts).where(eq(schema.contacts.id,task.contactId)).limit(1);
      if(!contact||contact.provider!=="ghl"||contact.providerId!==execution.payload.contactId)throw new OperationsError("message_contact_evidence_mismatch",409);
      // The matching sent message itself legitimately invalidated the draft. Its
      // exclusion reconstructs the reviewed context; any OTHER message, call,
      // restriction or task edit still changes the exact approval fingerprint.
      const preview=await this.preview(tx,task,execution.providerMessageId);
      const [approval]=await tx.select().from(schema.operationApprovals).where(and(eq(schema.operationApprovals.workspaceId,actor.workspace),eq(schema.operationApprovals.taskId,task.id),eq(schema.operationApprovals.taskRevision,task.revision),eq(schema.operationApprovals.fingerprint,preview.hash),gt(schema.operationApprovals.expiresAt,now))).orderBy(desc(schema.operationApprovals.createdAt)).limit(1);
      if(!approval||execution.createdAt<approval.createdAt||occurredAt<approval.createdAt)throw new OperationsError("message_approval_context_changed_or_expired",409);
      if(task.portalJobId){
        if(!this.config.resolvePortalJob)throw new OperationsError("portal_identity_adapter_unavailable",503);
        const source=await this.config.resolvePortalJob(task.portalJobId);
        if(source.id!==task.portalJobId||source.revision!==task.portalRevision||source.highlevelContactId!==contact.providerId)throw new OperationsError("message_portal_source_changed",409);
      }
      if(task.dependencies.length){const dependencies=await tx.select({status:schema.tasks.status}).from(schema.tasks).where(and(eq(schema.tasks.workspaceId,actor.workspace),inArray(schema.tasks.id,task.dependencies)));if(dependencies.length!==task.dependencies.length||dependencies.some(d=>d.status!=="completed"))throw new OperationsError("dependencies_unresolved",409);}
      const proof={kind:"verified_communication",executionId:execution.id,taskId:task.id,approvedRevision:task.revision,approvalId:approval.id,providerMessageId:execution.providerMessageId,delivered:true,occurredAt:occurredAt.toISOString(),verifiedAt:execution.verifiedAt.toISOString(),actorId:actor.id};
      await tx.execute(sql`select set_config('egc.communication_completion',${task.id},true)`);
      patch={...patch,status:"completed",completedAt:now,completionEvidence:[...task.completionEvidence,proof]};note={...proof,externalExecution:false};
    } else if(command.command==="task.complete") {
      assertCompletion(task.kind);
      if(task.dependencies.length) {
        const dependencies=await tx.select({status:schema.tasks.status}).from(schema.tasks).where(and(eq(schema.tasks.workspaceId,actor.workspace),inArray(schema.tasks.id,task.dependencies)));
        if(dependencies.length!==task.dependencies.length || dependencies.some(d=>d.status!=="completed"))throw new OperationsError("dependencies_unresolved",409);
      }
      patch={...patch,status:"completed",completedAt:now,completionEvidence:[...task.completionEvidence,{kind:"staff_attestation",actor:actor.id,outcome:command.outcome,at:now.toISOString()}]};
      note={outcome:command.outcome,evidenceType:"staff_attestation_not_payment_or_delivery"};
    } else if(command.command==="task.cancel") {
      patch={...patch,status:"cancelled"};note={reason:command.reason};
    } else if(command.command==="task.reject") {
      patch={...patch,approvalStatus:"rejected"};note={reason:command.reason};
    } else throw new OperationsError("unsupported_write",400);
    const [updated]=await tx.update(schema.tasks).set(patch).where(and(eq(schema.tasks.id,task.id),eq(schema.tasks.revision,command.revision))).returning();
    if(!updated)throw new OperationsError("task_revision_conflict",409);
    await this.event(tx,actor,updated,command.command,note);
    return {ok:true,task:updated};
  }
}
export function operationsService(config:OperationsConfiguration) {return new OperationsService(getDb(),config);}
