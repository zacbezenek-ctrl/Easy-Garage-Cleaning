import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
const required=['contacts.search','egc.operations_status','egc.operations_owners','egc.calendar','actions.queue','actions.propose','actions.complete','actions.complete_from_message','actions.review','egc.visit_get','egc.schedule_visit','egc.add_job_note','egc.update_job_operations','egc.link_project','appointments.reconcile','communications.reconcile','recordings.list','recordings.get','recordings.retry'];
const uuid=(s:string)=>{const h=createHash('sha256').update(s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const isUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const canaryTitle='SYSTEM VALIDATION: internal release canary';
function isCanary(task:any,id:string,release:string){return task?.id===id&&task.kind==='manual'&&task.title===canaryTitle&&!task.contactId&&!task.jobId&&!task.portalJobId&&!task.portalVisitId&&!task.draftPayload&&Array.isArray(task.sourceEvidence)&&task.sourceEvidence.some((e:any)=>e?.source==='staff'&&e.id==='release:'+release);}
/** Local HTTP smoke crosses the real MCP auth/dispatch boundary. Credentials and
 * customer payloads are never returned or logged. Optional writes only create and
 * immediately complete one unlinked internal validation action per release. */
export async function verifyOperationsOnStart(port:number,env:NodeJS.ProcessEnv=process.env,log:(value:Record<string,unknown>)=>void=v=>console.log(JSON.stringify(v))){
 if(env.EGC_OPERATIONS_VERIFY_ON_START!=='true')return;
 const releaseValue=env.RAILWAY_GIT_COMMIT_SHA??env.EGC_RELEASE_SHA;
 const summary:Record<string,unknown>={event:'operations_startup_verification',release:typeof releaseValue==='string'&&/^[a-f0-9]{40}$/.test(releaseValue)?releaseValue:null,ok:false};
 try{
  if(!env.MCP_BEARER_TOKEN||env.MCP_BEARER_TOKEN.length<32)throw new Error('verification_credential_unavailable');
  const host=new URL(env.MCP_PUBLIC_ORIGIN??'https://invalid.invalid').host;
  let sequence=0;
  const rpc=async(method:string,params:Record<string,unknown>={})=>await new Promise<any>((resolve,reject)=>{
    const id=++sequence;
    const req=httpRequest({hostname:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{host,'content-type':'application/json',accept:'application/json,text/event-stream',authorization:`Bearer ${env.MCP_BEARER_TOKEN}`}},res=>{
      let body='';res.on('data',chunk=>{body+=chunk;if(body.length>2000000){req.destroy();reject(new Error('verification_response_too_large'));}});res.on('error',()=>reject(new Error('verification_transport_unavailable')));res.on('end',()=>{try{
        if(res.statusCode!==200)throw new Error('verification_http_failure');
        const messages=res.headers['content-type']?.includes('text/event-stream')?body.split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(raw=>JSON.parse(raw)):[JSON.parse(body)];
        const json=messages.find(message=>message?.jsonrpc==='2.0'&&message.id===id);
        if(!json||!json.result||typeof json.result!=='object'||json.error||json.result.isError)throw new Error('verification_rpc_failure');resolve(json.result);
      }catch{reject(new Error('verification_invalid_response'));}});
    });req.setTimeout(30000,()=>req.destroy(new Error('verification_timeout')));req.on('error',()=>reject(new Error('verification_transport_unavailable')));req.end(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  });
  const tool=async(name:string,args:Record<string,unknown>)=>{const r=await rpc('tools/call',{name,arguments:args});const value=r.structuredContent?.result??JSON.parse(r.content?.find((c:any)=>c.type==='text')?.text??'null');if(!value||typeof value!=='object'||value.error||value.ok===false)throw new Error('verification_tool_failed');return value;};
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'egc-internal-release-verification',version:'1'}});
  const listed=await rpc('tools/list');if(!Array.isArray(listed.tools)||listed.tools.some((t:any)=>typeof t?.name!=='string'))throw new Error('verification_tools_missing');const names=new Set(listed.tools.map((t:any)=>t.name));
  if(names.size!==listed.tools.length)throw new Error('verification_duplicate_tools');
  if(required.some(n=>!names.has(n)))throw new Error('verification_tools_missing');summary.discoveredTools=names.size;summary.requiredToolsPresent=true;
  const contacts=await tool('contacts.search',{limit:1});if(!Array.isArray(contacts))throw new Error('verification_contact_read_failed');summary.existingContactRead=true;
  if(env.EGC_OPERATIONS_ENABLED==='true'){
    const status=await tool('egc.operations_status',{});if(status.ok!==true)throw new Error('verification_operations_unavailable');summary.operationsRead=true;
    if(env.EGC_OPERATIONS_CANARY_ON_START==='true'){
      const release=String(summary.release||'');if(!/^[a-f0-9]{40}$/.test(release))throw new Error('verification_release_required');
      const owners=await tool('egc.operations_owners',{});if(owners.authority!=='employee_hub'||!Array.isArray(owners.members))throw new Error('verification_owner_unverified');const eligible=owners.members.filter((m:any)=>m?.role==='owner'&&typeof m.id==='string'&&m.id.length>0);if(eligible.length!==1)throw new Error('verification_owner_ambiguous');
      const requestId=uuid('egc-internal-acceptance:'+release);
      // Fixed per-release times keep retries byte-identical after a restart.
      const created=await tool('actions.propose',{requestId,task:{title:canaryTitle,description:'Synthetic internal task. No customer, project, send, booking or payment.',kind:'manual',assignedUserId:eligible[0].id,dueAt:'2099-01-01T00:00:00Z',completionCondition:'Verify this saved task through MCP and record the read-back result',sourceEvidence:[{source:'staff',id:'release:'+release,excerpt:'Synthetic system acceptance test'}]}});
      const id=created.task?.id;if(!isUuid(id))throw new Error('verification_task_not_created');summary.canaryTaskId=id;
      const read=await tool('actions.review',{taskId:id});if(!isCanary(read.task,id,release)||!Number.isSafeInteger(read.task.revision)||read.task.revision<1)throw new Error('verification_task_read_failed');
      if(read.task.status!=='completed')await tool('actions.complete',{requestId:uuid('egc-internal-acceptance-complete:'+release),taskId:id,revision:read.task.revision,outcome:'Synthetic internal task was created and read back through the authenticated MCP boundary. No customer operation performed.'});
      const confirmed=await tool('actions.review',{taskId:id});if(!isCanary(confirmed.task,id,release)||confirmed.task.status!=='completed'||!Array.isArray(confirmed.history)||!confirmed.history.some((e:any)=>e?.type==='task.complete'))throw new Error('verification_completion_not_confirmed');
      summary.internalWriteReadVerified=true;
    }
  }else summary.operationsRead='not_enabled';
  summary.ok=true;
 }catch(error){summary.errorCode=error instanceof Error&&/^verification_[a-z_]+$/.test(error.message)?error.message:'verification_failed';}
 log(summary);
}
