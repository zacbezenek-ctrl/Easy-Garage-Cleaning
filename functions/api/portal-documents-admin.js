import { getHubSession } from '../_lib/hub-session.js';
import { INSURANCE_MAX_BYTES, portalDocumentDrive, portalDocumentsStatus, portalDocumentsStorage, requirePortalDocumentsManager, uploadInsuranceCertificate, withdrawInsuranceCertificate } from '../_lib/customer-documents.js';

// A 5 MB PDF is ~6.7 MB as base64 plus a small JSON envelope.
const LIMIT = Math.ceil(INSURANCE_MAX_BYTES / 3) * 4 + 16384;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = problem => problem?.code?.startsWith('PORTAL_DOCUMENTS_')
  ? reply(problem.status || 503, { ok: false, code: problem.code, error: problem.message })
  : reply(503, { ok: false, code: 'PORTAL_DOCUMENTS_UNAVAILABLE', error: 'Portal documents could not be verified. Keep this upload and retry it; do not start another.' });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
const forbidden = () => reply(403, { ok: false, code: 'PORTAL_DOCUMENTS_ORIGIN_FORBIDDEN', error: 'Open the EGC Hub before changing portal documents.' });

/**
 * Owner/manager administration of customer portal documents (P4-09).
 * GET: certificate status with the owner-facing expired/missing flag.
 * GET ?file=insurance: the stored certificate itself, for review.
 * POST {action:'upload', requestId, expectedRevision, expiresOn, filename, dataUrl}
 * POST {action:'withdraw', requestId, expectedRevision}
 * Nothing here sends anything to customers.
 */
export function portalDocumentsAdminHandlers({ session = getHubSession, storage = portalDocumentsStorage, drive = portalDocumentDrive, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request)) return forbidden();
      try {
        const actor = await session(request, env);
        requirePortalDocumentsManager(actor);
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (!keys.length) return reply(200, await portalDocumentsStatus(storage(env), actor, env, now()));
        if (keys.length !== 1 || keys[0] !== 'file' || params.get('file') !== 'insurance') return reply(400, { ok: false, code: 'PORTAL_DOCUMENTS_INVALID_REQUEST', error: 'Choose a portal document.' });
        const settings = await storage(env).read(), saved = settings?.insuranceCertificate;
        if (!saved?.driveFileId) return reply(404, { ok: false, code: 'PORTAL_DOCUMENTS_NOT_FOUND', error: 'No certificate has been uploaded.' });
        const file = await drive(env).download(saved.driveFileId);
        if (!file) return reply(404, { ok: false, code: 'PORTAL_DOCUMENTS_NOT_FOUND', error: 'The saved certificate is missing from Google Drive. Upload it again.' });
        const name = String(saved.filename || 'Certificate of insurance.pdf').replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 120) || 'Certificate of insurance.pdf';
        return new Response(file.body, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", ...(file.length ? { 'Content-Length': String(file.length) } : {}) } });
      } catch (problem) { return failure(problem); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return forbidden();
      try {
        const actor = await session(request, env);
        requirePortalDocumentsManager(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'PORTAL_DOCUMENTS_JSON_REQUIRED', error: 'Send the portal document request as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'PORTAL_DOCUMENTS_PDF_TOO_LARGE', error: 'The certificate PDF must be 5 MB or smaller.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'PORTAL_DOCUMENTS_PDF_TOO_LARGE', error: 'The certificate PDF must be 5 MB or smaller.' });
        let input;
        try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'PORTAL_DOCUMENTS_JSON_INVALID', error: 'The portal document request was incomplete.' }); }
        const at = now().toISOString();
        if (input?.action === 'upload') return reply(200, await uploadInsuranceCertificate({ store: storage(env), drive: drive(env) }, actor, input, at));
        if (input?.action === 'withdraw') return reply(200, await withdrawInsuranceCertificate(storage(env), actor, input, at));
        return reply(400, { ok: false, code: 'PORTAL_DOCUMENTS_INVALID_REQUEST', error: 'Choose upload or withdraw.' });
      } catch (problem) { return failure(problem); }
    },
  };
}

const handlers = portalDocumentsAdminHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
