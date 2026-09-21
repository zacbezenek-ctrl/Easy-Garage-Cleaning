import {afterEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {verifyOperationsOnStart} from '../src/operations-smoke.js';

const names=['contacts.search','egc.operations_status','egc.operations_owners','egc.calendar','actions.queue','actions.propose','actions.complete','actions.complete_from_message','actions.review','egc.visit_get','egc.schedule_visit','egc.add_job_note','egc.update_job_operations','egc.link_project','appointments.reconcile','communications.reconcile','recordings.list','recordings.get','recordings.retry'];
const env={EGC_OPERATIONS_VERIFY_ON_START:'true',EGC_OPERATIONS_ENABLED:'true',MCP_BEARER_TOKEN:'synthetic-secret-credential-more-than-32-chars',MCP_PUBLIC_ORIGIN:'https://mcp.example.test',EGC_RELEASE_SHA:'a'.repeat(40)};
const id='12345678-1234-4234-8234-123456789abc';
const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function fixture(options:{sse?:boolean;contacts?:unknown;missingTool?:boolean;duplicate?:boolean;mutateRead?:(r:any)=>void;ownerCount?:number;failComplete?:boolean;badId?:boolean;malformed?:boolean;rpcError?:boolean;toolError?:boolean}={}){
 const requests:any[]=[],headers:any[]=[],tasks=new Map<string,any>();let completes=0;
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const request=JSON.parse(body);requests.push(request);headers.push(req.headers);let result:any;
   if(request.method==='initialize')result={protocolVersion:'2025-03-26'};
   else if(request.method==='tools/list')result={tools:(options.missingTool?names.slice(1):options.duplicate?[...names,names[0]]:names).map(name=>({name}))};
   else{
     const {name,arguments:args}=request.params;let value:any;
     if(name==='contacts.search')value='contacts' in options?options.contacts:[{email:'private@example.invalid',token:'provider-secret'}];
     else if(name==='egc.operations_status')value={ok:true};
     else if(name==='egc.operations_owners')value={authority:'employee_hub',members:Array.from({length:options.ownerCount??1},(_,i)=>({id:'owner-'+i,role:'owner'}))};
     else if(name==='actions.propose'){if(!tasks.has(args.requestId))tasks.set(args.requestId,{...args.task,id,revision:1,status:'open',contactId:null,jobId:null,portalJobId:null,portalVisitId:null,draftPayload:null});value={ok:true,task:tasks.get(args.requestId)};}
     else if(name==='actions.review'){const task=structuredClone([...tasks.values()][0]);value={ok:true,task,history:task.status==='completed'?[{type:'task.complete'}]:[]};options.mutateRead?.(value);}
     else if(name==='actions.complete'){completes++;const task=[...tasks.values()][0];task.status='completed';task.revision=2;value={ok:true,task};if(options.failComplete){res.statusCode=503;res.end('provider-secret');return;}}
     else throw new Error('Unexpected fixture tool '+name);
     result=options.toolError&&name==='contacts.search'?{isError:true,content:[{type:'text',text:'provider-secret'}]}:{structuredContent:{result:value}};
   }
   const response=options.rpcError?{jsonrpc:'2.0',id:request.id,error:{message:'provider-secret'}}:{jsonrpc:'2.0',id:options.badId?request.id+1:request.id,result};
   res.setHeader('content-type',options.sse?'text/event-stream':'application/json');
   res.end(options.malformed?'private@example.invalid provider-secret':options.sse?`event: progress\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n`:JSON.stringify(response));
 });});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 const run=async(extra:NodeJS.ProcessEnv={})=>{const log=vi.fn();await verifyOperationsOnStart(port,{...env,...extra},log);return log;};
 return{run,requests,headers,completes:()=>completes};
}
describe('operations startup verification',()=>{
 it.each([false,true])('crosses local authenticated transport and handles JSON/SSE without leaking customer data (%s)',async sse=>{const f=await fixture({sse}),log=await f.run();expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:true,existingContactRead:true,operationsRead:true}));expect(f.headers.every(h=>h.host==='mcp.example.test'&&h.authorization===`Bearer ${env.MCP_BEARER_TOKEN}`)).toBe(true);expect(f.requests.filter(r=>r.method==='tools/call').map(r=>r.params.name)).toEqual(['contacts.search','egc.operations_status']);for(const secret of [env.MCP_BEARER_TOKEN,'provider-secret','private@example.invalid'])expect(JSON.stringify(log.mock.calls)).not.toContain(secret);});
 it('is inactive unless explicitly enabled and refuses absent credentials before any HTTP',async()=>{const f=await fixture();expect(await f.run({EGC_OPERATIONS_VERIFY_ON_START:'false'})).not.toHaveBeenCalled();const log=await f.run({MCP_BEARER_TOKEN:''});expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:false,errorCode:'verification_credential_unavailable'}));expect(f.requests).toHaveLength(0);});
 it.each([{},null,{contacts:[]}])('cannot claim success for malformed existing contact read %s',async contacts=>{const f=await fixture({contacts}),log=await f.run();expect(log.mock.calls[0]?.[0].ok).toBe(false);expect(log.mock.calls[0]?.[0].existingContactRead).not.toBe(true);});
 it.each([{missingTool:true},{duplicate:true},{badId:true},{malformed:true},{rpcError:true},{toolError:true}])('fails safely for invalid discovery or RPC responses %s',async options=>{const f=await fixture(options),log=await f.run();expect(log.mock.calls[0]?.[0].ok).toBe(false);expect(JSON.stringify(log.mock.calls)).not.toMatch(/provider-secret|private@example.invalid/);});
 it('keeps operations-disabled smoke read-only even if canary flag is set',async()=>{const f=await fixture(),log=await f.run({EGC_OPERATIONS_ENABLED:'false',EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:true,operationsRead:'not_enabled'}));expect(f.requests.filter(r=>r.method==='tools/call').map(r=>r.params.name)).toEqual(['contacts.search']);});
 it('creates, reads and completes one unlinked internal canary per release across restarts',async()=>{const f=await fixture();for(let n=0;n<2;n++){const log=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log).toHaveBeenCalledWith(expect.objectContaining({ok:true,internalWriteReadVerified:true,canaryTaskId:id}));}const creates=f.requests.filter(r=>r.params?.name==='actions.propose');expect(creates[0].params.arguments).toEqual(creates[1].params.arguments);expect(f.completes()).toBe(1);expect(f.requests.some(r=>r.params?.name==='send_sms'||r.params?.name==='egc.schedule_visit')).toBe(false);});
 it('recovers a lost completion response through durable read-back without another completion write',async()=>{const f=await fixture({failComplete:true});const first=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(first.mock.calls[0]?.[0].ok).toBe(false);const second=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(second.mock.calls[0]?.[0].ok).toBe(true);expect(f.completes()).toBe(1);});
 it.each([0,2])('refuses ambiguous owner selection before any synthetic write (%s)',async ownerCount=>{const f=await fixture({ownerCount}),log=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log.mock.calls[0]?.[0].ok).toBe(false);expect(f.requests.some(r=>r.params?.name==='actions.propose')).toBe(false);});
 it('never completes a foreign/customer-linked task returned by faulty read-back',async()=>{const f=await fixture({mutateRead:r=>r.task.contactId='customer-id'}),log=await f.run({EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log.mock.calls[0]?.[0].errorCode).toBe('verification_task_read_failed');expect(f.completes()).toBe(0);});
 it('does not log malformed release configuration or treat it as canary identity',async()=>{const f=await fixture(),log=await f.run({EGC_RELEASE_SHA:'private@example.invalid',EGC_OPERATIONS_CANARY_ON_START:'true'});expect(log.mock.calls[0]?.[0]).toMatchObject({ok:false,release:null,errorCode:'verification_release_required'});expect(JSON.stringify(log.mock.calls)).not.toContain('private@example.invalid');});
});
