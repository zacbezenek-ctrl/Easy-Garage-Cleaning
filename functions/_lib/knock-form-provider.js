// GET-only through the existing integration. No contact writes or workflow changes.
import { ghl } from './highlevel-tags.js';
import { knockFailure } from './knock-store.js';

const ID = /^[A-Za-z0-9_-]{1,180}$/;
const isId = value => typeof value === 'string' && ID.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const NATIVE_SCAN_LIMIT = Object.freeze({ pages: 5, pageSize: 100, responseBytes: 1048576, timeoutMs: 20000 });
const unavailable = () => knockFailure('GHL submission evidence is unavailable. Nothing has been marked submitted; check again later.', 424, 'knock_form_provider_unavailable');
const incomplete = () => knockFailure('GHL receipt search is incomplete. Nothing was marked submitted; ask a manager to review.', 409, 'knock_form_search_incomplete');

async function boundedResponse(response) {
  if (Number(response.headers.get('content-length')) > NATIVE_SCAN_LIMIT.responseBytes) throw unavailable();
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > NATIVE_SCAN_LIMIT.responseBytes) throw unavailable();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Response(new Blob(chunks), { status: response.status, headers: { 'Content-Type': 'application/json' } });
}

export function nativeFormReader(integration, { fetcher = fetch } = {}) {
  const client = () => {
    const signal = AbortSignal.timeout(NATIVE_SCAN_LIMIT.timeoutMs);
    return { ...integration, fetch: async (url, options) => boundedResponse(await fetcher(url, { ...options, redirect: 'error', signal })) };
  };
  const contactFor = async (c, row) => {
    const contact = (await ghl(c, `/contacts/${encodeURIComponent(row.contactId)}`, { method: 'GET' }))?.contact;
    if (!object(contact) || contact.id !== row.contactId || contact.locationId !== c.locationId ||
        row.locationId != null && row.locationId !== c.locationId || typeof row.createdAt !== 'string' || row.createdAt.length > 40 ||
        !Number.isFinite(Date.parse(row.createdAt)) || !object(row.others) || Object.keys(row.others).length > 100) throw unavailable();
    return { row, contact };
  };
  const parameters = (formId, createdAt, expiresAt, page) => new URLSearchParams({ locationId: integration.locationId,
    formId, limit: String(NATIVE_SCAN_LIMIT.pageSize), page: String(page), startAt: createdAt.slice(0, 10), endAt: expiresAt.slice(0, 10) });
  // Compatibility diagnostic: exact IDs still use the same verifier, never a provider write.
  const read = async ({ formId, contactId, submissionId, createdAt, expiresAt }) => {
    if (![formId, contactId, submissionId].every(isId)) throw unavailable();
    try {
      const c = client(), params = parameters(formId, createdAt, expiresAt, 1); params.set('q', contactId);
      const data = await ghl(c, `/forms/submissions?${params}`, { method: 'GET' });
      if (!object(data) || !Array.isArray(data.submissions) || data.submissions.length > 100) throw unavailable();
      const matches = data.submissions.filter(row => object(row) && row.id === submissionId && row.formId === formId && row.contactId === contactId);
      if (matches.length !== 1) throw unavailable();
      return await contactFor(c, matches[0]);
    } catch { throw unavailable(); }
  };
  // q does NOT search custom fields. Scan the documented form/date pages, then match the opaque reference exactly.
  read.discover = async ({ formId, referenceFieldId, reference, createdAt, expiresAt }) => {
    if (!isId(formId) || !isId(referenceFieldId) || !/^kf_[0-9a-f]{32}$/.test(reference)) throw unavailable();
    const c = client(), seen = new Set(), matches = []; let total = null;
    try {
      for (let page = 1; page <= NATIVE_SCAN_LIMIT.pages; page++) {
        const data = await ghl(c, `/forms/submissions?${parameters(formId, createdAt, expiresAt, page)}`, { method: 'GET' });
        const rows = data?.submissions, meta = data?.meta;
        if (!Array.isArray(rows) || rows.length > 100 || !object(meta) || meta.currentPage !== page ||
            !Number.isSafeInteger(meta.total) || meta.total < 0 || meta.total > 500 || total !== null && meta.total !== total ||
            !(meta.nextPage === null || meta.nextPage === page + 1)) throw incomplete();
        total = meta.total;
        for (const row of rows) {
          if (!object(row) || !isId(row.id) || !isId(row.contactId) || !object(row.others) || seen.has(row.id)) throw incomplete();
          seen.add(row.id);
          const value = row.others[referenceFieldId];
          if (value === reference || Array.isArray(value) && value.includes(reference)) matches.push(row);
        }
        if (matches.length > 1) throw knockFailure('More than one GHL submission uses this reference. Manager review is required.', 409, 'knock_form_multiple_receipts');
        if (meta.nextPage === null) {
          if (seen.size !== total) throw incomplete();
          if (!matches.length) return null;
          if (matches[0].formId !== formId || matches[0].others[referenceFieldId] !== reference) throw knockFailure('GHL reference is ambiguous or belongs to another form.', 409, 'knock_form_mismatch');
          return await contactFor(c, matches[0]);
        }
        if (!rows.length || seen.size >= total) throw incomplete();
      }
      throw incomplete();
    } catch (error) {
      if (['knock_form_search_incomplete', 'knock_form_multiple_receipts', 'knock_form_mismatch'].includes(error.code)) throw error;
      throw unavailable();
    }
  };
  return read;
}
