/* The one approved path for customer- and crew-facing messages. A send needs
   a policy, an owner-approved template (or human-written text confirmed in a
   preview), a verified saved recipient and a compare-and-set ledger claim. */
import { hasBusinessAccess } from './hub-session.js';
import { assignmentKey, createJobAssignmentAccess, jobCrewNames } from './job-assignment.js';
import { appendConversationMessage } from './customer-messaging.js';
import { denverToday, validDate } from './dispatch-time.js';
import { arrivalSettings, arrivalWindowFields } from './dispatch-arrival.js';
import { HUMAN_APPROVALS, messagePolicy, quietHoursDecision, invoiceBalance, depositDue } from './message-policies.js';
import { LINK_VARIABLES, messageDigest, renderTemplate, templateRoom, templateVariables, validateTemplateVersion } from './message-templates.js';
import { TEMPLATE_KINDS } from './message-template-defaults.js';
import { templateRegistry } from './message-template-store.js';
import { MESSAGE_SENDS, ledgerId } from './message-send-store.js';
import { STAFF_CONTACT_TAG, maskRecipient, recipientDestination } from './ghl-messenger.js';
import { fieldJobLead, fieldLeadOnlyComplete } from './field-permissions.js';
import { describeLost, describeWork, jobCrewIds, lostOptions, shortestOption, workOptions } from './crew-notifications.js';

export const COMPANY_PHONE = '(970) 999-1818';
export const CONFIRM_TTL_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INPUT_KEYS = ['kind','jobId','accountId','overrides','confirmToken','requestId'];
const HELD = new Set(['submitted','uncertain','sending']);
const DAY_MS = 86400000;
const DUMMY_LINK = 'https://easygaragecleaning.com/';
// Crew notice variables that name days, and the longest each may read.
const CREW_DATED = Object.freeze(['serviceDate', 'removedDates']);
const CREW_DATE_CAP = Object.freeze({ crew_assignment: 90, crew_unassignment: 90, crew_schedule_change: 70 });
// The other queued visits a crew notice's grouped text names (none for one sent alone).
const noticeBatchIds = batch => Array.isArray(batch?.ids) ? [...new Set(batch.ids.filter(id => typeof id === 'string' && /^crew_[a-f0-9]{40}$/.test(id)))].slice(0, 200) : [];
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// A provider answer that arrived after a person reconciled the send (message-reconcile.js) is kept as lateResult.
const lateSubmitted = row => object(row?.lateResult) && row.lateResult.status === 'submitted';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const firstWord = value => String(value || '').trim().split(/\s+/)[0].slice(0, 40);
const usd = cents => cents === null || cents === undefined ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const dateText = (date, weekday = true) => validDate(date) ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...(weekday ? { weekday: 'long' } : {}), month: 'long', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`)) : '';
const minutesOf = time => { const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || ''); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
const clockText = minutes => { const hour = Math.floor(minutes / 60) % 24; return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`; };
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), character => character.charCodeAt(0));

export function messagingFlags(env = {}) {
  // Off unless explicitly enabled; while enabled, delivery stays a dry run
  // until the owner explicitly sets EGC_MESSAGING_DRY_RUN=false.
  return { enabled: env.EGC_MESSAGING_ENABLED === 'true', dryRun: env.EGC_MESSAGING_DRY_RUN !== 'false' };
}

async function confirmKey(secret) {
  const root = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = new Uint8Array(await crypto.subtle.sign('HMAC', root, encoder.encode('egc:message-confirm:v1')));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Confirm tokens use a key derived from HUB_SESSION_SECRET for this purpose
// only, and bind the approving actor to the exact send, text and recipient.
export async function createConfirmToken(secret, { actorId, ledgerId: key, bodyHash, recipientHash, issuedAt, expiresAt }) {
  if (!secret) throw fail('messaging_not_configured', 'Message confirmation is not configured. Nothing was sent.', 503);
  const payload = b64(encoder.encode(JSON.stringify({ v: 1, p: 'message-confirm', a: actorId, k: key, b: bodyHash, r: recipientHash, iat: issuedAt ?? expiresAt - CONFIRM_TTL_MS, exp: expiresAt })));
  return `${payload}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', await confirmKey(secret), encoder.encode(payload))))}`;
}

export async function verifyConfirmToken(secret, token, expected, nowMs) {
  if (typeof token !== 'string' || !token) throw fail('messaging_confirmation_required', 'Preview this message and confirm it before sending.', 409);
  const invalid = () => fail('messaging_confirmation_invalid', 'This confirmation could not be verified. Preview the message again.', 403);
  if (!secret) throw fail('messaging_not_configured', 'Message confirmation is not configured. Nothing was sent.', 503);
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || token.length > 2048) throw invalid();
  let claims;
  try {
    if (!await crypto.subtle.verify('HMAC', await confirmKey(secret), unb64(signature), encoder.encode(payload))) throw invalid();
    claims = JSON.parse(new TextDecoder().decode(unb64(payload)));
  } catch { throw invalid(); }
  if (!object(claims) || claims.v !== 1 || claims.p !== 'message-confirm' || claims.a !== expected.actorId || !Number.isFinite(claims.iat)) throw invalid();
  if (!Number.isFinite(claims.exp) || claims.exp <= nowMs) throw fail('messaging_confirmation_expired', 'This confirmation expired. Preview the message again before sending.', 409);
  if (claims.k !== expected.ledgerId || claims.b !== expected.bodyHash || claims.r !== expected.recipientHash) throw fail('messaging_confirmation_stale', 'The message or its recipient changed after the preview. Preview it again.', 409);
  return claims;
}

// The preview time inside a confirm token fixes the send key, so a confirmed
// preview maps to the same ledger even when a time bucket rolls over before
// the send. It is read before verification only to derive that key; the
// signature check still binds it, and anything implausible falls back to now
// (a minute of clock skew between Worker instances is tolerated).
function tokenKeyTime(token, nowMs) {
  try {
    const claims = JSON.parse(new TextDecoder().decode(unb64(String(token).split('.')[0])));
    return Number.isFinite(claims?.iat) && claims.iat <= nowMs + 60000 && claims.iat > nowMs - CONFIRM_TTL_MS ? claims.iat : nowMs;
  } catch { return nowMs; }
}

function parseOverrides(policy, value) {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).some(key => !policy.overrides.includes(key))) throw fail('messaging_override_not_allowed', 'This message type does not allow those changes.', 400);
  const result = {};
  if ('etaMinutes' in value) {
    if (!Number.isInteger(value.etaMinutes) || value.etaMinutes < 1 || value.etaMinutes > 240) throw fail('messaging_override_invalid', 'Enter an arrival estimate from 1 to 240 minutes.');
    result.etaMinutes = value.etaMinutes;
  }
  if ('crewId' in value) {
    if (typeof value.crewId !== 'string' || !/^[A-Za-z0-9_.@-]{1,120}$/.test(value.crewId.trim())) throw fail('messaging_override_invalid', 'Choose a crew member assigned to this job.');
    result.crewId = assignmentKey(value.crewId);
  }
  if ('channel' in value) {
    if (!['SMS', 'Email'].includes(value.channel)) throw fail('messaging_override_invalid', 'Choose SMS or Email.');
    result.channel = value.channel;
  }
  if ('body' in value) {
    if (typeof value.body !== 'string' || !value.body.trim() || value.body.length > 1200) throw fail('messaging_override_invalid', 'Enter the follow-up message (at most 1,200 characters).');
    result.body = value.body;
  }
  if ('taskId' in value) {
    if (typeof value.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.taskId)) throw fail('messaging_override_invalid', 'The follow-up task reference is invalid.');
    result.taskId = value.taskId;
  }
  if ('noticeId' in value) {
    if (typeof value.noticeId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.noticeId)) throw fail('messaging_override_invalid', 'The crew notice reference is invalid.');
    result.noticeId = value.noticeId;
  }
  return result;
}

export function createApprovedSendService({
  store, messenger, templates = templateRegistry(store), clock = () => new Date(), env = {}, secret = env.HUB_SESSION_SECRET || '',
  links = {}, attachments = async () => [], crewContact = async () => null, readAccount = (target, id) => target.read('customers', id),
  // Policies with the 'account_staff' role ask the caller twice: staffGate(actor) before the record is read, then
  // accountAccess(actor, account) for the resolved account. Both refuse unless injected, so the role stays closed by default.
  staffGate = () => false, accountAccess = async () => false,
  assignment = actor => createJobAssignmentAccess(env, actor), reserve = () => {}, crewNotice = async () => null,
} = {}) {
  const now = () => { const value = clock(); return value instanceof Date ? value : new Date(value); };
  const linkProviders = { loginLink: context => context.audience === 'crew' ? 'https://easygaragecleaning.com/employee.html' : undefined, ...links };
  // The roster read once per service; `ok` is false when it could not be read.
  let rosterCache;
  const rosterRead = () => rosterCache ||= (typeof store.roster === 'function' ? Promise.resolve().then(() => store.roster()).then(rows => ({ rows: Array.isArray(rows) ? rows : [], ok: Array.isArray(rows) }), () => ({ rows: [], ok: false })) : Promise.resolve({ rows: [], ok: true }));
  const roster = async () => (await rosterRead()).rows;
  const rosterName = async id => { const key = assignmentKey(typeof id === 'string' ? id : id?.username || id?.user || id?.id || ''); return key ? (await roster()).find(person => person.id === key)?.name || '' : ''; };

  const forbidden = policy => fail('messaging_forbidden', policy.roles.includes('assigned_crew') ? 'Only crew assigned to this job or a manager can send this message.' : 'Your account cannot send this message.', 403);

  // Role checks that do not depend on the record run before it is read, so an
  // account that may not use a message type cannot probe which records exist.
  // Returns true when only a job assignment or account ownership could still authorize the actor.
  function gate(policy, actor, source, input) {
    if (actor.kind === 'customer') {
      if (source === 'portal' && policy.roles.includes('customer') && policy.target === 'account' && input.accountId === actor.customerAccountId) return false;
      throw fail('messaging_forbidden', 'This message cannot be requested from this account.', 403);
    }
    const dispatcher = hasBusinessAccess(actor) && ['owner', 'manager'].includes(actor.role);
    if ((policy.roles.includes('dispatcher') && dispatcher) || (policy.roles.includes('business') && hasBusinessAccess(actor))) return false;
    if (policy.roles.includes('assigned_crew') || (policy.roles.includes('account_staff') && staffGate(actor) === true)) return true;
    throw forbidden(policy);
  }

  async function readTarget(policy, input, crewOnly) {
    if (policy.target === 'job') {
      if (input.accountId !== undefined || !safeId(input.jobId)) throw fail('messaging_request_invalid', 'Choose a valid job for this message.');
      const job = await store.read('jobs', input.jobId);
      if (!job || job.recordType || !safeId(job.id)) throw crewOnly ? forbidden(policy) : fail('messaging_target_not_found', 'That job could not be found.', 404);
      return { job, account: null };
    }
    if (input.jobId !== undefined || !safeId(input.accountId)) throw fail('messaging_request_invalid', 'Choose a valid customer account for this message.');
    const account = await readAccount(store, input.accountId);
    if (!account || account.recordType || !safeId(account.id)) throw crewOnly ? forbidden(policy) : fail('messaging_target_not_found', 'That customer account could not be found.', 404);
    return { job: null, account };
  }

  async function authorize(ctx) {
    const { policy, actor, job, account } = ctx;
    if (policy.roles.includes('assigned_crew') && job && actor.user) ctx.actorAssigned = await assignment(actor).assigned(job);
    if (ctx.automated) return;
    if (actor.kind === 'customer') {
      if (ctx.source === 'portal' && policy.roles.includes('customer') && account && actor.customerAccountId === account.id) return;
      throw fail('messaging_forbidden', 'This message cannot be requested from this account.', 403);
    }
    const dispatcher = hasBusinessAccess(actor) && ['owner', 'manager'].includes(actor.role);
    if (policy.roles.includes('dispatcher') && dispatcher) return;
    if (policy.roles.includes('business') && hasBusinessAccess(actor)) return;
    if (policy.roles.includes('assigned_crew') && ctx.actorAssigned) return;
    if (policy.roles.includes('account_staff') && account && staffGate(actor) === true && await accountAccess(actor, account) === true) return;
    throw forbidden(policy);
  }

  async function variable(name, ctx) {
    const { job, account, policy, overrides, actor } = ctx;
    if (name === 'firstName') return firstWord(policy.audience === 'crew' ? ctx.crew?.name : account ? account.firstName || account.name : job?.customer);
    if (name === 'companyPhone') return COMPANY_PHONE;
    if (name === 'etaMinutes') return overrides.etaMinutes === undefined ? '' : String(overrides.etaMinutes);
    // A crew notice names its own work (a segment, days taken away, or both),
    // which can differ from the job's own date and time: every lost day, and
    // the first new or changed slot with any others.
    const slot = policy.audience === 'crew' && ctx.notice ? ctx.notice : null;
    const budget = CREW_DATE_CAP[ctx.kind] || CREW_DATE_CAP.crew_assignment;
    if (name === 'serviceDate' && slot) return ctx.kind === 'crew_unassignment' ? describeLost(slot.lost, { working: slot.slots, max: budget }) : describeWork(slot.added, { batch: slot.batch, max: budget });
    if (name === 'removedDates') return slot ? describeLost(slot.lost, { working: slot.slots, max: budget }) : '';
    if (name === 'serviceDate') return dateText(job?.date);
    if (name === 'arrivalWindow' && slot && (slot.segmentId || slot.date !== job?.date || slot.time !== job?.time)) { const start = minutesOf(slot.time); return start === null ? '' : clockText(start); }
    if (name === 'arrivalWindow') {
      // Dispatch's saved window (or its enabled default) is what the customer
      // was promised; the start-time estimate is only the legacy fallback.
      const promised = job ? arrivalWindowFields(job, arrivalSettings(env)).arrivalWindow : null;
      if (promised) return promised;
      const start = minutesOf(job?.time), window = Number.isInteger(job?.arrivalWindowMinutes) && job.arrivalWindowMinutes > 0 && job.arrivalWindowMinutes <= 240 ? job.arrivalWindowMinutes : 60;
      return start === null ? '' : `${clockText(start)}–${clockText(start + window)}`;
    }
    if (name === 'invoiceNumber') return String(job?.invoice?.number || '');
    if (name === 'balance') return usd(ctx.kind === 'deposit_reminder' ? depositDue(job) : invoiceBalance(job));
    if (name === 'dueDate') return dateText(ctx.kind === 'estimate_expiring' ? job?.estimate?.validUntil : job?.invoice?.dueDate, false);
    if (name === 'crewLeadName') return firstWord(await rosterName(job?.crewLead) || (ctx.actorAssigned ? actor.displayName || actor.user : '') || await rosterName(jobCrewNames(job)[0]));
    return '';
  }

  // Every day a crew notice names must fit one text: serviceDate (the new or
  // changed work, or the days lost for a removal) and removedDates share what
  // the wording, the first name, the arrival window and the real link leave
  // under the SMS limit. Each offers only lossless forms (every change named,
  // or the first ones named and the rest counted), each at most CREW_DATE_CAP
  // when it can be. The pair that fits and leaves the fewest changes only
  // counted wins, then the one naming more of the days taken away, then the
  // more readable. When no pair fits, the most compact forms render and the
  // SMS limit refuses the text (messaging_sms_too_long): the notice fails
  // where a dispatcher sees it instead of going out with days missing.
  async function fitCrewDates(ctx, template, values, dated) {
    const vars = { ...values };
    for (const name of Object.keys(vars).filter(name => LINK_VARIABLES.includes(name))) {
      const provider = linkProviders[name];
      const link = typeof provider === 'function' ? await Promise.resolve().then(() => provider({ kind: ctx.kind, audience: ctx.policy.audience, sendKey: '', ledgerId: '', job: ctx.job, account: ctx.account, purpose: 'preview' })).catch(() => undefined) : undefined;
      vars[name] = typeof link === 'string' && link ? link : DUMMY_LINK;
    }
    const { room, counts } = templateRoom(template, vars, dated), notice = ctx.notice;
    const cap = CREW_DATE_CAP[ctx.kind] || CREW_DATE_CAP.crew_assignment, size = text => [...text].length;
    const lost = () => lostOptions(notice.lost, { working: notice.slots });
    const options = dated.map(name => {
      const all = name === 'removedDates' || ctx.kind === 'crew_unassignment' ? lost() : workOptions(notice.added, { batch: notice.batch });
      const capped = all.filter(option => size(option.text) <= cap);
      return capped.length ? capped : all.length ? [shortestOption(all)] : [{ text: '', unnamed: 0, style: 0 }];
    });
    const lossAt = dated.indexOf('removedDates');
    const rank = picks => [picks.reduce((sum, pick) => sum + pick.unnamed, 0), lossAt < 0 ? 0 : picks[lossAt].unnamed, -picks.reduce((sum, pick) => sum + pick.style, 0)];
    const better = (left, right) => { for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] < right[index]; return false; };
    let best = null;
    const walk = (index, picks) => {
      if (index < dated.length) { for (const option of options[index]) walk(index + 1, [...picks, option]); return; }
      if (picks.reduce((sum, pick, at) => sum + counts[dated[at]] * size(pick.text), 0) > room) return;
      const score = rank(picks);
      if (!best || better(score, best.score)) best = { score, picks };
    };
    walk(0, []);
    const chosen = best ? best.picks : options.map(shortestOption);
    return Object.fromEntries(dated.map((name, index) => [name, chosen[index].text]));
  }

  function recipientSource(ctx) {
    if (ctx.policy.audience === 'crew') return { contactId: ctx.crew?.highlevelContactId || '', phone: ctx.crew?.phone || '', email: ctx.crew?.email || '', name: ctx.crew?.name || '' };
    const record = ctx.account || ctx.job;
    return { contactId: String(record.highlevelContactId || ''), phone: String(record.phone || ''), email: String(record.email || ''), name: String(ctx.account ? record.name || [record.firstName, record.lastName].filter(Boolean).join(' ') : record.customer || '') };
  }

  // Validation, the pre-read role gate, the target record and authorization.
  // keyMs is the instant the send key is derived from (the preview time for a
  // confirmed send); eligibility always uses the current time.
  async function prepare(actor, input, keyMs) {
    if (!object(input) || Object.keys(input).some(key => !INPUT_KEYS.includes(key))) throw fail('messaging_request_invalid', 'This message request contains unsupported fields.');
    if (input.requestId !== undefined && !UUID.test(input.requestId)) throw fail('messaging_request_invalid', 'Use a unique request ID.');
    const policy = messagePolicy(input.kind);
    if (!policy) throw fail('messaging_kind_unknown', 'Choose a supported message type.');
    if (policy.adapterOnly) throw fail('messaging_kind_adapter_only', 'This message is sent by its existing automatic workflow and cannot be sent here.', 409);
    const source = actor?.source || 'hub', automated = actor?.kind === 'system';
    if (!policy.triggers.includes(source)) throw fail('messaging_trigger_not_allowed', 'This message cannot be sent from here.', 403);
    if (automated && (source !== 'cron' || !policy.approvals.includes('owner_automation'))) throw fail('messaging_forbidden', 'This message cannot be sent automatically.', 403);
    if (!automated && !actor?.user) throw fail('messaging_sign_in_required', 'Sign in to the Employee Hub to send messages.', 401);
    const overrides = parseOverrides(policy, input.overrides);
    // Crew notices are queued by dispatch and only the scheduler sends them.
    if (overrides.noticeId !== undefined && !automated) throw fail('messaging_override_not_allowed', 'This message type does not allow those changes.', 400);
    const crewOnly = automated ? false : gate(policy, actor, source, input);
    const at = now(), { job, account } = await readTarget(policy, input, crewOnly), keyAt = new Date(keyMs ?? at.getTime());
    const ctx = { kind: input.kind, input, policy, actor, source, automated, overrides, job, account, now: at, nowMs: at.getTime(), today: denverToday(at), keyMs: keyAt.getTime(), keyDay: denverToday(keyAt), actorAssigned: false, crewId: overrides.crewId || '' };
    await authorize(ctx);
    return ctx;
  }

  // Everything except link generation: template, display render,
  // deterministic send key and the recipient binding.
  async function context(actor, input, keyMs) {
    const ctx = await prepare(actor, input, keyMs), { policy, job, account, overrides, automated } = ctx;
    // FIELD_LEAD_ONLY_COMPLETE narrows the crew's on-my-way send to the job's crew lead (fieldCapabilities.sendOnMyWay); status stays readable.
    if (policy.kind === 'on_my_way' && fieldLeadOnlyComplete(env) && !automated && !(hasBusinessAccess(actor) && ['owner', 'manager'].includes(actor.role)) && !await fieldJobLead({ session: actor, job, access: assignment(actor) }).catch(() => false)) throw fail('messaging_forbidden', 'Only the crew lead or a manager can send the on-my-way message for this job.', 403);
    if (policy.audience === 'crew') {
      // A removal notice goes to someone no longer on the job; every other crew
      // message needs the recipient assigned now, by username or (on a legacy
      // job) by a display name only they carry on the roster.
      // When the roster cannot be read, a crew stored by display name cannot be
      // matched yet: that is a wait (roster_unavailable), never "not assigned".
      const onJob = async () => {
        if (jobCrewNames(job).some(name => assignmentKey(name) === ctx.crewId)) return true;
        const { rows, ok } = await rosterRead();
        if (jobCrewIds(job, rows).has(ctx.crewId)) return true;
        if (!ok) throw fail('messaging_not_eligible', 'The crew roster could not be read. Try again shortly.', 409, { reason: 'roster_unavailable' });
        return false;
      };
      if (!ctx.crewId || (policy.crewAssigned !== false && !await onJob())) throw fail('messaging_not_eligible', 'Choose a crew member assigned to this job.', 409, { reason: 'crew_not_assigned' });
      if (overrides.noticeId !== undefined) {
        ctx.notice = await crewNotice({ noticeId: overrides.noticeId, crewId: ctx.crewId, kind: ctx.kind, job, now: ctx.now });
        if (!object(ctx.notice) || ctx.notice.id !== overrides.noticeId || ctx.notice.valid !== true) throw fail('messaging_not_eligible', 'This crew notice no longer matches the schedule.', 409, { reason: /^[a-z][a-z0-9_]{0,63}$/.test(String(ctx.notice?.reason || '')) ? ctx.notice.reason : 'notice_unavailable' });
      }
      ctx.crew = await crewContact({ crewId: ctx.crewId, job });
      if (!object(ctx.crew) || !ctx.crew.name) throw fail('messaging_recipient_unavailable', 'This crew member\'s contact details are not available for messaging yet.', 409, { reason: 'crew_contact_unavailable' });
    }
    const eligibility = policy.eligible(ctx);
    if (!eligibility.eligible) throw fail('messaging_not_eligible', 'This message does not apply to this record right now.', 409, { reason: eligibility.reason });
    let template;
    if (policy.customBody && overrides.body !== undefined) {
      const version = validateTemplateVersion({ channel: overrides.channel || 'SMS', subject: overrides.channel === 'Email' ? 'A note from Easy Garage Cleaning' : '', body: overrides.body }, TEMPLATE_KINDS[policy.template].variables);
      template = { kind: '', version: null, hash: '', ...version, humanAuthored: true, automationEnabled: false };
    } else {
      template = await templates.active(policy.template);
      if (!template) throw fail('messaging_template_not_approved', 'The owner must approve this message wording before it can be sent.', 409);
    }
    if (automated && template.automationEnabled !== true) throw fail('messaging_automation_disabled', 'The owner has not turned on automatic sending for this message.', 409);
    const names = [...new Set([...templateVariables(template.subject || ''), ...templateVariables(template.body)])];
    const values = {};
    // A crew notice's dates are sized to the room the rest of its text leaves.
    const dated = policy.audience === 'crew' && ctx.notice && template.channel === 'SMS' ? CREW_DATED.filter(name => names.includes(name)) : [];
    for (const name of names) if (!dated.includes(name)) values[name] = LINK_VARIABLES.includes(name) ? DUMMY_LINK : await variable(name, ctx);
    if (dated.length) Object.assign(values, await fitCrewDates(ctx, template, values, dated));
    const display = renderTemplate(template, values).display;
    const bodyHash = await messageDigest({ channel: template.channel, subject: display.subject, body: display.body });
    ctx.bodyHash = bodyHash;
    const sendKey = policy.dedupe(ctx), contact = recipientSource(ctx);
    const destination = recipientDestination(template.channel, contact);
    const recipientHash = destination ? await messageDigest(`${template.channel}:${destination}`) : '';
    const record = job || account;
    const fingerprint = await messageDigest({ bodyHash, recipientHash, contactId: contact.contactId, notify: record.notify ?? null, automation: record.customerAutomationEnabled ?? null, template: template.hash || '', sendKey });
    return Object.assign(ctx, { template, names, values, display, sendKey, ledgerId: await ledgerId(sendKey), contact, destination, recipientHash, fingerprint });
  }

  // Link providers must be side-effect free for purpose 'preview' and
  // idempotent per sendKey for purpose 'send'. Real links are never stored.
  async function finalize(ctx, purpose) {
    const values = { ...ctx.values };
    for (const name of ctx.names.filter(name => LINK_VARIABLES.includes(name))) {
      const provider = linkProviders[name];
      values[name] = typeof provider === 'function' ? await provider({ kind: ctx.kind, audience: ctx.policy.audience, sendKey: ctx.sendKey, ledgerId: ctx.ledgerId, job: ctx.job, account: ctx.account, purpose }) : undefined;
    }
    const rendered = renderTemplate(ctx.template, values);
    const files = await attachments({ kind: ctx.kind, sendKey: ctx.sendKey, job: ctx.job, account: ctx.account, purpose });
    if (!Array.isArray(files) || files.length > 10 || files.some(file => !object(file) || typeof file.name !== 'string' || typeof file.url !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(file.url))) throw fail('messaging_attachment_invalid', 'A message attachment could not be verified.', 409);
    return { rendered, files: files.map(file => ({ name: file.name.slice(0, 120), url: file.url })) };
  }

  function suppression(ctx) {
    const record = ctx.job || ctx.account;
    if (ctx.policy.audience === 'customer' && record.notify === false) return { status: 'suppressed', reason: 'job_notifications_off' };
    if (ctx.automated && ctx.policy.audience === 'customer' && record.customerAutomationEnabled !== true) return { status: 'suppressed', reason: 'customer_automation_off' };
    if (!ctx.destination) return { status: 'needs_contact', reason: ctx.template.channel === 'SMS' ? 'no_phone' : 'no_email' };
    if (ctx.policy.audience === 'crew' && !ctx.contact.contactId) return { status: 'needs_contact', reason: 'staff_contact_not_linked' };
    return null;
  }

  // Staff messages never create or update a HighLevel contact: they go only to
  // the linked staff contact, which must carry the staff tag. Customer sends
  // upsert from saved data as before.
  const lookup = (ctx, upsert) => ({ ...ctx.contact, preferred: ctx.template.channel, ...(ctx.policy.audience === 'crew' ? { upsert: false, requiredTag: STAFF_CONTACT_TAG } : { upsert }) });

  function held(existing, ctx, flags) {
    if (!existing) return null;
    if (HELD.has(existing.status)) return { status: existing.status === 'submitted' ? 'already_sent' : existing.status, attempts: existing.attempts || 0, alreadyRecorded: true };
    if (existing.status === 'dry_run' && flags.dryRun) return { status: 'dry_run', attempts: existing.attempts || 0, alreadyRecorded: true };
    // HighLevel accepted it after a person marked it not delivered: it reached the customer, so it is never sent again.
    if (lateSubmitted(existing)) return { status: 'already_sent', reason: 'late_result_submitted', attempts: existing.attempts || 0, alreadyRecorded: true };
    if (existing.status === 'failed' && Number(existing.attempts || 0) >= ctx.policy.maxAttempts) return { status: 'attempts_exhausted', attempts: existing.attempts, alreadyRecorded: true };
    return null;
  }

  function summary(ctx) {
    return {
      kind: ctx.kind, sendKey: ctx.sendKey, approval: approvalMode(ctx), channel: ctx.template.channel,
      template: ctx.template.humanAuthored ? { kind: '', version: null, hash: '', humanAuthored: true } : { kind: ctx.template.kind, version: ctx.template.version, hash: ctx.template.hash },
      subject: ctx.display.subject, body: ctx.display.body, recipient: { channel: ctx.template.channel, masked: maskRecipient(ctx.template.channel, ctx.destination) },
    };
  }

  function approvalMode(ctx) {
    if (ctx.automated) return 'owner_automation';
    if (ctx.actor.kind === 'customer') return 'customer_initiated';
    return ctx.policy.approvals.find(mode => HUMAN_APPROVALS.includes(mode)) || '';
  }

  async function preview(actor, input) {
    const ctx = await context(actor, input), flags = messagingFlags(env), base = summary(ctx);
    const blocked = suppression(ctx);
    if (blocked) return { ...base, ...blocked, delivery: flags };
    const { rendered, files } = await finalize(ctx, 'preview');
    const result = { ...base, attachments: files.map(file => file.name), length: [...rendered.body].length, delivery: flags };
    const prior = held(await store.read(MESSAGE_SENDS, ctx.ledgerId), ctx, flags);
    if (prior) return { ...result, ...prior };
    const recipient = await messenger.resolveRecipient(lookup(ctx, false));
    result.recipient = { channel: ctx.template.channel, masked: recipient.masked || '' };
    if (recipient.status !== 'ready') return { ...result, status: recipient.status, reason: recipient.reason || '' };
    if (!HUMAN_APPROVALS.includes(result.approval)) return { ...result, status: 'ready' };
    const expiresAt = ctx.nowMs + CONFIRM_TTL_MS;
    const confirmToken = await createConfirmToken(secret, { actorId: assignmentKey(actor.user), ledgerId: ctx.ledgerId, bodyHash: ctx.bodyHash, recipientHash: ctx.recipientHash, issuedAt: ctx.nowMs, expiresAt });
    return { ...result, status: 'ready', confirmToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  function ledgerRecord(ctx, approval, recipient, files) {
    const record = ctx.job || ctx.account;
    return {
      sendKey: ctx.sendKey, kind: ctx.kind, audience: ctx.policy.audience, targetType: ctx.policy.target, targetId: record.id, approval, source: ctx.source,
      actorId: ctx.automated ? String(ctx.actor.id || 'automation') : assignmentKey(ctx.actor.user), actorRole: ctx.automated ? 'system' : String(ctx.actor.role || ctx.actor.kind || ''),
      templateKind: ctx.template.kind || '', templateVersion: ctx.template.version ?? null, templateHash: ctx.template.hash || '', humanAuthored: ctx.template.humanAuthored === true,
      channel: ctx.template.channel, recipient: recipient.masked || '', recipientHash: ctx.recipientHash, contactId: recipient.contactId || '',
      subject: ctx.display.subject, body: ctx.display.body, bodyHash: ctx.bodyHash, attachments: files.map(file => file.name), requestId: ctx.input.requestId || '',
      // A crew notice's claim records the other queued visits its text names
      // (a grouped recurring-run text), so they close only with a text that
      // named them, whichever attempt of whichever tick sent it.
      ...(ctx.notice ? { noticeBatch: noticeBatchIds(ctx.notice.batch) } : {}),
    };
  }

  async function mirror(ctx, state) {
    // A dispatch crew notice is recorded on its own notice row and ledger.
    // Writing the job would move its revision minutes after a dispatch save,
    // while a dispatcher may still be editing it, and crowd its customer log.
    if (!ctx.job || ctx.overrides.noticeId !== undefined) return 'skipped';
    const entryId = `msg:${ctx.ledgerId.slice(0, 32)}`, at = state.completedAt || state.attemptedAt;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const job = await store.read('jobs', ctx.job.id);
        if (!job) return 'skipped';
        const entry = {
          id: entryId, event: ctx.kind, label: TEMPLATE_KINDS[ctx.policy.template]?.label || ctx.kind, status: state.status, source: ctx.source,
          actor: state.actorId, actorRole: state.actorRole, policy: state.approval, templateKind: state.templateKind, templateVersion: state.templateVersion,
          channel: state.channel, recipient: state.recipient, attempt: state.attempts, messageId: state.messageId || '', attemptedAt: at,
        };
        const log = [...(Array.isArray(job.communicationLog) ? job.communicationLog : []).filter(item => item?.id !== entryId), entry].slice(-40);
        const patch = { communicationLog: log, updatedAt: at }, reached = ctx.policy.audience === 'customer' && ['submitted', 'failed', 'uncertain'].includes(state.status);
        // The Hub attention queue only flags 'needs_attention'. Dry runs and
        // staff messages leave it alone, and a success never hides an earlier
        // problem with a different message.
        const attention = state.status !== 'submitted';
        if (reached && (attention || job.communicationLastStatus !== 'needs_attention' || job.communicationLastEvent === ctx.kind)) {
          Object.assign(patch, { communicationLastEvent: ctx.kind, communicationLastStatus: attention ? 'needs_attention' : state.status, communicationLastAt: at });
        }
        // Billing kinds stay out of the customer thread, which assigned crew
        // can read; the business-only communication log still records them.
        if (reached && !ctx.policy.billing) {
          const delivery = { channel: state.channel === 'SMS' ? 'sms' : 'highlevel', status: state.status === 'submitted' ? 'sent' : ['failed', 'uncertain'].includes(state.status) ? state.status : 'queued', attemptedAt: at, messageId: state.messageId || '', conversationId: state.conversationId || '' };
          patch.customerConversation = appendConversationMessage(job, {
            id: `msg_${ctx.ledgerId.slice(0, 24)}_${state.attempts}`, requestId: `egc-send-${ctx.ledgerId.slice(0, 24)}-${state.attempts}`, providerMessageId: state.messageId || '',
            direction: 'to_customer', authorRole: ['crew', 'crew_lead'].includes(ctx.actor.role) ? 'crew' : 'manager', authorName: ctx.automated ? 'Easy Garage Cleaning' : String(ctx.actor.displayName || 'Easy Garage Cleaning').slice(0, 120),
            body: state.body, createdAt: at, delivery,
          });
          patch.customerConversationUpdatedAt = at;
        }
        await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch }]);
        return 'saved';
      } catch { /* Display copy only. Never repeat the external send. */ }
    }
    return 'failed';
  }

  async function send(actor, input) {
    const flags = messagingFlags(env);
    if (!flags.enabled) throw fail('messaging_disabled', 'Messaging is turned off. Nothing was sent.', 409);
    const human = actor?.kind !== 'system' && actor?.kind !== 'customer', startMs = now().getTime();
    const keyMs = human && typeof input?.confirmToken === 'string' ? tokenKeyTime(input.confirmToken, startMs) : startMs;
    const ctx = await context(actor, input, keyMs), approval = approvalMode(ctx), base = summary(ctx);
    if (!approval || !ctx.policy.approvals.includes(approval)) throw fail('messaging_forbidden', 'This message needs a different approval before it can be sent.', 403);
    if (HUMAN_APPROVALS.includes(approval)) await verifyConfirmToken(secret, input.confirmToken, { actorId: assignmentKey(actor.user), ledgerId: ctx.ledgerId, bodyHash: ctx.bodyHash, recipientHash: ctx.recipientHash }, ctx.nowMs);
    const blocked = suppression(ctx);
    if (blocked) return { ...base, ...blocked, delivery: flags };
    const existing = await store.read(MESSAGE_SENDS, ctx.ledgerId);
    const prior = held(existing, ctx, flags);
    if (prior) return { ...base, ...prior, recipient: { channel: ctx.template.channel, masked: existing.recipient || '' }, delivery: flags };
    if (ctx.policy.quietHours && ctx.automated) {
      const quiet = quietHoursDecision(ctx.now);
      if (!quiet.allowed) return { ...base, status: 'deferred', reason: 'quiet_hours', notBefore: quiet.notBefore, delivery: flags };
    }
    // Windows alone could let a daily job send on two consecutive days across
    // a window edge, so automation also waits a full cadence after the
    // previous window's reminder.
    if (ctx.policy.cadenceDays && ctx.automated) {
      const previous = await store.read(MESSAGE_SENDS, await ledgerId(ctx.policy.previousKey(ctx)));
      const lastMs = Date.parse(previous?.attemptedAt || ''), notBefore = lastMs + ctx.policy.cadenceDays * DAY_MS;
      if (HELD.has(previous?.status) && Number.isFinite(lastMs) && notBefore > ctx.nowMs) return { ...base, status: 'deferred', reason: 'reminder_cadence', notBefore: new Date(notBefore).toISOString(), delivery: flags };
    }
    const { rendered, files } = await finalize(ctx, 'send');
    const recipient = await messenger.resolveRecipient(lookup(ctx, true));
    base.recipient = { channel: ctx.template.channel, masked: recipient.masked || '' };
    if (recipient.status !== 'ready') return { ...base, status: recipient.status, reason: recipient.reason || '', delivery: flags };
    if (!recipient.contactId) return { ...base, status: 'needs_contact', reason: 'contact_unresolved', delivery: flags };
    if (recipientDestination(ctx.template.channel, { phone: recipient.toNumber, email: recipient.emailTo }) !== ctx.destination) throw fail('messaging_target_changed', 'The recipient changed while the message was being prepared. Preview it again.', 409);
    // Re-check after the slow provider lookup: approval, contact, notification
    // preference, assignment and wording must still match what was confirmed.
    const fresh = await context(actor, input, keyMs);
    if (fresh.fingerprint !== ctx.fingerprint) throw fail('messaging_target_changed', 'This record changed while the message was being prepared. Preview it again.', 409);
    // The caller may refuse to claim when it cannot also finish the provider
    // call and the ledger write (for example a spent subrequest budget).
    await reserve(ctx);
    const at = now().toISOString(), attemptId = crypto.randomUUID();
    const attempts = Number(existing?.attempts || 0) + (flags.dryRun ? 0 : 1);
    const claim = {
      ...ledgerRecord(ctx, approval, recipient, files), status: flags.dryRun ? 'dry_run' : 'sending', attemptId, attempts,
      idempotencyKey: `egc-msg-${ctx.ledgerId.slice(0, 40)}-${attempts}`, createdAt: existing?.createdAt || at, attemptedAt: at, completedAt: flags.dryRun ? at : '',
      messageId: '', conversationId: '', httpStatus: null, reason: '',
      history: [...(Array.isArray(existing?.history) ? existing.history : []), { attempt: attempts, status: flags.dryRun ? 'dry_run' : 'sending', at, actorId: ctx.automated ? 'automation' : assignmentKey(actor.user), requestId: input.requestId || '' }].slice(-10),
    };
    try {
      await store.commit([{ collection: MESSAGE_SENDS, id: ctx.ledgerId, ...(existing ? { revision: existing.revision } : {}), patch: claim }]);
    } catch (error) {
      // A lost commit response may still have claimed the send for us.
      const latest = await store.read(MESSAGE_SENDS, ctx.ledgerId).catch(() => null);
      if (latest?.attemptId !== attemptId) {
        if (error?.code === 'messaging_revision_conflict' || latest) return { ...base, status: latest?.status === 'submitted' ? 'already_sent' : latest?.status || 'sending', attempts: latest?.attempts || 0, alreadyRecorded: true, delivery: flags };
        throw error;
      }
    }
    if (flags.dryRun) return { ...base, status: 'dry_run', attempts, attachments: claim.attachments, mirror: await mirror(ctx, claim), delivery: flags };
    const result = await messenger.send({
      type: ctx.template.channel, contactId: recipient.contactId, message: rendered.body, subject: rendered.subject, html: rendered.html || '',
      attachments: files.map(file => file.url), toNumber: recipient.toNumber || '', emailTo: recipient.emailTo || '', idempotencyKey: claim.idempotencyKey,
    });
    const status = ['submitted', 'failed', 'uncertain'].includes(result?.status) ? result.status : 'uncertain';
    let state = {
      ...claim, status, messageId: status === 'submitted' ? String(result.messageId || '') : '', conversationId: String(result?.conversationId || ''),
      httpStatus: Number.isInteger(result?.httpStatus) ? result.httpStatus : null, reason: String(result?.reason || ''), completedAt: now().toISOString(),
    };
    state.history = [...claim.history.slice(0, -1), { ...claim.history.at(-1), status, completedAt: state.completedAt }];
    let saved = false, reconciled = null, lateSaved = false;
    for (let attempt = 0; attempt < 3 && !saved && !lateSaved; attempt += 1) {
      try {
        const latest = await store.read(MESSAGE_SENDS, ctx.ledgerId);
        if (latest?.attemptId !== attemptId) {
          // A person reconciled this attempt while it was in flight. Their
          // outcome stays on the ledger; what HighLevel answered is kept beside
          // it (a later send sees an accepted message as sent), and the job's
          // display copy is left as the person set it.
          if (!object(latest?.reconciled) || latest.reconciled.attemptId !== attemptId) break;
          reconciled = latest.reconciled;
          const lateResult = { status, messageId: state.messageId, conversationId: state.conversationId, httpStatus: state.httpStatus, reason: state.reason, attempt: attempts, attemptId, at: state.completedAt };
          await store.commit([{ collection: MESSAGE_SENDS, id: ctx.ledgerId, revision: latest.revision, patch: { lateResult } }]);
          lateSaved = true;
          continue;
        }
        await store.commit([{ collection: MESSAGE_SENDS, id: ctx.ledgerId, revision: latest.revision, patch: state }]);
        saved = true;
      } catch { /* Retry the ledger write; never repeat the provider call. */ }
    }
    if (reconciled) return {
      ...base, status, reason: 'reconciled_before_result', messageId: state.messageId, conversationId: state.conversationId, attempts, attachments: claim.attachments,
      ...(state.httpStatus ? { httpStatus: state.httpStatus } : {}), ledgerSaved: false, lateResultSaved: lateSaved, reconciled: { outcome: String(reconciled.outcome || ''), by: String(reconciled.by || ''), at: String(reconciled.at || '') }, mirror: 'skipped', delivery: flags,
    };
    // An unsaved outcome leaves the claim in 'sending', which is never resent.
    if (!saved) state = { ...state, status: status === 'submitted' ? 'submitted' : 'uncertain', reason: 'delivery_status_not_saved' };
    return {
      ...base, status: state.status, reason: state.reason, messageId: state.messageId, conversationId: state.conversationId, attempts, attachments: claim.attachments,
      ...(state.httpStatus ? { httpStatus: state.httpStatus } : {}), ledgerSaved: saved, mirror: await mirror(ctx, state), delivery: flags,
    };
  }

  // Status only authorizes the caller for the kind and record and reads the
  // ledger. It never re-checks eligibility or template approval, so a message
  // stays visible after its job closes, its wording is retired or a day
  // passes. Pass the sendKey returned by preview or send to find a message
  // whose key depended on the time or the text.
  async function status(actor, input) {
    if (!object(input)) throw fail('messaging_request_invalid', 'This message request contains unsupported fields.');
    const { confirmToken, sendKey, ...rest } = input;
    if (sendKey !== undefined && (typeof sendKey !== 'string' || !sendKey || sendKey.length > 400)) throw fail('messaging_request_invalid', 'Use the send key returned by the preview or send.');
    const ctx = await prepare(actor, rest);
    if (sendKey === undefined && ctx.policy.customBody && !ctx.overrides.taskId) throw fail('messaging_request_invalid', 'Use the send key returned when this follow-up was sent.');
    const key = sendKey ?? ctx.policy.dedupe(ctx), record = ctx.job || ctx.account;
    const existing = await store.read(MESSAGE_SENDS, await ledgerId(key));
    const base = { kind: ctx.kind, sendKey: key };
    if (!existing || existing.kind !== ctx.kind || existing.targetType !== ctx.policy.target || existing.targetId !== record.id) return { ...base, status: 'not_sent', attempts: 0 };
    return {
      ...base, channel: existing.channel, status: existing.status, attempts: existing.attempts || 0, recipient: { channel: existing.channel, masked: existing.recipient || '' },
      approval: existing.approval, source: existing.source, actorId: existing.actorId, template: { kind: existing.templateKind, version: existing.templateVersion },
      attemptedAt: existing.attemptedAt || '', completedAt: existing.completedAt || '', messageId: existing.messageId || '',
      ...(object(existing.lateResult) ? { lateResult: { status: String(existing.lateResult.status || ''), messageId: String(existing.lateResult.messageId || ''), at: String(existing.lateResult.at || '') } } : {}),
      canRetry: existing.status === 'failed' && Number(existing.attempts || 0) < ctx.policy.maxAttempts && !lateSubmitted(existing),
    };
  }

  return { preview, send, status };
}
