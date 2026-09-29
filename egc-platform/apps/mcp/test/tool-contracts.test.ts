import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHmac} from 'node:crypto';
import {getTableName,isTable,type Table} from 'drizzle-orm';

// The full server is built through a capturing McpServer; the database runs on a fake postgres driver, workspace
// services and the GHL client are recorded, and bridge calls are decoded from the signed envelope sent over fetch.
const state=vi.hoisted(()=>({captured:new Map<string,{config:any;handler:(args:unknown)=>Promise<any>}>(),effects:[] as Record<string,any>[],rows:{} as Record<string,Record<string,unknown>[]>,db:undefined as any}));
const {AT,recorder}=vi.hoisted(()=>({AT:'2026-09-22T12:00:00.000Z',
  recorder:(service:string,values:Record<string,unknown>)=>Object.fromEntries(Object.entries(values).map(([name,value])=>[name,vi.fn(async()=>{state.effects.push({kind:'service',name:`${service}.${name}`});return typeof value==='function'?value():value;})]))}));
vi.mock('@modelcontextprotocol/server',async importOriginal=>{
  const actual=await importOriginal<Record<string,unknown>>();
  class McpServer{registerTool(name:string,config:unknown,handler:any){if(state.captured.has(name))throw new Error(`Tool ${name} is already registered`);state.captured.set(name,{config,handler});}}
  return {...actual,McpServer};
});
vi.mock('@egc/database',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),getDb:()=>state.db}));
vi.mock('@egc/customer-state',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),...recorder('customer-state',{
  getCanonicalReport:()=>({period:{since:AT,until:AT},periodActivity:{},cohort:{denominator:0,window:{since:AT,until:AT},metrics:{}},customers:[],pipelines:{walkthrough:[],videoQuote:[],directJob:[]},countedEvents:[],confirmedOutcomesWithUnknownTime:[],reviewRequiredEvents:[],coverage:{complete:true},soldRevenue:{valueCents:null},collectedRevenue:{valueCents:null},authority:'canonical_customer_event_ledger'}),
  getOperationalEventEvidence:{events:[]},getCustomerTimeline:{customer:null,coverage:{complete:false}},getCustomerStateDiagnostics:[],reconcileCustomerState:{ok:true},recordUserConfirmedOutcome:{ok:true}})}));
vi.mock('@egc/lead-audit',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),...recorder('lead-audit',{leadsNeedingContact:[],leadsNotResponding:[],recentBookings:[],callTranscriptsForContact:[],recomputeLeadState:undefined})}));
vi.mock('@egc/meta-conversions',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),...recorder('meta-conversions',{previewConversions:{},syncConversions:{},conversionStatus:{},retryConversions:{},sendTestEvent:{}})}));

import {schema} from '@egc/database';
import {GhlClient} from '@egc/ghl';
import {WRITE_COMMANDS} from '@egc/operations';
import {buildServer} from '../src/server.js';
import {blockedToolCall,DIRECT_SEND_TOOLS,operationsPrincipal} from '../src/operations.js';
import {requiredToolScope} from '../src/tool-access.js';
import {DOMAIN_TOOLS} from '../src/tools/index.js';
import {TWO_STEP_CLASSES} from '../src/tools/define.js';
import {READ_SCOPE,WRITE_SCOPE} from '../src/oauth.js';
import {classify,dbRow,sqlDriver,type Statement} from './fixtures/sql-driver.js';
import {LEGACY_ONE_STEP,TOOL_CONTRACTS,type Effect,type ModeContract,type ToolContract} from './fixtures/tool-contracts.js';

type Mode='legacy'|'operations';
const SECRET='isolated-contract-test-signing-secret-0123456789';
const actor={id:'mcp-oauth-grant:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b',role:'integration' as const,kind:'integration' as const,workspace:'egc'};
const TABLES=new Map<string,Table>((Object.values(schema) as unknown[]).filter((value):value is Table=>isTable(value)).map(table=>[getTableName(table),table]));
// Service functions that change stored or external state; a read tool must never reach them.
// recording.retry requeues processing; recording.list and recording.get only read.
const RECORDING_WRITES=new Set(['recording.retry']);
const mutates=(call:Record<string,any>)=>call.kind==='bridge'?WRITE_COMMANDS.has(call.name):RECORDING_WRITES.has(call.name);
const MUTATING_SERVICES=new Set(['customer-state.reconcileCustomerState','customer-state.recordUserConfirmedOutcome','meta-conversions.syncConversions','meta-conversions.retryConversions','meta-conversions.sendTestEvent','lead-audit.recomputeLeadState']);
// A read may only select. Anything the fake driver cannot classify counts as a write unless it is a session setting or a show.
const READ_ONLY_OTHER=/^\s*(set|show)\b/i;
const writesOf=(statements:Pick<Statement,'sql'|'op'|'table'>[])=>statements.filter(s=>s.op!=='select'&&!(s.op==='other'&&READ_ONLY_OTHER.test(s.sql))).map(s=>`${s.op} ${s.table??s.sql.trim().split(/\s+/,2).join(' ')}`);
// Writing the send ledger or calling the provider's send is a customer send, whatever class a fixture claims.
const sendsToCustomer=(run:{statements:Statement[];provider:string[]})=>run.statements.some(s=>s.op==='insert'&&s.table==='communication_executions')||run.provider.includes('sendMessage');
const GHL_RESPONSES:Record<string,unknown>={getContact:{contact:{id:'synthetic-ghl-contact',phone:'+15555550100',email:'synthetic@example.test'}},getCalendars:{calendars:[]},getLocation:{location:{}}};
const env={...process.env};
let driver:ReturnType<typeof sqlDriver>;

function build(mode:Mode){
  process.env.EGC_OPERATIONS_ENABLED=String(mode==='operations');
  state.captured.clear();buildServer({now:()=>new Date(AT)});return new Map(state.captured);
}
function contractFor(name:string,mode:Mode):ToolContract&ModeContract{
  const base=TOOL_CONTRACTS[name];if(!base)throw new Error(`missing contract for registered tool ${name}`);
  const override=base[mode]??{};
  const bridged='bridge' in base.effect||'recordings' in base.effect;
  // With unified operations disabled no bridge request is made; the tool reports that instead.
  const effect=override.effect??(mode==='legacy'&&bridged?{refused:'operations_not_enabled'}:base.effect);
  return {...base,...override,effect};
}
function decodeEnvelope(body:unknown){
  const envelope=String(JSON.parse(String(body)).envelope),[payload,signature]=envelope.split('.');
  expect(signature).toBe(createHmac('sha256',SECRET).update(payload!).digest('base64url'));
  return JSON.parse(Buffer.from(payload!,'base64url').toString('utf8'));
}
async function exercise(tool:{config:any;handler:(args:unknown)=>Promise<any>},contract:ToolContract&ModeContract){
  state.effects.length=0;state.rows=contract.rows??{};driver.log.length=0;
  let result:any,thrown=false;
  try{result=await operationsPrincipal.run(actor,()=>tool.handler(tool.config.inputSchema.parse(contract.valid)));}catch{thrown=true;}
  const statements=[...driver.log],effects=[...state.effects];
  return {result:result?.structuredContent?.result,thrown,statements,effects,
    bridge:effects.filter(e=>e.kind==='bridge'||e.kind==='recordings'),provider:effects.filter(e=>e.kind==='provider').map(e=>e.name),service:effects.filter(e=>e.kind==='service').map(e=>e.name)};
}
// Soft assertions so one run lists every tool that disagrees with its contract.
function expectEffect(name:string,effect:Effect,run:Awaited<ReturnType<typeof exercise>>){
  const where=`${name}: ${JSON.stringify(effect)} observed ${JSON.stringify({db:run.statements.map(s=>`${s.op} ${s.table}`),bridge:run.bridge.map(b=>b.name),provider:run.provider,service:run.service,result:run.result})}`;
  if('none' in effect){expect.soft(run.statements,where).toEqual([]);expect.soft(run.effects,where).toEqual([]);expect.soft(run.thrown||Boolean(run.result?.error),where).toBe(false);}
  // A refusal may read to decide, but it writes nothing and calls no bridge, provider or service.
  else if('refused' in effect){expect.soft(run.result?.error,where).toBe(effect.refused);expect.soft(run.statements.filter(s=>s.op!=='select'),where).toEqual([]);expect.soft(run.effects,where).toEqual([]);}
  else if('bridge' in effect||'recordings' in effect){
    const kind='bridge' in effect?'bridge':'recordings',command='bridge' in effect?effect.bridge:effect.recordings;
    const call=run.bridge.find(b=>b.kind===kind&&b.name===command);
    expect.soft(call,where).toBeDefined();
    expect.soft(call).toMatchObject({iss:'mcp',aud:kind==='bridge'?'egc-operations':'egc-recordings',actor:actor.id});
  }
  else if('db' in effect)expect.soft(run.statements.some(s=>s.op===effect.db&&s.table===effect.table),where).toBe(true);
  else if('provider' in effect)expect.soft(run.provider,where).toContain(effect.provider);
  else expect.soft(run.service,where).toContain(effect.service);
}

beforeAll(()=>{
  // Registry tools get the clock through buildServer; legacy handlers read Date directly, so Date alone is pinned too.
  vi.useFakeTimers({toFake:['Date'],now:new Date(AT)});
  for(const key of ['EGC_MCP_DIRECT_SENDS_ENABLED','MCP_BEARER_WRITE_ENABLED','GHL_WRITEBACK_ENABLED','GHL_WALKTHROUGH_CALENDAR_ID','GHL_JOBS_CALENDAR_ID','EGC_OPERATIONS_INBOUND_TASKS_ENABLED'])delete process.env[key];
  Object.assign(process.env,{EGC_OPERATIONS_API_ORIGIN:'https://operations.example.test',EGC_OPERATIONS_MCP_SIGNING_SECRET:SECRET});
  driver=sqlDriver(statement=>{
    const rows=statement.op==='select'&&statement.table?state.rows[statement.table]:undefined;
    return rows?rows.map(values=>dbRow(TABLES.get(statement.table!)!,values)):[];
  });
  state.db=driver.db;
  vi.spyOn(GhlClient,'fromEnv').mockImplementation(()=>new Proxy({},{get:(_target,prop)=>{
    if(prop==='locationId')return 'synthetic-location';
    if(typeof prop!=='string'||prop==='then')return undefined;
    return async()=>{state.effects.push({kind:'provider',name:prop});return GHL_RESPONSES[prop]??{};};
  }}) as never);
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL,init?:RequestInit)=>{
    const url=new URL(String(input)),claims=decodeEnvelope(init?.body);
    state.effects.push({kind:url.pathname==='/operations/rpc'?'bridge':url.pathname==='/recordings/rpc'?'recordings':'unexpected',name:claims.request.body.command,iss:claims.iss,aud:claims.aud,actor:claims.actor.id});
    return Response.json({ok:true,authority:'employee_hub',items:[],total:0,nextOffset:null,coverage:{complete:true}});
  }));
});
afterAll(()=>{process.env={...env};vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('per-tool contract gate',()=>{
  it('every registered tool has exactly one contract and every contract names a registered tool',()=>{
    const legacy=build('legacy'),operations=build('operations');
    const registered=new Set([...legacy.keys(),...operations.keys()]);
    expect([...registered].filter(name=>!TOOL_CONTRACTS[name]),'registered tools without a contract').toEqual([]);
    expect(Object.keys(TOOL_CONTRACTS).filter(name=>!registered.has(name)),'contracts for tools that are not registered').toEqual([]);
    expect(registered.size).toBe(Object.keys(TOOL_CONTRACTS).length);
  });
  it('legacy one-step exceptions are exactly the registered send/destructive tools without a confirmation path',()=>{
    const unconfirmed=Object.entries(TOOL_CONTRACTS).filter(([,c])=>TWO_STEP_CLASSES.has(c.class)&&!c.twoStep).map(([name])=>name);
    expect(unconfirmed.sort()).toEqual([...LEGACY_ONE_STEP].sort());
    for(const name of LEGACY_ONE_STEP)expect(DOMAIN_TOOLS.some(def=>def.name===name),name).toBe(false);
    // The one-step list cannot be bypassed by labelling a direct send as a plain write.
    for(const name of DIRECT_SEND_TOOLS)expect(TOOL_CONTRACTS[name]?.class,name).toBe('send');
  });
  it('the read gate counts data-modifying CTEs and unclassified statements as writes',()=>{
    const statement=(sql:string)=>({sql,...classify(sql)});
    expect(writesOf([
      statement('select "jobs"."id" from "jobs" where "jobs"."status" = $1 limit $2'),statement('select 1 from "leads" where "leads"."updated_at" > $1 limit $2'),
      statement('(select "id" from "jobs") union (select "id" from "tasks")'),statement('with "recent" as (select "id" from "jobs") select * from "recent"'),statement('select now()'),
      statement('set client_min_messages to warning'),statement('show server_version')
    ])).toEqual([]);
    expect(writesOf([
      statement('with "moved" as (insert into "tasks" ("title") values ($1) returning "id") select * from "moved"'),
      statement('with "x" as (update "jobs" set "status" = $1 returning "id") select 1'),statement('with "x" as (delete from "leads" returning "id") select 1'),
      statement('merge into "jobs" using "staging" on true when matched then update set "status" = $1'),statement('truncate "jobs"'),statement('call refresh_jobs()')
    ])).toEqual(['insert tasks','update jobs','delete leads','other merge into','other truncate "jobs"','other call refresh_jobs()']);
  });
  for(const mode of ['legacy','operations'] as const){
    describe(`${mode} mode`,()=>{
      let tools:Map<string,{config:any;handler:(args:unknown)=>Promise<any>}>;
      beforeAll(()=>{tools=build(mode);});
      it('annotations, OAuth scopes, class and two-step path agree with tool-access and the registry',()=>{
        for(const [name,tool] of tools){
          const contract=contractFor(name,mode),{config}=tool,def=DOMAIN_TOOLS.find(d=>d.name===name);
          expect.soft(contract.scope,name).toBe(contract.class==='read'?READ_SCOPE:WRITE_SCOPE);
          expect.soft(requiredToolScope(name),name).toBe(contract.scope);
          expect.soft(config.annotations.readOnlyHint,name).toBe(contract.class==='read');
          const scopes=config._meta.securitySchemes.flatMap((scheme:{scopes:string[]})=>scheme.scopes);
          expect.soft(scopes.includes(WRITE_SCOPE),name).toBe(contract.scope===WRITE_SCOPE);expect.soft(scopes.includes(READ_SCOPE),name).toBe(true);
          expect.soft(Boolean(config.annotations.destructiveHint),name).toBe(def?TWO_STEP_CLASSES.has(contract.class):contract.class==='destructive');
          expect.soft('confirmToken' in (config.inputSchema.shape??{}),name).toBe(contract.twoStep);
          if(def)expect.soft({class:def.policy.class,twoStep:def.policy.twoStep},name).toEqual({class:contract.class,twoStep:contract.twoStep});
        }
      });
      it('valid inputs parse and invalid inputs are rejected by the registered schema',()=>{
        for(const [name,tool] of tools){
          const contract=contractFor(name,mode);
          expect.soft(tool.config.inputSchema.safeParse(contract.valid).success,`${name} valid ${JSON.stringify(contract.valid)}`).toBe(true);
          expect.soft(tool.config.inputSchema.safeParse(contract.invalid).success,`${name} invalid ${JSON.stringify(contract.invalid)}`).toBe(false);
        }
      });
      it('the HTTP gate blocks exactly the contracted tools',()=>{
        for(const name of tools.keys())expect.soft(blockedToolCall(name)?.error??null,name).toBe(mode==='operations'?contractFor(name,mode).blocked??null:null);
      });
      it('a valid call reaches the contracted bridge command, database statement, provider or service, and reads never write',async()=>{
        for(const [name,tool] of tools){
          const contract=contractFor(name,mode);
          // Tools refused at the HTTP boundary never reach their handler unless the contract pins the handler's own refusal.
          if(contract.blocked&&!contract[mode]?.effect)continue;
          const run=await exercise(tool,contract);
          expectEffect(name,contract.effect,run);
          if(typeof run.result?.asOf==='string')expect.soft(run.result.asOf,`${name} asOf comes from the fixed clock`).toBe(AT);
          if(contract.class==='read'){
            expect.soft(writesOf(run.statements),`${name} wrote to the database`).toEqual([]);
            expect.soft(run.bridge.filter(mutates).map(b=>b.name),`${name} sent a bridge write`).toEqual([]);
            expect.soft(run.provider.filter(m=>!/^(get|search|list)/.test(m)),`${name} called a provider mutation`).toEqual([]);
            expect.soft(run.service.filter(s=>MUTATING_SERVICES.has(s)),`${name} called a mutating service`).toEqual([]);
          }else if(run.bridge.length)expect.soft(run.bridge.some(mutates),`${name} is a write but bridged only reads`).toBe(true);
          if(sendsToCustomer(run))expect.soft(contract.class,`${name} sends to a customer`).toBe('send');
          expect.soft(run.bridge.filter(b=>b.kind==='unexpected'),name).toEqual([]);
        }
      });
    });
  }
});
