import { createCustomerPortalSessionCookie, verifyCustomerPortalAccessToken } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  let access;
  try {
    const verified = await verifyCustomerPortalAccessToken(env, url.searchParams.get('access'));
    access = (await readCustomerPortalContext(env, verified)).session;
  } catch (error) {
    const reason = error.status >= 500 ? 'unavailable' : 'invalid';
    return new Response(null, { status: 303, headers: { Location: `/customer-portal?error=${reason}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  return new Response(null, { status: 303, headers: {
    Location: '/customer-portal',
    'Set-Cookie': await createCustomerPortalSessionCookie(env, access.jobId, { actorId: access.actorId, permissions: access.permissions }),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  } });
}
