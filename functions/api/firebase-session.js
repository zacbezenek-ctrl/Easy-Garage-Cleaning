import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { createFirebaseCustomToken, firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function onRequestGet({ request, env }) {
  const session = await getHubSession(request, env);
  if (!session) return json(401, { ok: false, error: 'Sign in required' });
  if (!firebaseServiceAccountConfigured(env)) return json(503, { ok: false, error: 'Secure data access is not configured' });
  const businessAccess = hasBusinessAccess(session);
  const token = await createFirebaseCustomToken(env, `hub:${String(session.user).toLowerCase()}`, {
    role: session.role || 'crew',
    business_access: businessAccess,
    username: String(session.user || '').slice(0, 80),
    display_name: String(session.displayName || session.user || '').slice(0, 80),
  });
  return json(200, { ok: true, token });
}
