import {afterEach,describe,it,expect,vi} from "vitest";
import Fastify from "fastify";
import {randomUUID} from "node:crypto";
import {signRequest,type SignedClaims} from "@egc/operations";

// GHL-ALIGN, production wiring: without an injected service the API builds its own reconciler only when
// EGC_OPERATIONS_INBOUND_TASKS_ENABLED is exactly "true". Storage and the booking tick are inert fakes here.
const f=vi.hoisted(()=>({constructed:0,run:(async()=>({})) as (...args:unknown[])=>Promise<unknown>}));
vi.mock("./inbound-actions.js",async importOriginal=>{
  const actual=await importOriginal<typeof import("./inbound-actions.js")>();
  class InboundActionReconciler{constructor(){f.constructed++;}run(...args:unknown[]){return f.run(...args);}}
  return {...actual,InboundActionReconciler};
});
vi.mock("./booking-worker.js",()=>({reconcileHubBookings:vi.fn(async()=>({ok:true}))}));
vi.mock("@egc/database",async importOriginal=>{
  const actual=await importOriginal<Record<string,unknown>>();
  const chain:unknown=new Proxy(function(){},{get:(_target,prop)=>prop==="then"?undefined:chain,apply:()=>chain});
  return {...actual,getDb:()=>chain};
});
import {registerOperationsRoutes} from "./operations.js";

const key="isolated-api-signing-key-only-01234567890123456789";
const base={EGC_OPERATIONS_ENABLED:"true",EGC_PORTAL_ORIGIN:"https://portal.example.test",EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key};
const reconcile=():SignedClaims=>({v:1,iss:"portal",aud:"egc-operations",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:{id:"test-owner",role:"owner",kind:"human",workspace:"egc"},request:{requestId:randomUUID(),body:{command:"inbound.reconcile",limit:50,lookbackDays:1}}});
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{for(const a of apps.splice(0))await a.close();vi.unstubAllGlobals();});
async function boot(flag?:string){
  f.constructed=0;f.run=vi.fn(async()=>({ok:true,created:1}));
  vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("External HTTP forbidden in this test");}));
  const a=Fastify();apps.push(a);await registerOperationsRoutes(a,{env:{...base,...(flag===undefined?{}:{EGC_OPERATIONS_INBOUND_TASKS_ENABLED:flag})}});await a.ready();
  return a;
}
describe("GHL-ALIGN: the API's own inbound reconciler",()=>{
  it("is never built, never ticks and inbound.reconcile answers disabled unless the flag is exactly true",async()=>{
    for(const flag of [undefined,"","false","TRUE","1","yes"," true"]){
      const a=await boot(flag);
      const r=await a.inject({method:"POST",url:"/operations/rpc",payload:{envelope:signRequest(reconcile(),key)}});
      expect(r.json(),String(flag)).toMatchObject({ok:false,disabled:true,error:"inbound_tasks_disabled",message:"disabled: follow-ups live in HighLevel",created:0});
      expect(f.constructed,String(flag)).toBe(0);expect(f.run).not.toHaveBeenCalled();
    }
  });
  it("with the owner's opt-in it is built once, ticks at startup and serves inbound.reconcile",async()=>{
    const a=await boot("true");
    expect(f.constructed).toBe(1);await vi.waitFor(()=>expect(f.run).toHaveBeenCalledWith());
    const r=await a.inject({method:"POST",url:"/operations/rpc",payload:{envelope:signRequest(reconcile(),key)}});
    expect(r.json()).toEqual({ok:true,created:1});expect(f.run).toHaveBeenLastCalledWith({limit:50,lookbackDays:1});
  });
});
