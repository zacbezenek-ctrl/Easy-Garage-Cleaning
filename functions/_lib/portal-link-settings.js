import { hasBusinessAccess } from './hub-session.js';
import { MESSAGING_SETTINGS, MESSAGING_SETTINGS_ID, PORTAL_LINK_ON_AT, PORTAL_LINK_TOGGLES, normalizeMessagingSettings } from './messaging-settings.js';
import { MESSAGE_OPERATIONS } from './message-send-store.js';
import { messageDigest } from './message-templates.js';
import { portalLinkPreviews } from './portal-invitation.js';

/* PORTAL-LINKS: the owner's two switches for the portal link texts (portal-invitation.js 'quote_ready' and 'job_done'),
   kept in the server-only messaging_settings/automation record beside the messaging pause (messaging-settings.js
   portalLinkQuoteReady, portalLinkJobDone; both false by default). Hub → Message templates shows them with the exact
   text each sends; only business users change them, through POST /api/message-templates
   {action:'set_portal_link', requestId, link:'quote_ready'|'job_done', enabled}. Each change is idempotent per
   requestId (message_operations) and written under the record's revision. Turning one on also records when
   (portalLinkQuoteReadyOnAt, portalLinkJobDoneOnAt): a text of that kind still waiting from before is never sent. */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEYS = ['action', 'requestId', 'link', 'enabled'];
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** {quoteReady, jobDone, paused, canChange, texts, error?}: error 'invalid' (the record needs review; every automatic
 * message is held) or 'unavailable' (it could not be read). */
export async function portalLinkSwitches(store, session) {
  let settings = null, error = '';
  try { settings = normalizeMessagingSettings(await store.read(MESSAGING_SETTINGS, MESSAGING_SETTINGS_ID)); }
  catch (problem) { error = problem?.code === 'messaging_settings_invalid' ? 'invalid' : 'unavailable'; }
  return { quoteReady: settings?.portalLinkQuoteReady === true, jobDone: settings?.portalLinkJobDone === true, paused: settings?.paused === true,
    canChange: hasBusinessAccess(session), texts: portalLinkPreviews(), ...(error ? { error } : {}) };
}

export async function setPortalLinkSwitch(store, session, input, now = new Date().toISOString()) {
  if (!session?.user) throw fail('messaging_sign_in_required', 'Sign in to the Employee Hub to change the portal link texts.', 401);
  if (!hasBusinessAccess(session)) throw fail('messaging_portal_link_forbidden', 'Only Zac, Tyler or Alex can turn the portal link texts on or off.', 403);
  if (!object(input) || Object.keys(input).some(key => !KEYS.includes(key)) || input.action !== 'set_portal_link' || !UUID.test(input.requestId || '') || !Object.hasOwn(PORTAL_LINK_TOGGLES, input.link) || typeof input.enabled !== 'boolean')
    throw fail('messaging_request_invalid', 'Choose a portal link text and whether it is on or off.');
  const receiptId = input.requestId.toLowerCase(), fingerprint = await messageDigest({ scope: 'portal_link_switch', actor: session.user, input });
  const prior = await store.read(MESSAGE_OPERATIONS, receiptId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw fail('messaging_idempotency_conflict', 'This request ID was already used for a different change. Refresh before saving.', 409);
    return { ok: true, requestId: input.requestId, replayed: true, portalLinks: await portalLinkSwitches(store, session) };
  }
  const doc = await store.read(MESSAGING_SETTINGS, MESSAGING_SETTINGS_ID);
  // Never write a switch into a record that already needs review: every automatic message is held until it is fixed.
  normalizeMessagingSettings(doc);
  const field = PORTAL_LINK_TOGGLES[input.link];
  if ((doc?.[field] === true) === input.enabled) return { ok: true, requestId: input.requestId, unchanged: true, portalLinks: await portalLinkSwitches(store, session) };
  await store.commit([
    { collection: MESSAGING_SETTINGS, id: MESSAGING_SETTINGS_ID, ...(doc?.revision ? { revision: doc.revision } : {}), patch: { [field]: input.enabled, ...(input.enabled ? { [PORTAL_LINK_ON_AT[input.link]]: now } : {}), portalLinksUpdatedBy: session.user, portalLinksUpdatedAt: now } },
    { collection: MESSAGE_OPERATIONS, id: receiptId, patch: { scope: 'portal_link_switch', fingerprint, actorId: session.user, action: input.action, link: input.link, enabled: input.enabled, requestId: input.requestId, createdAt: now } },
  ]).catch(error => {
    if (error?.code === 'messaging_revision_conflict') throw fail('messaging_settings_revision_conflict', 'The messaging settings changed at the same time. Refresh and try again.', 409);
    throw error;
  });
  return { ok: true, requestId: input.requestId, portalLinks: await portalLinkSwitches(store, session) };
}
