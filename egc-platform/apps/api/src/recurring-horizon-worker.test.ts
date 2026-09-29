import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@egc/database",()=>({schema:{syncCursors:{key:"key"}},getDb:()=>{throw new Error("tests inject the cursor writer");}}));
import {existsSync,readFileSync} from "node:fs";
import Fastify from "fastify";
import {SERVICE_ORIGINS,servicePublicKeySet,verifyRequest,verifyServiceRequest} from "@egc/operations";
import {portalAdapter} from "./operations.js";
import {RecurringHorizonError,recurringHorizonClient,registerRecurringHorizon,runRecurringHorizon,startRecurringHorizonWorker,type RecurringHorizonSummary,type RecurringHorizonWorkerOptions} from "./recurring-horizon-worker.js";

const NOW=Date.parse("2026-09-22T12:00:00.000Z");
const LEGACY="synthetic-legacy-portal-signing-secret-0123456789";
const ROOT="synthetic-api-bearer-root-secret-0123456789abcdef";
const worker={id:"recurring-horizon-worker",kind:"integration",role:"integration",workspace:"egc"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const page=(extra:Record<string,unknown>={})=>({ok:true,authority:"employee_hub",command:"recurring.extend_horizon",enabled:true,plans:[],totals:{created:0,conflicts:0,adopted:0,updated:0,kept:0,priced:0,blocked:0,errors:0,attempts:0},complete:true,more:false,after:null,...extra});
function capture(response:()=>Response=()=>reply(page())){
  const calls:{url:string;init:RequestInit;envelope:string}[]=[];
  const fetcher=vi.fn(async(url:URL|string|Request,init?:RequestInit)=>{calls.push({url:String(url),init:init!,envelope:JSON.parse(String(init!.body)).envelope});return response();}) as unknown as typeof fetch;
  return {calls,fetcher};
}
const legacy=(fetcher:typeof fetch)=>recurringHorizonClient(portalAdapter("https://hub.example.test",LEGACY,"egc",fetcher,{}).read,"egc");
const stops:Array<()=>void>=[];
const apps:Array<ReturnType<typeof Fastify>>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);});
afterEach(async()=>{for(const stop of stops.splice(0))stop();for(const app of apps.splice(0))await app.close();vi.useRealTimers();});

describe("egc-api signs recurring.extend_horizon over its existing Hub bridge",()=>{
 it("signs the legacy portal envelope as the worker actor with the API clock",async()=>{
  const {calls,fetcher}=capture();
  const result=await legacy(fetcher)({command:"recurring.extend_horizon",maxPlans:10,limit:4});
  expect(result.more).toBe(false);expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://hub.example.test/api/operations-portal");expect(calls[0]!.init).toMatchObject({method:"POST",redirect:"error"});
  const claims=verifyRequest(calls[0]!.envelope,{portal:LEGACY},NOW,"egc-portal");
  expect(claims.actor).toEqual(worker);expect(claims.iat).toBe(NOW/1000);expect(claims.iss).toBe("portal");
  expect(claims.request.body).toEqual({command:"recurring.extend_horizon",maxPlans:10,limit:4});
  expect(JSON.stringify(calls)).not.toContain(LEGACY);
 });
 it("signs v2 service envelopes with the API service key, only for the pinned Hub origin",async()=>{
  const {calls,fetcher}=capture(),env={EGC_OPERATIONS_SERVICE_AUTH:"v2",API_BEARER_TOKEN:ROOT};
  await recurringHorizonClient(portalAdapter(SERVICE_ORIGINS.hub,"","egc",fetcher,env).read,"egc")({command:"recurring.extend_horizon",after:"plan_b"});
  const key=(await servicePublicKeySet({service:"api",rootSecret:ROOT,workspace:"egc"})).keys[0]!;
  const claims=await verifyServiceRequest(calls[0]!.envelope,{service:"hub",workspace:"egc",path:"/api/operations-portal",now:NOW,consumeNonce:async()=>true,resolveKey:async()=>key});
  expect(claims.actor).toEqual(worker);expect(claims.iat).toBe(NOW/1000);expect(claims.request.body).toEqual({command:"recurring.extend_horizon",after:"plan_b"});
  expect(calls[0]!.url).toBe(SERVICE_ORIGINS.hub+"/api/operations-portal");
  expect(()=>portalAdapter("https://hub.example.test","","egc",fetcher,env)).toThrow();
 });
 it("sends nothing but a valid horizon command",async()=>{
  const {calls,fetcher}=capture(),call=legacy(fetcher);
  for(const body of [{command:"status"},{command:"recurring.extend_horizon",maxPlans:99},{command:"recurring.extend_horizon",now:"2027-01-01T00:00:00Z"}])await expect(call(body)).rejects.toMatchObject({code:"recurring_horizon_invalid",status:400});
  expect(calls).toHaveLength(0);
 });
 it("relays only snake_case Hub codes and never raw upstream text",async()=>{
  const cases:[()=>Response,string,number][]=[[()=>reply({error:"recurring_horizon_internal_only"},403),"recurring_horizon_internal_only",403],[()=>reply({error:"dispatch_storage_unavailable"},503),"dispatch_storage_unavailable",503],[()=>reply({error:"token=synthetic-secret private@example.invalid"},500),"portal_authority_unavailable",503],[()=>new Response("<html>",{status:502}),"recurring_bridge_invalid_response",503],[()=>reply(["not an object"]),"recurring_bridge_invalid_response",503]];
  for(const [response,code,status] of cases){const {fetcher}=capture(response);await expect(legacy(fetcher)({command:"recurring.extend_horizon"})).rejects.toMatchObject({code,status});}
  const offline=vi.fn(async()=>{throw new Error("socket hang up token=synthetic-secret");}) as unknown as typeof fetch;
  await expect(legacy(offline)({command:"recurring.extend_horizon"})).rejects.toMatchObject({code:"recurring_bridge_unavailable",status:503});
 });
 it("gives each Hub call 25 seconds rather than the bridge's 15-second default",async()=>{
  const timeouts:number[]=[],timeout=vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{timeouts.push(ms);return new AbortController().signal;});
  const {fetcher}=capture();
  await legacy(fetcher)({command:"recurring.extend_horizon"});
  expect(timeouts).toEqual([25_000]);timeout.mockRestore();
 });
 it("is the only place the run lives: egc-worker holds no bridge signing secret for it",()=>{
  expect(existsSync(new URL("../../worker/src/recurring-horizon-worker.ts",import.meta.url))).toBe(false);
  expect(readFileSync(new URL("../../worker/src/worker.ts",import.meta.url),"utf8")).not.toMatch(/recurring|API_BEARER_TOKEN|EGC_OPERATIONS_PORTAL_SIGNING_SECRET/);
  expect(readFileSync(new URL("./operations.ts",import.meta.url),"utf8")).toContain("registerRecurringHorizon(app,{env,read:bridge.read,workspace})");
 });
});

describe("paging a horizon run",()=>{
 it("follows the Hub cursor until no plan is left and sums only aggregate counts",async()=>{
  const call=vi.fn().mockResolvedValueOnce(page({more:true,after:"plan_b",complete:false,totals:{created:3,conflicts:1,updated:2,kept:1,priced:3,attempts:4,blocked:0,errors:0,adopted:0}}))
   .mockResolvedValueOnce(page({more:true,after:null,complete:false,totals:{created:1,kept:4,attempts:5}})).mockResolvedValueOnce(page({totals:{created:0,priced:1,blocked:1,attempts:1}}));
  const result=await runRecurringHorizon(call,{maxPlans:5,limit:4});
  expect(call.mock.calls.map(([body])=>body)).toEqual([{command:"recurring.extend_horizon",maxPlans:5,limit:4},{command:"recurring.extend_horizon",after:"plan_b",maxPlans:5,limit:4},{command:"recurring.extend_horizon",maxPlans:5,limit:4}]);
  expect(result).toEqual({enabled:true,complete:true,rounds:3,truncated:false,created:4,conflicts:1,adopted:0,updated:2,kept:5,priced:4,blocked:1,errors:0,attempts:10});
 });
 it("stops a tick after maxRounds, reports a disabled Hub and rejects malformed pages",async()=>{
  const endless=vi.fn(async()=>page({more:true,after:"plan_z",complete:false}));
  expect(await runRecurringHorizon(endless,{maxRounds:3})).toMatchObject({rounds:3,truncated:true,complete:false});expect(endless).toHaveBeenCalledTimes(3);
  expect(await runRecurringHorizon(async()=>({ok:true,authority:"employee_hub",command:"recurring.extend_horizon",enabled:false,plans:[],complete:true,more:false,after:null}))).toMatchObject({enabled:false,complete:true,rounds:1});
  for(const bad of [{},page({authority:"other"}),page({more:"yes"}),page({after:5}),page({totals:null}),page({command:"hub.staff.roster"})])await expect(runRecurringHorizon(async()=>bad as Record<string,unknown>)).rejects.toMatchObject({code:"recurring_bridge_invalid_response"});
 });
});

describe("hourly run inside egc-api",()=>{
 const done:RecurringHorizonSummary={enabled:true,complete:true,rounds:1,truncated:false,created:2,conflicts:0,adopted:0,updated:0,kept:0,priced:2,blocked:0,errors:0,attempts:2};
 it("does not start without EGC_RECURRING_PLANS_ENABLED exactly true",async()=>{
  for(const env of [{},{EGC_RECURRING_PLANS_ENABLED:"TRUE"},{EGC_RECURRING_PLANS_ENABLED:"1"}]){
   const run=vi.fn(),mark=vi.fn();stops.push(startRecurringHorizonWorker({env,run,mark}));await vi.advanceTimersByTimeAsync(2*3_600_000);expect(run).not.toHaveBeenCalled();expect(mark).not.toHaveBeenCalled();
   const app=Fastify(),read=vi.fn(),start=vi.fn();apps.push(app);
   expect(registerRecurringHorizon(app,{env,read,workspace:"egc",start})).toBe(false);await app.ready();expect(start).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
  }
 });
 it("starts with the API, calls the Hub as the worker actor and stops on close",async()=>{
  const read=vi.fn(async()=>page({totals:{created:1,attempts:1}})),marks:string[]=[];
  const start=(options:RecurringHorizonWorkerOptions)=>startRecurringHorizonWorker({...options,mark:async key=>{marks.push(key);}});
  const app=Fastify();apps.push(app);
  expect(registerRecurringHorizon(app,{env:{EGC_RECURRING_PLANS_ENABLED:"true"},read,workspace:"egc",start})).toBe(true);
  expect(read).not.toHaveBeenCalled();
  await app.ready();await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(1);expect(read.mock.calls[0]).toEqual([worker,{command:"recurring.extend_horizon",maxPlans:10,limit:4},{timeoutMs:25_000}]);
  expect(marks).toEqual(["recurring_horizon:last_attempt","recurring_horizon:last_success","recurring_horizon:last_result"]);
  await vi.advanceTimersByTimeAsync(3_600_000);expect(read).toHaveBeenCalledTimes(2);
  await app.close();apps.splice(apps.indexOf(app),1);
  await vi.advanceTimersByTimeAsync(2*3_600_000);expect(read).toHaveBeenCalledTimes(2);
 });
 it("runs at start and then hourly, records cursors and logs aggregates only",async()=>{
  const run=vi.fn(async()=>done),marks:[string,string][]=[],logger={log:vi.fn(),error:vi.fn()};
  stops.push(startRecurringHorizonWorker({env:{EGC_RECURRING_PLANS_ENABLED:"true"},run,mark:async(key,value)=>{marks.push([key,value]);},logger,now:()=>new Date(NOW)}));
  await vi.advanceTimersByTimeAsync(1);expect(run).toHaveBeenCalledTimes(1);
  expect(marks.map(([key])=>key)).toEqual(["recurring_horizon:last_attempt","recurring_horizon:last_success","recurring_horizon:last_result"]);
  expect(JSON.parse(marks[2]![1])).toEqual({at:"2026-09-22T12:00:00.000Z",...done});
  expect(JSON.parse(logger.log.mock.calls[0]![0])).toEqual({event:"recurring_horizon_run",...done});
  await vi.advanceTimersByTimeAsync(3_599_000);expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);expect(run).toHaveBeenCalledTimes(2);
 });
 it("never overlaps a slow run and records an incomplete run separately",async()=>{
  let finish!:(value:RecurringHorizonSummary)=>void;const run=vi.fn(()=>new Promise<RecurringHorizonSummary>(resolve=>{finish=resolve;})),marks:string[]=[];
  stops.push(startRecurringHorizonWorker({env:{EGC_RECURRING_PLANS_ENABLED:"true"},intervalMs:1_000,run,mark:async key=>{marks.push(key);},logger:{log:vi.fn(),error:vi.fn()}}));
  await vi.advanceTimersByTimeAsync(5_000);expect(run).toHaveBeenCalledTimes(1);
  finish({...done,complete:false,truncated:true});await vi.advanceTimersByTimeAsync(1_000);
  expect(marks).toContain("recurring_horizon:last_incomplete");expect(marks).not.toContain("recurring_horizon:last_success");expect(run).toHaveBeenCalledTimes(2);
 });
 it("records a sanitized failure and retries on the next hour",async()=>{
  const logger={log:vi.fn(),error:vi.fn()},marks:[string,string][]=[];
  const run=vi.fn().mockRejectedValueOnce(new Error("token=synthetic-secret private@example.invalid")).mockRejectedValueOnce(new RecurringHorizonError("recurring_horizon_internal_only",403)).mockResolvedValue(done);
  stops.push(startRecurringHorizonWorker({env:{EGC_RECURRING_PLANS_ENABLED:"true"},run,mark:async(key,value)=>{marks.push([key,value]);},logger,now:()=>new Date(NOW)}));
  await vi.advanceTimersByTimeAsync(2*3_600_000);
  expect(run).toHaveBeenCalledTimes(3);
  expect(marks.filter(([key])=>key==="recurring_horizon:last_failure").map(([,value])=>JSON.parse(value).code)).toEqual(["recurring_horizon_failed","recurring_horizon_internal_only"]);
  expect(logger.error).toHaveBeenCalledTimes(2);expect(JSON.stringify([logger.error.mock.calls,logger.log.mock.calls,marks])).not.toContain("synthetic-secret");
  expect(marks.some(([key])=>key==="recurring_horizon:last_success")).toBe(true);
 });
});
