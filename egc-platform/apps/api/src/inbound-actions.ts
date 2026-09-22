import {createHash} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {OperationsError,type Actor,type OperationsService} from '@egc/operations';
import {ReconciliationFailure,reconciliationDiagnostic,type ReconciliationDiagnostic,type ReconciliationStage} from './reconciliation-diagnostics.js';
type Db=ReturnType<typeof getDb>;
export type InboundPolicy={authority:'employee_hub';inboundResponse:{enabled:boolean;ownerId:string|null;dueMinutes:number|null;ownerSource:string;dueSource:string;blockedReason:string|null}};
export function inboundRequestId(messageId:string){const h=createHash('sha256').update('inbound-action:'+messageId).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export function inboundAction(message:{id:string;contactId:string;occurredAt:Date;body:string|null},policy:InboundPolicy){
  const p=policy.inboundResponse;if(policy.authority!=='employee_hub'||!p.enabled||!p.ownerId||!Number.isInteger(p.dueMinutes)||p.dueMinutes!<5)throw new OperationsError('inbound_policy_unresolved',409);
  return{title:'Review and respond to customer reply',kind:'review_notes' as const,description:'A customer sent a message that has no later recorded human response. Review its context before responding; booking status does not close this obligation.',priority:'high' as const,assignedUserId:p.ownerId,dueAt:new Date(message.occurredAt.getTime()+p.dueMinutes!*60000).toISOString(),timeZone:'America/Denver',waitingOn:'EGC' as const,reviewAt:null,portalJobId:null,portalVisitId:null,contactId:message.contactId,jobId:null,completionCondition:'Record a verified human response or a documented decision after reviewing the customer message.',sourceEvidence:[{source:'message' as const,id:message.id,excerpt:(message.body||'[Customer message with no text body]').slice(0,2000)}],dependencies:[],draft:null,dedupeKey:'inbound_reply:'+message.id};
}
export class InboundActionReconciler{
  private actor:Actor;
  constructor(private db:Db,private service:OperationsService,private readPolicy:()=>Promise<InboundPolicy>,private workspace='egc',private clock:()=>Date=()=>new Date()){this.actor={id:'inbound-response-reconciler',kind:'integration',role:'integration',workspace};}
  private async save(status:Record<string,unknown>){await this.db.insert(schema.syncCursors).values({key:'operations:inbound:status:'+this.workspace,cursor:JSON.stringify(status),updatedAt:this.clock()}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor:JSON.stringify(status),updatedAt:this.clock()}});}
  async run(options:{lookbackDays?:number;limit?:number}={}){
    let stage:ReconciliationStage='inbound_activation';
    try{
    const now=this.clock(),key='operations:inbound:activation:'+this.workspace;
    await this.db.insert(schema.syncCursors).values({key,cursor:now.toISOString(),updatedAt:now}).onConflictDoNothing();
    const [activation]=await this.db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,key));
    const from=options.lookbackDays?new Date(now.getTime()-options.lookbackDays*86400000):new Date(activation!.cursor!);
    if(!Number.isFinite(from.getTime()))throw new OperationsError('inbound_activation_invalid',503);
    const limit=Math.max(1,Math.min(200,options.limit??50));
    return await this.db.transaction(async tx=>{
      const locks=await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as locked`);if(!(locks[0] as {locked?:boolean})?.locked)return{ok:true,skipped:'already_running'};
      const [previous]=await tx.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,'operations:inbound:status:'+this.workspace));
      let lastSuccessAt:string|null=null;try{const prior=JSON.parse(previous?.cursor??'null');if(typeof prior?.lastSuccessAt==='string'&&Number.isFinite(Date.parse(prior.lastSuccessAt)))lastSuccessAt=prior.lastSuccessAt;}catch{/* A malformed checkpoint must not become a successful run. */}
      const status={lastAttemptAt:now.toISOString(),activationAt:activation!.cursor,windowStart:from.toISOString(),checked:0,created:0,alreadyPresent:0,completed:0,failed:0,blocked:0,hasMore:false,ownerSource:'unknown',dueMinutes:null as number|null,errorCode:null as string|null,failure:null as ReconciliationDiagnostic|null,lastSuccessAt};
      try{
        stage='inbound_policy';
        const policy=await this.readPolicy();status.ownerSource=policy.inboundResponse?.ownerSource||'unknown';status.dueMinutes=policy.inboundResponse?.dueMinutes??null;
        stage='inbound_messages';const rows=await this.db.execute(sql`select m.id,m.contact_id as "contactId",m.occurred_at as "occurredAt",m.body from messages m
          where m.direction='inbound' and m.actor_type='customer' and m.occurred_at>=${from.toISOString()}::timestamptz and m.occurred_at<=${now.toISOString()}::timestamptz
          and lower(coalesce(m.raw->>'status',m.raw->>'messageStatus','')) not in ('failed','undelivered','cancelled','canceled') and lower(m.type) not like '%call%' and lower(m.type) not like '%voicemail%' and m.type not in ('1','10')
          and not exists(select 1 from messages response where response.contact_id=m.contact_id and response.direction='outbound' and response.actor_type='human' and lower(coalesce(response.raw->>'status',response.raw->>'messageStatus','')) in ('sent','delivered','read') and response.occurred_at>m.occurred_at and response.occurred_at<=${now.toISOString()}::timestamptz and lower(response.type) not like '%call%' and lower(response.type) not like '%voicemail%' and response.type not in ('1','10'))
          and not exists(select 1 from tasks t where t.workspace_id=${this.workspace} and t.dedupe_key='inbound_reply:'||m.id::text)
          order by m.occurred_at,m.id limit ${limit+1}`);
        status.hasMore=rows.length>limit;status.checked=Math.min(rows.length,limit);
        if(!policy.inboundResponse?.enabled){status.blocked=status.checked;status.errorCode=policy.inboundResponse?.blockedReason||'inbound_policy_unresolved';status.failure=reconciliationDiagnostic({code:status.errorCode},'inbound_policy');stage='inbound_save';await this.save(status);return{ok:false,...status};}
        stage='inbound_create';for(const raw of rows.slice(0,limit)){const r=raw as unknown as {id:string;contactId:string;occurredAt:Date;body:string|null};try{await this.service.execute(this.actor,{command:'task.create',task:inboundAction({...r,occurredAt:new Date(r.occurredAt)},policy)},inboundRequestId(r.id));status.created++;}catch(e){if(e instanceof OperationsError&&['task_already_exists','idempotency_key_payload_conflict'].includes(e.code))status.alreadyPresent++;else {status.failed++;status.failure??=reconciliationDiagnostic(e,stage);}}}
        stage='inbound_answered';const answered=await this.db.execute(sql`select t.id,t.revision,response.id as "responseId" from tasks t join messages original on t.dedupe_key='inbound_reply:'||original.id::text
          join lateral(select m.id from messages m where m.contact_id=original.contact_id and m.direction='outbound' and m.actor_type='human' and lower(coalesce(m.raw->>'status',m.raw->>'messageStatus','')) in ('sent','delivered','read') and m.occurred_at>original.occurred_at and m.occurred_at<=${now.toISOString()}::timestamptz and lower(coalesce(m.raw->>'status',m.raw->>'messageStatus','')) not in ('failed','undelivered','cancelled','canceled') and lower(m.type) not like '%call%' and lower(m.type) not like '%voicemail%' and m.type not in ('1','10') order by m.occurred_at,m.id limit 1)response on true
          where t.workspace_id=${this.workspace} and t.status in ('open','in_progress') and t.kind='review_notes' and t.source='operations' order by t.created_at,t.id limit ${limit}`);
        stage='inbound_complete';for(const raw of answered){const r=raw as unknown as {id:string;revision:number;responseId:string};try{await this.service.execute(this.actor,{command:'task.complete',taskId:r.id,revision:r.revision,outcome:'Verified later human outbound message: '+r.responseId},inboundRequestId('completed:'+r.id+':'+r.responseId));status.completed++;}catch(e){status.failed++;status.failure??=reconciliationDiagnostic(e,stage);}}
        if(status.failed)status.errorCode='inbound_action_write_failed';else status.lastSuccessAt=this.clock().toISOString();stage='inbound_save';await this.save(status);return{ok:status.failed===0,...status};
      }catch(error){status.errorCode='inbound_reconciliation_unavailable';status.failure=reconciliationDiagnostic(error,stage);status.failed++;stage='inbound_save';await this.save(status);return{ok:false,...status};}
    });
    }catch(error){throw new ReconciliationFailure(error,stage);}
  }
}
