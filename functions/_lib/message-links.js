/* Link providers for automatic customer messages. The project portal is where
   a customer reviews an estimate and pays, so portalLink and payLink both open
   a signed owner access link minted, exactly as the accepted-quote portal
   invitation does, under the verified account root's current link version: a
   staff revocation ends it. A payLink also names where the exchanged session
   lands (next=pay, the portal payment card; portal-landing.js). Links are never
   stored; the ledger and the job only ever hold the placeholder display copy. */
import { createCustomerPortalAccessToken, customerPortalConfigured } from './customer-portal.js';
import { customerPortalLinkAccount } from './customer-portal-revocation.js';
import { businessAccountJob } from './portal-invitation.js';

export const PORTAL_SESSION_URL = 'https://easygaragecleaning.com/api/customer-portal-session';

export function portalLinkProviders({ env = {}, read, now = () => Date.now() } = {}) {
  if (!customerPortalConfigured(env) || typeof read !== 'function') return {};
  const link = next => async ({ audience, job }) => {
    if (audience !== 'customer' || !job?.id) return undefined;
    // A company project is shared through its business hub's roles; an owner
    // link would bypass them (B2B-SAFE), so none is ever minted for one.
    if (businessAccountJob(job)) throw Object.assign(new Error('This job belongs to a business account. Share it through that company\'s business hub instead.'), { code: 'messaging_not_eligible', status: 409, details: { reason: 'business_account_job' } });
    const { account, linkVersion } = await customerPortalLinkAccount(read, job);
    const token = await createCustomerPortalAccessToken(env, job.id, now(), linkVersion, account.id);
    return `${PORTAL_SESSION_URL}?access=${encodeURIComponent(token)}${next ? `&next=${next}` : ''}`;
  };
  return { portalLink: link(''), payLink: link('pay') };
}
