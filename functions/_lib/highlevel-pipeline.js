// The verified EGC Pipeline and the two stages the schedule mirror (ghl-schedule-mirror.js) moves an opportunity to.
// Like the calendars (highlevel-calendars.js), the built-in ids apply only when the EGC location is configured; any
// other location needs them from the environment, and without them the mirror moves no stage.
import { EGC_LOCATION } from './highlevel-calendars.js';

export const EGC_PIPELINE = 'anSgrMpYHtAX6YlUHnIR';
export const EGC_WALKTHROUGH_APPOINTMENT_STAGE = 'f14b91c5-a452-4e11-b0f9-bfcdd354b849';
export const EGC_JOB_SCHEDULED_STAGE = '9e14286c-0c24-4773-b403-790e7bbc68de';

/** {pipelineId, walkthroughStageId, jobScheduledStageId}; '' for any id not configured. */
export function schedulePipeline(env = {}) {
  const isEGC = (env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID) === EGC_LOCATION;
  return {
    pipelineId: env.HIGHLEVEL_PIPELINE_ID || env.GHL_PIPELINE_ID || (isEGC ? EGC_PIPELINE : ''),
    walkthroughStageId: env.HIGHLEVEL_WALKTHROUGH_APPOINTMENT_STAGE_ID || env.GHL_WALKTHROUGH_APPOINTMENT_STAGE_ID || (isEGC ? EGC_WALKTHROUGH_APPOINTMENT_STAGE : ''),
    jobScheduledStageId: env.HIGHLEVEL_JOB_SCHEDULED_STAGE_ID || env.GHL_JOB_SCHEDULED_STAGE_ID || (isEGC ? EGC_JOB_SCHEDULED_STAGE : ''),
  };
}
