import { hasBusinessAccess } from './hub-session.js';
import { TEMPLATE_KINDS, TEMPLATE_KIND_IDS } from './message-template-defaults.js';
import { validateTemplateVersion, templateHash, messageDigest } from './message-templates.js';
import { MESSAGE_TEMPLATES, MESSAGE_OPERATIONS } from './message-send-store.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_VERSIONS = 25;
const ACTIONS = { save_draft: ['channel','subject','body'], approve: ['version','hash'], retire: ['version'], set_automation: ['enabled'] };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });

export function requireTemplateEditor(session) {
  if (!session?.user) throw fail('messaging_sign_in_required', 'Sign in to the Employee Hub to manage message templates.', 401);
  if (!hasBusinessAccess(session) || !['owner','manager'].includes(session.role)) throw fail('messaging_template_forbidden', 'Only an owner or operations manager can manage message templates.', 403);
}
// Same owner test as the Gusto and employee-account gates: the role alone is
// configurable per user, so it is never enough to approve customer wording.
export const isMessagingOwner = session => hasBusinessAccess(session) && session?.role === 'owner' && String(session?.user || '').trim().toLowerCase() === 'zacb';
export function requireTemplateOwner(session) {
  requireTemplateEditor(session);
  if (!isMessagingOwner(session)) throw fail('messaging_template_owner_required', 'Only the owner can approve message wording or automation.', 403);
}

function versionRow(row) {
  return {
    version: row.version, channel: row.channel, subject: row.subject || '', body: row.body, variables: Array.isArray(row.variables) ? row.variables : [],
    hash: row.hash, status: ['draft','approved','retired'].includes(row.status) ? row.status : 'draft',
    createdBy: row.createdBy || '', createdAt: row.createdAt || '', approvedBy: row.approvedBy || '', approvedAt: row.approvedAt || '', retiredAt: row.retiredAt || '',
  };
}

async function seed(kind) {
  const base = TEMPLATE_KINDS[kind], version = validateTemplateVersion({ channel: base.channel, subject: base.subject || '', body: base.body }, base.variables);
  return { version: 1, ...version, hash: await templateHash(kind, version), status: 'draft', createdBy: 'egc-default', createdAt: '', approvedBy: '', approvedAt: '', retiredAt: '' };
}

// A missing document is presented as its unapproved default seed. The seed is
// only persisted by the first explicit edit or owner approval.
export async function templateState(kind, doc) {
  if (!Object.hasOwn(TEMPLATE_KINDS, kind)) throw fail('messaging_template_unknown', 'Choose a supported message template.', 404);
  const base = TEMPLATE_KINDS[kind];
  if (!doc) return { kind, label: base.label, audience: base.audience, allowedVariables: base.variables, versions: [await seed(kind)], activeVersion: null, latestVersion: 1, automationEnabled: false, seeded: true, revision: '', updatedAt: '', updatedBy: '' };
  const versions = (Array.isArray(doc.versions) ? doc.versions : []).filter(row => object(row) && Number.isInteger(row.version) && typeof row.body === 'string' && typeof row.hash === 'string').map(versionRow);
  const latest = Math.max(0, ...versions.map(row => row.version));
  if (!versions.length || doc.latestVersion !== latest) throw fail('messaging_template_storage_invalid', 'This message template record needs administrator review before it can be used.', 503);
  const active = versions.find(row => row.version === doc.activeVersion && row.status === 'approved') ? doc.activeVersion : null;
  return { kind, label: base.label, audience: base.audience, allowedVariables: base.variables, versions, activeVersion: active, latestVersion: latest, automationEnabled: doc.automationEnabled === true && active !== null, seeded: false, revision: doc.revision || '', updatedAt: doc.updatedAt || '', updatedBy: doc.updatedBy || '' };
}

export async function readTemplate(store, kind) {
  return templateState(kind, await store.read(MESSAGE_TEMPLATES, kind));
}

export async function listTemplates(store) {
  return Promise.all(TEMPLATE_KIND_IDS.map(kind => readTemplate(store, kind)));
}

// The send path only ever sees an owner-approved version whose stored hash
// still matches its text. Any edit is a new draft with a new hash.
export async function activeTemplate(store, kind) {
  const state = await readTemplate(store, kind);
  const row = state.versions.find(version => version.version === state.activeVersion && version.status === 'approved');
  if (!row || !row.approvedBy || !row.approvedAt || row.hash !== await templateHash(kind, row)) return null;
  return { kind, version: row.version, channel: row.channel, subject: row.subject, body: row.body, hash: row.hash, approvedBy: row.approvedBy, approvedAt: row.approvedAt, automationEnabled: state.automationEnabled };
}

export function templateRegistry(store) {
  return { active: kind => activeTemplate(store, kind), read: kind => readTemplate(store, kind) };
}

export function templateView(state) {
  const { revision, ...view } = state;
  return view;
}

export async function mutateTemplate(store, session, input, now = new Date().toISOString()) {
  requireTemplateEditor(session);
  if (!object(input) || !Object.hasOwn(ACTIONS, input.action) || !UUID.test(input.requestId || '')) throw fail('messaging_request_invalid', 'Use a supported template action with a unique request ID.');
  const allowed = ['action','requestId','kind','expectedVersion',...ACTIONS[input.action]];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw fail('messaging_request_invalid', 'This template request contains unsupported fields. Refresh and try again.');
  if (input.action !== 'save_draft') requireTemplateOwner(session);
  if (!Object.hasOwn(TEMPLATE_KINDS, input.kind)) throw fail('messaging_template_unknown', 'Choose a supported message template.', 404);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw fail('messaging_request_invalid', 'Refresh the template before saving.');
  const receiptId = input.requestId.toLowerCase(), fingerprint = await messageDigest({ scope: 'message_template', actor: session.user, input });
  const prior = await store.read(MESSAGE_OPERATIONS, receiptId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw fail('messaging_idempotency_conflict', 'This request ID was already used for a different change. Refresh before saving.', 409);
    return { ok: true, requestId: input.requestId, replayed: true, template: templateView(await readTemplate(store, input.kind)) };
  }
  const current = await readTemplate(store, input.kind);
  if (input.expectedVersion !== current.latestVersion) throw fail('messaging_template_revision_conflict', 'Someone changed this template while you were editing. Your draft is kept; load the latest version before saving.', 409, { latestVersion: current.latestVersion });
  const versions = current.versions.map(row => ({ ...row }));
  let activeVersion = current.activeVersion, automationEnabled = current.automationEnabled, unchanged = false;
  if (input.action === 'save_draft') {
    const version = validateTemplateVersion({ channel: input.channel, subject: input.subject, body: input.body }, current.allowedVariables);
    const hash = await templateHash(input.kind, version), latest = versions.find(row => row.version === current.latestVersion);
    if (latest?.hash === hash) unchanged = true;
    else versions.push({ version: current.latestVersion + 1, ...version, hash, status: 'draft', createdBy: session.user, createdAt: now, approvedBy: '', approvedAt: '', retiredAt: '' });
  } else if (input.action === 'approve') {
    const target = versions.find(row => row.version === input.version);
    if (!target) throw fail('messaging_template_version_missing', 'That template version no longer exists. Refresh and review.', 404);
    if (typeof input.hash !== 'string' || target.hash !== input.hash || target.hash !== await templateHash(input.kind, target)) throw fail('messaging_template_revision_conflict', 'The template text changed. Review the latest wording before approving.', 409);
    if (target.status === 'approved' && activeVersion === target.version) unchanged = true;
    else {
      for (const row of versions) if (row.version === activeVersion && row.version !== target.version) Object.assign(row, { status: 'retired', retiredAt: now });
      Object.assign(target, { status: 'approved', approvedBy: session.user, approvedAt: now, retiredAt: '' });
      activeVersion = target.version;
    }
  } else if (input.action === 'retire') {
    const target = versions.find(row => row.version === input.version);
    if (!target) throw fail('messaging_template_version_missing', 'That template version no longer exists. Refresh and review.', 404);
    if (target.status === 'retired') unchanged = true;
    else {
      Object.assign(target, { status: 'retired', retiredAt: now });
      if (activeVersion === target.version) { activeVersion = null; automationEnabled = false; }
    }
  } else {
    if (typeof input.enabled !== 'boolean') throw fail('messaging_request_invalid', 'Choose whether automation is on or off.');
    if (input.enabled && activeVersion === null) throw fail('messaging_template_not_approved', 'Approve the message wording before turning on automation.', 409);
    if (automationEnabled === input.enabled) unchanged = true;
    automationEnabled = input.enabled;
  }
  if (unchanged) return { ok: true, requestId: input.requestId, unchanged: true, template: templateView(current) };
  const kept = versions.filter(row => row.version === activeVersion || row.version === versions.at(-1).version || versions.indexOf(row) >= versions.length - MAX_VERSIONS);
  const latestVersion = Math.max(...kept.map(row => row.version));
  const patch = {
    kind: input.kind, versions: kept, activeVersion, latestVersion, automationEnabled: automationEnabled && activeVersion !== null,
    ...(input.action === 'set_automation' ? { automationUpdatedBy: session.user, automationUpdatedAt: now } : {}),
    updatedAt: now, updatedBy: session.user, lastRequestId: input.requestId,
  };
  await store.commit([
    { collection: MESSAGE_TEMPLATES, id: input.kind, ...(current.revision ? { revision: current.revision } : {}), patch },
    { collection: MESSAGE_OPERATIONS, id: receiptId, patch: { scope: 'message_template', fingerprint, actorId: session.user, action: input.action, kind: input.kind, requestId: input.requestId, createdAt: now, latestVersion, activeVersion } },
  ]).catch(error => {
    if (error?.code === 'messaging_revision_conflict') throw fail('messaging_template_revision_conflict', 'Someone changed this template at the same time. Your draft is kept; load the latest version before saving.', 409);
    throw error;
  });
  const saved = await readTemplate(store, input.kind);
  return { ok: true, requestId: input.requestId, template: templateView(saved) };
}
