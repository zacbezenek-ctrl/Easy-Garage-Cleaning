/**
 * EGC → Quo (formerly OpenPhone) SMS sender — Cloudflare Pages Function
 * POST /api/quo-send   { job_id, message?, template?, idempotency_key }  (+ Idempotency-Key header)
 *
 * Sends a text straight through the Quo API instead of routing via Zapier.
 * Quo kept OpenPhone's REST API, so the default host is api.openphone.com.
 * The recipient is always the saved job phone. Business users keep free-form
 * job texts. Everyone else may only send a crew/prejob.html script, which the
 * server renders from the saved job: crew never supply the price, so no reply
 * can confirm or deny a guessed rate. A script placeholder ([TIME], [N], ...)
 * left in any text is filled from the saved job, or the send is refused, so a
 * literal placeholder never reaches the customer. The confirmation script says
 * "tomorrow", so it is sent only the day before the saved job date (Denver).
 *
 * Idempotency: every send claims messageReceipts/quo_<sha256(key)> (a
 * top-level, server-only collection; the catch-all Firestore rule denies
 * browsers) BEFORE calling Quo. Keys are global: the fingerprint covers the
 * job, the saved phone and the rendered text, so reusing a key for another
 * job or text is a 409 conflict. A replay of a sent key returns the saved
 * result without a second text; a pending or ambiguous attempt is never
 * retried automatically.
 *
 * Env (Cloudflare Pages → Settings → Environment variables):
 *   QUO_API_KEY  (required) — Quo workspace API key. Sent as the Authorization
 *                header value verbatim (OpenPhone-style: NOT "Bearer <key>").
 *   QUO_FROM     (optional) — the EGC Quo number to send from. Default +19709991818.
 *   QUO_API_BASE (optional) — default https://api.openphone.com/v1. Override if Quo
 *                moves the host (e.g. https://api.quo.com/v1) or auth changes.
 */

import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { readJob, encodeFirestoreFields, decodeFirestoreFields } from '../_lib/firestore-job.js';
import { firestoreFetch } from '../_lib/firebase-service-account.js';
import { createJobAssignmentAccess, jobCrewNames } from '../_lib/job-assignment.js';
import { fieldId } from '../_lib/field-execution.js';
import { arrivalClock } from '../_lib/dispatch-arrival.js';
import { addDays, denverToday } from '../_lib/dispatch-time.js';

const DOCUMENTS = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const RECEIPTS = 'messageReceipts';
const MAX_BODY_BYTES = 8 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,255}$/;
const SAFE_NAME = /^[\p{L}\p{M}][\p{L}\p{M}'’.-]{0,39}$/u;
const PRICE = /^\d{1,7}(?:\.\d{1,2})?$/;
// Server copy of the crew/prejob.html SMS scripts (the idempotency test runs
// that page's buttons against it). The page sends [TIME] and [N] literally;
// they are rendered here from the saved start time and crew size.
const SLOT = { NAME: '[^ ]{1,60}', ADDRESS: '[\\s\\S]{1,300}', RATE: '[^ ]{1,20}', TIME: '[^\\n]{1,20}', N: '[^ ,]{1,4}' };
const PLACEHOLDER = /\[(NAME|ADDRESS|RATE|TIME|N)\]/g;
const TEMPLATES = new Map([
  ['arrival', 'Hi [NAME] — the Easy Garage Cleaning crew is on the way to [ADDRESS]. We\'ll see you shortly. Reply here if anything changed.'],
  ['confirmation', 'Hi [NAME], it\'s Easy Garage Cleaning — confirming your garage comeback tomorrow at [TIME]. Crew of [N], we\'ll knock when we arrive. Flat rate locked at $[RATE] like we agreed — nothing changes. Reply C to confirm. — Alex'],
].map(([id, text]) => {
  const slots = [];
  const source = text.split(/\[(NAME|ADDRESS|RATE|TIME|N)\]/).map((part, index) => index % 2 ? (slots.push(part), `(${SLOT[part]})`) : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return [id, { id, text, slots, pattern: new RegExp(`^${source}$`, 'u') }];
}));

// Same pattern as functions/api/field-jobs.js: a present Origin/Referer must be
// this exact origin (absent headers rely on the SameSite=Strict session cookie).
const mutationOriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};
const jsonRequest = request => request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json';
// US phone → E.164 so Quo accepts it no matter how the crew typed it.
function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length > 10) return '+' + d;
  return '';
}
async function assignedToJob(job, session, env) {
  if (hasBusinessAccess(session)) return true;
  return createJobAssignmentAccess(env, session).assigned(job);
}

// The saved flat rate, shown the way crew/prejob.html fills its rate field.
export function savedJobRate(job = {}) {
  for (const value of [job.total, job.priceQuoted]) {
    if (value === '' || value == null) continue;
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  }
  return '';
}
// Start time as the customer reads it ('9:00 AM'), or '' when none is saved.
export function savedJobTime(job = {}) {
  return arrivalClock(job.time);
}
// Planned crew size, else the number of assigned crew; '' when neither is saved.
export function savedCrewSize(job = {}) {
  for (const value of [job.crewNeeded, job.crewSize]) {
    if (value === '' || value == null) continue;
    const size = Number(value);
    if (Number.isInteger(size) && size >= 1 && size <= 20) return String(size);
  }
  const assigned = jobCrewNames(job).length;
  return assigned >= 1 && assigned <= 20 ? String(assigned) : '';
}
// Returns the value to send ('' when the saved job lacks it), or null when the
// caller's value is off-script. RATE is always the saved job rate: a typed
// price (or the [RATE] placeholder) only has to look like a price, and a wrong
// guess renders the same text as a right one, so the reply never depends on
// the saved price. TIME and N accept the placeholder or the saved value only.
function scriptSlot(slot, value, job) {
  if (slot === 'RATE') return value === '[RATE]' || PRICE.test(value) ? savedJobRate(job) : null;
  if (slot === 'TIME' || slot === 'N') {
    const saved = slot === 'TIME' ? savedJobTime(job) : savedCrewSize(job);
    return value === `[${slot}]` || (saved !== '' && value === saved) ? saved : null;
  }
  if (slot === 'ADDRESS') {
    const address = typeof job.address === 'string' ? job.address : '';
    if (value === '[ADDRESS]') return address.trim() ? address : 'your garage';
    return value === 'your garage' || (address !== '' && value === address) ? value : null;
  }
  const first = String(job.customer || '').trim().split(/\s+/)[0] || '';
  if (value === '[NAME]') return SAFE_NAME.test(first) ? first : 'there';
  return value === 'there' || (first !== '' && value === first) || (SAFE_NAME.test(value) && !/\.\p{L}{2}/u.test(value)) ? value : null;
}
/**
 * Renders a pre-job script from the saved job. `message` may be the page's
 * filled-in text or the script with its placeholders; with only `template`,
 * the script's placeholders are used. Returns null when nothing matches, or
 * { template, message, missing } otherwise, where `missing` lists the slots
 * the saved job cannot fill.
 */
export function renderScript(job = {}, { message = '', template = '' } = {}) {
  const candidates = template ? [TEMPLATES.get(template)].filter(Boolean) : [...TEMPLATES.values()];
  for (const script of candidates) {
    const match = script.pattern.exec(message || (template ? script.text : ''));
    if (!match) continue;
    const values = script.slots.map((slot, index) => scriptSlot(slot, match[index + 1], job));
    if (values.includes(null)) continue;
    let slot = 0;
    return { template: script.id, message: script.text.replace(PLACEHOLDER, () => values[slot++]), missing: script.slots.filter((_, index) => values[index] === '') };
  }
  return null;
}
const scriptId = message => [...TEMPLATES.values()].find(script => script.pattern.test(message))?.id || '';
// Business free-form texts keep their words; only left-over placeholders are
// filled from the saved job.
export function fillPlaceholders(job = {}, text = '') {
  const missing = new Set();
  const message = text.replace(PLACEHOLDER, (placeholder, slot) => {
    const value = scriptSlot(slot, placeholder, job);
    if (!value) missing.add(slot);
    return value || placeholder;
  });
  return { message, missing: [...missing] };
}

const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
const receiptUrl = id => `${DOCUMENTS}/${RECEIPTS}/${id}`;
const receiptRecord = document => ({ ...decodeFirestoreFields(document.fields || {}), __updateTime: document.updateTime || '' });
async function readReceipt(env, id) {
  const response = await firestoreFetch(env, receiptUrl(id));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Receipt read failed (${response.status})`);
  return receiptRecord(await response.json());
}
// Returns null when a concurrent request changed the receipt first.
async function writeReceipt(env, id, patch, updateTime = '') {
  const url = new URL(receiptUrl(id));
  if (updateTime) {
    Object.keys(patch).forEach(field => url.searchParams.append('updateMask.fieldPaths', field));
    url.searchParams.set('currentDocument.updateTime', updateTime);
  } else url.searchParams.set('currentDocument.exists', 'false');
  const response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(patch) }) });
  if ([400, 409, 412].includes(response.status)) return null;
  if (!response.ok) throw new Error(`Receipt write failed (${response.status})`);
  return receiptRecord(await response.json());
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const unavailable = () => json(503, { ok: false, code: 'QUO_SEND_STORAGE_UNAVAILABLE', error: 'The text could not be checked against earlier sends. Retry shortly.' });
const templateRequired = () => json(400, { ok: false, code: 'QUO_SEND_TEMPLATE_REQUIRED', error: 'Crew texts must use the pre-job script with this job\'s saved details. Reload the page to pick up the latest job, then send again.' });
// Managers may save the job or type the value themselves; crew can only ask.
const detailsMissing = (missing, business) => missing.includes('RATE')
  ? json(400, { ok: false, code: 'QUO_SEND_RATE_UNAVAILABLE', error: business ? 'This job has no saved flat rate yet. Save the flat rate on the job, or type the amount in place of [RATE], then send again.' : 'This job has no saved flat rate yet. Ask a manager to send the confirmation text.' })
  : json(400, { ok: false, code: 'QUO_SEND_SCHEDULE_UNAVAILABLE', error: business ? 'This job has no saved start time or crew size yet. Save them on the job, or type them in place of [TIME] and [N], then send again.' : 'This job has no saved start time or crew size yet. Ask a manager to save them on the job, then send the confirmation text.' });
const wrongDay = business => json(400, { ok: false, code: 'QUO_SEND_CONFIRMATION_DATE_MISMATCH', error: `The confirmation text says "tomorrow", but this job is not saved for tomorrow. Send it the day before the job${business ? ', or text the customer your own wording' : ''}.` });

export function quoSendHandlers({ session: readSession = getHubSession, now = () => new Date() } = {}) {
  return {
    async post({ request, env }) {
      if (!mutationOriginAllowed(request)) return json(403, { ok: false, code: 'QUO_SEND_ORIGIN_FORBIDDEN', error: 'Forbidden origin' });
      if (!jsonRequest(request)) return json(415, { ok: false, code: 'QUO_SEND_JSON_REQUIRED', error: 'Texts must be sent as JSON.' });
      const session = await readSession(request, env);
      if (!session) return json(401, { ok: false, error: 'Sign in to the EGC Hub' });
      const QUO_KEY = env.QUO_API_KEY || env.QUO; // accept either var name
      if (!QUO_KEY) return json(501, { ok: false, error: 'Quo not configured — set QUO_API_KEY' });

      const tooLarge = () => json(413, { ok: false, code: 'QUO_SEND_TOO_LARGE', error: 'Request too large' });
      if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return tooLarge();
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return tooLarge();
      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'Invalid JSON' });

      const jobId = String(body.job_id || '');
      if (!fieldId(jobId)) return json(400, { ok: false, error: 'A valid assigned job is required' });
      let job;
      try { job = await readJob(env, jobId); } catch { return json(503, { ok: false, code: 'QUO_SEND_STORAGE_UNAVAILABLE', error: 'Your job assignment could not be checked. Retry shortly.' }); }
      if (!job || !await assignedToJob(job, session, env)) return json(403, { ok: false, error: 'This job is not assigned to you' });

      const headerKey = request.headers.get('Idempotency-Key'), bodyKey = body.idempotency_key;
      if (headerKey != null && bodyKey != null && String(headerKey) !== String(bodyKey)) return json(400, { ok: false, code: 'QUO_SEND_IDEMPOTENCY_KEY_MISMATCH', error: 'The send key does not match. Reload before retrying.' });
      const key = String(headerKey ?? bodyKey ?? '').trim();
      if (!IDEMPOTENCY_KEY.test(key)) return json(400, { ok: false, code: 'QUO_SEND_IDEMPOTENCY_KEY_REQUIRED', error: 'A send key is required so a retry cannot text the customer twice. Reload the page and retry.' });
      const to = normPhone(job.phone);
      const requested = body.template == null || body.template === '' ? '' : String(body.template);
      if (requested && !TEMPLATES.has(requested)) return templateRequired();
      const typed = String(body.message || '').slice(0, 1500);
      let message = typed, template = scriptId(typed) || 'custom', missing;
      if (requested || !hasBusinessAccess(session)) {
        const script = renderScript(job, { message: typed, template: requested });
        if (!script) return templateRequired();
        ({ message, template, missing } = script);
      } else ({ message, missing } = fillPlaceholders(job, typed));
      if (missing.length) return detailsMissing(missing, hasBusinessAccess(session));
      if (template === 'confirmation' && job.date !== addDays(denverToday(now()), 1)) return wrongDay(hasBusinessAccess(session));
      if (!to || !message) return json(400, { ok: false, error: 'to and message are required' });

      // The fingerprint omits the actor: two crew members tapping the same
      // scripted text for one job replay one send instead of texting twice.
      // It includes the job, so a key reused on another job is a conflict.
      const receiptId = 'quo_' + await sha256(key), fingerprint = await sha256(JSON.stringify({ jobId, to, message }));
      const settled = receipt => {
        if (!receipt) return null;
        if (receipt.fingerprint !== fingerprint) return json(409, { ok: false, code: 'QUO_SEND_IDEMPOTENCY_CONFLICT', error: 'This send key was already used for a different text. Reload before retrying.' });
        if (receipt.status === 'sent') return json(200, { ok: true, id: receipt.messageId || '', replayed: true });
        if (receipt.status === 'rejected') return null;
        return json(409, { ok: false, code: 'QUO_SEND_OUTCOME_UNKNOWN', error: 'An earlier attempt of this text may already have reached the customer. Check the Quo thread before sending again.' });
      };
      let claimed;
      try {
        const existing = await readReceipt(env, receiptId), early = settled(existing);
        if (early) return early;
        const stamp = now().toISOString(), attempt = { status: 'pending', actorId: String(session.user || ''), template, attemptedAt: stamp, updatedAt: stamp };
        claimed = existing
          ? await writeReceipt(env, receiptId, { ...attempt, attempts: Number(existing.attempts || 0) + 1 }, existing.__updateTime)
          : await writeReceipt(env, receiptId, { recordType: 'quo_message_receipt', channel: 'quo', jobId, idempotencyKey: key, fingerprint, createdAt: stamp, attempts: 1, ...attempt });
        if (!claimed) return settled(await readReceipt(env, receiptId)) || unavailable();
      } catch { return unavailable(); }

      const base = (env.QUO_API_BASE || 'https://api.openphone.com/v1').replace(/\/$/, '');
      const from = env.QUO_FROM || '+19709991818';
      let outcome;
      try {
        const r = await fetch(base + '/messages', {
          method: 'POST',
          headers: { Authorization: QUO_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], content: message }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await r.json().catch(() => ({}));
        // 4xx means Quo refused the text, so the same key may retry; a 5xx
        // or lost connection may still have delivered it.
        outcome = r.ok ? { status: 'sent', messageId: String((data && data.data && data.data.id) || '').slice(0, 180), providerStatus: r.status } : { status: r.status >= 500 ? 'uncertain' : 'rejected', providerStatus: r.status };
      } catch {
        outcome = { status: 'uncertain', providerStatus: 0 };
      }
      const stamp = now().toISOString();
      await writeReceipt(env, receiptId, { ...outcome, updatedAt: stamp, ...(outcome.status === 'sent' ? { sentAt: stamp } : {}) }, claimed.__updateTime).catch(() => null);
      if (outcome.status === 'sent') return json(200, { ok: true, id: outcome.messageId });
      if (outcome.status === 'rejected') return json(502, { ok: false, error: 'Quo rejected the message', status: outcome.providerStatus });
      return json(502, { ok: false, code: 'QUO_SEND_OUTCOME_UNKNOWN', error: outcome.providerStatus ? 'Quo did not confirm the message' : 'Quo unreachable', ...(outcome.providerStatus ? { status: outcome.providerStatus } : {}) });
    },
  };
}

export async function onRequestOptions({ request }) {
  if (!mutationOriginAllowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    Allow: 'POST, OPTIONS', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key' } });
}
export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}
export const onRequestPost = quoSendHandlers().post;
