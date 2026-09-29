// SEC-00: every new token family signs with its own HKDF-derived HMAC key.
// Existing session cookies, portal tokens, service keys and the employee vault
// keep their current secrets; nothing here re-keys them.
const encoder = new TextEncoder();
const SALT = encoder.encode('egc/purpose-keys/v1');
const MIN_ROOT = 32, MAX_ROOT = 8192;

export const PURPOSES = Object.freeze({
  confirm: 'egc/confirm/v1',
  crewPhotoLink: 'egc/crew-photo-link/v1',
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

// Tokens and signatures stay under 4096 characters; a sealed value passes its own, larger bound.
function fromBase64Url(value, max = 4096) {
  if (typeof value !== 'string' || !value || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
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

async function derivedBits(env, label) {
  const { root } = purposeKeyRoot(env);
  const material = await crypto.subtle.importKey('raw', encoder.encode(root), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: encoder.encode(label) }, material, 256));
}

export async function purposeKey(env, label) {
  if (!LABELS.has(label)) throw fail('purpose_key_label_invalid', 'This key purpose is not registered.');
  const bits = await derivedBits(env, label);
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

// FUN-13: AES-GCM sealing keys from the same root. Their HKDF labels never
// match a signing label, so a sealing key can never sign or verify a token.
export const SEAL_PURPOSES = Object.freeze({
  webLeadReceipt: 'egc/seal/web-lead-receipt/v1',
});
const SEAL_LABELS = new Set(Object.values(SEAL_PURPOSES));
// The largest value that may be sealed (UTF-8 JSON bytes). It covers any
// website lead the 32 KB web-lead body limit admits, even all 3-byte
// characters, and a Firestore document holds its ciphertext with room to spare.
export const SEAL_MAX_BYTES = 256 * 1024;
// base64url characters of the largest ciphertext (plaintext plus the 16-byte tag): anything sealed can be opened.
const SEAL_MAX_CT = Math.ceil((SEAL_MAX_BYTES + 16) * 4 / 3);

async function sealKey(env, label) {
  if (!SEAL_LABELS.has(label)) throw fail('purpose_key_label_invalid', 'This key purpose is not registered.');
  const bits = await derivedBits(env, label);
  try { return await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
  finally { bits.fill(0); }
}

/** Seals a JSON value with a random 12-byte IV; `aad` binds it to the record that stores it. */
export async function purposeSeal(env, label, value, aad) {
  if (typeof aad !== 'string' || !aad) throw fail('purpose_seal_invalid', 'A sealed value must be bound to its record.');
  const plain = encoder.encode(JSON.stringify(value));
  if (plain.length > SEAL_MAX_BYTES) throw fail('purpose_seal_too_large', 'The value is too large to seal.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, await sealKey(env, label), plain));
  return { v: 1, iv: base64Url(iv), ct: base64Url(sealed) };
}

/** Opens a value sealed by purposeSeal for the same record; anything altered or re-bound fails closed. */
export async function purposeOpen(env, label, sealed, aad) {
  const iv = fromBase64Url(sealed?.iv), ct = fromBase64Url(sealed?.ct, SEAL_MAX_CT);
  if (sealed?.v !== 1 || !iv || iv.length !== 12 || !ct || ct.length < 17 || typeof aad !== 'string' || !aad) throw fail('purpose_seal_invalid', 'The sealed value is malformed.');
  const key = await sealKey(env, label);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, ct); }
  catch { throw fail('purpose_seal_invalid', 'The sealed value could not be opened.'); }
  return JSON.parse(new TextDecoder().decode(plain));
}

export { base64Url as purposeBase64Url };
// Token decoding for other modules always keeps the 4096-character cap.
export const purposeFromBase64Url = value => fromBase64Url(value);
