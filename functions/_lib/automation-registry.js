/* FUN-30 automation registry. Every path that can message a customer or fire a
   HighLevel, Zapier or provider automation is recorded in the checked-in data
   file and classified under the approval rule (design §10). Pure: the data is
   read-only, time is injected, and nothing here sends a message or changes a
   live automation. */
import { AUTOMATION_REGISTRY } from './automation-registry-data.js';
import { messageDigest } from './message-templates.js';
import { denverToday, validDate } from './dispatch-time.js';
import { OWNER_USERNAME } from './business-users.js';
import { HUMAN_APPROVALS } from './message-policies.js';

export { AUTOMATION_REGISTRY };
// What the path is under the approval rule. owner_automation: sends by itself
// and needs an owner-approved fixed template. human_approved: a person approves
// each message. customer_initiated: the customer asked for it. internal: never
// reaches a customer. disabled: must not send.
export const CLASSIFICATIONS = Object.freeze(['owner_automation', 'human_approved', 'customer_initiated', 'internal', 'disabled']);
// Today's triage. approved_automatic: it already sends automatically and may
// keep running unchanged (this is not an owner approval of its text; approvedBy
// records that). approved_human: every message is approved by a person or asked
// for by the customer. internal: no customer message. needs_owner_approval: the
// owner must verify or decide before it counts as allowed. retire: recommended
// off; a later unit or the owner turns it off, never this registry.
export const DISPOSITIONS = Object.freeze(['approved_automatic', 'approved_human', 'internal', 'needs_owner_approval', 'retire']);
export const SYSTEMS = Object.freeze(['ghl_workflow', 'ghl_calendar', 'ghl_conversation_ai', 'zapier', 'quo', 'hub', 'stripe', 'emailjs', 'jobber', 'web3forms', 'platform']);
export const CHANNELS = Object.freeze(['SMS', 'Email', 'SMS+Email', 'none', 'unknown']);
export const AUDIENCES = Object.freeze(['customer', 'staff', 'none']);
export const CONTENT_SOURCES = Object.freeze(['fixed_template', 'provider_template', 'message_templates', 'human_authored', 'ai_generated', 'none', 'unknown']);
export const SENDS_TODAY = Object.freeze(['yes', 'no', 'unknown']);
export const SPEED_TO_LEAD = Object.freeze(['automation_touch', 'human_touch', 'none']);
export const TRIGGER_TYPES = Object.freeze(['tag_added', 'opportunity_created', 'opportunity_stage', 'opportunity_status', 'contact_created', 'contact_field', 'appointment_created', 'appointment_status', 'note_added', 'task_added', 'fb_lead_form', 'inbound_message', 'missed_call']);
export const SOURCE_STATUS = Object.freeze(['complete', 'partial', 'unverified']);
export const ATTESTATION_STATUS = Object.freeze(['never', 'current', 'overdue', 'stale', 'invalid']);
const GHL_API = 'https://services.leadconnectorhq.com';
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HEX64 = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const AUTOMATIC = new Set(['owner_automation', 'customer_initiated', 'disabled']);

const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `automation_registry_${code}`, status, ...(details ? { details } : {}) });
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const lower = value => text(value, 80).toLowerCase();
const list = value => Array.isArray(value) ? value : [];
const instant = value => typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));

export const automationTemplateHash = async value => value === null || value === undefined ? null : messageDigest(String(value));
// Attestations bind to the registry content; recording one never changes it.
export const registryHash = (registry = AUTOMATION_REGISTRY) => { const { attestations, ...content } = registry; return messageDigest(content); };
export const automationById = (registry, id) => list(registry?.automations).find(entry => entry.id === id) || null;
const triggerById = (registry, id) => list(registry?.triggers).find(trigger => trigger.id === id) || null;

// A concrete write such as tag:egc-reminder-2d resolves to its registered
// pattern tag:egc-reminder-{n}d.
export function resolveSurface(registry, surface) {
  const exact = triggerById(registry, surface);
  if (exact) return exact;
  return list(registry?.triggers).find(trigger => trigger.id.includes('{n}') && new RegExp(`^${trigger.id.split('{n}').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d{1,3}')}$`).test(String(surface))) || null;
}

export const listenersFor = (registry, triggerId) => list(registry?.automations).filter(entry => list(entry.listensTo).includes(triggerId));

// The Hub writes that can start this automation (design: "the list of Hub
// writes that trigger each workflow").
export function hubWritesFor(registry, id) {
  const entry = automationById(registry, id);
  if (!entry) return [];
  return list(entry.listensTo).flatMap(triggerId => list(triggerById(registry, triggerId)?.hubWrites).map(write => ({ trigger: triggerId, ...write })));
}

// Safe to leave running when a new Hub write could start it: it never reaches
// a customer, it is verified off, a person approves every message, or the
// owner approved its exact fixed text. AI-written content never clears.
export function automationCleared(entry) {
  if (!entry) return false;
  if (entry.classification === 'internal') return entry.audience !== 'customer';
  if (entry.classification === 'disabled') return entry.sendsToday === 'no';
  if (entry.contentSource === 'ai_generated') return false;
  if (entry.disposition === 'approved_human') return true;
  return ['owner_automation', 'customer_initiated'].includes(entry.classification) && entry.approvedBy === OWNER_USERNAME && instant(entry.approvedAt) && HEX64.test(entry.templateHash || '');
}

function messageView(entry) {
  return { automationId: entry.id, name: entry.name, system: entry.system, channel: entry.channel, audience: entry.audience, subject: entry.subject ?? null,
    templateText: entry.templateText ?? null, templateHash: entry.templateHash ?? null, classification: entry.classification, disposition: entry.disposition, cleared: automationCleared(entry) };
}

// The customer-facing messages a set of Hub writes can start, and everything
// that keeps the list from being complete. FUN-11 shows these texts.
export function messagesForSurfaces(registry, surfaces) {
  const blockers = [], messages = [], seen = new Set();
  for (const surface of [...new Set(list(surfaces))]) {
    const trigger = resolveSurface(registry, surface);
    if (!trigger) { blockers.push(`trigger_unregistered:${surface}`); continue; }
    if (trigger.listenersVerified !== true) blockers.push(`listeners_unverified:${trigger.id}`);
    for (const entry of listenersFor(registry, trigger.id)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.audience !== 'none') messages.push(messageView(entry));
      if (!automationCleared(entry)) blockers.push(entry.contentSource === 'ai_generated' ? `automation_ai_generated:${entry.id}` : `automation_unapproved:${entry.id}`);
    }
  }
  return { complete: blockers.length === 0, messages, blockers: [...new Set(blockers)] };
}

// Mirrors functions/api/highlevel.js tool=schedule (a Hub booking sync). Every
// sync writes the appointment (status confirmed) whatever notify says, and a job
// with no linked opportunity creates one when the contact has none open.
export function bookingSurfaces({ eventType = 'walkthrough', notify = true, reminderDays = 2, contactLinked = false, opportunityLinked = false } = {}) {
  const days = Math.min(30, Math.max(1, Number(reminderDays || 2))), job = eventType === 'job';
  return ['tag:egc-hub-scheduled', job ? 'tag:egc-job-scheduled' : 'tag:egc-walkthrough-scheduled',
    ...(notify !== false ? [`tag:egc-reminder-${days}d`, 'appointment:created_notify'] : []), 'appointment:created',
    ...(job ? [...(opportunityLinked ? [] : ['opportunity:created']), 'opportunity_stage:scheduled'] : []), ...(contactLinked ? [] : ['contact:upsert'])];
}
export const bookingMessages = (registry, input) => ({ surfaces: bookingSurfaces(input), ...messagesForSurfaces(registry, bookingSurfaces(input)) });

export function gateBlockers(registry, gateId) {
  const gate = list(registry?.gates).find(item => item.id === gateId);
  if (!gate) throw fail('gate_unknown', 'That automation gate is not registered.', 404);
  return messagesForSurfaces(registry, gate.surfaces).blockers;
}

function monthAfter(date) {
  const [y, m, d] = date.split('-').map(Number), year = y + Math.floor(m / 12), month = m % 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// Monthly owner re-attestation: due one calendar month (America/Denver) after
// the last one, and void as soon as the registry content changes. One that is
// not the owner's, has no registry hash or is dated in the future makes the
// status invalid until the data file is fixed; it never counts as current.
export function attestationStatus(registry, now, currentHash) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw fail('clock_invalid', 'A valid clock is required.', 500);
  const recorded = list(registry?.attestations), none = { attestedBy: null, attestedAt: null, dueOn: null, registryHash: currentHash ?? null };
  if (!recorded.length) return { status: 'never', ...none };
  const invalid = recorded.filter(item => item?.attestedBy !== OWNER_USERNAME || !instant(item?.attestedAt) || !HEX64.test(String(item?.registryHash || '')) || Date.parse(item.attestedAt) > now.getTime());
  if (invalid.length) return { status: 'invalid', ...none, invalid: invalid.length };
  const latest = [...recorded].sort((a, b) => Date.parse(a.attestedAt) - Date.parse(b.attestedAt)).at(-1);
  const dueOn = monthAfter(denverToday(new Date(latest.attestedAt)));
  const status = latest.registryHash !== currentHash ? 'stale' : denverToday(now) > dueOn ? 'overdue' : 'current';
  return { status, attestedBy: latest.attestedBy, attestedAt: latest.attestedAt, dueOn, registryHash: currentHash ?? null, attestedHash: latest.registryHash };
}

// Go/no-go for a flag-gated write (FUN-11/12/35): every automation it can start
// is cleared, every listener list is owner-verified and the attestation is current.
export async function evaluateGate(registry, gateId, { now, hash, problems } = {}) {
  const gate = list(registry?.gates).find(item => item.id === gateId);
  if (!gate) throw fail('gate_unknown', 'That automation gate is not registered.', 404);
  const current = hash ?? await registryHash(registry), invalid = (problems ?? await registryProblems(registry)).length > 0;
  const attestation = attestationStatus(registry, now, current), result = messagesForSurfaces(registry, gate.surfaces);
  const reasons = [...(invalid ? ['registry_invalid'] : []), ...(attestation.status === 'current' ? [] : [`attestation_${attestation.status}`]), ...result.blockers];
  return { id: gate.id, unit: gate.unit, label: gate.label, go: reasons.length === 0, reasons, surfaces: [...gate.surfaces], messages: result.messages, attestation };
}
export async function evaluateGates(registry, { now } = {}) {
  const [hash, problems] = await Promise.all([registryHash(registry), registryProblems(registry)]);
  return Promise.all(list(registry?.gates).map(gate => evaluateGate(registry, gate.id, { now, hash, problems })));
}

const PLACEHOLDER = /\{\{\s*[A-Za-z][A-Za-z0-9]*\s*\}\}|\[[A-Z][A-Z ]{0,19}\]/g;
const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// Does a sent body fit a registered fixed template? {{variable}} and [SLOT]
// placeholders stand for at least one character. Wildcard matching by
// leftmost search is exact for this pattern shape and linear in the body.
export function templateMatches(templateText, body) {
  const template = squash(templateText), value = squash(body);
  if (!template || !value) return false;
  const parts = template.split(PLACEHOLDER);
  if (parts.length === 1) return template === value;
  const first = parts[0], last = parts.at(-1), end = value.length - last.length;
  if (!value.startsWith(first) || !value.endsWith(last) || end - first.length < parts.length - 1) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, at + 1);
    if (found < 0) return false;
    at = found + part.length;
  }
  return end - at >= 1;
}

export function matchTemplate(registry, body) {
  if (!squash(body)) return null;
  const candidates = list(registry?.automations).filter(entry => typeof entry.templateText === 'string' && entry.audience !== 'none');
  const ordered = [...candidates.filter(entry => AUTOMATIC.has(entry.classification)), ...candidates.filter(entry => !AUTOMATIC.has(entry.classification))];
  return ordered.find(entry => templateMatches(entry.templateText, body)) || null;
}

// A registered path whose speedToLead is none (an arrival text, a portal
// invitation) never counts as a lead response; otherwise the actor decides.
const touch = (actor, entry, reason) => ({ actor, entryId: entry?.id || null, registered: Boolean(entry), reason,
  speedToLead: entry?.speedToLead === 'none' ? null : actor === 'automation' ? 'automation_touch' : actor === 'human' ? 'human_touch' : null });

// Speed to lead: is an outbound message an automation touch or a human one?
// Registered workflows and fixed templates are automation; Hub sends a person
// approved and staff-user sends are human even when HighLevel reports source
// 'api' (design §4.2). A customer-initiated send is not a human touch. Anything
// without evidence stays unknown, never guessed.
export function classifyTouch(registry, message = {}) {
  const direction = lower(message.direction);
  if (direction === 'inbound') return touch('customer', null, 'inbound');
  if (direction !== 'outbound') return touch('unknown', null, 'direction_unknown');
  const workflowId = text(message.workflowId, 120);
  if (workflowId) {
    const entry = list(registry?.automations).find(item => item.system === 'ghl_workflow' && item.providerId === workflowId);
    return touch('automation', entry, entry ? 'registered_workflow' : 'unregistered_workflow');
  }
  if (text(message.messageSendId, 200)) {
    const entry = list(registry?.automations).find(item => item.msgCoreKind && item.msgCoreKind === message.kind) || null;
    if (message.approval === 'owner_automation') return touch('automation', entry, 'owner_automation_send');
    if (message.approval === 'customer_initiated') return touch('automation', entry, 'customer_initiated_send');
    return HUMAN_APPROVALS.includes(message.approval) ? touch('human', entry, 'approved_send') : touch('unknown', entry, 'approval_unknown');
  }
  const matched = matchTemplate(registry, message.body);
  if (matched) return AUTOMATIC.has(matched.classification) ? touch('automation', matched, 'registered_template') : touch('human', matched, 'human_template');
  const source = lower(message.source);
  if (['workflow', 'bulk_actions', 'campaign'].includes(source)) return touch('automation', null, 'unregistered_automation');
  if (text(message.userId, 120)) return touch('human', null, 'staff_user');
  if (source === 'api') return touch('automation', null, 'api_without_user');
  return touch('unknown', null, 'no_actor_evidence');
}

// Read-only drift check of a HighLevel workflow listing against the registry.
// A workflow the registry does not know is always reported, even if internal.
// A date-only verifiedAt cannot order edits within its day, so an update on
// that Denver day counts as changed; an ISO instant is compared exactly.
export function diffGhlWorkflows(registry, workflows) {
  if (!Array.isArray(workflows)) throw fail('ghl_inventory_invalid', 'The HighLevel workflow list was incomplete.', 502);
  const known = new Map(list(registry?.automations).filter(entry => entry.system === 'ghl_workflow' && entry.providerId).map(entry => [entry.providerId, entry]));
  const listed = new Map();
  for (const row of workflows) {
    const id = text(row?.id, 120);
    if (!id) throw fail('ghl_inventory_invalid', 'The HighLevel workflow list was incomplete.', 502);
    listed.set(id, { id, name: text(row.name, 200), status: lower(row.status), updatedAt: instant(row.updatedAt) || /^\d{4}-\d{2}-\d{2}T/.test(text(row.updatedAt, 40)) ? text(row.updatedAt, 40) : '' });
  }
  const rows = [...listed.values()];
  const unregistered = rows.filter(row => !known.has(row.id));
  const missing = [...known.values()].filter(entry => !listed.has(entry.providerId)).map(entry => ({ automationId: entry.id, providerId: entry.providerId, name: entry.name }));
  const changed = rows.filter(row => {
    const entry = known.get(row.id), updated = Date.parse(row.updatedAt);
    if (!entry || !Number.isFinite(updated)) return false;
    return instant(entry.verifiedAt) ? updated > Date.parse(entry.verifiedAt) : validDate(entry.verifiedAt) && denverToday(new Date(updated)) >= entry.verifiedAt;
  }).map(row => ({ automationId: known.get(row.id).id, providerId: row.id, name: row.name, updatedAt: row.updatedAt, verifiedAt: known.get(row.id).verifiedAt }));
  const statusMismatch = rows.filter(row => {
    const entry = known.get(row.id);
    return entry && row.status && ((entry.sendsToday === 'yes' && row.status !== 'published') || (entry.sendsToday === 'no' && row.status === 'published'));
  }).map(row => ({ automationId: known.get(row.id).id, providerId: row.id, status: row.status, sendsToday: known.get(row.id).sendsToday }));
  return { complete: !unregistered.length && !missing.length && !changed.length && !statusMismatch.length, listed: rows.length, unregistered, missing, changed, statusMismatch };
}

// GET /workflows/ is read-only. Credentials come from the caller and are never
// echoed; a malformed answer is an error, never an empty list.
export async function fetchGhlWorkflows({ token, locationId, fetcher = fetch, timeoutMs = 15000 } = {}) {
  if (!text(token, 4000) || !text(locationId, 120)) throw fail('ghl_not_configured', 'HighLevel credentials are required to list workflows.', 503);
  let response, data;
  try {
    response = await fetcher(`${GHL_API}/workflows/?${new URLSearchParams({ locationId: text(locationId, 120) })}`, { method: 'GET', redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: `Bearer ${text(token, 4000)}`, Version: '2021-07-28' }, signal: AbortSignal.timeout(timeoutMs) });
    data = await response.json().catch(() => null);
  } catch { throw fail('ghl_unavailable', 'HighLevel did not answer the workflow list request.', 503); }
  if (!response.ok) throw fail('ghl_rejected', `HighLevel refused the workflow list (HTTP ${response.status}).`, 502, { status: response.status });
  if (!Array.isArray(data?.workflows)) throw fail('ghl_inventory_invalid', 'The HighLevel workflow list was incomplete.', 502);
  return data.workflows.map(row => ({ id: text(row?.id, 120), name: text(row?.name, 200), status: lower(row?.status), version: Number.isFinite(row?.version) ? row.version : null, updatedAt: text(row?.updatedAt, 40) }));
}

const oneOf = (problems, where, value, allowed, field) => { if (!allowed.includes(value)) problems.push(`${where}: ${field} ${JSON.stringify(value)} is not one of ${allowed.join('|')}`); };

// Structural and approval-rule invariants. Returns problems (empty = valid).
export async function registryProblems(registry = AUTOMATION_REGISTRY) {
  const problems = [];
  if (!registry || registry.schemaVersion !== 1) return ['registry: schemaVersion must be 1'];
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(String(registry.registryVersion || ''))) problems.push('registry: registryVersion must look like YYYY-MM-DD.N');
  for (const [name, source] of Object.entries(registry.sources || {})) {
    oneOf(problems, `source ${name}`, source?.status, SOURCE_STATUS, 'status');
    if (source?.verifiedAt !== null && !validDate(source?.verifiedAt)) problems.push(`source ${name}: verifiedAt must be a date or null`);
  }
  const triggerIds = new Set();
  for (const trigger of list(registry.triggers)) {
    const where = `trigger ${trigger?.id}`;
    if (!/^[a-z_]+:[a-z0-9{}_-]+$/.test(String(trigger?.id || '')) || triggerIds.has(trigger.id)) problems.push(`${where}: id must be unique type:value`);
    triggerIds.add(trigger?.id);
    oneOf(problems, where, trigger?.type, TRIGGER_TYPES, 'type');
    if (typeof trigger?.listenersVerified !== 'boolean') problems.push(`${where}: listenersVerified must be boolean`);
    for (const write of list(trigger?.hubWrites)) if (!text(write?.file) || !text(write?.when) || typeof write?.automatic !== 'boolean' || !Array.isArray(write?.via)) problems.push(`${where}: each hub write needs file, via[], when and automatic`);
  }
  const ids = new Set(), kinds = new Set();
  const inventory = registry.codeInventory || {};
  for (const entry of list(registry.automations)) {
    const where = `automation ${entry?.id}`;
    if (!ID.test(String(entry?.id || '')) || ids.has(entry.id)) problems.push(`${where}: id must be unique lowercase dotted`);
    ids.add(entry?.id);
    if (!text(entry?.name) || !text(entry?.trigger)) problems.push(`${where}: name and trigger are required`);
    oneOf(problems, where, entry?.system, SYSTEMS, 'system');
    oneOf(problems, where, entry?.classification, CLASSIFICATIONS, 'classification');
    oneOf(problems, where, entry?.disposition, DISPOSITIONS, 'disposition');
    oneOf(problems, where, entry?.channel, CHANNELS, 'channel');
    oneOf(problems, where, entry?.audience, AUDIENCES, 'audience');
    oneOf(problems, where, entry?.contentSource, CONTENT_SOURCES, 'contentSource');
    oneOf(problems, where, entry?.sendsToday, SENDS_TODAY, 'sendsToday');
    oneOf(problems, where, entry?.speedToLead, SPEED_TO_LEAD, 'speedToLead');
    const rule = {
      approved_automatic: entry.sendsToday === 'yes' && ['owner_automation', 'customer_initiated'].includes(entry.classification) && entry.contentSource !== 'ai_generated' && entry.audience !== 'none',
      approved_human: ['human_approved', 'customer_initiated'].includes(entry.classification) && entry.contentSource !== 'ai_generated',
      internal: entry.classification === 'internal' && entry.audience !== 'customer',
      needs_owner_approval: ['owner_automation', 'human_approved'].includes(entry.classification),
      retire: entry.classification === 'disabled',
    }[entry.disposition];
    if (rule === false) problems.push(`${where}: disposition ${entry.disposition} does not fit classification ${entry.classification}`);
    if (entry.classification === 'internal' && entry.disposition !== 'internal') problems.push(`${where}: internal paths must have disposition internal`);
    if (entry.contentSource === 'ai_generated' && !['retire', 'needs_owner_approval'].includes(entry.disposition)) problems.push(`${where}: AI-written messages can never be approved automatically`);
    if (entry.audience === 'none' && entry.channel !== 'none') problems.push(`${where}: a path with no audience sends on no channel`);
    if ((entry.templateText === null) !== (entry.templateHash === null)) problems.push(`${where}: templateText and templateHash are both set or both null`);
    else if (entry.templateText !== null) {
      if (typeof entry.templateText !== 'string' || !entry.templateText.trim()) problems.push(`${where}: templateText must be text`);
      else if (entry.templateHash !== await automationTemplateHash(entry.templateText)) problems.push(`${where}: templateHash does not match templateText`);
    }
    if (entry.contentSource === 'fixed_template' && entry.templateText === null) problems.push(`${where}: a fixed template must register its text`);
    if (entry.approvedBy !== null || entry.approvedAt !== null) {
      if (entry.approvedBy !== OWNER_USERNAME || !instant(entry.approvedAt)) problems.push(`${where}: only the owner approves, with an ISO approvedAt`);
      if (entry.templateText === null || !['owner_automation', 'customer_initiated'].includes(entry.classification)) problems.push(`${where}: an approval is of an exact automatic template`);
    }
    if (entry.system === 'ghl_workflow' && entry.providerId !== null && !UUID.test(String(entry.providerId))) problems.push(`${where}: a HighLevel workflow id is a UUID`);
    if (entry.verifiedAt !== null && !validDate(entry.verifiedAt) && !instant(entry.verifiedAt)) problems.push(`${where}: verifiedAt must be a date, an ISO instant or null`);
    for (const triggerId of list(entry.listensTo)) if (!triggerIds.has(triggerId)) problems.push(`${where}: listens to unknown trigger ${triggerId}`);
    for (const ref of list(entry.code)) if (!inventory[ref?.file]?.[ref?.signature]) problems.push(`${where}: code ${ref?.file} ${ref?.signature} is not in codeInventory`);
    if (entry.msgCoreKind) { if (kinds.has(entry.msgCoreKind)) problems.push(`${where}: msgCoreKind ${entry.msgCoreKind} is registered twice`); kinds.add(entry.msgCoreKind); }
    if (!text(entry.ownerCheck) && entry.disposition === 'needs_owner_approval') problems.push(`${where}: needs_owner_approval entries say what the owner must check`);
  }
  const referenced = new Set(list(registry.automations).flatMap(entry => list(entry.code).map(ref => `${ref.file} ${ref.signature}`)));
  for (const [file, signatures] of Object.entries(inventory)) for (const signature of Object.keys(signatures)) if (!referenced.has(`${file} ${signature}`)) problems.push(`codeInventory ${file} ${signature}: no automation claims this send path`);
  for (const gate of list(registry.gates)) for (const surface of list(gate?.surfaces)) if (!resolveSurface(registry, surface)) problems.push(`gate ${gate?.id}: unknown surface ${surface}`);
  for (const item of list(registry.attestations)) if (item?.attestedBy !== OWNER_USERNAME || !instant(item?.attestedAt) || !HEX64.test(String(item?.registryHash || ''))) problems.push('attestation: owner, ISO attestedAt and a registry hash are required');
  return problems;
}

// The report behind GET /api/automation-registry and the inventory script.
export async function registryReport(registry = AUTOMATION_REGISTRY, { now } = {}) {
  const [hash, problems] = await Promise.all([registryHash(registry), registryProblems(registry)]);
  const attestation = attestationStatus(registry, now, hash), byDisposition = Object.fromEntries(DISPOSITIONS.map(value => [value, 0]));
  for (const entry of list(registry.automations)) byDisposition[entry.disposition] = (byDisposition[entry.disposition] || 0) + 1;
  return {
    asOf: now.toISOString(),
    registry: { schemaVersion: registry.schemaVersion, registryVersion: registry.registryVersion, hash, sources: registry.sources },
    integrity: { valid: problems.length === 0, problems },
    attestation,
    summary: { automations: list(registry.automations).length, triggers: list(registry.triggers).length, byDisposition,
      customerFacingUncleared: list(registry.automations).filter(entry => entry.audience === 'customer' && !automationCleared(entry)).length },
    automations: list(registry.automations).map(({ code, ...entry }) => ({ ...entry, cleared: automationCleared(entry), hubWrites: hubWritesFor(registry, entry.id) })),
    triggers: list(registry.triggers).map(trigger => ({ ...trigger, listeners: listenersFor(registry, trigger.id).map(entry => entry.id) })),
    gates: await Promise.all(list(registry.gates).map(gate => evaluateGate(registry, gate.id, { now, hash, problems }))),
  };
}
