import {beforeEach,describe,expect,it,vi} from "vitest";
import type {Actor,Command} from "@egc/operations";
type Json=Record<string,unknown>;
// D9b: a visit already bound to an appointment on the deleted jobs calendar is a calendar skip on the update path too,
// never a retry until review. Synthetic Hub bridge, database and provider; no network.
vi.mock("@egc/lead-audit",()=>({recomputeLeadState:vi.fn(async()=>undefined)}));
vi.mock("@egc/database",()=>{
 const schema={contacts:{name:"contacts"},leads:{name:"leads"},appointmentOperations:{name:"appointmentOperations",request:"request"},appointments:{name:"appointments"},auditLogs:{name:"auditLogs"}};
 const db={
  select:()=>({from:(table:unknown)=>{const rows=table===schema.contacts?[{id:"contact-row",providerId:"contact-1"}]:[];const query:Json={where:()=>query,orderBy:async()=>rows,limit:async()=>rows};return query;}}),
  insert:()=>({values:()=>({onConflictDoNothing:async()=>undefined,onConflictDoUpdate:()=>({returning:async()=>[]})})}),
 };
 return {schema,getDb:()=>db};
});
import {syncPortalSchedule} from "./scheduling.js";

const actor:Actor={id:"schedule-sync-worker",kind:"integration",role:"integration",workspace:"egc"};
const visit=(type:string):Json=>({portalVisitId:"visit-1",portalCustomerId:"customer-1",type,status:"scheduled",title:"Synthetic visit",address:"1 Synthetic Way",startTime:"2026-10-22T15:30:00.000Z",endTimeInstant:"2026-10-22T18:30:00.000Z",highlevelContactId:"contact-1",highlevelAppointmentId:"appointment-on-deleted-calendar",revision:"r1"});
const portal=(type:string)=>vi.fn(async(_actor:Actor,command:Command):Promise<Json>=>({visit:visit(type),command:command.command}));
const providerError=(status:number,body:string)=>Object.assign(new Error(`GHL request failed: ${status} /calendars/events/appointments/appointment-on-deleted-calendar`),{status,body});
const provider=(error:Error)=>({locationId:"location-1",getContact:vi.fn(async()=>({contact:{id:"contact-1",locationId:"location-1"}})),getAppointment:vi.fn(async()=>{throw error;}),getCalendars:vi.fn(async()=>({calendars:[]})),createAppointment:vi.fn(),updateAppointment:vi.fn()});
const command={command:"schedule.sync_provider" as const,portalVisitId:"visit-1",requestId:"dispatch-key:mirror",runAutomations:false};
const sync=(type:string,error:Error,env:Json={})=>{const p=provider(error);return {p,result:syncPortalSchedule(actor,command as never,portal(type),{env:env as NodeJS.ProcessEnv,provider:p as never})};};

beforeEach(()=>vi.clearAllMocks());
describe("schedule.sync_provider on an appointment whose calendar is gone",()=>{
 it("HighLevel's 400 'The calendar is deleted.' is schedule_calendar_deleted, before any provider write",async()=>{
  const {p,result}=sync("job",providerError(400,'{"statusCode":400,"message":"The calendar is deleted."}'));
  await expect(result).rejects.toMatchObject({code:"schedule_calendar_deleted",status:409});
  expect(p.getAppointment).toHaveBeenCalledWith("appointment-on-deleted-calendar");
  expect(p.updateAppointment).not.toHaveBeenCalled();expect(p.createAppointment).not.toHaveBeenCalled();
 });
 it("a job's 404 with no jobs calendar configured is the deleted calendar too; with one configured it stays an ordinary failure",async()=>{
  await expect(sync("job",providerError(404,"{}")).result).rejects.toMatchObject({code:"schedule_calendar_deleted"});
  const configured=sync("job",providerError(404,"{}"),{GHL_JOBS_CALENDAR_ID:"new-jobs"});
  await expect(configured.result).rejects.toMatchObject({code:"schedule_provider_sync_unavailable",status:503});
  expect(configured.p.getAppointment).toHaveBeenCalledTimes(1);
 });
 it("a walkthrough's 404 (its calendar is live) and any other provider error keep retrying as before",async()=>{
  const walk=sync("walkthrough",providerError(404,"{}"));
  await expect(walk.result).rejects.toMatchObject({code:"schedule_provider_sync_unavailable"});
  expect(walk.p.getAppointment).toHaveBeenCalledTimes(1);
  await expect(sync("job",providerError(503,"The calendar is deleted.")).result).rejects.toMatchObject({code:"schedule_provider_sync_unavailable"});
 });
});
