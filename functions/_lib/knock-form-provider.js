// Only reads through the existing integration. Never upserts contacts, sends messages or changes workflows.
import { ghl } from './highlevel-tags.js';
import { knockFailure } from './knock-store.js';

const ID = /^[A-Za-z0-9_-]{1,180}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => knockFailure('GHL submission evidence is unavailable. Nothing has been marked submitted; check again later.', 424, 'knock_form_provider_unavailable');

export function nativeFormReader(integration, { fetcher = fetch } = {}) {
  // A bounded timeout and redirect refusal keep both reads on the allowlisted API host.
  const c = { ...integration, fetch: (url, options) => fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }) };
  return async ({ formId, contactId, submissionId, createdAt, expiresAt }) => {
    if (![formId, contactId, submissionId].every(id => typeof id === 'string' && ID.test(id))) throw unavailable();
    try {
      const params = new URLSearchParams({ locationId: c.locationId, formId, q: contactId, limit: '100', page: '1',
        startAt: createdAt.slice(0, 10), endAt: expiresAt.slice(0, 10) });
      const data = await ghl(c, `/forms/submissions?${params}`, { method: 'GET' });
      if (!object(data) || !Array.isArray(data.submissions) || data.submissions.length > 100) throw unavailable();
      // q is broad. Only the exact three IDs can select a receipt; names/emails are not a match.
      const candidates = data.submissions.filter(row => object(row) && row.id === submissionId && row.formId === formId && row.contactId === contactId);
      if (candidates.length !== 1) throw unavailable();
      const contactData = await ghl(c, `/contacts/${encodeURIComponent(contactId)}`, { method: 'GET' });
      const row = candidates[0], contact = contactData?.contact;
      if (!object(contact) || contact.id !== contactId || contact.locationId !== c.locationId ||
          row.locationId != null && row.locationId !== c.locationId || typeof row.createdAt !== 'string' || row.createdAt.length > 40 ||
          !Number.isFinite(Date.parse(row.createdAt)) || !object(row.others) || Object.keys(row.others).length > 100) throw unavailable();
      return { row, contact };
    } catch { throw unavailable(); }
  };
}
