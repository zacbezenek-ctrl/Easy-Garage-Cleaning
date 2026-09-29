/* Link providers for automatic customer messages. The project portal is where
   a customer reviews an estimate and pays, so portalLink and payLink both open
   a signed owner access link minted, exactly as the accepted-quote portal
   invitation does, under the verified account root's current link version: a
   staff revocation ends it. A payLink also names where the exchanged session
   lands (next=pay, the portal payment card; portal-landing.js). Links are never
   stored; the ledger and the job only ever hold the placeholder display copy.
   A company project (businessAccountId on the job or its account root) is
   shared through its business hub's roles, so no link is ever minted for one:
   the message policies refuse those jobs first, and this refusal
   (link_not_allowed_business_account) is the backstop. */
import { createCustomerPortalAccessToken, customerPortalConfigured } from './customer-portal.js';
import { customerPortalLinkAccount } from './customer-portal-revocation.js';
import { businessAccountJob } from './portal-invitation.js';

export const PORTAL_SESSION_URL = 'https://easygaragecleaning.com/api/customer-portal-session';

// messaging_not_eligible keeps the refusal a 409 for /api/messages and a
// not_eligible outcome for the scheduler; the reason names this layer.
const businessLink = () => Object.assign(new Error('This job belongs to a business account. Share it through that company\'s business hub instead.'), { code: 'messaging_not_eligible', status: 409, details: { reason: 'link_not_allowed_business_account' } });

export function portalLinkProviders({ env = {}, read, now = () => Date.now() } = {}) {
  if (!customerPortalConfigured(env) || typeof read !== 'function') return {};
  const link = next => async ({ audience, job }) => {
    if (audience !== 'customer' || !job?.id) return undefined;
    // An owner link would bypass the company's hub roles (B2B-SAFE).
    if (businessAccountJob(job)) throw businessLink();
    const { account, linkVersion } = await customerPortalLinkAccount(read, job);
    if (businessAccountJob(account)) throw businessLink();
    const token = await createCustomerPortalAccessToken(env, job.id, now(), linkVersion, account.id);
    return `${PORTAL_SESSION_URL}?access=${encodeURIComponent(token)}${next ? `&next=${next}` : ''}`;
  };
  return { portalLink: link(''), payLink: link('pay') };
}
