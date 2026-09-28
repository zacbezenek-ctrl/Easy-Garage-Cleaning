import { readCookie, verifyCustomerPortalSessionToken } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';
import { availableInsuranceFileId, portalDocumentDrive, portalDocumentsDriveConfigured, portalDocumentsStorage } from '../_lib/customer-documents.js';
import { readJob } from '../_lib/firestore-job.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const UNAVAILABLE = 'Our current certificate of insurance is not available online right now. Call or text (970) 999-1818 and we will send it to you.';
const FILENAME = 'Easy-Garage-Cleaning-Certificate-of-Insurance.pdf';

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

// Only ?kind=insurance, optionally with view=status; no duplicate or unknown keys.
function query(request) {
  const params = new URL(request.url).searchParams, keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !['kind', 'view'].includes(key))) return null;
  if (params.get('kind') !== 'insurance' || params.has('view') && params.get('view') !== 'status') return null;
  return { kind: 'insurance', status: params.has('view') };
}

/**
 * GET /api/customer-portal-document?kind=insurance streams the current
 * certificate of insurance to any valid portal session (owner, collaborator or
 * business viewer, re-verified on every request). ?view=status answers only
 * whether it is available so the portal can offer the download or a call-us
 * fallback. Missing, expired, withdrawn or malformed certificates are a 404.
 */
export function customerPortalDocumentHandlers({ now = () => new Date(), read = readJob, storage = portalDocumentsStorage, drive = portalDocumentDrive } = {}) {
  return {
    async get({ request, env }) {
      if (!allowed(request)) return reply(403, { ok: false, code: 'CUSTOMER_PORTAL_ORIGIN_FORBIDDEN', error: 'Open your private project page to download documents.' });
      const wanted = query(request);
      if (!wanted) return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_DOCUMENT_INVALID', error: 'That document is not available.' });
      const at = now();
      try { await readCustomerPortalContext(env, await verifyCustomerPortalSessionToken(env, readCookie(request), at.getTime()), { read }); }
      catch (error) {
        if (/^CUSTOMER_PORTAL_[A-Z_]+$/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
        return reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Your project could not be loaded. Please try again shortly.' });
      }
      let fileId;
      try { fileId = availableInsuranceFileId(await storage(env).read(), at); }
      catch { return reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Documents could not be loaded. Please try again shortly.' }); }
      const available = Boolean(fileId) && portalDocumentsDriveConfigured(env);
      if (wanted.status) return reply(200, { ok: true, kind: 'insurance', available });
      if (!available) return reply(404, { ok: false, code: 'CUSTOMER_PORTAL_DOCUMENT_UNAVAILABLE', error: UNAVAILABLE });
      let file;
      try { file = await drive(env).download(fileId); }
      catch { return reply(503, { ok: false, code: 'CUSTOMER_PORTAL_DOCUMENT_TEMPORARILY_UNAVAILABLE', error: 'The certificate could not be opened right now. Please try again shortly.' }); }
      if (!file) return reply(404, { ok: false, code: 'CUSTOMER_PORTAL_DOCUMENT_UNAVAILABLE', error: UNAVAILABLE });
      return new Response(file.body, { status: 200, headers: {
        'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${FILENAME}"`,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
        ...(file.length ? { 'Content-Length': String(file.length) } : {}),
      } });
    },
  };
}

const handlers = customerPortalDocumentHandlers();
export const onRequestGet = handlers.get;
