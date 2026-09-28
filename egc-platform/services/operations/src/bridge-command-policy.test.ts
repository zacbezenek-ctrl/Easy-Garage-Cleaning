import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {authorize,commandSchema,OperationsError,PORTAL_PASSTHROUGH,WRITE_COMMANDS,type Actor,type Command} from "./contracts.js";
import {BRIDGE_COMMAND_KINDS,BRIDGE_COMMAND_POLICY,MCP_PRINCIPAL_PATTERN,bridgeCommandDenial,bridgeCommandPolicy,type BridgeCommandPolicy} from "./bridge-command-policy.js";
import {isHubCommandName} from "./hub-command-policy.js";

const owner:Actor={id:"zacb",role:"owner",kind:"human",workspace:"egc"};
const manager:Actor={...owner,id:"tylerg",role:"manager"};
const sales:Actor={...owner,id:"alexk",role:"sales"};
const integration:Actor={id:"mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8",role:"integration",kind:"integration",workspace:"egc"};
// The API's own workers and anything that merely resembles an MCP grant only read.
const workers:Actor[]=["booking-reconciler","inbound-response-reconciler","operations-api","post-job-followup","verified-grant","mcp-oauth-grant:synthetic","mcp-service-grant:x"].map(id=>({...integration,id}));
const worker:Actor={...integration,id:"booking-adoption-worker"};
const denied=(fn:()=>unknown,code:string)=>{try{fn();throw new Error("Expected denial");}catch(e){expect(e).toBeInstanceOf(OperationsError);expect((e as OperationsError).code).toBe(code);expect((e as OperationsError).status).toBe(403);}};
const schedule=(extra:Record<string,unknown>={})=>commandSchema.parse({command:"schedule.mutate",requestId:randomUUID(),mode:"create",portalCustomerId:"customer-a",kind:"walkthrough",changes:{date:"2026-09-23",time:"10:00",endTime:"11:00"},...extra});
const note=commandSchema.parse({command:"portal.note.add",requestId:randomUUID(),portalJobId:"job-a",expectedRevision:"r1",body:"Synthetic note"});
const link=commandSchema.parse({command:"schedule.link_customer",portalVisitId:"visit-a",expectedRevision:"r1",providerContact:{id:"contact-a"}});

describe("legacy bridge command policy (SEC-04)",()=>{
 it("covers every legacy passthrough command with a frozen, crew-free rule",()=>{
  for(const name of PORTAL_PASSTHROUGH)if(!isHubCommandName(name))expect(bridgeCommandPolicy({command:name}),name).not.toBeNull();
  expect(Object.isFrozen(BRIDGE_COMMAND_POLICY)).toBe(true);
  for(const [name,rule] of Object.entries(BRIDGE_COMMAND_POLICY)){
   expect(Object.isFrozen(rule)&&Object.isFrozen(rule.actors)&&rule.actors.length>0,name).toBe(true);
   // Every integration write names the principals that really send it.
   if(rule.kind!=="read")for(const actor of rule.actors)if(actor.kind==="integration")expect(actor.idPattern,name).toBeInstanceOf(RegExp);
   expect(BRIDGE_COMMAND_KINDS).toContain(rule.kind);
   for(const actor of rule.actors){expect(["crew","crew_lead"]).not.toContain(actor.role);expect(actor.kind==="integration").toBe(actor.role==="integration");}
   // Every write the Hub runs is also a write the API records for replay.
   if(rule.kind!=="read"&&!name.startsWith("recording."))expect(WRITE_COMMANDS.has(name),name).toBe(true);
  }
 });
 it("refines schedule.mutate by mode and ignores inherited keys",()=>{
  expect(bridgeCommandPolicy({command:"schedule.mutate",mode:"cancel"})).toMatchObject({action:"schedule.mutate:cancel",kind:"destructive",confirm:true});
  for(const mode of ["create","update","toString",undefined])expect(bridgeCommandPolicy({command:"schedule.mutate",mode})).toMatchObject({action:"schedule.mutate",kind:"write",confirm:false});
  for(const command of ["toString","__proto__","constructor","task.create",42,undefined])expect(bridgeCommandPolicy({command})).toBeNull();
 });
 it("authorize() enforces the shared table: crew never, sales reads only, integrations where the Hub flows need them",()=>{
  for(const actor of [owner,manager,integration])expect(()=>authorize(actor,schedule(),"egc")).not.toThrow();
  denied(()=>authorize(sales,schedule(),"egc"),"bridge_role_forbidden");
  denied(()=>authorize(sales,schedule({mode:"cancel",portalVisitId:"visit-a",expectedRevision:"r1",changes:{}}),"egc"),"bridge_role_forbidden");
  for(const role of ["crew","crew_lead"] as const)denied(()=>authorize({...owner,role},schedule(),"egc"),"role_forbidden");
  denied(()=>authorize(sales,note,"egc"),"bridge_role_forbidden");
  expect(()=>authorize(integration,note,"egc")).not.toThrow();
  for(const actor of [owner,manager])denied(()=>authorize(actor,link,"egc"),"bridge_role_forbidden");
  expect(()=>authorize({...integration,id:"schedule-sync:mcp-oauth-grant:synthetic"},link,"egc")).not.toThrow();
  for(const actor of [...workers,integration])denied(()=>authorize(actor,link,"egc"),"bridge_integration_forbidden");
  for(const actor of [sales,integration])expect(()=>authorize(actor,commandSchema.parse({command:"portal.revenue",from:"2026-09-01T00:00:00Z",to:"2026-10-01T00:00:00Z"}),"egc")).not.toThrow();
  const adopt={command:"schedule.adopt"} as unknown as Command;
  expect(()=>authorize(worker,adopt,"egc")).not.toThrow();
  denied(()=>authorize(integration,adopt,"egc"),"schedule_adoption_internal_only");
  expect(bridgeCommandDenial(integration,bridgeCommandPolicy({command:"schedule.adopt"})!)).toBe("bridge_integration_forbidden");
  expect(bridgeCommandDenial({id:"x",kind:"human",role:"integration"},bridgeCommandPolicy({command:"calendar"})!)).toBe("bridge_actor_invalid");
 });
 it("admits only the MCP's verified principals as integration writers of visits and job records",()=>{
  for(const id of ["mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8","mcp-service-grant"])expect(MCP_PRINCIPAL_PATTERN.test(id),id).toBe(true);
  for(const id of ["mcp-oauth-grant:synthetic","mcp-oauth-grant:6BA7B810-9DAD-41D1-80B4-00C04FD430C8","mcp-service-grant:x","x-mcp-service-grant","schedule-sync:mcp-service-grant"])expect(MCP_PRINCIPAL_PATTERN.test(id),id).toBe(false);
  for(const command of [schedule(),schedule({mode:"cancel",portalVisitId:"visit-a",expectedRevision:"r1",changes:{}}),note]){
   for(const actor of [integration,{...integration,id:"mcp-service-grant"}])expect(()=>authorize(actor,command,"egc")).not.toThrow();
   for(const actor of workers)denied(()=>authorize(actor,command,"egc"),"bridge_integration_forbidden");
  }
  const bind=bridgeCommandPolicy({command:"schedule.bind_provider"})!;
  for(const id of ["schedule-sync:booking-reconciler",integration.id])expect(bridgeCommandDenial({...integration,id},bind),id).toBeNull();
  expect(bridgeCommandDenial({...integration,id:"note-link:hub-note:tylerg"},bind)).toBe("bridge_integration_forbidden");
  // principals:false (a lib behind the signed bridge) checks kind and role only.
  const mutate=bridgeCommandPolicy({command:"schedule.mutate"})!;
  expect(bridgeCommandDenial(workers[0],mutate,{principals:false})).toBeNull();
  expect(bridgeCommandDenial(sales,mutate,{principals:false})).toBe("bridge_role_forbidden");
 });
 it("fails closed for a passthrough command the table does not cover",()=>{
  const {"portal.note.add":_removed,...partial}=BRIDGE_COMMAND_POLICY as Record<string,BridgeCommandPolicy>;
  denied(()=>authorize(owner,note,"egc",undefined,partial),"bridge_command_unknown");
  expect(()=>authorize(owner,commandSchema.parse({command:"status"}),"egc",undefined,{})).not.toThrow();
  expect(()=>authorize(owner,commandSchema.parse({command:"hub.staff.roster"}),"egc",undefined,{})).not.toThrow();
 });
});
