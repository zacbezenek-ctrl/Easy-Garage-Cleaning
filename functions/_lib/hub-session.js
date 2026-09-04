const COOKIE_NAME = 'egc_hub_session';
const SESSION_SECONDS = 12 * 60 * 60;

const DEFAULT_USERS = {
  ZacB: '6b8670f397174ff99440629b877581216a0b26b6770054be198988ff48a16861',
  TylerG: '28b50fd5ee98af8cf015972811def03dbc2eaff52997f82ecfc4342ece6cfa36',
  AlexK: '52e2e9901adc10406ad9597084ece4770d1c9fd0e3b76e1f31abf35f8030ac50',
  FrankJara: 'ed2ed02c6f4db402e46a370902a0f19ae2539753d4c13288954ecb32b1253d70',
  JobberCrew: 'a68121119b6a72c583c366a62257cbb3652867e9b50e46bdda6fb05280dee683',
};

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
  if (!env.HUB_AUTH_USERS_JSON) return DEFAULT_USERS;
  try {
    const configured = JSON.parse(env.HUB_AUTH_USERS_JSON);
    return configured && typeof configured === 'object' ? configured : DEFAULT_USERS;
  } catch {
    return DEFAULT_USERS;
  }
}

function sessionSecret(env = {}) {
  return env.HUB_SESSION_SECRET || env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '';
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
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

export async function validateHubCredential(env, username, password) {
  const expected = users(env)[username];
  if (!expected || typeof password !== 'string') return false;
  return safeEqual(await hashHubCredential(username, password), expected);
}

export async function createHubSessionToken(env, username, now = Date.now()) {
  const secret = sessionSecret(env);
  if (!secret) throw new Error('Hub session secret is not configured');
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ v: 1, u: username, exp: now + SESSION_SECONDS * 1000 })));
  return `${payload}.${await signature(secret, payload)}`;
}

export async function verifyHubSessionToken(env, token, now = Date.now()) {
  const secret = sessionSecret(env);
  if (!secret || !token) return null;
  const [payload, suppliedSignature, extra] = String(token).split('.');
  if (!payload || !suppliedSignature || extra || !safeEqual(await signature(secret, payload), suppliedSignature)) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (session.v !== 1 || !users(env)[session.u] || !Number.isFinite(session.exp) || session.exp <= now) return null;
    return { user: session.u, expiresAt: session.exp };
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

export async function createHubSessionCookie(env, username) {
  const token = await createHubSessionToken(env, username);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearHubSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function hubAuthConfigured(env = {}) {
  return Boolean(sessionSecret(env));
}

