import { createCustomerPortalSessionCookie, verifyCustomerPortalAccessToken } from '../_lib/customer-portal.js';
import { readJob } from '../_lib/firestore-job.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const access = await verifyCustomerPortalAccessToken(env, url.searchParams.get('access'));
  if (!access || !await readJob(env, access.jobId).catch(() => null)) {
    return new Response(null, { status: 303, headers: { Location: '/customer-portal?error=invalid', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  return new Response(null, { status: 303, headers: {
    Location: '/customer-portal',
    'Set-Cookie': await createCustomerPortalSessionCookie(env, access.jobId, { actorId: access.actorId, permissions: access.permissions }),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  } });
}
