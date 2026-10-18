// Verified EGC customer calendars. These event calendars have no public booking
// hours; the manager's Hub schedule supplies their appointment times.
// D9b (owner, 2026-10-17): a HighLevel calendar is only a second record of the Hub
// schedule. The jobs calendar below was DELETED in HighLevel (verified 2026-10-17:
// the API answers 400 "The calendar is deleted."), so it is never a default: a job
// calendar comes from the environment only, and without one a job's calendar mirror
// is skipped (calendar_not_configured). The live walkthrough calendar keeps its default.
export const EGC_LOCATION = 'KlgLwRaQSPz5G1YXsmc6';
export const EGC_JOB_CALENDAR = 'KuLHTd1509oEl3KntLmF';
export const EGC_WALKTHROUGH_CALENDAR = 'qsibYaxFPm16uyovdIc5';
/** Why a calendar mirror was skipped. Neither is a failure of the Hub write or of the schedule mirror. */
export const CALENDAR_SKIP_REASONS = Object.freeze(['calendar_deleted', 'calendar_not_configured']);
/** The egc-api schedule.sync_provider codes for the same skips (egc-platform/apps/api/src/schedule-calendar.ts). */
export const CALENDAR_SKIP_CODES = Object.freeze({ schedule_calendar_deleted: 'calendar_deleted', schedule_calendar_not_configured: 'calendar_not_configured' });

export function customerCalendars(env) {
  const isEGC = (env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID) === EGC_LOCATION;
  return {
    jobCalendarId: env.HIGHLEVEL_JOB_CALENDAR_ID || env.GHL_JOB_CALENDAR_ID || '',
    walkthroughCalendarId: env.HIGHLEVEL_WALKTHROUGH_CALENDAR_ID || env.GHL_WALKTHROUGH_CALENDAR_ID || (isEGC ? EGC_WALKTHROUGH_CALENDAR : ''),
  };
}

export function isStaffScheduledCalendar(calendarId) {
  return [EGC_JOB_CALENDAR, EGC_WALKTHROUGH_CALENDAR].includes(calendarId);
}

/** 'calendar_deleted' when HighLevel's answer to an appointment write says the calendar is gone: a 400 naming a
 * deleted calendar, or a 404 to a create (a PUT's 404 is a missing appointment, not a missing calendar). Else null. */
export function calendarDeletedAnswer(error, { create = true } = {}) {
  if (!error || !Number.isInteger(error.status)) return null;
  if (error.status === 404 && create) return 'calendar_deleted';
  return error.status === 400 && /calendar\s+is\s+deleted|calendar\s+(?:was\s+)?deleted|calendar\s+not\s+found/i.test(String(error.detail || error.message || '')) ? 'calendar_deleted' : null;
}
