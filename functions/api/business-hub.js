import { createBusinessHandler } from '../_lib/business-hub-service.js';
import { createBusinessStore } from '../_lib/business-hub-store.js';
import { getHubSession } from '../_lib/hub-session.js';
import { customerMoneyState, customerPaymentNeedsReview } from '../_lib/customer-payments.js';
import { createCustomerPortalSessionCookie, clearCustomerPortalSessionCookie } from '../_lib/customer-portal.js';
export async function onRequest({ request, env }) {
  return createBusinessHandler({
    store: createBusinessStore(env), getStaff: req => getHubSession(req, env),
    finance: customerMoneyState, needsReview: customerPaymentNeedsReview,
    projectCookie: (jobId, claims) => createCustomerPortalSessionCookie(env, jobId, claims),
    clearProjectCookie: clearCustomerPortalSessionCookie,
  })(request);
}
