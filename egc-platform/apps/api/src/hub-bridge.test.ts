import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {verifyRequest,type Actor} from "@egc/operations";
import {portalAdapter} from "./operations.js";
const key="isolated-api-signing-key-only-01234567890123456789";
const actor:Actor={id:"mcp-oauth-grant:synthetic",kind:"integration",role:"integration",workspace:"egc"};
const NOW=Date.parse("2026-09-22T12:00:00.000Z");
beforeEach(()=>{vi.useFakeTimers({now:NOW,toFake:["Date"]});});
afterEach(()=>{vi.useRealTimers();});
const upstream=(status:number,body:unknown)=>vi.fn(async(_url:unknown,_options?:RequestInit)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}}));
describe("hub registry commands over the portal bridge",()=>{
 it("forwards the exact hub command and signed actor, and returns the Hub authority result",async()=>{
  const f=upstream(200,{ok:true,authority:"employee_hub",staff:[{id:"crew1",name:"Synthetic Crew",role:"crew"}]});
  const p=portalAdapter("https://portal.test",key,"egc",f as unknown as typeof fetch,{});
  const command={command:"hub.staff.roster" as const,delegate:"zacb"};
  await expect(p.read(actor,command)).resolves.toMatchObject({authority:"employee_hub"});
  const claims=verifyRequest(JSON.parse(String(f.mock.calls[0]![1]!.body)).envelope,{portal:key},NOW,"egc-portal");
  expect(claims.iat).toBe(NOW/1000);
  expect(claims.actor).toEqual(actor);expect(claims.request.body).toEqual(command);
 });
 it("preserves hub and dispatch refusal codes and status instead of collapsing them",async()=>{
  for(const [status,error] of [[403,"hub_delegate_unverified"],[403,"hub_integration_write_forbidden"],[400,"hub_command_unknown"],[400,"dispatch_range_invalid"],[503,"dispatch_storage_unavailable"],[503,"hub_source_unavailable"]] as const){
   const p=portalAdapter("https://portal.test",key,"egc",upstream(status,{error}) as unknown as typeof fetch,{});
   await expect(p.read(actor,{command:"hub.dispatch.overview",view:"schedule",delegate:"zacb"})).rejects.toMatchObject({code:error,status:status>=500?503:status,details:{upstreamStatus:status}});
  }
 });
 it("still redacts unknown or malformed upstream codes",async()=>{
  for(const error of ["HUB_PRIVATE","hub_","dispatchx_detail","hub-delegate","postgres://secret@db",{nested:"hub_x"}]){
   const p=portalAdapter("https://portal.test",key,"egc",upstream(403,{error}) as unknown as typeof fetch,{});
   await expect(p.read(actor,{command:"hub.staff.roster",delegate:"zacb"})).rejects.toMatchObject({code:"portal_authority_unavailable",status:403});
  }
 });
});
