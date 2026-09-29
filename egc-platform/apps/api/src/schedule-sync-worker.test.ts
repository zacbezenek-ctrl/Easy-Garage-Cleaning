import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import Fastify from "fastify";
import {OperationsError,OperationsService,PORTAL_PASSTHROUGH,SCHEDULE_SYNC_WORKER_ID,WRITE_COMMANDS,authorize,commandSchema,type Actor,type Command} from "@egc/operations";
import {SCHEDULE_SYNC_WORKER_ACTOR_ID,registerScheduleSyncWorker,runScheduleSyncTick,scheduleSyncAlerts,startScheduleSyncWorker,type ScheduleSyncExecute,type ScheduleSyncResult} from "./schedule-sync-worker.js";

type Json=Record<string,unknown>;
const NOW=Date.parse("2026-09-22T18:00:00.000Z");
const WORKER:Actor={id:"schedule-sync-worker",kind:"integration",role:"integration",workspace:"egc"};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const item=(id:string,extra:Json={})=>({portalVisitId:id,requestId:`dispatch-key-${id}`,expectedRevision:`2026-09-22T17:00:00.000000Z-${id}`,type:"job",syncStatus:"pending",syncAttempts:0,...extra});
const due=(items:Json[],extra:Json={})=>({ok:true,authority:"employee_hub",items,counts:{due:items.length},coverage:{complete:true},heartbeat:true,...extra});
const verified=(command:Json)=>({ok:true,authority:"employee_hub",providerSync:"verified",portalVisitId:command.portalVisitId,appointmentId:"appointment-synthetic"});
/** The real OperationsService (contract parse, authorize, passthrough) over a fake Hub and a fake provider sync. */
function operations({hub=async(_actor:Actor,command:Json):Promise<Json>=>command.command==="schedule.sync_due"?due([item("visit-a"),item("visit-b")]):{ok:true,authority:"employee_hub",syncStatus:"error"},sync=async(_actor:Actor,command:Json):Promise<Json>=>verified(command)}:{hub?:(actor:Actor,command:Json)=>Promise<Json>;sync?:(actor:Actor,command:Json)=>Promise<Json>}={}){
 const portalRead=vi.fn(async(actor:Actor,command:Command)=>hub(actor,command as unknown as Json));
 const syncSchedule=vi.fn(async(actor:Actor,command:Json)=>sync(actor,command));
 const service=new OperationsService(null as never,{workspace:"egc",portalRead,syncSchedule:syncSchedule as never});
 const execute:ScheduleSyncExecute=(actor,body,requestId)=>service.execute(actor,body,requestId);
 return {service,execute,portalRead,syncSchedule,hubCalls:()=>portalRead.mock.calls.map(([,command])=>command as unknown as Json)};
}
const tick=(execute:ScheduleSyncExecute,extra:Partial<Parameters<typeof runScheduleSyncTick>[0]>={})=>runScheduleSyncTick({execute,now:()=>NOW,...extra});
const EMPTY_BACKLOG={owned:0,backingOff:0,parked:0,oldestFailureMinutes:null};

describe("schedule sync contract",()=>{
 it("adds an integration-only read and failure writer that the API forwards to the Hub",()=>{
  expect(SCHEDULE_SYNC_WORKER_ACTOR_ID).toBe(SCHEDULE_SYNC_WORKER_ID);
  expect(commandSchema.parse({command:"schedule.sync_due"})).toEqual({command:"schedule.sync_due",limit:25});
  for(const bad of [{command:"schedule.sync_due",limit:26},{command:"schedule.sync_due",limit:0},{command:"schedule.sync_due",jobId:"visit"}])expect(commandSchema.safeParse(bad).success).toBe(false);
  const failed={command:"schedule.sync_failed",requestId:"0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b",portalVisitId:"visit-a",expectedRevision:"r1",syncRequestId:"walkthrough-handoff:0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b",code:"appointment_outcome_unknown"};
  expect(commandSchema.parse(failed)).toEqual(failed);
  for(const change of [{code:"Provider said: token=synthetic"},{syncRequestId:"has spaces"},{portalVisitId:"a/b"},{requestId:"not-a-uuid"},{expectedRevision:""},{extra:true}])expect(commandSchema.safeParse({...failed,...change}).success,JSON.stringify(change)).toBe(false);
  expect([WRITE_COMMANDS.has("schedule.sync_failed"),WRITE_COMMANDS.has("schedule.sync_due"),PORTAL_PASSTHROUGH.has("schedule.sync_due"),PORTAL_PASSTHROUGH.has("schedule.sync_failed")]).toEqual([true,false,true,true]);
 });

 it("lets only the schedule-sync worker principal call the queue commands",()=>{
  const failed=commandSchema.parse({command:"schedule.sync_failed",requestId:"0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b",portalVisitId:"visit-a",expectedRevision:"r1",syncRequestId:"key",code:"schedule_provider_sync_unavailable"});
  for(const command of [commandSchema.parse({command:"schedule.sync_due"}),failed]){
   expect(()=>authorize(WORKER,command,"egc")).not.toThrow();
   for(const actor of [{...WORKER,id:"booking-reconciler"},{...WORKER,id:"mcp:chatgpt"},{...WORKER,id:"hub-schedule:zacb"},{id:"zacb",kind:"human",role:"owner",workspace:"egc"},{id:"tylerg",kind:"human",role:"manager",workspace:"egc"}] as Actor[])
    expect(()=>authorize(actor,command,"egc"),actor.id).toThrow("schedule_sync_queue_internal_only");
   expect(()=>authorize({...WORKER,workspace:"other"},command,"egc")).toThrow("workspace_forbidden");
  }
 });

 it("forwards the queue commands to the Hub unchanged and refuses other principals before any Hub call",async()=>{
  const o=operations();
  await o.service.execute(WORKER,{command:"schedule.sync_due"},"0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b");
  expect(o.portalRead).toHaveBeenCalledWith(WORKER,{command:"schedule.sync_due",limit:25});
  await expect(o.service.execute({id:"zacb",kind:"human",role:"owner",workspace:"egc"},{command:"schedule.sync_due"},"1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d")).rejects.toMatchObject({code:"schedule_sync_queue_internal_only",status:403});
  await expect(o.service.execute(WORKER,{command:"schedule.sync_due"},"not-a-uuid")).rejects.toMatchObject({code:"request_id_required"});
  expect(o.portalRead).toHaveBeenCalledTimes(1);
 });
});

describe("schedule sync tick",()=>{
 it("syncs each due visit with its own sync key and automations off",async()=>{
  const o=operations(),ids=["0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b","1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d","2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"];
  const result=await tick(o.execute,{requestId:()=>ids.shift()!});
  expect(result).toEqual({status:"completed",code:"",counts:{due:2,selected:2,synced:2,notNeeded:0,failed:0,conflicts:0,stateConflicts:0,unrecorded:0,deferred:0,complete:true,heartbeat:true},backlog:EMPTY_BACKLOG});
  expect(o.syncSchedule.mock.calls.map(([actor,command])=>[actor,command])).toEqual([[WORKER,{command:"schedule.sync_provider",portalVisitId:"visit-a",requestId:"dispatch-key-visit-a",runAutomations:false}],[WORKER,{command:"schedule.sync_provider",portalVisitId:"visit-b",requestId:"dispatch-key-visit-b",runAutomations:false}]]);
  expect(o.hubCalls()).toEqual([{command:"schedule.sync_due",limit:25}]);
 });

 it("hands every failure back to the Hub with the selected revision and a redacted code",async()=>{
  const failures:Record<string,unknown>={
   "visit-known":new OperationsError("schedule_provider_contact_mismatch",409),
   "visit-crash":new Error("socket hang up token=synthetic-secret Synthetic Customer"),
  };
  const o=operations({hub:async(_actor,command)=>command.command==="schedule.sync_due"?due([item("visit-known"),item("visit-crash"),item("visit-odd"),item("visit-cancelled")]):{ok:true,authority:"employee_hub",syncStatus:"error"},
   sync:async(_actor,command)=>{const id=String(command.portalVisitId);if(failures[id])throw failures[id];if(id==="visit-odd")return {...verified(command),portalVisitId:"someone-else"};return {ok:true,authority:"employee_hub",providerSync:"not_needed",portalVisitId:id,appointmentId:null};}});
  const result=await tick(o.execute);
  expect(result.counts).toMatchObject({selected:4,synced:0,notNeeded:1,failed:3,conflicts:0,unrecorded:0});
  const written=o.hubCalls().filter(command=>command.command==="schedule.sync_failed");
  expect(written.map(({portalVisitId,expectedRevision,syncRequestId,code})=>({portalVisitId,expectedRevision,syncRequestId,code}))).toEqual([
   {portalVisitId:"visit-known",expectedRevision:item("visit-known").expectedRevision,syncRequestId:"dispatch-key-visit-known",code:"schedule_provider_contact_mismatch"},
   {portalVisitId:"visit-crash",expectedRevision:item("visit-crash").expectedRevision,syncRequestId:"dispatch-key-visit-crash",code:"schedule_provider_sync_unavailable"},
   {portalVisitId:"visit-odd",expectedRevision:item("visit-odd").expectedRevision,syncRequestId:"dispatch-key-visit-odd",code:"schedule_provider_response_unverified"}]);
  for(const command of written)expect(command.requestId).toMatch(UUID);
  expect(JSON.stringify([result,written])).not.toMatch(/token|synthetic-secret|Synthetic Customer/);
 });

 it("leaves a visit that changed since selection to the next tick and stops when the Hub cannot record a backoff",async()=>{
  let failedWrites=0;
  const o=operations({hub:async(_actor,command)=>{
   if(command.command==="schedule.sync_due")return due([item("visit-a"),item("visit-b"),item("visit-c"),item("visit-d")]);
   failedWrites++;
   if(command.portalVisitId==="visit-a")throw new OperationsError("schedule_revision_conflict",409);
   throw new OperationsError("portal_authority_unavailable",503);
  },sync:async()=>{throw new OperationsError("schedule_provider_sync_unavailable",503);}});
  expect((await tick(o.execute)).counts).toMatchObject({selected:4,failed:0,conflicts:1,unrecorded:1,deferred:2});
  expect([o.syncSchedule.mock.calls.length,failedWrites]).toEqual([2,2]);
 });

 it("treats only a visit changed since selection as a benign conflict",async()=>{
  const answers:Record<string,OperationsError>={"visit-a":new OperationsError("schedule_sync_changed_since_selection",409),"visit-b":new OperationsError("schedule_sync_not_pending",409)};
  const o=operations({hub:async(_actor,command)=>{
   if(command.command==="schedule.sync_due")return due([item("visit-a"),item("visit-b"),item("visit-c")]);
   throw answers[String(command.portalVisitId)];
  },sync:async()=>{throw new OperationsError("schedule_provider_sync_unavailable",503);}});
  const result=await tick(o.execute);
  expect(result).toMatchObject({status:"completed",counts:{selected:3,conflicts:1,unrecorded:1,deferred:1}});
  expect(o.syncSchedule).toHaveBeenCalledTimes(2);
 });

 it("never counts a provider state conflict as a benign change, whatever the Hub answers to the failure",async()=>{
  // visit-a: the Hub re-queued the drifted visit, so its failure write is a revision conflict; visit-b: the failure is recorded.
  // visit-d: the sync bound, then read the appointment back holding another writer's stale time
  // (schedule_provider_drift) and re-queued the visit, so its failure write is a revision conflict too.
  const o=operations({hub:async(_actor,command)=>{
   if(command.command==="schedule.sync_due")return due([item("visit-a"),item("visit-b"),item("visit-c"),item("visit-d")]);
   if(command.portalVisitId==="visit-a"||command.portalVisitId==="visit-d")throw new OperationsError("schedule_revision_conflict",409);
   if(command.portalVisitId==="visit-c")throw new OperationsError("schedule_sync_changed_since_selection",409);
   return {ok:true,authority:"employee_hub",syncStatus:"error"};
  },sync:async(_actor,command)=>{
   if(command.portalVisitId==="visit-c")throw new OperationsError("schedule_revision_conflict",409);
   if(command.portalVisitId==="visit-d")throw new OperationsError("schedule_provider_drift",409);
   throw new OperationsError("schedule_provider_state_conflict",409);
  }});
  const result=await tick(o.execute);
  expect(result.counts).toMatchObject({selected:4,failed:1,conflicts:1,stateConflicts:3,unrecorded:0});
  expect(o.hubCalls().filter(command=>command.command==="schedule.sync_failed").map(command=>[command.portalVisitId,command.code])).toEqual([["visit-a","schedule_provider_state_conflict"],["visit-b","schedule_provider_state_conflict"],["visit-c","schedule_revision_conflict"],["visit-d","schedule_provider_drift"]]);
  expect(o.syncSchedule.mock.calls.every(([,command])=>command.runAutomations===false)).toBe(true);
  expect(scheduleSyncAlerts(result)).toEqual(["HighLevel held a different schedule than the Hub"]);
 });

 it("reports the Hub's backlog: owned, backing off, parked and the age of the oldest failure",async()=>{
  const o=operations({hub:async(_actor,command)=>command.command==="schedule.sync_due"?due([item("visit-a")],{counts:{due:1,owned:5,backingOff:3,parked:1},oldestFailureAt:"2026-09-22T16:30:00.000Z"}):{ok:true}});
  expect((await tick(o.execute)).backlog).toEqual({owned:5,backingOff:3,parked:1,oldestFailureMinutes:90});
  for(const [counts,oldestFailureAt] of [[{owned:-1,backingOff:"3",parked:1.5},"soon"],[undefined,undefined]] as const){
   const odd=operations({hub:async(_actor,command)=>command.command==="schedule.sync_due"?due([],{counts,oldestFailureAt}):{ok:true}});
   expect((await tick(odd.execute)).backlog).toEqual(EMPTY_BACKLOG);
  }
 });

 it("stops at the next recorded failure when the Hub flag is turned off mid-tick, so page loads own the rest",async()=>{
  // schedule.sync_provider never reads the flag; only the Hub's queue commands answer disabled.
  const o=operations({hub:async(_actor,command)=>{
   if(command.command==="schedule.sync_due")return due([item("visit-a"),item("visit-b"),item("visit-c")]);
   if(command.portalVisitId==="visit-a")return {ok:true,authority:"employee_hub",syncStatus:"error"};
   throw new OperationsError("schedule_sync_queue_disabled",409);
  },sync:async()=>{throw new OperationsError("schedule_provider_sync_unavailable",503);}});
  const result=await tick(o.execute);
  expect(result).toEqual({status:"disabled",code:"schedule_sync_queue_disabled",counts:{due:3,selected:3,synced:0,notNeeded:0,failed:1,conflicts:0,stateConflicts:0,unrecorded:0,deferred:2,complete:true,heartbeat:true},backlog:EMPTY_BACKLOG});
  expect(o.syncSchedule).toHaveBeenCalledTimes(2);
  expect(o.hubCalls().filter(command=>command.command==="schedule.sync_failed").map(command=>command.portalVisitId)).toEqual(["visit-a","visit-b"]);
 });

 it("reports whether the Hub recorded the worker's check-in",async()=>{
  const o=operations({hub:async(_actor,command)=>command.command==="schedule.sync_due"?due([],{heartbeat:false}):{ok:true}});
  expect((await tick(o.execute)).counts).toMatchObject({selected:0,heartbeat:false});
 });

 it("stops starting new syncs at the deadline",async()=>{
  let clock=NOW;
  const o=operations({hub:async(_actor,command)=>command.command==="schedule.sync_due"?due([item("visit-a"),item("visit-b"),item("visit-c")]):{ok:true},sync:async(_actor,command)=>{clock+=60_000;return verified(command);}});
  expect((await tick(o.execute,{now:()=>clock,deadlineMs:100_000})).counts).toMatchObject({synced:2,deferred:1});
 });

 it("classifies queue outcomes and never syncs from an unverifiable answer",async()=>{
  const cases:Array<[()=>Promise<Json>,Partial<ScheduleSyncResult>]>=[
   [async()=>{throw new OperationsError("schedule_sync_queue_disabled",409);},{status:"disabled",code:"schedule_sync_queue_disabled"}],
   [async()=>{throw new OperationsError("schedule_sync_queue_internal_only",403);},{status:"rejected",code:"schedule_sync_queue_internal_only"}],
   [async()=>{throw new OperationsError("schedule_sync_queue_incomplete",503);},{status:"failed",code:"schedule_sync_queue_incomplete"}],
   [async()=>{throw new Error("ECONNRESET token=synthetic");},{status:"failed",code:"schedule_sync_queue_unavailable"}],
   [async()=>due([item("visit-a"),item("visit-a")]),{status:"failed",code:"schedule_sync_queue_unverified"}],
   [async()=>due([item("_egc_schedule_lock_2026-09-30")]),{status:"failed",code:"schedule_sync_queue_unverified"}],
   [async()=>due([item("visit-a",{requestId:"has spaces"})]),{status:"failed",code:"schedule_sync_queue_unverified"}],
   [async()=>due([item("visit-a",{expectedRevision:""})]),{status:"failed",code:"schedule_sync_queue_unverified"}],
   [async()=>due(Array.from({length:26},(_,i)=>item(`visit-${i}`))),{status:"failed",code:"schedule_sync_queue_unverified"}],
   [async()=>({...due([item("visit-a")]),authority:"provider"}),{status:"failed",code:"schedule_sync_queue_unverified"}],
   [async()=>({ok:true,authority:"employee_hub",items:{}}),{status:"failed",code:"schedule_sync_queue_unverified"}],
  ];
  for(const [answer,expected] of cases){
   const o=operations({hub:async(_actor,command)=>command.command==="schedule.sync_due"?answer():{ok:true}});
   const result=await tick(o.execute);
   expect(result).toMatchObject({...expected,counts:{}});
   expect(o.syncSchedule).not.toHaveBeenCalled();
   expect(JSON.stringify(result)).not.toContain("token");
  }
  const partial=operations({hub:async(_actor,command)=>command.command==="schedule.sync_due"?due([item("visit-a")],{coverage:{complete:false},counts:{due:1200}}):{ok:true}});
  expect((await tick(partial.execute)).counts).toMatchObject({due:1200,selected:1,synced:1,complete:false});
 });
});

describe("schedule sync loop",()=>{
 const stops:Array<()=>void>=[];
 beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);});
 afterEach(()=>{for(const stop of stops.splice(0))stop();vi.useRealTimers();});
 const completed=(counts:Record<string,number|boolean>={synced:1}):ScheduleSyncResult=>({status:"completed",code:"",counts});

 it("stays off unless the flag is exactly true",async()=>{
  const tickSpy=vi.fn(async()=>completed());
  for(const env of [{},{EGC_SCHEDULE_SYNC_WORKER:"TRUE"},{EGC_SCHEDULE_SYNC_WORKER:"1"},{EGC_SCHEDULE_SYNC_WORKER:"false"}])stops.push(startScheduleSyncWorker({env,tick:tickSpy,record:vi.fn(async()=>undefined),logger:{error:vi.fn()}}));
  await vi.advanceTimersByTimeAsync(60*60_000);
  expect(tickSpy).not.toHaveBeenCalled();
 });

 it("runs at once and every 2 minutes, never overlapping a tick still running",async()=>{
  let finish:()=>void=()=>{};
  const tickSpy=vi.fn(()=>new Promise<ScheduleSyncResult>(resolve=>{finish=()=>resolve(completed());}));
  const record=vi.fn(async()=>undefined),logger={error:vi.fn(),info:vi.fn()};
  const stop=startScheduleSyncWorker({env:{EGC_SCHEDULE_SYNC_WORKER:"true"},tick:tickSpy,record,logger,now:()=>Date.now()});stops.push(stop);
  await vi.advanceTimersByTimeAsync(10*60_000);
  expect(tickSpy).toHaveBeenCalledTimes(1);
  finish();await vi.advanceTimersByTimeAsync(0);
  expect(record).toHaveBeenCalledWith("schedule_sync:last_success","2026-09-22T18:10:00.000Z");
  await vi.advanceTimersByTimeAsync(2*60_000);
  expect(tickSpy).toHaveBeenCalledTimes(2);
  finish();stop();
  await vi.advanceTimersByTimeAsync(60*60_000);
  expect(tickSpy).toHaveBeenCalledTimes(2);
  expect(logger.error).not.toHaveBeenCalled();
 });

 it("records aggregate outcomes only and flags ticks that did not finish",async()=>{
  const results:ScheduleSyncResult[]=[{status:"failed",code:"schedule_sync_queue_unavailable",counts:{}},completed({due:3,selected:3,synced:1,failed:1,unrecorded:1,deferred:1}),{status:"disabled",code:"schedule_sync_queue_disabled",counts:{}}];
  const writes:Array<[string,string]>=[],logger={error:vi.fn(),info:vi.fn()};
  let calls=0;
  const tickSpy=vi.fn(async()=>{const result=results[calls++];if(!result)throw new Error("token=synthetic visit-private");return result;});
  stops.push(startScheduleSyncWorker({env:{EGC_SCHEDULE_SYNC_WORKER:"true"},tick:tickSpy,record:async(key,value)=>{writes.push([key,value]);},logger,now:()=>NOW}));
  await vi.advanceTimersByTimeAsync(3*2*60_000);
  expect(tickSpy).toHaveBeenCalledTimes(4);
  expect(writes.map(([key])=>key)).toEqual(["schedule_sync:last_result","schedule_sync:last_result","schedule_sync:last_success","schedule_sync:last_result"]);
  expect(JSON.parse(writes[1]![1])).toEqual({event:"schedule_sync",status:"completed",code:"",due:3,selected:3,synced:1,failed:1,unrecorded:1,deferred:1,observedAt:"2026-09-22T18:00:00.000Z"});
  expect(logger.error).toHaveBeenCalledTimes(3);
  expect(JSON.stringify([writes,logger.info.mock.calls,logger.error.mock.calls])).not.toMatch(/token|visit-private/);
 });

 it("records the backlog and logs one error when coverage is capped, every sync failed, HighLevel drifted or visits are parked",async()=>{
  const backlog={owned:4,backingOff:1,parked:0,oldestFailureMinutes:30};
  const results:ScheduleSyncResult[]=[
   {...completed({due:4,selected:2,synced:2,failed:0,complete:true}),backlog},
   {...completed({due:1200,selected:1,synced:1,failed:0,complete:false}),backlog},
   {...completed({due:2,selected:2,synced:0,failed:2,complete:true}),backlog},
   {...completed({due:1,selected:1,synced:0,failed:0,stateConflicts:1,complete:true}),backlog},
   {...completed({due:0,selected:0,synced:0,failed:0,complete:true}),backlog:{...backlog,parked:2}},
  ];
  const writes:Array<[string,string]>=[],logger={error:vi.fn(),info:vi.fn()};
  let calls=0;
  stops.push(startScheduleSyncWorker({env:{EGC_SCHEDULE_SYNC_WORKER:"true"},tick:async()=>results[calls++]??completed({}),record:async(key,value)=>{writes.push([key,value]);},logger,now:()=>NOW}));
  await vi.advanceTimersByTimeAsync(4*2*60_000);
  expect(calls).toBe(5);
  expect(JSON.parse(writes.find(([key])=>key==="schedule_sync:last_result")![1]).backlog).toEqual(backlog);
  expect(logger.error.mock.calls.map(([message])=>message)).toEqual([
   "Schedule sync needs attention: the queue scan was capped, so some visits were not considered. Inspect schedule_sync:last_result.",
   "Schedule sync needs attention: every selected sync failed. Inspect schedule_sync:last_result.",
   "Schedule sync needs attention: HighLevel held a different schedule than the Hub. Inspect schedule_sync:last_result.",
   "Schedule sync needs attention: visits stopped retrying and need a manager's Retry in the Hub. Inspect schedule_sync:last_result."]);
 });
});

describe("API wiring",()=>{
 const apps:ReturnType<typeof Fastify>[]=[];
 afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
 it("starts with the server when the flag and the Hub bridge are present, and stops on close",async()=>{
  const app=Fastify();apps.push(app);
  const execute=vi.fn<ScheduleSyncExecute>(async()=>{throw new OperationsError("schedule_sync_queue_disabled",409);}),record=vi.fn(async()=>undefined);
  registerScheduleSyncWorker(app,{env:{EGC_SCHEDULE_SYNC_WORKER:"true",EGC_OPERATIONS_WORKSPACE:"egc"},execute,record,intervalMs:60_000});
  await app.ready();
  await vi.waitFor(()=>expect(record).toHaveBeenCalledWith("schedule_sync:last_result",expect.stringContaining('"status":"disabled"')));
  expect(execute).toHaveBeenCalledWith(WORKER,{command:"schedule.sync_due",limit:25},expect.stringMatching(UUID));
 });
 it("does nothing without the flag and only warns when the bridge is missing",async()=>{
  for(const [env,execute,warned] of [[{},vi.fn(),false],[{EGC_SCHEDULE_SYNC_WORKER:"true"},undefined,true]] as const){
   const app=Fastify();apps.push(app);const warn=vi.spyOn(app.log,"warn");
   registerScheduleSyncWorker(app,{env,execute,record:vi.fn(async()=>undefined)});
   await app.ready();
   expect(warn.mock.calls.length>0).toBe(warned);
   if(execute)expect(execute).not.toHaveBeenCalled();
  }
 });
});
