import {signOperationsEnvelope} from './operations-envelope.js';

/** Called only after the Hub bridge authenticates the session and exact job access. */
export async function syncNativeSchedule(env,session,input,fetcher=fetch){
  const fail=code=>Object.assign(new Error(code),{code});
  if(!input.portalVisitId||!input.requestId)throw fail('schedule_stable_identity_required');
  if(!env.EGC_OPERATIONS_API_ORIGIN||!env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET)throw fail('schedule_bridge_not_configured');
  const origin=new URL(env.EGC_OPERATIONS_API_ORIGIN);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw fail('schedule_bridge_not_configured');
  // The route checked the native user's exact job permission. This service
  // identity may synchronize that saved visit, never manufacture browser dates.
  const actor={id:`hub-schedule:${session.user}`,kind:'integration',role:'integration',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'};
  const body={command:'schedule.sync_provider',portalVisitId:input.portalVisitId,requestId:input.requestId,runAutomations:input.runAutomations===true,...(input.contactProviderId?{contactProviderId:input.contactProviderId}:{})};
  const envelope=await signOperationsEnvelope({v:1,iss:'portal',aud:'egc-operations',iat:Math.floor(Date.now()/1000),nonce:crypto.randomUUID(),actor,request:{requestId:crypto.randomUUID(),body}},env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET);
  let response,result;
  try{response=await fetcher(new URL('/operations/rpc',origin),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(45000)});result=await response.json();}catch{throw fail('schedule_provider_outcome_unknown');}
  if(!response.ok||result.ok!==true)throw Object.assign(fail(typeof result.error==='string'&&/^[a-z_]+$/.test(result.error)?result.error:'schedule_provider_sync_failed'),{operationId:result.operationId});
  if(result.authority!=='employee_hub'||result.portalVisitId!==input.portalVisitId||!['verified','not_needed'].includes(result.providerSync))throw fail('schedule_provider_response_unverified');
  return {appointmentId:result.appointmentId||'',calendarId:result.calendarId||'',operationId:result.operationId||null,updated:true,providerSync:result.providerSync};
}
