const PROJECT_ID = 'egcw-1ec83';
const encoder = new TextEncoder();
const CUSTOM_TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

let cachedAccessToken = null;

function unitTestKey(env = {}) {
  const key = String(env.FIREBASE_API_KEY || '');
  return /^firebase-test(?:-|$)/.test(key) ? key : '';
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

function serviceAccount(env = {}) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('Firebase service account is not configured');
  let account;
  try { account = JSON.parse(raw); }
  catch { throw new Error('Firebase service account is invalid'); }
  const privateKey = String(account.private_key || '').replace(/\\n/g, '\n');
  const clientEmail = String(account.client_email || '');
  const projectId = String(account.project_id || PROJECT_ID);
  if (!privateKey || !clientEmail || projectId !== PROJECT_ID) {
    throw new Error('Firebase service account does not match this project');
  }
  return { ...account, private_key: privateKey, client_email: clientEmail, project_id: projectId };
}

async function signingKey(account) {
  const der = Uint8Array.from(
    atob(account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')),
    character => character.charCodeAt(0),
  );
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signedJwt(account, payload) {
  const header = encodeJson({ alg: 'RS256', typ: 'JWT', ...(account.private_key_id ? { kid: account.private_key_id } : {}) });
  const body = encodeJson(payload);
  const unsigned = `${header}.${body}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(account), encoder.encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export function firebaseServiceAccountConfigured(env = {}) {
  try { serviceAccount(env); return true; }
  catch { return Boolean(unitTestKey(env)); }
}

export async function createFirebaseCustomToken(env, uid, claims = {}) {
  const account = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const safeUid = String(uid || '').trim().slice(0, 128);
  if (!safeUid) throw new Error('Firebase user id is required');
  return signedJwt(account, {
    iss: account.client_email,
    sub: account.client_email,
    aud: CUSTOM_TOKEN_AUDIENCE,
    iat: now,
    exp: now + 3600,
    uid: safeUid,
    claims,
  });
}

export async function getFirestoreAccessToken(env) {
  const account = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken?.email === account.client_email && cachedAccessToken.expiresAt > now + 60) {
    return cachedAccessToken.token;
  }
  const assertion = await signedJwt(account, {
    iss: account.client_email,
    scope: FIRESTORE_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error(`Firebase service authentication failed (${response.status})`);
  cachedAccessToken = {
    email: account.client_email,
    token: result.access_token,
    expiresAt: now + Math.max(300, Number(result.expires_in || 3600)),
  };
  return cachedAccessToken.token;
}

export async function firestoreFetch(env, input, init = {}) {
  const url = new URL(String(input));
  url.searchParams.delete('key');
  const headers = new Headers(init.headers || {});
  const testKey = unitTestKey(env);
  if (testKey) url.searchParams.set('key', testKey);
  else headers.set('Authorization', `Bearer ${await getFirestoreAccessToken(env)}`);
  return fetch(url, { ...init, headers });
}
