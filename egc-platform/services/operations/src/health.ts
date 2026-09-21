import {sql} from 'drizzle-orm';
import {getDb} from '@egc/database';
type Tx=Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
export async function operationalHealth(tx:Tx,workspace:string){
  const counts=await tx.execute(sql`select 'webhooks' as source,processing_status as status,count(*)::int as count,min(received_at) as "oldestAt",max(processed_at) as "lastProcessedAt" from webhook_events group by processing_status
    union all select 'outbox',processing_status,count(*)::int,min(created_at),max(processed_at) from outbox_events group by processing_status
    union all select 'post_job_followups',coalesce(payload->>'_egcFollowupStatus','pending'),count(*)::int,min(created_at),max(processed_at) from outbox_events where type='ghl.contact_note.sync' and payload->>'scope'='post_job' group by coalesce(payload->>'_egcFollowupStatus','pending')
    union all select 'recordings',status,count(*)::int,min(created_at),max(updated_at) from walkthroughs where workspace_id=${workspace} group by status
    union all select 'appointment_operations',status,count(*)::int,min(created_at),max(updated_at) from appointment_operations group by status
    union all select 'communication_executions',status,count(*)::int,min(created_at),max(updated_at) from communication_executions group by status`);
  const freshness=await tx.execute(sql`select (select max(updated_at) from contacts) as "contactsMirroredAt",(select max(updated_at) from messages) as "messagesMirroredAt",(select max(updated_at) from appointments) as "appointmentsMirroredAt",(select max(received_at) from webhook_events) as "lastWebhookReceivedAt"`);
  const cursors=await tx.execute(sql`select key,updated_at as "updatedAt" from sync_cursors where key not like 'meta%' and key not like '%:meta:%' order by key`);
  const inbound=await tx.execute(sql`select cursor,updated_at as "updatedAt" from sync_cursors where key=${'operations:inbound:status:'+workspace}`);
  let inboundStatus:Record<string,unknown>|null=null;try{const parsed=JSON.parse(String((inbound[0]as {cursor?:unknown}|undefined)?.cursor??'null'));if(parsed&&typeof parsed==='object'){inboundStatus={};for(const key of ['lastAttemptAt','lastSuccessAt','activationAt','windowStart','checked','created','alreadyPresent','completed','failed','blocked','hasMore','ownerSource','dueMinutes','errorCode'])if(typeof parsed[key]==='number'||typeof parsed[key]==='boolean'||parsed[key]===null||typeof parsed[key]==='string'&&/^[A-Za-z0-9_.:+-]{1,100}$/.test(parsed[key]))inboundStatus[key]=parsed[key];}}catch{/* Corrupt status is unknown, never raw text. */}
  return{asOf:new Date().toISOString(),queues:counts,mirrorFreshness:freshness[0]??null,syncCheckpoints:cursors,inboundActions:inboundStatus,
    semantics:'Queue statuses and mirror refresh times are operational health, not customer-contact timestamps. Missing source state is unknown; dead_letter/failed/uncertain require review.'};
}
