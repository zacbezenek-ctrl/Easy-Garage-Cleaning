import { localInstant } from './operations-portal-records.js';

// Effective with the owner's 2026-10-15 instruction. Historical appointments
// remain readable/editable without rewriting their original scheduled start.
export const JOB_START_POLICY_DATE = '2026-10-15';
export const JOB_START_MINIMUM = '09:30';
export const JOB_START_MESSAGE = 'Job work must start at 9:30 AM or later in America/Denver. Choose a later start time.';
const work = job => ['job', 'cleanout', 'reorg'].includes(job?.type);
const rows = job => Array.isArray(job?.assignmentSegments) && job.assignmentSegments.length ? job.assignmentSegments : job ? [job] : [];

export function jobStartProblem(before, after, { restore = false } = {}) {
  if (!work(after)) return null;
  const previous = rows(before);
  for (const row of rows(after)) {
    if (row.date < JOB_START_POLICY_DATE || !localInstant(row.date, row.time)) continue;
    // Unchanged starts are grandfathered even when notes, crew, or end time change.
    const same = previous.some(old => (old.id || '') === (row.id || '') && old.date === row.date && old.time === row.time);
    if (!restore && same) continue;
    if (row.time < JOB_START_MINIMUM) return JOB_START_MESSAGE;
  }
  return null;
}
