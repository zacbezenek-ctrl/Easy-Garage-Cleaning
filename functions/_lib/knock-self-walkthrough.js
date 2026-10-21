import { repKeyFor } from './knock-access.js';
import { assignmentKey } from './job-assignment.js';

/* REP-WALKTHROUGH (owner decision 2026-10-21): a door-to-door rep runs the walkthrough at the door themselves. The right
   is Knock's own, never a Hub role: an admin turns on Walkthroughs for the rep in Knock Admin (knock_reps walkthroughSelf,
   knock-access.js repPatch, which records who turned it on and when). It reaches the walkthrough pages for ONE visit at a
   time: a Hub walkthrough the bridge booked for the rep's own "Do the walkthrough now" (knock-bridge.js bookSelfRun:
   source door_to_door, d2d {kind: 'walkthrough', repKey, selfRun: true}, assigned to the rep alone), and the job its
   signed handoff saved from it (sourceWalkthroughId). It is not the Sales role and carries none of it: no schedule.book,
   no Dispatch, no customer lookups, and the estimator pool stays chosen by skill and role (knock-bridge.js
   estimatorIds), so the rep is never booked to anyone else's walkthrough. A self-run visit only exists for a customer
   its booking created (knock-bridge.js EXISTING_CUSTOMER), so the right never opens a customer the Hub already had.
   Not covered: the audio recorder and walkthrough notes (/api/operations-recordings, /api/walkthrough-notes), so the
   rep types notes at Finish. Behind EGC_KNOCK_JOB_BRIDGE. */
export const knockJobBridgeEnabled = env => env?.EGC_KNOCK_JOB_BRIDGE === 'true';

// Set only by selfWalkthroughSession on the server's own session object: a browser cannot send a Symbol.
export const SELF_WALKTHROUGH = Symbol('egc.selfWalkthrough');
export const selfWalkthroughVisitId = session => typeof session?.[SELF_WALKTHROUGH] === 'string' ? session[SELF_WALKTHROUGH] : '';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:secure_|_egc_)/.test(value);

// An active Knock rep with Walkthroughs on.
export const repRunsWalkthroughs = rep => plain(rep) && rep.status === 'active' && rep.walkthroughSelf === true;

/** The rep's Knock record when they may run their own walkthroughs (the bridge on, Walkthroughs on, active), else null.
 * A storage fault reads as no right: the page then refuses as it does for anyone without walkthrough access. */
export async function walkthroughRep(session, env, knock) {
  if (!knockJobBridgeEnabled(env) || typeof session?.user !== 'string' || !session.user.trim()) return null;
  const rep = await Promise.resolve().then(() => knock.get('knock_reps', repKeyFor(session.user))).catch(() => null);
  return repRunsWalkthroughs(rep) ? rep : null;
}

/** Whether `visit` is the rep's own self-run walkthrough (booked by the bridge for their "Do the walkthrough now"). */
export function selfRunVisit(visit, session) {
  const user = assignmentKey(session?.user);
  return Boolean(user) && plain(visit) && visit.type === 'walkthrough' && !visit.recordType && visit.source === 'door_to_door' && plain(visit.d2d) &&
    visit.d2d.kind === 'walkthrough' && visit.d2d.selfRun === true && visit.d2d.repKey === repKeyFor(session.user) &&
    Array.isArray(visit.assignedCrew) && visit.assignedCrew.length === 1 && assignmentKey(visit.assignedCrew[0]) === user;
}

/** The session for one request that names only the rep's own self-run walkthrough (or the job saved from it): it runs
 * that walkthrough as a quote author who is not a dispatcher (quote-permissions.js, walkthrough-visit.js). Any other
 * request, any id of another visit or job, a rep without Walkthroughs, or a session that already runs walkthroughs
 * gets the session unchanged, so every check after it answers as before. readJob(id) reads one Hub job. */
export async function selfWalkthroughSession(session, env, ids, { readJob, knock, performer = () => false }) {
  if (!knockJobBridgeEnabled(env) || typeof session?.user !== 'string' || performer(session)) return session;
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(id => id !== undefined && id !== null && id !== ''))];
  if (!wanted.length || wanted.some(id => !safeId(id))) return session;
  // The rep's right first: no Hub job is read for anyone without it.
  if (!await walkthroughRep(session, env, knock)) return session;
  let visitId = '';
  for (const id of wanted) {
    const job = await Promise.resolve().then(() => readJob(id)).catch(() => null);
    if (!plain(job)) return session;
    const visit = job.type === 'walkthrough' ? job : safeId(job.sourceWalkthroughId) ? await Promise.resolve().then(() => readJob(job.sourceWalkthroughId)).catch(() => null) : null;
    if (!selfRunVisit(visit, session) || job !== visit && job.sourceWalkthroughId !== visit.id || visitId && visitId !== visit.id) return session;
    visitId = visit.id;
  }
  return { ...session, [SELF_WALKTHROUGH]: visitId };
}
