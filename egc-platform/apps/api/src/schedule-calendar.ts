/** D9b (owner, 2026-10-17): a HighLevel calendar is only a second record of the Hub schedule. Which calendar a
 * schedule.sync_provider create may write, decided from the provider's calendar list alone (no import, so the root Hub
 * tests load it too). The jobs calendar is env-only (GHL_JOBS_CALENDAR_ID): the old "EGC Customer Jobs" calendar was
 * deleted in HighLevel (verified 2026-10-17: 400 "The calendar is deleted."), so a name match is never a default for
 * jobs. Walkthroughs keep GHL_WALKTHROUGH_CALENDAR_ID, else the single calendar named like "walkthrough".
 * A skip is a code, never a provider write:
 *   schedule_calendar_not_configured  no jobs calendar configured;
 *   schedule_calendar_deleted         the configured calendar is missing from the list or marked deleted/inactive.
 * The Hub parks both at once (functions/_lib/schedule-sync-queue.js SCHEDULE_SYNC_PARK_CODES) and its browser sync
 * reports "calendar mirror skipped" (functions/api/highlevel.js), so nothing is retried every tick, and the Hub save
 * and the Hub's schedule mirror (contact, opportunity, note) never wait on a calendar. */
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

