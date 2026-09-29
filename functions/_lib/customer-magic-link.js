/* Client Login magic links (SEC-07 / P4-03). A request names a phone or
   email; the customer must be the single exact normalized match, the typed
   value must equal the saved one, and the link goes only to the saved contact
   through the approved-send service (portal_magic_link, customer_initiated:
   owner-approved wording, DND and notify respected). Requests are limited per
   address, per phone/email (15 minutes and a rolling day) and per customer
   (a rolling day of texts: counted before the send, and given back when the
   send turns out to text nothing). Every outcome looks the same to the
   browser. Tokens are random, single-use and expire after 15
   minutes; only customer_login_links/{purpose-keyed digest} is stored. */
import { customerIdentityFields, findCustomerCandidates, normalizeEmail, normalizePhoneE164 } from './customer-identity.js';
import { PURPOSES, purposeSign } from './purpose-keys.js';
import { clientAddressKey, consumeRateLimit, consumeRollingLimit, releaseRollingLimit } from './rate-limit.js';
import { CUSTOMER_SESSIONS, customerAccountId, newCustomerSession, portalSessionVersion, randomToken } from './customer-account-session.js';

export const LOGIN_LINKS = 'customer_login_links';
export const LOGIN_LINK_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// The 15-minute windows stop bursts; the rolling 24-hour limits stop a slow
// drip (one request every ten minutes) from texting a customer all night.
// The customer cap is counted on the resolved account just before a send, so
// a phone and an email for the same customer share it, and it counts texts,
// not taps (see UNSENT).
export const LOGIN_LIMITS = Object.freeze({
  ip: Object.freeze({ bucket: 'customer_login_ip', limit: 10, windowMs: 15 * 60 * 1000 }),
  identifier: Object.freeze({ bucket: 'customer_login_identifier', limit: 3, windowMs: 15 * 60 * 1000 }),
  identifierDay: Object.freeze({ bucket: 'customer_login_identifier_day', limit: 5, windowMs: DAY_MS, rolling: true }),
  customerDay: Object.freeze({ bucket: 'customer_login_customer_day', limit: 3, windowMs: DAY_MS, rolling: true }),
});
const consumeLoginLimit = (store, env, rule, key, at) => (rule.rolling ? consumeRollingLimit : consumeRateLimit)(store, env, { bucket: rule.bucket, key, limit: rule.limit, windowMs: rule.windowMs }, at);
// Approved-send answers that mean this request texted nothing: a repeat inside
// the ten-minute send key, or a send already in flight or held there
// (alreadyRecorded), and the refusals it returns before claiming its ledger
// (DND, notify off or no SMS consent, no usable contact, provider lookup
// down). Such a request gives its customer-day slot back, so three quick taps
// cost one slot. Any other answer, or an error, keeps it (fail closed): the
// cap stays at three texts per customer in any 24 hours.
const UNSENT = new Set(['suppressed', 'needs_contact', 'contact_mismatch', 'not_configured', 'unavailable']);
const textedNothing = sent => sent?.alreadyRecorded === true || UNSENT.has(sent?.status);
export const LOGIN_VERIFY_PATH = '/api/customer-login-verify';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Only these hosts may appear in a sign-in link; anything else falls back to production.
const LINK_HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|(?:[a-z0-9-]+\.)?easy-garage-cleaning\.pages\.dev)$/;
const PRODUCTION = 'https://easygaragecleaning.com';
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const uuid = random => { const b = random(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const hex = [...b].map(byte => byte.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };

// Client Login stays off (the API answers 404) unless this is exactly "true".
export const customerLoginEnabled = env => env?.CUSTOMER_LOGIN_ENABLED === 'true';
export const loginTokenValid = token => typeof token === 'string' && TOKEN.test(token);

/** A typed phone or email in its lookup form, or null. */
export function loginIdentifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 254) return null;
  const text = value.trim();
  if (text.includes('@')) { const email = normalizeEmail(text); return email ? { kind: 'email', field: 'emailLower', value: email } : null; }
  const phone = normalizePhoneE164(text);
  return phone ? { kind: 'phone', field: 'phoneE164', value: phone } : null;
}

export function loginLinkOrigin(requestUrl) {
  try { const url = new URL(requestUrl); return url.protocol === 'https:' && LINK_HOST.test(url.host) ? url.origin : PRODUCTION; } catch { return PRODUCTION; }
}

export const loginLinkId = async (env, token) => `ml_${await purposeSign(env, PURPOSES.magicLink, token)}`;

/** Creates a single-use link for a customer and returns its URL; the raw
 * token exists only in the returned URL. */
export async function createLoginLink(store, env, { customerId, sessionVersion, ledgerId = '' }, now, { random, origin = PRODUCTION } = {}) {
  if (!customerAccountId(customerId) || !Number.isSafeInteger(sessionVersion) || sessionVersion < 0) throw fail('CUSTOMER_LOGIN_LINK_INVALID', 'A sign-in link needs a verified customer.', 500);
  const createdMs = Date.parse(now);
  if (!Number.isFinite(createdMs)) throw fail('CUSTOMER_LOGIN_LINK_INVALID', 'A sign-in link needs a valid clock.', 500);
  const token = randomToken(random), id = await loginLinkId(env, token), expiresAt = new Date(createdMs + LOGIN_LINK_TTL_MS).toISOString();
  await store.commit([{ collection: LOGIN_LINKS, id, patch: { customerId, sessionVersion, ledgerId: /^[a-f0-9]{64}$/.test(ledgerId) ? ledgerId : '', via: 'magic_link', createdAt: new Date(createdMs).toISOString(), expiresAt, usedAt: null, sessionId: '' } }]);
  return { id, expiresAt, url: `${origin}${LOGIN_VERIFY_PATH}?token=${token}` };
}

/** Approved-send link provider: a real link only for purpose 'send', only for
 * the account the service resolved, bound to its current session version. */
export function loginLinkProvider(store, env, { now = () => new Date().toISOString(), random, origin = PRODUCTION } = {}) {
  return async ({ kind, account, purpose, ledgerId }) => {
    if (kind !== 'portal_magic_link' || purpose !== 'send' || !customerAccountId(account?.id)) return undefined;
    const sessionVersion = portalSessionVersion(account);
    if (sessionVersion === null) return undefined;
    return (await createLoginLink(store, env, { customerId: account.id, sessionVersion, ledgerId }, now(), { random, origin })).url;
  };
}

/** The whole request path. Returns an internal outcome for tests and logs;
 * the HTTP layer answers every outcome with the same 202. */
export async function requestCustomerLoginLink({ store, identity, env, service, now = () => new Date().toISOString(), random = bytes => crypto.getRandomValues(bytes), limits = LOGIN_LIMITS }, { identifier, ip }) {
  const id = loginIdentifier(identifier);
  if (!id) return { outcome: 'invalid' };
  const at = now();
  // In order, stopping at the first refusal, so a refused attempt is not counted by the later limits.
  for (const [rule, key] of [[limits.ip, clientAddressKey(ip)], [limits.identifier, `${id.kind}:${id.value}`], [limits.identifierDay, `${id.kind}:${id.value}`]]) {
    const hit = await consumeLoginLimit(store, env, rule, key, at);
    if (!hit.allowed) return { outcome: 'rate_limited', bucket: rule.bucket };
  }
  const found = await findCustomerCandidates(identity, { [id.kind]: id.value });
  if (found.ambiguous) return { outcome: 'ambiguous' };
  if (!found.customerId) return { outcome: found.customers.length ? 'unverified' : 'unknown' };
  const customer = await store.read('customers', found.customerId);
  if (!customer || customer.recordType || customer.id !== found.customerId) return { outcome: 'unknown' };
  // The saved record must still carry exactly what was typed; a stale lookup key is not evidence.
  if (customerIdentityFields(customer)[id.field] !== id.value) return { outcome: 'contact_mismatch' };
  if (portalSessionVersion(customer) === null) return { outcome: 'account_review' };
  const capped = await consumeLoginLimit(store, env, limits.customerDay, `customer:${customer.id}`, at);
  if (!capped.allowed) return { outcome: 'rate_limited', bucket: limits.customerDay.bucket };
  const actor = { user: `customer:${customer.id}`, kind: 'customer', source: 'portal', customerAccountId: customer.id };
  const sent = await service.send(actor, { kind: 'portal_magic_link', accountId: customer.id, requestId: uuid(random) });
  const { customerDay } = limits;
  if (customerDay.rolling && textedNothing(sent)) await releaseRollingLimit(store, env, { bucket: customerDay.bucket, key: `customer:${customer.id}`, limit: customerDay.limit, windowMs: customerDay.windowMs }, at, now());
  return { outcome: 'send', status: sent.status, reason: sent.reason || '' };
}

/** Consumes a link and opens an account session in ONE commit: the link's
 * usedAt compare-and-set, the create-only session and a fence on the
 * customer's revision (a version bump after the read voids the sign-in).
 * `prepare(customer)` runs after the link checks and before that commit, so
 * work the sign-in depends on (the landing project) can fail without
 * spending the link; its result is returned as `prepared`. */
export async function redeemLoginLink(store, env, token, now = new Date().toISOString(), { random, prepare } = {}) {
  const invalid = () => fail('CUSTOMER_LOGIN_LINK_INVALID', 'This sign-in link is not valid. Request a new one.', 400);
  const spent = () => fail('CUSTOMER_LOGIN_LINK_USED', 'This sign-in link was already used. Request a new one.', 410);
  if (!loginTokenValid(token)) throw invalid();
  const id = await loginLinkId(env, token), nowMs = Date.parse(now);
  const link = await store.read(LOGIN_LINKS, id);
  if (!link || link.id !== id || !customerAccountId(link.customerId) || !Number.isSafeInteger(link.sessionVersion)) throw invalid();
  if (link.usedAt) throw spent();
  if (!(Date.parse(link.expiresAt) > nowMs)) throw fail('CUSTOMER_LOGIN_LINK_EXPIRED', 'This sign-in link expired. Request a new one.', 410);
  const customer = await store.read('customers', link.customerId);
  if (!customer || customer.recordType || customer.id !== link.customerId || portalSessionVersion(customer) !== link.sessionVersion) throw fail('CUSTOMER_LOGIN_LINK_REVOKED', 'This sign-in link is no longer valid. Request a new one.', 410);
  let prepared;
  if (prepare) {
    try { prepared = await prepare(customer); }
    catch { throw fail('CUSTOMER_LOGIN_LANDING_UNAVAILABLE', 'Sign-in could not be completed. Your link still works; try it again shortly.', 503); }
  }
  const session = await newCustomerSession(env, { customerId: customer.id, sessionVersion: link.sessionVersion, via: 'magic_link' }, now, random);
  try {
    await store.commit([
      { collection: LOGIN_LINKS, id, revision: link.revision, patch: { usedAt: now, sessionId: session.id } },
      session.write,
      { collection: 'customers', id: customer.id, revision: customer.revision, verify: true },
    ]);
  } catch (error) {
    // A lost response may still have committed this exact sign-in.
    const latest = await store.read(LOGIN_LINKS, id).catch(() => null);
    if (latest?.sessionId === session.id && await store.read(CUSTOMER_SESSIONS, session.id).catch(() => null)) return { customer, session, prepared };
    if (latest?.usedAt) throw spent();
    // The link is still unused (the customer record changed underneath, or the
    // commit did not apply), so the same link may be tried again.
    if (['dispatch_revision_conflict', 'dispatch_outcome_unknown'].includes(error?.code)) throw fail('CUSTOMER_LOGIN_LINK_CHANGED', 'Sign-in did not finish. Open the link again.', 409);
    throw fail('CUSTOMER_LOGIN_STORAGE_UNAVAILABLE', 'Sign-in could not be completed. Please try the link again shortly.', 503);
  }
  return { customer, session, prepared };
}
