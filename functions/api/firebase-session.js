import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { createFirebaseCustomToken, firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function onRequestGet({ request, env }) {
  const session = await getHubSession(request, env);
  if (!session) return json(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in required' });
  if (!firebaseServiceAccountConfigured(env)) return json(503, { ok: false, code: 'FIREBASE_NOT_CONFIGURED', error: 'Secure employee data access needs administrator setup. Your account has not been changed.' });
  const businessAccess = hasBusinessAccess(session);
  try {
    const token = await createFirebaseCustomToken(env, `hub:${String(session.user).toLowerCase()}`, {
      role: session.role || 'crew',
      business_access: businessAccess,
      username: String(session.user || '').slice(0, 80),
      display_name: String(session.displayName || session.user || '').slice(0, 80),
    });
    return json(200, { ok: true, token });
  } catch {
    return json(503, { ok: false, code: 'FIREBASE_AUTH_UNAVAILABLE', error: 'Secure employee data access is unavailable. Ask the administrator to check the server credentials, then retry.' });
  }
}
