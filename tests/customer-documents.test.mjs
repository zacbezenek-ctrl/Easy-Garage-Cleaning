import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { CUSTOMER_PORTAL_CONTENT, CUSTOMER_PORTAL_TERMS_VERSION, UNVERSIONED_PAGE_TERMS_VERSION, approvalTermsVersion, customerPortalDocuments } from '../functions/_lib/customer-portal-content.js';
import { INSURANCE_MAX_BYTES, createPortalDocumentDrive, decodeInsurancePdf, insuranceCertificateStatus } from '../functions/_lib/customer-documents.js';
import { customerPortalDocumentHandlers } from '../functions/api/customer-portal-document.js';
import { portalDocumentsAdminHandlers } from '../functions/api/portal-documents-admin.js';
import { onRequest as middleware } from '../functions/_middleware.js';
import { NOW, env as portalEnv, portalCookie, portalHandlers, portalPost, portalScript, portalStore, portalView } from './helpers/portal-fixture.mjs';

const origin = 'https://easygaragecleaning.com';
const CANARY = 'synthetic-drive-canary-0001';
const env = {
  ...portalEnv, HUB_SESSION_SECRET: 'synthetic-portal-documents-hub-secret', FIREBASE_API_KEY: 'firebase-test-portal-documents',
  GOOGLE_CLIENT_ID: 'synthetic-google-client', GOOGLE_CLIENT_SECRET: 'synthetic-google-secret', GOOGLE_REFRESH_TOKEN: 'synthetic-google-refresh',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', role: 'owner' }, TylerG: { passwordHash: 'synthetic-hash', role: 'manager' }, AlexK: { passwordHash: 'synthetic-hash', role: 'sales' }, FrankJara: { passwordHash: 'synthetic-hash', role: 'crew' } }),
};
const PDF = new TextEncoder().encode('%PDF-1.4\n% Synthetic certificate of insurance fixture only\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const dataUrl = (bytes = PDF, mime = 'application/pdf') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const job = (changes = {}) => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled', ...changes });
const certificate = (changes = {}) => ({ driveFileId: CANARY, expiresOn: '2027-03-01', uploadedAt: '2026-09-01T16:00:00.000Z', uploadedBy: 'zacb', filename: 'Synthetic COI.pdf', size: PDF.length, requestId: randomUUID(), fingerprint: 'synthetic', ...changes });

// Firestore REST emulation for jobs and portal_settings: versioned updateTime,
// :commit with updateMask and exists/updateTime preconditions (412 on
// mismatch). Any other host fails the test.
function firestore(t, { jobs = {}, settings = null } = {}) {
  const documents = new Map(), calls = [];
  let counter = 0, failCommit = null;
  const put = (path, data) => documents.set(path, { data: structuredClone(data), updateTime: `2026-09-22T12:00:00.${String(++counter).padStart(6, '0')}Z` });
  for (const [id, data] of Object.entries(jobs)) put(`jobs/${id}`, data);
  if (settings) put('portal_settings/documents', settings);
  const body = path => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(documents.get(path).data), updateTime: documents.get(path).updateTime });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    assert.equal(url.hostname, 'firestore.googleapis.com', `Unexpected external request to ${url.hostname}`);
    const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf('/documents') + '/documents'.length)).replace(/^\//, '');
    calls.push({ method, path });
    if (path === ':commit') {
      const writes = JSON.parse(options.body).writes;
      if (failCommit && failCommit(writes)) { failCommit = null; return Response.json({}, { status: 500 }); }
      for (const write of writes) {
        const key = write.update.name.split('/documents/')[1], existing = documents.get(key);
        if (write.currentDocument?.exists === false ? existing : write.currentDocument?.updateTime !== existing?.updateTime) return Response.json({}, { status: 412 });
        const patch = decodeFirestoreFields(write.update.fields), next = { ...(existing?.data || {}) };
        for (const field of write.updateMask.fieldPaths) next[field] = patch[field];
        put(key, next);
      }
      return Response.json({ commitTime: '2026-09-22T12:00:01Z' });
    }
    assert.equal(method, 'GET', `Unexpected Firestore ${method} ${path}`);
    return documents.has(path) ? Response.json(body(path)) : Response.json({}, { status: 404 });
  });
  return { documents, calls, settings: () => structuredClone(documents.get('portal_settings/documents')?.data ?? null), revision: () => documents.get('portal_settings/documents')?.updateTime || '', failNextCommit: predicate => { failCommit = predicate; } };
}

// Drive stand-in with the same contract as createPortalDocumentDrive(env).
function fakeDrive({ corrupt = false } = {}) {
  const files = new Map(), calls = [];
  let next = 0, failDownload = false, failUpload = false;
  const client = {
    async allocate() { calls.push('allocate'); return `synthetic-drive-file-${String(++next).padStart(4, '0')}`; },
    async metadata(id) { calls.push('metadata'); return files.has(id) ? structuredClone(files.get(id).meta) : null; },
    async upload(id, meta, bytes) {
      calls.push('upload');
      if (failUpload) throw Object.assign(new Error('synthetic lost upload'), { code: 'PORTAL_DOCUMENTS_UPLOAD_UNVERIFIED', status: 503 });
      if (!files.has(id)) files.set(id, { bytes: Uint8Array.from(bytes), meta: { id, size: String(bytes.length + (corrupt ? 1 : 0)), mimeType: 'application/pdf', trashed: false, appProperties: { egcPortalDocument: 'insurance_certificate', egcRequestId: meta.requestId, egcExpiresOn: meta.expiresOn } } });
    },
    async download(id) {
      calls.push('download');
      if (failDownload) throw Object.assign(new Error('synthetic drive outage'), { code: 'PORTAL_DOCUMENTS_DRIVE_UNAVAILABLE', status: 503 });
      return files.has(id) ? { body: new Blob([files.get(id).bytes]).stream(), length: files.get(id).bytes.length } : null;
    },
  };
  return { files, calls, drive: () => client, seed: (id, bytes = PDF) => files.set(id, { bytes, meta: {} }), failDownloads: () => { failDownload = true; }, failUploads: (on = true) => { failUpload = on; } };
}

const customerCookie = async (claims = {}, jobId = 'job-1') => `egc_customer_portal=${await createCustomerPortalSessionToken(portalEnv, jobId, Date.parse(NOW), { ...(claims.actorId ? {} : { linkVersion: 0 }), ...claims })}`;
const hubCookie = async user => (await createHubSessionCookie(env, user)).split(';')[0];
const customerHandlers = (drive, at = NOW) => customerPortalDocumentHandlers({ now: () => new Date(at), drive: drive.drive });
const adminHandlers = (drive, at = NOW) => portalDocumentsAdminHandlers({ now: () => new Date(at), drive: drive.drive });
const documentRequest = (cookie, query = '?kind=insurance', headers = {}) => new Request(`${origin}/api/customer-portal-document${query}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
const adminGet = (cookie, query = '') => new Request(`${origin}/api/portal-documents-admin${query}`, { headers: { ...(cookie ? { Cookie: cookie } : {}) } });
const adminPost = (cookie, body, headers = {}) => new Request(`${origin}/api/portal-documents-admin`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const upload = (changes = {}) => ({ action: 'upload', requestId: randomUUID(), expectedRevision: '', expiresOn: '2027-09-01', filename: 'Synthetic COI 2027.pdf', dataUrl: dataUrl(), ...changes });
const json = async response => ({ status: response.status, body: await response.json() });
const plainText = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&rsquo;/g, '’').replace(/\s+/g, ' ');

test('portal guarantee and terms are verbatim copies of the published website', () => {
  const read = name => plainText(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  const terms = read('terms-of-service.html'), home = read('index.html'), faq = read('faq.html');
  for (const section of CUSTOMER_PORTAL_CONTENT.terms.sections) {
    assert.ok(terms.includes(section.heading), `${section.heading} is not a published terms heading`);
    assert.ok(terms.includes(section.body), `${section.heading} differs from terms-of-service.html`);
  }
  assert.ok(terms.includes(`Last updated: ${CUSTOMER_PORTAL_CONTENT.terms.updated}`), 'the terms date matches the published page');
  assert.ok(home.includes(CUSTOMER_PORTAL_CONTENT.guarantee.title));
  assert.ok(home.includes(CUSTOMER_PORTAL_CONTENT.guarantee.sections[0].body), 'the quote guarantee differs from the home page');
  assert.ok(faq.includes(CUSTOMER_PORTAL_CONTENT.guarantee.sections[1].body), 'the satisfaction statement differs from the FAQ');
  assert.equal(CUSTOMER_PORTAL_CONTENT.estimateTerms, 'This flat-rate estimate covers the scope shown. The displayed deposit is due upfront after approval and is applied to your total. The remaining balance is due on completion. Any material change requires your approval before additional work or charges.');
  assert.ok(Object.isFrozen(CUSTOMER_PORTAL_CONTENT) && Object.isFrozen(CUSTOMER_PORTAL_CONTENT.terms.sections[0]));
});

test('changing any portal copy requires a new terms version', () => {
  // Approvals record CUSTOMER_PORTAL_TERMS_VERSION as the copy the customer saw.
  // If this fails, bump the version in customer-portal-content.js, then re-pin.
  const digest = createHash('sha256').update(JSON.stringify(CUSTOMER_PORTAL_CONTENT)).digest('hex');
  assert.deepEqual({ version: CUSTOMER_PORTAL_TERMS_VERSION, digest }, { version: '2026-09-portal', digest: '9e4cc7513cd038178a5ad22cb5e05f08dab6a737fc49c6d7f48a1de0566ae2c3' });
  const dto = customerPortalDocuments();
  assert.equal(dto.termsVersion, CUSTOMER_PORTAL_TERMS_VERSION);
  assert.doesNotMatch(JSON.stringify(dto), /"source"/, 'source notes stay server-side');
});

test('certificate status follows the Denver calendar and flags expired, expiring, missing and malformed records', () => {
  const settings = changes => ({ insuranceCertificate: certificate(changes) });
  assert.deepEqual([insuranceCertificateStatus(null, NOW).state, insuranceCertificateStatus(null, NOW).flag], ['missing', 'insurance_certificate_missing']);
  assert.equal(insuranceCertificateStatus({ insuranceCertificate: null }, NOW).state, 'missing');
  assert.equal(insuranceCertificateStatus(settings({ driveFileId: 'x' }), NOW).flag, 'insurance_certificate_invalid');
  assert.equal(insuranceCertificateStatus(settings({ expiresOn: '2027-02-30' }), NOW).state, 'invalid');
  const current = insuranceCertificateStatus(settings({ expiresOn: '2026-12-01' }), NOW);
  assert.deepEqual([current.state, current.available, current.flag, current.daysRemaining], ['current', true, '', 70]);
  const soon = insuranceCertificateStatus(settings({ expiresOn: '2026-10-22' }), NOW);
  assert.deepEqual([soon.state, soon.available, soon.flag, soon.daysRemaining], ['expiring_soon', true, 'insurance_certificate_expiring', 30]);
  // 11:30 PM Sept 29 in Denver is already Sept 30 in UTC: still valid for the last evening.
  assert.equal(insuranceCertificateStatus(settings({ expiresOn: '2026-09-30' }), '2026-09-30T05:30:00.000Z').state, 'expiring_soon');
  const lapsed = insuranceCertificateStatus(settings({ expiresOn: '2026-09-30' }), '2026-09-30T06:30:00.000Z');
  assert.deepEqual([lapsed.state, lapsed.available, lapsed.flag], ['expired', false, 'insurance_certificate_expired']);
  assert.equal(JSON.stringify(current).includes(CANARY), false, 'status never carries the Drive id');
});

test('the insurance download requires a valid portal session', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate() } }), drive = fakeDrive();
  drive.seed(CANARY);
  for (const cookie of ['', 'egc_customer_portal=forged.token', await customerCookie({}, 'missing-job')]) {
    const response = await json(await customerHandlers(drive).get({ env, request: documentRequest(cookie) }));
    assert.ok([401, 404].includes(response.status), `unexpected ${response.status}`);
    assert.equal(response.body.ok, false);
  }
  const anonymous = await json(await customerHandlers(drive).get({ env, request: documentRequest('') }));
  assert.deepEqual([anonymous.status, anonymous.body.code], [401, 'CUSTOMER_PORTAL_AUTH_REQUIRED']);
  const statusView = await json(await customerHandlers(drive).get({ env, request: documentRequest('', '?kind=insurance&view=status') }));
  assert.equal(statusView.status, 401);
  assert.equal(store.calls.filter(call => call.path.startsWith('portal_settings')).length, 0, 'settings are never read without a session');
  assert.deepEqual(drive.calls, []);
});

test('a valid session downloads the current certificate as a no-store attachment', async t => {
  firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate() } });
  const drive = fakeDrive(); drive.seed(CANARY);
  const response = await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie()) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="Easy-Garage-Cleaning-Certificate-of-Insurance.pdf"');
  assert.match(response.headers.get('Cache-Control'), /(^|[ ,])no-store($|,)/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Content-Length'), String(PDF.length));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PDF);
  const status = await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie(), '?kind=insurance&view=status') });
  const text = await status.text();
  assert.deepEqual(JSON.parse(text), { ok: true, kind: 'insurance', available: true });
  assert.equal(text.includes(CANARY), false);
});

test('collaborators download while active and lose access when removed', async t => {
  const person = { id: 'person-1', name: 'Synthetic Helper', email: 'helper@example.invalid', status: 'active', permissions: { view: true, decide: false, pay: false, rebook: false } };
  const store = firestore(t, { jobs: { 'job-1': job({ customerCollaborators: [person] }) }, settings: { insuranceCertificate: certificate() } });
  const drive = fakeDrive(); drive.seed(CANARY);
  const cookie = await customerCookie({ actorId: 'person-1', permissions: { view: true } });
  assert.equal((await customerHandlers(drive).get({ env, request: documentRequest(cookie) })).status, 200);
  store.documents.get('jobs/job-1').data.customerCollaborators = [{ ...person, status: 'removed' }];
  const revoked = await json(await customerHandlers(drive).get({ env, request: documentRequest(cookie) }));
  assert.deepEqual([revoked.status, revoked.body.code], [403, 'CUSTOMER_PORTAL_ACCESS_REVOKED']);
});

test('an expired certificate is a 404 for customers and an expired flag for the owner', async t => {
  firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate({ expiresOn: '2026-09-22' }) } });
  const drive = fakeDrive(); drive.seed(CANARY);
  const customer = await json(await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie()) }));
  assert.deepEqual([customer.status, customer.body.code], [404, 'CUSTOMER_PORTAL_DOCUMENT_UNAVAILABLE']);
  assert.match(customer.body.error, /\(970\) 999-1818/);
  assert.deepEqual(drive.calls, [], 'an expired certificate is never fetched from Drive');
  assert.equal((await json(await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie(), '?kind=insurance&view=status') }))).body.available, false);
  const owner = await json(await adminHandlers(drive).get({ env, request: adminGet(await hubCookie('ZacB')) }));
  assert.equal(owner.status, 200);
  assert.deepEqual([owner.body.flag, owner.body.insurance.state, owner.body.insurance.available, owner.body.insurance.expiresOn], ['insurance_certificate_expired', 'expired', false, '2026-09-22']);
  assert.equal(JSON.stringify(owner.body).includes(CANARY), false, 'the owner view never exposes the Drive id');
  // The day before, the same record is still downloadable but flagged as expiring.
  const earlier = '2026-09-21T18:00:00.000Z';
  const valid = await customerPortalDocumentHandlers({ now: () => new Date(earlier), drive: drive.drive }).get({ env, request: documentRequest(`egc_customer_portal=${await createCustomerPortalSessionToken(portalEnv, 'job-1', Date.parse(earlier), { linkVersion: 0 })}`) });
  assert.equal(valid.status, 200);
  assert.equal((await json(await adminHandlers(drive, earlier).get({ env, request: adminGet(await hubCookie('ZacB')) }))).body.flag, 'insurance_certificate_expiring');
});

test('missing certificates, missing Drive files and missing Drive setup are 404s; outages are 503s', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() } });
  const drive = fakeDrive(), cookie = await customerCookie();
  const missing = await json(await customerHandlers(drive).get({ env, request: documentRequest(cookie) }));
  assert.deepEqual([missing.status, missing.body.code], [404, 'CUSTOMER_PORTAL_DOCUMENT_UNAVAILABLE']);
  assert.equal((await json(await adminHandlers(drive).get({ env, request: adminGet(await hubCookie('TylerG')) }))).body.flag, 'insurance_certificate_missing');
  store.documents.set('portal_settings/documents', { data: { insuranceCertificate: certificate() }, updateTime: '2026-09-22T12:10:00.000000Z' });
  assert.equal((await customerHandlers(drive).get({ env, request: documentRequest(cookie) })).status, 404, 'a Drive file that disappeared is unavailable');
  const unconfigured = { ...env, GOOGLE_REFRESH_TOKEN: '' };
  assert.equal((await json(await customerHandlers(drive).get({ env: unconfigured, request: documentRequest(cookie, '?kind=insurance&view=status') }))).body.available, false);
  assert.equal((await customerHandlers(drive).get({ env: unconfigured, request: documentRequest(cookie) })).status, 404);
  drive.seed(CANARY); drive.failDownloads();
  const outage = await json(await customerHandlers(drive).get({ env, request: documentRequest(cookie) }));
  assert.deepEqual([outage.status, outage.body.code], [503, 'CUSTOMER_PORTAL_DOCUMENT_TEMPORARILY_UNAVAILABLE']);
  const broken = await json(await customerPortalDocumentHandlers({ now: () => new Date(NOW), drive: drive.drive, storage: () => ({ read: async () => { throw Object.assign(new Error('down'), { code: 'PORTAL_DOCUMENTS_STORAGE_UNAVAILABLE', status: 503 }); } }) }).get({ env, request: documentRequest(cookie) }));
  assert.deepEqual([broken.status, broken.body.code], [503, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE']);
});

test('the document endpoint rejects unknown documents, ambiguous queries and cross-site requests', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate() } });
  const drive = fakeDrive(), cookie = await customerCookie();
  for (const query of ['', '?kind=terms', '?kind=insurance&kind=insurance', '?kind=insurance&view=raw', '?kind=insurance&fileId=x']) {
    const response = await json(await customerHandlers(drive).get({ env, request: documentRequest(cookie, query) }));
    assert.deepEqual([response.status, response.body.code], [400, 'CUSTOMER_PORTAL_DOCUMENT_INVALID'], query);
  }
  assert.equal((await customerHandlers(drive).get({ env, request: documentRequest(cookie, '?kind=insurance', { 'Sec-Fetch-Site': 'cross-site' }) })).status, 403);
  assert.equal((await customerHandlers(drive).get({ env, request: documentRequest(cookie, '?kind=insurance', { Origin: 'https://attacker.example' }) })).status, 403);
  assert.equal(store.calls.length, 0);
  assert.deepEqual(drive.calls, []);
});

test('admin upload requires an owner or manager Hub session', async t => {
  const store = firestore(t), drive = fakeDrive(), handlers = adminHandlers(drive);
  for (const request of [adminGet(''), adminPost('', upload())]) {
    const response = await json(await (request.method === 'GET' ? handlers.get : handlers.post)({ env, request }));
    assert.deepEqual([response.status, response.body.code], [401, 'PORTAL_DOCUMENTS_SIGN_IN_REQUIRED']);
  }
  assert.equal((await handlers.post({ env, request: adminPost(await customerCookie(), upload()) })).status, 401, 'a customer portal cookie is not a Hub session');
  for (const user of ['FrankJara', 'AlexK']) {
    const response = await json(await handlers.post({ env, request: adminPost(await hubCookie(user), upload()) }));
    assert.deepEqual([response.status, response.body.code], [403, 'PORTAL_DOCUMENTS_FORBIDDEN'], user);
    assert.equal((await handlers.get({ env, request: adminGet(await hubCookie(user)) })).status, 403);
  }
  assert.equal(store.calls.length, 0);
  assert.deepEqual(drive.calls, []);
});

test('admin upload accepts only complete PDFs within the size cap over same-origin JSON', async t => {
  const store = firestore(t), drive = fakeDrive(), cookie = await hubCookie('ZacB'), handlers = adminHandlers(drive);
  const expectations = [
    [upload({ dataUrl: dataUrl(new TextEncoder().encode('Synthetic plain text, not a PDF'), 'text/plain') }), 415, 'PORTAL_DOCUMENTS_PDF_REQUIRED'],
    [upload({ dataUrl: dataUrl(new TextEncoder().encode('<html>Synthetic page pretending to be a PDF, padded to pass the length check.</html>')) }), 415, 'PORTAL_DOCUMENTS_PDF_INVALID'],
    [upload({ dataUrl: dataUrl(PDF.slice(0, PDF.length - 7)) }), 415, 'PORTAL_DOCUMENTS_PDF_INVALID'],
    [upload({ dataUrl: dataUrl(new Uint8Array(INSURANCE_MAX_BYTES + 1)) }), 413, 'PORTAL_DOCUMENTS_PDF_TOO_LARGE'],
    [upload({ expiresOn: '2026-09-22' }), 400, 'PORTAL_DOCUMENTS_EXPIRATION_INVALID'],
    [upload({ expiresOn: '2031-01-01' }), 400, 'PORTAL_DOCUMENTS_EXPIRATION_INVALID'],
    [upload({ requestId: 'not-a-uuid' }), 400, 'PORTAL_DOCUMENTS_INVALID_REQUEST'],
    [upload({ driveFileId: CANARY }), 400, 'PORTAL_DOCUMENTS_INVALID_REQUEST'],
  ];
  for (const [body, status, code] of expectations) {
    const response = await json(await handlers.post({ env, request: adminPost(cookie, body) }));
    assert.deepEqual([response.status, response.body.code], [status, code], code);
  }
  assert.equal((await handlers.post({ env, request: adminPost(cookie, upload(), { 'Content-Type': 'text/plain' }) })).status, 415);
  assert.equal((await handlers.post({ env, request: adminPost(cookie, upload(), { Origin: 'https://attacker.example' }) })).status, 403);
  assert.equal((await handlers.post({ env, request: adminPost(cookie, upload(), { 'Sec-Fetch-Site': 'cross-site' }) })).status, 403);
  assert.equal((await handlers.post({ env, request: adminPost(cookie, upload(), { 'Content-Length': String(9 * 1024 * 1024) }) })).status, 413);
  assert.equal((await handlers.post({ env, request: adminPost(cookie, '{"action":') })).status, 400);
  assert.equal(store.calls.filter(call => call.path === ':commit').length, 0, 'nothing is stored');
  assert.deepEqual(drive.calls.filter(call => call !== 'metadata'), [], 'nothing reaches Drive');
});

test('an owner upload is stored privately, downloadable, idempotent and revision-checked', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() } }), drive = fakeDrive(), cookie = await hubCookie('ZacB'), handlers = adminHandlers(drive);
  const body = upload();
  const saved = await json(await handlers.post({ env, request: adminPost(cookie, body) }));
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.insurance.state, saved.body.insurance.expiresOn, saved.body.insurance.uploadedBy, saved.body.flag], ['current', '2027-09-01', 'zacb', '']);
  const record = store.settings();
  assert.equal(record.insuranceCertificate.expiresOn, '2027-09-01');
  assert.equal(record.insuranceCertificate.uploadedAt, NOW);
  assert.equal(record.insuranceCertificate.requestId, body.requestId);
  assert.equal(record.insuranceCertificate.size, PDF.length);
  assert.equal(record.insuranceCertificate.sha256, createHash('sha256').update(PDF).digest('hex'));
  assert.equal(record.pendingInsuranceUpload, null);
  assert.equal(JSON.stringify(saved.body).includes(record.insuranceCertificate.driveFileId), false, 'the Drive id stays server-side');
  assert.deepEqual(drive.calls.filter(call => call !== 'metadata'), ['allocate', 'upload']);
  assert.equal(drive.files.get(record.insuranceCertificate.driveFileId).meta.appProperties.egcRequestId, body.requestId);
  const download = await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie()) });
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), PDF);

  const replay = await json(await handlers.post({ env, request: adminPost(cookie, body) }));
  assert.deepEqual([replay.status, replay.body.replayed], [200, true]);
  assert.deepEqual(drive.calls.filter(call => call !== 'metadata' && call !== 'download'), ['allocate', 'upload'], 'a replay never uploads again');
  const conflict = await json(await handlers.post({ env, request: adminPost(cookie, { ...body, expiresOn: '2027-10-01' }) }));
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'PORTAL_DOCUMENTS_IDEMPOTENCY_CONFLICT']);
  const stale = await json(await handlers.post({ env, request: adminPost(await hubCookie('TylerG'), upload({ expectedRevision: '' })) }));
  assert.deepEqual([stale.status, stale.body.code], [409, 'PORTAL_DOCUMENTS_REVISION_CONFLICT']);
  assert.equal(store.settings().insuranceCertificate.requestId, body.requestId, 'a stale upload changes nothing');

  const renewal = await json(await handlers.post({ env, request: adminPost(await hubCookie('TylerG'), upload({ expectedRevision: store.revision(), expiresOn: '2028-09-01' })) }));
  assert.equal(renewal.status, 200);
  assert.equal(store.settings().insuranceCertificate.uploadedBy, 'tylerg');
  assert.deepEqual(store.settings().insuranceCertificateHistory.map(item => [item.expiresOn, item.replacedAt]), [['2027-09-01', NOW]]);
  assert.equal(renewal.body.history[0].expiresOn, '2027-09-01');
});

test('a lost final save resumes with the same Drive file instead of uploading twice', async t => {
  const store = firestore(t), drive = fakeDrive(), cookie = await hubCookie('ZacB'), handlers = adminHandlers(drive), body = upload();
  store.failNextCommit(writes => writes.some(write => write.updateMask.fieldPaths.includes('insuranceCertificate')));
  const lost = await json(await handlers.post({ env, request: adminPost(cookie, body) }));
  assert.deepEqual([lost.status, lost.body.code], [503, 'PORTAL_DOCUMENTS_OUTCOME_UNKNOWN']);
  assert.equal(store.settings().pendingInsuranceUpload.requestId, body.requestId);
  assert.equal(store.settings().insuranceCertificate, undefined);
  const retried = await json(await handlers.post({ env, request: adminPost(cookie, body) }));
  assert.equal(retried.status, 200);
  assert.deepEqual(drive.calls.filter(call => call !== 'metadata'), ['allocate', 'upload'], 'one Drive id, one upload');
  assert.equal(store.settings().insuranceCertificate.driveFileId, 'synthetic-drive-file-0001');
  assert.equal(store.settings().pendingInsuranceUpload, null);
});

test('an upload Drive cannot verify is never offered to customers', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() } }), drive = fakeDrive({ corrupt: true });
  const response = await json(await adminHandlers(drive).post({ env, request: adminPost(await hubCookie('ZacB'), upload()) }));
  assert.deepEqual([response.status, response.body.code], [503, 'PORTAL_DOCUMENTS_UPLOAD_UNVERIFIED']);
  assert.equal(store.settings().insuranceCertificate, undefined);
  assert.equal((await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie()) })).status, 404);
});

test('withdrawing a certificate stops customer downloads and keeps an audit entry', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate() } }), drive = fakeDrive(); drive.seed(CANARY);
  const cookie = await hubCookie('ZacB'), handlers = adminHandlers(drive), requestId = randomUUID();
  const withdrawn = await json(await handlers.post({ env, request: adminPost(cookie, { action: 'withdraw', requestId, expectedRevision: store.revision() }) }));
  assert.deepEqual([withdrawn.status, withdrawn.body.insurance.state, withdrawn.body.flag], [200, 'missing', 'insurance_certificate_missing']);
  assert.equal(store.settings().insuranceCertificate, null);
  assert.deepEqual([store.settings().insuranceCertificateHistory[0].withdrawnBy, store.settings().insuranceCertificateHistory[0].withdrawnAt], ['zacb', NOW]);
  assert.equal((await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie()) })).status, 404);
  const replay = await json(await handlers.post({ env, request: adminPost(cookie, { action: 'withdraw', requestId, expectedRevision: 'stale' }) }));
  assert.deepEqual([replay.status, replay.body.replayed], [200, true]);
  const nothing = await json(await handlers.post({ env, request: adminPost(cookie, { action: 'withdraw', requestId: randomUUID(), expectedRevision: store.revision() }) }));
  assert.deepEqual([nothing.status, nothing.body.code], [409, 'PORTAL_DOCUMENTS_NOTHING_TO_WITHDRAW']);
});

test('a withdrawal cancels an unfinished upload so retrying it cannot re-offer the certificate', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate() } }), drive = fakeDrive(); drive.seed(CANARY);
  const handlers = adminHandlers(drive), manager = await hubCookie('TylerG'), owner = await hubCookie('ZacB'), body = upload({ expectedRevision: store.revision() });
  drive.failUploads();
  const lost = await json(await handlers.post({ env, request: adminPost(manager, body) }));
  assert.deepEqual([lost.status, lost.body.code], [503, 'PORTAL_DOCUMENTS_UPLOAD_UNVERIFIED']);
  const status = await json(await handlers.get({ env, request: adminGet(owner) }));
  assert.deepEqual([status.body.insurance.state, status.body.pendingUpload], ['current', { startedAt: NOW, by: 'tylerg' }], 'the owner can see the unfinished upload');
  assert.equal(JSON.stringify(status.body).includes('synthetic-drive-file-0001'), false, 'the pending Drive id stays server-side');
  const withdrawn = await json(await handlers.post({ env, request: adminPost(owner, { action: 'withdraw', requestId: randomUUID(), expectedRevision: status.body.revision }) }));
  assert.deepEqual([withdrawn.status, withdrawn.body.insurance.state, withdrawn.body.pendingUpload], [200, 'missing', null]);
  assert.equal(store.settings().pendingInsuranceUpload, null);
  drive.failUploads(false);
  const retried = await json(await handlers.post({ env, request: adminPost(manager, body) }));
  assert.deepEqual([retried.status, retried.body.code], [409, 'PORTAL_DOCUMENTS_REVISION_CONFLICT'], 'the retry must be reviewed against the withdrawal');
  assert.equal(store.settings().insuranceCertificate, null);
  assert.equal((await customerHandlers(drive).get({ env, request: documentRequest(await customerCookie()) })).status, 404, 'customers still cannot download it');
  assert.equal(drive.calls.filter(call => call === 'upload').length, 1, 'the stale retry never reaches Drive');
});

test('the Hub reports a saved certificate as unavailable while Google Drive is disconnected', async t => {
  const store = firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate() } }), drive = fakeDrive(); drive.seed(CANARY);
  const unconfigured = { ...env, GOOGLE_REFRESH_TOKEN: '' }, owner = await hubCookie('ZacB');
  const hub = async target => (await json(await adminHandlers(drive).get({ env: target, request: adminGet(owner) }))).body;
  const off = await hub(unconfigured);
  assert.deepEqual([off.insurance.state, off.insurance.available, off.flag, off.driveConfigured, off.insurance.expiresOn], ['unavailable', false, 'insurance_certificate_drive_unconfigured', false, '2027-03-01']);
  assert.equal((await json(await customerHandlers(drive).get({ env: unconfigured, request: documentRequest(await customerCookie(), '?kind=insurance&view=status') }))).body.available, false, 'customers are refused too');
  const on = await hub(env);
  assert.deepEqual([on.insurance.state, on.insurance.available, on.flag, on.driveConfigured], ['current', true, '', true]);
  store.documents.set('portal_settings/documents', { data: { insuranceCertificate: certificate({ expiresOn: '2026-09-01' }) }, updateTime: '2026-09-22T12:10:00.000000Z' });
  assert.deepEqual([(await hub(unconfigured)).insurance.state, (await hub(unconfigured)).flag], ['expired', 'insurance_certificate_expired'], 'a lapsed certificate keeps its own flag');
  store.documents.delete('portal_settings/documents');
  assert.equal((await hub(unconfigured)).flag, 'insurance_certificate_missing');
  assert.deepEqual(drive.calls, [], 'status never calls Drive');
});

test('the edge middleware keeps the sandboxed PDF headers on both certificate downloads', async t => {
  firestore(t, { jobs: { 'job-1': job() }, settings: { insuranceCertificate: certificate() } });
  const drive = fakeDrive(); drive.seed(CANARY);
  const routes = [[documentRequest(await customerCookie()), customerHandlers(drive).get], [adminGet(await hubCookie('ZacB'), '?file=insurance'), adminHandlers(drive).get]];
  for (const [request, handler] of routes) {
    const response = await middleware({ request, env, next: () => handler({ env, request }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox", request.url);
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(response.headers.get('Content-Type'), 'application/pdf');
    assert.match(response.headers.get('Content-Disposition'), /^attachment; filename="[^"]+\.pdf"$/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PDF);
  }
  const statusRequest = documentRequest(await customerCookie(), '?kind=insurance&view=status');
  const status = await middleware({ request: statusRequest, env, next: () => customerHandlers(drive).get({ env, request: statusRequest }) });
  assert.match(status.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/, 'JSON answers keep the site policy');
  assert.equal(status.headers.get('Referrer-Policy'), 'no-referrer');
  const other = await middleware({ request: new Request(`${origin}/api/customer-portal`), env, next: async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Security-Policy': "default-src 'none'; sandbox" } }) });
  assert.match(other.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/, 'other endpoints cannot opt out of the site policy');
});

test('owners can review the saved PDF as a no-store attachment', async t => {
  firestore(t, { settings: { insuranceCertificate: certificate({ expiresOn: '2026-01-01', filename: 'Synthetic "COI".pdf' }) } });
  const drive = fakeDrive(); drive.seed(CANARY);
  const response = await adminHandlers(drive).get({ env, request: adminGet(await hubCookie('ZacB'), '?file=insurance') });
  assert.equal(response.status, 200, 'owners can review even an expired certificate');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="Synthetic -COI-.pdf"');
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PDF);
  assert.equal((await adminHandlers(drive).get({ env, request: adminGet(await hubCookie('ZacB'), '?file=other') })).status, 400);
});

test('decodeInsurancePdf checks the data URL, magic bytes, trailer and size', () => {
  assert.deepEqual(decodeInsurancePdf(dataUrl()), PDF);
  for (const bad of [null, '', 'data:application/pdf;base64,', `data:image/png;base64,${Buffer.from(PDF).toString('base64')}`, dataUrl(new TextEncoder().encode('%PDF-1.4 but it never ends '.repeat(4)))]) assert.throws(() => decodeInsurancePdf(bad), error => /^PORTAL_DOCUMENTS_PDF_/.test(error.code));
  assert.throws(() => decodeInsurancePdf(`data:application/pdf;base64,${'A'.repeat(Math.ceil(INSURANCE_MAX_BYTES / 3) * 4 + 4)}`), error => error.code === 'PORTAL_DOCUMENTS_PDF_TOO_LARGE' && error.status === 413);
});

test('the Drive client caches its token, streams only PDFs and uploads with app properties', async () => {
  const calls = [];
  let clock = Date.parse(NOW), contentType = 'application/pdf', folderExists = false;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.ok(['oauth2.googleapis.com', 'www.googleapis.com'].includes(url.hostname), `Unexpected host ${url.hostname}`);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: `synthetic-access-${calls.length}`, expires_in: 3600 });
    assert.equal(init.redirect, 'error');
    assert.match(init.headers.Authorization, /^Bearer synthetic-access-/);
    if (url.pathname.endsWith('/files/generateIds')) return Response.json({ ids: ['synthetic-drive-file-0009'] });
    if (url.pathname === '/drive/v3/files' && (init.method || 'GET') === 'GET') return Response.json({ files: folderExists ? [{ id: 'synthetic-folder-0001' }] : [] });
    if (url.pathname === '/drive/v3/files' && init.method === 'POST') { folderExists = true; return Response.json({ id: 'synthetic-folder-0001' }); }
    if (url.pathname.startsWith('/upload/drive/v3/files')) return calls.filter(call => call.url.pathname.startsWith('/upload')).length > 1 ? Response.json({}, { status: 409 }) : Response.json({ id: 'synthetic-drive-file-0009' });
    if (url.searchParams.get('alt') === 'media') return url.pathname.endsWith('/missing-file-0001') ? new Response('', { status: 404 }) : new Response(PDF, { headers: { 'Content-Type': contentType, 'Content-Length': String(PDF.length) } });
    throw new Error(`Unexpected Drive request ${url.pathname}`);
  };
  const drive = createPortalDocumentDrive({ fetcher, now: () => clock })(env);
  const file = await drive.download('synthetic-drive-file-0009');
  assert.deepEqual(new Uint8Array(await new Response(file.body).arrayBuffer()), PDF);
  assert.equal(file.length, PDF.length);
  assert.equal(await drive.download('missing-file-0001'), null);
  assert.equal(calls.filter(call => call.url.hostname === 'oauth2.googleapis.com').length, 1, 'the access token is reused');
  clock += 3600 * 1000;
  await drive.download('synthetic-drive-file-0009');
  assert.equal(calls.filter(call => call.url.hostname === 'oauth2.googleapis.com').length, 2, 'an expired token is refreshed with the injected clock');
  contentType = 'text/html';
  await assert.rejects(drive.download('synthetic-drive-file-0009'), error => error.code === 'PORTAL_DOCUMENTS_DRIVE_UNAVAILABLE');
  assert.equal(await drive.allocate(), 'synthetic-drive-file-0009');
  await drive.upload('synthetic-drive-file-0009', { requestId: 'synthetic-request', expiresOn: '2027-09-01', filename: 'Synthetic.pdf' }, PDF);
  await drive.upload('synthetic-drive-file-0009', { requestId: 'synthetic-request', expiresOn: '2027-09-01', filename: 'Synthetic.pdf' }, PDF);
  const sent = new TextDecoder().decode(calls.find(call => call.url.pathname.startsWith('/upload')).init.body);
  const metadata = JSON.parse(sent.split('\r\n\r\n')[1].split('\r\n')[0]);
  assert.deepEqual(metadata, { id: 'synthetic-drive-file-0009', name: 'Synthetic.pdf', mimeType: 'application/pdf', parents: ['synthetic-folder-0001'], appProperties: { egcPortalDocument: 'insurance_certificate', egcRequestId: 'synthetic-request', egcExpiresOn: '2027-09-01' } });
  assert.ok(sent.includes('%PDF-1.4'));
  assert.throws(() => createPortalDocumentDrive({ fetcher })({ ...env, GOOGLE_CLIENT_SECRET: '' }), error => error.code === 'PORTAL_DOCUMENTS_DRIVE_UNCONFIGURED');
});

// P2-05: portal approvals name the revision, amount and fingerprint of the estimate
// the page displayed; these tests read it as the page would before approving.
async function bound(cookie, body) {
  const shown = (await portalView(portalHandlers(), cookie)).body.estimate;
  return { ...body, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint };
}

test('the portal returns versioned documents and approval records the terms version shown', async t => {
  const f = portalStore(t, { 'job-1': job({ estimate: { number: 'EST-1', status: 'sent', amount: 800, termsVersion: '2026-09' } }) });
  const cookie = await portalCookie();
  const view = await portalView(portalHandlers(), cookie);
  assert.equal(view.body.estimate.terms, CUSTOMER_PORTAL_CONTENT.estimateTerms);
  assert.equal(view.body.estimate.termsVersion, CUSTOMER_PORTAL_TERMS_VERSION);
  assert.deepEqual(view.body.documents, customerPortalDocuments());
  assert.equal(view.body.documents.insurance.url, '/api/customer-portal-document?kind=insurance');
  const approved = await portalPost(portalHandlers(), cookie, await bound(cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, terms_version: view.body.estimate.termsVersion }));
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approval.termsVersion, CUSTOMER_PORTAL_TERMS_VERSION);
  assert.equal(f.job('job-1').customerApproval.termsVersion, CUSTOMER_PORTAL_TERMS_VERSION);
  assert.equal(f.job('job-1').estimate.acceptedTermsVersion, CUSTOMER_PORTAL_TERMS_VERSION);
  assert.equal(f.job('job-1').estimate.termsVersion, '2026-09', 'the Hub document terms version is left alone');
});

test('approval with terms the page no longer shows is refused without a write', async t => {
  const f = portalStore(t, { 'job-1': job({ estimate: { number: 'EST-1', status: 'sent', amount: 800 } }) });
  const cookie = await portalCookie(), writes = f.writes.length;
  for (const terms_version of ['2025-01-portal', '', null]) {
    const stale = await portalPost(portalHandlers(), cookie, await bound(cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, terms_version }));
    assert.deepEqual([stale.status, stale.body.code], [409, 'CUSTOMER_PORTAL_TERMS_CHANGED']);
  }
  assert.equal(f.writes.length, writes);
  assert.equal(f.job('job-1').customerApproval, undefined);
  // A page from before versioning showed the same estimate terms line, but not
  // the guarantee or service terms, so it is recorded as exactly that.
  const legacy = await portalPost(portalHandlers(), cookie, await bound(cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true }));
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.approval.termsVersion, UNVERSIONED_PAGE_TERMS_VERSION);
  assert.equal(f.job('job-1').customerApproval.termsVersion, '2026-09-estimate-terms-unversioned');
  assert.equal(f.job('job-1').estimate.acceptedTermsVersion, '2026-09-estimate-terms-unversioned');
  assert.notEqual(UNVERSIONED_PAGE_TERMS_VERSION, CUSTOMER_PORTAL_TERMS_VERSION, 'never recorded as the full guarantee and terms bundle');
});

test('pages from before versioning are accepted only while their estimate terms are still current', () => {
  assert.equal(approvalTermsVersion(CUSTOMER_PORTAL_TERMS_VERSION), CUSTOMER_PORTAL_TERMS_VERSION);
  assert.equal(approvalTermsVersion(undefined), UNVERSIONED_PAGE_TERMS_VERSION, 'the pre-versioning page showed only this version\'s estimate terms');
  assert.equal(approvalTermsVersion(UNVERSIONED_PAGE_TERMS_VERSION), '', 'the marker is recorded, never accepted from a page');
  for (const sent of ['', null, 0, ['2026-09-portal'], '2026-09-deposit50', ' 2026-09-portal']) assert.equal(approvalTermsVersion(sent), '', JSON.stringify(sent));
  // After the copy changes, a stale unversioned page must reload instead of approving unseen terms.
  assert.equal(approvalTermsVersion(undefined, '2027-01-portal'), '');
  assert.equal(approvalTermsVersion(CUSTOMER_PORTAL_TERMS_VERSION, '2027-01-portal'), '');
  assert.equal(approvalTermsVersion('2027-01-portal', '2027-01-portal'), '2027-01-portal');
});

test('a stale page is refused before any write even when the rest of the approval is valid', async t => {
  const f = portalStore(t, { 'job-1': job({ estimate: { number: 'EST-1', status: 'sent', amount: 800 } }) });
  const cookie = await portalCookie();
  const refused = await portalPost(portalHandlers(), cookie, await bound(cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, terms_version: '2026-09-deposit50' }));
  assert.deepEqual([refused.status, refused.body.code, f.writes.length], [409, 'CUSTOMER_PORTAL_TERMS_CHANGED', 0], 'the walkthrough terms version is not the portal copy');
  const approved = await portalPost(portalHandlers(), cookie, await bound(cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, terms_version: CUSTOMER_PORTAL_TERMS_VERSION }));
  assert.equal(approved.status, 200);
  assert.deepEqual(f.writes.map(write => write.fields.includes('customerApproval')), [true]);
  assert.equal(f.job('job-1').customerApproval.termsVersion, CUSTOMER_PORTAL_TERMS_VERSION);
});

const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
function portalPage(fetchImpl) {
  const nodes = new Map(), created = [];
  const element = (tag = 'div', id = '') => {
    const classes = new Set(), node = {
      tag, id, textContent: '', dataset: {}, children: [], attributes: new Map(), listeners: {}, href: '', className: '',
      classList: { toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; }, add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      append(...items) { node.children.push(...items); }, replaceChildren(...items) { node.children = items; }, after(item) { node.nextSibling = item; nodes.set(item.id, item); },
      setAttribute: (name, value) => node.attributes.set(name, String(value)), getAttribute: name => node.attributes.get(name) ?? null, removeAttribute: name => node.attributes.delete(name),
      addEventListener: (event, handler) => { node.listeners[event] = handler; },
    };
    return node;
  };
  // Like getElementById: the version note exists only once the page inserts it.
  const $ = id => { if (!nodes.has(id) && id !== 'estimate-terms-version') nodes.set(id, element('div', id)); return nodes.get(id) ?? null; };
  $('insurance-download').href = '/api/customer-portal-document?kind=insurance';
  $('insurance-download').setAttribute('download', 'Easy-Garage-Cleaning-Certificate-of-Insurance.pdf');
  const toasts = [];
  const context = {
    $, setText: (id, value) => { $(id).textContent = value; }, toast: (message, bad) => toasts.push([message, bad]), fetch: fetchImpl, Error,
    dateLabel: value => `label:${value}`, portalData: null, showError: () => {}, URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => {} }, setTimeout: () => 0,
    document: { createElement: tag => { const node = element(tag); node.click = () => created.push(node); node.remove = () => {}; return node; }, body: { append: () => {} } },
  };
  context.make = (tag, className, text) => { const node = element(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  vm.runInNewContext([portalScript(html, ['function documentSection(', 'function insuranceState(', 'async function checkInsurance(', 'function renderDocuments(', 'function portalError(']), portalScript(html, ["$('insurance-download').addEventListener('click',"])].join('\n'), context);
  return { $, context, toasts, created };
}

test('the portal documents card renders copy as text and offers the certificate only when available', async () => {
  const requests = [];
  const page = portalPage(async url => { requests.push(url); return { ok: true, json: async () => ({ ok: true, kind: 'insurance', available: true }) }; });
  const data = { estimate: { termsVersion: CUSTOMER_PORTAL_TERMS_VERSION }, documents: { ...customerPortalDocuments(), guarantee: { title: 'No-Surprise Quote Guarantee', sections: [{ heading: '<img src=x onerror=alert(1)>', body: 'Synthetic body' }] } } };
  page.context.renderDocuments(data);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.$('documents-card').classList.contains('hidden'), false);
  assert.equal(page.$('guarantee-title').textContent, 'No-Surprise Quote Guarantee');
  assert.equal(page.$('guarantee-body').children[0].children[0].textContent, '<img src=x onerror=alert(1)>', 'copy is text, never markup');
  assert.equal(page.$('terms-body').children.length, CUSTOMER_PORTAL_CONTENT.terms.sections.length);
  assert.equal(page.$('documents-version').textContent, `Terms version ${CUSTOMER_PORTAL_TERMS_VERSION}`);
  assert.equal(page.$('estimate-terms').nextSibling, page.$('estimate-terms-version'));
  assert.equal(page.$('estimate-terms-version').children[0], `Terms version ${CUSTOMER_PORTAL_TERMS_VERSION}. `);
  assert.equal(page.$('estimate-terms-version').children[1].href, '#documents-card');
  assert.deepEqual(requests, ['/api/customer-portal-document?kind=insurance&view=status']);
  assert.equal(page.$('insurance-download').classList.contains('hidden'), false);
  assert.equal(page.$('insurance-ask').classList.contains('hidden'), true);
  assert.equal(page.$('insurance-skeleton').classList.contains('hidden'), true);
  page.context.renderDocuments(data);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1, 'quiet refreshes do not re-check a verified answer');

  const failing = portalPage(async () => ({ ok: false, json: async () => ({ ok: false }) }));
  failing.context.renderDocuments(data);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failing.$('insurance-download').classList.contains('hidden'), true);
  assert.equal(failing.$('insurance-ask').classList.contains('hidden'), false);
  assert.match(failing.$('insurance-state').textContent, /Text or call us/);
  const hidden = portalPage(async () => assert.fail('no documents, no request'));
  hidden.context.renderDocuments({ estimate: {} });
  assert.equal(hidden.$('documents-card').classList.contains('hidden'), true);
});

test('the download button saves the PDF and falls back to the call-us state on a 404', async () => {
  let response = { ok: true, headers: { get: () => 'application/pdf' }, blob: async () => 'synthetic-blob' };
  const page = portalPage(async () => response);
  const link = page.$('insurance-download');
  await link.listeners.click({ preventDefault() {}, currentTarget: link });
  assert.equal(page.created.length, 1);
  assert.equal(page.created[0].download, 'Easy-Garage-Cleaning-Certificate-of-Insurance.pdf');
  assert.equal(link.textContent, '', 'the label is restored');
  response = { ok: false, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, code: 'CUSTOMER_PORTAL_DOCUMENT_UNAVAILABLE', error: 'Synthetic unavailable message' }) };
  await link.listeners.click({ preventDefault() {}, currentTarget: link });
  assert.deepEqual(page.toasts.at(-1), ['Synthetic unavailable message', true]);
  assert.equal(page.$('insurance-ask').classList.contains('hidden'), false);
  assert.equal(link.getAttribute('aria-busy'), null);
});

test('the approve button sends the displayed terms version and reloads on a terms change', async () => {
  const bodies = [], loads = [];
  const button = { disabled: false, textContent: 'Approve estimate', addEventListener: (event, handler) => { button.handler = handler; } };
  const context = {
    // P2-05: the page also binds the approval to the estimate it displayed.
    portalData: { estimate: { termsVersion: CUSTOMER_PORTAL_TERMS_VERSION, revision: 2, amount: 800, fingerprint: 'synthetic-fingerprint' } }, Error,
    $: id => ({ 'approve-button': button, 'approval-name': { value: ' Synthetic Customer ' }, 'approval-confirm': { checked: true }, 'pay-button': { classList: { contains: () => true } } })[id],
    toast: () => {}, showError: () => {}, load: async quiet => loads.push(quiet),
    fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: false, json: async () => ({ ok: false, code: 'CUSTOMER_PORTAL_TERMS_CHANGED', error: 'Terms changed' }) }; },
  };
  vm.runInNewContext(portalScript(html, ['function portalError(', 'async function api(', "$('approve-button').addEventListener('click',"]), context);
  await button.handler();
  assert.deepEqual(bodies, [{ action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, terms_version: CUSTOMER_PORTAL_TERMS_VERSION, estimate_revision: 2, amount_cents: 80000, estimate_fingerprint: 'synthetic-fingerprint' }]);
  assert.deepEqual(loads, [true]);
  assert.equal(button.disabled, false);
});

test('Hub wiring: the settings screen mounts the portal documents module and portal_settings stays server-only', () => {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(suite, /S\.active==='settings'&&canView\('settings'\)[^\n]*window\.EGCPortalDocuments\.mount\(slot\)/);
  assert.ok(page.indexOf('employee-portal-documents.js?v=') > 0 && page.indexOf('employee-portal-documents.js?v=') < page.indexOf('employee-suite.js?v='));
  assert.match(rules, /match \/portal_settings\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
});
