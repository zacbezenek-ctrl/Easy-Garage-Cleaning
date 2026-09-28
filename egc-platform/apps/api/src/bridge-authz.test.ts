import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import type {Actor} from "@egc/operations";
import {portalAdapter} from "./operations.js";
const key="isolated-api-signing-key-only-01234567890123456789";
const actor:Actor={id:"mcp-oauth-grant:synthetic",kind:"integration",role:"integration",workspace:"egc"};
const NOW=Date.parse("2026-09-22T12:00:00.000Z");
beforeEach(()=>{vi.useFakeTimers({now:NOW,toFake:["Date"]});});
afterEach(()=>{vi.useRealTimers();});
const upstream=(status:number,body:unknown)=>vi.fn(async(_url:unknown,_options?:RequestInit)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}}));
const cancel={command:"schedule.mutate" as const,requestId:"6ba7b810-9dad-41d1-80b4-00c04fd430c8",mode:"cancel" as const,portalVisitId:"visit-a",portalCustomerId:"customer-a",expectedRevision:"r1",changes:{}};
describe("SEC-04 bridge refusals over the portal adapter",()=>{
 it("relays the Hub's policy and confirmation codes with their status",async()=>{
  for(const [status,error] of [[403,"bridge_role_forbidden"],[403,"bridge_integration_forbidden"],[403,"bridge_actor_invalid"],[403,"bridge_confirmation_required"],[400,"bridge_via_invalid"],[403,"confirm_token_invalid"],[403,"confirm_token_mismatch"],[410,"confirm_token_expired"],[409,"confirm_token_used"]] as const){
   const p=portalAdapter("https://portal.test",key,"egc",upstream(status,{error}) as unknown as typeof fetch,{});
   await expect(p.read(actor,cancel)).rejects.toMatchObject({code:error,status,details:{upstreamStatus:status}});
  }
 });
 it("still redacts malformed codes that only resemble them",async()=>{
  for(const error of ["bridge_","BRIDGE_ROLE_FORBIDDEN","bridgex_role","confirm_token_","confirm_tokens_used","confirm_invalid"]){
   const p=portalAdapter("https://portal.test",key,"egc",upstream(403,{error}) as unknown as typeof fetch,{});
   await expect(p.read(actor,cancel)).rejects.toMatchObject({code:"portal_authority_unavailable",status:403});
  }
 });
});
