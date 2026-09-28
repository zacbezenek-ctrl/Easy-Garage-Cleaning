import { hasBusinessAccess, listHubUserProfiles } from './hub-session.js';
import { employeeAccountsConfigured, listEmployeeApplications } from './employee-accounts.js';
import { sanitizeStaffRoles } from './staff-roles.js';

// Members the operations bridge may assign work to. Today: the configured business
// users. With EGC_OPERATIONS_STAFF_MEMBERS=true, business users carry their configured
// staffRoles, and configured users and approved employee accounts whose staff roles
// include sales or phone (for example the walkthrough/phone person) are added with
// id = their username and businessAccess:false. Identities that differ only by case fail closed.
export const operationsStaffMembersEnabled = env => env?.EGC_OPERATIONS_STAFF_MEMBERS === 'true';
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const FOLLOWUP_ROLES = ['sales', 'phone'];

// The members plus `others`: identities the Hub knows that cannot take work, as
// {id, active}. Configured users and approved accounts without a sales or phone role are
// active; accounts that are not approved are not. With the flag off, configured users
// holding sales or phone are {id, active:true, staffOnly:true}: only the flag keeps them
// out (employee accounts are not read at all). Only names and status are kept.
export async function operationsRoster(env, { accounts = listEmployeeApplications } = {}) {
  const enabled = operationsStaffMembersEnabled(env), configured = listHubUserProfiles(env);
  const members = configured.filter(hasBusinessAccess).map(p => {
    const staffRoles = enabled ? sanitizeStaffRoles(p.staffRoles, p) : null;
    return { id: p.user, name: p.displayName, role: p.role, ...(staffRoles?.length ? { staffRoles } : {}) };
  });
  const seen = new Set(members.map(member => member.id.trim().toLowerCase())), idle = [];
  const add = (id, name, roles, active = true) => {
    const staffRoles = roles.filter(role => FOLLOWUP_ROLES.includes(role));
    if (!active || !staffRoles.length) { if (id) idle.push({ id, active }); return; }
    if (!enabled) { if (id) idle.push({ id, active: true, staffOnly: true }); return; }
    if (!id || seen.has(id.toLowerCase())) throw failure('portal_members_ambiguous');
    seen.add(id.toLowerCase());
    members.push({ id, name, role: staffRoles[0], staffRoles, businessAccess: false });
  };
  for (const p of configured) if (!hasBusinessAccess(p)) add(String(p.user || '').trim(), String(p.displayName || p.user), sanitizeStaffRoles(p.staffRoles, p) || []);
  if (enabled && employeeAccountsConfigured(env)) {
    let rows;
    // Account storage failures surface as the bridge's retryable code, never their message.
    try { rows = await accounts(env); } catch { throw failure('portal_source_unavailable', 503); }
    for (const account of rows) {
      const id = String(account?.username || '').trim();
      add(id, String(account?.displayName || id), sanitizeStaffRoles(account?.staffRoles, { user: id, businessAccess: false }) || [account?.role === 'sales' ? 'sales' : 'crew'], account?.status === 'approved');
    }
  }
  return { members, others: idle.filter(entry => !seen.has(entry.id.toLowerCase())) };
}

export async function operationsMembers(env, options) {
  return (await operationsRoster(env, options)).members;
}
