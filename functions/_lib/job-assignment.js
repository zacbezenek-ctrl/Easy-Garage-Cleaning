import { listHubUserProfiles } from './hub-session.js';
import { employeeAccountsConfigured, listEmployeeApplications } from './employee-accounts.js';

// Usernames are case-insensitive, but punctuation and suffixes are identity.
export const assignmentKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

const assignmentName = value => typeof value === 'string' ? value.trim()
  : String(value?.username || value?.user || value?.id || value?.name || '').trim();

export function jobCrewNames(job) {
  const explicit = Array.isArray(job?.assignedCrew) ? job.assignedCrew : [];
  const names = explicit.length ? explicit : String(job?.assignedTo || '').split(/\s*(?:,|\+|&|\band\b)\s*/i);
  const seen = new Set();
  return names.map(assignmentName).filter(name => name && !seen.has(assignmentKey(name)) && seen.add(assignmentKey(name)));
}

// Scope the roster lookup to a request. Only old display-name assignments need
// it; new assignments use the stable username and never need fuzzy matching.
export function createJobAssignmentAccess(env, session) {
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

  async function assigned(job) {
    if (!job) return false;
    const explicit = Array.isArray(job.assignedCrew) ? job.assignedCrew : [];
    const names = explicit.length ? explicit : jobCrewNames(job);
    for (const name of names) if (await matches(name)) return true;
    return false;
  }

  async function identities() {
    if (!username) return [];
    const names = [String(session.user).trim()];
    if (displayName && displayName !== username && await uniqueDisplayName()) names.push(String(session.displayName).trim());
    return names;
  }

  return { matches, assigned, identities };
}
