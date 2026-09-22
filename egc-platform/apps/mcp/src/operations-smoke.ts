import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
const required=['contacts.search','egc.operations_status','egc.operations_owners','egc.calendar','actions.queue','actions.propose','actions.complete','actions.complete_from_message','actions.review','egc.visit_get','egc.schedule_visit','egc.add_job_note','egc.update_job_operations','egc.link_project','appointments.reconcile','communications.reconcile','recordings.list','recordings.get','recordings.retry'];
const uuid=(s:string)=>{const h=createHash('sha256').update(s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const isUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const canaryTitle='SYSTEM VALIDATION: internal release canary';
function isCanary(task:any,id:string,release:string){return task?.id===id&&task.kind==='manual'&&task.title===canaryTitle&&!task.contactId&&!task.jobId&&!task.portalJobId&&!task.portalVisitId&&!task.draftPayload&&Array.isArray(task.sourceEvidence)&&task.sourceEvidence.some((e:any)=>e?.source==='staff'&&e.id==='release:'+release);}
const activeRuns=new Map<number,Promise<void>>();
const RETRY_DELAY_MS=30000,MAX_ATTEMPTS=3,MAX_CALENDAR_PAGES=5;
const transientToolErrors=new Set(['portal_authority_unavailable','portal_source_unavailable','portal_calendar_unavailable','operations_unavailable','operations_outcome_unknown','operations_not_enabled','service_key_source_unavailable','service_replay_store_unavailable']);
const fault=(code:string,retryable=false)=>Object.assign(new Error(code),{retryable});
type SmokeRuntime={now?:()=>number;sleep?:(milliseconds:number)=>Promise<void>};
const sleep=(milliseconds:number)=>new Promise<void>(resolve=>{const timer=setTimeout(resolve,milliseconds);timer.unref();});
function calendarWindow(now:number){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));const midnight=Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);return{startDate:new Date(midnight-7*86400000).toISOString().slice(0,10),endDate:new Date(midnight+8*86400000).toISOString().slice(0,10)};}
/** Local HTTP smoke crosses the real MCP auth/dispatch boundary. Credentials and
 * customer payloads are never returned or logged. Optional writes only create and
 * immediately complete one unlinked internal validation action per release.
 * The server invokes this promise in the background. Retries use unref timers,
 * never overlap another run, and never retry an attempted canary write. */
export async function verifyOperationsOnStart(port:number,env:NodeJS.ProcessEnv=process.env,log:(value:Record<string,unknown>)=>void=v=>console.log(JSON.stringify(v)),runtime:SmokeRuntime={}){
 if(env.EGC_OPERATIONS_VERIFY_ON_START!=='true')return;
 const current=activeRuns.get(port);if(current)return current;
 const run=(async()=>{for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt++){
   const {summary,retryable}=await verifyAttempt(port,env,runtime.now??Date.now);
   const retryScheduled=retryable&&attempt<MAX_ATTEMPTS;
   log({...summary,attempt,maxAttempts:MAX_ATTEMPTS,retryScheduled,...(retryScheduled?{retryDelayMs:RETRY_DELAY_MS}:{})});
   if(!retryScheduled)return;
   await (runtime.sleep??sleep)(RETRY_DELAY_MS);
 }})();activeRuns.set(port,run);
 try{await run;}finally{if(activeRuns.get(port)===run)activeRuns.delete(port);}
}
async function verifyAttempt(port:number,env:NodeJS.ProcessEnv,now:()=>number){
 const releaseValue=env.RAILWAY_GIT_COMMIT_SHA??env.EGC_RELEASE_SHA;
 const summary:Record<string,unknown>={event:'operations_startup_verification',release:typeof releaseValue==='string'&&/^[a-f0-9]{40}$/.test(releaseValue)?releaseValue:null,ok:false};
 let stage='configuration',retryable=false;
 try{
  if(!env.MCP_BEARER_TOKEN||env.MCP_BEARER_TOKEN.length<32)throw new Error('verification_credential_unavailable');
  let origin:URL;try{origin=new URL(env.MCP_PUBLIC_ORIGIN??'');}catch{throw fault('verification_origin_unavailable');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw fault('verification_origin_unavailable');
  const host=origin.host;
  let sequence=0;
  const rpc=async(method:string,params:Record<string,unknown>={})=>await new Promise<any>((resolve,reject)=>{
    const id=++sequence;
    const req=httpRequest({hostname:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{host,'content-type':'application/json',accept:'application/json,text/event-stream',authorization:`Bearer ${env.MCP_BEARER_TOKEN}`}},res=>{
      let body='';res.on('data',chunk=>{body+=chunk;if(body.length>2000000){req.destroy();reject(fault('verification_response_too_large'));}});res.on('error',()=>reject(fault('verification_transport_unavailable',true)));res.on('end',()=>{try{
        if(res.statusCode!==200)throw fault('verification_http_failure',res.statusCode===429||Boolean(res.statusCode&&res.statusCode>=500));
        const messages=res.headers['content-type']?.includes('text/event-stream')?body.split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(raw=>JSON.parse(raw)):[JSON.parse(body)];
        const json=messages.find(message=>message?.jsonrpc==='2.0'&&message.id===id);
        if(!json||!json.result||typeof json.result!=='object'||json.error||json.result.isError)throw new Error('verification_rpc_failure');resolve(json.result);
      }catch(error){reject(error instanceof Error&&/^verification_[a-z_]+$/.test(error.message)?error:fault('verification_invalid_response'));}});
    });req.setTimeout(30000,()=>req.destroy(fault('verification_timeout',true)));req.on('error',()=>reject(fault('verification_transport_unavailable',true)));req.end(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  });
  const tool=async(name:string,args:Record<string,unknown>)=>{const r=await rpc('tools/call',{name,arguments:args});const value=r.structuredContent?.result??JSON.parse(r.content?.find((c:any)=>c.type==='text')?.text??'null');if(!value||typeof value!=='object'||value.error||value.ok===false)throw fault('verification_tool_failed',transientToolErrors.has(value?.error));return value;};
  stage='discovery';
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'egc-internal-release-verification',version:'1'}});
  const listed=await rpc('tools/list');if(!Array.isArray(listed.tools)||listed.tools.some((t:any)=>typeof t?.name!=='string'))throw new Error('verification_tools_missing');const names=new Set(listed.tools.map((t:any)=>t.name));
  if(names.size!==listed.tools.length)throw new Error('verification_duplicate_tools');
  if(required.some(n=>!names.has(n)))throw new Error('verification_tools_missing');summary.discoveredTools=names.size;summary.requiredToolsPresent=true;
  stage='contacts';const contacts=await tool('contacts.search',{limit:1});if(!Array.isArray(contacts))throw new Error('verification_contact_read_failed');summary.existingContactRead=true;
  if(env.EGC_OPERATIONS_ENABLED==='true'){
    stage='operations_status';
    const status=await tool('egc.operations_status',{});if(status.ok!==true)throw new Error('verification_operations_unavailable');summary.operationsRead=true;
    stage='hub_owners';
    const owners=await tool('egc.operations_owners',{});
    if(owners.ok!==true||owners.authority!=='employee_hub'||!Array.isArray(owners.members)||!owners.members.length||owners.members.some((m:any)=>!m||typeof m.id!=='string'||!m.id||!['owner','manager','sales','crew_lead','crew'].includes(m.role))||new Set(owners.members.map((m:any)=>m.id)).size!==owners.members.length)throw fault('verification_owner_unverified');
    summary.hubOwnersRead=true;summary.hubOwnerCount=owners.members.length;
    stage='hub_calendar';
    const window=calendarWindow(now()),ids=new Set<string>();let offset=0,total:number|undefined,pages=0,finished=false,timeNeedsReview=0;
    for(;pages<MAX_CALENDAR_PAGES;pages++){
      const calendar=await tool('egc.calendar',{...window,offset,limit:200});
      const asOf=typeof calendar.coverage?.asOf==='string'?Date.parse(calendar.coverage.asOf):NaN;
      if(calendar.ok!==true||calendar.authority!=='employee_hub'||calendar.startDate!==window.startDate||calendar.endDate!==window.endDate||calendar.timeZone!=='America/Denver'||calendar.coverage?.complete!==true||!Number.isFinite(asOf)||asOf<now()-5*60000||asOf>now()+30000||!Array.isArray(calendar.exceptions)||calendar.exceptions.length||!Array.isArray(calendar.items)||calendar.items.length>200||!Number.isSafeInteger(calendar.total)||calendar.total<0||calendar.total>MAX_CALENDAR_PAGES*200||(total!==undefined&&total!==calendar.total))throw fault('verification_calendar_coverage_unverified');
      total=calendar.total;
      for(const item of calendar.items){if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||item.source!=='employee_hub'||!['walkthrough','job'].includes(item.kind))throw fault('verification_calendar_coverage_unverified');ids.add(item.id);if(item.timeNeedsReview===true)timeNeedsReview++;}
      if(calendar.nextOffset===null){if(ids.size!==total)throw fault('verification_calendar_coverage_unverified');finished=true;break;}
      if(!Number.isSafeInteger(calendar.nextOffset)||calendar.nextOffset!==offset+calendar.items.length||calendar.nextOffset<=offset||calendar.nextOffset>=total!)throw fault('verification_calendar_coverage_unverified');
      offset=calendar.nextOffset;
    }
    if(!finished)throw fault('verification_calendar_coverage_unverified');
    summary.hubCalendarRead=true;summary.hubCalendarCoverageComplete=true;summary.hubCalendarCount=ids.size;summary.hubCalendarPages=pages+1;summary.hubScheduleTimeNeedsReviewCount=timeNeedsReview;summary.hubCalendarWindow={...window,timeZone:'America/Denver'};
    if(env.EGC_OPERATIONS_CANARY_ON_START==='true'){
      stage='canary';
      const release=String(summary.release||'');if(!/^[a-f0-9]{40}$/.test(release))throw new Error('verification_release_required');
      const eligible=owners.members.filter((m:any)=>m?.role==='owner'&&typeof m.id==='string'&&m.id.length>0);if(eligible.length!==1)throw new Error('verification_owner_ambiguous');
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
 }catch(error){summary.errorCode=error instanceof Error&&/^verification_[a-z_]+$/.test(error.message)?error.message:'verification_failed';retryable=['operations_status','hub_owners','hub_calendar'].includes(stage)&&Boolean((error as {retryable?:boolean}|null)?.retryable);summary.failedStage=stage;}
 return{summary,retryable};
}
