/**
 * EGC Website Lead relay — Cloudflare Pages Function
 * POST /api/web-lead
 *
 * The quote forms POST natively to Web3Forms (the email leg). fb-capture.js
 * mirrors the same submission here. This function writes the lead directly to
 * HighLevel, then forwards it to the existing Zapier instant-text/CAPI hook.
 *
 * The Zap then fires the team SMS alert + Meta CAPI Lead, and — once you add an
 * "AI by Zapier" step + an OpenPhone "Send Message" step — texts the lead back
 * in Tyler's voice, exactly like the Facebook flow (which uses Zapier's free
 * built-in AI and your existing OpenPhone connection — no API keys anywhere).
 *
 * To make that Zap setup trivial, the relay hands it three ready-to-use fields:
 *   lead_first_name  — first name only (for the greeting)
 *   lead_timing      — "in-hours" or "out-of-hours" (Mon–Sat 07:00–19:00 MT),
 *                      computed server-side so the AI step needs no Formatter
 *   lead_phone_e164  — the lead's number in +1XXXXXXXXXX form (OpenPhone "To")
 * plus the usual name/phone/items/source/subject and Meta fbc/fbp/fbclid, and
 * inquiry_id (the browser Meta Lead eventID, for CAPI deduplication).
 *
 * FUN-13: with WEB_LEAD_RECEIPTS_ENABLED=true the lead is first recorded in the
 * server-only web_lead_receipts ledger (with its inquiry.received funnel event)
 * and a failed HighLevel sync is retried by the signed messaging cron instead of
 * being lost. A retried sync reaches HighLevel like an on-time one, so no
 * HighLevel change is needed (WEB_LEAD_DELAYED_SYNC_TAG=true optionally tags it
 * egc-delayed-sync). Ads landing page leads (which never reached this relay
 * before) are only synced once WEB_LEAD_ADS_RELAY_ENABLED=true.
 *
 * Config (Cloudflare Pages → Variables and Secrets, PRODUCTION):
 *   WEBSITE_LEAD_HOOK_URL — Zapier Catch Hook URL.
 */

import { webLeadTiming } from '../_lib/funnel-calendar.js';
import { WEB_LEAD_FIELDS, envVar, highLevelConfig, receiveWebLead, syncHighLevelLead, webLeadHeld, webLeadInquiryId, webLeadLedgerOn, webLeadMeta, webLeadStorage } from '../_lib/web-lead-intake.js';

const ALLOWED_HOST_RE = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const MAX_BODY = 32 * 1024;

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

function resolveHook(env) {
  return envVar(env, 'WEBSITE_LEAD_HOOK_URL');
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  if (!origin && !referer) return true;
  return ALLOWED_HOST_RE.test(hostOf(origin) || hostOf(referer));
}

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length > 11) return '+' + d;
  return '';
}

// Mon–Sat 07:00–19:00 Mountain from the shared FUN-01 business calendar
// (holidays not applied, so the Zap sees exactly the legacy value). Fails to
// "in-hours" (better to promise a call "in a couple minutes" than to wrongly
// promise tomorrow).
function leadTiming(now) {
  return webLeadTiming(now);
}

// The relay fields in their legacy order; inquiry_id only when there is one.
function relayFields(body, name, phone, inquiryId, now) {
  const params = new URLSearchParams();
  const flat = {};
  for (const k of WEB_LEAD_FIELDS) {
    const v = String(body[k] || '').trim();
    flat[k] = v;
    if (v) params.set(k, v);
  }
  if (inquiryId) { flat.inquiry_id = inquiryId; params.set('inquiry_id', inquiryId); }
  // Ready-to-map fields for the Zap's AI + OpenPhone steps.
  const extras = {
    lead_first_name: name.split(/\s+/)[0] || '',
    lead_timing: leadTiming(now),
    lead_phone_e164: normalizePhone(phone),
  };
  for (const [k, v] of Object.entries(extras)) {
    flat[k] = v;
    if (v) params.set(k, v);
  }
  return { flat, params };
}

async function relayLead(hook, flat, params) {
  const relayAllowed = flat.sms_consent === 'yes';
  let relay = { configured: !!hook, sent: false, skipped: hook && !relayAllowed ? 'no-sms-consent' : '' };
  if (hook && relayAllowed) {
    try {
      const resp = await fetch(hook + (hook.includes('?') ? '&' : '?') + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flat),
      });
      relay = { configured: true, sent: resp.ok };
    } catch { relay = { configured: true, sent: false }; }
  }
  return relay;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// A count-only marker for leads delivered without a receipt: no lead data, ever.
const RECEIPT_UNAVAILABLE = JSON.stringify({ event: 'web_lead_receipt_unavailable' });

export function webLeadHandlers({ storage = webLeadStorage, now = () => new Date(), sync = syncHighLevelLead, warn = message => console.warn(message) } = {}) {
  async function post({ request, env }) {
    const json = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });

    if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

    let body;
    try { body = JSON.parse(raw); }
    catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'Invalid JSON' });

    // Honeypot tripped — answer success so bots learn nothing, forward nothing.
    if (body.botcheck) return json(200, { ok: true });

    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    if (!name || phone.replace(/\D/g, '').length < 7) {
      return json(400, { ok: false, error: 'name and phone required' });
    }

    const at = now();
    const hook = resolveHook(env);
    const ledger = webLeadLedgerOn(env);
    // The browser's inquiry id makes a resent submission the same inquiry; the ledger assigns one when it is missing.
    const inquiryId = webLeadInquiryId(body.inquiry_id) || (ledger ? crypto.randomUUID() : '');
    const { flat, params } = relayFields(body, name, phone, inquiryId, at);
    const meta = webLeadMeta(flat, { name, phone });
    const held = webLeadHeld(env, meta);
    const lead = { name, phone, flat };

    let receipt = null, settleDelivered = null, ownedElsewhere = null;
    const unavailable = () => { try { warn(RECEIPT_UNAVAILABLE); } catch {} };
    if (ledger) {
      let result;
      try {
        result = await receiveWebLead({ store: storage(env), env, now: at.toISOString(), sync: value => sync(env, value), relay: () => relayLead(hook, flat, params) }, { lead, inquiryId, clientInquiryId: webLeadInquiryId(body.inquiry_id) === inquiryId, meta, held });
      } catch { result = { fallback: true }; }
      if (!result.fallback) return json(result.status, result.body);
      // Nothing was sent yet: deliver the legacy way and say the receipt is missing.
      // Such a lead has no receipt or inquiry.received event (FUN-25 reconciles against HighLevel).
      receipt = { status: 'unavailable' };
      // A receipt commit that could not be confirmed may still have landed: that is settled after the sync.
      if (typeof result.settleDelivered === 'function') {
        settleDelivered = result.settleDelivered;
        if (typeof result.ownedElsewhere === 'function') ownedElsewhere = result.ownedElsewhere;
      } else unavailable();
    }
    // Ads landing page leads stay out of HighLevel and the text relay until the owner opens them (they still arrive by Web3Forms email).
    if (held) return json(202, { ok: true, accepted: true, held, ...(inquiryId ? { inquiryId } : {}), ...(receipt ? { receipt } : {}) });

    let highlevel;
    try { highlevel = await sync(env, { ...flat, name, phone, source: flat.source || 'EGC Website' }); }
    catch {
      // A receipt that did land stays due, so the cron retries this lead.
      if (settleDelivered) unavailable();
      return json(502, { ok: false, error: 'HighLevel lead sync failed' });
    }

    const highlevelAnswer = { configured: highlevel.configured, synced: highlevel.synced, consentTag: highlevel.consentTag || '', consentTagSynced: highlevel.consentTagSynced !== false };
    if (ownedElsewhere) {
      // The unconfirmed receipt commit may have lost to a concurrent copy of this submission (a double
      // tap or an fb-capture resend) that holds the receipt: that copy sends the one text, so this one
      // does not, and the customer is never texted twice. The lead has its receipt, so no marker either.
      let ownerStatus = '';
      try { ownerStatus = await ownedElsewhere(); } catch {}
      if (ownerStatus) return json(200, { ok: true, inquiryId, receipt: { status: ownerStatus }, highlevel: highlevelAnswer, relay: { configured: !!hook, sent: false, skipped: 'already-received' } });
    }
    const relay = await relayLead(hook, flat, params);
    if (settleDelivered) {
      // Marking a receipt that landed after all keeps the cron from syncing this lead a second time.
      let settled = false;
      try { settled = await settleDelivered(highlevel, relay); } catch {}
      if (settled) receipt = { status: 'synced' };
      else unavailable();
    }
    if (!highlevel.configured && !relay.sent) return json(503, { ok: false, error: 'Lead destinations are not configured' });
    return json(200, { ok: true, ...(receipt ? { inquiryId, receipt } : {}), highlevel: highlevelAnswer, relay });
  }

  // Health/config probe — reports whether the hook is wired (boolean only).
  async function get({ env }) {
    const highlevel = highLevelConfig(env);
    return new Response(JSON.stringify({ ok: true, configured: !!resolveHook(env) || Boolean(highlevel.token && highlevel.locationId), highlevel: Boolean(highlevel.token && highlevel.locationId), relay: !!resolveHook(env) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return { post, get };
}

const handlers = webLeadHandlers();
export const onRequestPost = handlers.post;
export const onRequestGet = handlers.get;
