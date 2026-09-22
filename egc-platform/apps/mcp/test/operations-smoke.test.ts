import {afterEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {verifyOperationsOnStart} from '../src/operations-smoke.js';

const names=['contacts.search','egc.operations_status','egc.operations_owners','egc.calendar','actions.queue','actions.propose','actions.complete','actions.complete_from_message','actions.review','egc.visit_get','egc.schedule_visit','egc.add_job_note','egc.update_job_operations','egc.link_project','appointments.reconcile','communications.reconcile','recordings.list','recordings.get','recordings.retry'];
const env={EGC_OPERATIONS_VERIFY_ON_START:'true',EGC_OPERATIONS_ENABLED:'true',MCP_BEARER_TOKEN:'synthetic-secret-credential-more-than-32-chars',MCP_PUBLIC_ORIGIN:'https://mcp.example.test',EGC_RELEASE_SHA:'a'.repeat(40)};
const id='12345678-1234-4234-8234-123456789abc';
const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function fixture(options:{sse?:boolean;textContent?:boolean;contacts?:unknown;missingTool?:boolean;duplicate?:boolean;mutateRead?:(r:any)=>void;ownerCount?:number;owners?:unknown;calendar?:(args:any)=>any;failure?:{tool:string;count:number;mode:'http'|'tool'|'disconnect';status?:number};failComplete?:boolean;badId?:boolean;malformed?:boolean;rpcError?:boolean;toolError?:boolean}={}){
 const requests:any[]=[],headers:any[]=[],tasks=new Map<string,any>();let completes=0,failures=0;
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const request=JSON.parse(body);requests.push(request);headers.push(req.headers);let result:any;
   if(request.method==='initialize')result={protocolVersion:'2025-03-26'};
   else if(request.method==='tools/list')result={tools:(options.missingTool?names.slice(1):options.duplicate?[...names,names[0]]:names).map(name=>({name}))};
   else{
     const {name,arguments:args}=request.params;let value:any;
     if(options.failure?.tool===name&&failures++<options.failure.count){
       if(options.failure.mode==='http'){res.statusCode=options.failure.status??503;res.end('provider-secret');return;}
       if(options.failure.mode==='disconnect'){req.socket.destroy();return;}
       value={error:'portal_authority_unavailable',private:'provider-secret'};
     }
     else
     if(name==='contacts.search')value='contacts' in options?options.contacts:[{email:'private@example.invalid',token:'provider-secret'}];
     else if(name==='egc.operations_status')value={ok:true};
     else if(name==='egc.operations_owners')value='owners' in options?options.owners:{ok:true,authority:'employee_hub',members:Array.from({length:options.ownerCount??1},(_,i)=>({id:'owner-'+i,role:'owner'}))};
     else if(name==='egc.calendar')value=options.calendar?options.calendar(args):calendar(args);
     else if(name==='actions.propose'){if(!tasks.has(args.requestId))tasks.set(args.requestId,{...args.task,id,revision:1,status:'open',contactId:null,jobId:null,portalJobId:null,portalVisitId:null,draftPayload:null});value={ok:true,task:tasks.get(args.requestId)};}
     else if(name==='actions.review'){const task=structuredClone([...tasks.values()][0]);value={ok:true,task,history:task.status==='completed'?[{type:'task.complete'}]:[]};options.mutateRead?.(value);}
     else if(name==='actions.complete'){completes++;const task=[...tasks.values()][0];task.status='completed';task.revision=2;value={ok:true,task};if(options.failComplete){res.statusCode=503;res.end('provider-secret');return;}}
     else throw new Error('Unexpected fixture tool '+name);
     result=options.toolError&&name==='contacts.search'?{isError:true,content:[{type:'text',text:'provider-secret'}]}:options.textContent?{content:[{type:'text',text:JSON.stringify(value)}]}:{structuredContent:{result:value}};
   }
   const response=options.rpcError?{jsonrpc:'2.0',id:request.id,error:{message:'provider-secret'}}:{jsonrpc:'2.0',id:options.badId?request.id+1:request.id,result};
   res.setHeader('content-type',options.sse?'text/event-stream':'application/json');
   res.end(options.malformed?'private@example.invalid provider-secret':options.sse?`event: progress\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n`:JSON.stringify(response));
 });});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 const run=async(extra:NodeJS.ProcessEnv={},runtime:Parameters<typeof verifyOperationsOnStart>[3]={sleep:async()=>{}})=>{const log=vi.fn();await verifyOperationsOnStart(port,{...env,...extra},log,runtime);return log;};
 return{run,port,requests,headers,completes:()=>completes};
}
const calendar=(args:any,extra:any={})=>({ok:true,authority:'employee_hub',startDate:args.startDate,endDate:args.endDate,timeZone:'America/Denver',items:[],total:0,nextOffset:null,exceptions:[],coverage:{complete:true,asOf:new Date().toISOString()},...extra});
const item=(n:number)=>({id:'private-visit-'+n,source:'employee_hub',kind:'walkthrough',customer:'private@example.invalid',address:'private address'});
describe('operations startup verification',()=>{
 it.each([false,true])('crosses local authenticated transport and handles JSON/SSE without leaking customer data (%s)',async sse=>{const f=await fixture({sse,calendar:args=>calendar(args,{items:[item(1)],total:1})}),log=await f.run();expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:true,existingContactRead:true,operationsRead:true,hubOwnersRead:true,hubOwnerCount:1,hubCalendarRead:true,hubCalendarCoverageComplete:true,hubCalendarCount:1,attempt:1,retryScheduled:false}));expect(f.headers.every(h=>h.host==='mcp.example.test'&&h.authorization===`Bearer ${env.MCP_BEARER_TOKEN}`)).toBe(true);expect(f.requests.filter(r=>r.method==='tools/call').map(r=>r.params.name)).toEqual(['contacts.search','egc.operations_status','egc.operations_owners','egc.calendar']);for(const secret of [env.MCP_BEARER_TOKEN,'provider-secret','private@example.invalid','private-visit-1','private address','owner-0'])expect(JSON.stringify(log.mock.calls)).not.toContain(secret);});
 it('accepts text content MCP responses and a complete authoritative empty calendar without writes',async()=>{const f=await fixture({textContent:true}),log=await f.run();expect(log.mock.calls[0]?.[0]).toMatchObject({ok:true,hubCalendarCount:0,hubCalendarCoverageComplete:true});expect(f.requests.some(r=>r.params?.name?.startsWith('actions.'))).toBe(false);});
 it('is inactive unless explicitly enabled and refuses absent credentials before any HTTP',async()=>{const f=await fixture();expect(await f.run({EGC_OPERATIONS_VERIFY_ON_START:'false'})).not.toHaveBeenCalled();const log=await f.run({MCP_BEARER_TOKEN:''});expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:false,errorCode:'verification_credential_unavailable'}));expect(f.requests).toHaveLength(0);});
 it.each([{},null,{contacts:[]}])('cannot claim success for malformed existing contact read %s',async contacts=>{const f=await fixture({contacts}),log=await f.run();expect(log.mock.calls[0]?.[0].ok).toBe(false);expect(log.mock.calls[0]?.[0].existingContactRead).not.toBe(true);});
 it.each([{missingTool:true},{duplicate:true},{badId:true},{malformed:true},{rpcError:true},{toolError:true}])('fails safely for invalid discovery or RPC responses %s',async options=>{const f=await fixture(options),log=await f.run();expect(log.mock.calls[0]?.[0].ok).toBe(false);expect(JSON.stringify(log.mock.calls)).not.toMatch(/provider-secret|private@example.invalid/);});
 it('keeps operations-disabled smoke read-only even if canary flag is set',async()=>{const f=await fixture(),log=await f.run({EGC_OPERATIONS_ENABLED:'false',EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:true,operationsRead:'not_enabled'}));expect(f.requests.filter(r=>r.method==='tools/call').map(r=>r.params.name)).toEqual(['contacts.search']);});
 it('creates, reads and completes one unlinked internal canary per release across restarts',async()=>{const f=await fixture();for(let n=0;n<2;n++){const log=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:true,internalWriteReadVerified:true,canaryTaskId:id}));}const creates=f.requests.filter(r=>r.params?.name==='actions.propose');expect(creates[0].params.arguments).toEqual(creates[1].params.arguments);expect(f.completes()).toBe(1);expect(f.requests.some(r=>r.params?.name==='send_sms'||r.params?.name==='egc.schedule_visit')).toBe(false);});
 it('recovers a lost completion response through durable read-back without another completion write',async()=>{const f=await fixture({failComplete:true});const first=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(first.mock.calls[0]?.[0].ok).toBe(false);const second=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(second.mock.calls[0]?.[0].ok).toBe(true);expect(f.completes()).toBe(1);});
 it.each([0,2])('refuses ambiguous owner selection before any synthetic write (%s)',async ownerCount=>{const f=await fixture({ownerCount}),log=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log.mock.calls[0]?.[0].ok).toBe(false);expect(f.requests.some(r=>r.params?.name==='actions.propose')).toBe(false);});
 it('never completes a foreign/customer-linked task returned by faulty read-back',async()=>{const f=await fixture({mutateRead:r=>r.task.contactId='customer-id'}),log=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log.mock.calls[0]?.[0].errorCode).toBe('verification_task_read_failed');expect(f.completes()).toBe(0);});
 it('does not log malformed release configuration or treat it as canary identity',async()=>{const f=await fixture(),log=await f.run({EGC_RELEASE_SHA:'private@example.invalid',EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log.mock.calls[0]?.[0]).toMatchObject({ok:false,release:null,errorCode:'verification_release_required'});expect(JSON.stringify(log.mock.calls)).not.toContain('private@example.invalid');});
 it('uses Denver calendar days at UTC midnight and exhausts validated pagination',async()=>{
  const now=Date.parse('2026-09-22T02:00:00Z'),seen:any[]=[];
  const f=await fixture({calendar:args=>{seen.push(args);return calendar(args,{items:args.offset===0?Array.from({length:200},(_,n)=>item(n)):[{...item(200),timeNeedsReview:true}],total:201,nextOffset:args.offset===0?200:null,coverage:{complete:true,asOf:new Date(now).toISOString()}});}});
  const log=await f.run({}, {now:()=>now,sleep:async()=>{}});expect(seen).toEqual([{startDate:'2026-09-14',endDate:'2026-09-29',offset:0,limit:200},{startDate:'2026-09-14',endDate:'2026-09-29',offset:200,limit:200}]);
  expect(log.mock.calls[0]?.[0]).toMatchObject({ok:true,hubCalendarCount:201,hubCalendarPages:2,hubScheduleTimeNeedsReviewCount:1});expect(JSON.stringify(log.mock.calls)).not.toContain('private-visit');
 });
 it.each([
  {authority:'ghl'}, {coverage:{complete:false,asOf:new Date().toISOString()}}, {coverage:{complete:true,asOf:'not-a-date'}}, {coverage:{complete:true,asOf:'2020-01-01T00:00:00Z'}}, {exceptions:[{recordId:'private',code:'bad'}]}, {items:null}, {items:[],total:1}, {nextOffset:undefined}, {startDate:'1990-01-01'}, {timeZone:'UTC'}, {total:1001}, {items:[item(1),item(1)],total:2}
 ])('incomplete, stale or contradictory calendar evidence never proves an empty healthy calendar: %s',async extra=>{
  const sleep=vi.fn(async()=>{}),f=await fixture({calendar:args=>calendar(args,extra)}),log=await f.run({}, {sleep});
  expect(log.mock.calls[0]?.[0]).toMatchObject({ok:false,failedStage:'hub_calendar',errorCode:'verification_calendar_coverage_unverified',retryScheduled:false});expect(log.mock.calls[0]?.[0]).not.toHaveProperty('hubCalendarCount');expect(sleep).not.toHaveBeenCalled();
 });
 it('rejects cross-page duplicate visits and changing totals',async()=>{
  for(const changedTotal of [false,true]){const f=await fixture({calendar:args=>calendar(args,args.offset===0?{items:[item(1)],total:2,nextOffset:1}:{items:[item(changedTotal?2:1)],total:changedTotal?3:2,nextOffset:null})}),log=await f.run();expect(log.mock.calls[0]?.[0]).toMatchObject({ok:false,errorCode:'verification_calendar_coverage_unverified'});expect(log.mock.calls[0]?.[0]).not.toHaveProperty('hubCalendarCount');}
 });
 it.each([{ok:true,authority:'ghl',members:[{id:'owner',role:'owner'}]},{ok:true,authority:'employee_hub',members:[]},{ok:true,authority:'employee_hub',members:[{id:'owner',role:'owner'},{id:'owner',role:'owner'}]}])('requires an authoritative valid owner roster before calendar access',async owners=>{
  const f=await fixture({owners}),log=await f.run();expect(log.mock.calls[0]?.[0]).toMatchObject({ok:false,errorCode:'verification_owner_unverified'});expect(f.requests.some(r=>r.params?.name==='egc.calendar')).toBe(false);
 });
 it.each(['http','tool','disconnect'] as const)('retries transient Hub deployment failure using nonblocking 30s delays, then verifies the full path (%s)',async mode=>{
  const sleep=vi.fn(async()=>{}),f=await fixture({failure:{tool:'egc.operations_owners',count:2,mode}}),log=await f.run({}, {sleep});
  expect(log.mock.calls).toHaveLength(3);expect(log.mock.calls.map(c=>c[0].attempt)).toEqual([1,2,3]);expect(log.mock.calls.slice(0,2).every(c=>c[0].ok===false&&c[0].retryScheduled===true)).toBe(true);expect(log.mock.calls[2]?.[0]).toMatchObject({ok:true,hubCalendarRead:true,retryScheduled:false});expect(sleep.mock.calls).toEqual([[30000],[30000]]);expect(f.requests.some(r=>r.params?.name==='actions.propose')).toBe(false);expect(JSON.stringify(log.mock.calls)).not.toContain('provider-secret');
 });
 it('stops after three transient attempts and does not log a failed calendar as zero',async()=>{
  const sleep=vi.fn(async()=>{}),f=await fixture({failure:{tool:'egc.calendar',count:99,mode:'tool'}}),log=await f.run({}, {sleep});expect(log.mock.calls).toHaveLength(3);expect(sleep).toHaveBeenCalledTimes(2);expect(log.mock.calls.at(-1)?.[0]).toMatchObject({ok:false,attempt:3,failedStage:'hub_calendar',retryScheduled:false});for(const [entry] of log.mock.calls)expect(entry).not.toHaveProperty('hubCalendarCount');
 });
 it('does not retry denied authentication or discovery failures',async()=>{
  const sleep=vi.fn(async()=>{}),f=await fixture({failure:{tool:'egc.operations_owners',count:99,mode:'http',status:403}}),log=await f.run({}, {sleep});expect(log).toHaveBeenCalledTimes(1);expect(sleep).not.toHaveBeenCalled();expect(log.mock.calls[0]?.[0]).toMatchObject({ok:false,retryScheduled:false});
 });
 it('coalesces overlapping startup calls while a background retry is waiting',async()=>{
  const f=await fixture({failure:{tool:'egc.operations_owners',count:1,mode:'tool'}}),firstLog=vi.fn(),secondLog=vi.fn();let resume!:()=>void,reached!:()=>void;
  const reachedSleep=new Promise<void>(resolve=>{reached=resolve;}),sleep=vi.fn(()=>new Promise<void>(resolve=>{resume=resolve;reached();}));
  const first=verifyOperationsOnStart(f.port,env,firstLog,{sleep});await reachedSleep;const second=verifyOperationsOnStart(f.port,env,secondLog,{sleep});expect(f.requests.filter(r=>r.method==='initialize')).toHaveLength(1);resume();await Promise.all([first,second]);expect(firstLog).toHaveBeenCalledTimes(2);expect(secondLog).not.toHaveBeenCalled();expect(f.requests.filter(r=>r.method==='initialize')).toHaveLength(2);expect(sleep).toHaveBeenCalledTimes(1);
 });
});
