/** Read-only production acceptance evidence. Never sends, books, approves or charges. */
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const required=['egc.operations_status','egc.operations_owners','egc.calendar','egc.job_brief','egc.visit_get','egc.customer_history','actions.queue','actions.review','actions.propose','actions.complete','actions.reconcile_inbound','recordings.list','recordings.get','recordings.retry','egc.daily_brief','egc.revenue_summary','communications.executions','communications.reconcile'];
const readOnly=new Set(['egc.operations_status','egc.operations_owners','egc.job_brief','egc.visit_get','actions.review','recordings.get']);
const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i,portal=/^[A-Za-z0-9_-]{1,180}$/;
export function parseRpc(text){
  try{return JSON.parse(text);}catch{/* Streamable HTTP may use SSE. */}
  for(const block of text.split(/\r?\n\r?\n/).reverse()){
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')continue;
    try{const value=JSON.parse(data);if('result'in value||'error'in value)return value;}catch{/* Ignore non-JSON stream heartbeats. */}
  }
  throw new Error('invalid_mcp_response');
}
const unwrap=result=>{
  if(result?.isError)throw new Error('tool_returned_error');
  const value=result?.structuredContent?.result??result?.structuredContent;
  const body=value??JSON.parse(result?.content?.find(c=>c.type==='text')?.text??'null');
  if(!body||body.error)throw new Error('tool_returned_error');
  return body;
};
export async function collectAcceptance({url,token,fixture={},fetcher=fetch}){
  const endpoint=new URL(url);
  if((endpoint.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(endpoint.hostname))||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('invalid_mcp_endpoint');
  if(!token)throw new Error('credential_missing');
  let session,id=0;
  async function rpc(method,params,notification=false){
    const response=await fetcher(endpoint,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:++id}),method,params}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('mcp_request_failed');
    session=response.headers.get('mcp-session-id')??session;
    if(notification)return null;
    const parsed=parseRpc(await response.text());if(parsed.error)throw new Error('mcp_protocol_error');return parsed.result;
  }
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'egc-operations-read-only-acceptance',version:'1.0'}});
  await rpc('notifications/initialized',{},true);
  const tools=new Map();let cursor;
  for(let page=0;page<100;page++){const result=await rpc('tools/list',cursor?{cursor}:{});if(!Array.isArray(result?.tools))throw new Error('invalid_tool_catalog');for(const tool of result.tools)tools.set(tool.name,tool);if(!result.nextCursor){cursor=null;break;}cursor=result.nextCursor;}
  if(cursor)throw new Error('incomplete_tool_catalog');
  const checks=[{check:'operations_tool_catalog',ok:required.every(name=>tools.has(name)),missing:required.filter(name=>!tools.has(name))}];
  async function inspect(name,args,verify){
    if(!readOnly.has(name))throw new Error('write_probe_forbidden');
    if(!tools.has(name)){checks.push({check:name,ok:false,error:'tool_unavailable'});return;}
    try{const body=unwrap(await rpc('tools/call',{name,arguments:args}));checks.push({check:name,...verify(body)});}catch{checks.push({check:name,ok:false,error:'read_probe_failed'});}
  }
  await inspect('egc.operations_status',{},body=>({ok:body.ok===true&&Boolean(body.health),release:typeof body.release==='string'&&/^[a-f0-9]{7,40}$/.test(body.release)?body.release:null,hasQueueHealth:Array.isArray(body.health?.queues),hasInboundCheckpoint:!!body.health?.inboundActions}));
  await inspect('egc.operations_owners',{},body=>({ok:body.authority==='employee_hub'&&Array.isArray(body.members),verifiedOwnerCount:Array.isArray(body.members)?body.members.length:null}));
  if(fixture.portalJobId){if(!portal.test(fixture.portalJobId))throw new Error('invalid_fixture_id');await inspect('egc.job_brief',{jobId:fixture.portalJobId},body=>({ok:body.authority==='employee_hub'&&body.job?.id===fixture.portalJobId,hasProject:Boolean(body.job?.projectId),hasStaffInstructions:Boolean(body.job?.operationalScope?.text),hasFinancialEvidence:Boolean(body.financials)}));}
  if(fixture.portalVisitId){if(!portal.test(fixture.portalVisitId))throw new Error('invalid_fixture_id');await inspect('egc.visit_get',{portalVisitId:fixture.portalVisitId},body=>({ok:body.authority==='employee_hub'&&body.visit?.portalVisitId===fixture.portalVisitId,hasExactCustomer:Boolean(body.visit?.portalCustomerId),hasProviderLink:Boolean(body.visit?.highlevelAppointmentId)}));}
  if(fixture.taskId){if(!uuid.test(fixture.taskId))throw new Error('invalid_fixture_id');await inspect('actions.review',{taskId:fixture.taskId},body=>({ok:body.task?.id===fixture.taskId,hasVerifiedOwner:Boolean(body.task?.assignedUserId),hasDeadline:Boolean(body.task?.dueAt),hasAuditHistory:Array.isArray(body.history)&&body.history.length>0,hasCompletionEvidence:Array.isArray(body.task?.completionEvidence)&&body.task.completionEvidence.length>0,revision:Number.isInteger(body.task?.revision)?body.task.revision:null}));}
  if(fixture.recordingId){if(!uuid.test(fixture.recordingId))throw new Error('invalid_fixture_id');await inspect('recordings.get',{recordingId:fixture.recordingId},body=>({ok:body.recording?.id===fixture.recordingId,status:['uploaded','processing','draft','approval_pending','approved','failed'].includes(body.recording?.status)?body.recording.status:'unknown',hasTranscript:typeof body.recording?.transcript==='string'&&body.recording.transcript.length>0,hasApprover:Boolean(body.recording?.approvedBy),hasExactVisit:Boolean(body.recording?.portalVisitId),syntheticPhraseObserved:typeof fixture.expectedRecordingPhrase==='string'?String(body.recording?.transcript??'').toLowerCase().includes(fixture.expectedRecordingPhrase.toLowerCase()):null}));}
  return{checkedAt:new Date().toISOString(),mode:'read_only',productionAcceptance:'incomplete_until_manual_matrix_evidence_is_recorded',checks,allReadChecksPassed:checks.every(c=>c.ok)};
}
async function main(){
  const args=process.argv.slice(2),manifestPath=args[args.indexOf('--manifest')+1],outputPath=args[args.indexOf('--output')+1];
  try{const fixture=args.includes('--manifest')?JSON.parse(await readFile(manifestPath,'utf8')):{};const report=await collectAcceptance({url:process.env.EGC_ACCEPTANCE_MCP_URL||'',token:process.env.MCP_BEARER_TOKEN,fixture});const json=JSON.stringify(report,null,2);if(args.includes('--output'))await writeFile(outputPath,json+'\n',{flag:'wx'});console.log(json);if(!report.allReadChecksPassed)process.exitCode=1;}catch{console.error(JSON.stringify({mode:'read_only',ok:false,error:'acceptance_probe_failed',instruction:'Inspect configuration or authenticated service health; no response bodies or credentials are printed.'}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
