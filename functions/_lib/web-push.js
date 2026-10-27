// Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm per RFC 8188) and VAPID sender identity (RFC 8292),
// on WebCrypto only, so it runs on Cloudflare Workers (and in Node's test runner) with no Node-only library.
// The VAPID key pair lives in Cloudflare env: EGC_VAPID_PUBLIC_KEY is the uncompressed P-256 point (65 bytes) and
// EGC_VAPID_PRIVATE_KEY the private scalar (32 bytes), both base64url, the format `npx web-push generate-vapid-keys`
// and scripts/generate-vapid-keys.mjs print. The private key never leaves the server.

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
// Push services a subscription may point at. The browser picks the endpoint, so the server posts only to these hosts
// (Chrome and Android: FCM; Safari and iPhone: Apple; Firefox: Mozilla; Edge: Windows push), never to any other URL.
const PUSH_HOSTS = /(?:^|\.)(?:fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
export const PUSH_GONE = new Set([404, 410]);

export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('Invalid base64url');
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), char => char.charCodeAt(0));
}

const decoded = value => { try { return base64UrlDecode(value); } catch { return null; } };
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

/** An https endpoint on a known push service, or ''. */
export function pushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1024) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && PUSH_HOSTS.test(url.hostname) ? url.href : '';
  } catch { return ''; }
}

/** A browser PushSubscription (its toJSON shape) checked for sending, or null. */
export function pushSubscription(value) {
  const endpoint = pushEndpoint(value?.endpoint);
  const p256dh = decoded(value?.keys?.p256dh), auth = decoded(value?.keys?.auth);
  if (!endpoint || p256dh?.length !== 65 || p256dh[0] !== 4 || auth?.length !== 16) return null;
  return { endpoint, keys: { p256dh: base64UrlEncode(p256dh), auth: base64UrlEncode(auth) } };
}

/** The VAPID key pair from env, or null when either half is missing or malformed. */
export function vapidKeys(env) {
  const publicKey = decoded(String(env?.EGC_VAPID_PUBLIC_KEY ?? '').trim()), privateKey = decoded(String(env?.EGC_VAPID_PRIVATE_KEY ?? '').trim());
  if (publicKey?.length !== 65 || publicKey[0] !== 4 || privateKey?.length !== 32) return null;
  return { publicKey: base64UrlEncode(publicKey), jwk: { kty: 'EC', crv: 'P-256', x: base64UrlEncode(publicKey.slice(1, 33)), y: base64UrlEncode(publicKey.slice(33, 65)), d: base64UrlEncode(privateKey), ext: false } };
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** RFC 8291: the payload encrypted to the subscription's keys as one aes128gcm record. `local` and `salt` are for tests. */
export async function encryptPushPayload(subscription, payload, { local, salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const uaPublic = base64UrlDecode(subscription.keys.p256dh), authSecret = base64UrlDecode(subscription.keys.auth);
  const plaintext = typeof payload === 'string' ? encoder.encode(payload) : new Uint8Array(payload);
  if (plaintext.length + 17 > RECORD_SIZE) throw new RangeError('Push payload is too large');
  const pair = local || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const receiver = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, pair.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record, so it is the last: the 0x02 delimiter, no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, Uint8Array.of(2))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

/** RFC 8292: the Authorization header value for one push service (the endpoint's origin), valid for 12 hours. */
export async function vapidAuthorization(keys, endpoint, { subject, now = Date.now() } = {}) {
  const segment = value => base64UrlEncode(encoder.encode(JSON.stringify(value)));
  const unsigned = `${segment({ typ: 'JWT', alg: 'ES256' })}.${segment({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const key = await crypto.subtle.importKey('jwk', keys.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already the JOSE r||s form.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

/** Posts one encrypted message. Resolves to the push service's status (201 sent, 404/410 the subscription is gone). */
export async function sendWebPush(keys, subscription, payload, { subject, ttl = 3600, urgency = 'high', now = Date.now(), fetcher = fetch } = {}) {
  const endpoint = pushEndpoint(subscription?.endpoint);
  if (!endpoint) return 0;
  const body = await encryptPushPayload(subscription, payload);
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidAuthorization(keys, endpoint, { subject, now }), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency },
    body,
  });
  return response.status;
}
