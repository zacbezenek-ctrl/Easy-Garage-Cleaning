import { configuredBusinessAccess, getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { createFirebaseCustomToken, firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { assignmentKey, createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { staffCapabilities, staffRolePermissionsEnabled } from '../_lib/staff-roles.js';
import { admitStaffFirebaseSession, firebaseRevocations, firebaseStaffUid } from '../_lib/firebase-revocation.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const unavailable = () => json(503, { ok: false, code: 'FIREBASE_AUTH_UNAVAILABLE', error: 'Secure employee data access is unavailable. Ask the administrator to check the server credentials, then retry.' });

// revocations(env): the Firebase session revocation service (null without the server account).
export function firebaseSessionHandlers({ session: readSession = getHubSession, revocations = firebaseRevocations, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      const session = await readSession(request, env);
      if (!session) return json(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in required' });
      if (!firebaseServiceAccountConfigured(env)) return json(503, { ok: false, code: 'FIREBASE_NOT_CONFIGURED', error: 'Secure employee data access needs administrator setup. Your account has not been changed.' });
      const businessAccess = hasBusinessAccess(session);
      // Business access from stored roles (EGC_STAFF_ROLE_ACCESS: a stored manager) is recorded in the
      // Firebase staff roster before any session carries it, so turning the flag off or a demotion revokes
      // the session at the next production Hub load even when nobody loaded the Hub in between
      // (firebase-revocation.js admit). Not recorded: no session. Configured business users are unchanged.
      if (businessAccess && !configuredBusinessAccess(session) && !await admitStaffFirebaseSession(revocations(env), session, now().toISOString())) return unavailable();
      try {
        // Resolve legacy aliases on the server; display_name remains presentation.
        // Business users do not need an alias lookup to retain their existing access.
        const identities = businessAccess ? [String(session.user).trim()] : await createJobAssignmentAccess(env, session).identities();
        // The same uid staff session revocation targets (firebase-revocation.js).
        const token = await createFirebaseCustomToken(env, firebaseStaffUid(session.user), {
          role: session.role || 'crew',
          business_access: businessAccess,
          username: String(session.user || '').slice(0, 80),
          display_name: String(session.displayName || session.user || '').slice(0, 80),
          assignment_identities: identities,
          assignment_keys: identities.map(assignmentKey),
          assignment_version: 1,
          // Capability claims exist only when stored staff roles are authoritative.
          ...(staffRolePermissionsEnabled(env) ? { caps: staffCapabilities(session, env), caps_v: 1 } : {}),
        });
        return json(200, { ok: true, token });
      } catch {
        return unavailable();
      }
    },
  };
}

const handlers = firebaseSessionHandlers();
export const onRequestGet = handlers.get;
