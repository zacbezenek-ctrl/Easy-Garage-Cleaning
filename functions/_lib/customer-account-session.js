/* Account-level customer sessions (SEC-06). The browser holds a random
   256-bit token in the __Host-egc_customer cookie; the server keeps only
   customer_sessions/{purpose-keyed digest}. A session is valid while it is
   unexpired, not revoked and its sessionVersion equals the customer's
   portalSessionVersion, so staff end every session at once by bumping that
   counter (revokeCustomerAccountSessions in customer-account-access.js, which
   also ends the per-job portal sessions handed out at sign-in). The legacy
   per-job egc_customer_portal cookie format is unchanged. */
import { PURPOSES, purposeBase64Url, purposeSign } from './purpose-keys.js';
import { readCookie } from './customer-portal.js';

export const CUSTOMER_SESSIONS = 'customer_sessions';
export const CUSTOMER_SESSION_COOKIE = '__Host-egc_customer';
export const CUSTOMER_SESSION_TTL_MS = 30 * 86400000;
export const CUSTOMER_SESSION_VIAS = Object.freeze(['magic_link', 'job_link']);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const customerAccountId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(_egc_|secure_)/.test(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const signInAgain = code => fail(code, 'Your sign-in has ended. Request a new sign-in link.', 401);
const unavailable = () => fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your account could not be loaded. Please try again shortly.', 503);

/** Absent means no revocation yet (0). A malformed value is null and fails closed. */
export function portalSessionVersion(customer) {
  const value = customer?.portalSessionVersion;
  if (value === undefined || value === null) return 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function randomToken(random = bytes => crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(32));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw fail('CUSTOMER_ACCOUNT_RANDOM_UNAVAILABLE', 'A secure sign-in could not be created. Please try again.', 503);
  return purposeBase64Url(bytes);
}

export const customerSessionId = async (env, token) => `cs_${await purposeSign(env, PURPOSES.customerAccountSession, token)}`;
export const customerSessionCookie = (token, maxAge = CUSTOMER_SESSION_TTL_MS / 1000) => `${CUSTOMER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const clearCustomerSessionCookie = () => customerSessionCookie('', 0);

/** Builds a session and the create-only write for it; the caller commits the
 * write, usually together with consuming the credential that authorized it. */
export async function newCustomerSession(env, { customerId, sessionVersion, via }, now, random) {
  if (!customerAccountId(customerId) || !Number.isSafeInteger(sessionVersion) || sessionVersion < 0 || !CUSTOMER_SESSION_VIAS.includes(via)) throw fail('CUSTOMER_ACCOUNT_SESSION_INVALID', 'A customer session needs a customer, a session version and a sign-in method.', 500);
  const createdMs = Date.parse(now);
  if (!Number.isFinite(createdMs)) throw fail('CUSTOMER_ACCOUNT_SESSION_INVALID', 'A customer session needs a valid clock.', 500);
  const token = randomToken(random), id = await customerSessionId(env, token), expiresAt = new Date(createdMs + CUSTOMER_SESSION_TTL_MS).toISOString();
  const record = { customerId, sessionVersion, via, createdAt: new Date(createdMs).toISOString(), expiresAt, revokedAt: null };
  return { token, id, expiresAt, record, write: { collection: CUSTOMER_SESSIONS, id, patch: record }, cookie: customerSessionCookie(token) };
}

export async function createCustomerAccountSession(store, env, input, now = new Date().toISOString(), { random } = {}) {
  const session = await newCustomerSession(env, input, now, random);
  await store.commit([session.write]);
  return session;
}

/** Resolves the cookie to a live session and its customer, or throws a 401
 * CUSTOMER_ACCOUNT_* error. Storage failures are 503, never a sign-out. */
export async function readCustomerAccountSession(store, env, request, now = new Date().toISOString()) {
  const token = readCookie(request, CUSTOMER_SESSION_COOKIE);
  if (!TOKEN.test(token)) throw fail('CUSTOMER_ACCOUNT_AUTH_REQUIRED', 'Sign in with the link we send to your phone or email.', 401);
  const id = await customerSessionId(env, token), nowMs = Date.parse(now);
  let row, customer;
  try { row = await store.read(CUSTOMER_SESSIONS, id); } catch { throw unavailable(); }
  if (!row || row.id !== id || !customerAccountId(row.customerId)) throw fail('CUSTOMER_ACCOUNT_AUTH_REQUIRED', 'Sign in with the link we send to your phone or email.', 401);
  if (row.revokedAt) throw signInAgain('CUSTOMER_ACCOUNT_SESSION_REVOKED');
  if (!(Date.parse(row.expiresAt) > nowMs)) throw signInAgain('CUSTOMER_ACCOUNT_SESSION_EXPIRED');
  try { customer = await store.read('customers', row.customerId); } catch { throw unavailable(); }
  if (!customer || customer.recordType || customer.id !== row.customerId) throw signInAgain('CUSTOMER_ACCOUNT_SESSION_REVOKED');
  const version = portalSessionVersion(customer);
  if (version === null || version !== row.sessionVersion) throw signInAgain('CUSTOMER_ACCOUNT_SESSION_REVOKED');
  return { id, revision: row.revision, customerId: row.customerId, sessionVersion: version, via: row.via, createdAt: row.createdAt, expiresAt: row.expiresAt, customer };
}

/** Ends this browser's session. Always returns the clearing cookie; a
 * session that cannot be marked is still unusable once the cookie is gone. */
export async function signOutCustomerAccountSession(store, env, request, now = new Date().toISOString()) {
  const token = readCookie(request, CUSTOMER_SESSION_COOKIE);
  let revoked = false;
  if (TOKEN.test(token)) {
    try {
      const id = await customerSessionId(env, token), row = await store.read(CUSTOMER_SESSIONS, id);
      if (row && !row.revokedAt) { await store.commit([{ collection: CUSTOMER_SESSIONS, id, revision: row.revision, patch: { revokedAt: now, revokedReason: 'signed_out' } }]); revoked = true; }
    } catch { /* The cookie is cleared regardless. */ }
  }
  return { revoked, cookie: clearCustomerSessionCookie() };
}
