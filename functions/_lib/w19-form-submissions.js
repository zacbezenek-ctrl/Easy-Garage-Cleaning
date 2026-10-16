import { HIGHLEVEL_API, highLevelConfig } from './highlevel-tags.js';
import { normalizeEmail } from './customer-identity.js';

// This is the existing native completion form. The intake/estimate form is a
// different form and cannot provide a W19 completion receipt.
export const W19_FORM_ID = '7HCRlKJs4VZx4KwNmDa6';
const PAGE_SIZE = 100, MAX_PAGES = 5, MAX_BODY_BYTES = 512 * 1024, PAGE_TIMEOUT_MS = 5000;
const ID = /^[A-Za-z0-9_-]{1,180}$/;
const REFERENCE = /^[A-Za-z0-9._~-]{16,512}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validId = value => typeof value === 'string' && ID.test(value);
function timestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return NaN;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return NaN;
  return Date.parse(value);
}
function fail(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}
const unavailable = () => fail('w19-provider-unavailable', 503, 'Completion submission verification is unavailable.');
function searchDate(instant, offsetDays) {
  const date = new Date(instant + offsetDays * 86400000).toISOString();
  return date.startsWith('+') ? '9999-12-31' : date.startsWith('-') ? '0000-01-01' : date.slice(0, 10);
}
function cancelQuietly(target) {
  // Stream cleanup must not extend the request deadline if cancellation stalls.
  try { void target?.cancel().catch(() => {}); } catch {}
}

async function boundedJson(response, signal) {
  if (!response?.ok || !response.headers || !response.body?.getReader) throw unavailable();
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType || '')) throw unavailable();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw unavailable();
  const reader = response.body.getReader();
  const cancel = () => cancelQuietly(reader);
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || length + value.byteLength > MAX_BODY_BYTES) throw unavailable();
      chunks.push(value); length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancelQuietly(reader);
    reader.releaseLock();
  }
}

async function readProvider(config, path, fetcher) {
  const controller = new AbortController();
  let timer, response;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, PAGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([timeout, (async () => {
      response = await fetcher(`${HIGHLEVEL_API}${path}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${config.token}`, Version: 'v3' },
      });
      return boundedJson(response, controller.signal);
    })()]);
  } catch {
    throw unavailable(); // Do not propagate provider text, credentials, or submitted answers.
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) {
      cancelQuietly(response.body);
    }
  }
}

function matchesReceipt(row, { contactId, locationId, jobId, reference, fieldIds, issued, expires }) {
  const created = timestamp(row.createdAt);
  return row.formId === W19_FORM_ID && row.contactId === contactId &&
    (!Object.hasOwn(row, 'locationId') || row.locationId === locationId) &&
    typeof row.others[fieldIds.jobId] === 'string' && row.others[fieldIds.jobId] === jobId &&
    typeof row.others[fieldIds.reference] === 'string' && row.others[fieldIds.reference] === reference &&
    created >= issued && created <= expires;
}

/** Read-only verification of one exact native receipt, using server-held bindings.
 * q is only a broad provider search; no returned row is trusted until all exact
 * bindings have been checked. Without a provider receipt ID, select the stable
 * earliest exact match only after complete pagination. The caller must claim
 * the canonical business handoff once, independently of provider receipt IDs.
 * Field IDs must come from verified form setup.
 */
export async function readW19Submission(env, input, fetcher = fetch) {
  const { submissionId, contactId, locationId, reference, jobId, issuedAt, expiresAt, fieldIds } = input || {};
  const issued = timestamp(issuedAt), expires = timestamp(expiresAt);
  if ((submissionId !== undefined && !validId(submissionId)) || ![contactId, locationId, jobId].every(validId) || typeof reference !== 'string' || !REFERENCE.test(reference) ||
      !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued ||
      !plain(fieldIds) || !validId(fieldIds.jobId) || !validId(fieldIds.reference) || fieldIds.jobId === fieldIds.reference || typeof fetcher !== 'function') {
    throw fail('w19-invalid-input', 400, 'Completion receipt bindings are invalid.');
  }
  const config = highLevelConfig(env || {});
  if (typeof config.token !== 'string' || !config.token.trim() || config.token.length > 8192 || config.locationId !== locationId) {
    throw fail('w19-configuration', 503, 'Completion submission verification is not configured.');
  }
  const seenIds = new Set();
  const expected = { contactId, locationId, jobId, reference, fieldIds, issued, expires };
  const matching = [];
  let selected = null, total = null, count = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ locationId, formId: W19_FORM_ID, q: contactId, page: String(page), limit: String(PAGE_SIZE),
      // The provider does not document its date-filter timezone. Pad the read
      // window by a day; the receipt timestamp still has exact bounds below.
      startAt: searchDate(issued, -1), endAt: searchDate(expires, 1) });
    const body = await readProvider(config, `/forms/submissions?${query}`, fetcher);
    if (!plain(body) || !Array.isArray(body.submissions) || body.submissions.length > PAGE_SIZE || !plain(body.meta) ||
        (Object.hasOwn(body, 'locationId') && body.locationId !== locationId)) throw unavailable();
    const meta = body.meta;
    if (!Number.isSafeInteger(meta.total) || meta.total < 0 || meta.total > PAGE_SIZE * MAX_PAGES ||
        meta.currentPage !== page || (meta.nextPage !== null && meta.nextPage !== page + 1) ||
        (Object.hasOwn(meta, 'prevPage') && meta.prevPage !== (page === 1 ? null : page - 1)) ||
        (total !== null && meta.total !== total)) throw unavailable();
    total = meta.total;
    for (const row of body.submissions) {
      if (!plain(row) || !validId(row.id) || !validId(row.formId) || !validId(row.contactId) ||
          !Number.isFinite(timestamp(row.createdAt)) || !plain(row.others) || Object.keys(row.others).length > 200 || seenIds.has(row.id)) throw unavailable();
      seenIds.add(row.id); count += 1;
      if (submissionId !== undefined) {
        if (row.id === submissionId) selected = row;
      } else if (matchesReceipt(row, expected)) {
        matching.push(row);
      }
    }
    if (count > total || (meta.nextPage !== null && (body.submissions.length !== PAGE_SIZE || count >= total))) throw unavailable();
    if (meta.nextPage === null) {
      if (count !== total) throw unavailable();
      if (submissionId === undefined) {
        selected = matching.reduce((earliest, row) => {
          if (!earliest) return row;
          const delta = timestamp(row.createdAt) - timestamp(earliest.createdAt);
          return delta < 0 || (delta === 0 && row.id < earliest.id) ? row : earliest;
        }, null);
      }
      if (!selected) throw fail('w19-submission-pending', 409, 'The completion submission receipt is not available yet.');
      const created = timestamp(selected.createdAt);
      if (!matchesReceipt(selected, expected)) {
        throw fail('w19-submission-mismatch', 409, 'The completion submission does not match this job confirmation.');
      }
      return Object.freeze({ submissionId: selected.id, formId: W19_FORM_ID, contactId, locationId, jobId, reference, createdAt: new Date(created).toISOString() });
    }
  }
  throw unavailable(); // Never treat a capped or incomplete search as absent or verified.
}

/** Verify only the opportunity already linked by the canonical job. Never
 * search a contact's latest opportunity or infer an opportunity from a form.
 * Official API: GET /opportunities/:id, Version v3, { opportunity: {...} }.
 */
export async function readW19Opportunity(env, input, fetcher = fetch) {
  const { opportunityId, contactId, locationId } = input || {};
  if (![opportunityId, contactId, locationId].every(validId) || typeof fetcher !== 'function') {
    throw fail('w19-invalid-input', 400, 'Completion opportunity bindings are invalid.');
  }
  const config = highLevelConfig(env || {});
  if (typeof config.token !== 'string' || !config.token.trim() || config.token.length > 8192 || config.locationId !== locationId) {
    throw fail('w19-configuration', 503, 'Completion opportunity verification is not configured.');
  }
  const body = await readProvider(config, `/opportunities/${encodeURIComponent(opportunityId)}`, fetcher);
  const opportunity = body?.opportunity;
  if (!plain(body) || !plain(opportunity) || ![opportunity.id, opportunity.contactId, opportunity.locationId].every(validId)) throw unavailable();
  if (opportunity.id !== opportunityId || opportunity.contactId !== contactId || opportunity.locationId !== locationId ||
      (Object.hasOwn(body, 'locationId') && body.locationId !== locationId)) {
    throw fail('w19-opportunity-mismatch', 409, 'The linked opportunity does not match this job confirmation.');
  }
  return Object.freeze({ id: opportunityId, contactId, locationId });
}

/** Verify the email on the job's already-linked customer contact. No contact
 * search, upsert, or fallback address is permitted. The caller must separately
 * compare this normalized address with the canonical job email before exposing
 * the job's existing value to an authorized lead.
 */
export async function readW19CustomerEmail(env, input, fetcher = fetch) {
  const { contactId, locationId } = input || {};
  if (![contactId, locationId].every(validId) || typeof fetcher !== 'function') {
    throw fail('w19-invalid-input', 400, 'Completion customer bindings are invalid.');
  }
  const config = highLevelConfig(env || {});
  if (typeof config.token !== 'string' || !config.token.trim() || config.token.length > 8192 || config.locationId !== locationId) {
    throw fail('w19-configuration', 503, 'Completion customer verification is not configured.');
  }
  // Official GET /contacts/:contactId returns { contact: { id, locationId, email, ... } }.
  const body = await readProvider(config, `/contacts/${encodeURIComponent(contactId)}`, fetcher);
  const contact = body?.contact;
  if (!plain(body) || !plain(contact) || ![contact.id, contact.locationId].every(validId)) throw unavailable();
  if (contact.id !== contactId || contact.locationId !== locationId ||
      (Object.hasOwn(body, 'locationId') && body.locationId !== locationId)) {
    throw fail('w19-customer-mismatch', 409, 'The linked customer does not match this job confirmation.');
  }
  const email = normalizeEmail(contact.email);
  if (!email) throw unavailable();
  return Object.freeze({ contactId, locationId, email });
}
