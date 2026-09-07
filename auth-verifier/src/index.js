import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PASSWORD_CHARACTERS = 8192;
const MAX_PASSWORD_BYTES = 3 * MAX_PASSWORD_CHARACTERS;
const MAX_SALT_BYTES = 4096;
const HASH_BYTES = 32;
const FIELDS = new Set(['algorithm', 'password', 'salt', 'iterations', 'length']);
const encoder = new TextEncoder();

class InvalidRequest extends Error {
  constructor(status = 400) {
    super('Invalid derivation request.');
    this.status = status;
  }
}

function failure(status) {
  return new Response(JSON.stringify({ error: status === 503 ? 'Derivation unavailable.' : 'Invalid derivation request.' }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function readInput(request) {
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    throw new InvalidRequest(413);
  }
  if (!request.body) throw new InvalidRequest();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  let bytes;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new InvalidRequest(413);
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new InvalidRequest(); }
  } finally {
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function decodeSalt(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_SALT_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidRequest();
  }
  let decoded;
  try {
    decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));
  } catch { throw new InvalidRequest(); }
  const canonical = btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (canonical !== value || decoded.length < 1 || decoded.length > MAX_SALT_BYTES) throw new InvalidRequest();
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

// Only callers with this Durable Object namespace binding can reach fetch().
// No constructor state, storage calls, network calls, timers, or logging retain
// credential material after the request finishes.
export class PasswordVerifier {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/derive') return failure(404);
    if (request.method !== 'POST') return failure(405);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415);
    let passwordBytes;
    let saltBytes;
    try {
      const input = await readInput(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).length !== FIELDS.size || Object.keys(input).some(key => !FIELDS.has(key)) ||
          input.algorithm !== 'pbkdf2-sha256' || input.length !== HASH_BYTES ||
          !Number.isInteger(input.iterations) || input.iterations < 100000 || input.iterations > 1000000 ||
          typeof input.password !== 'string' || input.password.length < 1 || input.password.length > MAX_PASSWORD_CHARACTERS) {
        throw new InvalidRequest();
      }
      passwordBytes = encoder.encode(input.password);
      if (passwordBytes.byteLength > MAX_PASSWORD_BYTES) throw new InvalidRequest();
      saltBytes = decodeSalt(input.salt);
      const derived = pbkdf2(sha256, passwordBytes, saltBytes, { c: input.iterations, dkLen: HASH_BYTES });
      if (!(derived instanceof Uint8Array) || derived.byteLength !== HASH_BYTES) return failure(503);
      return new Response(derived, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      return failure(error instanceof InvalidRequest ? error.status : 503);
    } finally {
      passwordBytes?.fill(0);
      saltBytes?.fill(0);
    }
  }
}

// There is deliberately no public credential-derivation endpoint.
export default {
  fetch() {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
