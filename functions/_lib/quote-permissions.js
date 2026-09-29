import { hasBusinessAccess } from './hub-session.js';
import { can, capabilityMode } from './staff-roles.js';

// P2-12: who may author quotes (unsigned drafts, sending options for review and
// signed walkthrough handoffs). Owners and managers (requireDispatcher) always
// can. With EGC_STAFF_ROLE_PERMISSIONS on, an account whose stored staff roles
// carry quotes.author (sales/walkthrough, manager) can too. With the flag off,
// or for an account without stored roles, this is exactly requireDispatcher, so
// today's access is unchanged. Being a quote author never grants dispatch:
// crew assignment and every /api/dispatch action still require requireDispatcher.
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const signed = session => Boolean(session) && typeof session === 'object' && typeof session.user === 'string' && Boolean(session.user.trim());

export const isDispatcher = session => signed(session) && hasBusinessAccess(session) && ['owner', 'manager'].includes(session.role);

export function quoteAuthorAccess(session, env = {}) {
  const dispatcher = isDispatcher(session);
  const author = dispatcher || signed(session) && capabilityMode(session, env) === 'staff_roles' && can(session, 'quotes.author', env);
  return { dispatcher, author };
}

export function requireQuoteAuthor(session, env = {}) {
  if (!signed(session)) throw fail('quote_sign_in_required', 'Sign in to the Employee Hub to prepare quotes.', 401);
  const access = quoteAuthorAccess(session, env);
  if (!access.author) throw fail('quote_forbidden', 'Only an owner, manager or walkthrough/sales employee can prepare quotes.', 403);
  return access;
}
