import {createHmac,randomUUID} from 'node:crypto';
import type {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {bridgeActor,operationsPrincipal,operationsEnabled} from './operations.js';
import {oauthSecurityMetadata,READ_SCOPE,WRITE_SCOPE} from './oauth.js';
import {isRecord,safeDetails,settle as result} from './tools/result.js';
export const RECORDING_WRITE_TOOLS=new Set(['recordings.retry']);
export async function callRecordings(body:Record<string,unknown>,requestId:string=randomUUID(),fetcher:typeof fetch=fetch){
  const actor=operationsPrincipal.getStore();if(!operationsEnabled())return{error:'operations_not_enabled'};if(!actor)return{error:'verified_principal_required'};
  const key=process.env.EGC_OPERATIONS_MCP_SIGNING_SECRET,origin=process.env.EGC_OPERATIONS_API_ORIGIN;if(!key||key.length<32||!origin)return{error:'recording_bridge_not_configured'};
  if(!['recording.list','recording.get','recording.retry'].includes(String(body.command)))return{error:'recording_mcp_command_forbidden'};
  const readOnly=body.command!=='recording.retry';
  const unavailable=(error:string,httpStatus?:number)=>({ok:false,error,requestId,...(httpStatus===undefined?{}:{httpStatus}),retryable:httpStatus===undefined||httpStatus===429||httpStatus>=500,
    ...(readOnly?{coverage:{complete:false,reason:error},instruction:'The recording source could not be read. This is not evidence of no recordings. Retry the same read after the source recovers.'}:
      {retryMode:'same_request_id',instruction:'The recording retry outcome is unknown. Inspect its current status, then retry only with the same requestId. Approval remains in the Employee Hub.'})});
  try{const url=new URL(origin);if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)return{error:'recording_bridge_not_configured'};
    const claims={v:1,iss:'mcp',aud:'egc-recordings',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:bridgeActor(actor),request:{requestId,body}},payload=Buffer.from(JSON.stringify(claims)).toString('base64url'),envelope=payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');
    const r=await fetcher(new URL('/recordings/rpc',url),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(20000)});
    let value:unknown;try{value=await r.json();}catch{value=undefined;}
    const errorCode=isRecord(value)&&typeof value.error==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(value.error)?value.error:undefined;
    if(!r.ok&&(!errorCode||!isRecord(value)||value.ok===true))return unavailable(readOnly?(r.status===429?'recording_rate_limited':'recording_upstream_unavailable'):'recording_outcome_unknown',r.status);
    if(!isRecord(value))return unavailable(readOnly?'recording_response_invalid':'recording_outcome_unknown',r.status);
    if(errorCode)return {...safeDetails(value),ok:false,error:errorCode,httpStatus:r.status,requestId,...(readOnly?{coverage:{complete:false,reason:errorCode}}:{}),...(r.status===429||r.status>=500?{retryable:true,...(!readOnly?{retryMode:'same_request_id'}:{})}:{})};
    if(value.error!==undefined||value.ok!==true)return unavailable(readOnly?'recording_response_invalid':'recording_outcome_unknown',r.status);
    return {...value,httpStatus:r.status,requestId};
  }catch{return unavailable('recording_outcome_unknown');}
}
export function registerRecordingTools(server:McpServer){
  const read={annotations:{readOnlyHint:true,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE])},write={annotations:{readOnlyHint:false,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE,WRITE_SCOPE])};
  server.registerTool('recordings.list',{description:'Read durable recordings for one exact authoritative Hub visit/job. Includes processing failures, reviewed status and linkage exceptions. No fuzzy customer matching.',inputSchema:z.object({portalJobId:z.string().regex(/^[A-Za-z0-9_-]{1,180}$/),offset:z.number().int().min(0).default(0)}),...read},async args=>result(await callRecordings({command:'recording.list',...args})));
  server.registerTool('recordings.get',{description:'Inspect an exact saved recording, transcript, extraction draft and review status. AI proposals are not approved scope. Source audio keys and credentials are never returned.',inputSchema:z.object({recordingId:z.string().uuid()}),...read},async args=>result(await callRecordings({command:'recording.get',...args})));
  server.registerTool('recordings.retry',{description:'Requeue failed transcription/extraction of already stored audio. Does not duplicate the recording, approve scope, send messages or create a job. Review approval remains in the signed-in Employee Hub.',inputSchema:z.object({recordingId:z.string().uuid(),requestId:z.string().uuid()}),...write},async({requestId,...args})=>result(await callRecordings({command:'recording.retry',...args},requestId)));
}
