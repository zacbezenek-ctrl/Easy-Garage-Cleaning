import { hasBusinessAccess, listHubUserProfiles } from './hub-session.js';
import { employeeAccountsConfigured, listEmployeeApplications } from './employee-accounts.js';
import { sanitizeStaffRoles } from './staff-roles.js';

// Members the operations bridge may assign work to. Today: the configured business
// users. With EGC_OPERATIONS_STAFF_MEMBERS=true, business users carry their configured
// staffRoles, and configured users and approved employee accounts whose staff roles
// include sales or phone (for example the walkthrough/phone person) are added with
// id = their username. Identities that differ only by case fail closed.
export const operationsStaffMembersEnabled = env => env?.EGC_OPERATIONS_STAFF_MEMBERS === 'true';
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const FOLLOWUP_ROLES = ['sales', 'phone'];

export async function operationsMembers(env, { accounts = listEmployeeApplications } = {}) {
  const enabled = operationsStaffMembersEnabled(env), configured = listHubUserProfiles(env);
  const members = configured.filter(hasBusinessAccess).map(p => {
    const staffRoles = enabled ? sanitizeStaffRoles(p.staffRoles, p) : null;
    return { id: p.user, name: p.displayName, role: p.role, ...(staffRoles?.length ? { staffRoles } : {}) };
  });
  if (!enabled) return members;
  const seen = new Set(members.map(member => member.id.trim().toLowerCase()));
  const add = (id, name, roles) => {
    const staffRoles = roles.filter(role => FOLLOWUP_ROLES.includes(role));
    if (!staffRoles.length) return;
    if (!id || seen.has(id.toLowerCase())) throw failure('portal_members_ambiguous');
    seen.add(id.toLowerCase());
    members.push({ id, name, role: staffRoles[0], staffRoles });
  };
  for (const p of configured) if (!hasBusinessAccess(p)) add(String(p.user || '').trim(), String(p.displayName || p.user), sanitizeStaffRoles(p.staffRoles, p) || []);
  if (!employeeAccountsConfigured(env)) return members;
  let rows;
  // Account storage failures surface as the bridge's retryable code, never their message.
  try { rows = await accounts(env); } catch { throw failure('portal_source_unavailable', 503); }
  for (const account of rows) {
    if (account?.status !== 'approved') continue;
    const id = String(account.username || '').trim();
    add(id, String(account.displayName || id), sanitizeStaffRoles(account.staffRoles, { user: id, businessAccess: false }) || [account.role === 'sales' ? 'sales' : 'crew']);
  }
  return members;
}
