// Verified EGC customer calendars. These event calendars have no public booking
// hours; the manager's Hub schedule supplies their appointment times.
const EGC_LOCATION = 'KlgLwRaQSPz5G1YXsmc6';
export const EGC_JOB_CALENDAR = 'KuLHTd1509oEl3KntLmF';
export const EGC_WALKTHROUGH_CALENDAR = 'qsibYaxFPm16uyovdIc5';

export function customerCalendars(env) {
  const isEGC = (env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID) === EGC_LOCATION;
  return {
    jobCalendarId: env.HIGHLEVEL_JOB_CALENDAR_ID || env.GHL_JOB_CALENDAR_ID || (isEGC ? EGC_JOB_CALENDAR : ''),
    walkthroughCalendarId: env.HIGHLEVEL_WALKTHROUGH_CALENDAR_ID || env.GHL_WALKTHROUGH_CALENDAR_ID || (isEGC ? EGC_WALKTHROUGH_CALENDAR : ''),
  };
}

export function isStaffScheduledCalendar(calendarId) {
  return [EGC_JOB_CALENDAR, EGC_WALKTHROUGH_CALENDAR].includes(calendarId);
}
