import {describe,expect,it} from "vitest";
import {CALENDAR_SKIP_CODES,calendarGoneOnUpdate,chooseScheduleCalendar} from "./schedule-calendar.js";
import {SCHEDULE_SYNC_CALENDAR_SKIPS,runScheduleSyncTick,scheduleSyncAlerts,type ScheduleSyncExecute} from "./schedule-sync-worker.js";

// D9b: the HighLevel calendar is only a second record. Synthetic calendar lists; no provider is called.
const DELETED_JOBS="KuLHTd1509oEl3KntLmF",WALK="qsibYaxFPm16uyovdIc5";
const listed=[{id:WALK,name:"EGC Customer Walkthroughs"},{id:"hiring",name:"Employee hiring"}];

describe("schedule calendar choice",()=>{
 it("never defaults a job to a calendar found by name: the jobs calendar is env-only",()=>{
  expect(chooseScheduleCalendar("job",{},[...listed,{id:DELETED_JOBS,name:"EGC Customer Jobs"}])).toEqual({skip:"schedule_calendar_not_configured"});
 });
 it("a configured jobs calendar HighLevel no longer lists, or marks deleted, is skipped as calendar_deleted",()=>{
  expect(chooseScheduleCalendar("job",{GHL_JOBS_CALENDAR_ID:DELETED_JOBS},listed)).toEqual({skip:"schedule_calendar_deleted"});
  expect(chooseScheduleCalendar("job",{GHL_JOBS_CALENDAR_ID:DELETED_JOBS},[{id:DELETED_JOBS,name:"EGC Customer Jobs",deleted:true}])).toEqual({skip:"schedule_calendar_deleted"});
  expect(chooseScheduleCalendar("job",{GHL_JOBS_CALENDAR_ID:"new-jobs"},[{id:"new-jobs",name:"EGC Crew Jobs"}])).toEqual({calendarId:"new-jobs"});
 });
 it("walkthroughs keep the configured or the single walkthrough calendar, and never the hiring calendar",()=>{
  expect(chooseScheduleCalendar("walkthrough",{},listed)).toEqual({calendarId:WALK});
  expect(chooseScheduleCalendar("walkthrough",{GHL_WALKTHROUGH_CALENDAR_ID:WALK},listed)).toEqual({calendarId:WALK});
  expect(chooseScheduleCalendar("walkthrough",{GHL_WALKTHROUGH_CALENDAR_ID:"hiring"},listed)).toEqual({ambiguous:true});
  expect(chooseScheduleCalendar("walkthrough",{},[...listed,{id:"two",name:"Second walkthrough"}])).toEqual({ambiguous:true});
 });
 it("an existing appointment on a deleted calendar is a skip too: a 400 naming it, or a job's 404 with no jobs calendar",()=>{
  const body='{"statusCode":400,"message":"The calendar is deleted."}';
  expect(calendarGoneOnUpdate({status:400,body},"job",{})).toBe(true);
  expect(calendarGoneOnUpdate({status:400,body},"walkthrough",{GHL_WALKTHROUGH_CALENDAR_ID:WALK})).toBe(true);
  expect(calendarGoneOnUpdate({status:404,body:"{}"},"job",{})).toBe(true);
  expect(calendarGoneOnUpdate({status:404,body:"{}"},"cleanout",{})).toBe(true);
  expect(calendarGoneOnUpdate({status:404,body:"{}"},"job",{GHL_JOBS_CALENDAR_ID:"new-jobs"})).toBe(false);
  expect(calendarGoneOnUpdate({status:404,body:"{}"},"walkthrough",{})).toBe(false);
  expect(calendarGoneOnUpdate({status:400,body:'{"message":"Slot unavailable"}'},"job",{})).toBe(false);
  expect(calendarGoneOnUpdate({status:503,body:"The calendar is deleted."},"job",{})).toBe(false);
  expect(calendarGoneOnUpdate(new Error("network"),"job",{})).toBe(false);
  expect(calendarGoneOnUpdate(null,"job",{})).toBe(false);
 });
 it("a calendar skip is reported to the Hub once per tick, which records it as skipped (no retry every tick, never a failure alert)",async()=>{
  const calls:Record<string,unknown>[]=[];
  const execute:ScheduleSyncExecute=async(_actor,body)=>{
   calls.push(body);
   if(body.command==="schedule.sync_due")return {ok:true,authority:"employee_hub",items:[{portalVisitId:"visit-job",requestId:"dispatch-key:mirror",expectedRevision:"r1"}],counts:{due:1},coverage:{complete:true},heartbeat:true};
   if(body.command==="schedule.sync_provider")throw Object.assign(new Error("schedule_calendar_deleted"),{code:"schedule_calendar_deleted",status:409});
   return {ok:true,authority:"employee_hub",syncStatus:"synced",reviewRequired:false};
  };
  const result=await runScheduleSyncTick({execute,now:()=>Date.parse("2026-10-17T18:00:00.000Z")});
  expect(result.counts).toMatchObject({selected:1,calendarSkipped:1,failed:0,synced:0});
  expect(scheduleSyncAlerts(result)).toEqual([]);
  expect(calls.filter(call=>call.command==="schedule.sync_failed")).toEqual([expect.objectContaining({code:"schedule_calendar_deleted",portalVisitId:"visit-job"})]);
  expect([...CALENDAR_SKIP_CODES]).toEqual(["schedule_calendar_deleted","schedule_calendar_not_configured"]);
  expect([...SCHEDULE_SYNC_CALENDAR_SKIPS]).toEqual([...CALENDAR_SKIP_CODES]);
 });
});
