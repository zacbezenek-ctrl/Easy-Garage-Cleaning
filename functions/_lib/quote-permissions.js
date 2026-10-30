import { hasBusinessAccess } from './hub-session.js';
import { can, capabilityMode, staffRoleAccessEnabled } from './staff-roles.js';
import { selfWalkthroughVisitId } from './knock-self-walkthrough.js';

// P2-12: who may author quotes (unsigned drafts, sending options for review and
// signed walkthrough handoffs). Owners and managers (requireDispatcher) always
// can. With EGC_STAFF_ROLE_PERMISSIONS on, an account whose stored staff roles
// carry quotes.author (sales/walkthrough, manager) can too. With the flag off,
// or for an account without stored roles, this is exactly requireDispatcher, so
// today's access is unchanged. Being a quote author never grants dispatch:
// crew assignment and every /api/dispatch action still require requireDispatcher.
// dispatcher (the full rule rows, the roster and crew assignment in a signed
// handoff, and unmasked customers in customer-resolve) follows the same
// dispatch.write as /api/dispatch: with the flag on, an owner or manager whose
// stored roles lack it (a manager lowered to ['sales']) is a quote author who is
// not a dispatcher. Every caller passes the handler's env.
// With EGC_STAFF_ROLE_ACCESS on (AUTH-ROLES) both come from can() alone: dispatcher
// is dispatch.write (a stored manager is one) and author is walkthrough.perform,
// which the same roles hold as quotes.author (owner, manager, sales, and the
// configured business users without stored roles); a refusal names the role.
export const WALKTHROUGH_DENIAL = 'Walkthroughs need the Sales role. Ask the owner.';
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const signed = session => Boolean(session) && typeof session === 'object' && typeof session.user === 'string' && Boolean(session.user.trim());

export const isDispatcher = session => signed(session) && hasBusinessAccess(session) && ['owner', 'manager'].includes(session.role);

// OFFICE (owner request 2026-10-30): an office-role session (quotes.removal, and not already a quote author) authors
// removal-only photo quotes through /api/quote-draft and nowhere else. That handler hands the quote-draft library the
// session officeQuoteSession returns, marked with a Symbol a browser cannot send, and checks that every quote the
// session prices, saves, revises, reads or sends is removal-only and has no walkthrough (office-quotes.js). The marked
// session is a quote author that is never a dispatcher (removalOnly:true); the role itself is not a quote author, so the
// walkthrough, its signed handoff, the gameplan and every other quote-author check refuse it as before.
const OFFICE_QUOTE = Symbol('egc.officeQuote');
export const officeQuoteActor = session => signed(session) && session[OFFICE_QUOTE] === true;
export function officeQuoteSession(session, env = {}) {
  if (!signed(session) || officeQuoteActor(session) || quoteAuthorAccess(session, env).author || !can(session, 'quotes.removal', env)) return session;
  return { ...session, [OFFICE_QUOTE]: true };
}

// REP-WALKTHROUGH: a Knock rep's session for their own self-run walkthrough (knock-self-walkthrough.js, given only to a
// request naming that visit or the job saved from it) authors that one walkthrough and is never a dispatcher.
export function quoteAuthorAccess(session, env = {}) {
  if (officeQuoteActor(session)) return { dispatcher: false, author: true, removalOnly: true };
  if (signed(session) && selfWalkthroughVisitId(session)) return { dispatcher: false, author: true };
  if (staffRoleAccessEnabled(env)) {
    const dispatcher = signed(session) && can(session, 'dispatch.write', env);
    return { dispatcher, author: dispatcher || signed(session) && can(session, 'walkthrough.perform', env) };
  }
  const dispatcher = isDispatcher(session) && (capabilityMode(session, env) !== 'staff_roles' || can(session, 'dispatch.write', env));
  const author = dispatcher || signed(session) && capabilityMode(session, env) === 'staff_roles' && can(session, 'quotes.author', env);
  return { dispatcher, author };
}

export function requireQuoteAuthor(session, env = {}) {
  if (!signed(session)) throw fail('quote_sign_in_required', 'Sign in to the Employee Hub to prepare quotes.', 401);
  const access = quoteAuthorAccess(session, env);
  if (!access.author) throw fail('quote_forbidden', staffRoleAccessEnabled(env) ? WALKTHROUGH_DENIAL : 'Only an owner, manager or walkthrough/sales employee can prepare quotes.', 403);
  return access;
}

// /api/customer-resolve: a quote author, or a booker (schedule.book: with EGC_STAFF_ROLE_ACCESS the phone role, and
// OFFICE the office role in every mode) finding or adding the customer of a booking or a photo quote.
// Anyone but a dispatcher gets the masked customer (customer-resolution.js).
export function requireCustomerResolver(session, env = {}) {
  if (!signed(session) || quoteAuthorAccess(session, env).author) return requireQuoteAuthor(session, env);
  if (can(session, 'schedule.book', env)) return { dispatcher: false, author: false };
  if (!staffRoleAccessEnabled(env)) return requireQuoteAuthor(session, env);
  throw fail('quote_forbidden', 'Customer lookups need the Sales or Phone role. Ask the owner.', 403);
}
