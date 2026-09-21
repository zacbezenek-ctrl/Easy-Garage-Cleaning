import {sql} from "drizzle-orm";
import {getDb} from "@egc/database";
import {callContactEvidence} from "@egc/lead-audit";
type Db=ReturnType<typeof getDb>;
type Tx=Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One chronological page across persisted sources, inside the caller's consistent
 * read transaction. Customer-level evidence never acquires a guessed job link. */
export type PortalTimelineEvent={id:string;kind:string;at:string;data:Record<string,unknown>};
export async function customerTimeline(tx:Tx,contactId:string,workspace:string,offset:number,limit:number,portalEvents:PortalTimelineEvent[]=[]) {
  const result=await tx.execute(sql`
    with events as (
      select 'message:'||id::text as id, 'message' as kind, occurred_at as at,
        jsonb_build_object('providerId',provider_id,'channel',type,'direction',direction,'actorType',actor_type,'body',body,'status',raw->>'status','association','customer') as data
      from messages where contact_id=${contactId}::uuid and lower(type) not like '%call%' and lower(type) not like '%voicemail%' and type not in ('1','10')
      union all
      select 'call:'||c.id::text,'call',c.started_at,
        jsonb_build_object('providerId',c.provider_message_id,'direction',c.direction,'actorType',c.actor_type,'status',c.status,'durationSeconds',c.duration_seconds,'recordingAvailable',c.recording_url is not null,'transcript',left(t.text,10000),'transcriptTruncated',length(t.text)>10000,'contactEvidence',c.raw,'association','customer')
      from calls c left join call_transcripts t on t.call_id=c.id where c.contact_id=${contactId}::uuid
      union all
      select 'appointment:'||id::text,'provider_appointment',coalesce(appointment_created_at,created_at),
        jsonb_build_object('providerId',provider_id,'calendarId',calendar_id,'status',status,'startAt',appointment_start_at,'endAt',appointment_end_at,'eventTimeKnown',appointment_created_at is not null,'authority','ghl_mirror','association','customer')
      from appointments where contact_id=${contactId}::uuid
      union all
      select 'recording:'||id::text,'recording',created_at,
        jsonb_build_object('recordingId',id,'portalJobId',portal_job_id,'portalVisitId',portal_visit_id,'portalProjectId',portal_project_id,'status',status,'transcript',left(transcript,10000),'transcriptTruncated',length(transcript)>10000,'approvedAt',approved_at,'approvedBy',approved_by,'errorCode',last_error_code,'association',case when portal_visit_id is null then 'customer' else 'exact_visit' end)
      from walkthroughs where contact_id=${contactId}::uuid and workspace_id=${workspace}
      union all
      select 'note:'||n.id::text,'job_note',n.created_at,
        jsonb_build_object('jobId',n.job_id,'body',n.body,'source',n.source,'actor',n.created_by,'authority','legacy_platform_job','association','exact_platform_job')
      from job_notes n join jobs j on j.id=n.job_id where j.contact_id=${contactId}::uuid
      union all
      select 'action:'||id::text,'action',created_at,
        jsonb_build_object('taskId',id,'title',title,'status',status,'owner',assigned_user_id,'dueAt',due_at,'waitingOn',waiting_on,'portalJobId',portal_job_id,'portalVisitId',portal_visit_id,'sourceEvidence',source_evidence,'completionEvidence',completion_evidence,'completedAt',completed_at,'association',case when portal_job_id is null then 'customer' else 'exact_portal_record' end)
      from tasks where contact_id=${contactId}::uuid and workspace_id=${workspace}
      union all
      select 'action-event:'||e.id::text,e.type,e.occurred_at,
        jsonb_build_object('taskId',e.task_id,'actor',e.actor_id,'source',e.source,'evidence',e.evidence,'association','exact_action')
      from operation_events e join tasks t on t.id=e.task_id where t.contact_id=${contactId}::uuid and e.workspace_id=${workspace}
      union all
      select event->>'id',event->>'kind',(event->>'at')::timestamptz,event->'data'
      from jsonb_array_elements(${JSON.stringify(portalEvents)}::jsonb) event
    ), page as (select * from events order by at desc,id desc limit ${limit} offset ${offset})
    select (select count(*)::int from events) as total,coalesce((select jsonb_agg(to_jsonb(page) order by at desc,id desc) from page),'[]'::jsonb) as items
  `);
  const row=result[0] as unknown as {total:number;items:Array<{id:string;kind:string;at:string;data:Record<string,unknown>}>};
  const items=(row?.items??[]).map(item=>{
    if(item.kind!=="call")return item;
    const {contactEvidence,...data}=item.data;
    return {...item,data:{...data,...callContactEvidence((contactEvidence??{}) as Record<string,unknown>)}};
  });
  return {items,total:row?.total??0,nextOffset:offset+items.length<(row?.total??0)?offset+items.length:null,
    association:"explicit_links_only",coverage:{messages:true,calls:true,providerAppointments:true,recordings:true,actions:true,notes:true,portalEvents:portalEvents.length,quotes:"exact_requested_hub_record",payments:"exact_requested_hub_record",consistency:"provider_mirror_snapshot_plus_separately_read_hub_revision"}};
}
