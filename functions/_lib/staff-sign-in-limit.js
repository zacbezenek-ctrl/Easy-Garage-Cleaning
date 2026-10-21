/* SEC-2026-10 (S-01): staff sign-in attempt limits for POST /api/hub-auth.
   Without them an anonymous caller could guess a staff password without end.
   Each attempt is counted, before the password is checked, against a rolling
   15-minute limit for the client address (CF-Connecting-IP, IPv6 by /64) and
   a rolling hour for the typed username. A sign-in that succeeds gives both
   attempts back, so only failures use the limits. Counters live in
   rate_limits (server-only; the key is stored only as a purpose-keyed digest)
   and fail closed: contention, an unreadable counter or an outage refuses. */
import { clientAddressKey, consumeRollingLimit, releaseRollingLimit } from './rate-limit.js';
import { dispatchStorage } from './dispatch-storage.js';

export const STAFF_SIGN_IN_LIMITS = Object.freeze({
  ip: Object.freeze({ bucket: 'staff_sign_in_ip', limit: 10, windowMs: 15 * 60 * 1000 }),
  // High enough that someone else's failed guesses rarely lock a staff member out; low enough to stop a distributed guess.
  username: Object.freeze({ bucket: 'staff_sign_in_user', limit: 50, windowMs: 60 * 60 * 1000 }),
});

const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const usernameKey = username => `user:${String(username || '').trim().toLowerCase()}`;

// Production always has the service account (employee accounts need it). An env without one (local preview, unit
// tests on the firebase-test key) has no counter store, and sign-in there behaves as before.
export const staffSignInLimitStore = env => (String(env?.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim() ? dispatchStorage(env) : null);

/** Counts one sign-in attempt. Returns { allowed, retryAfter, release() }: call release() after a successful sign-in. */
export async function consumeStaffSignIn(store, env, { ip, username }, now = new Date().toISOString(), limits = STAFF_SIGN_IN_LIMITS) {
  const counted = [];
  for (const [rule, key] of [[limits.ip, clientAddressKey(ip)], [limits.username, usernameKey(username)]]) {
    const options = { bucket: rule.bucket, key, limit: rule.limit, windowMs: rule.windowMs };
    let hit;
    try { hit = await consumeRollingLimit(store, env, options, now); }
    catch { throw fail('HUB_AUTH_LIMIT_UNAVAILABLE', 'Sign-in is temporarily unavailable. Try again later.'); }
    if (!hit.allowed) {
      // A refused username attempt hands back the address attempt it already counted.
      for (const done of counted) await releaseRollingLimit(store, env, done, now);
      const retryAfter = Math.max(1, Math.ceil((Date.parse(hit.resetAt) - Date.parse(now)) / 1000) || 60);
      return { allowed: false, bucket: rule.bucket, retryAfter, release: async () => {} };
    }
    counted.push(options);
  }
  return { allowed: true, release: async () => { for (const done of counted) await releaseRollingLimit(store, env, done, now); } };
}
