import {createHash} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {isOutboundBusinessMediaPromise} from '@egc/customer-state';
import {OperationsError,type Actor,type OperationsService} from '@egc/operations';
import {inboundReviewCopy} from './inbound-triage.js';
import {ReconciliationFailure,reconciliationDiagnostic,type ReconciliationDiagnostic,type ReconciliationStage} from './reconciliation-diagnostics.js';

type Db=ReturnType<typeof getDb>;
type MessageRow={id:string;contactId:string;occurredAt:Date;body:string|null;raw?:Record<string,unknown>;preparationTaskId?:string|null};
export type InboundPolicy={authority:'employee_hub';inboundResponse:{enabled:boolean;ownerId:string|null;dueMinutes:number|null;ownerSource:string;dueSource:string;blockedReason:string|null}};

function requestId(namespace:string,value:string){
  const h=createHash('sha256').update(namespace+':'+value).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function inboundRequestId(messageId:string){return requestId('inbound-action',messageId);}
export function promiseRequestId(messageId:string){return requestId('outbound-promise',messageId);}

function hasMediaEvidence(raw:Record<string,unknown>={}){
  const arrays=[raw.attachments,raw.messageAttachments,raw.files,raw.media,raw.mediaAttachments].filter(Array.isArray) as unknown[][];
  const values=[...arrays.flat(),raw.attachment,raw.mediaUrl,raw.fileUrl].filter(v=>v!==undefined&&v!==null);
  return values.some(value=>{
    if(typeof value==='string')return /\.(?:jpe?g|png|gif|webp|heic|mp4|mov|webm)(?:$|[?#])/i.test(value);
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const row=value as Record<string,unknown>,type=String(row.type??row.contentType??row.mimeType??'').toLowerCase(),name=String(row.name??row.filename??row.url??row.href??'').toLowerCase();
    return /^(?:image|video)\//.test(type)||/\.(?:jpe?g|png|gif|webp|heic|mp4|mov|webm)(?:$|[?#])/.test(name);
  });
}

export function inboundAction(message:{id:string;contactId:string;occurredAt:Date;body:string|null},policy:InboundPolicy){
  const p=policy.inboundResponse;if(policy.authority!=='employee_hub'||!p.enabled||!p.ownerId||!Number.isInteger(p.dueMinutes)||p.dueMinutes!<5)throw new OperationsError('inbound_policy_unresolved',409);
  return{...inboundReviewCopy(message.body),kind:'review_notes' as const,assignedUserId:p.ownerId,dueAt:new Date(message.occurredAt.getTime()+p.dueMinutes!*60000).toISOString(),timeZone:'America/Denver',waitingOn:'EGC' as const,reviewAt:null,portalJobId:null,portalVisitId:null,contactId:message.contactId,jobId:null,sourceEvidence:[{source:'message' as const,id:message.id,excerpt:(message.body||'[Customer message with no text body]').slice(0,2000)}],dependencies:[],draft:null,dedupeKey:'inbound_reply:'+message.id};
}

export function outboundPromiseAction(message:{id:string;contactId:string;occurredAt:Date;body:string|null},policy:InboundPolicy,dependencies:string[]=[]){
  const p=policy.inboundResponse;
  if(policy.authority!=='employee_hub'||!p.ownerId)throw new OperationsError('promise_owner_unresolved',409);
  const text=(message.body??'').trim();
  if(!isOutboundBusinessMediaPromise({sourceType:'message',direction:'outbound',text}))throw new OperationsError('outbound_media_promise_not_detected',409);
  return{
    title:'Deliver promised customer photos/video',
    description:'Source-bound customer promise. This task remains open through acknowledgments, postponements, unrelated replies, and asset preparation. Its due time is the internal detection time, not a newly asserted customer deadline.',
    kind:'manual' as const,priority:'medium' as const,assignedUserId:p.ownerId,dueAt:message.occurredAt.toISOString(),timeZone:'America/Denver',waitingOn:'EGC' as const,reviewAt:null,
    portalJobId:null,portalVisitId:null,contactId:message.contactId,jobId:null,
    completionCondition:'Verified later provider evidence for this exact contact: a human outbound message after the source promise has delivery/read status and contains at least one photo or video attachment. Acknowledgments, postponements, unrelated messages, preparation, and staff attestation do not fulfill the promise.',
    sourceEvidence:[{source:'message' as const,id:message.id,excerpt:(message.body||'[Outbound promise with no text body]').slice(0,2000)}],
    dependencies,draft:null,dedupeKey:'outbound_media_promise:'+message.id
  };
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
        const status={lastAttemptAt:now.toISOString(),activationAt:activation!.cursor,windowStart:from.toISOString(),checked:0,created:0,alreadyPresent:0,completed:0,promiseChecked:0,promiseCreated:0,promiseAlreadyPresent:0,promiseCompleted:0,promiseBlocked:0,failed:0,blocked:0,hasMore:false,ownerSource:'unknown',dueMinutes:null as number|null,errorCode:null as string|null,failure:null as ReconciliationDiagnostic|null,lastSuccessAt};
        try{
          stage='inbound_policy';
          const policy=await this.readPolicy();status.ownerSource=policy.inboundResponse?.ownerSource||'unknown';status.dueMinutes=policy.inboundResponse?.dueMinutes??null;

          stage='inbound_messages';
          const rows=await this.db.execute(sql`select m.id,m.contact_id as "contactId",m.occurred_at as "occurredAt",m.body from messages m
            where m.direction='inbound' and m.actor_type='customer' and m.occurred_at>=${from.toISOString()}::timestamptz and m.occurred_at<=${now.toISOString()}::timestamptz
            and lower(coalesce(m.raw->>'status',m.raw->>'messageStatus','')) not in ('failed','undelivered','cancelled','canceled') and lower(m.type) not like '%call%' and lower(m.type) not like '%voicemail%' and m.type not in ('1','10')
            and not exists(select 1 from messages response where response.contact_id=m.contact_id and response.direction='outbound' and response.actor_type='human' and lower(coalesce(response.raw->>'status',response.raw->>'messageStatus','')) in ('sent','delivered','read') and response.occurred_at>m.occurred_at and response.occurred_at<=${now.toISOString()}::timestamptz and lower(response.type) not like '%call%' and lower(response.type) not like '%voicemail%' and response.type not in ('1','10'))
            and not exists(select 1 from tasks t where t.workspace_id=${this.workspace} and t.dedupe_key='inbound_reply:'||m.id::text)
            order by m.occurred_at,m.id limit ${limit+1}`);
          status.hasMore=rows.length>limit;status.checked=Math.min(rows.length,limit);

          stage='promise_scan';
          const promiseRows=await this.db.execute(sql`select m.id,m.contact_id as "contactId",m.occurred_at as "occurredAt",m.body,
            (select t.id from tasks t where t.workspace_id=${this.workspace} and t.dedupe_key like ('promise-preparation:message:'||m.id::text||':%') and t.status not in ('cancelled','superseded') order by t.created_at desc,t.id limit 1) as "preparationTaskId"
            from messages m where m.direction='outbound' and m.actor_type='human' and m.body is not null
            and m.occurred_at>=${from.toISOString()}::timestamptz and m.occurred_at<=${now.toISOString()}::timestamptz
            and m.body ~* '(send|text|upload).{0,120}(photo|picture|video)'
            and not exists(select 1 from tasks t where t.workspace_id=${this.workspace} and t.dedupe_key='outbound_media_promise:'||m.id::text)
            order by m.occurred_at,m.id limit ${limit+1}`);
          const promises=(promiseRows as unknown as MessageRow[]).filter(r=>isOutboundBusinessMediaPromise({sourceType:'message',direction:'outbound',text:r.body??''}));
          status.promiseChecked=Math.min(promises.length,limit);status.hasMore=status.hasMore||promiseRows.length>limit;
          if(!policy.inboundResponse?.ownerId)status.promiseBlocked=status.promiseChecked;
          else for(const raw of promises.slice(0,limit)){
            const r={...raw,occurredAt:new Date(raw.occurredAt)};
            try{await this.service.execute(this.actor,{command:'task.create',task:outboundPromiseAction(r,policy,r.preparationTaskId?[r.preparationTaskId]:[])},promiseRequestId(r.id));status.promiseCreated++;}
            catch(e){if(e instanceof OperationsError&&['task_already_exists','idempotency_key_payload_conflict'].includes(e.code))status.promiseAlreadyPresent++;else{status.failed++;status.failure??=reconciliationDiagnostic(e,stage);}}
          }

          stage='promise_delivery';
          const deliveryRows=await this.db.execute(sql`select t.id,t.revision,response.id as "messageId",response.raw from tasks t
            join messages original on t.dedupe_key='outbound_media_promise:'||original.id::text
            join messages response on response.contact_id=original.contact_id and response.direction='outbound' and response.actor_type='human' and response.occurred_at>original.occurred_at and response.occurred_at<=${now.toISOString()}::timestamptz
            where t.workspace_id=${this.workspace} and t.status in ('open','in_progress') and t.source='operations'
            and lower(coalesce(response.raw->>'status',response.raw->>'messageStatus','')) in ('delivered','read')
            order by t.created_at,t.id,response.occurred_at,response.id limit ${Math.min(2000,limit*10)}`);
          const picked=new Map<string,{id:string;revision:number;messageId:string;raw:Record<string,unknown>}>();
          for(const raw of deliveryRows as unknown as Array<{id:string;revision:number;messageId:string;raw:Record<string,unknown>}>){if(!picked.has(raw.id)&&hasMediaEvidence(raw.raw))picked.set(raw.id,raw);}
          for(const r of picked.values()){
            try{await this.service.execute(this.actor,{command:'task.complete_promise_from_message',taskId:r.id,revision:r.revision,messageId:r.messageId},requestId('promise-completed',r.id+':'+r.messageId));status.promiseCompleted++;}
            catch(e){if(!(e instanceof OperationsError&&['task_revision_conflict','promise_delivery_not_verified'].includes(e.code))){status.failed++;status.failure??=reconciliationDiagnostic(e,stage);}}
          }

          if(!policy.inboundResponse?.enabled){status.blocked=status.checked;status.errorCode=policy.inboundResponse?.blockedReason||'inbound_policy_unresolved';status.failure??=reconciliationDiagnostic({code:status.errorCode},'inbound_policy');stage='inbound_save';await this.save(status);return{ok:status.failed===0&&status.promiseBlocked===0,...status};}

          stage='inbound_create';
          for(const raw of rows.slice(0,limit)){const r=raw as unknown as MessageRow;try{await this.service.execute(this.actor,{command:'task.create',task:inboundAction({...r,occurredAt:new Date(r.occurredAt)},policy)},inboundRequestId(r.id));status.created++;}catch(e){if(e instanceof OperationsError&&['task_already_exists','idempotency_key_payload_conflict'].includes(e.code))status.alreadyPresent++;else {status.failed++;status.failure??=reconciliationDiagnostic(e,stage);}}}

          stage='inbound_answered';
          const answered=await this.db.execute(sql`select t.id,t.revision,response.id as "responseId" from tasks t join messages original on t.dedupe_key='inbound_reply:'||original.id::text
            join lateral(select m.id from messages m where m.contact_id=original.contact_id and m.direction='outbound' and m.actor_type='human' and lower(coalesce(m.raw->>'status',m.raw->>'messageStatus','')) in ('sent','delivered','read') and m.occurred_at>original.occurred_at and m.occurred_at<=${now.toISOString()}::timestamptz and lower(coalesce(m.raw->>'status',m.raw->>'messageStatus','')) not in ('failed','undelivered','cancelled','canceled') and lower(m.type) not like '%call%' and lower(m.type) not like '%voicemail%' and m.type not in ('1','10') order by m.occurred_at,m.id limit 1)response on true
            where t.workspace_id=${this.workspace} and t.status in ('open','in_progress') and t.kind='review_notes' and t.source='operations' order by t.created_at,t.id limit ${limit}`);
          stage='inbound_complete';
          for(const raw of answered){const r=raw as unknown as {id:string;revision:number;responseId:string};try{await this.service.execute(this.actor,{command:'task.complete',taskId:r.id,revision:r.revision,outcome:'Verified later human outbound message: '+r.responseId},inboundRequestId('completed:'+r.id+':'+r.responseId));status.completed++;}catch(e){status.failed++;status.failure??=reconciliationDiagnostic(e,stage);}}

          if(status.failed)status.errorCode='inbound_action_write_failed';else status.lastSuccessAt=this.clock().toISOString();
          stage='inbound_save';await this.save(status);return{ok:status.failed===0&&status.promiseBlocked===0,...status};
        }catch(error){status.errorCode='inbound_reconciliation_unavailable';status.failure=reconciliationDiagnostic(error,stage);status.failed++;stage='inbound_save';await this.save(status);return{ok:false,...status};}
      });
    }catch(error){throw new ReconciliationFailure(error,stage);}
  }
}
