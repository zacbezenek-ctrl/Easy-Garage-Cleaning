import {afterEach,describe,expect,it,vi} from 'vitest';
import * as z from 'zod/v4';
import type {McpServer} from '@modelcontextprotocol/server';
import {schema} from '@egc/database';
import {getTableColumns} from 'drizzle-orm';
import {crmReadTools} from '../src/tools/domains/crm-reads.js';
import {registerTools} from '../src/tools/define.js';
import {CURSOR_CLOCK_SKEW_MS,CURSOR_MAX_AGE_MS,decodeCursor,encodeCursor,encodeKeysetCursor,readCursor} from '../src/tools/pagination.js';
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

// Offset cursors unless a test turns keyset on; null leaves the flag to EGC_MCP_KEYSET_CURSORS, as production does.
function harness(respond:Respond=()=>[],timeline=vi.fn(async({contactId}:{contactId:string})=>({contactId,customer:{state:'JOB_SOLD'},coverage:{complete:true}})),clock:()=>Date=now,keyset:(()=>boolean)|null=()=>false){
  const driver=sqlDriver(respond),tools=new Map<string,Registered>();
  registerTools({registerTool:(name:string,config:unknown,handler:any)=>tools.set(name,{config,handler})} as unknown as McpServer,crmReadTools({db:()=>driver.db,timeline:timeline as never,...(keyset?{keyset}:{})}),{now:()=>clock()});
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
// The clock moves on by step between pages, as it does between real calls; between(n) runs after page n, where data can change.
async function walkAll(walk:Walk,count:number,size:number,step=0,respond:Respond=slicer(walk,count),keyset:()=>boolean=()=>false,between?:(pages:number)=>void){
  let clock=NOW.valueOf();
  const h=harness(respond,undefined,()=>new Date(clock),keyset),keys:string[]=[],pages:any[]=[];let cursor:string|null|undefined;
  do{const r=await h.call(walk.name,{...walk.args,[walk.limitKey??'limit']:size,...(cursor?{cursor}:{})});const page=walk.page?walk.page(r):r;pages.push(page);keys.push(...page.items.map(walk.key));cursor=page.page.nextCursor;clock+=step;between?.(pages.length);}while(cursor&&pages.length<20);
  const log=h.log.filter(s=>s.table===walk.table);
  return {keys,pages,log:log.filter(s=>!isProbe(s)),probes:log.filter(isProbe),h};
}
// A keyed dataset row: its exact ordering key (microseconds, as the page statement selects it) and id, with created/updated times (ms) for the change probe.
type Keyed={key:string;id:string;row:Record<string,unknown>;created?:number;updated?:number};
// Microsecond n inside ONE millisecond, so a millisecond (JS Date) key could not tell these rows apart.
const us=(n:number)=>`2026-09-22T11:00:00.123${String(n).padStart(3,'0')}Z`;
const keyOrder=(dir:'asc'|'desc')=>(a:Keyed,b:Keyed)=>{const c=a.key<b.key?-1:a.key>b.key?1:a.id<b.id?-1:a.id>b.id?1:0;return dir==='asc'?c:-c;};
const FIXED_KEY=new Set(['leads.search','calls.search','walkthroughs.search']),ANY_KEY=new Set(['appointments.search','conversations.get']);
const decoded=(cursor:string)=>JSON.parse(Buffer.from(cursor,'base64url').toString());
/** Answers a page statement like PostgreSQL: the statement's order with its id tie-breaker, its keyset predicate, then LIMIT/OFFSET; position columns come back under their aliases.
 * A change probe (anchor bound last before its LIMIT) finds a row updated after the anchor, and with a created_at bound only one that also existed at the anchor. */
function keysetResponder(walk:Walk,data:()=>Keyed[]):Respond{
  return s=>{
    const extra=walk.extra?.(s);if(extra)return extra;
    if(s.table!==walk.table)return [];
    if(isProbe(s)){const anchor=Date.parse(String(s.params[s.params.length-2])),existed=/"created_at" <= \$/.test(s.sql);return data().some(r=>r.updated!==undefined&&r.updated>anchor&&(!existed||(r.created??0)<=anchor))?[{}]:[];}
    const text=flat(s.sql),dir=/ order by \S+ (asc|desc), /.exec(text)![1] as 'asc'|'desc',after=/\) ([<>]) \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/.exec(text),page=limitOffset(s)!,cmp=keyOrder(dir);
    let rows=[...data()].sort(cmp);
    if(after){expect(after[1]).toBe(dir==='asc'?'>':'<');const at={key:String(s.params[Number(after[2])-1]),id:String(s.params[Number(after[3])-1]),row:{}};rows=rows.filter(r=>cmp(r,at)>0);}
    return rows.slice(page.offset,page.offset+page.limit).map(r=>({...r.row,egc_page_key:r.key,egc_page_id:r.id}));
  };
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

describe('keyset cursors (EGC_MCP_KEYSET_CURSORS)',()=>{
  const on=()=>true,jobs=WALKS.find(w=>w.name==='jobs.search')!;
  it.each(WALKS.map(w=>[w.name,w] as const))('%s: continues strictly after the last row at microsecond precision, through ties, without OFFSET',async(name,walk)=>{
    const dir=name==='appointments.search'?'asc':'desc',data=[900,900,901,500,500,500,1].map((m,i)=>({key:us(m),id:id(i),row:walk.row(i)}));
    const sorted=[...data].sort(keyOrder(dir)),{keys,pages,log,probes}=await walkAll(walk,7,3,90_000,keysetResponder(walk,()=>data),on);
    expect(keys).toEqual(sorted.map(r=>r.id));
    expect(pages.map(p=>[p.page.offset,p.page.returned,p.asOf,p.coverage.complete])).toEqual([[0,3,NOW.toISOString(),true],[3,3,NOW.toISOString(),true],[6,1,NOW.toISOString(),true]]);
    expect(pages[2].page.nextCursor).toBeNull();
    // Version 2 cursors carry the anchor, the rows already returned and the exact position of the last one.
    expect(pages.slice(0,2).map(p=>decoded(p.page.nextCursor))).toEqual([{v:2,o:3,f:expect.any(String),a:NOW.valueOf(),k:[sorted[2]!.key,sorted[2]!.id]},{v:2,o:6,f:expect.any(String),a:NOW.valueOf(),k:[sorted[5]!.key,sorted[5]!.id]}]);
    expect(log.map(limitOffset)).toEqual(Array(3).fill({limit:4,offset:0}));
    expect(log.every(st=>/ as "egc_page_key", .* as "egc_page_id" from /.test(flat(st.sql))&&!/ offset \$/.test(st.sql))).toBe(true);
    // Later pages bind the same filters and window as the first, then the previous page's last position.
    const bound=(st:Statement)=>st.params.filter(p=>typeof p==='string');
    expect(log.map(st=>bound(st).slice(bound(log[0]!).length))).toEqual([[],[sorted[2]!.key,sorted[2]!.id],[sorted[5]!.key,sorted[5]!.id]]);
    expect(log.slice(1).every(st=>bound(st).slice(0,bound(log[0]!).length).join()===bound(log[0]!).join())).toBe(true);
    expect(pages.flatMap(p=>p.items).some((item:any)=>'egcPageKey' in item||'egcPageId' in item)).toBe(false);
    // Only an update can move a row across the cursor: fixed keys need no probe, updatedAt orders look for a row that existed at the anchor and was updated after it,
    // and keys an update can move either way look for any row written after the anchor, as an offset walk does.
    if(FIXED_KEY.has(name))expect(probes).toHaveLength(0);
    else{
      expect(probes).toHaveLength(2);
      for(const probe of probes)if(ANY_KEY.has(name)){expect(flat(probe.sql)).toMatch(/ and "\w+"\."updated_at" > \$\d+\) limit \$\d+$/);expect(probe.sql).not.toMatch(/created_at/);expect(probe.params).toEqual([...bound(log[0]!),NOW.toISOString(),1]);}
      else{expect(flat(probe.sql)).toMatch(/"created_at" <= \$\d+ and "\w+"\."updated_at" > \$\d+\)\)? limit \$\d+$/);expect(probe.params).toEqual([...bound(log[0]!),NOW.toISOString(),NOW.toISOString(),1]);}
    }
  });
  it.each([...ANY_KEY].map(name=>[name,WALKS.find(w=>w.name===name)!] as const))('%s: a row created after asOf, returned, then moved past the cursor is reported on the pages it can repeat on, never a silent duplicate',async(name,walk)=>{
    // Four rows at asOf, two per page. One is booked between them after page 1 (returned on page 2), then rescheduled past the cursor (returned again on page 3).
    const pos=(n:number)=>us(name==='appointments.search'?n:500-n),old=NOW.valueOf()-DAY;
    const data:Keyed[]=[100,200,300,400].map((n,i)=>({key:pos(n),id:id(i),row:walk.row(i),created:old,updated:old}));
    const {keys,pages,probes}=await walkAll(walk,5,2,30_000,keysetResponder(walk,()=>data),on,n=>{
      if(n===1)data.push({key:pos(250),id:id(9),row:walk.row(9),created:NOW.valueOf()+10_000,updated:NOW.valueOf()+10_000});
      if(n===2)Object.assign(data[4]!,{key:pos(350),updated:NOW.valueOf()+40_000});
    });
    expect(keys).toEqual([id(0),id(1),id(9),id(2),id(9),id(3)]);
    expect(pages.map(p=>[p.asOf,p.coverage.complete,p.coverage.reason])).toEqual([[NOW.toISOString(),true,undefined],[NOW.toISOString(),false,'rows_changed_after_asOf'],[NOW.toISOString(),false,'rows_changed_after_asOf']]);
    expect(pages[2].coverage.instruction).toMatch(/created or updated after asOf.*either way across the cursor.*missing or repeated.*Omit cursor/);
    // The existed-at-asOf probe of the updatedAt orders would find nothing here: the moved row was created after asOf.
    expect(probes.every(p=>!/created_at/.test(p.sql))).toBe(true);
  });
  it('rows removed or added ahead of the cursor between pages never skip or repeat a keyset row; the same changes shift an offset walk',async()=>{
    const fresh=()=>Array.from({length:6},(_,i)=>({key:us(600-i*100),id:id(i),row:jobs.row(i)}));
    const walk=async(keyset:boolean,change:(data:Keyed[])=>void)=>{const data=fresh();return (await walkAll(jobs,6,2,0,keysetResponder(jobs,()=>data),()=>keyset,n=>{if(n===1)change(data);})).keys;};
    const removeFirst=(data:Keyed[])=>{data.splice(0,1);},addAtHead=(data:Keyed[])=>{data.push({key:us(999),id:id(9),row:jobs.row(9)});};
    const all=[0,1,2,3,4,5].map(n=>id(n));
    expect(await walk(true,removeFirst)).toEqual(all);expect(await walk(true,addAtHead)).toEqual(all);
    // Offsets: the removal skips row 2 and the insert repeats row 1, silently.
    expect(await walk(false,removeFirst)).toEqual([id(0),id(1),id(3),id(4),id(5)]);
    expect(await walk(false,addAtHead)).toEqual([id(0),id(1),id(1),id(2),id(3),id(4),id(5)]);
  });
  it('pins the keyset statements: position columns in the select, the row-value predicate after the filters, no OFFSET, and a plain page for the client',async()=>{
    const data=[3,2,1].map((m,i)=>({key:us(m),id:id(i),row:jobs.row(i)})),h=harness(keysetResponder(jobs,()=>data),undefined,now,on);
    const paged=()=>h.log.filter(st=>st.table==='jobs'&&!isProbe(st));
    const first=await h.call('jobs.search',{status:'scheduled',limit:2});
    expect(flat(paged()[0]!.sql)).toMatch(/^select .*"updated_at", to_char\("updated_at" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) as "egc_page_key", "id" as "egc_page_id" from "jobs" where "jobs"\."status" = \$1 order by "jobs"\."updated_at" desc, "jobs"\."id" desc limit \$2$/);
    expect(paged()[0]!.params).toEqual(['scheduled',3]);
    const second=await h.call('jobs.search',{status:'scheduled',limit:2,cursor:first.page.nextCursor});
    expect(flat(paged()[1]!.sql)).toMatch(/ from "jobs" where \("jobs"\."status" = \$1 and \("jobs"\."updated_at", "jobs"\."id"\) < \(\$2::timestamptz, \$3::uuid\)\) order by "jobs"\."updated_at" desc, "jobs"\."id" desc limit \$4$/);
    expect(paged()[1]!.params).toEqual(['scheduled',us(2),id(1),3]);
    expect(first.items.map((x:any)=>x.id)).toEqual([id(0),id(1)]);expect(Object.keys(first.items[0]).sort()).toEqual([...Object.keys(getTableColumns(schema.jobs)),'operational'].sort());
    expect(second).toMatchObject({items:[{id:id(2)}],page:{limit:2,offset:2,returned:1,nextCursor:null},asOf:NOW.toISOString(),coverage:{complete:true}});
    for(const value of [first,second])expect(h.tools.get('jobs.search')!.config.outputSchema.safeParse({result:value}).success).toBe(true);
    // Ascending walks continue with >.
    const appointments=WALKS.find(w=>w.name==='appointments.search')!,a=harness(keysetResponder(appointments,()=>[]),undefined,now,on);
    await a.call('appointments.search',{limit:2,cursor:encodeKeysetCursor('appointments.search',{daysPast:30,daysFuture:90},2,NOW,{key:us(5),id:id(1)})});
    expect(flat(a.log[0]!.sql)).toMatch(/and \("appointments"\."appointment_start_at", "appointments"\."id"\) > \(\$3::timestamptz, \$4::uuid\)\) order by "appointments"\."appointment_start_at" asc, "appointments"\."id" asc limit \$5$/);
  });
  it('reports a row that existed at asOf and was updated after it, never probes a fixed-key order, and runs the full probe for a key that moves either way',async()=>{
    const h=harness(st=>isProbe(st)?[{}]:[],undefined,now,on);
    const moved=await h.call('jobs.search',{limit:2,cursor:encodeKeysetCursor('jobs.search',{},2,NOW,{key:us(5),id:id(1)})});
    expect(moved.coverage).toEqual({complete:false,reason:'rows_changed_after_asOf',instruction:expect.stringMatching(/existed at asOf.*across the cursor.*missing or repeated.*Omit cursor/)});
    expect(flat(h.log.find(isProbe)!.sql)).toMatch(/^select 1 from "jobs" where \("jobs"\."created_at" <= \$1 and "jobs"\."updated_at" > \$2\) limit \$3$/);expect(h.log.find(isProbe)!.params).toEqual([NOW.toISOString(),NOW.toISOString(),1]);
    for(const [name,filters] of [['leads.search',{state:'JOB_SOLD',days:30}],['leads.search',{days:30}],['calls.search',{days:30}],['walkthroughs.search',{status:'draft'}]] as const){
      const fixed=harness(st=>isProbe(st)?[{}]:[],undefined,now,on),r=await fixed.call(name,{...filters,limit:1,cursor:encodeKeysetCursor(name,filters,1,NOW,{key:us(5),id:id(1)})});
      expect(r.coverage,name).toEqual({complete:true});expect(fixed.log.filter(isProbe),name).toHaveLength(0);
    }
    // A key an update can move either way runs the offset probe: any matching row written after asOf, including one created after it.
    for(const [name,filters,args] of [['appointments.search',{daysPast:30,daysFuture:90},{limit:2}],['conversations.get',{conversationId:CONTACT},{conversationId:CONTACT,messageLimit:2}]] as const){
      const any=harness(st=>st.table==='conversations'?[dbRow(schema.conversations,{id:CONTACT,providerId:'x',contactId:OTHER})]:isProbe(st)?[{}]:[],undefined,now,on);
      const r=await any.call(name,{...args,cursor:encodeKeysetCursor(name,filters,2,NOW,{key:us(5),id:id(1)})}),coverage=name==='conversations.get'?r.messages.coverage:r.coverage;
      expect(coverage,name).toEqual({complete:false,reason:'rows_changed_after_asOf',instruction:expect.stringMatching(/created or updated after asOf.*either way across the cursor.*missing or repeated.*Omit cursor/)});
      const probe=any.log.find(isProbe)!;expect(flat(probe.sql),name).toMatch(/ and "\w+"\."updated_at" > \$\d+\) limit \$\d+$/);expect(probe.sql,name).not.toMatch(/created_at/);expect(probe.params.slice(-2),name).toEqual([NOW.toISOString(),1]);
    }
  });
  it('the flag chooses the kind of a new walk only; an offset cursor still continues by offset and a keyset cursor is refused once the flag is off',async()=>{
    const data=[3,2,1].map((m,i)=>({key:us(m),id:id(i),row:jobs.row(i)}));
    // Exactly "true" turns keyset on for new walks; the default reads the environment on every call.
    for(const [value,version] of [[undefined,1],['true',2],['TRUE',1],['1',1],['false',1]] as const){
      if(value===undefined)delete process.env.EGC_MCP_KEYSET_CURSORS;else process.env.EGC_MCP_KEYSET_CURSORS=value;
      const r=await harness(keysetResponder(jobs,()=>data),undefined,now,null).call('jobs.search',{limit:1});
      expect(decoded(r.page.nextCursor).v,String(value)).toBe(version);
    }
    const offsetCursor=encodeCursor('jobs.search',{},1,NOW),keysetCursor=encodeKeysetCursor('jobs.search',{},1,NOW,{key:us(3),id:id(0)});
    const off=harness(keysetResponder(jobs,()=>data),undefined,now,()=>false),refused=await off.raw('jobs.search',{limit:1,cursor:keysetCursor});
    expect(refused.isError).toBe(true);expect(refused.structuredContent.result).toMatchObject({error:'invalid_cursor',instruction:expect.stringMatching(/Omit cursor/)});expect(off.log).toHaveLength(0);
    const onH=harness(keysetResponder(jobs,()=>data),undefined,now,on),continued=await onH.call('jobs.search',{limit:1,cursor:offsetCursor});
    expect(flat(onH.log[0]!.sql)).toMatch(/ limit \$1 offset \$2$/);expect(onH.log[0]!.sql).not.toMatch(/egc_page_key/);
    expect(continued.items.map((x:any)=>x.id)).toEqual([id(1)]);expect(decoded(continued.page.nextCursor)).toMatchObject({v:1,o:2,a:NOW.valueOf()});
  });
  it('refuses a forged, foreign or stale keyset cursor before querying',async()=>{
    const h=harness(keysetResponder(jobs,()=>[]),undefined,now,on),good=decoded(encodeKeysetCursor('jobs.search',{status:'scheduled'},2,NOW,{key:us(3),id:id(0)}));
    const forge=(patch:Record<string,unknown>)=>Buffer.from(JSON.stringify({...good,...patch})).toString('base64url');
    const cases:[Record<string,unknown>,Record<string,unknown>,string][]=[
      [{},{status:'completed'},'cursor_filter_mismatch'],
      [{a:undefined},{status:'scheduled'},'invalid_cursor'],[{k:undefined},{status:'scheduled'},'invalid_cursor'],[{v:1},{status:'scheduled'},'invalid_cursor'],
      [{k:['2026-09-22T11:00:00.123Z',id(0)]},{status:'scheduled'},'invalid_cursor'],[{k:['2026-02-30T11:00:00.123000Z',id(0)]},{status:'scheduled'},'invalid_cursor'],
      [{k:[us(3),id(0).toUpperCase()]},{status:'scheduled'},'invalid_cursor'],[{k:[us(3),"x' or 1=1 --"]},{status:'scheduled'},'invalid_cursor'],[{k:[us(3)]},{status:'scheduled'},'invalid_cursor'],
      [{k:[us(3),id(0),'extra']},{status:'scheduled'},'invalid_cursor'],[{o:-1},{status:'scheduled'},'invalid_cursor'],
      [{a:NOW.valueOf()-CURSOR_MAX_AGE_MS-1},{status:'scheduled'},'invalid_cursor'],[{a:NOW.valueOf()+CURSOR_CLOCK_SKEW_MS+1},{status:'scheduled'},'invalid_cursor']
    ];
    for(const [patch,args,code] of cases){
      const r=await h.raw('jobs.search',{...args,cursor:forge(patch)});
      expect(r.isError,JSON.stringify(patch)).toBe(true);expect(r.structuredContent.result.error,JSON.stringify(patch)).toBe(code);
    }
    expect(h.log).toHaveLength(0);
    expect((await h.call('jobs.search',{status:'scheduled',cursor:forge({})})).page.offset).toBe(2);
  });
  it('a row whose position cannot be encoded ends the page with an offset cursor at the same place, and the walk still finishes',async()=>{
    const data=[5,4,3,2].map((m,i)=>({key:us(m),id:id(i),row:jobs.row(i)})),inner=keysetResponder(jobs,()=>data);
    const respond:Respond=st=>inner(st)?.map(row=>row.egc_page_id===id(1)?{...row,egc_page_key:null}:row);
    const {keys,pages}=await walkAll(jobs,4,2,0,respond,on);
    expect(keys).toEqual([0,1,2,3].map(n=>id(n)));expect(decoded(pages[0].page.nextCursor)).toMatchObject({v:1,o:2,a:NOW.valueOf()});expect(pages[1].page).toMatchObject({offset:2,nextCursor:null});
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
