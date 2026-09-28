import { hasBusinessAccess, isHubOwner } from './hub-session.js';

// Canonical staff roles and the capabilities they carry. can(session, capability, env)
// is the one authorization check new Hub code uses. With EGC_STAFF_ROLE_PERMISSIONS
// off (the default), or for an account without stored staffRoles, it reproduces the
// hard-coded checks exactly: owner capabilities need isHubOwner, dispatch.write needs
// requireDispatcher (business access plus role owner|manager), and every other
// capability needs hasBusinessAccess. Stored roles never grant an owner capability to
// anyone but the configured owner.
export const STAFF_ROLES = Object.freeze(['owner', 'manager', 'crew_lead', 'crew', 'sales', 'phone']);
export const STAFF_CAPABILITIES = Object.freeze(['dispatch.write', 'time.approve', 'pay.manage', 'accounts.approve', 'money.refund', 'money.charge_stored_card', 'customer.send', 'followups.own', 'quotes.author', 'mcp.write', 'b2b.manage', 'catalog.manage', 'settings.manage']);
export const OWNER_CAPABILITIES = Object.freeze(['pay.manage', 'accounts.approve', 'money.refund', 'money.charge_stored_card', 'catalog.manage', 'settings.manage']);
const MANAGER_CAPABILITIES = Object.freeze(['dispatch.write', 'time.approve', 'customer.send', 'followups.own', 'quotes.author', 'mcp.write', 'b2b.manage']);
export const ROLE_CAPABILITIES = Object.freeze({
  owner: STAFF_CAPABILITIES,
  manager: MANAGER_CAPABILITIES,
  crew_lead: Object.freeze([]),
  crew: Object.freeze([]),
  sales: Object.freeze(['customer.send', 'followups.own', 'quotes.author']),
  phone: Object.freeze(['customer.send', 'followups.own']),
});
const ROLE_PRECEDENCE = ['owner', 'manager', 'crew_lead', 'sales', 'phone', 'crew'];
const known = new Set(STAFF_ROLES), capabilities = new Set(STAFF_CAPABILITIES), ownerOnly = new Set(OWNER_CAPABILITIES);
const signedProfile = session => Boolean(session) && typeof session === 'object' && !Array.isArray(session) && typeof session.user === 'string' && Boolean(session.user.trim());

export const staffRolePermissionsEnabled = env => env?.EGC_STAFF_ROLE_PERMISSIONS === 'true';

// Unknown, duplicate and non-string entries are dropped; 'owner' is only kept for
// the configured owner's signed profile. Returns null when nothing is stored.
export function sanitizeStaffRoles(value, session = null) {
  if (!Array.isArray(value)) return null;
  const roles = [...new Set(value.filter(role => typeof role === 'string' && known.has(role)))];
  return STAFF_ROLES.filter(role => roles.includes(role) && (role !== 'owner' || isHubOwner(session)));
}

// Roles derived from today's account data, for display and the migration backfill.
export function defaultStaffRoles(profile) {
  if (isHubOwner(profile)) return ['owner'];
  const role = String(profile?.role || '').trim().toLowerCase();
  if (hasBusinessAccess(profile) && ['owner', 'manager'].includes(role)) return ['manager'];
  return ['crew_lead', 'sales', 'phone'].includes(role) ? [role] : ['crew'];
}

export function primaryStaffRole(roles) {
  return ROLE_PRECEDENCE.find(role => Array.isArray(roles) && roles.includes(role)) || 'crew';
}

function legacyCan(session, capability) {
  if (ownerOnly.has(capability)) return isHubOwner(session);
  if (capability === 'dispatch.write') return hasBusinessAccess(session) && ['owner', 'manager'].includes(session.role);
  return hasBusinessAccess(session);
}

export function capabilityMode(session, env) {
  return staffRolePermissionsEnabled(env) && signedProfile(session) && sanitizeStaffRoles(session.staffRoles, session) ? 'staff_roles' : 'legacy';
}

export function can(session, capability, env = {}) {
  if (!capabilities.has(capability)) throw new TypeError(`Unknown staff capability: ${capability}`);
  if (!signedProfile(session)) return false;
  if (capabilityMode(session, env) === 'legacy') return legacyCan(session, capability);
  if (ownerOnly.has(capability) && !isHubOwner(session)) return false;
  return sanitizeStaffRoles(session.staffRoles, session).some(role => ROLE_CAPABILITIES[role].includes(capability));
}

export function staffCapabilities(session, env = {}) {
  return STAFF_CAPABILITIES.filter(capability => can(session, capability, env));
}
