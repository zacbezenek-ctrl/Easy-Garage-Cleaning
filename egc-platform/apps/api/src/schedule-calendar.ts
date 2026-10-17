/** D9b (owner, 2026-10-17): a HighLevel calendar is only a second record of the Hub schedule. Which calendar a
 * schedule.sync_provider create may write, decided from the provider's calendar list alone (no import, so the root Hub
 * tests load it too). The jobs calendar is env-only (GHL_JOBS_CALENDAR_ID): the old "EGC Customer Jobs" calendar was
 * deleted in HighLevel (verified 2026-10-17: 400 "The calendar is deleted."), so a name match is never a default for
 * jobs. Walkthroughs keep GHL_WALKTHROUGH_CALENDAR_ID, else the single calendar named like "walkthrough".
 * A skip is a code, never a provider write:
 *   schedule_calendar_not_configured  no jobs calendar configured;
 *   schedule_calendar_deleted         the configured calendar is missing from the list or marked deleted/inactive, or
 *                                     (calendarGoneOnUpdate) HighLevel's answer about a visit's existing appointment
 *                                     says its calendar is gone.
 * The Hub records both as "calendar mirror skipped" and takes the visit out of its queue at once
 * (functions/_lib/schedule-sync-queue.js SCHEDULE_SYNC_CALENDAR_SKIP_CODES), and its browser sync reports the same
 * (functions/api/highlevel.js), so nothing is retried every tick, and the Hub save and the Hub's schedule mirror
 * (contact, opportunity, note) never wait on a calendar. */
type Json=Record<string,unknown>;
export const CALENDAR_SKIP_CODES=Object.freeze(["schedule_calendar_deleted","schedule_calendar_not_configured"] as const);
export type CalendarChoice={calendarId:string}|{skip:typeof CALENDAR_SKIP_CODES[number]}|{ambiguous:true};
const object=(value:unknown):value is Json=>!!value&&typeof value==="object"&&!Array.isArray(value);
const gone=(calendar:Json)=>calendar.deleted===true||calendar.isActive===false;

export function chooseScheduleCalendar(type:string,env:Record<string,string|undefined>,listed:unknown[]):CalendarChoice{
  const calendars=listed.filter(object).filter(calendar=>typeof calendar.id==="string"&&calendar.id);
  const walkthrough=type==="walkthrough",configured=walkthrough?env.GHL_WALKTHROUGH_CALENDAR_ID:env.GHL_JOBS_CALENDAR_ID;
  if(!walkthrough&&!configured)return {skip:"schedule_calendar_not_configured"};
  if(configured){
    const match=calendars.find(calendar=>calendar.id===configured);
    if(!match||gone(match))return {skip:"schedule_calendar_deleted"};
    if(/employee|hiring|interview/i.test(String(match.name)))return {ambiguous:true};
    return {calendarId:configured};
  }
  const candidates=calendars.filter(calendar=>!gone(calendar)&&/walkthrough/i.test(String(calendar.name)));
  if(candidates.length!==1||/employee|hiring|interview/i.test(String(candidates[0]?.name)))return {ambiguous:true};
  return {calendarId:String(candidates[0]!.id)};
}

/** True when HighLevel's error for a visit's EXISTING appointment says the calendar is gone: a 400 naming a deleted
 * calendar (the live answer for KuLHTd1509oEl3KntLmF on 2026-10-17), or a 404 for a job while no jobs calendar is
 * configured (the jobs calendar is env-only, so such an appointment can only have been on the deleted one). A
 * walkthrough's 404 stays an ordinary failure: its calendar is live, so the appointment itself is what is missing.
 * Duck-typed (status, body or message) so this module stays import-free. */
export function calendarGoneOnUpdate(error:unknown,type:string,env:Record<string,string|undefined>):boolean{
  const e=object(error)?error:{};
  if(e.status===400&&/calendar\s+(?:is\s+|was\s+|has\s+been\s+)?deleted/i.test(`${String(e.body??"")} ${String(e.message??"")}`))return true;
  return e.status===404&&type!=="walkthrough"&&!env.GHL_JOBS_CALENDAR_ID;
}
