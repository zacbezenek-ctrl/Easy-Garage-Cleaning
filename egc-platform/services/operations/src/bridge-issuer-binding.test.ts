import {describe,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {authorize,commandSchema,OperationsError,type Actor,type Command} from "./contracts.js";
import {BRIDGE_COMMAND_POLICY,type BridgeIssuer} from "./bridge-command-policy.js";
import {OperationsService} from "./service.js";

// BRIDGE-ADOPT-AUTHZ: authorize() binds a signed integration actor to the service that mints it.
const integration=(id:string):Actor=>({id,kind:"integration",role:"integration",workspace:"egc"});
const GRANT="mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const owner:Actor={id:"zacb",kind:"human",role:"owner",workspace:"egc"};
const denied=(fn:()=>unknown,code:string)=>{try{fn();throw new Error("Expected denial");}catch(e){expect(e).toBeInstanceOf(OperationsError);expect((e as OperationsError).code).toBe(code);expect((e as OperationsError).status).toBe(403);}};
const proof={source:"ghl_appointment",sourceId:"verified-appointment",sourceRevision:"r1",contactProviderId:"verified-contact",providerContact:{id:"verified-contact"},kind:"walkthrough",startAt:"2026-09-22T20:15:00Z",endAt:"2026-09-22T20:45:00Z",address:"Synthetic address",title:"Walkthrough",originalBookingAt:null,sourceCreatedAt:null,verifiedAt:"2026-09-22T07:00:00Z",providerAppointmentId:"verified-appointment",providerCalendarId:"verified-calendar",providerStatus:"confirmed",localJobId:null,normalizedLocalAppointmentId:null,evidenceIds:["source:verified"]};
// Each integration-only command with the API principal that really sends it.
const ONLY:Record<string,{id:string;body:Command}>={
 "schedule.adopt":{id:"booking-adoption-worker",body:commandSchema.parse({command:"schedule.adopt",requestId:randomUUID(),proof})},
 "schedule.link_customer":{id:`schedule-sync:${GRANT}`,body:commandSchema.parse({command:"schedule.link_customer",portalVisitId:"visit-a",expectedRevision:"r1",providerContact:{id:"contact-a"}})},
 "schedule.bind_provider":{id:"schedule-sync:booking-reconciler",body:commandSchema.parse({command:"schedule.bind_provider",operationId:randomUUID(),portalVisitId:"visit-a",expectedRevision:"r1",event:{id:"appointment-a"}})}
};

describe("integration actor issuer binding in authorize()",()=>{
 it("refuses every integration-only command when the MCP or the Hub signs another service's principal, and admits the service that mints it",()=>{
  for(const [name,{id,body}] of Object.entries(ONLY)){
   expect(BRIDGE_COMMAND_POLICY[name]!.actors.every(a=>a.kind==="integration"),name).toBe(true);
   for(const issuer of ["mcp","hub"] as BridgeIssuer[])denied(()=>authorize(integration(id),body,"egc",undefined,undefined,issuer),"bridge_integration_issuer_mismatch");
   for(const issuer of ["mcp","hub"] as BridgeIssuer[])denied(()=>authorize(integration(`forged-${id}`),body,"egc",undefined,undefined,issuer),"bridge_integration_issuer_unknown");
   // egc-api's own worker runs in-process: authorize() is called without an envelope issuer.
   expect(()=>authorize(integration(id),body,"egc"),name).not.toThrow();
  }
  // The MCP's own principal passes the binding; the policy then decides as before.
  expect(()=>authorize(integration(GRANT),ONLY["schedule.bind_provider"]!.body,"egc",undefined,undefined,"mcp")).not.toThrow();
  denied(()=>authorize(integration(GRANT),ONLY["schedule.bind_provider"]!.body,"egc",undefined,undefined,"hub"),"bridge_integration_issuer_mismatch");
  denied(()=>authorize(integration(GRANT),ONLY["schedule.link_customer"]!.body,"egc",undefined,undefined,"mcp"),"bridge_integration_forbidden");
  denied(()=>authorize(integration(GRANT),ONLY["schedule.adopt"]!.body,"egc",undefined,undefined,"mcp"),"schedule_adoption_internal_only");
 });
 it("binds the Hub's per-user sync identities and delegated hub.* readers the same way",()=>{
  const sync=commandSchema.parse({command:"schedule.sync_provider",portalVisitId:"visit-a",requestId:randomUUID()});
  const note=commandSchema.parse({command:"provider.note.ensure",requestId:randomUUID(),portalJobId:"job-a",providerContactId:"contact-a",scope:"post_job",title:"Synthetic",body:"Synthetic note"});
  for(const [id,command] of [["hub-schedule:zacb",sync],["hub-note:zacb",note]] as const){
   expect(()=>authorize(integration(id),command,"egc",undefined,undefined,"hub")).not.toThrow();
   denied(()=>authorize(integration(id),command,"egc",undefined,undefined,"mcp"),"bridge_integration_issuer_mismatch");
  }
  const roster=commandSchema.parse({command:"hub.staff.roster",delegate:"zacb"});
  expect(()=>authorize(integration(GRANT),roster,"egc",undefined,undefined,"mcp")).not.toThrow();
  // MCP-OAUTH's Hub-approved grant, mcp:<hub user>:<grant id>, is the MCP's too.
  const delegated="mcp:zacb:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b",calendar=commandSchema.parse({command:"calendar",startDate:"2026-09-22",endDate:"2026-09-23"});
  for(const command of [roster,calendar,commandSchema.parse({command:"status"})]){
   for(const issuer of ["mcp",undefined] as (BridgeIssuer|undefined)[])expect(()=>authorize(integration(delegated),command,"egc",undefined,undefined,issuer)).not.toThrow();
   denied(()=>authorize(integration(delegated),command,"egc",undefined,undefined,"hub"),"bridge_integration_issuer_mismatch");
   denied(()=>authorize(integration("mcp:zacb:not-a-grant"),command,"egc",undefined,undefined,"mcp"),"bridge_integration_issuer_unknown");
  }
  for(const id of ["booking-reconciler","messaging-cron-worker"])denied(()=>authorize(integration(id),roster,"egc",undefined,undefined,"mcp"),"bridge_integration_issuer_mismatch");
  denied(()=>authorize(integration("funnel-feed-reader"),roster,"egc",undefined,undefined,"mcp"),"bridge_integration_issuer_unknown");
  denied(()=>authorize(integration("verified-grant"),commandSchema.parse({command:"status"}),"egc",undefined,undefined,"mcp"),"bridge_integration_issuer_unknown");
 });
 it("leaves humans to the role policy and in-process callers to today's rules",()=>{
  for(const issuer of ["mcp","hub",undefined] as (BridgeIssuer|undefined)[])expect(()=>authorize(owner,ONLY["schedule.bind_provider"]!.body,"egc",undefined,undefined,issuer)).toThrow("bridge_role_forbidden");
  expect(()=>authorize(owner,commandSchema.parse({command:"status"}),"egc",undefined,undefined,"mcp")).not.toThrow();
  expect(()=>authorize(integration("verified-grant"),commandSchema.parse({command:"status"}),"egc")).not.toThrow();
  // Invalid claims are still refused before any binding question.
  denied(()=>authorize({...owner,kind:"integration"},commandSchema.parse({command:"status"}),"egc",undefined,undefined,"mcp"),"invalid_actor");
 });
 it("OperationsService.execute authorizes with the verified issuer, so a forged principal never reaches the Hub",async()=>{
  const portalRead=vi.fn(async(actor:Actor,command:Command)=>({ok:true,authority:"employee_hub",actor:actor.id,command:command.command}));
  const service=new OperationsService({} as ConstructorParameters<typeof OperationsService>[0],{workspace:"egc",portalRead});
  const {id,body}=ONLY["schedule.link_customer"]!;
  await expect(service.execute(integration(id),body,randomUUID(),"mcp")).rejects.toMatchObject({code:"bridge_integration_issuer_mismatch",status:403});
  await expect(service.execute(integration("schedule-sync:hub-schedule:zacb"),ONLY["schedule.bind_provider"]!.body,randomUUID(),"hub")).rejects.toMatchObject({code:"bridge_integration_issuer_mismatch",status:403});
  expect(portalRead).not.toHaveBeenCalled();
  await expect(service.execute(integration(GRANT),ONLY["schedule.bind_provider"]!.body,randomUUID(),"mcp")).resolves.toMatchObject({actor:GRANT,command:"schedule.bind_provider"});
  await expect(service.execute(integration(id),body,randomUUID())).resolves.toMatchObject({actor:id,command:"schedule.link_customer"});
  expect(portalRead).toHaveBeenCalledTimes(2);
 });
});
