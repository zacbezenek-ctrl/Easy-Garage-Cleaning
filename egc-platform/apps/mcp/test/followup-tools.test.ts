import {afterEach,describe,expect,it,vi} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/server';
import {WRITE_COMMANDS} from '@egc/operations';
import {followupTools,groupOverdue,OVERDUE_BRIDGE_PAGE,OVERDUE_MAX_BRIDGE_PAGES,OVERDUE_SCAN_LIMIT,scanOverdue,type OperationsCall} from '../src/tools/domains/followups.js';
import {registerTools} from '../src/tools/define.js';
import {DOMAIN_TOOLS,REGISTRY_WRITE_TOOLS} from '../src/tools/index.js';
import {requiredToolScope,WRITE_TOOLS} from '../src/tool-access.js';
import {operationsPrincipal} from '../src/operations.js';
import {READ_SCOPE,WRITE_SCOPE} from '../src/oauth.js';

const env={...process.env};afterEach(()=>{process.env={...env};vi.restoreAllMocks();});
const NOW=new Date('2026-09-22T12:00:00.000Z'),MIN=60_000,HOUR=60*MIN,DAY=24*HOUR;
const actor={id:'mcp-oauth-grant:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b',role:'integration' as const,kind:'integration' as const,workspace:'egc'};
const iso=(ms:number)=>new Date(ms).toISOString();
const uuid=(n:number)=>`aaaaaaaa-0000-4000-8000-${String(n).padStart(12,'0')}`;
type Row=Record<string,unknown>;
// A synthetic task row as the operations service returns it (dates as ISO strings, internal fields included).
const task=(n:number,extra:Row={}):Row=>({id:uuid(n),workspaceId:'egc',revision:2,kind:'callback',title:`Synthetic follow-up ${n}`,description:'Internal context that the tool must not return',
  status:'open',priority:'medium',assignedUserId:'tylerg',dueAt:iso(NOW.valueOf()-(n+1)*HOUR),reviewAt:null,waitingOn:'none',portalJobId:null,portalVisitId:null,contactId:null,
  approvalStatus:'not_required',completionCondition:'Customer reached',dedupeKey:`dedupe-${n}`,sourceEvidence:[],draftPayload:null,createdAt:iso(NOW.valueOf()-3*DAY),updatedAt:iso(NOW.valueOf()-2*DAY),...extra});

/** A fake bridge serving `rows` for view 'overdue' with the service's paging contract, recording every command. */
function bridge(rows:Row[]|(()=>Row[])){
  const commands:Row[]=[];
  const call=vi.fn<OperationsCall>(async command=>{
    commands.push(command as Row);const c=command as Row&{offset:number;limit:number;owner?:string};
    const all=(typeof rows==='function'?rows():rows).filter(row=>!c.owner||row.assignedUserId===c.owner),items=all.slice(c.offset,c.offset+c.limit);
    return {ok:true,items,total:all.length,offset:c.offset,nextOffset:c.offset+items.length<all.length?c.offset+items.length:null,asOf:NOW.toISOString(),
      coverage:{registeredTasks:'complete',inferredCommitments:'not_complete'},httpStatus:200,requestId:uuid(9999)};
  });
  return {call,commands};
}
function harness(call:OperationsCall,clock:()=>Date=()=>NOW){
  const tools=new Map<string,{config:any;handler:(args:unknown)=>Promise<any>}>();
  registerTools({registerTool:(name:string,config:unknown,handler:any)=>tools.set(name,{config,handler})} as unknown as McpServer,followupTools({call}),{now:()=>clock()});
  const tool=tools.get('egc.whats_overdue')!;
  const raw=(args:Record<string,unknown>={})=>operationsPrincipal.run(actor,()=>tool.handler(tool.config.inputSchema.parse(args)));
  const run=async(args:Record<string,unknown>={})=>(await raw(args)).structuredContent.result as Record<string,any>;
  return {tool,raw,run};
}

describe('egc.whats_overdue is a read-only registry tool',()=>{
  it('is class read with read annotations, egc:read only, and not in any write set',()=>{
    const def=DOMAIN_TOOLS.find(d=>d.name==='egc.whats_overdue')!;
    expect(def.policy).toMatchObject({class:'read',readOnly:true,scope:READ_SCOPE,scopes:[READ_SCOPE],requiresRequestId:false,twoStep:false,ownerOnly:false});
    expect(def.annotations).toEqual({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
    expect(requiredToolScope('egc.whats_overdue')).toBe(READ_SCOPE);
    expect(WRITE_TOOLS.has('egc.whats_overdue')).toBe(false);expect(REGISTRY_WRITE_TOOLS.has('egc.whats_overdue')).toBe(false);
    const {tool}=harness(bridge([]).call);
    expect(tool.config.annotations.readOnlyHint).toBe(true);
    expect(tool.config._meta.securitySchemes.flatMap((s:{scopes:string[]})=>s.scopes)).toEqual([READ_SCOPE]);
    expect(tool.config._meta.securitySchemes.flatMap((s:{scopes:string[]})=>s.scopes)).not.toContain(WRITE_SCOPE);
    expect('requestId' in tool.config.inputSchema.shape).toBe(false);expect('confirmToken' in tool.config.inputSchema.shape).toBe(false);
  });
  it('rejects unknown keys and oversized pages before any bridge call',()=>{
    const {tool}=harness(bridge([]).call),schema=tool.config.inputSchema;
    expect(schema.safeParse({}).success).toBe(true);expect(schema.parse({})).toEqual({limit:20});
    for(const bad of [{limit:51},{limit:0},{owner:''},{owner:'x'.repeat(201)},{view:'due'},{actor:'owner'},{requestId:uuid(1)}])expect(schema.safeParse(bad).success,JSON.stringify(bad)).toBe(false);
  });
  it('only ever reads the overdue queue: every bridge command is a non-write queue read',async()=>{
    const {call,commands}=bridge(Array.from({length:450},(_,n)=>task(n)));
    await harness(call).run({owner:'tylerg'});
    expect(commands.length).toBeGreaterThan(0);
    for(const command of commands){expect(command).toMatchObject({command:'queue',view:'overdue',owner:'tylerg',dueBefore:NOW.toISOString(),limit:OVERDUE_BRIDGE_PAGE});expect(WRITE_COMMANDS.has(String(command.command))).toBe(false);}
  });
});

describe('grouping and the item projection',()=>{
  const rows=[
    task(1,{kind:'followup_message',assignedUserId:'tylerg',sourceEvidence:[1,2,3,4].map(i=>({source:'call',id:`call-${i}`,excerpt:`Customer said to call back Friday (${i})`})),
      draftPayload:{channel:'sms',recipient:'+15555550100',subject:'',body:'x'.repeat(300),sendWindowStart:iso(NOW.valueOf()-HOUR),sendWindowEnd:iso(NOW.valueOf()+DAY),
        attachments:[{kind:'portal_quote',url:'https://easygaragecleaning.com/portal/quote/synthetic-1',label:'Your quote',refId:'quote:synthetic-1'}]},approvalStatus:'pending'}),
    task(2,{kind:'callback',assignedUserId:'tylerg'}),
    task(3,{kind:'callback',assignedUserId:'zacb'}),
    task(4,{kind:'send_quote',assignedUserId:'',draftPayload:{channel:'email',recipient:'synthetic@example.invalid',subject:'Your quote',body:'Short body',sendWindowStart:null,sendWindowEnd:null,attachments:'not-a-list'}}),
    task(5,{kind:'callback',assignedUserId:'tylerg',waitingOn:'customer',dueAt:iso(NOW.valueOf()+DAY),reviewAt:iso(NOW.valueOf()-90*MIN)}),
    task(6,{kind:'prepare_quote',assignedUserId:null})
  ];
  it('counts by owner (with kinds) and by kind, largest first, unassigned last on a tie',async()=>{
    const {call}=bridge(rows),r=await harness(call).run();
    expect(r.summary).toEqual({total:6,exact:true,
      byOwner:[{owner:'tylerg',count:3,kinds:[{kind:'callback',count:2},{kind:'followup_message',count:1}]},{owner:null,count:2,kinds:[{kind:'prepare_quote',count:1},{kind:'send_quote',count:1}]},{owner:'zacb',count:1,kinds:[{kind:'callback',count:1}]}],
      byKind:[{kind:'callback',count:3},{kind:'followup_message',count:1},{kind:'prepare_quote',count:1},{kind:'send_quote',count:1}]});
    expect(groupOverdue([]).byOwner).toEqual([]);
    const tie=groupOverdue([task(1,{assignedUserId:null}),task(2,{assignedUserId:'alexk'})] as any);
    expect(tie.byOwner.map(o=>o.owner)).toEqual(['alexk',null]);
  });
  it('projects an allowlist with minutes overdue, three evidence excerpts and a bounded draft preview',async()=>{
    const {call}=bridge(rows),r=await harness(call).run({limit:10});
    expect(r.items.map((i:any)=>i.taskId)).toEqual(rows.map(row=>row.id));
    const [first,,, quote,waiting]=r.items;
    expect(first).toMatchObject({title:'Synthetic follow-up 1',kind:'followup_message',owner:'tylerg',attentionAt:iso(NOW.valueOf()-2*HOUR),overdueMinutes:120,revision:2,approvalStatus:'pending',sourceEvidenceCount:4});
    expect(first.sourceEvidence).toEqual([1,2,3].map(i=>({source:'call',id:`call-${i}`,excerpt:`Customer said to call back Friday (${i})`})));
    expect(first.draft).toEqual({channel:'sms',recipient:'+15555550100',subject:'',bodyPreview:'x'.repeat(280)+'…',bodyLength:300,sendWindowStart:iso(NOW.valueOf()-HOUR),sendWindowEnd:iso(NOW.valueOf()+DAY),
      attachments:[{kind:'portal_quote',label:'Your quote'}],approvalStatus:'pending'});
    expect(quote).toMatchObject({owner:null,draft:{channel:'email',subject:'Your quote',bodyPreview:'Short body',bodyLength:10,attachments:[]}});
    expect(waiting).toMatchObject({waitingOn:'customer',attentionAt:iso(NOW.valueOf()-90*MIN),overdueMinutes:90},'waiting work is overdue by its review time');
    expect(r.items[1].draft).toBeNull();
    const text=JSON.stringify(r);
    for(const hidden of ['Internal context','dedupe-','workspaceId','completionCondition','x'.repeat(281),'/portal/quote/','quote:synthetic-1'])expect(text).not.toContain(hidden);
    expect(r.note).toMatch(/^Read-only\. Nothing was sent/);
    expect(r.coverage).toEqual({complete:true,scope:'registered_actions'});
    expect(r.asOf).toBe(NOW.toISOString());
  });
});

describe('bridge pagination',()=>{
  it('follows the queue until nextOffset is null, each later call overlapping the previous page by one row',async()=>{
    const {call,commands}=bridge(Array.from({length:450},(_,n)=>task(n)));
    const r=await harness(call).run();
    expect(commands.map(c=>c.offset)).toEqual([0,199,398]);
    expect(r.summary).toMatchObject({total:450,exact:true});expect(r.coverage.complete).toBe(true);expect(r.page).toMatchObject({total:450,returned:20});
  });
  it(`stops after ${OVERDUE_MAX_BRIDGE_PAGES} pages and reports a lower bound instead of a complete count`,async()=>{
    const {call,commands}=bridge(Array.from({length:1500},(_,n)=>task(n))),h=harness(call);
    const r=await h.run();
    expect(commands.map(c=>c.offset)).toEqual([0,199,398,597,796]);
    expect(call).toHaveBeenCalledTimes(OVERDUE_MAX_BRIDGE_PAGES);
    expect(OVERDUE_SCAN_LIMIT).toBe(996);
    expect(r.summary).toMatchObject({total:OVERDUE_SCAN_LIMIT,exact:false});
    expect(r.coverage).toMatchObject({complete:false,reason:'scan_limit_reached',scanned:OVERDUE_SCAN_LIMIT,liveTotal:1500});
    expect(h.tool.config.description).toContain('It reads at most 996 overdue actions');
    expect(r.page.total).toBeUndefined();
  });
  it('a page that does not advance, or any malformed page, is an error and never an empty list',async()=>{
    const bad:Row[]=[
      {ok:true,items:[task(1)],total:5,nextOffset:0},{ok:true,items:[task(1)],total:5,nextOffset:7},{ok:true,items:[],total:5,nextOffset:0},
      {ok:true,items:'none',total:0,nextOffset:null},{ok:true,items:[{id:uuid(1)}],total:1,nextOffset:null},{ok:true,items:[],nextOffset:null},{ok:true,items:[task(1)],total:0,nextOffset:null},{items:[],total:0,nextOffset:null},
      // A short page that claims to be the last one while the total says more exist would silently drop actions.
      {ok:true,items:[task(1)],total:3,nextOffset:null},{ok:true,items:[],total:2,nextOffset:null},{ok:true,items:[task(1)],total:-1,nextOffset:null}
    ];
    for(const body of bad){
      const call=vi.fn<OperationsCall>(async()=>body),out=await harness(call).raw();
      expect(out.isError,JSON.stringify(body)).toBe(true);
      expect(out.structuredContent.result).toMatchObject({error:'operations_response_invalid'});
      expect(out.structuredContent.result.items).toBeUndefined();
    }
  });
  it('a queue that changes between bridge pages is reported as unsettled, and a shifted row is counted once',async()=>{
    // Serves rows() for each page, then applies change() once after the first page, like an action changing between bridge calls.
    const live=(initial:Row[],change:(rows:Row[])=>Row[])=>{
      let rows=initial;const offsets:number[]=[];
      const call=vi.fn<OperationsCall>(async command=>{
        const c=command as Row&{offset:number;limit:number},all=rows,items=all.slice(c.offset,c.offset+c.limit);offsets.push(c.offset);
        if(c.offset===0)rows=change(rows);
        return {ok:true,items,total:all.length,offset:c.offset,nextOffset:c.offset+items.length<all.length?c.offset+items.length:null};
      });
      return {call,offsets};
    };
    // An action on the first page is completed: every later row moves up by one, so the overlap row is uuid(200), not uuid(199).
    const removed=live(Array.from({length:450},(_,n)=>task(n)),rows=>rows.filter(row=>row.id!==uuid(5)));
    const r=await harness(removed.call).run();
    expect(removed.offsets).toEqual([0,199,398]);
    expect(r.coverage).toMatchObject({complete:false,reason:'queue_changed_during_read'});
    expect(r.summary).toMatchObject({total:450,exact:false});expect(r.page.total).toBeUndefined();
    // A newer overdue action sorts first: the second page repeats uuid(198) and uuid(199), which are counted once.
    const inserted=live(Array.from({length:201},(_,n)=>task(n)),rows=>[task(900,{dueAt:iso(NOW.valueOf()-9*DAY)}),...rows]);
    const scan=await scanOverdue(inserted.call,{dueBefore:NOW});
    expect(inserted.offsets).toEqual([0,199]);
    expect(scan).toMatchObject({complete:true,stable:false,total:202});
    if('error' in scan)throw new Error(scan.error);
    expect(scan.tasks).toHaveLength(201);expect(new Set(scan.tasks.map(t=>t.id)).size).toBe(201);expect(scan.tasks.map(t=>t.id)).not.toContain(uuid(900));
  });
  it('a completion plus a newly overdue action between bridge calls keeps the total but is caught by the overlap row',async()=>{
    // 450 overdue actions. After the first bridge page an action on it is completed and another falls overdue at the end of the
    // queue: the total stays 450, yet every later row shifts up one, so without the overlap uuid(200) would never be served.
    const shifting=()=>{
      let rows=Array.from({length:450},(_,n)=>task(n));const offsets:number[]=[];
      const call=vi.fn<OperationsCall>(async command=>{
        const c=command as Row&{offset:number;limit:number},all=rows,items=all.slice(c.offset,c.offset+c.limit);offsets.push(c.offset);
        if(c.offset===0)rows=[...rows.filter(row=>row.id!==uuid(5)),task(700,{dueAt:iso(NOW.valueOf()-30*MIN)})];
        return {ok:true,items,total:all.length,offset:c.offset,nextOffset:c.offset+items.length<all.length?c.offset+items.length:null};
      });
      return {call,offsets};
    };
    const direct=shifting(),scan=await scanOverdue(direct.call,{dueBefore:NOW});
    expect(direct.offsets).toEqual([0,199,398]);
    if('error' in scan)throw new Error(scan.error);
    expect(scan).toMatchObject({complete:true,stable:false,total:450});
    expect(scan.tasks.map(t=>t.id)).toContain(uuid(200));
    const r=await harness(shifting().call).run();
    expect(r.coverage).toMatchObject({complete:false,reason:'queue_changed_during_read'});
    expect(r.summary.exact).toBe(false);expect(r.page.total).toBeUndefined();
  });
  it('passes a bridge error through as an error result with a truthful instruction',async()=>{
    const call=vi.fn<OperationsCall>(async()=>({error:'operations_unavailable',message:'upstream body',retryable:true}));
    const out=await harness(call).raw();
    expect(out.isError).toBe(true);
    expect(out.structuredContent.result).toEqual({error:'operations_unavailable',instruction:'Overdue follow-ups could not be read. Nothing is reported as current; retry later.'});
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('with unified operations disabled, the real bridge refuses before any request',async()=>{
    process.env.EGC_OPERATIONS_ENABLED='false';
    const fetched=vi.fn();vi.stubGlobal('fetch',fetched);
    const tool=DOMAIN_TOOLS.find(d=>d.name==='egc.whats_overdue')!,tools=new Map<string,any>();
    registerTools({registerTool:(name:string,config:unknown,handler:any)=>tools.set(name,{config,handler})} as unknown as McpServer,[tool],{now:()=>NOW});
    const out=await operationsPrincipal.run(actor,()=>tools.get('egc.whats_overdue').handler({limit:20}));
    expect(out.structuredContent.result).toEqual({error:'operations_not_enabled',instruction:'The Action Center backend is not enabled on this server, so overdue follow-ups cannot be read. This is not an empty queue.'});
    expect(fetched).not.toHaveBeenCalled();vi.unstubAllGlobals();
  });
});

describe('cursor pages',()=>{
  it('walks items with nextCursor, keeps the first asOf and counts, and binds the cursor to the owner',async()=>{
    let clock=NOW;const {call}=bridge(Array.from({length:45},(_,n)=>task(n))),h=harness(call,()=>clock);
    const first=await h.run({limit:20});
    expect(first.items).toHaveLength(20);expect(first.page).toMatchObject({offset:0,returned:20,total:45});expect(first.page.nextCursor).toEqual(expect.any(String));
    clock=new Date(NOW.valueOf()+10*MIN);
    const second=await h.run({limit:20,cursor:first.page.nextCursor});
    expect(second.asOf).toBe(NOW.toISOString());expect(second.items.map((i:any)=>i.taskId)).toEqual(Array.from({length:20},(_,n)=>uuid(20+n)));
    expect(second.items[0].overdueMinutes,'minutes are measured from the walk asOf').toBe(21*60);
    const third=await h.run({limit:20,cursor:second.page.nextCursor});
    expect(third.items).toHaveLength(5);expect(third.page.nextCursor).toBeNull();expect(third.coverage.complete).toBe(true);
    const other=await h.raw({limit:20,owner:'zacb',cursor:first.page.nextCursor});
    expect(other.isError).toBe(true);expect(other.structuredContent.result.error).toBe('cursor_filter_mismatch');
    expect((await h.raw({cursor:'not a cursor'})).structuredContent.result.error).toBe('invalid_cursor');
  });
  it('keeps membership at asOf and reports a row changed after asOf on a later page',async()=>{
    let clock=NOW,rows=Array.from({length:30},(_,n)=>task(n));
    const {call}=bridge(()=>rows),h=harness(call,()=>clock);
    const first=await h.run({limit:20});
    clock=new Date(NOW.valueOf()+HOUR);
    // An action that fell due after the walk began stays out of this walk.
    rows=[...rows,task(100,{dueAt:iso(NOW.valueOf()+30*MIN)})];
    const later=await h.run({limit:20,cursor:first.page.nextCursor});
    expect(later.summary.total).toBe(30);expect(later.items.map((i:any)=>i.taskId)).not.toContain(uuid(100));expect(later.coverage).toEqual({complete:true,scope:'registered_actions'});
    rows=rows.map(row=>row.id===uuid(3)?{...row,updatedAt:iso(NOW.valueOf()+5*MIN)}:row);
    const changed=await h.run({limit:20,cursor:first.page.nextCursor});
    expect(changed.coverage).toMatchObject({complete:false,reason:'rows_changed_after_asOf'});expect(changed.summary.exact).toBe(false);
  });
});
