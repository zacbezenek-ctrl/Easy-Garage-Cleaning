import {beforeEach,describe,expect,it,vi} from "vitest";
import type {McpServer} from "@modelcontextprotocol/server";
import type {ZodType} from "zod/v4";
const operations=vi.hoisted(()=>({callOperations:vi.fn()}));
vi.mock("../src/operations.js",()=>operations);
import {registerPortalRecordTools} from "../src/portal-record-tools.js";

type Registration={config:{inputSchema:ZodType;annotations:{readOnlyHint:boolean}},handler:(input:unknown)=>Promise<any>};
const tools=new Map<string,Registration>();
const requestId="315c8503-d90f-48ac-81e1-5692074e1027";
const portalJobId="hub-mu3h10f1jntp";
const revision="2026-09-16T02:18:11.191511Z";
const nextRevision="2026-09-23T22:30:00.000000Z";
const providerId="5EzRV3HIYBdmpPyY2MIs";
const providerContact=vi.fn(async()=>({contact:{id:providerId,locationId:"loc",name:"Exact Customer",phone:"+19705550100",email:"exact@example.com",secret:"must-not-cross-boundary"}}));
async function call(name:string,input:unknown){const t=tools.get(name)!;return t.handler(t.config.inputSchema.parse(input));}
beforeEach(()=>{
 vi.resetAllMocks();providerContact.mockImplementation(async()=>({contact:{id:providerId,locationId:"loc",name:"Exact Customer",phone:"+19705550100",email:"exact@example.com",secret:"must-not-cross-boundary"}}));
 tools.clear();registerPortalRecordTools({registerTool:(name:string,config:Registration["config"],handler:Registration["handler"])=>tools.set(name,{config,handler})} as unknown as McpServer,{providerContact});
});
describe("native project-link recovery",()=>{
 it("keeps the preview strictly read-only and source-bound",async()=>{
  operations.callOperations.mockResolvedValue({ok:true,job:{id:portalJobId,revision,highlevelContactId:providerId,customerId:null,projectId:null,kind:"walkthrough",startAt:"2026-09-25T20:00:00Z",endAt:"2026-09-25T20:30:00Z",address:"123 Main St"}});
  const out=await call("egc.preview_link_project",{portalJobId});
  expect(tools.get("egc.preview_link_project")?.config.annotations.readOnlyHint).toBe(true);
  expect(operations.callOperations).toHaveBeenCalledTimes(1);
  expect(operations.callOperations).toHaveBeenCalledWith({command:"portal.job",jobId:portalJobId});
  expect(out.structuredContent.result).toMatchObject({ok:true,portalJobId,expectedRevision:revision,providerContactId:providerId,providerContactVerified:true,correctionRequired:true});
 });
 it("uses the exact provider identity and revision-bound customer adoption only after the normal project ensure reports a missing customer",async()=>{
  operations.callOperations.mockImplementation(async(command:any)=>{
   if(command.command==="portal.project.ensure"&&command.expectedRevision===revision)return {error:"record_customer_link_missing"};
   if(command.command==="portal.job")return {ok:true,job:{id:portalJobId,revision,highlevelContactId:providerId,customerId:null,projectId:null,kind:"walkthrough",startAt:"2026-09-25T20:00:00Z",endAt:"2026-09-25T20:30:00Z",address:"123 Main St"}};
   if(command.command==="schedule.link_customer")return {ok:true,visit:{portalVisitId:portalJobId,portalCustomerId:"ghl_"+providerId,portalProjectId:"project_"+portalJobId,revision:nextRevision}};
   if(command.command==="portal.project.ensure"&&command.expectedRevision===nextRevision)return {ok:true,record:{id:portalJobId,customerId:"ghl_"+providerId,projectId:"project_"+portalJobId}};
   throw new Error("unexpected command");
  });
  const out=await call("egc.link_project",{requestId,portalJobId,expectedRevision:revision});
  expect(out.structuredContent.result).toMatchObject({ok:true,customerLinkRecovered:true,providerContactId:providerId,originalRevision:revision});
  const linked=operations.callOperations.mock.calls.find(([command])=>command.command==="schedule.link_customer")?.[0];
  expect(linked).toMatchObject({command:"schedule.link_customer",portalVisitId:portalJobId,expectedRevision:revision,providerContact:{id:providerId,locationId:"loc",name:"Exact Customer",phone:"+19705550100",email:"exact@example.com"}});
  expect(JSON.stringify(linked)).not.toContain("must-not-cross-boundary");
 });
 it("refuses a stale caller revision before any native identity write",async()=>{
  operations.callOperations.mockImplementation(async(command:any)=>{
   if(command.command==="portal.project.ensure")return {error:"project_customer_id_required"};
   if(command.command==="portal.job")return {ok:true,job:{id:portalJobId,revision:nextRevision,highlevelContactId:providerId}};
   throw new Error("unexpected write");
  });
  const out=await call("egc.link_project",{requestId,portalJobId,expectedRevision:revision});
  expect(out.structuredContent.result).toMatchObject({ok:false,error:"record_revision_conflict",expectedRevision:revision,currentRevision:nextRevision});
  expect(operations.callOperations.mock.calls.some(([command])=>command.command==="schedule.link_customer")).toBe(false);
 });
 it("blocks a provider identity mismatch and never falls back to names",async()=>{
  providerContact.mockResolvedValue({contact:{id:"different-provider-id",name:"Same Name"}});
  operations.callOperations.mockImplementation(async(command:any)=>{
   if(command.command==="portal.project.ensure")return {error:"record_customer_link_missing"};
   if(command.command==="portal.job")return {ok:true,job:{id:portalJobId,revision,highlevelContactId:providerId,customer:"Same Name"}};
   throw new Error("unexpected write");
  });
  const out=await call("egc.link_project",{requestId,portalJobId,expectedRevision:revision});
  expect(out.structuredContent.result).toMatchObject({ok:false,error:"project_provider_contact_identity_mismatch"});
  expect(operations.callOperations.mock.calls.some(([command])=>command.command==="schedule.link_customer")).toBe(false);
 });
 it("preserves ambiguity/cross-customer failures from the authoritative Hub adoption path",async()=>{
  operations.callOperations.mockImplementation(async(command:any)=>{
   if(command.command==="portal.project.ensure")return {error:"record_customer_link_missing"};
   if(command.command==="portal.job")return {ok:true,job:{id:portalJobId,revision,highlevelContactId:providerId}};
   if(command.command==="schedule.link_customer")return {error:"schedule_customer_link_ambiguous"};
   throw new Error("unexpected command");
  });
  const out=await call("egc.link_project",{requestId,portalJobId,expectedRevision:revision});
  expect(out.structuredContent.result).toMatchObject({error:"schedule_customer_link_ambiguous"});
 });
});
