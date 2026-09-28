import {afterEach,describe,expect,it,vi} from 'vitest';
import * as z from 'zod/v4';
import type {McpServer} from '@modelcontextprotocol/server';
import {schema} from '@egc/database';
import {crmReadTools} from '../src/tools/domains/crm-reads.js';
import {registerTools} from '../src/tools/define.js';
import {CURSOR_CLOCK_SKEW_MS,CURSOR_MAX_AGE_MS,decodeCursor,encodeCursor,readCursor} from '../src/tools/pagination.js';
import {DOMAIN_TOOLS} from '../src/tools/index.js';
import {requiredToolScope} from '../src/tool-access.js';
import {operationsPrincipal} from '../src/operations.js';
import {READ_SCOPE} from '../src/oauth.js';
import {buildServer} from '../src/server.js';
import {dbRow,limitOffset,sqlDriver,type Respond,type Statement} from './fixtures/sql-driver.js';

const env={...process.env};afterEach(()=>{process.env={...env};vi.restoreAllMocks();});
const NOW=new Date('2026-09-22T12:00:00.000Z'),now=()=>NOW,HOUR=3_600_000,DAY=24*HOUR;
const actor={id:'mcp-oauth-grant:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b',role:'integration' as const,kind:'integration' as const,workspace:'egc'};
const CONTACT='3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b',OTHER='ac178de9-8156-42b8-818c-83e21c12c099';
const id=(n:number,p='a')=>`${p.repeat(8)}-0000-4000-8000-${String(n).padStart(12,'0')}`;
const iso=(ms:number)=>new Date(ms).toISOString();
const LEGACY_READS=['contacts.search','contacts.get','leads.search','leads.get','conversations.search','conversations.get','calls.search','calls.get','opportunities.search','opportunities.get','appointments.search','jobs.search','jobs.get','tasks.search','walkthroughs.search','walkthroughs.get'];
type Registered={config:any;handler:(args:unknown)=>Promise<any>};

function harness(respond:Respond=()=>[],timeline=vi.fn(async({contactId}:{contactId:string})=>({contactId,customer:{state:'JOB_SOLD'},coverage:{complete:true}})),clock:()=>Date=now){
  const driver=sqlDriver(respond),tools=new Map<string,Registered>();
  registerTools({registerTool:(name:string,config:unknown,handler:any)=>tools.set(name,{config,handler})} as unknown as McpServer,crmReadTools({db:()=>driver.db,timeline:timeline as never}),{now:()=>clock()});
  // Parse like the SDK does before the registry handler runs.
  const raw=async(name:string,args:Record<string,unknown>={})=>{const t=tools.get(name)!;return operationsPrincipal.run(actor,()=>t.handler(t.config.inputSchema.parse(args)));};
  const call=async(name:string,args:Record<string,unknown>={})=>(await raw(name,args)).structuredContent.result as Record<string,any>;
  return {...driver,tools,raw,call,timeline};
}
const flat=(sql:string)=>sql.replace(/\s+/g,' ');
// The change probe a later page runs after its read; the page statement itself never selects a bare 1.
const isProbe=(s:Statement)=>/^select 1 from /.test(s.sql);

// One dataset per paged read, in the order the SQL would return it; the fake answers each query with its own LIMIT/OFFSET slice.
type Walk={name:string;args:Record<string,unknown>;table:string;row:(i:number)=>Record<string,unknown>;key:(item:any)=>string;page?:(r:any)=>any;limitKey?:string;extra?:Respond};
const WALKS:Walk[]=[
  {name:'contacts.search',args:{},table:'contacts',row:i=>dbRow(schema.contacts,{id:id(i),providerId:`p-${i}`,name:`Synthetic ${i}`}),key:x=>x.id},
  {name:'leads.search',args:{},table:'leads',row:i=>({...dbRow(schema.leads,{id:id(i),contactId:id(i,'b'),currentState:'NEVER_CONTACTED',createdAt:iso(NOW.valueOf()-i*1000)}),...dbRow(schema.contacts,{id:id(i,'b'),providerId:`p-${i}`})}),key:x=>x.lead.id},
  {name:'conversations.search',args:{contactId:CONTACT},table:'conversations',row:i=>dbRow(schema.conversations,{id:id(i),providerId:`c-${i}`,contactId:CONTACT}),key:x=>x.id},
  {name:'conversations.get',args:{conversationId:CONTACT},table:'messages',limitKey:'messageLimit',page:r=>r.messages,row:i=>dbRow(schema.messages,{id:id(i),providerId:`m-${i}`,conversationId:CONTACT,contactId:OTHER,type:'TYPE_SMS',direction:'inbound',occurredAt:iso(NOW.valueOf())}),key:x=>x.id,
    extra:s=>s.table==='conversations'?[dbRow(schema.conversations,{id:CONTACT,providerId:'conversation',contactId:OTHER})]:undefined},
  {name:'calls.search',args:{},table:'calls',row:i=>({...dbRow(schema.calls,{id:id(i),providerMessageId:`call-${i}`,contactId:OTHER,direction:'inbound',startedAt:iso(NOW.valueOf())}),...dbRow(schema.contacts,{name:`Caller ${i}`,phone:'+15555550100'})}),key:x=>x.call.id},
  {name:'opportunities.search',args:{},table:'opportunities',row:i=>dbRow(schema.opportunities,{id:id(i),providerId:`o-${i}`,contactId:OTHER}),key:x=>x.id},
  {name:'appointments.search',args:{},table:'appointments',row:i=>dbRow(schema.appointments,{id:id(i),providerId:`a-${i}`,contactId:OTHER,status:'new',appointmentStartAt:iso(NOW.valueOf())}),key:x=>x.id},
  {name:'jobs.search',args:{},table:'jobs',row:i=>dbRow(schema.jobs,{id:id(i),contactId:OTHER,status:'scheduled'}),key:x=>x.id},
  {name:'tasks.search',args:{},table:'tasks',row:i=>dbRow(schema.tasks,{id:id(i),title:`Task ${i}`}),key:x=>x.id},
  {name:'walkthroughs.search',args:{},table:'walkthroughs',row:i=>dbRow(schema.walkthroughs,{id:id(i),status:'draft'}),key:x=>x.id}
];
function slicer(walk:Walk,count:number):Respond{
  const rows=Array.from({length:count},(_,i)=>walk.row(i));
  return s=>{const extra=walk.extra?.(s);if(extra)return extra;if(s.table!==walk.table||isProbe(s))return [];const page=limitOffset(s);return page?rows.slice(page.offset,page.offset+page.limit):rows;};
}
// The clock moves on by step between pages, as it does between real calls.
async function walkAll(walk:Walk,count:number,size:number,step=0,respond:Respond=slicer(walk,count)){
  let clock=NOW.valueOf();
  const h=harness(respond,undefined,()=>new Date(clock)),keys:string[]=[],pages:any[]=[];let cursor:string|null|undefined;
  do{const r=await h.call(walk.name,{...walk.args,[walk.limitKey??'limit']:size,...(cursor?{cursor}:{})});const page=walk.page?walk.page(r):r;pages.push(page);keys.push(...page.items.map(walk.key));cursor=page.page.nextCursor;clock+=step;}while(cursor&&pages.length<20);
  const log=h.log.filter(s=>s.table===walk.table);
  return {keys,pages,log:log.filter(s=>!isProbe(s)),probes:log.filter(isProbe)};
}

describe('legacy CRM reads on the registry',()=>{
  it('keeps every legacy name, registered exactly once per mode as a read-scoped registry tool with a strict input',()=>{
    expect(crmReadTools().map(def=>def.name).sort()).toEqual([...LEGACY_READS].sort());
    for(const def of crmReadTools())expect(def.policy).toMatchObject({class:'read',readOnly:true,scope:READ_SCOPE,twoStep:false,requiresRequestId:false});
    for(const operations of [false,true]){
      process.env.EGC_OPERATIONS_ENABLED=String(operations);
      const registered=(buildServer({now}) as unknown as {_registeredTools:Record<string,any>})._registeredTools;
      for(const name of LEGACY_READS){
        const tool=registered[name];
        expect(tool,name).toBeDefined();expect(DOMAIN_TOOLS.filter(def=>def.name===name)).toHaveLength(1);
        expect(tool.annotations).toEqual({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
        expect(requiredToolScope(name)).toBe(READ_SCOPE);expect(tool._meta.securitySchemes).toEqual([{type:'oauth2',scopes:[READ_SCOPE]}]);
        expect(z.toJSONSchema(tool.inputSchema)).toMatchObject({additionalProperties:false});
      }
    }
  });
  it('accepts every legacy input with its original defaults and maximums, adds an optional cursor and rejects unknown keys',()=>{
    const inputs=Object.fromEntries(crmReadTools().map(def=>[def.name,def.input]));
    const accepted:[string,Record<string,unknown>,Record<string,unknown>][]=[
      ['contacts.search',{},{query:'',limit:50}],['contacts.search',{query:'  Jane  ',limit:200},{query:'Jane',limit:200}],
      ['contacts.get',{contactId:CONTACT},{contactId:CONTACT}],
      ['leads.search',{},{days:30,limit:100}],['leads.search',{state:'BOOKED',days:365,limit:500},{state:'BOOKED',days:365,limit:500}],['leads.search',{state:'JOB_SOLD'},{state:'JOB_SOLD',days:30,limit:100}],
      ['leads.get',{leadId:CONTACT},{leadId:CONTACT}],
      ['conversations.search',{contactId:CONTACT},{contactId:CONTACT,limit:50}],['conversations.search',{contactId:CONTACT,limit:200},{contactId:CONTACT,limit:200}],
      ['conversations.get',{conversationId:CONTACT},{conversationId:CONTACT,messageLimit:100}],['conversations.get',{conversationId:CONTACT,messageLimit:500},{conversationId:CONTACT,messageLimit:500}],
      ['calls.search',{},{days:30,limit:100}],['calls.search',{contactId:CONTACT,days:365,limit:500},{contactId:CONTACT,days:365,limit:500}],
      ['calls.get',{callId:CONTACT},{callId:CONTACT}],
      ['opportunities.search',{},{limit:100}],['opportunities.search',{contactId:CONTACT,status:'open',limit:500},{contactId:CONTACT,status:'open',limit:500}],
      ['opportunities.get',{opportunityId:CONTACT},{opportunityId:CONTACT}],
      ['appointments.search',{},{daysPast:30,daysFuture:90,limit:200}],['appointments.search',{contactId:CONTACT,daysPast:0,daysFuture:730,limit:500},{contactId:CONTACT,daysPast:0,daysFuture:730,limit:500}],
      ['jobs.search',{},{limit:100}],['jobs.search',{contactId:CONTACT,status:'scheduled',limit:500},{contactId:CONTACT,status:'scheduled',limit:500}],
      ['jobs.get',{jobId:CONTACT},{jobId:CONTACT}],
      ['tasks.search',{},{limit:100}],
      ['tasks.search',{status:'blocked',priority:'urgent',assignedUserId:'user-1',contactId:CONTACT,jobId:OTHER,opportunityId:CONTACT,dueBefore:'2026-10-01T00:00:00Z',dueAfter:'2026-09-01T00:00:00-06:00',limit:200},
        {status:'blocked',priority:'urgent',assignedUserId:'user-1',contactId:CONTACT,jobId:OTHER,opportunityId:CONTACT,dueBefore:'2026-10-01T00:00:00Z',dueAfter:'2026-09-01T00:00:00-06:00',limit:200}],
      ['walkthroughs.search',{},{limit:100}],['walkthroughs.search',{contactId:CONTACT,status:'draft',limit:500},{contactId:CONTACT,status:'draft',limit:500}],
      ['walkthroughs.get',{walkthroughId:CONTACT},{walkthroughId:CONTACT}]
    ];
    for(const [name,input,parsed] of accepted){
      expect(inputs[name]!.parse(input),`${name} ${JSON.stringify(input)}`).toEqual(parsed);
      if(name.endsWith('.search')||name==='conversations.get')expect(inputs[name]!.parse({...input,cursor:'opaque-cursor'}).cursor).toBe('opaque-cursor');
    }
    const rejected:[string,Record<string,unknown>][]=[
      ['contacts.search',{limit:201}],['leads.search',{limit:501}],['leads.search',{state:'SOMETHING_ELSE'}],['leads.search',{days:366}],['conversations.search',{}],['conversations.search',{contactId:CONTACT,limit:201}],
      ['conversations.get',{conversationId:CONTACT,messageLimit:501}],['calls.search',{limit:0}],['appointments.search',{daysFuture:731}],['tasks.search',{limit:201}],['tasks.search',{status:'done'}],['tasks.search',{dueBefore:'tomorrow'}],
      ['jobs.search',{cursor:''}],['jobs.search',{cursor:'x'.repeat(513)}],['contacts.get',{contactId:'not-a-uuid'}],['jobs.get',{}],
      ['contacts.search',{query:'x',actor:'owner'}],['jobs.get',{jobId:CONTACT,role:'owner'}],['conversations.get',{conversationId:CONTACT,offset:10}]
    ];
    for(const [name,input] of rejected)expect(inputs[name]!.safeParse(input).success,`${name} ${JSON.stringify(input)}`).toBe(false);
  });
});

describe('SQL-side filtering and pagination',()=>{
  it('puts every filter in the WHERE of the paged statement, before LIMIT/OFFSET, with windows from the injected clock',async()=>{
    const cases:[string,Record<string,unknown>,string,RegExp[],unknown[]][]=[
      ['contacts.search',{query:'555',limit:2},'contacts',[/where \("contacts"\."name" ilike \$1 or "contacts"\."phone" ilike \$2 or "contacts"\."email" ilike \$3\) order by "contacts"\."updated_at" desc, "contacts"\."id" desc limit \$4$/],['%555%','%555%','%555%',3]],
      ['leads.search',{state:'NEVER_CONTACTED',days:7},'leads',[/where \("leads"\."created_at" >= \$1 and coalesce\(\(select "customer_state_snapshots"\."snapshot"->>'state' from "customer_state_snapshots" where "customer_state_snapshots"\."contact_id"="leads"\."contact_id"\),"leads"\."current_state"::text\) in \(\$2, \$3\)\) order by "leads"\."created_at" desc, "leads"\."id" desc limit \$4$/],[iso(NOW.valueOf()-7*DAY),'NEVER_CONTACTED','NEW_LEAD',101]],
      ['conversations.search',{contactId:CONTACT},'conversations',[/where "conversations"\."contact_id" = \$1 order by "conversations"\."updated_at" desc, "conversations"\."id" desc limit \$2$/],[CONTACT,51]],
      ['calls.search',{contactId:CONTACT,days:3},'calls',[/inner join "contacts" on "calls"\."contact_id" = "contacts"\."id" where \("calls"\."contact_id" = \$1 and "calls"\."started_at" >= \$2\) order by "calls"\."started_at" desc, "calls"\."id" desc limit \$3$/],[CONTACT,iso(NOW.valueOf()-3*DAY),101]],
      ['opportunities.search',{contactId:CONTACT,status:'open',limit:500},'opportunities',[/where \("opportunities"\."contact_id" = \$1 and "opportunities"\."status" = \$2\) order by "opportunities"\."updated_at" desc, "opportunities"\."id" desc limit \$3$/],[CONTACT,'open',201]],
      ['appointments.search',{contactId:CONTACT,daysPast:1,daysFuture:2},'appointments',[/where \("appointments"\."appointment_start_at" >= \$1 and "appointments"\."appointment_start_at" < \$2 and "appointments"\."contact_id" = \$3\) order by "appointments"\."appointment_start_at" asc, "appointments"\."id" asc limit \$4$/],[iso(NOW.valueOf()-DAY),iso(NOW.valueOf()+2*DAY),CONTACT,201]],
      ['jobs.search',{contactId:CONTACT,status:'scheduled',limit:1},'jobs',[/where \("jobs"\."contact_id" = \$1 and "jobs"\."status" = \$2\) order by "jobs"\."updated_at" desc, "jobs"\."id" desc limit \$3$/],[CONTACT,'scheduled',2]],
      ['tasks.search',{status:'blocked',priority:'urgent',assignedUserId:'user-1',contactId:CONTACT,jobId:OTHER,opportunityId:CONTACT,dueBefore:'2026-10-01T00:00:00Z',dueAfter:'2026-09-01T00:00:00Z',limit:10},'tasks',
        [/where \("tasks"\."status" = \$1 and "tasks"\."priority" = \$2 and "tasks"\."assigned_user_id" = \$3 and "tasks"\."contact_id" = \$4 and "tasks"\."job_id" = \$5 and "tasks"\."opportunity_id" = \$6 and "tasks"\."due_at" <= \$7 and "tasks"\."due_at" >= \$8\) order by "tasks"\."updated_at" desc, "tasks"\."id" desc limit \$9$/],
        ['blocked','urgent','user-1',CONTACT,OTHER,CONTACT,'2026-10-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',11]],
      ['walkthroughs.search',{contactId:CONTACT,status:'draft'},'walkthroughs',[/where \("walkthroughs"\."contact_id" = \$1 and "walkthroughs"\."status" = \$2\) order by "walkthroughs"\."created_at" desc, "walkthroughs"\."id" desc limit \$3$/],[CONTACT,'draft',101]]
    ];
    for(const [name,args,table,patterns,params] of cases){
      const h=harness(),r=await h.call(name,args);
      expect(r,name).toMatchObject({items:[],page:{offset:0,returned:0,nextCursor:null},asOf:NOW.toISOString(),coverage:{complete:true}});
      const paged=h.log.filter(s=>s.table===table);expect(paged,name).toHaveLength(1);
      for(const pattern of patterns)expect(flat(paged[0]!.sql),name).toMatch(pattern);
      expect(paged[0]!.params,name).toEqual(params);
    }
  });
  it('without filters the paged statement has no WHERE, and a cursor continues with OFFSET on the same filters',async()=>{
    const h=harness(),cursor=encodeCursor('jobs.search',{status:'scheduled'},200);
    await h.call('jobs.search',{});await h.call('jobs.search',{status:'scheduled',limit:500,cursor});
    expect(flat(h.log[0]!.sql)).toMatch(/from "jobs" order by "jobs"\."updated_at" desc, "jobs"\."id" desc limit \$1$/);expect(h.log[0]!.params).toEqual([101]);
    expect(flat(h.log[1]!.sql)).toMatch(/where "jobs"\."status" = \$1 order by "jobs"\."updated_at" desc, "jobs"\."id" desc limit \$2 offset \$3$/);expect(h.log[1]!.params).toEqual(['scheduled',201,200]);
  });
  it.each(WALKS.map(w=>[w.name,w] as const))('%s: the cursor walks the full set without duplicates or gaps while the clock moves on',async(_name,walk)=>{
    const {keys,pages,log,probes}=await walkAll(walk,7,3,90_000);
    expect(keys).toEqual(Array.from({length:7},(_,i)=>id(i)));
    expect(pages.map(p=>p.page)).toEqual([
      {limit:3,offset:0,returned:3,nextCursor:expect.any(String)},{limit:3,offset:3,returned:3,nextCursor:expect.any(String)},{limit:3,offset:6,returned:1,nextCursor:null}]);
    // Every page keeps the first page's asOf, and the filters (including any window) are bound to it, not to the later clock.
    expect(pages.every(p=>p.asOf===NOW.toISOString()&&p.coverage.complete===true)).toBe(true);
    expect(log.map(limitOffset)).toEqual([{limit:4,offset:0},{limit:4,offset:3},{limit:4,offset:6}]);
    const bound=(st:Statement)=>st.params.filter(p=>typeof p==='string');
    expect(log.map(bound)).toEqual([bound(log[0]!),bound(log[0]!),bound(log[0]!)]);
    // Only later pages probe for rows written after the anchor, with the same filters.
    expect(probes).toHaveLength(2);
    for(const probe of probes)expect(probe.params).toEqual([...bound(log[0]!),NOW.toISOString(),1]);
    expect(decodeCursor(pages[1].page.nextCursor,walk.name,walk.name==='conversations.get'?{conversationId:CONTACT}:{...walk.args,...(walk.name==='leads.search'||walk.name==='calls.search'?{days:30}:walk.name==='appointments.search'?{daysPast:30,daysFuture:90}:walk.name==='contacts.search'?{query:''}:{})})).toBe(6);
  });
  it('a legacy limit above 200 is served 200 per page and still reaches every row exactly once',async()=>{
    const {keys,pages,log}=await walkAll(WALKS.find(w=>w.name==='tasks.search')!,505,200);
    expect(pages.map(p=>p.page.returned)).toEqual([200,200,105]);expect(new Set(keys).size).toBe(505);
    const leads=await walkAll(WALKS.find(w=>w.name==='leads.search')!,505,500);
    expect(leads.pages.map(p=>[p.page.limit,p.page.returned])).toEqual([[200,200],[200,200],[200,105]]);expect(new Set(leads.keys).size).toBe(505);
    expect(leads.log.map(limitOffset)).toEqual([{limit:201,offset:0},{limit:201,offset:200},{limit:201,offset:400}]);expect(log).toHaveLength(3);
  });
  it('binds a cursor to its tool and exact filters and refuses a foreign or forged one before querying',async()=>{
    const h=harness(slicer(WALKS.find(w=>w.name==='jobs.search')!,5)),first=await h.call('jobs.search',{status:'scheduled',limit:2});
    const cursor=first.page.nextCursor as string,before=h.log.length;
    for(const [name,args,code] of [['jobs.search',{status:'completed'},'cursor_filter_mismatch'],['jobs.search',{},'cursor_filter_mismatch'],['walkthroughs.search',{status:'scheduled'},'cursor_filter_mismatch'],['jobs.search',{status:'scheduled',cursor:'not a cursor!'},'invalid_cursor']] as const){
      const r=await h.raw(name,{cursor,...args});
      expect(r.isError,`${name} ${JSON.stringify(args)}`).toBe(true);expect(r.structuredContent.result).toMatchObject({error:code});
    }
    expect(h.log).toHaveLength(before);
    expect((await h.call('jobs.search',{status:'scheduled',limit:50,cursor})).page).toMatchObject({offset:2,returned:3,nextCursor:null});
  });
  it('appointments.search: appointments that start between page calls neither shift the offset nor hide later rows',async()=>{
    const walk=WALKS.find(w=>w.name==='appointments.search')!,starts=[10_000,20_000,HOUR,2*HOUR,3*HOUR];
    const rows=starts.map((ms,i)=>dbRow(schema.appointments,{id:id(i),providerId:`a-${i}`,contactId:OTHER,status:'new',appointmentStartAt:iso(NOW.valueOf()+ms)}));
    // Answers like PostgreSQL would: the window bounds are the first two parameters, then LIMIT/OFFSET.
    const respond:Respond=st=>{
      if(st.table!=='appointments'||isProbe(st))return [];
      const [since,until]=st.params as string[],page=limitOffset(st)!,start=(r:Record<string,unknown>)=>String(r['appointments.appointment_start_at']);
      return rows.filter(r=>start(r)>=since!&&start(r)<until!).slice(page.offset,page.offset+page.limit);
    };
    // Upcoming only (daysPast 0), two per page, 30 seconds between calls: the first two appointments start during the walk.
    const {keys,pages,log}=await walkAll({...walk,args:{daysPast:0,daysFuture:1}},5,2,30_000,respond);
    expect(keys).toEqual(starts.map((_,i)=>id(i)));
    expect(pages.map(p=>[p.page.returned,p.asOf,p.coverage.complete])).toEqual([[2,NOW.toISOString(),true],[2,NOW.toISOString(),true],[1,NOW.toISOString(),true]]);
    expect(log.map(st=>st.params.slice(0,2))).toEqual(Array(3).fill([NOW.toISOString(),iso(NOW.valueOf()+DAY)]));
    // A fresh walk at the later time measures its window from that time, so the started appointments are no longer in it.
    const later=harness(respond,undefined,()=>new Date(NOW.valueOf()+30_000));
    expect((await later.call('appointments.search',{daysPast:0,daysFuture:1,limit:2})).items.map((x:any)=>x.id)).toEqual([id(2),id(3)]);
  });
  it('refuses a cursor anchored in the future or more than a day ago before querying, and serves any other from its anchor',async()=>{
    const h=harness(),filters={daysPast:1,daysFuture:1},cursor=(at:number,offset=2)=>encodeCursor('appointments.search',filters,offset,new Date(at));
    for(const at of [NOW.valueOf()-CURSOR_MAX_AGE_MS-1,NOW.valueOf()+CURSOR_CLOCK_SKEW_MS+1,NOW.valueOf()+DAY]){
      const r=await h.raw('appointments.search',{...filters,cursor:cursor(at)});
      expect(r.isError,iso(at)).toBe(true);expect(r.structuredContent.result.error).toBe('invalid_cursor');
    }
    expect(h.log).toHaveLength(0);
    const anchor=NOW.valueOf()-23*HOUR,r=await h.call('appointments.search',{...filters,cursor:cursor(anchor)});
    expect(r).toMatchObject({asOf:iso(anchor),page:{offset:2}});
    expect(h.log[0]!.params).toEqual([iso(anchor-DAY),iso(anchor+DAY),201,2]);
    expect((await h.call('appointments.search',{...filters,cursor:cursor(NOW.valueOf()+CURSOR_CLOCK_SKEW_MS)})).asOf).toBe(iso(NOW.valueOf()+CURSOR_CLOCK_SKEW_MS));
    // The anchor is part of the cursor's integrity checks; decodeCursor, which predates anchors, still reads the offset.
    const raw=JSON.parse(Buffer.from(cursor(anchor),'base64url').toString());
    for(const a of ['soon',1.5,-1,null]){
      const forged=Buffer.from(JSON.stringify({...raw,a})).toString('base64url');
      expect(()=>readCursor(forged,'appointments.search',filters,NOW),String(a)).toThrow('invalid_cursor');
    }
    expect(readCursor(cursor(anchor),'appointments.search',filters,NOW)).toEqual({offset:2,anchor:new Date(anchor)});
    expect(readCursor(encodeCursor('appointments.search',filters,4),'appointments.search',filters,NOW)).toEqual({offset:4});
    expect(decodeCursor(cursor(anchor,7),'appointments.search',filters)).toBe(7);
  });
  it('a later page reports rows written after asOf instead of a silent shift, and the first page never probes',async()=>{
    const rows=slicer(WALKS.find(w=>w.name==='jobs.search')!,5);let written=false;
    const h=harness(st=>isProbe(st)?(written?[{}]:[]):rows(st),undefined,()=>new Date(NOW.valueOf()+(written?60_000:0)));
    const first=await h.call('jobs.search',{limit:2});
    expect(first.coverage).toEqual({complete:true});expect(h.log.filter(isProbe)).toHaveLength(0);
    const second=await h.call('jobs.search',{limit:2,cursor:first.page.nextCursor});
    expect(second.coverage).toEqual({complete:true});
    written=true;
    const third=await h.call('jobs.search',{limit:2,cursor:second.page.nextCursor});
    expect(third).toMatchObject({items:[{id:id(4)}],page:{offset:4,nextCursor:null},asOf:NOW.toISOString(),coverage:{complete:false,reason:'rows_changed_after_asOf',instruction:expect.stringMatching(/missing or repeated.*Omit cursor/)}});
    const probes=h.log.filter(isProbe);expect(probes).toHaveLength(2);
    expect(flat(probes[1]!.sql)).toMatch(/^select 1 from "jobs" where "jobs"\."updated_at" > \$1 limit \$2$/);expect(probes[1]!.params).toEqual([NOW.toISOString(),1]);
    // With a state filter a canonical snapshot change can move a lead into the set, so the probe covers the snapshot too.
    const leads=harness();
    await leads.call('leads.search',{state:'JOB_SOLD',limit:1,cursor:encodeCursor('leads.search',{state:'JOB_SOLD',days:30},1,NOW)});
    const probe=leads.log.find(isProbe)!;
    expect(flat(probe.sql)).toMatch(/^select 1 from "leads" where \(\("leads"\."created_at" >= \$1 and coalesce\(.*\) in \(\$2\)\) and \("leads"\."updated_at" > \$3 or exists \(select 1 from "customer_state_snapshots" where \("customer_state_snapshots"\."contact_id" = "leads"\."contact_id" and "customer_state_snapshots"\."updated_at" > \$4\)\)\)\) limit \$5$/);
    expect(probe.params).toEqual([iso(NOW.valueOf()-30*DAY),'JOB_SOLD',NOW.toISOString(),NOW.toISOString(),1]);
    const unfiltered=harness();
    await unfiltered.call('leads.search',{limit:1,cursor:encodeCursor('leads.search',{days:30},1,NOW)});
    expect(flat(unfiltered.log.find(isProbe)!.sql)).not.toMatch(/customer_state_snapshots/);
  });
  it('conversations.get binds its message cursor to the exact conversation',async()=>{
    const h=harness(s=>s.table==='conversations'?[dbRow(schema.conversations,{id:CONTACT,providerId:'x',contactId:OTHER})]:[]);
    const r=await h.raw('conversations.get',{conversationId:CONTACT,cursor:encodeCursor('conversations.get',{conversationId:OTHER},100)});
    expect(r.isError).toBe(true);expect(r.structuredContent.result.error).toBe('cursor_filter_mismatch');expect(h.log.filter(s=>s.table==='messages')).toHaveLength(0);
  });
});

describe('record reads and enrichment',()=>{
  it('enriches only the returned page with canonical state and keeps provider state separate',async()=>{
    const walk=WALKS.find(w=>w.name==='leads.search')!,rows=slicer(walk,3);
    const h=harness(s=>s.table==='customer_state_snapshots'?[dbRow(schema.customerStateSnapshots,{contactId:id(0,'b'),snapshot:{state:'JOB_SOLD'},coverage:{complete:true},lastReconciledAt:iso(NOW.valueOf())})]:rows(s));
    const r=await h.call('leads.search',{limit:2});
    expect(r.items.map((x:any)=>[x.lead.currentState,x.lead.providerState,x.operational.state??x.operational.coverage.error])).toEqual([['JOB_SOLD','NEVER_CONTACTED','JOB_SOLD'],['NEVER_CONTACTED','NEVER_CONTACTED','customer_not_reconciled']]);
    const lookup=h.log.find(s=>s.table==='customer_state_snapshots')!;expect(lookup.params).toEqual([id(0,'b'),id(1,'b')]);
    const contacts=harness(slicer(WALKS[0]!,3));const c=await contacts.call('contacts.search',{limit:2});
    expect(c.items.map((x:any)=>x.operational)).toEqual([{coverage:{complete:false,error:'customer_not_reconciled'}},{coverage:{complete:false,error:'customer_not_reconciled'}}]);
    expect(contacts.log.find(s=>s.table==='customer_state_snapshots')!.params).toEqual([id(0),id(1)]);
  });
  it('gets return one record with a refreshed canonical timeline, and not-found as an error result',async()=>{
    const job=dbRow(schema.jobs,{id:CONTACT,contactId:OTHER,status:'scheduled'}),h=harness(s=>s.table==='jobs'?[job]:[]);
    expect(await h.call('jobs.get',{jobId:CONTACT})).toMatchObject({id:CONTACT,status:'scheduled',canonical:{contactId:OTHER,customer:{state:'JOB_SOLD'}}});
    expect(h.timeline).toHaveBeenCalledWith({contactId:OTHER,refresh:true});
    for(const [name,args,code] of [['contacts.get',{contactId:CONTACT},'contact_not_found'],['leads.get',{leadId:CONTACT},'lead_not_found'],['calls.get',{callId:CONTACT},'call_not_found'],['opportunities.get',{opportunityId:CONTACT},'opportunity_not_found'],['walkthroughs.get',{walkthroughId:CONTACT},'walkthrough_not_found'],['conversations.get',{conversationId:CONTACT},'conversation_not_found']] as const){
      const empty=harness(),r=await empty.raw(name,args);
      expect(r.isError,name).toBe(true);expect(r.structuredContent.result).toEqual({error:code});expect(empty.timeline).not.toHaveBeenCalled();
    }
    const lead=harness(s=>s.table==='leads'?[{...dbRow(schema.leads,{id:CONTACT,contactId:OTHER,currentState:'BOOKED'}),...dbRow(schema.contacts,{id:OTHER,providerId:'p'})}]:[]);
    expect(await lead.call('leads.get',{leadId:CONTACT})).toMatchObject({lead:{id:CONTACT,providerState:'BOOKED',currentState:'JOB_SOLD'},contact:{id:OTHER},canonical:{contactId:OTHER}});
    const call=harness(s=>s.table==='calls'?[dbRow(schema.calls,{id:CONTACT,providerMessageId:'m',contactId:OTHER,direction:'inbound',startedAt:iso(NOW.valueOf())})]:[]);
    expect(await call.call('calls.get',{callId:CONTACT})).toMatchObject({call:{id:CONTACT},transcript:null});
    const walkthrough=harness(s=>s.table==='walkthroughs'?[dbRow(schema.walkthroughs,{id:CONTACT,status:'draft',extraction:{garageSize:'2-car'}})]:[]);
    expect(await walkthrough.call('walkthroughs.get',{walkthroughId:CONTACT})).toMatchObject({id:CONTACT,status:'draft',extraction:{garageSize:'2-car'}});
  });
  it('never returns database error text',async()=>{
    const h=harness(()=>{throw new Error('password authentication failed postgres://egc:secret-password@db.internal/egc customer@example.test');});
    for(const [name,args] of [['jobs.search',{}],['contacts.get',{contactId:CONTACT}]] as const){
      const r=await h.raw(name,args);
      expect(r.isError).toBe(true);expect(r.structuredContent.result).toEqual({tool:name,error:'tool_operation_failed'});expect(JSON.stringify(r)).not.toMatch(/secret-password|customer@example/);
    }
  });
  it('declares the page envelope as output, and every paged result satisfies it',async()=>{
    for(const walk of WALKS.filter(w=>w.name!=='conversations.get')){
      const h=harness(slicer(walk,2)),value=await h.call(walk.name,{...walk.args,limit:1});
      expect(h.tools.get(walk.name)!.config.outputSchema.safeParse({result:value}).success,walk.name).toBe(true);
    }
    expect(harness().tools.get('conversations.get')!.config.outputSchema).toBeUndefined();
  });
});
