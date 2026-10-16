export const w19Reply = (status, body) => Response.json(body, { status, headers: {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
} });
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export const w19Error = error => w19Reply(error.status || 503, { ok: false, proceed: false, code: error.code || 'W19_UNAVAILABLE',
  error: error.code ? error.message : 'Completion confirmation is unavailable. Its outcome has not been confirmed; check status before retrying.' });
export const w19OriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
};

export async function w19ReadBody(request, keys) {
  const max = 4096;
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail('W19_JSON_REQUIRED', 'Send a JSON completion confirmation.', 415);
  if (Number(request.headers.get('Content-Length') || 0) > max) throw fail('W19_REQUEST_TOO_LARGE', 'The completion confirmation is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw fail('W19_REQUEST_INVALID', 'The completion confirmation is empty.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw fail('W19_REQUEST_TOO_LARGE', 'The completion confirmation is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('W19_REQUEST_INVALID', 'The completion confirmation could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw fail('W19_REQUEST_INVALID', 'The completion confirmation contains unsupported information.');
  return body;
}
