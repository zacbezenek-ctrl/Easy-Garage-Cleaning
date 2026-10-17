// Who is going (D9 / WP13): a walkthrough's estimator as the HighLevel user its appointment and opportunity are
// assigned to. The staff directory profile may carry highlevelUserId (a manager-only field the people lane adds);
// with none, or with the directory off, callers fall back to HIGHLEVEL_USER_ID exactly as before. Only that one
// profile is read (one document per legacy spelling), never the whole staff vault.
import { readOne } from './employee-vault.js';
import { legacyPersonKeys, personKey, staffDirectoryEnabled } from './staff-directory.js';

const HIGHLEVEL_USER = /^[A-Za-z0-9]{8,64}$/;
export const storedHighLevelUserId = value => typeof value === 'string' && HIGHLEVEL_USER.test(value.trim()) ? value.trim() : null;

/** A walkthrough's estimator (roster id): its crew lead, else the first person assigned. '' for any other visit. */
export function walkthroughEstimator(job) {
  if (job?.type !== 'walkthrough') return '';
  const first = Array.isArray(job.assignedCrew) ? job.assignedCrew.find(value => typeof value === 'string' && value.trim()) : '';
  return personKey(typeof job.crewLead === 'string' && job.crewLead.trim() ? job.crewLead : first || '');
}

/** The walkthrough estimator's HighLevel user id, or null: not a walkthrough, nobody assigned, the staff directory
 * off (EGC_STAFF_DIRECTORY_ENABLED), no mapped id, or an unreadable profile. `read(collection, id)` returns {data}. */
export async function estimatorHighLevelUserId(env, job, { read = (collection, id) => readOne(env, collection, id) } = {}) {
  const id = walkthroughEstimator(job);
  if (!id || !staffDirectoryEnabled(env)) return null;
  try {
    for (const key of [id, ...legacyPersonKeys(id)]) {
      const data = (await read('profiles', key))?.data;
      if (data && personKey(data.username || data.user) === id) return storedHighLevelUserId(data.highlevelUserId);
    }
  } catch { /* An unreadable profile keeps today's single HighLevel user. */ }
  return null;
}
