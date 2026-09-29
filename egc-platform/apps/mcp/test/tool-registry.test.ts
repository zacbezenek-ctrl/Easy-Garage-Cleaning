import {afterEach,describe,expect,it,vi} from 'vitest';
import * as z from 'zod/v4';
import type {McpServer} from '@modelcontextprotocol/server';
import {defineTool,registerTools,invokeTool,requestIdField,confirmTokenField,TOOL_CLASSES,TWO_STEP_CLASSES,type ConfirmGate,type ToolClass,type ToolDef} from '../src/tools/define.js';
import {decodeCursor,encodeCursor,encodeKeysetCursor,filterDigest,keysetOf,pageOf,pageFields,readCursor,CursorError} from '../src/tools/pagination.js';
import {error,guarded,result} from '../src/tools/result.js';
import {DOMAIN_TOOLS,REGISTRY_WRITE_TOOLS} from '../src/tools/index.js';
import {requiredToolScope,WRITE_TOOLS} from '../src/tool-access.js';
import {operationsPrincipal} from '../src/operations.js';
import {READ_SCOPE,WRITE_SCOPE} from '../src/oauth.js';
import {buildServer} from '../src/server.js';

const env={...process.env};afterEach(()=>{process.env={...env};vi.restoreAllMocks();});
const NOW=new Date('2026-09-22T12:00:00.000Z'),now=()=>NOW;
const REQUEST='3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70';
const service={id:'mcp-service-grant',role:'integration' as const,kind:'integration' as const,workspace:'egc'};
const owner={...service,id:'mcp-oauth-grant:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b'};
const as=<T>(actor:typeof service|null,run:()=>T)=>actor?operationsPrincipal.run(actor,run):run();
const payload=(r:{structuredContent:{result:unknown}})=>r.structuredContent.result as Record<string,any>;
// Legacy write tools registered before this framework without a requestId. Entries may only be removed as tools migrate.
const LEGACY_WITHOUT_REQUEST_ID=['meta.conversions.sync','meta.conversions.retry','meta.conversions.test','egc.reconcile_customer_state','egc.record_user_confirmed_outcome','jobs.create','jobs.update','jobs.add_note','walkthroughs.create_draft','walkthroughs.update_draft','walkthroughs.approve','communications.reconcile','tasks.create','tasks.update','tasks.complete','contacts.create','contacts.update','contacts.add_tags','contacts.remove_tags','opportunities.create','opportunities.update','appointments.reconcile','appointments.delete'];

function spec(cls:ToolClass,extra:Record<string,unknown>={}){
  const twoStep=TWO_STEP_CLASSES.has(cls);
  return {name:`synthetic.${cls}_tool`,class:cls,description:`Synthetic ${cls} tool.`,
    input:z.object({...(cls==='read'?{}:{requestId:requestIdField}),...(twoStep?{confirmToken:confirmTokenField}:{}),value:z.string().max(20)}).strict(),
    ...(twoStep?{preview:vi.fn((input:any)=>({wouldApply:input.value}))}:{}),
    handler:vi.fn((input:any)=>({applied:input.value})),...extra} as any;
}
function capture(){const tools=new Map<string,{config:any;handler:(args:unknown)=>Promise<any>}>();return {tools,server:{registerTool:(name:string,config:unknown,handler:any)=>{if(tools.has(name))throw new Error(`Tool ${name} is already registered`);tools.set(name,{config,handler});}} as unknown as McpServer};}
function built(operations:boolean){process.env.EGC_OPERATIONS_ENABLED=String(operations);return (buildServer() as unknown as {_registeredTools:Record<string,any>})._registeredTools;}

describe('defineTool derives policy from the tool class',()=>{
  it.each(TOOL_CLASSES)('%s',cls=>{
    const def=defineTool(spec(cls)),readOnly=cls==='read',twoStep=cls==='destructive'||cls==='send'||cls==='money';
    expect(def.policy).toEqual({class:cls,readOnly,scope:readOnly?READ_SCOPE:WRITE_SCOPE,scopes:readOnly?[READ_SCOPE]:[READ_SCOPE,WRITE_SCOPE],requiresRequestId:!readOnly,twoStep,ownerOnly:false});
    expect(def.annotations).toEqual({readOnlyHint:readOnly,destructiveHint:twoStep,openWorldHint:cls==='send'||cls==='money'});
    expect(Object.isFrozen(def)&&Object.isFrozen(def.policy)).toBe(true);
    const {tools,server}=capture();registerTools(server,[def]);const config=tools.get(def.name)!.config;
    expect(config.annotations.readOnlyHint).toBe(readOnly);
    expect(config.securitySchemes).toEqual([{type:'oauth2',scopes:def.policy.scopes}]);expect(config._meta.securitySchemes).toEqual(config.securitySchemes);
    expect(z.toJSONSchema(config.inputSchema)).toMatchObject({additionalProperties:false});
  });
  it('refuses definitions that would weaken the safety contract',()=>{
    const bad:[string,Record<string,unknown>][]=[
      ['write_requires_request_id',{...spec('write'),input:z.object({value:z.string()}).strict()}],
      ['write_requires_request_id',{...spec('write'),input:z.object({requestId:z.string().uuid().optional()}).strict()}],
      ['write_requires_request_id',{...spec('write'),input:z.object({requestId:z.string()}).strict()}],
      ['two_step_requires_confirm_path',{...spec('send'),input:z.object({requestId:requestIdField}).strict()}],
      ['two_step_requires_confirm_path',{...spec('money'),preview:undefined}],
      ['two_step_requires_confirm_path',{...spec('destructive'),input:z.object({requestId:requestIdField,confirmToken:z.string()}).strict()}],
      ['confirm_path_requires_two_step_class',{...spec('write'),input:z.object({requestId:requestIdField,confirmToken:confirmTokenField}).strict()}],
      ['confirm_path_requires_two_step_class',{...spec('read'),preview:()=>null}],
      ['input_must_be_strict',{...spec('read'),input:z.object({value:z.string()})}],
      ['input_must_be_strict',{...spec('read'),input:z.object({value:z.string()}).passthrough()}],
      ['input_must_be_object',{...spec('read'),input:z.string()}],
      ['name_must_be_domain_verb',{...spec('read'),name:'send_sms'}],
      ['name_must_be_domain_verb',{...spec('read'),name:'Contacts.search'}],
      ['unknown_class',{...spec('read'),class:'admin'}],
      ['description_required',{...spec('read'),description:' '}],
      ['handler_required',{...spec('read'),handler:undefined}]
    ];
    for(const [reason,definition] of bad)expect(()=>defineTool(definition as any),reason).toThrow(reason);
  });
  it('rejects duplicate registry names and collisions with reserved legacy names',()=>{
    const def=defineTool(spec('read'));
    expect(()=>registerTools(capture().server,[def,def])).toThrow('duplicate_name');
    expect(()=>registerTools(capture().server,[def],{reserved:[def.name]})).toThrow('duplicate_name');
  });
  it('strict input schemas reject unknown keys, including through the real registry',()=>{
    const def=defineTool(spec('write'));
    expect(def.input.safeParse({requestId:REQUEST,value:'x'}).success).toBe(true);
    expect(def.input.safeParse({requestId:REQUEST,value:'x',actor:'owner'}).success).toBe(false);
    const policy=built(false)['egc.safety_policy'];
    expect(policy.inputSchema.safeParse({}).success).toBe(true);expect(policy.inputSchema.safeParse({role:'owner'}).success).toBe(false);
  });
});

describe('registry invariants over every registered tool',()=>{
  it.each([false,true])('operations=%s: classified, write-scoped, request IDs, unique names',operations=>{
    const tools=built(operations),names=Object.keys(tools);
    for(const def of DOMAIN_TOOLS)expect(names.filter(n=>n===def.name)).toHaveLength(1);
    const withoutRequestId:string[]=[];
    for(const [name,tool] of Object.entries(tools)){
      expect(typeof tool.annotations?.readOnlyHint,name).toBe('boolean');
      expect(tool.annotations.readOnlyHint,name).toBe(requiredToolScope(name)===READ_SCOPE);
      const scopes=tool._meta.securitySchemes.flatMap((s:any)=>s.scopes);
      expect(scopes.includes(WRITE_SCOPE),name).toBe(!tool.annotations.readOnlyHint);
      if(!tool.annotations.readOnlyHint&&!('requestId' in (tool.inputSchema?.shape??{})))withoutRequestId.push(name);
    }
    expect(withoutRequestId.sort()).toEqual([...LEGACY_WITHOUT_REQUEST_ID].sort());
    const legacy=names.filter(n=>!DOMAIN_TOOLS.some(d=>d.name===n));
    expect(()=>registerTools(capture().server,DOMAIN_TOOLS,{reserved:legacy})).not.toThrow();
  });
  it('every registry write definition requires egc:write and a request ID at the HTTP boundary',()=>{
    for(const def of DOMAIN_TOOLS){
      expect(requiredToolScope(def.name)).toBe(def.policy.readOnly?READ_SCOPE:WRITE_SCOPE);
      expect(REGISTRY_WRITE_TOOLS.has(def.name)).toBe(!def.policy.readOnly);
      if(!def.policy.readOnly)expect(def.input.shape.requestId.safeParse(undefined).success).toBe(false);
    }
    expect([...REGISTRY_WRITE_TOOLS].every(name=>WRITE_TOOLS.has(name))).toBe(true);
    for(const name of ['actions.propose','egc.generate_brief','actions.reconcile_inbound'])expect(requiredToolScope(name)).toBe(WRITE_SCOPE);
  });
  it('a registry name that collides with a legacy tool cannot be registered on the real server',()=>{
    const server=buildServer();
    expect(()=>registerTools(server,[defineTool({...spec('read'),name:'contacts.search'})])).toThrow(/already registered/);
  });
});

describe('invokeTool enforcement',()=>{
  it('requires the verified principal before running any handler',async()=>{
    const def=defineTool(spec('read'));
    expect(payload(await as(null,()=>invokeTool(def,{value:'x'})))).toEqual({error:'verified_principal_required'});
    expect(def.handler).not.toHaveBeenCalled();
  });
  it('owner-only tools refuse the static service grant',async()=>{
    const def=defineTool(spec('read',{ownerOnly:true}));
    expect(payload(await as(service,()=>invokeTool(def,{value:'x'})))).toMatchObject({error:'owner_grant_required'});
    expect(def.handler).not.toHaveBeenCalled();
    expect(payload(await as(owner,()=>invokeTool(def,{value:'x'},{now})))).toEqual({applied:'x'});
    expect(def.handler).toHaveBeenCalledWith({value:'x'},{actor:owner,now});
  });
  it('never echoes thrown provider text and sanitizes returned error details',async()=>{
    const thrown=defineTool(spec('read',{handler:()=>{throw new Error('Bearer secret-token for private@example.test');}}));
    const r=await as(service,()=>invokeTool(thrown,{value:'x'}));
    expect(r.isError).toBe(true);expect(payload(r)).toEqual({tool:'synthetic.read_tool',error:'tool_operation_failed'});
    expect(JSON.stringify(r)).not.toMatch(/secret-token|private@example/);
    const returned=defineTool(spec('write',{handler:()=>({error:'task_revision_conflict',currentRevision:4,token:'secret-token',message:'provider body',nested:{authorization:'x',kept:true}})}));
    const e=payload(await as(service,()=>invokeTool(returned,{requestId:REQUEST,value:'x'})));
    expect(e).toEqual({error:'task_revision_conflict',currentRevision:4,nested:{kept:true}});
  });
  // A write handler may have committed before it threw, so the caller must replay the same request instead of retrying blindly.
  it.each(['write','send'] as const)('a %s handler that throws reports an unknown outcome bound to the same requestId',async cls=>{
    const def=defineTool(spec(cls,{handler:vi.fn(()=>{throw new Error('Bearer secret-token for private@example.test');})}));
    const gate:ConfirmGate={issue:()=>null,verify:()=>true};
    const r=await as(owner,()=>invokeTool(def,{requestId:REQUEST,value:'x',...(cls==='send'?{confirmToken:'issued-token-0123456789'}:{})},{confirm:gate,now}));
    expect(def.handler).toHaveBeenCalledTimes(1);expect(r.isError).toBe(true);
    expect(payload(r)).toEqual({tool:def.name,requestId:REQUEST,retryMode:'same_request_id',instruction:'Retry with the identical requestId and arguments; do not create a new request.',error:'tool_outcome_unknown'});
    expect(JSON.stringify(r)).not.toMatch(/secret-token|private@example/);
  });
  it('a failure before any handler runs is not reported as an unknown outcome',async()=>{
    const def=defineTool(spec('send',{preview:()=>{throw new Error('provider down');}}));
    expect(payload(await as(owner,()=>invokeTool(def,{requestId:REQUEST,value:'x'},{now})))).toEqual({tool:def.name,error:'tool_operation_failed'});
    const verifyThrows=defineTool(spec('money'));
    const gate:ConfirmGate={issue:()=>null,verify:()=>{throw new Error('store down');}};
    expect(payload(await as(owner,()=>invokeTool(verifyThrows,{requestId:REQUEST,value:'x',confirmToken:'issued-token-0123456789'},{confirm:gate,now})))).toEqual({tool:verifyThrows.name,error:'tool_operation_failed'});
    expect(verifyThrows.handler).not.toHaveBeenCalled();
  });
  it('validates declared output before it leaves the server',async()=>{
    const def=defineTool(spec('read',{output:z.object({applied:z.number()}).strict()}));
    expect(payload(await as(service,()=>invokeTool(def,{value:'x'})))).toEqual({tool:def.name,error:'tool_output_invalid'});
    const {tools,server}=capture();registerTools(server,[def]);
    expect(tools.get(def.name)!.config.outputSchema.safeParse({result:{applied:1}}).success).toBe(true);
    // A write has already run when its output fails validation; only a same-request replay is safe.
    const write=defineTool(spec('write',{output:z.object({applied:z.number()}).strict()}));
    expect(payload(await as(service,()=>invokeTool(write,{requestId:REQUEST,value:'x'})))).toMatchObject({tool:write.name,requestId:REQUEST,retryMode:'same_request_id',error:'tool_outcome_unknown'});
  });
  it.each(['destructive','send','money'] as const)('%s previews first and never executes without a verified confirmation',async cls=>{
    const def=defineTool(spec(cls)),args={requestId:REQUEST,value:'x'};
    const preview=payload(await as(owner,()=>invokeTool(def,args,{now})));
    expect(preview).toMatchObject({requiresConfirmation:true,executed:false,tool:def.name,requestId:REQUEST,preview:{wouldApply:'x'},confirmation:'unavailable'});
    expect(def.handler).not.toHaveBeenCalled();
    const refused=await as(owner,()=>invokeTool(def,{...args,confirmToken:'forged-token-0123456789'},{now}));
    expect(payload(refused)).toMatchObject({error:'two_step_confirmation_unavailable',requestId:REQUEST});expect(def.handler).not.toHaveBeenCalled();
    const {tools,server}=capture();registerTools(server,[def]);expect(tools.get(def.name)!.config.annotations.destructiveHint).toBe(true);
  });
  it('an installed gate binds the confirmation to the exact input, actor and injected time',async()=>{
    const gate:ConfirmGate={issue:vi.fn(()=>({token:'issued-token-0123456789',expiresAt:'2026-09-22T12:05:00.000Z'})),verify:vi.fn(({token,input})=>token==='issued-token-0123456789'&&input.value==='x')};
    const def=defineTool(spec('send')),args={requestId:REQUEST,value:'x'};
    const preview=payload(await as(owner,()=>invokeTool(def,args,{confirm:gate,now})));
    expect(preview).toMatchObject({confirmToken:'issued-token-0123456789',expiresAt:'2026-09-22T12:05:00.000Z'});
    expect(gate.issue).toHaveBeenCalledWith({tool:def.name,input:args,actor:owner,preview:{wouldApply:'x'},now:NOW});
    expect(payload(await as(owner,()=>invokeTool(def,{...args,value:'y',confirmToken:'issued-token-0123456789'},{confirm:gate,now})))).toMatchObject({error:'confirmation_invalid_or_expired'});
    expect(def.handler).not.toHaveBeenCalled();
    expect(payload(await as(owner,()=>invokeTool(def,{...args,confirmToken:'issued-token-0123456789'},{confirm:gate,now})))).toEqual({applied:'x'});
    expect(def.handler).toHaveBeenCalledWith(args,{actor:owner,now});
    expect(gate.verify).toHaveBeenLastCalledWith({tool:def.name,input:args,actor:owner,token:'issued-token-0123456789',now:NOW});
  });
  it('a preview that reports an error is returned as an error, not a confirmable request',async()=>{
    const def=defineTool(spec('send',{preview:()=>({error:'contact_do_not_contact',phone:'+15555550100'})}));
    const r=await as(owner,()=>invokeTool(def,{requestId:REQUEST,value:'x'}));
    expect(r.isError).toBe(true);expect(payload(r)).toMatchObject({error:'contact_do_not_contact'});expect(payload(r).requiresConfirmation).toBeUndefined();
  });
});

describe('cursor pagination',()=>{
  const filters={status:'open',jobId:'3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b'};
  it('round-trips an offset bound to the tool and exact filters',()=>{
    const cursor=encodeCursor('tasks.list',filters,150);
    expect(decodeCursor(cursor,'tasks.list',{jobId:filters.jobId,status:'open'})).toBe(150);
    expect(decodeCursor(undefined,'tasks.list',filters)).toBe(0);
    expect(decodeCursor(cursor,'tasks.list',{...filters,ignored:undefined})).toBe(150);
  });
  it('rejects a tampered filterDigest, another query, another tool and malformed cursors',()=>{
    const cursor=encodeCursor('tasks.list',filters,50),raw=JSON.parse(Buffer.from(cursor,'base64url').toString());
    const tampered=Buffer.from(JSON.stringify({...raw,f:filterDigest('tasks.list',{status:'done'})})).toString('base64url');
    const code=(fn:()=>unknown)=>{try{fn();}catch(e){return (e as CursorError).code;}return 'accepted';};
    expect(code(()=>decodeCursor(tampered,'tasks.list',filters))).toBe('cursor_filter_mismatch');
    expect(code(()=>decodeCursor(cursor,'tasks.list',{...filters,status:'done'}))).toBe('cursor_filter_mismatch');
    expect(code(()=>decodeCursor(cursor,'jobs.list',filters))).toBe('cursor_filter_mismatch');
    for(const bad of ['%%%','bm90LWpzb24',Buffer.from(JSON.stringify({...raw,o:-1})).toString('base64url'),Buffer.from(JSON.stringify({...raw,v:2})).toString('base64url'),Buffer.from(JSON.stringify({...raw,f:'short'})).toString('base64url'),'a'.repeat(600)])
      expect(code(()=>decodeCursor(bad,'tasks.list',filters))).toBe('invalid_cursor');
  });
  it('builds the page envelope from limit+1 rows with injected time and explicit coverage',()=>{
    const rows=[1,2,3,4],first=pageOf({rows,limit:3,offset:0,tool:'tasks.list',filters,asOf:NOW,coverage:{complete:true}});
    expect(first).toMatchObject({items:[1,2,3],page:{limit:3,offset:0,returned:3},asOf:NOW.toISOString(),coverage:{complete:true}});
    expect(decodeCursor(first.page.nextCursor!,'tasks.list',filters)).toBe(3);
    const last=pageOf({rows:[4],limit:3,offset:3,tool:'tasks.list',filters,asOf:NOW,coverage:{complete:false,reason:'source_partial'},total:4});
    expect(last.page).toEqual({limit:3,offset:3,returned:1,nextCursor:null,total:4});expect(last.coverage.complete).toBe(false);
    expect(pageOf({rows:[],limit:3,offset:0,tool:'t.x',filters,asOf:NOW,coverage:{complete:true},total:9}).page.nextCursor).toBeNull();
    expect(z.object(pageFields).strict().parse({})).toEqual({limit:50});expect(z.object(pageFields).safeParse({limit:201}).success).toBe(false);
  });
  it('keyset cursors round-trip an exact microsecond position with the anchor and rows already returned, and stay under the cursor size limit',()=>{
    const after={key:'2026-09-22T11:59:59.999999Z',id:'ffffffff-ffff-4fff-bfff-ffffffffffff'},cursor=encodeKeysetCursor('tasks.list',filters,123_456,NOW,after);
    expect(readCursor(cursor,'tasks.list',filters,NOW)).toEqual({offset:123_456,anchor:NOW,after});
    expect(decodeCursor(cursor,'tasks.list',filters)).toBe(123_456);expect(cursor.length).toBeLessThanOrEqual(512);expect(pageFields.cursor.safeParse(cursor).success).toBe(true);
    expect(readCursor(encodeCursor('tasks.list',filters,4,NOW),'tasks.list',filters,NOW)).toEqual({offset:4,anchor:NOW});
    const code=(fn:()=>unknown)=>{try{fn();}catch(e){return (e as CursorError).code;}return 'accepted';};
    expect(code(()=>readCursor(cursor,'tasks.list',{...filters,status:'done'},NOW))).toBe('cursor_filter_mismatch');
    const raw=JSON.parse(Buffer.from(cursor,'base64url').toString()),forged=(patch:Record<string,unknown>)=>Buffer.from(JSON.stringify({...raw,...patch})).toString('base64url');
    for(const patch of [{a:undefined},{k:undefined},{k:[after.key]},{k:[after.key,after.id,'x']},{k:['2026-09-22T11:59:59.999Z',after.id]},{k:['2026-09-31T00:00:00.000000Z',after.id]},{k:['2026-13-01T00:00:00.000000Z',after.id]},{k:[after.key,'not-a-uuid']},{k:[after.key,after.id.toUpperCase()]},{k:{0:after.key,1:after.id}},{v:3}])
      expect(code(()=>readCursor(forged(patch),'tasks.list',filters,NOW)),JSON.stringify(patch)).toBe('invalid_cursor');
    // An offset cursor never carries a position.
    expect(code(()=>readCursor(Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(encodeCursor('tasks.list',filters,4,NOW),'base64url').toString()),k:[after.key,after.id]})).toString('base64url'),'tasks.list',filters,NOW))).toBe('invalid_cursor');
  });
  it('pageOf with keyOf continues after the last returned row, anchored to asOf, and falls back to an offset cursor when that row has no usable position',()=>{
    const rows=[{id:'a',key:'2026-09-22T11:00:00.000003Z'},{id:'b',key:'2026-09-22T11:00:00.000002Z'},{id:'c',key:'2026-09-22T11:00:00.000001Z'}];
    const uuid=(c:string)=>`${c.repeat(8)}-0000-4000-8000-000000000000`,keyOf=(row:{id:string;key:string})=>keysetOf(row.key,uuid(row.id));
    const page=pageOf({rows,limit:2,offset:10,tool:'tasks.list',filters,asOf:NOW,coverage:{complete:true},keyOf});
    expect(page.items).toEqual(rows.slice(0,2));expect(readCursor(page.page.nextCursor!,'tasks.list',filters,NOW)).toEqual({offset:12,anchor:NOW,after:{key:rows[1]!.key,id:uuid('b')}});
    expect(pageOf({rows:rows.slice(0,2),limit:2,offset:0,tool:'tasks.list',filters,asOf:NOW,coverage:{complete:true},keyOf}).page.nextCursor).toBeNull();
    const fallback=pageOf({rows,limit:2,offset:10,tool:'tasks.list',filters,asOf:NOW,anchor:NOW,coverage:{complete:true},keyOf:()=>undefined});
    expect(readCursor(fallback.page.nextCursor!,'tasks.list',filters,NOW)).toEqual({offset:12,anchor:NOW});
    for(const [key,id] of [[null,uuid('a')],['2026-09-22T11:00:00.000001+00',uuid('a')],['2026-09-22T11:00:00.000001Z',null],['infinity',uuid('a')]])expect(keysetOf(key,id),String(key)).toBeUndefined();
  });
});

describe('result helpers',()=>{
  it('keep payload shape and sanitize error codes and details',async()=>{
    expect(result({ok:true})).toEqual({content:[{type:'text',text:JSON.stringify({ok:true},null,2)}],structuredContent:{result:{ok:true}}});
    expect(payload(error('Provider exploded: token=abc'))).toEqual({error:'tool_operation_failed'});
    expect(payload(error('x_y',{error:'override',password:'p',note:'n'.repeat(900)})).note).toHaveLength(501);
    expect(payload(error('x_y',{error:'override'})).error).toBe('x_y');
    expect(payload(error('x_y',{accessToken:'a',Body:'b',response:{},headers:{},messageId:'m-1',withdrawalCents:500,operationId:'op'}))).toEqual({messageId:'m-1',withdrawalCents:500,operationId:'op',error:'x_y'});
    expect(payload(await guarded(async()=>{throw new Error('secret');},'meta_conversion_operation_failed'))).toEqual({error:'meta_conversion_operation_failed'});
  });
});

describe('egc.safety_policy',()=>{
  const call=async(operations:boolean)=>{const tool=built(operations)['egc.safety_policy'];return payload(await as(service,()=>tool.handler({})));};
  it('reports blocked one-step sends and disabled legacy writes in operations mode',async()=>{
    const policy=await call(true);
    expect(policy).toMatchObject({mode:'action_center',customerSends:{oneStepMcpSends:'blocked',tools:['conversations.send_message','send_sms','egc.send_followup']}});
    expect(policy.legacyWritesDisabled).toContain('appointments.delete');expect(policy.access.sends).toMatch(/One-step MCP customer sends are paused/);
    expect(policy.customerSends.alternative).toMatch(/approval does not send.*is enabled on this server yet/);expect(policy.customerSends.alternative).not.toMatch(/sends? (?:it|them) from the Employee Hub/);
    expect(policy.registry).toContainEqual({name:'egc.safety_policy',class:'read',scope:READ_SCOPE,requestIdRequired:false,twoStep:false,ownerOnly:false});
    process.env.EGC_MCP_DIRECT_SENDS_ENABLED='true';expect((await call(true)).customerSends.oneStepMcpSends).toBe('enabled');
  });
  it('reports legacy mode truthfully',async()=>{
    const policy=await call(false);expect(policy).toMatchObject({mode:'legacy',customerSends:{oneStepMcpSends:'enabled'},legacyWritesDisabled:[]});
    expect(policy.access.payments).toBe('No payment, charge or refund tool is provided.');
  });
});
