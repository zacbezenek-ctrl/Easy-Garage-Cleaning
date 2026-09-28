const ACCESS_SECONDS = 30 * 24 * 60 * 60;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = 'egc_customer_portal';
const encoder = new TextEncoder();

function secret(env = {}) {
  return String(env.CUSTOMER_PORTAL_SECRET || env.HUB_SESSION_SECRET || '');
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function sign(env, payload, purpose) {
  const value = secret(env);
  if (!value) throw new Error('Customer Portal secret is not configured');
  const key = await crypto.subtle.importKey('raw', encoder.encode(`${value}:customer-portal:${purpose}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

const linkVersionValid = value => Number.isSafeInteger(value) && value >= 0;
// Same id rules readCustomerPortalContext applies to every job it loads.
const linkRootValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);

// Staff revocation bumps this account-level counter. Absent means no link has
// ever been revoked; a malformed value is never read as 0 (null fails closed).
export function customerPortalLinkVersion(job) {
  const value = job?.customerPortalLinkVersion;
  if (value === undefined || value === null) return 0;
  return linkVersionValid(value) ? value : null;
}

// Claims: `lv` is the account link version and `lr` the verified account root
// job id the token was minted under. Owner tokens (no actor) MUST name their
// version: one minted without it would count as 0 and lock the owner out after
// the account's first revocation, so omitting it is a programmer error rather
// than a silent default. Every production caller also passes the root.
// Collaborator and business tokens embed lv/lr whenever the caller passes them.
async function createToken(env, purpose, jobId, seconds, now = Date.now(), claims = {}) {
  const id = String(jobId || '').trim();
  if (!id || id.length > 120) throw new Error('A valid job is required');
  const actorId = String(claims.actorId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  if (!actorId && claims.linkVersion === undefined) throw new TypeError('Owner portal tokens need an explicit linkVersion (customerPortalLinkVersion of the verified account root)');
  if (claims.linkVersion !== undefined && !linkVersionValid(claims.linkVersion)) throw new Error('A valid portal link version is required');
  if (claims.linkRoot !== undefined && !linkRootValid(claims.linkRoot)) throw new Error('A valid portal link account root is required');
  const permissions = ['view', 'decide', 'pay', 'rebook'].filter(key => claims.permissions?.[key]);
  const payload = base64Url(encoder.encode(JSON.stringify({
    v: 1, j: id, exp: now + seconds * 1000,
    ...(actorId ? { a: actorId, p: permissions } : {}),
    ...(claims.linkVersion !== undefined ? { lv: claims.linkVersion } : {}),
    ...(claims.linkRoot !== undefined ? { lr: claims.linkRoot } : {}),
  })));
  return `${payload}.${await sign(env, payload, purpose)}`;
}

async function verifyToken(env, purpose, token, now = Date.now()) {
  const [payload, suppliedSignature, extra] = String(token || '').split('.');
  if (!payload || !suppliedSignature || extra) return null;
  let expected;
  try { expected = await sign(env, payload, purpose); } catch { return null; }
  if (!safeEqual(expected, suppliedSignature)) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (value.v !== 1 || !value.j || String(value.j).length > 120 || !Number.isFinite(value.exp) || value.exp <= now) return null;
    // A signature cannot launder a malformed claim into "no claim".
    if (value.lv !== undefined && !linkVersionValid(value.lv)) return null;
    if (value.lr !== undefined && !linkRootValid(value.lr)) return null;
    return {
      jobId: String(value.j), expiresAt: value.exp, actorId: String(value.a || ''),
      permissions: Object.fromEntries(['view', 'decide', 'pay', 'rebook'].map(key => [key, !value.a || (Array.isArray(value.p) && value.p.includes(key))])),
      ...(value.lv !== undefined ? { linkVersion: value.lv } : {}),
      ...(value.lr !== undefined ? { linkRoot: value.lr } : {}),
    };
  } catch { return null; }
}

// Tokens verified without lv/lr (minted before revocation existed) keep
// working until staff first revoke that account; readCustomerPortalContext
// enforces both claims. New owner links must pass the verified account's
// current version (required) and its root job id.
export const createCustomerPortalAccessToken = (env, jobId, now, linkVersion, linkRoot) => createToken(env, 'access', jobId, ACCESS_SECONDS, now, { linkVersion, linkRoot });
// Collaborator invitations: callers should pass readCustomerPortalContext's
// result.linkVersion and result.accountJobId so a revocation also ends the
// invitation (see docs/portal-invitations.md, "Revoking portal links").
export const createCustomerPortalCollaboratorAccessToken = (env, jobId, actorId, permissions, now, linkVersion, linkRoot) => createToken(env, 'access', jobId, ACCESS_SECONDS, now, { actorId, permissions, linkVersion, linkRoot });
export const verifyCustomerPortalAccessToken = (env, token, now) => verifyToken(env, 'access', token, now);
export const createCustomerPortalSessionToken = (env, jobId, now, claims = {}) => createToken(env, 'session', jobId, SESSION_SECONDS, now, claims);
export const verifyCustomerPortalSessionToken = (env, token, now) => verifyToken(env, 'session', token, now);

export function readCookie(request, name = COOKIE_NAME) {
  for (const item of String(request.headers.get('Cookie') || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator >= 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return '';
}

export async function getCustomerPortalSession(request, env, now) {
  return verifyCustomerPortalSessionToken(env, readCookie(request), now);
}

export async function createCustomerPortalSessionCookie(env, jobId, claims = {}, now = Date.now()) {
  const token = await createCustomerPortalSessionToken(env, jobId, now, claims);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearCustomerPortalSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function customerPortalConfigured(env = {}) {
  return Boolean(secret(env));
}
