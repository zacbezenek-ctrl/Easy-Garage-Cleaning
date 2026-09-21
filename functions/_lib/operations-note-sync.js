import {signOperationsEnvelope} from './operations-envelope.js';
/** Only called after native session authentication and exact saved-job access. */
export async function syncNativeNote(env,session,input,fetcher=fetch){
  const fail=code=>Object.assign(new Error(code),{code});
  if(!input.portalJobId||!input.requestId||!input.contactId||!session?.user)throw fail('provider_note_stable_identity_required');
  if(!env.EGC_OPERATIONS_API_ORIGIN||!env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET)throw fail('provider_note_bridge_not_configured');
  const origin=new URL(env.EGC_OPERATIONS_API_ORIGIN);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw fail('provider_note_bridge_not_configured');
  const actor={id:`hub-note:${session.user}`,kind:'integration',role:'integration',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'};
  const body={command:'provider.note.ensure',requestId:input.requestId,portalJobId:input.portalJobId,providerContactId:input.contactId,scope:input.scope,title:input.title,body:input.body};
  const envelope=await signOperationsEnvelope({v:1,iss:'portal',aud:'egc-operations',iat:Math.floor(Date.now()/1000),nonce:crypto.randomUUID(),actor,request:{requestId:crypto.randomUUID(),body}},env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET);
  let response,result;try{response=await fetcher(new URL('/operations/rpc',origin),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(45000)});result=await response.json();}catch{throw fail('provider_note_outcome_unknown');}
  if(!response.ok||result.ok!==true)throw Object.assign(fail(['provider_note_request_conflict','provider_note_requires_review','provider_note_pending','provider_note_contact_conflict','provider_note_source_unverified','post_job_completion_time_required','post_job_followup_owner_unresolved','post_job_followup_unavailable'].includes(result.error)?result.error:'provider_note_sync_failed'),{operationId:result.outboxId});
  if(result.authority!=='employee_hub'||result.portalJobId!==input.portalJobId||result.providerSync!=='verified'||typeof result.noteId!=='string'||!result.noteId)throw fail('provider_note_response_unverified');
  return{note:{id:result.noteId},outboxId:result.outboxId,providerSync:'verified',followupTaskId:result.followupTaskId||null};
}
