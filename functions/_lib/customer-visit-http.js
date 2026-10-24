const fail = (message, status) => Object.assign(new Error(message), { code: 'CUSTOMER_VISIT_REQUEST_INVALID', status });
export async function readVisitJson(request, { portal = false } = {}) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site' || portal && request.headers.get('X-EGC-Portal') !== '1') throw fail('Reload this page before making the request.', 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail('Use a JSON request.', 415);
  if (Number(request.headers.get('Content-Length')) > 6000) throw fail('This request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw fail('The request could not be read.', 400);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 6000) { await reader.cancel(); throw fail('This request is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const data = JSON.parse(new TextDecoder().decode(buffer));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch { throw fail('The request could not be read.', 400); }
}
