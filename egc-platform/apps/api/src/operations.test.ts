import {afterEach,describe,it,expect,vi} from "vitest";
import Fastify from "fastify";
import {randomUUID} from "node:crypto";
import {OperationsError,signRequest,type OperationsService,type SignedClaims} from "@egc/operations";
import {registerOperationsRoutes,portalAdapter} from "./operations.js";
const key="isolated-api-signing-key-only-01234567890123456789";
const env={EGC_OPERATIONS_ENABLED:"true",EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key};
const claim=():SignedClaims=>({v:1,iss:"portal",aud:"egc-operations",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:{id:"test-owner",role:"owner",kind:"human",workspace:"egc"},request:{requestId:randomUUID(),body:{command:"status"}}});
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{for(const a of apps.splice(0))await a.close();});
async function app(execute=vi.fn(async()=>({ok:true})),settings:NodeJS.ProcessEnv=env){const a=Fastify();apps.push(a);await registerOperationsRoutes(a,{service:{execute} as unknown as OperationsService,env:settings});return{a,execute};}
describe("operations HTTP boundary",()=>{
 it("disabled is 503 not an empty queue",async()=>{const{a,execute}=await app(undefined,{});const r=await a.inject({method:"POST",url:"/operations/rpc",payload:{}});expect(r.statusCode).toBe(503);expect(execute).not.toHaveBeenCalled();});
 it("unsigned calls cannot reach the service",async()=>{const{a,execute}=await app();const r=await a.inject({method:"POST",url:"/operations/rpc",payload:{actor:claim().actor}});expect(r.statusCode).toBe(401);expect(execute).not.toHaveBeenCalled();});
 it("valid signature supplies the actual principal and stable request ID",async()=>{const{a,execute}=await app(),c=claim();const r=await a.inject({method:"POST",url:"/operations/rpc",payload:{envelope:signRequest(c,key),actor:{id:"forged"}}});expect(r.statusCode).toBe(200);expect(execute).toHaveBeenCalledWith(c.actor,c.request.body,c.request.requestId);expect(r.headers['cache-control']).toBe('no-store');});
 it("wrong-key and stale requests never execute",async()=>{const{a,execute}=await app();const c=claim();c.iat-=120;for(const token of [signRequest(c,key),signRequest(claim(),key+'wrong')]){const r=await a.inject({method:"POST",url:"/operations/rpc",payload:{envelope:token}});expect(r.statusCode).toBe(401);}expect(execute).not.toHaveBeenCalled();});
 it("known conflicts preserve conflict status and unknown SQL errors are redacted",async()=>{const execute=vi.fn(async()=>{throw new OperationsError("task_revision_conflict",409,{currentRevision:4});});const{a}=await app(execute);const r=await a.inject({method:"POST",url:"/operations/rpc",payload:{envelope:signRequest(claim(),key)}});expect(r.statusCode).toBe(409);expect(r.json().currentRevision).toBe(4);execute.mockImplementation(async()=>{throw new Error("postgres://private-password@db customer PII");});const failure=await a.inject({method:"POST",url:"/operations/rpc",payload:{envelope:signRequest(claim(),key)}});expect(failure.statusCode).toBe(503);expect(failure.body).not.toContain('private-password');});
 it("bounds body size and has no GET side effects",async()=>{const{a,execute}=await app();expect((await a.inject({method:"POST",url:"/operations/rpc",payload:{envelope:"x".repeat(220001)}})).statusCode).toBe(413);expect((await a.inject({method:"GET",url:"/operations/rpc"})).statusCode).toBe(404);expect(execute).not.toHaveBeenCalled();});
});
describe("portal adapter never substitutes provider records",()=>{
 it("refuses invalid/mutable origins",()=>{for(const origin of ["http://example.com","https://example.com/path","https://user:pass@example.com","https://example.com/?x=1"])expect(()=>portalAdapter(origin,key,"egc")).toThrow();});
 it("requires exact identity and authoritative owner evidence",async()=>{const f=vi.fn(async()=>new Response(JSON.stringify({authority:"employee_hub",job:{id:"wrong",revision:"v1"}}),{status:200}));const p=portalAdapter("https://portal.test",key,"egc",f as unknown as typeof fetch);await expect(p.resolve("right")).rejects.toMatchObject({code:"portal_identity_unverified"});expect(await p.owner("owner-test")).toBe(false);});
 it("provider failure is surfaced, never a fallback calendar",async()=>{const f=vi.fn(async()=>new Response('{"error":"down"}',{status:503}));const p=portalAdapter("https://portal.test",key,"egc",f as unknown as typeof fetch);await expect(p.read(claim().actor,{command:"calendar",startDate:"2026-09-18",endDate:"2026-09-20",timeZone:"America/Denver",offset:0,limit:50})).rejects.toMatchObject({code:"portal_authority_unavailable"});expect(f).toHaveBeenCalledTimes(1);});
});
