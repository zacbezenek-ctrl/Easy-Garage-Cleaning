import {operationsApiOrigin,signPortalServiceEnvelope} from './operations-service-auth.js';
/** Only called after native session authentication and exact saved-job access. */
export async function syncNativeNote(env,session,input,fetcher=fetch){
  const fail=code=>Object.assign(new Error(code),{code});
  if(!input.portalJobId||!input.requestId||!input.contactId||!session?.user)throw fail('provider_note_stable_identity_required');
  const origin=operationsApiOrigin(env);
  const actor={id:`hub-note:${session.user}`,kind:'integration',role:'integration',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'};
  const body={command:'provider.note.ensure',requestId:input.requestId,portalJobId:input.portalJobId,providerContactId:input.contactId,scope:input.scope,title:input.title,body:input.body};
  const envelope=await signPortalServiceEnvelope(env,{path:'/operations/rpc',actor,request:{requestId:crypto.randomUUID(),body}});
  let response,result;try{response=await fetcher(new URL('/operations/rpc',origin),{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(45000)});if(response.status>=300&&response.status<400)throw fail('provider_note_redirect_refused');result=await response.json();}catch{throw fail('provider_note_outcome_unknown');}
  if(!response.ok||result.ok!==true)throw Object.assign(fail(['provider_note_request_conflict','provider_note_requires_review','provider_note_pending','provider_note_contact_conflict','provider_note_source_unverified','post_job_completion_time_required','post_job_followup_owner_unresolved','post_job_followup_unavailable'].includes(result.error)?result.error:'provider_note_sync_failed'),{operationId:result.outboxId});
  if(result.authority!=='employee_hub'||result.portalJobId!==input.portalJobId||result.providerSync!=='verified'||typeof result.noteId!=='string'||!result.noteId)throw fail('provider_note_response_unverified');
  return{note:{id:result.noteId},outboxId:result.outboxId,providerSync:'verified',followupTaskId:result.followupTaskId||null};
}
