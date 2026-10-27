import { firestoreFetch } from './firebase-service-account.js';
import { approvedEmployeeProfiles, employeeAccountsConfigured } from './employee-accounts.js';
import { hasBusinessAccess, listHubAccessProfiles } from './hub-session.js';
import { createJobAssignmentAccess } from './job-assignment.js';
import { open, opaqueId, seal } from './employee-vault.js';
import { PUSH_GONE, pushEndpoint, pushSubscription, sendWebPush, vapidKeys } from './web-push.js';

/* CREW-PUSH (EGC_CREW_CHAT_PUSH): a crew-chat message saved through /api/employee-hub alerts the phones of the people
   allowed to read it, even with the Hub closed or the phone locked. Exactly "true" turns it on, and only together with
   HUB_OFFLINE_ENABLED (the installable Hub whose worker, hub-sw.js, shows the alert) and both VAPID keys; anything else
   leaves chat as it was (alerts only while the Hub is open).
   Who: the general room goes to every current staff account, a job room to its assigned crew and managers (the same
   rule /api/employee-hub uses to show the room), never to the sender. Each recipient is checked against today's roster
   when the message is sent, so a deactivated account or a crew member taken off the job gets nothing.
   What: the lock screen shows the sender's name and the room (General crew chat, or a job room and its date), never the
   message text or the customer's name, because anyone near the phone can read it.
   Where kept: one sealed document per browser subscription in employee_push_subscriptions (server-only, like the
   employee vault, under the same key), so the Hub's polls never read them: they are read once per message sent.
   A subscription the push service answers 404 or 410 for is deleted. */
export const crewChatPushSwitch = env => env?.EGC_CREW_CHAT_PUSH === 'true';
export const crewChatPushEnabled = env => crewChatPushSwitch(env) && env?.HUB_OFFLINE_ENABLED === 'true' && Boolean(vapidKeys(env));

const PROJECT_ID = 'egcw-1ec83';
const DOCUMENTS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
export const PUSH_COLLECTION = 'employee_push_subscriptions';
const RECORD_TYPE = 'employee_push_v1';
// The vault's document-id namespace for subscriptions (opaqueId '<namespace>:<endpoint>'): a storage contract.
const NAMESPACE = 'pushSubscriptions';
// A message reaches at most this many devices per person (their newest) and this many in all, so one account cannot
// make a single message fan out without bound.
const PER_PERSON = 5, MAX_SENDS = 200, BATCH = 20;
// Who the VAPID sender is (RFC 8292 sub): the business site, so a push service can reach the operator.
const SUBJECT = 'https://easygaragecleaning.com';
const key = value => String(value ?? '').trim().toLowerCase();
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringField = value => ({ stringValue: String(value ?? '') });

async function documentFor(env, endpoint) {
  return opaqueId(env, NAMESPACE, endpoint);
}

/** Saves (or moves to this person) one browser subscription. Returns the stored record. */
export async function saveCrewPushSubscription(env, user, value, { now = new Date(), fetcher = firestoreFetch } = {}) {
  const subscription = pushSubscription(value);
  if (!subscription || !key(user)) throw Object.assign(new Error('This alert subscription is not valid'), { status: 400 });
  const documentId = await documentFor(env, subscription.endpoint), at = now.toISOString();
  const record = { id: documentId, user: String(user).trim(), ...subscription, updatedAt: at };
  const sealed = await seal(env, documentId, record);
  const response = await fetcher(env, `${DOCUMENTS}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: [{ update: {
    name: `projects/${PROJECT_ID}/databases/(default)/documents/${PUSH_COLLECTION}/${documentId}`,
    fields: { recordType: stringField(RECORD_TYPE), sealedPayload: stringField(sealed.payload), sealedIv: stringField(sealed.iv), vaultId: stringField(documentId), updatedAt: stringField(at) },
  } }] }) });
  if (!response.ok) throw new Error(`Alert subscription could not be saved (${response.status})`);
  return record;
}

async function deleteDocument(env, documentId, fetcher) {
  const response = await fetcher(env, `${DOCUMENTS}/${PUSH_COLLECTION}/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Alert subscription could not be removed (${response.status})`);
}

/** Every stored subscription that opens with this key. One that does not (a malformed or foreign row) is skipped. */
export async function listCrewPushSubscriptions(env, { fetcher = firestoreFetch } = {}) {
  const response = await fetcher(env, `${DOCUMENTS}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: PUSH_COLLECTION }], limit: 1000 } }) });
  if (!response.ok) throw new Error(`Alert subscriptions could not be read (${response.status})`);
  const rows = await response.json().catch(() => []);
  const records = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const fields = row?.document?.fields, documentId = String(row?.document?.name || '').split('/').pop();
    if (!fields || fields.recordType?.stringValue !== RECORD_TYPE || fields.vaultId?.stringValue !== documentId) continue;
    try {
      const data = await open(env, documentId, fields.sealedIv?.stringValue, fields.sealedPayload?.stringValue);
      const subscription = pushSubscription(data);
      if (isRecord(data) && data.id === documentId && subscription && key(data.user) && await documentFor(env, subscription.endpoint) === documentId) records.push({ ...subscription, id: documentId, user: data.user, updatedAt: String(data.updatedAt || '') });
    } catch { /* not ours to send to */ }
  }
  return records;
}

/** Removes this person's subscription for one endpoint (sign-out, alerts turned off). Another person's is left alone. */
export async function removeCrewPushSubscription(env, user, endpoint, { fetcher = firestoreFetch } = {}) {
  const url = pushEndpoint(endpoint);
  if (!url) return false;
  const documentId = await documentFor(env, url);
  const response = await fetcher(env, `${DOCUMENTS}/${PUSH_COLLECTION}/${encodeURIComponent(documentId)}`);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Alert subscription could not be read (${response.status})`);
  const fields = (await response.json().catch(() => ({})))?.fields || {};
  let data = null;
  try { data = await open(env, documentId, fields.sealedIv?.stringValue, fields.sealedPayload?.stringValue); } catch { /* unreadable: leave it */ }
  if (!data || key(data.user) !== key(user)) return false;
  await deleteDocument(env, documentId, fetcher);
  return true;
}

// Today's staff, as sessions: the configured Hub users, stored managers (EGC_STAFF_ROLE_ACCESS) with their business
// access, and every approved employee account. An unreadable account list leaves the employee accounts out.
async function staffRoster(env) {
  const roster = new Map();
  for (const profile of await listHubAccessProfiles(env).catch(() => [])) roster.set(key(profile.user), profile);
  if (employeeAccountsConfigured(env)) {
    for (const profile of await approvedEmployeeProfiles(env).catch(() => [])) if (!roster.has(key(profile.user))) roster.set(key(profile.user), profile);
  }
  return roster;
}

const jobDay = date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  try { return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch { return ''; }
};

/** What the lock screen shows for a message: sender and room only. */
export function crewChatAlert(message, job = null) {
  const sender = String(message?.senderName || message?.sender || 'Someone').trim().slice(0, 60) || 'Someone';
  const room = job ? `job:${job.id}` : 'team', day = job ? jobDay(job.date) : '';
  return { title: 'EGC crew chat', body: job ? `${sender} posted in a job room${day ? ` (${day})` : ''}` : `${sender} posted in General crew chat`, tag: String(message?.id || room).slice(0, 180), view: 'crew_chat', room };
}

/** The subscriptions a message goes to: allowed to read its room, current staff, not the sender, newest few per person. */
export async function crewChatRecipients(env, { message, job = null, subscriptions, roster }) {
  const sender = key(message?.sender), byPerson = new Map();
  for (const subscription of subscriptions) {
    const person = key(subscription.user);
    if (!person || person === sender || !roster.has(person)) continue;
    if (!byPerson.has(person)) byPerson.set(person, []);
    byPerson.get(person).push(subscription);
  }
  const chosen = [];
  for (const [person, rows] of byPerson) {
    const profile = roster.get(person);
    if (job && !hasBusinessAccess(profile) && !await createJobAssignmentAccess(env, profile).assigned(job)) continue;
    chosen.push(...rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, PER_PERSON));
  }
  return chosen.slice(0, MAX_SENDS);
}

/** Sends the alerts for one newly saved chat message. Never throws: a failed alert never fails the message. */
export async function sendCrewChatPush(env, { collection, message, readJob, now = () => Date.now(), pushFetch = (...args) => fetch(...args), fetcher = firestoreFetch } = {}) {
  const outcome = { sent: 0, gone: 0, failed: 0 };
  try {
    const keys = vapidKeys(env);
    if (!crewChatPushEnabled(env) || !keys || !['teamMessages', 'jobMessages'].includes(collection) || !isRecord(message)) return outcome;
    const job = collection === 'jobMessages' ? await readJob(env, message.jobId) : null;
    if (collection === 'jobMessages' && !job) return outcome;
    const subscriptions = await listCrewPushSubscriptions(env, { fetcher });
    if (!subscriptions.length) return outcome;
    const recipients = await crewChatRecipients(env, { message, job, subscriptions, roster: await staffRoster(env) });
    const payload = JSON.stringify(crewChatAlert(message, job));
    for (let at = 0; at < recipients.length; at += BATCH) {
      await Promise.all(recipients.slice(at, at + BATCH).map(async subscription => {
        try {
          const status = await sendWebPush(keys, subscription, payload, { subject: SUBJECT, now: now(), fetcher: pushFetch });
          if (status >= 200 && status < 300) outcome.sent++;
          else if (PUSH_GONE.has(status)) { outcome.gone++; await deleteDocument(env, subscription.id, fetcher).catch(() => {}); }
          else outcome.failed++;
        } catch { outcome.failed++; }
      }));
    }
  } catch (error) {
    outcome.failed++;
    console.warn('Crew chat alerts were not sent:', String(error?.message || error).slice(0, 200));
  }
  return outcome;
}
