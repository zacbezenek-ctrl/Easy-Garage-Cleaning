import { createCustomerPortalSessionCookie, verifyCustomerPortalAccessToken } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';

export function customerPortalSessionHandler({ now = () => new Date() } = {}) {
  return async ({ request, env }) => {
    const url = new URL(request.url), time = now().getTime();
    let access, linkRoot;
    try {
      const verified = await verifyCustomerPortalAccessToken(env, url.searchParams.get('access'), time);
      ({ session: access, linkRoot } = await readCustomerPortalContext(env, verified));
    } catch (error) {
      const reason = error.status >= 500 ? 'unavailable' : 'invalid';
      return new Response(null, { status: 303, headers: { Location: `/customer-portal?error=${reason}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    // The session keeps the verified link version and account root, so a later
    // revocation or re-parenting also ends portal sessions opened from earlier
    // links. Owner sessions always carry the version current at exchange.
    return new Response(null, { status: 303, headers: {
      Location: '/customer-portal',
      'Set-Cookie': await createCustomerPortalSessionCookie(env, access.jobId, { actorId: access.actorId, permissions: access.permissions, linkVersion: access.linkVersion, linkRoot }, time),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    } });
  };
}

export const onRequestGet = customerPortalSessionHandler();
