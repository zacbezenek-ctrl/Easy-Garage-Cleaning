import {operationsApiOrigin,signPortalServiceEnvelope} from './operations-service-auth.js';

/** Called only after the Hub bridge authenticates the session and exact job access. */
export async function syncNativeSchedule(env,session,input,fetcher=fetch){
  const fail=code=>Object.assign(new Error(code),{code});
  if(!input.portalVisitId||!input.requestId)throw fail('schedule_stable_identity_required');
  const origin=operationsApiOrigin(env);
  // The route checked the native user's exact job permission. This service
  // identity may synchronize that saved visit, never manufacture browser dates.
  const actor={id:`hub-schedule:${session.user}`,kind:'integration',role:'integration',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'};
  const body={command:'schedule.sync_provider',portalVisitId:input.portalVisitId,requestId:input.requestId,runAutomations:input.runAutomations===true,...(input.contactProviderId?{contactProviderId:input.contactProviderId}:{})};
  const envelope=await signPortalServiceEnvelope(env,{path:'/operations/rpc',actor,request:{requestId:crypto.randomUUID(),body}});
  let response,result;
  try{response=await fetcher(new URL('/operations/rpc',origin),{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(45000)});if(response.status>=300&&response.status<400)throw fail('schedule_provider_redirect_refused');result=await response.json();}catch{throw fail('schedule_provider_outcome_unknown');}
  if(!response.ok||result.ok!==true)throw Object.assign(fail(typeof result.error==='string'&&/^[a-z_]+$/.test(result.error)?result.error:'schedule_provider_sync_failed'),{operationId:result.operationId});
  if(result.authority!=='employee_hub'||result.portalVisitId!==input.portalVisitId||!['verified','not_needed'].includes(result.providerSync))throw fail('schedule_provider_response_unverified');
  return {appointmentId:result.appointmentId||'',calendarId:result.calendarId||'',operationId:result.operationId||null,updated:true,providerSync:result.providerSync};
}
