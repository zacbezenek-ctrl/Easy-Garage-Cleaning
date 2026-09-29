import { can } from './staff-roles.js';

/** Dispatch permission (P1-DS-03): the P1-08 capability dispatch.write. With
 * EGC_STAFF_ROLE_PERMISSIONS unset (the default) or for an account without
 * stored staff roles this is exactly the older check (business access plus the
 * owner or manager role); with it on, stored roles decide (staff-roles.js).
 * An HTTP handler checks with its env; the library calls it then makes for the
 * same request have no env, so the handler's answer for that session object,
 * a grant or a denial, is remembered here (never written onto the session) and
 * any other session gets the default check. A spread copy of a session is a new
 * object and is checked afresh. Only a call without env consults that memory:
 * a call with an explicit env is always checked against it and replaces the
 * remembered answer. So a handler that checks with env first (a requireDispatcher
 * or canDispatch call with env) makes its library's env-less checks follow stored
 * roles too: a manager whose stored roles were lowered is not let back in by the
 * older owner-or-manager check. */
const decided = new WeakMap();

export function canDispatch(session, env) {
  if (!session || typeof session !== 'object') return false;
  if (env === undefined) return decided.has(session) ? decided.get(session) : can(session, 'dispatch.write');
  const allowed = can(session, 'dispatch.write', env);
  decided.set(session, allowed);
  return allowed;
}
