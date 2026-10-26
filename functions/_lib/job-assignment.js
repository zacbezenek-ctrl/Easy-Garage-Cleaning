import { hasBusinessAccess, listHubUserProfiles } from './hub-session.js';
import { selfRunCardHidden, selfWalkthroughVisitId } from './knock-self-walkthrough.js';
import { quoteAuthorAccess } from './quote-permissions.js';
import { walkthroughPerformer } from './walkthrough-visit.js';

// A handler clock for createJobAssignmentAccess: a function, a Date or an ISO instant; none keeps the default.
export const assignmentClock = at => at === undefined || at === null || at === '' ? {} : { now: typeof at === 'function' ? at : () => new Date(at) };
import { employeeAccountsConfigured, listEmployeeApplications } from './employee-accounts.js';

// Usernames are case-insensitive, but punctuation and suffixes are identity.
export const assignmentKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

const assignmentName = value => typeof value === 'string' ? value.trim()
  : String(value?.username || value?.user || value?.id || value?.name || '').trim();

export function jobCrewNames(job) {
  const names = Array.isArray(job?.assignedCrew) ? job.assignedCrew : String(job?.assignedTo || '').split(/\s*(?:,|\+|&|\band\b)\s*/i);
  const seen = new Set();
  return names.map(assignmentName).filter(name => name && !seen.has(assignmentKey(name)) && seen.add(assignmentKey(name)));
}

// Scope the roster lookup to a request. Only old display-name assignments need
// it; new assignments use the stable username and never need fuzzy matching.
// REP-WALKTHROUGH: a Knock rep stays on the crew of their own self-run walkthrough (assignedCrew [rep]) after their right
// to it ends (knock-self-walkthrough.js selfRunCardHidden), so assigned() stops counting them then: every assignment
// gate (customer messages, the job room, uploads, sends) refuses them, and no stored job needs rewriting. Managers are
// never affected, nor is anyone who runs walkthroughs in their own right (an estimator, a quote author: their visits
// follow the ordinary rules), nor a session granted that visit for this request (its window was checked on the
// request's clock). now: the request's clock (the handler's injected one where it has it).
export function createJobAssignmentAccess(env, session, { now = () => new Date() } = {}) {
  const username = assignmentKey(session?.user);
  const displayName = assignmentKey(session?.displayName);
  let aliasCheck;
  const uniqueDisplayName = () => aliasCheck ||= (async () => {
    const profiles = listHubUserProfiles(env);
    if (employeeAccountsConfigured(env)) profiles.push(...(await listEmployeeApplications(env)).filter(profile => profile.status === 'approved'));
    return !profiles.some(profile => {
      const user = assignmentKey(profile.user || profile.username);
      return user && user !== username && (user === displayName || assignmentKey(profile.displayName) === displayName);
    });
  })().catch(() => false); // An unreadable roster cannot prove a legacy alias.

  async function matches(value) {
    const key = assignmentKey(assignmentName(value));
    if (!username || !key) return false;
    if (key === username) return true;
    // An explicit account identifier on an object is authoritative over its label.
    if (value && typeof value === 'object' && (value.username || value.user || value.id)) return false;
    return Boolean(displayName && key === displayName && await uniqueDisplayName());
  }

  // Their own walkthrough right, never one a Knock rep's grant lends for a single visit.
  let own;
  const ownRight = () => own ??= !selfWalkthroughVisitId(session) && (walkthroughPerformer(session, env) || quoteAuthorAccess(session, env).author);

  async function assigned(job) {
    if (!job) return false;
    // A session granted this very visit (selfWalkthroughSession) was already checked against the request's own clock.
    if (job.type === 'walkthrough' && !hasBusinessAccess(session) && selfWalkthroughVisitId(session) !== job.id && !ownRight() && selfRunCardHidden(job, session, now())) return false;
    const names = Array.isArray(job.assignedCrew) ? job.assignedCrew : jobCrewNames(job);
    for (const name of names) if (await matches(name)) return true;
    return false;
  }

  async function identities() {
    if (!username) return [];
    const names = [String(session.user).trim()];
    if (displayName && displayName !== username && await uniqueDisplayName()) names.push(String(session.displayName).trim());
    return names;
  }

  // Per-day segment assignments store canonical usernames, so they match the
  // signed-in username only, never a display-name alias.
  const exactly = value => Boolean(username) && assignmentKey(assignmentName(value)) === username;

  return { matches, assigned, identities, exactly };
}
