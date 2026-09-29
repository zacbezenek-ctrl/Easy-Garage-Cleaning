import { configuredBusinessAccess, hasBusinessAccess, isHubOwner, staffRoleAccessEnabled } from './hub-session.js';

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
// AUTH-ROLES: capabilities that exist only with EGC_STAFF_ROLE_ACCESS on (staffRoleAccessEnabled).
// schedule.book books, moves, cancels, restores and marks no-shows for customer visits (jobs and
// walkthroughs) and reads the schedule to do it; crew assignment, crews, vehicles, time off and
// company blocks stay dispatch.write, and it carries no pay, cost or money access.
// walkthrough.perform runs the walkthrough (gameplan, its signed handoff and customer, the visit
// recorder). With the flag off can() answers false for them and no list reports them.
export const ACCESS_CAPABILITIES = Object.freeze(['schedule.book', 'walkthrough.perform']);
export const ROLE_ACCESS_CAPABILITIES = Object.freeze({
  owner: ACCESS_CAPABILITIES,
  manager: ACCESS_CAPABILITIES,
  crew_lead: Object.freeze([]),
  crew: Object.freeze([]),
  sales: ACCESS_CAPABILITIES,
  phone: Object.freeze(['schedule.book']),
});
const ROLE_PRECEDENCE = ['owner', 'manager', 'crew_lead', 'sales', 'phone', 'crew'];
const known = new Set(STAFF_ROLES), capabilities = new Set(STAFF_CAPABILITIES), ownerOnly = new Set(OWNER_CAPABILITIES), accessOnly = new Set(ACCESS_CAPABILITIES);
const signedProfile = session => Boolean(session) && typeof session === 'object' && !Array.isArray(session) && typeof session.user === 'string' && Boolean(session.user.trim());

export { staffRoleAccessEnabled };
// EGC_STAFF_ROLE_ACCESS includes this flag, so one switch turns on the whole role model.
export const staffRolePermissionsEnabled = env => env?.EGC_STAFF_ROLE_PERMISSIONS === 'true' || staffRoleAccessEnabled(env);

// Unknown, duplicate and non-string entries are dropped; 'owner' is only kept for
// the configured owner's signed profile. Returns null when nothing is stored.
// These are the stored roles as displayed (roster, staff directory); can() acts
// on capabilityRoles below.
export function sanitizeStaffRoles(value, session = null) {
  if (!Array.isArray(value)) return null;
  const roles = [...new Set(value.filter(role => typeof role === 'string' && known.has(role)))];
  return STAFF_ROLES.filter(role => roles.includes(role) && (role !== 'owner' || isHubOwner(session)));
}

// The roles can() acts on (only with EGC_STAFF_ROLE_PERMISSIONS=true). The
// configured owner's signed profile is never left without a management role
// there: stored roles naming neither owner nor manager (['crew_lead'] for an
// owner who also works in the field, F19, or []) act as if they also held
// 'owner', so they cannot lock the owner out. An explicit ['manager'] is honored
// (the owner then acts with manager capabilities only). The stored roles, and
// what the roster and staff directory show, stay as sanitizeStaffRoles returns.
// With EGC_STAFF_ROLE_ACCESS (AUTH-ROLES) the owner always also holds 'owner',
// and an account outside the configured business users that has no stored roles
// acts on the role its account already names (defaultStaffRoles: a signed sales
// invitation is sales, anyone else crew). The configured business users without
// stored roles keep the legacy checks.
function capabilityRoles(session, env) {
  const access = staffRoleAccessEnabled(env);
  const roles = sanitizeStaffRoles(session?.staffRoles, session) || (access && signedProfile(session) && !configuredBusinessAccess(session) ? defaultStaffRoles(session) : null);
  if (!roles || !isHubOwner(session) || roles.includes('owner') || !access && roles.includes('manager')) return roles;
  return STAFF_ROLES.filter(role => role === 'owner' || roles.includes(role));
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

// Only the configured business users without stored roles reach the legacy
// checks for the AUTH-ROLES capabilities: a dispatcher books, and business access
// runs walkthroughs.
function legacyCan(session, capability) {
  if (ownerOnly.has(capability)) return isHubOwner(session);
  if (capability === 'dispatch.write' || capability === 'schedule.book') return hasBusinessAccess(session) && ['owner', 'manager'].includes(session.role);
  return hasBusinessAccess(session);
}

export function capabilityMode(session, env) {
  return staffRolePermissionsEnabled(env) && signedProfile(session) && capabilityRoles(session, env) ? 'staff_roles' : 'legacy';
}

export function can(session, capability, env = {}) {
  const access = accessOnly.has(capability);
  if (!access && !capabilities.has(capability)) throw new TypeError(`Unknown staff capability: ${capability}`);
  if (!signedProfile(session) || access && !staffRoleAccessEnabled(env)) return false;
  if (capabilityMode(session, env) === 'legacy') return legacyCan(session, capability);
  if (ownerOnly.has(capability) && !isHubOwner(session)) return false;
  const matrix = access ? ROLE_ACCESS_CAPABILITIES : ROLE_CAPABILITIES;
  return capabilityRoles(session, env).some(role => matrix[role].includes(capability));
}

// The capability names and role matrix a viewer is told about: with EGC_STAFF_ROLE_ACCESS
// off, exactly STAFF_CAPABILITIES and ROLE_CAPABILITIES.
export function capabilityNames(env = {}) {
  return staffRoleAccessEnabled(env) ? [...STAFF_CAPABILITIES, ...ACCESS_CAPABILITIES] : STAFF_CAPABILITIES;
}
export function capabilityMatrix(env = {}) {
  return staffRoleAccessEnabled(env) ? Object.fromEntries(STAFF_ROLES.map(role => [role, [...ROLE_CAPABILITIES[role], ...ROLE_ACCESS_CAPABILITIES[role]]])) : ROLE_CAPABILITIES;
}

export function staffCapabilities(session, env = {}) {
  return capabilityNames(env).filter(capability => can(session, capability, env));
}

// The roles can() acts on for this session, or null when the legacy checks decide.
export function capabilityRoleSet(session, env = {}) {
  return capabilityMode(session, env) === 'staff_roles' ? [...capabilityRoles(session, env)] : null;
}
