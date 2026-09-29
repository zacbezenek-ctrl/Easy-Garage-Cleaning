import {getHubSession} from '../_lib/hub-session.js';
import {sameOrigin} from './operations.js';
import {operationsEnabled,operationsApiOrigin,signPortalServiceEnvelope} from '../_lib/operations-service-auth.js';
import {recordingActorRole} from '../_lib/operations-recording-approval.js';
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function onRequestPost({request,env}){
  if(!sameOrigin(request))return reply(403,{error:'same_origin_required'});
  try{
    const session=await getHubSession(request,env);if(!session)return reply(403,{error:'business_session_required'});
    const role=recordingActorRole(session,env);if(!role)return reply(403,{error:'recording_role_forbidden'});
    if(!operationsEnabled(env))return reply(503,{error:'operations_not_enabled'});
    const origin=operationsApiOrigin(env);
    const multipart=request.headers.get('Content-Type')?.startsWith('multipart/form-data');let requestId,body,audio;
    if(multipart){if(Number(request.headers.get('Content-Length')||0)>25*1024*1024)return reply(413,{error:'recording_size_invalid'});const form=await request.formData();requestId=form.get('requestId');audio=form.get('audio');if(!(audio instanceof File)||!audio.size||audio.size>24*1024*1024)return reply(400,{error:'recording_size_invalid'});const digest=await crypto.subtle.digest('SHA-256',await audio.arrayBuffer());body={command:'recording.upload',portalJobId:form.get('portalJobId'),audioSha256:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')};}
    else{if(!request.headers.get('Content-Type')?.startsWith('application/json'))return reply(415,{error:'json_required'});const text=await request.text();if(text.length>200000)return reply(413,{error:'request_too_large'});let input;try{input=JSON.parse(text);}catch{return reply(400,{error:'invalid_json'});}requestId=input?.requestId;body=input?.body;}
    if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId)||!body||typeof body!=='object')return reply(400,{error:'invalid_recording_request'});
    const actor={id:session.user,role,kind:'human',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'};
    const envelope=await signPortalServiceEnvelope(env,{path:multipart?'/recordings/upload':'/recordings/rpc',audience:'egc-recordings',actor,request:{requestId,body}});
    let outbound,headers;if(multipart){outbound=new FormData();outbound.set('envelope',envelope);outbound.set('audio',audio,'recording');headers={};}else{outbound=JSON.stringify({envelope});headers={'Content-Type':'application/json'};}
    const r=await fetch(new URL(multipart?'/recordings/upload':'/recordings/rpc',origin),{method:'POST',redirect:'manual',headers,body:outbound,signal:AbortSignal.timeout(55000)});
    if(r.status>=300&&r.status<400)return reply(502,{error:'recording_unavailable'});
    if(!r.headers.get('Content-Type')?.includes('application/json'))return reply(502,{error:'recording_unavailable'});
    return reply(r.status,await r.json());
  }catch{return reply(503,{error:'recording_unavailable',retryable:true});}
}
