import { authenticateEmployeeAccount, getEmployeeSessionProfile } from './employee-accounts.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const COOKIE_NAME = 'egc_hub_session';
const SESSION_SECONDS = 12 * 60 * 60;
const ACTION_STATE_SECONDS = 10 * 60;
const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256';
const PASSWORD_HASH_ITERATIONS = 210000;
const PASSWORD_HASH_BYTES = 32;

const BUSINESS_USERS = new Set(['zacb', 'tylerg', 'alexk']);

export function hasBusinessAccess(profileOrUsername) {
  if (profileOrUsername && typeof profileOrUsername === 'object') {
    const username = String(profileOrUsername.user || '').trim().toLowerCase();
    return profileOrUsername.businessAccess === true && BUSINESS_USERS.has(username);
  }
  return BUSINESS_USERS.has(String(profileOrUsername || '').trim().toLowerCase());
}

const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function users(env = {}) {
  if (!env.HUB_AUTH_USERS_JSON) return {};
  try {
    const configured = JSON.parse(env.HUB_AUTH_USERS_JSON);
    if (configured && typeof configured === 'object' && !Array.isArray(configured)) return configured;
  } catch {
    // A broken staff configuration must not fall through to another account.
  }
  const error = new Error('Staff sign-in configuration needs administrator attention');
  error.code = 'HUB_AUTH_CONFIGURATION';
  throw error;
}

function configuredUsername(env, username) {
  const requested = String(username || '').trim().toLowerCase();
  const matches = Object.keys(users(env)).filter(key => key.trim().toLowerCase() === requested);
  if (matches.length > 1) {
    const error = new Error('Staff sign-in configuration needs administrator attention');
    error.code = 'HUB_AUTH_CONFIGURATION';
    throw error;
  }
  return matches[0] || '';
}

function userRecord(env, username) {
  const canonical = configuredUsername(env, username);
  if (!canonical) return null;
  const configured = users(env)[canonical];
  const record = typeof configured === 'string' ? { passwordHash: configured } : configured;
  if (!record || typeof record !== 'object' || Array.isArray(record) || !String(record.passwordHash || record.hash || '').trim()) {
    const error = new Error('Staff sign-in configuration needs administrator attention');
    error.code = 'HUB_AUTH_CONFIGURATION';
    throw error;
  }
  const role = String(record.role || 'crew').toLowerCase();
  return {
    username: canonical,
    passwordHash: String(record.passwordHash || record.hash || ''),
    displayName: String(record.displayName || canonical),
    role: ['owner', 'manager', 'sales', 'crew_lead', 'crew'].includes(role) ? role : 'crew',
    payType: String(record.payType || 'hourly'),
    hourlyRate: Math.max(0, Number(record.hourlyRate || 0)),
  };
}

export function getHubUserProfile(env, username) {
  const record = userRecord(env, username);
  if (!record) return null;
  const { passwordHash, username: canonical, ...profile } = record;
  return { user: canonical, ...profile, businessAccess: hasBusinessAccess(canonical) };
}

export function listHubUserProfiles(env = {}) {
  return Object.keys(users(env)).map(username => getHubUserProfile(env, username)).filter(Boolean);
}

function sessionSecret(env = {}) {
  return env.HUB_SESSION_SECRET || '';
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function derivePasswordHash(password, salt, iterations, env = {}) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  try {
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      PASSWORD_HASH_BYTES * 8
    );
    return new Uint8Array(bits);
  } catch (error) {
    // Cloudflare's native PBKDF2 caps iterations at 100000, including on paid
    // plans. The exact same derivation can run in JS with a sufficient CPU
    // allowance; never lower the stored work factor or reset existing hashes.
    // Enable only after provisioning a hosting plan with adequate CPU time.
    if (env.HUB_PASSWORD_HASH_FALLBACK === 'enabled' && error?.name === 'NotSupportedError' && /iteration counts above \d+.*not supported/i.test(error?.message || '')) {
      const passwordBytes = encoder.encode(password);
      try { return pbkdf2(sha256, passwordBytes, salt, { c: iterations, dkLen: PASSWORD_HASH_BYTES }); }
      finally { passwordBytes.fill(0); }
    }
    throw error;
  }
}

async function signature(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function hashHubCredential(username, password) {
  return digestHex(`${username}:${password}:egc-salt-2026`);
}

export async function createHubCredentialHash(password, env = {}) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Hub passwords must be at least 12 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS, env);
  return `${PASSWORD_HASH_PREFIX}$${PASSWORD_HASH_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

function passwordConfigurationError(message) {
  return Object.assign(new Error(message), { code: 'HUB_AUTH_CONFIGURATION', status: 503 });
}

async function verifyPasswordHash(username, password, expected, env = {}) {
  if (typeof password !== 'string') return false;
  const invalidHash = () => passwordConfigurationError('Staff sign-in password configuration needs administrator attention. Your account has not been changed.');
  if (typeof expected !== 'string') throw invalidHash();
  const [prefix, iterationText, saltText, hashText, extra] = expected.split('$');
  if (prefix !== PASSWORD_HASH_PREFIX) {
    if (!/^[a-f0-9]{64}$/i.test(expected)) throw invalidHash();
    return safeEqual(await hashHubCredential(username, password), expected.toLowerCase());
  }
  const iterations = Number(iterationText);
  if (extra !== undefined || !/^\d+$/.test(iterationText || '') || !Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000 || !/^[A-Za-z0-9_-]+$/.test(saltText || '') || !/^[A-Za-z0-9_-]+$/.test(hashText || '')) throw invalidHash();
  let salt, storedHash;
  try {
    salt = base64UrlToBytes(saltText);
    storedHash = base64UrlToBytes(hashText);
    if (!salt.length || storedHash.length !== PASSWORD_HASH_BYTES || bytesToBase64Url(salt) !== saltText || bytesToBase64Url(storedHash) !== hashText) throw invalidHash();
  } catch { throw invalidHash(); }
  let derived;
  try {
    derived = await derivePasswordHash(password, salt, iterations, env);
  } catch (error) {
    if (error?.name === 'NotSupportedError' && /iteration counts above \d+.*not supported/i.test(error?.message || '')) {
      throw passwordConfigurationError('The sign-in host cannot process the configured password iteration count. Ask Zac to update Hub hosting support; your account has not been changed.');
    }
    throw passwordConfigurationError('Staff sign-in password verification is unavailable. Ask Zac to check the Hub hosting setup. Your account has not been changed.');
  }
  return safeEqual(bytesToBase64Url(derived), hashText);
}

export async function validateHubCredential(env, username, password) {
  return Boolean(await authenticateHubCredential(env, username, password));
}

export async function authenticateHubCredential(env, username, password) {
  const record = userRecord(env, username);
  if (record?.passwordHash && await verifyPasswordHash(record.username, password, record.passwordHash, env)) {
    return getHubUserProfile(env, record.username);
  }
  if (configuredUsername(env, username)) return null;
  if (hasBusinessAccess(username)) {
    const error = new Error('This staff account has not been configured. Ask the owner to complete secure staff sign-in setup.');
    error.code = 'HUB_AUTH_CONFIGURATION';
    throw error;
  }
  return authenticateEmployeeAccount(env, username, password);
}

export async function createHubSessionToken(env, username, now = Date.now(), suppliedProfile = null) {
  const secret = sessionSecret(env);
  if (!secret) throw new Error('Hub session secret is not configured');
  const profile = suppliedProfile || getHubUserProfile(env, username);
  if (!profile) throw new Error('Hub user is not configured');
  const session = suppliedProfile?.source === 'employee-account'
    ? { v: 2, u: username, av: profile.sessionVersion || '', d: profile.displayName, r: 'crew', p: profile.payType || 'hourly', h: Math.max(0, Number(profile.hourlyRate || 0)), exp: now + SESSION_SECONDS * 1000 }
    : { v: 1, u: profile.user || configuredUsername(env, username), exp: now + SESSION_SECONDS * 1000 };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(session)));
  return `${payload}.${await signature(secret, payload)}`;
}

export async function verifyHubSessionToken(env, token, now = Date.now()) {
  const secret = sessionSecret(env);
  if (!secret || !token) return null;
  const [payload, suppliedSignature, extra] = String(token).split('.');
  if (!payload || !suppliedSignature || extra || !safeEqual(await signature(secret, payload), suppliedSignature)) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!Number.isFinite(session.exp) || session.exp <= now) return null;
    if (session.v === 2 && session.u && session.d) {
      const profile = await getEmployeeSessionProfile(env, String(session.u), session.av);
      return profile ? { ...profile, expiresAt: session.exp } : null;
    }
    if (session.v !== 1 || !Object.hasOwn(users(env), session.u)) return null;
    const profile = getHubUserProfile(env, session.u);
    return profile ? { ...profile, expiresAt: session.exp } : null;
  } catch {
    return null;
  }
}

export async function createHubActionState(env, purpose, username, now = Date.now()) {
  const secret = sessionSecret(env);
  if (!secret) throw new Error('Hub session secret is not configured');
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ v: 2, p: purpose, u: username, exp: now + ACTION_STATE_SECONDS * 1000 })));
  return `${payload}.${await signature(secret, payload)}`;
}

export async function verifyHubActionState(env, token, purpose, now = Date.now()) {
  const secret = sessionSecret(env);
  if (!secret || !token || !purpose) return null;
  const [payload, suppliedSignature, extra] = String(token).split('.');
  if (!payload || !suppliedSignature || extra || !safeEqual(await signature(secret, payload), suppliedSignature)) return null;
  try {
    const state = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (state.v !== 2 || state.p !== purpose || !users(env)[state.u] || !Number.isFinite(state.exp) || state.exp <= now) return null;
    return { user: state.u, purpose: state.p, expiresAt: state.exp };
  } catch {
    return null;
  }
}

export function readCookie(request, name = COOKIE_NAME) {
  const source = request.headers.get('Cookie') || '';
  for (const item of source.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return '';
}

export async function getHubSession(request, env) {
  return verifyHubSessionToken(env, readCookie(request));
}

export async function createHubSessionCookie(env, username, profile = null) {
  const token = await createHubSessionToken(env, username, Date.now(), profile);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearHubSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function hubAuthConfigured(env = {}) {
  return Boolean(sessionSecret(env));
}
