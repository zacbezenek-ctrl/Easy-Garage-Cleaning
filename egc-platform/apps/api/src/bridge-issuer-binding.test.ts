import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import {MCP_GRANT,OperationsService,SERVICE_ORIGINS,servicePublicKeySet,signRequest,signServiceAssertion,signServiceRequest,type Actor,type Command,type Delegate} from "@egc/operations";
const state=vi.hoisted(()=>({nonces:new Set<string>()}));
vi.mock("@egc/database",async()=>{const actual=await vi.importActual<typeof import("@egc/database")>("@egc/database");return{...actual,getDb:()=>({insert:()=>({values:(v:{issuer:string;nonce:string})=>({onConflictDoNothing:()=>({returning:async()=>{const key=v.issuer+v.nonce;if(state.nonces.has(key))return[];state.nonces.add(key);return[{id:"synthetic"}];}})})}),delete:()=>({where:async()=>undefined})})};});
import {registerOperationsRoutes} from "./operations.js";
import {registerRecordingRoutes,type RecordingService} from "./recordings.js";
import {signRecordingEnvelope} from "./recording-contracts.js";

/* BRIDGE-ADOPT-AUTHZ end to end: a verified envelope whose actor its signer neither mints
 * nor relays is refused before the service reaches the Hub, and the refusal is audited. */
const NOW=Date.parse("2026-09-22T12:00:00.000Z");
const portalKey="isolated-bridge-adopt-portal-key-0123456789abcdef",mcpKey="isolated-bridge-adopt-mcp-key-0123456789abcdefgh",hubSecret="synthetic-bridge-adopt-hub-root-0123456789abcdef";
const legacy={EGC_OPERATIONS_ENABLED:"true",EGC_OPERATIONS_PORTAL_SIGNING_SECRET:portalKey,EGC_OPERATIONS_MCP_SIGNING_SECRET:mcpKey,EGC_OPERATIONS_WORKSPACE:"egc"};
const v2={...legacy,EGC_OPERATIONS_SERVICE_AUTH:"v2",API_BEARER_TOKEN:"synthetic-bridge-adopt-api-root-0123456789abcdef"};
const GRANT="mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8",DELEGATED="mcp:zacb:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b";
const integration=(id:string):Actor=>({id,kind:"integration",role:"integration",workspace:"egc"});
const proof={source:"ghl_appointment",sourceId:"verified-appointment",sourceRevision:"r1",contactProviderId:"verified-contact",providerContact:{id:"verified-contact"},kind:"walkthrough",startAt:"2026-09-22T20:15:00Z",endAt:"2026-09-22T20:45:00Z",address:"Synthetic address",title:"Walkthrough",originalBookingAt:null,sourceCreatedAt:null,verifiedAt:"2026-09-22T07:00:00Z",providerAppointmentId:"verified-appointment",providerCalendarId:"verified-calendar",providerStatus:"confirmed",localJobId:null,normalizedLocalAppointmentId:null,evidenceIds:["source:verified"]};
// Each integration-only bridge command with the egc-api principal that really sends it.
const ONLY=[
 {id:"booking-adoption-worker",body:{command:"schedule.adopt",requestId:randomUUID(),proof}},
 {id:`schedule-sync:${GRANT}`,body:{command:"schedule.link_customer",portalVisitId:"visit-a",expectedRevision:"r1",providerContact:{id:"contact-a"}}},
 {id:"schedule-sync:booking-reconciler",body:{command:"schedule.bind_provider",operationId:randomUUID(),portalVisitId:"visit-a",expectedRevision:"r1",event:{id:"appointment-a"}}}
];
const apps:ReturnType<typeof Fastify>[]=[];
beforeEach(async()=>{
 vi.useFakeTimers({now:NOW,toFake:["Date"]});state.nonces.clear();
 const keys=await servicePublicKeySet({service:"hub",rootSecret:hubSecret,workspace:"egc"});
 vi.stubGlobal("fetch",vi.fn(async(url:unknown)=>{expect(url).toBe(SERVICE_ORIGINS.hub+"/api/operations-service-keys");return new Response(JSON.stringify(keys),{headers:{"content-type":"application/json"}});}));
});
afterEach(async()=>{for(const app of apps.splice(0))await app.close();vi.unstubAllGlobals();vi.useRealTimers();});
async function setup(env:NodeJS.ProcessEnv=legacy,audit=vi.fn(async(_row:unknown)=>undefined)){
 const portalRead=vi.fn(async(actor:Actor,command:Command)=>({ok:true,authority:"employee_hub",actor:actor.id,command:command.command}));
 const syncSchedule=vi.fn(async(actor:Actor)=>({ok:true,actor:actor.id})),ensureProviderNote=vi.fn(async(actor:Actor)=>({ok:true,actor:actor.id}));
 const service=new OperationsService({} as ConstructorParameters<typeof OperationsService>[0],{workspace:"egc",portalRead,syncSchedule,ensureProviderNote});
 const app=Fastify();apps.push(app);await registerOperationsRoutes(app,{env,service,audit});
 return {app,audit,portalRead,syncSchedule,ensureProviderNote};
}
const v1=(iss:"mcp"|"portal",actor:Actor,body:unknown,requestId=randomUUID(),delegate?:Delegate)=>signRequest({v:1,iss,aud:"egc-operations",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,...(delegate?{delegate}:{}),request:{requestId,body:body as Command}},iss==="mcp"?mcpKey:portalKey);
// MCP-OAUTH: the Hub-signed approval a Hub-approved grant carries as its delegate.
const approval=async(user:string,role:Delegate["role"]):Promise<Delegate>=>({user,role,assertion:await signServiceAssertion({service:"hub",rootSecret:hubSecret,workspace:"egc",...MCP_GRANT,claims:{hubUser:user,role,businessAccess:true,grantNonce:"x".repeat(43),resource:"https://egc-mcp.example.invalid",scope:"egc:read egc:write",client:"Claude (claude.ai)"},now:NOW})});
const rpc=async(app:ReturnType<typeof Fastify>,envelope:string)=>{const r=await app.inject({method:"POST",url:"/operations/rpc",payload:{envelope}});return{status:r.statusCode,body:r.json()};};

describe("integration actors bound to their issuer on /operations/rpc",()=>{
 it("refuses every integration-only command when the MCP or the Hub signs an egc-api principal, audits it, and never reaches the Hub",async()=>{
  const{app,audit,portalRead}=await setup();
  for(const {id,body} of ONLY)for(const iss of ["mcp","portal"] as const){
   const requestId=randomUUID();
   expect(await rpc(app,v1(iss,integration(id),body,requestId)),`${iss} ${body.command}`).toEqual({status:403,body:{error:"bridge_integration_issuer_mismatch"}});
   expect(audit).toHaveBeenLastCalledWith({actor:id,action:"operations.issuer_refused",entity:"operations_request",entityId:requestId,newValue:{code:"bridge_integration_issuer_mismatch",issuer:iss==="mcp"?"mcp":"hub",boundTo:"api",command:body.command},source:"operations"});
  }
  expect(audit).toHaveBeenCalledTimes(ONLY.length*2);
  expect(portalRead).not.toHaveBeenCalled();
 });
 it("accepts each principal from the service that mints it",async()=>{
  const{app,audit,portalRead,syncSchedule,ensureProviderNote}=await setup();
  // The MCP's own principal binds provider evidence; the policy, not the binding, keeps it from links and adoption.
  expect(await rpc(app,v1("mcp",integration(GRANT),ONLY[2]!.body))).toEqual({status:200,body:{ok:true,authority:"employee_hub",actor:GRANT,command:"schedule.bind_provider"}});
  expect(await rpc(app,v1("mcp",integration(GRANT),ONLY[1]!.body))).toEqual({status:403,body:{error:"bridge_integration_forbidden"}});
  expect(await rpc(app,v1("mcp",integration(GRANT),ONLY[0]!.body))).toEqual({status:403,body:{error:"schedule_adoption_internal_only"}});
  // The Hub's per-user sync identities come only from the Hub's key.
  const sync={command:"schedule.sync_provider",portalVisitId:"visit-a",requestId:randomUUID(),runAutomations:false};
  const note={command:"provider.note.ensure",requestId:randomUUID(),portalJobId:"job-a",providerContactId:"contact-a",scope:"post_job",title:"Synthetic",body:"Synthetic note"};
  expect(await rpc(app,v1("portal",integration("hub-schedule:zacb"),sync))).toEqual({status:200,body:{ok:true,actor:"hub-schedule:zacb"}});
  expect(await rpc(app,v1("portal",integration("hub-note:zacb"),note))).toEqual({status:200,body:{ok:true,actor:"hub-note:zacb"}});
  for(const [id,body] of [["hub-schedule:zacb",sync],["hub-note:zacb",note]] as const)expect(await rpc(app,v1("mcp",integration(id),body))).toEqual({status:403,body:{error:"bridge_integration_issuer_mismatch"}});
  expect([portalRead.mock.calls.length,syncSchedule.mock.calls.length,ensureProviderNote.mock.calls.length,audit.mock.calls.length]).toEqual([1,1,1,2]);
 });
 it("binds delegated hub.* reads, inbound reconciliation and unknown ids the same way",async()=>{
  const{app,audit,portalRead}=await setup();
  const roster={command:"hub.staff.roster",delegate:"zacb"};
  expect(await rpc(app,v1("mcp",integration(GRANT),roster))).toMatchObject({status:200,body:{actor:GRANT,command:"hub.staff.roster"}});
  expect(await rpc(app,v1("mcp",integration("booking-reconciler"),roster))).toEqual({status:403,body:{error:"bridge_integration_issuer_mismatch"}});
  expect(await rpc(app,v1("mcp",integration("funnel-feed-reader"),roster))).toEqual({status:403,body:{error:"bridge_integration_issuer_unknown"}});
  expect(await rpc(app,v1("mcp",integration("mcp-integration"),{command:"status"}))).toEqual({status:403,body:{error:"bridge_integration_issuer_unknown"}});
  expect(await rpc(app,v1("mcp",integration("inbound-response-reconciler"),{command:"inbound.reconcile",limit:5}))).toEqual({status:403,body:{error:"bridge_integration_issuer_mismatch"}});
  expect(await rpc(app,v1("mcp",integration(GRANT),{command:"inbound.reconcile",limit:5}))).toEqual({status:503,body:{error:"inbound_reconciliation_not_configured"}});
  expect(portalRead).toHaveBeenCalledTimes(1);
  expect(audit.mock.calls.map(([row])=>(row as {newValue:{code:string;command:string}}).newValue)).toEqual([
   {code:"bridge_integration_issuer_mismatch",issuer:"mcp",boundTo:"api",command:"hub.staff.roster"},{code:"bridge_integration_issuer_unknown",issuer:"mcp",boundTo:null,command:"hub.staff.roster"},
   {code:"bridge_integration_issuer_unknown",issuer:"mcp",boundTo:null,command:"status"},{code:"bridge_integration_issuer_mismatch",issuer:"mcp",boundTo:"api",command:"inbound.reconcile"}]);
  // Humans answer to the role policy whatever the signer.
  expect(await rpc(app,v1("mcp",{id:"synthetic-owner",kind:"human",role:"owner",workspace:"egc"},{command:"portal.members"}))).toMatchObject({status:200,body:{actor:"synthetic-owner"}});
 });
 it("binds v2 Hub envelopes to the Hub, and a failed audit write never changes the refusal",async()=>{
  const failing=vi.fn(async()=>{throw new Error("private audit storage failure");});
  const{app,syncSchedule}=await setup(v2,failing);
  const token=(actor:Actor,body:Record<string,unknown>)=>signServiceRequest({service:"hub",rootSecret:hubSecret,workspace:"egc",path:"/operations/rpc",actor,request:{requestId:randomUUID(),body}});
  const sync={command:"schedule.sync_provider",portalVisitId:"visit-a",requestId:randomUUID(),runAutomations:false};
  expect(await rpc(app,await token(integration("hub-schedule:zacb"),sync))).toEqual({status:200,body:{ok:true,actor:"hub-schedule:zacb"}});
  // The v2 Hub verifier already admits only its own sync identities; the binding holds the same line.
  expect(await rpc(app,await token(integration("booking-adoption-worker"),ONLY[0]!.body))).toEqual({status:403,body:{error:"hub_principal_forbidden"}});
  const forged=await rpc(app,v1("mcp",integration("booking-adoption-worker"),ONLY[0]!.body));
  expect(forged).toEqual({status:403,body:{error:"bridge_integration_issuer_mismatch"}});
  expect(JSON.stringify(forged)).not.toContain("private");
  expect(failing).toHaveBeenCalledTimes(1);expect(syncSchedule).toHaveBeenCalledTimes(1);
 });
});

describe("Hub-approved MCP grants through a real OperationsService",()=>{
 it("admits mcp:<hub user>:<grant id> signed with the MCP key for reads, and refuses the same id signed with the Hub key",async()=>{
  const{app,audit,portalRead}=await setup(),delegate=await approval("zacb","owner");
  const calendar={command:"calendar",startDate:"2026-09-22",endDate:"2026-09-23"},roster={command:"hub.staff.roster",delegate:"zacb"};
  expect(await rpc(app,v1("mcp",integration(DELEGATED),calendar,randomUUID(),delegate))).toEqual({status:200,body:{ok:true,authority:"employee_hub",actor:DELEGATED,command:"calendar"}});
  expect(await rpc(app,v1("mcp",integration(DELEGATED),roster,randomUUID(),delegate))).toEqual({status:200,body:{ok:true,authority:"employee_hub",actor:DELEGATED,command:"hub.staff.roster"}});
  expect(portalRead.mock.calls.map(([actor])=>actor)).toEqual([integration(DELEGATED),integration(DELEGATED)]);
  // The Hub never mints an MCP grant, so neither Hub key may present one, with or without a valid approval beside it.
  const requestId=randomUUID();
  expect(await rpc(app,v1("portal",integration(DELEGATED),calendar,requestId,delegate))).toEqual({status:403,body:{error:"bridge_integration_issuer_mismatch"}});
  expect(await rpc(app,v1("portal",integration(DELEGATED),roster))).toEqual({status:403,body:{error:"bridge_integration_issuer_mismatch"}});
  expect(audit).toHaveBeenCalledTimes(2);
  expect(audit).toHaveBeenCalledWith({actor:DELEGATED,action:"operations.issuer_refused",entity:"operations_request",entityId:requestId,newValue:{code:"bridge_integration_issuer_mismatch",issuer:"hub",boundTo:"mcp",command:"calendar"},source:"operations"});
  // The delegate check still runs first: a grant id that names another user is refused as MCP-OAUTH refuses it.
  expect(await rpc(app,v1("mcp",integration("mcp:tylerg:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b"),calendar,randomUUID(),delegate))).toEqual({status:403,body:{error:"delegate_invalid"}});
  expect(portalRead).toHaveBeenCalledTimes(2);expect(audit).toHaveBeenCalledTimes(2);
 });
});

describe("integration actors bound to their issuer on /recordings/rpc",()=>{
 it("admits the MCP's principals and refuses anything else it signs",async()=>{
  const app=Fastify();apps.push(app);await app.register(multipart);
  const execute=vi.fn(async(..._args:unknown[])=>({ok:true}));
  await registerRecordingRoutes(app,legacy,{execute,processNext:vi.fn(async()=>false)} as unknown as RecordingService);
  const envelope=(actor:Actor)=>signRecordingEnvelope({v:1,iss:"mcp",aud:"egc-recordings",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,request:{requestId:randomUUID(),body:{command:"recording.list",portalJobId:"visit-a",offset:0}}},mcpKey);
  const post=async(actor:Actor)=>{const r=await app.inject({method:"POST",url:"/recordings/rpc",payload:{envelope:envelope(actor)}});return{status:r.statusCode,error:r.json().error};};
  expect(await post(integration(GRANT))).toEqual({status:200,error:undefined});
  expect(await post(integration(DELEGATED))).toEqual({status:200,error:undefined});
  expect(await post(integration("booking-reconciler"))).toEqual({status:403,error:"bridge_integration_issuer_mismatch"});
  expect(await post(integration("forged-recording-worker"))).toEqual({status:403,error:"bridge_integration_issuer_unknown"});
  expect(execute).toHaveBeenCalledTimes(2);
 });
 it("logs and audits every refusal like /operations/rpc, on /recordings/rpc and /recordings/upload, and a failed audit write never changes it",async()=>{
  const app=Fastify({logger:false});apps.push(app);await app.register(multipart);
  const execute=vi.fn(async(..._args:unknown[])=>({ok:true})),upload=vi.fn(async(..._args:unknown[])=>({ok:true}));
  const rows:unknown[]=[],audit=vi.fn(async(row:unknown)=>{rows.push(row);if(rows.length===3)throw new Error("private audit storage failure");});
  const warn=vi.spyOn(app.log,"warn");
  await registerRecordingRoutes(app,legacy,{execute,upload,processNext:vi.fn(async()=>false)} as unknown as RecordingService,audit);
  const envelope=(iss:"mcp"|"portal",actor:Actor,body:Record<string,unknown>,requestId:string)=>signRecordingEnvelope({v:1,iss,aud:"egc-recordings",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,request:{requestId,body}},iss==="mcp"?mcpKey:portalKey);
  const list={command:"recording.list",portalJobId:"visit-a",offset:0},ids=[randomUUID(),randomUUID(),randomUUID()];
  const refused=[await app.inject({method:"POST",url:"/recordings/rpc",payload:{envelope:envelope("mcp",integration("booking-reconciler"),list,ids[0]!)}}),
   await app.inject({method:"POST",url:"/recordings/rpc",payload:{envelope:envelope("portal",integration(DELEGATED),list,ids[1]!)}})];
  const boundary="synthetic-boundary",form=[`--${boundary}\r\nContent-Disposition: form-data; name="envelope"\r\n\r\n${envelope("mcp",integration("forged-recording-worker"),{command:"recording.upload",portalJobId:"visit-a",audioSha256:"a".repeat(64)},ids[2]!)}\r\n`,
   `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\nsynthetic\r\n--${boundary}--\r\n`].join("");
  refused.push(await app.inject({method:"POST",url:"/recordings/upload",headers:{"content-type":`multipart/form-data; boundary=${boundary}`},payload:form}));
  expect(refused.map(r=>[r.statusCode,r.json().error])).toEqual([[403,"bridge_integration_issuer_mismatch"],[403,"bridge_integration_issuer_mismatch"],[403,"bridge_integration_issuer_unknown"]]);
  for(const r of refused)expect(r.body).not.toContain("private");
  expect(rows).toEqual([
   {actor:"booking-reconciler",action:"operations.issuer_refused",entity:"recording_request",entityId:ids[0],newValue:{code:"bridge_integration_issuer_mismatch",issuer:"mcp",boundTo:"api",command:"recording.list"},source:"recordings"},
   {actor:DELEGATED,action:"operations.issuer_refused",entity:"recording_request",entityId:ids[1],newValue:{code:"bridge_integration_issuer_mismatch",issuer:"hub",boundTo:"mcp",command:"recording.list"},source:"recordings"},
   {actor:"forged-recording-worker",action:"operations.issuer_refused",entity:"recording_request",entityId:ids[2],newValue:{code:"bridge_integration_issuer_unknown",issuer:"mcp",boundTo:null,command:"recording.upload"},source:"recordings"}]);
  expect(warn.mock.calls.map(([fields])=>(fields as {code:string;issuer:string;actor:string;command:string}))).toEqual([
   {code:"bridge_integration_issuer_mismatch",issuer:"mcp",actor:"booking-reconciler",command:"recording.list"},{code:"bridge_integration_issuer_mismatch",issuer:"hub",actor:DELEGATED,command:"recording.list"},
   {code:"bridge_integration_issuer_unknown",issuer:"mcp",actor:"forged-recording-worker",command:"recording.upload"}]);
  // Other refusals (a human the MCP key signs) are not issuer refusals and add no row.
  expect((await app.inject({method:"POST",url:"/recordings/rpc",payload:{envelope:envelope("mcp",{id:"synthetic-owner",kind:"human",role:"owner",workspace:"egc"},list,randomUUID())}})).json().error).toBe("recording_role_forbidden");
  expect([rows.length,execute.mock.calls.length,upload.mock.calls.length]).toEqual([3,0,0]);
 });
});
