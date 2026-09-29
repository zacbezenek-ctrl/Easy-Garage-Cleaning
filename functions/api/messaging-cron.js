/* Signed tick from the Railway messaging worker. Only the worker's service
   identity can run it: a v2 service envelope bound to this exact path, a
   single-use nonce, the EGC workspace and the messaging-cron-worker
   integration actor. Browsers never reach it with a usable credential. */
import { operationsAuthMode, operationsEnabled, verifyApiServiceEnvelope } from '../_lib/operations-service-auth.js';
import { createGhlMessenger } from '../_lib/ghl-messenger.js';
import { createApprovedSendService, messagingFlags } from '../_lib/approved-send.js';
import { messagingStorage } from '../_lib/message-send-store.js';
import { messageDigest } from '../_lib/message-templates.js';
import { sendAcceptedQuotePortal } from '../_lib/portal-invitation.js';
import { portalLinkProviders } from '../_lib/message-links.js';
import { serverMessagingEnabled } from '../_lib/messaging-settings.js';
import { CLAIM_COST, CRON_ACTOR_ID, finishRun, runDueMessages, startRun } from '../_lib/messaging-scheduler.js';
import { crewNotificationDeps } from '../_lib/crew-notification-delivery.js';
import { webLeadRetryRunner } from '../_lib/web-lead-intake.js';
import { jobberGuardSends } from '../_lib/jobber-guard.js';

export const MESSAGING_CRON_PATH = '/api/messaging-cron';
const MAX_BYTES = 32000;
const COMMAND_KEYS = ['command', 'dryRun'];
// Signature key discovery and the nonce claim run before the meter starts.
const VERIFY_COST = 4;
const DEFAULT_BUDGET = 45;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const budgetOf = env => { const value = Number(env?.EGC_MESSAGING_SUBREQUEST_BUDGET); return (Number.isInteger(value) && value >= 30 && value <= 9500 ? value : DEFAULT_BUDGET) - VERIFY_COST; };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = (status, code, error) => reply(status, { ok: false, code, error });

function metered(store, messenger, limit) {
  let used = 0;
  const count = (fn, cost = 1) => typeof fn === 'function' ? (...args) => { used += cost; return fn(...args); } : fn;
  return {
    store: {
      ...store, read: count(store.read), commit: count(store.commit), roster: count(store.roster, 2),
      jobRecords: async (...args) => { const rows = await store.jobRecords(...args); used += Math.max(1, Math.ceil(rows.length / 500)); return rows; },
    },
    messenger: { ...messenger, resolveRecipient: count(messenger.resolveRecipient, 2), send: count(messenger.send) },
    left: () => limit - used, charge: cost => { used += cost; },
  };
}

function authFailure(error) {
  const code = String(error?.code || '');
  if (code === 'operations_not_enabled' || code === 'service_signing_not_configured') return failure(503, 'messaging_cron_not_configured', 'Signed service requests are not configured for the Hub.');
  if (error?.status === 409) return failure(409, 'messaging_cron_replayed', 'This signed request was already used. Sign a new request.');
  if (error?.status === 401 || error?.message === 'Unauthorized') return failure(401, 'messaging_cron_unauthorized', 'The signed service request could not be verified.');
  return failure(503, 'messaging_cron_unavailable', 'The signed service request could not be checked. Retry with a new signature.');
}

export function messagingCronHandlers({
  verify = verifyApiServiceEnvelope, storage = messagingStorage, messenger = env => createGhlMessenger({ env }), now = () => new Date(),
  portalInvite = env => jobId => sendAcceptedQuotePortal(env, jobId, { requireRequested: true }),
  links = (env, { store, clock }) => portalLinkProviders({ env, read: id => store.read('jobs', id), now: () => clock().getTime() }),
  options = () => ({}), crewOutbox = () => null, webLeads = env => webLeadRetryRunner(env), jobberGuard = jobberGuardSends,
  // EGC_CREW_NOTIFICATIONS_ENABLED: the dispatch crew-notice outbox and its send hooks (null when off).
  crew = crewNotificationDeps,
} = {}) {
  return {
    async get() { return failure(405, 'messaging_cron_method_not_allowed', 'Use a signed POST from the EGC worker.'); },
    async post({ request, env }) {
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'messaging_cron_json_required', 'Signed service requests must be JSON.');
      if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return failure(413, 'messaging_cron_request_too_large', 'The signed service request is too large.');
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return failure(413, 'messaging_cron_request_too_large', 'The signed service request is too large.');
      let body; try { body = JSON.parse(raw); } catch { return failure(400, 'messaging_cron_json_invalid', 'The signed service request was incomplete.'); }
      if (!object(body) || Object.keys(body).length !== 1 || typeof body.envelope !== 'string') return failure(400, 'messaging_cron_request_invalid', 'Send exactly one signed envelope.');
      // The legacy shared-secret envelope has no path binding or nonce, so it
      // can never authorize automatic customer messages.
      let v2 = false; try { v2 = operationsEnabled(env) && operationsAuthMode(env) === 'v2'; } catch {}
      if (!v2) return failure(503, 'messaging_cron_not_configured', 'Signed service requests are not configured for the Hub.');
      const started = now();
      let claims;
      try { claims = await verify(env, body.envelope, MESSAGING_CRON_PATH, { now: started.getTime() }); } catch (error) { return authFailure(error); }
      const actor = claims?.actor, workspace = env.EGC_OPERATIONS_WORKSPACE || 'egc';
      if (claims?.v !== 2 || claims.path !== MESSAGING_CRON_PATH) return failure(401, 'messaging_cron_unauthorized', 'The signed service request could not be verified.');
      if (actor?.workspace !== workspace) return failure(403, 'messaging_cron_forbidden', 'This workspace cannot run the messaging schedule.');
      if (actor.id !== CRON_ACTOR_ID || actor.kind !== 'integration' || actor.role !== 'integration') return failure(403, 'messaging_cron_forbidden', 'Only the messaging worker can run the messaging schedule.');
      const command = claims.request?.body;
      if (!object(command) || Object.keys(command).some(key => !COMMAND_KEYS.includes(key)) || command.command !== 'messaging.run' || (command.dryRun !== undefined && typeof command.dryRun !== 'boolean')) return failure(400, 'messaging_cron_command_invalid', 'Use messaging.run with an optional dryRun flag.');
      const dryRun = command.dryRun === true, budget = budgetOf(env), retryLeads = webLeads(env);
      // FUN-13: website-lead receipts whose HighLevel sync failed retry on this
      // tick whether or not server messaging is on. They run after the reminder
      // run, from what it left (at most a third of the budget), and start no new
      // retry once the tick is 30 s old.
      const withLeads = async (body, left = budget) => {
        if (!retryLeads) return body;
        let used = 0, leads;
        try { leads = await retryLeads({ now: started, dryRun, budget: () => Math.min(left, Math.floor(budget / 3)) - used, charge: cost => { used += cost; }, elapsed: () => now().getTime() - started.getTime() }); }
        catch { leads = { error: 'web_lead_retry_unavailable' }; }
        return { ...body, webLeads: leads };
      };
      // Until the owner turns server messaging on, the Hub's legacy browser
      // triggers own these reminders; only dry runs may inspect the schedule.
      if (!dryRun && !serverMessagingEnabled(env)) return reply(409, await withLeads({ ok: false, code: 'messaging_cron_disabled', error: 'Server messaging is turned off. Nothing was sent.' }));
      try {
        const meter = metered(storage(env), messenger(env), budget), store = meter.store, flags = messagingFlags(env);
        const runId = claims.request.requestId.toLowerCase(), attemptId = crypto.randomUUID(), fingerprint = await messageDigest({ scope: 'messaging_cron', actor: actor.id, command });
        const run = await startRun(store, { runId, attemptId, fingerprint, actorId: actor.id, dryRun, at: started.toISOString() });
        if (run.existing) {
          if (run.existing.fingerprint !== fingerprint) return failure(409, 'messaging_idempotency_conflict', 'This request ID was already used for a different run.');
          if (run.existing.status === 'completed') return reply(200, await withLeads({ ok: true, runId, replayed: true, summary: run.existing.summary }, meter.left()));
          if (run.existing.status === 'failed') return reply(503, { ok: false, code: run.existing.code || 'messaging_run_failed', error: 'This run did not finish. Start a new run.', runId });
          return failure(409, 'messaging_run_in_progress', 'This run is still in progress.');
        }
        const reserve = () => { if (meter.left() < CLAIM_COST) throw Object.assign(new Error('This message was not attempted.'), { code: 'messaging_not_attempted', status: 503 }); };
        const notices = crew(env, { store, charge: meter.charge, now: started });
        const linkProviders = { ...(notices?.links || {}), ...links(env, { store, clock: now }) };
        // FUN-32: EGC_JOBBER_GUARD_BILLING / _MESSAGING hold automatic reminders for customers with open Jobber strays.
        const service = await jobberGuard(createApprovedSendService({ store, messenger: meter.messenger, clock: now, env, secret: env?.HUB_SESSION_SECRET || '', links: linkProviders, reserve, ...(notices ? { crewContact: notices.crewContact, crewNotice: notices.crewNotice } : {}), ...options(env) }), { store, env, now: started });
        let summary;
        try {
          summary = await runDueMessages({ store, service, flags, links: linkProviders, portalInvite: portalInvite(env), crewOutbox: notices?.outbox || crewOutbox(env), budget: meter.left, charge: meter.charge }, { now: started, dryRun, requestId: claims.request.requestId });
        } catch (error) {
          const code = /^messaging_[a-z_]+$/.test(error?.code || '') ? error.code : 'messaging_run_failed';
          await finishRun(store, runId, attemptId, { status: 'failed', code, completedAt: now().toISOString() });
          return reply(error?.status && error.status < 500 ? error.status : 503, { ok: false, code, error: code === 'messaging_settings_invalid' ? error.message : 'The messaging schedule could not finish. Nothing more was sent; the next run retries.', runId });
        }
        const saved = await finishRun(store, runId, attemptId, { status: 'completed', completedAt: now().toISOString(), summary });
        return reply(200, await withLeads({ ok: true, runId, summarySaved: saved, summary }, meter.left()));
      } catch {
        return failure(503, 'messaging_cron_unavailable', 'The messaging schedule could not be verified. The next run retries safely.');
      }
    },
  };
}

const handlers = messagingCronHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
