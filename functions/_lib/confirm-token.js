import { PURPOSES, purposeBase64Url, purposeFromBase64Url, purposeSign, purposeVerify } from './purpose-keys.js';

// SEC-03: two-step confirmation for money, customer-send and destructive
// commands. Step one returns a short-lived HMAC token bound to the actor, the
// action, the record and a digest of the exact payload. Step two verifies it and
// creates confirm_tokens/{sha256(nonce)} with exists:false in the same commit as
// the change, so a token can authorize exactly one change.
export const CONFIRM_TOKEN_COLLECTION = 'confirm_tokens';
const PREFIX = 'ect1';
const MAX_TTL_SECONDS = 300, CLOCK_SKEW_MS = 60000, MAX_TOKEN = 2048, MAX_PAYLOAD = 256000;
const ACTOR = /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/, ACTION = /^[a-z][a-z0-9_.:-]{0,79}$/, ENTITY = /^[A-Za-z0-9_.:/-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const HEX64 = /^[a-f0-9]{64}$/, NONCE = /^[A-Za-z0-9_-]{22}$/;
const encoder = new TextEncoder();
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const invalidInput = message => fail('confirm_token_input_invalid', message, 400);
const invalidToken = () => fail('confirm_token_invalid', 'This confirmation is not valid. Review the action and confirm again.', 403);
const mismatch = () => fail('confirm_token_mismatch', 'This confirmation does not match the requested change. Review the action and confirm again.', 403);

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const sha256Hex = async text => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));

function clock(now) {
  const value = now instanceof Date ? now.toISOString() : now;
  const ms = typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw invalidInput('A valid server time is required to confirm this change.');
  return ms;
}

function binding({ actorId, action, entityId } = {}) {
  const actor = typeof actorId === 'string' ? actorId.trim().toLowerCase() : '';
  if (!ACTOR.test(actor)) throw invalidInput('The confirming account is not valid.');
  if (typeof action !== 'string' || !ACTION.test(action)) throw invalidInput('The action to confirm is not valid.');
  if (typeof entityId !== 'string' || !ENTITY.test(entityId)) throw invalidInput('The record to confirm is not valid.');
  return { actor, action, entityId };
}

/** Undefined keys and Date objects normalize exactly as JSON would send them. */
export async function confirmationPayloadHash(payload) {
  let text;
  try { text = canonical(JSON.parse(JSON.stringify(payload === undefined ? null : payload))); } catch { throw invalidInput('The change to confirm could not be read.'); }
  if (text.length > MAX_PAYLOAD) throw invalidInput('The change to confirm is too large.');
  return sha256Hex(text);
}

export async function issueConfirmation(env, { actorId, action, entityId, payload, summary, ttlSeconds = MAX_TTL_SECONDS, now = new Date().toISOString() } = {}) {
  if (env && typeof env === 'object' && Object.hasOwn(env, 'actorId')) throw new TypeError('issueConfirmation(env, {actorId, action, entityId, payload, now}) takes the Worker env first.');
  const bound = binding({ actorId, action, entityId }), iat = clock(now);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) throw invalidInput(`Confirmations expire within ${MAX_TTL_SECONDS / 60} minutes.`);
  if (summary !== undefined && (typeof summary !== 'string' || !summary.trim())) throw invalidInput('The confirmation summary must be text.');
  const nonce = purposeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const claims = { v: 1, a: bound.actor, x: bound.action, e: bound.entityId, h: await confirmationPayloadHash(payload), iat, exp: iat + ttlSeconds * 1000, n: nonce };
  const body = purposeBase64Url(encoder.encode(JSON.stringify(claims)));
  const token = `${PREFIX}.${body}.${await purposeSign(env, PURPOSES.confirm, `${PREFIX}.${body}`)}`;
  return {
    confirmationId: await sha256Hex(nonce), token, expiresAt: new Date(claims.exp).toISOString(), payloadHash: claims.h,
    summary: (summary || `Confirm ${bound.action} for ${bound.entityId}`).trim().slice(0, 300),
  };
}

async function verify(env, token, expected) {
  const bound = binding(expected), now = clock(expected.now);
  if (typeof token !== 'string' || token.length > MAX_TOKEN) throw invalidToken();
  const [prefix, body, signature, extra] = token.split('.');
  if (prefix !== PREFIX || !body || !signature || extra !== undefined) throw invalidToken();
  if (!await purposeVerify(env, PURPOSES.confirm, `${PREFIX}.${body}`, signature)) throw invalidToken();
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(purposeFromBase64Url(body))); } catch { throw invalidToken(); }
  if (!claims || claims.v !== 1 || typeof claims.a !== 'string' || typeof claims.x !== 'string' || typeof claims.e !== 'string' || !HEX64.test(claims.h) || !NONCE.test(claims.n) ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TTL_SECONDS * 1000 || claims.iat > now + CLOCK_SKEW_MS) throw invalidToken();
  if (claims.a !== bound.actor || claims.x !== bound.action || claims.e !== bound.entityId || claims.h !== await confirmationPayloadHash(expected.payload)) throw mismatch();
  if (claims.exp <= now) throw fail('confirm_token_expired', 'This confirmation expired. Review the action and confirm again.', 410);
  return { now, claims: { confirmationId: await sha256Hex(claims.n), actorId: claims.a, action: claims.x, entityId: claims.e, payloadHash: claims.h, issuedAt: new Date(claims.iat).toISOString(), expiresAt: new Date(claims.exp).toISOString() } };
}

/** Verifies signature, binding and expiry without consuming the token. */
export async function verifyConfirmation(env, token, expected = {}) {
  return (await verify(env, token, expected)).claims;
}

/**
 * Consumes the token atomically with `writes` (the confirmed change) using
 * store.commit and store.read (dispatchStorage, schedulingStorage or an
 * equivalent). replayed:false means THIS call's commit applied `writes`.
 * replayed:true means an earlier call with the same requestId already applied
 * them, so nothing was committed now and the caller must not repeat any send,
 * charge or other side effect. Without a requestId every reuse is
 * confirm_token_used.
 */
export async function consumeConfirmation(env, store, token, expected = {}, writes = []) {
  if (typeof store?.read !== 'function' || typeof store?.commit !== 'function') throw new TypeError('consumeConfirmation(env, store, token, expected, writes) needs a store with read() and commit().');
  const { now, claims } = await verify(env, token, expected);
  if (expected.requestId !== undefined && expected.requestId !== null && (typeof expected.requestId !== 'string' || !UUID.test(expected.requestId))) throw invalidInput('The confirming request needs a valid request ID.');
  if (!Array.isArray(writes)) throw invalidInput('The confirmed change is not valid.');
  const requestId = expected.requestId ? expected.requestId.toLowerCase() : null;
  // attemptId is unique to this call, so a read-back can tell this call's own
  // lost response apart from another call that carried the same requestId.
  const attemptId = hex(crypto.getRandomValues(new Uint8Array(16)));
  const record = { v: 1, ...claims, consumedAt: new Date(now).toISOString(), attemptId, requestId };
  const result = { ok: true, confirmationId: claims.confirmationId, consumedAt: record.consumedAt };
  const outcome = saved => {
    if (!saved) return null;
    const consumedAt = saved.consumedAt || result.consumedAt;
    if (saved.attemptId === attemptId) return { ...result, consumedAt, replayed: false };
    if (requestId && saved.requestId === requestId) return { ...result, consumedAt, replayed: true };
    throw fail('confirm_token_used', 'This confirmation was already used. Review the action and confirm again.', 409);
  };
  // The receipt is checked before committing, so a retry never depends on
  // which precondition the store evaluates first or how it reports it.
  const existing = outcome(await store.read(CONFIRM_TOKEN_COLLECTION, claims.confirmationId));
  if (existing) return existing;
  try {
    await store.commit([{ collection: CONFIRM_TOKEN_COLLECTION, id: claims.confirmationId, patch: record, data: record }, ...writes]);
    return { ...result, replayed: false };
  } catch (error) {
    let saved;
    try { saved = await store.read(CONFIRM_TOKEN_COLLECTION, claims.confirmationId); } catch { throw error; }
    const settled = outcome(saved);
    if (settled) return settled;
    throw error;
  }
}

/** Env-bound helpers for callers that hold the env once: confirmations(env).issue({...}). */
export function confirmations(env) {
  return {
    issue: input => issueConfirmation(env, input),
    verify: (token, expected) => verifyConfirmation(env, token, expected),
    consume: (store, token, expected, writes) => consumeConfirmation(env, store, token, expected, writes),
  };
}
