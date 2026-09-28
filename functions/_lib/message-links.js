/* Link providers for automatic customer messages. The project portal is where
   a customer reviews an estimate and pays, so portalLink and payLink both open
   a signed owner access link minted, exactly as the accepted-quote portal
   invitation does, under the verified account root's current link version: a
   staff revocation ends it. Links are never stored; the ledger and the job
   only ever hold the placeholder display copy. */
import { createCustomerPortalAccessToken, customerPortalConfigured } from './customer-portal.js';
import { customerPortalLinkAccount } from './customer-portal-revocation.js';

export const PORTAL_SESSION_URL = 'https://easygaragecleaning.com/api/customer-portal-session';

export function portalLinkProviders({ env = {}, read, now = () => Date.now() } = {}) {
  if (!customerPortalConfigured(env) || typeof read !== 'function') return {};
  const link = async ({ audience, job }) => {
    if (audience !== 'customer' || !job?.id) return undefined;
    const { account, linkVersion } = await customerPortalLinkAccount(read, job);
    const token = await createCustomerPortalAccessToken(env, job.id, now(), linkVersion, account.id);
    return `${PORTAL_SESSION_URL}?access=${encodeURIComponent(token)}`;
  };
  return { portalLink: link, payLink: link };
}
