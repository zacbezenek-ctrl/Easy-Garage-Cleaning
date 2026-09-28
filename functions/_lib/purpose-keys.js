// SEC-00: every new token family signs with its own HKDF-derived HMAC key.
// Existing session cookies, portal tokens, service keys and the employee vault
// keep their current secrets; nothing here re-keys them.
const encoder = new TextEncoder();
const SALT = encoder.encode('egc/purpose-keys/v1');
const MIN_ROOT = 32, MAX_ROOT = 8192;

export const PURPOSES = Object.freeze({
  confirm: 'egc/confirm/v1',
  customerAccountSession: 'egc/customer-account-session/v1',
  magicLink: 'egc/magic-link/v1',
  rateLimit: 'egc/rate-limit/v1',
});
const LABELS = new Set(Object.values(PURPOSES));
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return base64Url(bytes) === value ? bytes : null;
  } catch { return null; }
}

/** The dedicated root wins when present; it never silently falls back if it is weak. */
export function purposeKeyRoot(env = {}) {
  const dedicated = env.HUB_PURPOSE_KEY_SECRET !== undefined && env.HUB_PURPOSE_KEY_SECRET !== '';
  const root = dedicated ? env.HUB_PURPOSE_KEY_SECRET : env.HUB_SESSION_SECRET;
  if (typeof root !== 'string' || root.length < MIN_ROOT || root.length > MAX_ROOT) throw fail('purpose_key_unavailable', 'Secure confirmation keys are not configured. Ask the Hub administrator to check the server secret.');
  return { root, name: dedicated ? 'HUB_PURPOSE_KEY_SECRET' : 'HUB_SESSION_SECRET' };
}

export async function purposeKey(env, label) {
  if (!LABELS.has(label)) throw fail('purpose_key_label_invalid', 'This key purpose is not registered.');
  const { root } = purposeKeyRoot(env);
  const material = await crypto.subtle.importKey('raw', encoder.encode(root), 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: encoder.encode(label) }, material, 256));
  try { return await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
  finally { bits.fill(0); }
}

export async function purposeSign(env, label, message) {
  const key = await purposeKey(env, label);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(message)))));
}

/** Constant-time verification through WebCrypto; malformed signatures are false. */
export async function purposeVerify(env, label, message, signature) {
  const key = await purposeKey(env, label);
  const bytes = fromBase64Url(signature);
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(String(message)));
}

export { base64Url as purposeBase64Url, fromBase64Url as purposeFromBase64Url };
