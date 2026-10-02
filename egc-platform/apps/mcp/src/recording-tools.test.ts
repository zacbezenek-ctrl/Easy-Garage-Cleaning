import {describe,it,expect,vi,afterEach} from 'vitest';
import {createHmac,randomUUID} from 'node:crypto';
import type {McpServer} from '@modelcontextprotocol/server';
import {operationsPrincipal} from './operations.js';
import {callRecordings,registerRecordingTools} from './recording-tools.js';
import {requiredToolScope} from './tool-access.js';
import {READ_SCOPE,WRITE_SCOPE} from './oauth.js';
const env={...process.env};afterEach(()=>{process.env={...env};vi.unstubAllGlobals();});
const actor={id:'grant-test',kind:'integration' as const,role:'integration' as const,workspace:'egc'};
function configured(){process.env.EGC_OPERATIONS_ENABLED='true';process.env.EGC_OPERATIONS_API_ORIGIN='https://api.synthetic.invalid';process.env.EGC_OPERATIONS_MCP_SIGNING_SECRET='isolated-recording-signing-test-key-0123456789';}
describe('recording MCP tools',()=>{
it('exposes read/get and write-scoped safe processing retry, never approval',()=>{const names=new Map<string,unknown>();registerRecordingTools({registerTool:(name:string,metadata:unknown)=>names.set(name,metadata)}as unknown as McpServer);expect([...names.keys()]).toEqual(['recordings.list','recordings.get','recordings.retry']);expect(requiredToolScope('recordings.get')).toBe(READ_SCOPE);expect(requiredToolScope('recordings.retry')).toBe(WRITE_SCOPE);});
it('requires enabled service and verified principal before any request',async()=>{configured();const fetcher=vi.fn();expect(await callRecordings({command:'recording.get'},randomUUID(),fetcher)).toMatchObject({error:'verified_principal_required'});expect(fetcher).not.toHaveBeenCalled();});
it('signs authenticated grant and exact request and refuses mutation escalation',async()=>{configured();const requestId=randomUUID();const fetcher=vi.fn(async(_url,options)=>{const token=JSON.parse(options.body).envelope,[payload,signature]=token.split('.');expect(signature).toBe(createHmac('sha256',process.env.EGC_OPERATIONS_MCP_SIGNING_SECRET!).update(payload).digest('base64url'));const claims=JSON.parse(Buffer.from(payload,'base64url').toString());expect(claims.iss).toBe('mcp');expect(claims.actor).toEqual(actor);expect(claims.request.requestId).toBe(requestId);return Response.json({ok:true});});await operationsPrincipal.run(actor,async()=>{expect(await callRecordings({command:'recording.get',recordingId:randomUUID()},requestId,fetcher as typeof fetch)).toMatchObject({ok:true});expect(await callRecordings({command:'recording.approve'},requestId,fetcher as typeof fetch)).toMatchObject({error:'recording_mcp_command_forbidden'});});expect(fetcher).toHaveBeenCalledTimes(1);});
it('unknown response preserves request ID without exposing raw network details',async()=>{configured();const requestId=randomUUID(),fetcher=vi.fn(async()=>{throw new Error('token=secret customer name');});const r=await operationsPrincipal.run(actor,()=>callRecordings({command:'recording.retry',recordingId:randomUUID()},requestId,fetcher));expect(r).toMatchObject({error:'recording_outcome_unknown',requestId});expect(JSON.stringify(r)).not.toMatch(/token=secret|customer name/);});
for(const status of [429,503])for(const format of ['json','text','inconsistent-success'] as const){
 it(`fails closed on HTTP ${status} ${format}, preserving incomplete coverage and avoiding retries`,async()=>{
  configured();const requestId=randomUUID();
  const fetcher=vi.fn(async()=>format==='text'?new Response('synthetic private edge error',{status}):Response.json(format==='json'?{error:'recording_source_unavailable',message:'synthetic private provider error',authorization:'synthetic secret'}:{ok:true,items:[],coverage:{complete:true}},{status}));
  const r=await operationsPrincipal.run(actor,()=>callRecordings({command:'recording.list',portalJobId:'synthetic-job'},requestId,fetcher));
  expect(r).toMatchObject({httpStatus:status,requestId,retryable:true,coverage:{complete:false}});
  expect(r.error).toEqual(expect.any(String));expect(r).not.toHaveProperty('items');expect(r).not.toMatchObject({ok:true});
  expect(JSON.stringify(r)).not.toMatch(/synthetic private|synthetic secret/);expect(fetcher).toHaveBeenCalledTimes(1);
 });
}
it('refuses malformed successful responses and preserves unknown write outcomes under the original request ID',async()=>{
 configured();const requestId=randomUUID();
 for(const value of [[],null,'unexpected',{},{recordings:[]},{ok:'true'},{ok:false},{error:'untrusted error with private text'}]){
  const f=vi.fn(async()=>Response.json(value));
  const read=await operationsPrincipal.run(actor,()=>callRecordings({command:'recording.get',recordingId:randomUUID()},requestId,f));
  expect(read).toMatchObject({error:'recording_response_invalid',httpStatus:200,requestId,coverage:{complete:false}});
  expect(JSON.stringify(read)).not.toContain('private text');expect(f).toHaveBeenCalledTimes(1);
 }
 const f=vi.fn(async()=>new Response('private edge error',{status:503}));
 const retry=await operationsPrincipal.run(actor,()=>callRecordings({command:'recording.retry',recordingId:randomUUID()},requestId,f));
 expect(retry).toMatchObject({error:'recording_outcome_unknown',httpStatus:503,requestId,retryMode:'same_request_id'});expect(f).toHaveBeenCalledTimes(1);
});
});
