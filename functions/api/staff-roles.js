import { getHubSession } from '../_lib/hub-session.js';
import { OWNER_CAPABILITIES, ROLE_CAPABILITIES, STAFF_CAPABILITIES, STAFF_ROLES, capabilityMode, sanitizeStaffRoles, staffCapabilities } from '../_lib/staff-roles.js';

// Read-only: the role/capability matrix and the signed-in user's own capabilities.
// Roles are changed through /api/staff-directory (set_roles, owner only).
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export function staffRolesHandlers({ session = getHubSession } = {}) {
  return {
    async get({ request, env }) {
      const actor = await session(request, env).catch(() => null);
      if (!actor?.user) return reply(401, { ok: false, code: 'staff_roles_sign_in_required', error: 'Sign in to view staff roles.' });
      return reply(200, { ok: true, authority: 'employee_hub', roles: STAFF_ROLES, capabilities: STAFF_CAPABILITIES, ownerCapabilities: OWNER_CAPABILITIES, matrix: ROLE_CAPABILITIES,
        viewer: { user: actor.user, mode: capabilityMode(actor, env), staffRoles: sanitizeStaffRoles(actor.staffRoles, actor), capabilities: staffCapabilities(actor, env) } });
    },
  };
}

const handlers = staffRolesHandlers();
export const onRequestGet = handlers.get;
