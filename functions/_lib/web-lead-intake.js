/* FUN-13: website lead intake ledger. With WEB_LEAD_RECEIPTS_ENABLED every
   website lead first gets a server-only receipt web_lead_receipts/{inquiryId}
   and, for demand, an inquiry.received funnel event in ONE create-only commit,
   and only then the HighLevel sync. The receipt is a delivery receipt, not a
   lead store: HighLevel stays the lead record and the legacy Firestore leads
   collection stays closed. The lead rides along only as a payload sealed under
   a SEC-B purpose key, cleared once HighLevel has it or 30 days after the
   receipt is abandoned. A failed sync is retried on the signed MSG-CRON tick
   (bounded, Denver quiet hours honoured).
   The Zapier relay, the one automatic customer text, only ever goes out from
   the request that received the lead, exactly as before; a retry never sends it.
   Nothing in HighLevel needs changing: a retried sync makes the same contact,
   tag and note calls as an on-time one, so HighLevel's own automations start
   when the lead reaches it, late or not, exactly as if it had just arrived. Its
   detail note says it came late, and it never creates or moves an opportunity
   someone may already have worked. Only with WEB_LEAD_DELAYED_SYNC_TAG=true
   does it also tag the contact egc-delayed-sync (removed again by the
   contact's next on-time sync), an optional extra for a HighLevel workflow
   filter that skips an instant reply that would now arrive late.
   Delivery is at-least-once: a sync whose result cannot be saved is synced
   again by the cron (its detail note repeats; the opportunity is left alone). */
import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { dispatchStorage } from './dispatch-storage.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { canonicalJson, sha256Hex } from './funnel-definitions.js';
import { funnelEventWrite } from './funnel-events.js';
import { quietHoursDecision } from './message-policies.js';
import { SEAL_PURPOSES, purposeOpen, purposeSeal } from './purpose-keys.js';

export const WEB_LEAD_RECEIPTS = 'web_lead_receipts';
export const WEB_LEAD_FIELDS = Object.freeze(['name', 'phone', 'email', 'items', 'service_type', 'job_size', 'what_to_remove', 'photo_description', 'source', 'subject', 'city', 'serviceZip', 'preferred_date', 'preferred_timing', 'booking_slot', 'estimated_range', 'flow_type', 'sms_consent', 'request_id', 'fbc', 'fbp', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'msclkid', 'landing_url', 'referrer', 'page_url']);
export const WEB_LEAD_ATTRIBUTION_FIELDS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'msclkid', 'fbclid', 'fbc', 'fbp', 'landing_url', 'referrer']);
export const WEB_LEAD_MAX_ATTEMPTS = 8;
// A claimed attempt that never settles (a lost worker) is due again after this.
export const WEB_LEAD_CLAIM_MS = 10 * 60000;
// Minutes before the next attempt, by attempts made so far.
export const WEB_LEAD_RETRY_MINUTES = Object.freeze([5, 15, 45, 120, 360, 720, 1440]);
// Cloudflare subrequests for one retry at worst: the claim, seven HighLevel calls
// (upsert, delayed tag (only with WEB_LEAD_DELAYED_SYNC_TAG), tags, opportunity
// check, note, pipelines, opportunity)
// and WEB_LEAD_RETRY_SETTLE_ROUNDS settle rounds of a read and a write. At the
// default messaging budget the lead retries' third (13) fits exactly one.
export const WEB_LEAD_RETRY_SETTLE_ROUNDS = 2;
export const WEB_LEAD_RETRY_COST = 1 + 7 + 2 * WEB_LEAD_RETRY_SETTLE_ROUNDS;
export const WEB_LEAD_RETRY_LIMIT = 5;
// Time on the tick (ms since it started; the Railway worker gives up at 120 s).
// The retry pass starts no new retry once the tick is WEB_LEAD_RETRY_WINDOW_MS
// old. A retry's claim is one Firestore write (20 s timeout), its HighLevel calls
// are each cut to end by WEB_LEAD_HIGHLEVEL_DEADLINE_MS (a call with less than
// WEB_LEAD_MIN_CALL_MS left is not started and the sync fails, to be retried),
// and it settles in rounds of a Firestore read and write (20 s timeouts each,
// WEB_LEAD_SETTLE_ROUND_MS), a further round only while one still fits before
// WEB_LEAD_TICK_LIMIT_MS. So even when every call hangs until its timeout, the
// pass is done 5 s inside the worker's timeout; an unsettled retry is synced
// again once its claim expires (at-least-once).
export const WEB_LEAD_RETRY_WINDOW_MS = 30000;
export const WEB_LEAD_TICK_LIMIT_MS = 115000;
export const WEB_LEAD_SETTLE_ROUND_MS = 40000;
export const WEB_LEAD_HIGHLEVEL_DEADLINE_MS = WEB_LEAD_TICK_LIMIT_MS - WEB_LEAD_SETTLE_ROUND_MS;
export const WEB_LEAD_MIN_CALL_MS = 1000;
const HIGHLEVEL_TIMEOUT_MS = 15000;
const OUT_OF_TIME = 'web_lead_retry_out_of_time';
// A sealed payload kept on an abandoned receipt is deleted this long after it was abandoned.
export const WEB_LEAD_PAYLOAD_RETENTION_DAYS = 30;
export const WEB_LEAD_DELAYED_TAG = 'egc-delayed-sync';
const HOLD_ADS = 'ads_relay_disabled';
const HIGHLEVEL_API = 'https://services.leadconnectorhq.com';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH = /^\/[A-Za-z0-9._~\/-]{0,199}$/;
const ACTOR = Object.freeze({ id: 'website-form', kind: 'customer' });
const PENDING = new Set(['syncing', 'failed']);
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const safeCode = value => /^[a-z][a-z0-9_]{0,63}$/.test(String(value || '')) ? String(value) : 'web_lead_sync_failed';
const later = (at, ms) => new Date(Date.parse(at) + ms).toISOString();

// Read an env var tolerant of stray whitespace in the NAME — a dashboard var
// saved as "WEBSITE_LEAD_HOOK_URL " (trailing space) is a silent footgun: it's
// present but env.WEBSITE_LEAD_HOOK_URL reads undefined. Prefer the exact key;
// otherwise match any key that trims to the requested name.
export function envVar(env, name) {
  if (env && env[name]) return env[name];
  for (const k of Object.keys(env || {})) {
    if (k.trim() === name && env[k]) return env[k];
  }
  return '';
}

export const webLeadReceiptsEnabled = env => envVar(env, 'WEB_LEAD_RECEIPTS_ENABLED') === 'true';
export const webLeadAdsRelayEnabled = env => envVar(env, 'WEB_LEAD_ADS_RELAY_ENABLED') === 'true';
/** Opt-in: only then does a late sync add WEB_LEAD_DELAYED_TAG and an on-time one (ledger on) remove it. */
export const webLeadDelayedSyncTagEnabled = env => envVar(env, 'WEB_LEAD_DELAYED_SYNC_TAG') === 'true';
/** The ledger runs only with the flag on and Firestore configured; otherwise web-lead is exactly the legacy relay. */
export const webLeadLedgerOn = env => webLeadReceiptsEnabled(env) && firebaseServiceAccountConfigured(env);
export const webLeadInquiryId = value => typeof value === 'string' && UUID.test(value.trim()) ? value.trim().toLowerCase() : '';

export function highLevelConfig(env) {
  return {
    token: envVar(env, 'HIGHLEVEL_API_KEY') || envVar(env, 'GHL_API_KEY'),
    locationId: envVar(env, 'HIGHLEVEL_LOCATION_ID') || envVar(env, 'GHL_LOCATION_ID'),
    pipelineId: envVar(env, 'HIGHLEVEL_PIPELINE_ID') || envVar(env, 'GHL_PIPELINE_ID'),
    stageId: envVar(env, 'HIGHLEVEL_NEW_LEAD_STAGE_ID') || envVar(env, 'GHL_NEW_LEAD_STAGE_ID'),
    assignedTo: envVar(env, 'HIGHLEVEL_USER_ID') || envVar(env, 'GHL_USER_ID'),
  };
}

// Provider bodies are never kept: a failure carries only a code a receipt may store.
async function highLevelRequest(config, path, options = {}, fetcher = fetch, timeoutMs = HIGHLEVEL_TIMEOUT_MS) {
  let response;
  try {
    response = await fetcher(HIGHLEVEL_API + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Version: 'v3',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw fail('highlevel_unavailable', 'HighLevel could not be reached'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) ? 'highlevel_rejected' : 'highlevel_unavailable', `HighLevel returned ${response.status}`, response.status);
  return data;
}

// Why a delayed sync left the opportunity alone; the detail note says the same to the team.
const OPPORTUNITY_SKIPPED = Object.freeze({
  existing_contact: 'not created or changed, because this contact already existed in HighLevel. Check its pipeline before adding one.',
  existing_opportunity: 'not created or changed, because this contact already has one in this pipeline (open, won, lost or abandoned). Check it before adding one or reopening it.',
  opportunity_check_failed: 'not created, because the contact\'s opportunities could not be checked. Add one if this lead needs it.',
});

// A retry that ran out of tick time fails as a whole (and is retried), even
// where a single call's failure is otherwise tolerated, so a lead is never
// marked synced without its detail note.
const tolerate = error => { if (error?.code === OUT_OF_TIME) throw error; };

/**
 * The website lead -> HighLevel contact, tags, detail note and new-lead
 * opportunity (client hub help: an internal comment instead). options:
 * {delayed, createdContactId, timeLeft}. A delayed (cron) sync makes the same
 * contact, tag and note calls as an on-time one (its note says it is late),
 * and never creates or moves an opportunity for a contact that existed before
 * this lead (only for one this sync or an earlier attempt of the same receipt,
 * createdContactId, created, and then only when it has no opportunity in the
 * pipeline at all: an upsert would reopen a won, lost or abandoned one at the
 * new-lead stage). Only with WEB_LEAD_DELAYED_SYNC_TAG=true does a delayed
 * sync first add WEB_LEAD_DELAYED_TAG with its own POST, and an on-time sync
 * of an existing contact (ledger on) remove one an earlier late sync left;
 * otherwise neither call is made. timeLeft() (ms) cuts each
 * HighLevel call's 15 s timeout to what is left, and the sync fails as
 * web_lead_retry_out_of_time rather than start a call with less than
 * WEB_LEAD_MIN_CALL_MS left. A failure after the contact upsert carries
 * createdContactId when this attempt created the contact.
 */
export async function syncHighLevelLead(env, lead, fetcher = (...args) => fetch(...args), { delayed = false, createdContactId = '', timeLeft = null } = {}) {
  const config = highLevelConfig(env);
  if (!config.token || !config.locationId) return { configured: false, synced: false };
  const isClientHubHelp = lead.flow_type === 'client_hub_help';
  const left = () => typeof timeLeft === 'function' ? Number(timeLeft()) : Infinity;
  const outOfTime = () => fail(OUT_OF_TIME, 'The retry ran out of time before HighLevel finished.');
  const request = async (path, options) => {
    const ms = left();
    if (!(ms >= WEB_LEAD_MIN_CALL_MS)) throw outOfTime();
    try { return await highLevelRequest(config, path, options, fetcher, Math.floor(Math.min(HIGHLEVEL_TIMEOUT_MS, ms))); }
    catch (error) { throw left() < WEB_LEAD_MIN_CALL_MS ? outOfTime() : error; }
  };

  const contactResult = await request('/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify({
      locationId: config.locationId,
      name: lead.name,
      phone: lead.phone,
      ...(lead.email ? { email: lead.email } : {}),
      source: lead.source || 'EGC Website',
    }),
  });
  const contactId = contactResult.contact && contactResult.contact.id || contactResult.id || '';
  if (!contactId) throw fail('highlevel_contact_missing', 'HighLevel did not return a contact ID');
  const isNew = contactResult.new === true, created = isNew || (Boolean(createdContactId) && createdContactId === contactId);
  try {
    return await syncHighLevelDetails({ env, config, lead, request, contactId, isNew, created, delayed, isClientHubHelp });
  } catch (error) {
    if (isNew && error && typeof error === 'object') error.createdContactId = contactId;
    throw error;
  }
}

async function syncHighLevelDetails({ env, config, lead, request, contactId, isNew, created, delayed, isClientHubHelp }) {
  const tagsPath = `/contacts/${encodeURIComponent(contactId)}/tags`;
  let delayedTag = null;
  // The tag is opt-in: without WEB_LEAD_DELAYED_SYNC_TAG no call adds or removes it, and a late
  // sync reaches HighLevel exactly as an on-time one does.
  const markDelayed = webLeadDelayedSyncTagEnabled(env);
  if (delayed && markDelayed) {
    // Before the source and consent tags, so a workflow those tags start already sees it.
    try { await request(tagsPath, { method: 'POST', body: JSON.stringify({ tags: [WEB_LEAD_DELAYED_TAG] }) }); delayedTag = 'added'; }
    catch (error) { tolerate(error); delayedTag = 'failed'; }
  } else if (!delayed && markDelayed && !isNew && webLeadLedgerOn(env)) {
    // An on-time lead clears the mark a late sync left, so its own instant reply is not skipped.
    try { await request(tagsPath, { method: 'DELETE', body: JSON.stringify({ tags: [WEB_LEAD_DELAYED_TAG] }) }); delayedTag = 'cleared'; }
    catch (error) { tolerate(error); delayedTag = 'clear_failed'; }
  }
  const consentTag = lead.sms_consent === 'yes' ? 'egc-sms-consent' : 'egc-no-sms-consent';
  const sourceTag = isClientHubHelp ? 'egc-client-hub-help' : 'egc-website-lead';
  let consentTagSynced = true;
  try {
    await request(tagsPath, {
      method: 'PUT',
      body: JSON.stringify({ tags: [sourceTag, consentTag] }),
    });
  } catch (error) { tolerate(error); consentTagSynced = false; }
  // A late sync may reach a deal someone already worked from the Web3Forms email: it never resets one.
  let opportunitySkipped = null;
  if (delayed && !isClientHubHelp && config.pipelineId) {
    if (!created) opportunitySkipped = 'existing_contact';
    else if (!isNew) {
      // Every status, not only open: the upsert matches the contact's opportunity in
      // this pipeline, so it would reopen a won, lost or abandoned deal at the new-lead stage.
      try {
        const params = new URLSearchParams({ locationId: config.locationId, contactId, pipelineId: config.pipelineId, status: 'all', limit: '100', page: '1' });
        const found = await request(`/opportunities/search?${params}`);
        const rows = found.opportunities;
        if (!Array.isArray(rows) || rows.some(row => (row?.contactId || row?.contact?.id) !== contactId)) opportunitySkipped = 'opportunity_check_failed';
        else if (rows.length || Number(found.meta?.total || 0)) opportunitySkipped = 'existing_opportunity';
      } catch (error) { tolerate(error); opportunitySkipped = 'opportunity_check_failed'; }
    }
  }
  const late = delayed ? { delayedTag, ...(opportunitySkipped ? { opportunitySkipped } : {}) } : delayedTag ? { delayedTag } : {};
  const detailLines = [
    isClientHubHelp ? 'EGC CLIENT HUB HELP REQUEST' : 'EGC WEBSITE LEAD DETAILS',
    ...(delayed ? ['Delivered late by the Hub retry: the first HighLevel sync failed. Check whether someone already followed up.'] : []),
    ...(opportunitySkipped ? [`Opportunity: ${OPPORTUNITY_SKIPPED[opportunitySkipped]}`] : []),
    `Service: ${lead.service_type || lead.items || '—'}`,
    `Job size: ${lead.job_size || '—'}`,
    `${isClientHubHelp ? 'Message' : 'Removal request'}: ${lead.what_to_remove || lead.items || '—'}`,
    `Photo description: ${lead.photo_description || '—'}`,
    `Email: ${lead.email || '—'}`,
    `Location: ${[lead.city, lead.serviceZip].filter(Boolean).join(' ') || '—'}`,
    `Preferred date / timing: ${[lead.preferred_date, lead.preferred_timing].filter(Boolean).join(' · ') || '—'}`,
    `Requested slot: ${lead.booking_slot || '—'}`,
    `Estimated range shown: ${lead.estimated_range || '—'}`,
    `Form path: ${lead.flow_type || 'standard'}`,
    `SMS consent checked: ${lead.sms_consent === 'yes' ? 'yes' : 'no'}`,
    `Campaign: ${[lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content].filter(Boolean).join(' · ') || 'direct / unavailable'}`,
    `Search attribution: ${[lead.utm_term, lead.gclid, lead.msclkid].filter(Boolean).join(' · ') || '—'}`,
    `Landing page: ${lead.page_url || lead.landing_url || '—'}`,
    ...(lead.inquiry_id ? [`Inquiry ID: ${lead.inquiry_id}`] : []),
  ];
  let noteSynced = false;
  try {
    await request(`/contacts/${encodeURIComponent(contactId)}/notes`, {
      method: 'POST', headers: { 'Idempotency-Key': `${isClientHubHelp ? 'client-hub-help-note' : 'website-lead-details'}:${contactId}:${lead.inquiry_id || lead.request_id || lead.booking_slot || lead.preferred_date || 'request'}` },
      body: JSON.stringify({ userId: config.assignedTo || undefined, title: isClientHubHelp ? 'EGC Client Hub Help' : 'EGC Website Lead Details', body: detailLines.join('\n').slice(0, 3000), color: '#F15A24', pinned: isClientHubHelp }),
    });
    noteSynced = true;
  } catch (error) { tolerate(error); }
  let internalCommentSynced = false;
  if (isClientHubHelp) {
    try {
      await request('/conversations/messages', {
        method: 'POST',
        headers: { 'Idempotency-Key': `client-hub-help:${contactId}:${lead.request_id || lead.inquiry_id || 'request'}` },
        body: JSON.stringify({
          type: 'InternalComment',
          contactId,
          message: `Client hub help request from ${lead.name}: ${lead.what_to_remove || lead.items || '—'}${lead.phone ? `\nPhone: ${lead.phone}` : ''}${lead.email ? `\nEmail: ${lead.email}` : ''}`.slice(0, 1200),
          ...(config.assignedTo ? { userId: config.assignedTo } : {}),
        }),
      });
      internalCommentSynced = true;
    } catch (error) { tolerate(error); }
    if (!noteSynced && !internalCommentSynced) throw fail('highlevel_note_failed', 'HighLevel could not store the client hub request');
    return { configured: true, synced: true, contactId, opportunityId: '', consentTag, consentTagSynced, internalCommentSynced, ...late };
  }
  if (!config.pipelineId || opportunitySkipped) return { configured: true, synced: true, contactId, opportunityId: '', consentTag, consentTagSynced, ...late };

  let stageId = config.stageId;
  if (!stageId) {
    const data = await request(`/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`);
    const pipeline = (data.pipelines || []).find(item => item.id === config.pipelineId);
    stageId = pipeline && pipeline.stages && pipeline.stages[0] && pipeline.stages[0].id || '';
  }
  if (!stageId) throw fail('highlevel_stage_missing', 'HighLevel new-lead pipeline stage is unavailable');

  const body = {
    pipelineId: config.pipelineId,
    locationId: config.locationId,
    name: `${lead.name} — ${lead.items || 'Website lead'}`,
    pipelineStageId: stageId,
    status: 'open',
    contactId,
    monetaryValue: 0,
    followers: config.assignedTo ? [config.assignedTo] : [],
    isRemoveAllFollowers: false,
    followersActionType: 'add',
    ...(config.assignedTo ? { assignedTo: config.assignedTo } : {}),
  };
  const result = await request('/opportunities/upsert', {
    method: 'POST',
    headers: { 'Idempotency-Key': `website-lead:${contactId}:${config.pipelineId}` },
    body: JSON.stringify(body),
  });
  return { configured: true, synced: true, contactId, opportunityId: result.opportunity && result.opportunity.id || result.id || '', consentTag, consentTagSynced, ...late };
}

function pathOf(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  return PATH.test(path) ? path : null;
}

/** The form a lead came from, by its page: the ads landing page is gated separately. */
export function webLeadFormSource(flat, pagePath) {
  if (flat.flow_type === 'client_hub_help') return 'client_hub_help';
  const page = pagePath === null ? null : pagePath.replace(/\.html$/, '').replace(/\/index$/, '/');
  if (page === null) return 'unknown';
  if (page === '/ads') return 'ads_landing';
  if (page === '/book') return 'book';
  if (page === '/') return 'home';
  return 'site_page';
}

/** Receipt metadata: nothing here identifies the person; attribution is kept only as a hash (null when there is none). */
export function webLeadMeta(flat, { name, phone }) {
  const pagePath = pathOf(flat.page_url), formSource = webLeadFormSource(flat, pagePath);
  const attribution = Object.fromEntries(WEB_LEAD_ATTRIBUTION_FIELDS.map(key => [key, flat[key] || '']));
  const attributionHash = Object.values(attribution).some(Boolean) ? sha256Hex(canonicalJson(attribution)) : null;
  const fingerprint = sha256Hex(canonicalJson({ v: 1, lead: { ...Object.fromEntries(WEB_LEAD_FIELDS.map(key => [key, flat[key] || ''])), name, phone } }));
  return { pagePath, formSource, attributionHash, fingerprint };
}

export const webLeadHeld = (env, meta) => meta.formSource === 'ads_landing' && !webLeadAdsRelayEnabled(env) ? HOLD_ADS : null;

const aad = inquiryId => `${WEB_LEAD_RECEIPTS}/${inquiryId}`;
export const openWebLead = (env, inquiryId, sealed) => purposeOpen(env, SEAL_PURPOSES.webLeadReceipt, sealed, aad(inquiryId));
/** Seals a lead for its receipt and proves it opens again to the same lead; otherwise it throws and the receipt stores no payload (payloadSealed:false). */
export async function sealWebLead(env, inquiryId, lead) {
  const sealed = await purposeSeal(env, SEAL_PURPOSES.webLeadReceipt, lead, aad(inquiryId));
  if (JSON.stringify(await openWebLead(env, inquiryId, sealed)) !== JSON.stringify(lead)) throw fail('purpose_seal_invalid', 'The sealed lead did not open to the same lead.');
  return sealed;
}

const retryAfter = (at, attempts) => later(at, WEB_LEAD_RETRY_MINUTES[Math.min(Math.max(attempts, 1), WEB_LEAD_RETRY_MINUTES.length) - 1] * 60000);

// Abandons a receipt. A sealed payload it still holds is kept for the owner
// for WEB_LEAD_PAYLOAD_RETENTION_DAYS; its retryAt is then the purge date.
const abandon = (row, at, reason, extra = {}) => ({ ...extra, ghlSyncStatus: 'abandoned', abandonReason: reason, abandonedAt: at, retryAt: row.sealedPayload ? later(at, WEB_LEAD_PAYLOAD_RETENTION_DAYS * 86400000) : null });

// The outcome of one claimed attempt. A lead without a sealed payload cannot
// be retried and is left for the owner (the Web3Forms email still has it).
// A failed attempt that created the HighLevel contact records it, so a retry
// knows that contact is its own and may still open the lead's opportunity.
// stopReason abandons a failed attempt at once (nothing will retry it).
function outcomePatch(row, at, result, error, stopReason = null) {
  if (!error) return { ghlSyncStatus: 'synced', syncedAt: at, lastAttemptAt: at, contactId: result.contactId || null, opportunityId: result.opportunityId || null, delayedTag: result.delayedTag || null, opportunitySkipped: result.opportunitySkipped || null, sealedPayload: null, retryAt: null, lastError: null, abandonReason: null };
  const code = safeCode(error.code), exhausted = stopReason || (!row.sealedPayload ? 'payload_unavailable' : row.attempts >= WEB_LEAD_MAX_ATTEMPTS ? 'attempts_exhausted' : null);
  const created = typeof error.createdContactId === 'string' && error.createdContactId ? { createdContactId: error.createdContactId } : {};
  return exhausted
    ? abandon(row, at, exhausted, { lastAttemptAt: at, lastError: code, ...created })
    : { ghlSyncStatus: 'failed', lastAttemptAt: at, lastError: code, retryAt: retryAfter(at, row.attempts), ...created };
}

const relayStatusOf = relayed => relayed ? relayed.sent ? 'sent' : relayed.skipped || (relayed.configured ? 'failed' : 'not_configured') : null;

// Settles the attempt this caller claimed. A lost response is resolved by the
// re-read; another claim (a later retry) is never overwritten. An attempt left
// unsettled is due again once its claim expires (at-least-once delivery).
// more() decides whether a further round still fits in the caller's time.
async function settle(store, inquiryId, claimId, patchFor, rounds = 3, more = () => true) {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    if (attempt > 0 && !more()) return false;
    let row;
    try { row = await store.read(WEB_LEAD_RECEIPTS, inquiryId); } catch { continue; }
    if (!row || row.claimId !== claimId) return false;
    if (row.ghlSyncStatus !== 'syncing') return true;
    try { await store.commit([{ collection: WEB_LEAD_RECEIPTS, id: inquiryId, revision: row.revision, patch: patchFor(row) }]); return true; }
    catch { /* The re-read decides whether it applied. */ }
  }
  return false;
}

// An unconfigured HighLevel is not a sync: the receipt keeps retrying until it is.
async function attemptSync(sync, lead) {
  let result;
  try { result = await sync(lead); }
  catch (error) { return { error, threw: true }; }
  return result?.configured === false ? { result, error: fail('highlevel_not_configured', 'HighLevel is not configured.'), threw: false } : { result, error: null, threw: false };
}

function replay(row, meta) {
  if (row.fingerprint !== meta.fingerprint) return { status: 409, body: { ok: false, code: 'web_lead_idempotency_conflict', error: 'This inquiry was already received with different details.' } };
  const receipt = { status: row.ghlSyncStatus };
  if (row.ghlSyncStatus === 'synced') return { status: 200, body: { ok: true, inquiryId: row.inquiryId, replayed: true, receipt, highlevel: { configured: true, synced: true } } };
  return { status: 202, body: { ok: true, inquiryId: row.inquiryId, replayed: true, accepted: true, receipt, ...(row.holdReason ? { held: row.holdReason } : {}) } };
}

/**
 * Receives one website lead through the ledger. deps: {store, env, now (ISO),
 * sync(lead), relay() (the legacy Zapier relay result), seal?, claimId?};
 * input: {lead: {name, phone, flat},
 * inquiryId, clientInquiryId, meta, held}. Returns {status, body}, or
 * {fallback:true} when the ledger itself is unavailable and the caller should
 * deliver the lead the legacy way (nothing was sent yet). When the receipt
 * commit could not be confirmed either way, the fallback also carries
 * ownedElsewhere(), which the caller awaits after the direct sync and before
 * the Zapier relay: it re-reads the receipt and resolves to that receipt's
 * status when a receipt under another claim exists (a concurrent copy of this
 * submission holds it and sends the one text, so this copy must not), or ''
 * otherwise (a failed re-read included); and settleDelivered(result, relay):
 * after the relay it marks the receipt, if it was written after all, so the
 * cron does not sync the lead again (resolves true once the receipt says
 * synced). A create refused because the
 * receipt already exists (a concurrent copy owns it) is never a fallback: when
 * that receipt cannot be read either, the answer is 503 web_lead_receipt_busy
 * and nothing is synced or relayed, so a resend replays the receipt.
 */
export async function receiveWebLead(deps, input) {
  const { store, env, now, sync, relay, seal = sealWebLead, claimId = crypto.randomUUID() } = deps;
  const { lead, inquiryId, clientInquiryId, meta, held } = input;
  const syncLead = { ...lead.flat, name: lead.name, phone: lead.phone, source: lead.flat.source || 'EGC Website' };
  let existing;
  try { existing = await store.read(WEB_LEAD_RECEIPTS, inquiryId); } catch { return { fallback: true }; }
  if (existing) return replay(existing, meta);

  let sealed = null;
  if (!held) { try { sealed = await seal(env, inquiryId, syncLead); } catch { sealed = null; } }
  const demand = meta.formSource !== 'client_hub_help';
  let event = null;
  if (demand) {
    event = await funnelEventWrite(null, now, {
      type: 'inquiry.received', idempotencyKey: { kind: 'requestId', value: inquiryId }, inquiryId,
      actor: ACTOR, via: 'hub', source: { collection: WEB_LEAD_RECEIPTS, id: inquiryId }, data: { origin: 'web_form' },
      eligibility: { ghl: { source: syncLead.source, tags: [] } },
    });
  }
  const receipt = {
    schemaVersion: 1, inquiryId, clientInquiryId, receivedAt: now,
    formSource: meta.formSource, pagePath: meta.pagePath, attributionHash: meta.attributionHash, fingerprint: meta.fingerprint,
    sealedPayload: sealed, payloadSealed: Boolean(sealed),
    ghlSyncStatus: held ? 'held' : 'syncing', holdReason: held || null,
    attempts: held ? 0 : 1, claimId: held ? null : claimId, lastAttemptAt: held ? null : now,
    retryAt: held ? null : later(now, WEB_LEAD_CLAIM_MS), lastError: null, abandonReason: null, abandonedAt: null,
    contactId: null, opportunityId: null, createdContactId: null, delayedTag: null, opportunitySkipped: null, syncedAt: null, relayStatus: null,
    funnelEventId: event ? event.id : null,
  };
  try {
    await store.commit([{ collection: WEB_LEAD_RECEIPTS, id: inquiryId, patch: receipt }, ...(event ? [{ collection: event.collection, id: event.id, patch: event.patch }] : [])]);
  } catch (error) {
    // A concurrent copy of the same submission, or a lost response: the stored receipt decides.
    let row = null;
    try { row = await store.read(WEB_LEAD_RECEIPTS, inquiryId); }
    catch {
      if (held) return { fallback: true };
      // The create-only commit was refused, so a copy of this submission already holds the
      // receipt and delivers the lead (its sync and its one text). A direct sync here would
      // text the customer twice: send the client back to replay the receipt instead.
      if (error?.code === 'web_lead_revision_conflict') return { status: 503, body: { ok: false, code: 'web_lead_receipt_busy', error: 'This inquiry is already being received. Send it again in a moment to check on it.' } };
      return { fallback: true, ownedElsewhere: async () => {
        // Our own claim, no receipt or no answer: this request stays the one that relays (the legacy rule).
        // The cron claims a receipt only 10 minutes after it was written, long after this request ends.
        let current = null;
        try { current = await store.read(WEB_LEAD_RECEIPTS, inquiryId); } catch { return ''; }
        return current && current.claimId !== claimId ? String(current.ghlSyncStatus || 'syncing') : '';
      }, settleDelivered: async (result, relayed) => {
        const failure = result?.configured === false ? fail('highlevel_not_configured', 'HighLevel is not configured.') : null;
        return await settle(store, inquiryId, claimId, current => ({ ...outcomePatch(current, now, result, failure), relayStatus: relayStatusOf(relayed) })) && !failure;
      } };
    }
    if (!row) return { fallback: true };
    if (held || row.claimId !== claimId) return replay(row, meta);
  }
  if (held) return { status: 202, body: { ok: true, inquiryId, accepted: true, held, receipt: { status: 'held' } } };

  const { result, error, threw } = await attemptSync(sync, syncLead);
  // The relay goes out once, from this request, only when the sync did not throw (the legacy rule).
  const relayed = threw ? null : await relay();
  // Client hub help has no Web3Forms copy. A message nothing will retry (no sealed
  // payload), or one HighLevel refused outright (a 4xx other than 408/429, which a
  // retry would only repeat until it is abandoned ~45 hours later), answers as the
  // legacy relay did, so the customer sees the failure and can resend or call. A
  // refused one is abandoned at once, so no late retry duplicates the resend; but
  // only once that is saved. If the settle fails, the receipt is still due, the
  // cron owns it and will retry it, so the answer is 202 queued instead.
  const hubHelpFailed = Boolean(error) && meta.formSource === 'client_hub_help';
  const stopReason = hubHelpFailed && sealed && error.code === 'highlevel_rejected' ? 'highlevel_rejected' : null;
  const settled = await settle(store, inquiryId, claimId, row => ({ ...outcomePatch(row, now, result, error, stopReason), relayStatus: relayStatusOf(relayed) }));
  // Without a sealed payload even an unsaved settle leaves nothing to retry (the cron abandons it unsynced).
  const legacyAnswer = hubHelpFailed && (!sealed || (Boolean(stopReason) && settled));
  const highlevel = result ? { configured: result.configured, synced: result.synced === true && !error, consentTag: result.consentTag || '', consentTagSynced: result.consentTagSynced !== false } : { configured: true, synced: false };
  if (error) {
    if (legacyAnswer) {
      if (threw) return { status: 502, body: { ok: false, error: 'HighLevel lead sync failed' } };
      if (!relayed?.sent) return { status: 503, body: { ok: false, error: 'Lead destinations are not configured' } };
    }
    return { status: 202, body: { ok: true, inquiryId, accepted: true, receipt: { status: sealed ? 'failed' : 'abandoned' }, highlevel: { ...highlevel, retry: sealed ? 'scheduled' : 'unavailable' }, ...(relayed ? { relay: relayed } : {}) } };
  }
  return { status: 200, body: { ok: true, inquiryId, receipt: { status: 'synced' }, highlevel, relay: relayed } };
}

/**
 * One bounded retry pass for the signed messaging tick. deps: {store, env,
 * sync(lead, {delayed, createdContactId, timeLeft}), open?, budget(),
 * charge(cost), claimId(), elapsed() (ms since the tick started)}. Nothing runs
 * during Denver quiet hours (a HighLevel sync can start its instant-reply
 * workflow), no new retry starts once the tick is windowMs old, and a retry's
 * HighLevel calls and settle rounds keep to the tick limits above (see
 * WEB_LEAD_RETRY_WINDOW_MS). The same pass deletes
 * sealed payloads kept past their retention. The summary's `held` counts ads
 * leads the closed ads gate stopped: their receipts are abandoned as
 * ads_relay_disabled, but they are the owner's choice, not sync failures, so
 * `abandoned` counts only the others.
 */
export async function retryWebLeadReceipts(deps, { now, dryRun = false, limit = WEB_LEAD_RETRY_LIMIT, windowMs = WEB_LEAD_RETRY_WINDOW_MS } = {}) {
  const { store, env, sync, open = openWebLead, budget = () => Infinity, charge = () => {}, claimId = () => crypto.randomUUID(), elapsed = () => 0 } = deps;
  const at = new Date(now), iso = at.toISOString();
  const summary = { at: iso, dryRun, due: 0, attempted: 0, synced: 0, failed: 0, abandoned: 0, held: 0, purged: 0, skipped: 0, notAttempted: 0 };
  if (!quietHoursDecision(at).allowed) return { ...summary, deferred: 'quiet_hours' };
  if (budget() < 1 + WEB_LEAD_RETRY_COST) return { ...summary, deferred: 'subrequest_budget' };
  if (elapsed() >= windowMs) return { ...summary, deferred: 'time_window' };
  charge(1);
  const due = await store.dueReceipts(iso, limit);
  summary.due = due.length;
  for (const row of due) {
    const purge = row.ghlSyncStatus === 'abandoned' && Boolean(row.sealedPayload);
    if (!(PENDING.has(row.ghlSyncStatus) || purge) || typeof row.retryAt !== 'string' || row.retryAt > iso) { summary.skipped += 1; continue; }
    if (dryRun) { summary.notAttempted += 1; continue; }
    if (elapsed() >= windowMs) { summary.notAttempted += 1; summary.timeLimited = true; continue; }
    if (purge) {
      if (budget() < 1) { summary.notAttempted += 1; continue; }
      charge(1);
      try { await store.commit([{ collection: WEB_LEAD_RECEIPTS, id: row.id, revision: row.revision, patch: { sealedPayload: null, retryAt: null, payloadPurgedAt: iso } }]); summary.purged += 1; }
      catch { summary.skipped += 1; }
      continue;
    }
    if (budget() < WEB_LEAD_RETRY_COST) { summary.notAttempted += 1; continue; }
    charge(WEB_LEAD_RETRY_COST);
    // The ads gate is re-checked: an ads lead accepted while it was open is not
    // synced once it has closed. It is abandoned like any lead the Hub gives up
    // on, so its sealed payload is kept for the owner for the retention period.
    const held = webLeadHeld(env, { formSource: row.formSource });
    const stop = held && row.sealedPayload ? abandon(row, iso, held)
      : !row.sealedPayload ? abandon(row, iso, 'payload_unavailable')
      : row.attempts >= WEB_LEAD_MAX_ATTEMPTS ? abandon(row, iso, 'attempts_exhausted') : null;
    const claim = claimId();
    try {
      await store.commit([{ collection: WEB_LEAD_RECEIPTS, id: row.id, revision: row.revision, patch: stop || { ghlSyncStatus: 'syncing', claimId: claim, attempts: (Number(row.attempts) || 0) + 1, lastAttemptAt: iso, retryAt: later(iso, WEB_LEAD_CLAIM_MS) } }]);
    } catch { summary.skipped += 1; continue; }
    if (stop) { summary[stop.abandonReason === HOLD_ADS ? 'held' : 'abandoned'] += 1; continue; }
    summary.attempted += 1;
    let lead = null;
    try { lead = await open(env, row.id, row.sealedPayload); } catch { lead = null; }
    const createdContactId = typeof row.createdContactId === 'string' ? row.createdContactId : '';
    // Its HighLevel calls end by the deadline; each further settle round only starts while it fits before the tick limit.
    const timeLeft = () => WEB_LEAD_HIGHLEVEL_DEADLINE_MS - elapsed(), roundFits = () => elapsed() + WEB_LEAD_SETTLE_ROUND_MS <= WEB_LEAD_TICK_LIMIT_MS;
    const { result, error } = lead ? await attemptSync(value => sync(value, { delayed: true, createdContactId, timeLeft }), lead) : { error: fail('web_lead_payload_unreadable', 'The sealed lead could not be opened.') };
    const unreadable = !lead;
    await settle(store, row.id, claim, current => unreadable ? abandon(current, iso, 'payload_unreadable', { lastError: 'web_lead_payload_unreadable', lastAttemptAt: iso }) : outcomePatch(current, iso, result, error), WEB_LEAD_RETRY_SETTLE_ROUNDS, roundFits);
    if (!error) summary.synced += 1; else if (unreadable || (Number(row.attempts) || 0) + 1 >= WEB_LEAD_MAX_ATTEMPTS) summary.abandoned += 1; else summary.failed += 1;
  }
  return summary;
}

/** The messaging cron's retry hook: null (nothing runs) unless the ledger is on and Firestore is configured. */
export function webLeadRetryRunner(env, { storage = webLeadStorage, sync = (lead, options) => syncHighLevelLead(env, lead, undefined, options) } = {}) {
  if (!webLeadLedgerOn(env)) return null;
  const store = storage(env);
  return ({ now, dryRun, budget, charge, elapsed }) => retryWebLeadReceipts({ store, env, sync, budget, charge, elapsed }, { now, dryRun });
}

function decode(document) {
  const prefix = `/documents/${WEB_LEAD_RECEIPTS}/`, name = document?.name;
  const id = typeof name === 'string' && name.includes(prefix) ? name.slice(name.indexOf(prefix) + prefix.length) : '';
  if (!webLeadInquiryId(id) || typeof document.updateTime !== 'string' || !document.updateTime) throw fail('web_lead_storage_incomplete', 'A website lead receipt could not be verified.');
  return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
}

function storageError(error) {
  if (/^web_lead_/.test(error?.code || '')) return error;
  if (error?.code === 'dispatch_revision_conflict') return fail('web_lead_revision_conflict', 'The website lead receipt changed.', 409);
  if (error?.code === 'dispatch_outcome_unknown') return fail('web_lead_outcome_unknown', 'The website lead receipt write could not be confirmed.');
  return fail('web_lead_storage_unavailable', 'Website lead receipts are unavailable.');
}

/** read/commit over dispatchStorage (revision = updateTime; no revision = create-only) plus the due-retry query. */
export function webLeadStorage(env, fetcher = firestoreFetch) {
  const base = dispatchStorage(env, fetcher);
  const wrap = method => async (...args) => { try { return await method(...args); } catch (error) { throw storageError(error); } };
  return {
    read: wrap(base.read), commit: wrap(base.commit),
    // Only receipts with work left (a retry, or a kept payload to delete) carry a retryAt, so a single-field range needs no composite index.
    async dueReceipts(nowIso, limit = WEB_LEAD_RETRY_LIMIT) {
      let response;
      try {
        response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: WEB_LEAD_RECEIPTS }],
          where: { fieldFilter: { field: { fieldPath: 'retryAt' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: nowIso } } },
          orderBy: [{ field: { fieldPath: 'retryAt' }, direction: 'ASCENDING' }], limit,
        } }) });
      } catch { throw fail('web_lead_storage_unavailable', 'Website lead receipts are unavailable.'); }
      if (!response.ok) throw fail('web_lead_storage_unavailable', 'Website lead receipts are unavailable.');
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows)) throw fail('web_lead_storage_incomplete', 'Website lead receipts returned an incomplete list.');
      return rows.filter(row => row?.document).map(row => decode(row.document));
    },
  };
}
