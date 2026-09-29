import { LIMITS, ROLES, INVITE_HOURS, INVITE_ORIGIN, fail, uid, isId, text, email, personName, safeName, date, digest, randomToken, rights, permitted, staffAllowed, staffCanAccess, activeMember, bounded, requireJobId, requireLinkedJob, businessActor, projectView, accountView, inviteState, receiptExpiry, QUOTA_WINDOW, quotaExpiry } from './business-hub-core.js';
import { PROPERTY_DENIED, memberPropertyIds, canSeeProperty, scopeAccount, isScopedAccount, requireScopedProperty, requireScopedLinkedJob, requestedPropertyIds, scopeKey, applyPropertyIds, memberSummary, propertySummary, businessHubAudit, scopedAccountView, operationReceipt } from './business-hub-scope.js';
import { funnelHubId } from './funnel-definitions.js';
import { projectDimensionPatch, resolveDimensions, visitDimensionFacts } from './funnel-dimensions.js';
const COOKIE = '__Host-egc_business';
// save() persists only a FULL account: one this hub read from storage (including through helpers.store), one it built for a
// new company, or a copyStoredAccount() of one. The marker is private to this module, so no other module can make a scoped
// view, a spread ({...account}) or a clone savable, and masked list rows are never marked.
const STORED = new WeakSet();
// The marker says which object may be saved; RECORDED says what it must still hold. For each stored account it keeps the
// ids its lists held when the hub read or built it. No hub action removes an entry (unlink_project sets active:false,
// revoke_member sets a status, and bounded() refuses a full list instead of trimming it), so a business_accounts write
// that lacks a recorded id would drop records: for example the properties a limited member cannot see, after a module
// copied scoped(ctx) into the stored account. That write is refused with 503 and nothing is written.
const RECORDED = new WeakMap();
const LISTS = Object.freeze({ properties: 'id', requests: 'id', projects: 'jobId', messages: 'id', members: 'id' });
const listed = (account, list) => Array.isArray(account?.[list]) ? account[list] : [];
const entries = account => Object.freeze(Object.fromEntries(Object.keys(LISTS).map(list => [list, Object.freeze(listed(account, list).map(item => item?.[LISTS[list]]))])));
// Each recorded id is still listed, and each list is at least as long as it was (so an entry without an id counts too).
function keepsEntries(account, recorded) {
  return Boolean(recorded) && Object.keys(LISTS).every(list => {
    const items = listed(account, list), ids = new Set(items.map(item => item?.[LISTS[list]]));
    return items.length >= recorded[list].length && recorded[list].every(id => ids.has(id));
  });
}
export const SAVE_REFUSED = 'The business hub could not complete that action. Please retry or contact Zoe.';
function storedAccount(account, recorded = entries(account)) { if (account && typeof account === 'object') { STORED.add(account); RECORDED.set(account, recorded); } return account; }
export const isStoredAccount = account => STORED.has(account) && !isScopedAccount(account);
const savable = account => isStoredAccount(account) && keepsEntries(account, RECORDED.get(account));
const cloneAccount = value => { try { return structuredClone(value); } catch { throw fail(503, SAVE_REFUSED); } };
// The only public way to derive a new account to save: a deep copy of a stored account, never of a scoped view or a spread.
// The copy must still hold every entry the original was read with, whatever the original holds now.
export function copyStoredAccount(account) {
  if (!isStoredAccount(account)) throw fail(503, SAVE_REFUSED);
  return storedAccount(cloneAccount(account), RECORDED.get(account));
}
// What a business_accounts write persists: one snapshot of a stored account, under its own id and still holding every
// recorded entry. The snapshot is both what is checked and what is written, so a getter cannot answer differently.
function accountWrite(account, id) {
  if (!isStoredAccount(account)) throw fail(503, SAVE_REFUSED);
  const data = cloneAccount(account);
  if (data?.id !== id || !keepsEntries(data, RECORDED.get(account))) throw fail(503, SAVE_REFUSED);
  return data;
}
// A write is plain data: a getter on it is refused, since it could answer the check and the store differently.
const plainWrite = w => Boolean(w) && typeof w === 'object' && Object.values(Object.getOwnPropertyDescriptors(w)).every(d => Object.hasOwn(d, 'value'));
const HOURS = 3600000, SESSION = 7 * 86400 * 1000;
// Invitation emails in a rolling day: per member (member.invite.sends), and across every account per mailbox and per EGC
// sender (business_operations quota records). Then the expired sessions removed per sign-in or sign-out, the longest a
// sign-in or sign-out response waits for that purge when the runtime offers no waitUntil, and the access changes kept per member.
const EMAIL_LIMIT = 3, ADDRESS_LIMIT = 3, SENDER_LIMIT = 20, EMAIL_WINDOW = QUOTA_WINDOW, PURGE_LIMIT = 20, PURGE_WAIT = 2000, HISTORY = 10;
const QUOTAS = Object.freeze({
  address: { limit: ADDRESS_LIMIT, message: 'This email address was already sent three invitations in the last 24 hours. Wait before emailing another, or create a private link.' },
  sender: { limit: SENDER_LIMIT, message: `You have emailed ${SENDER_LIMIT} invitations in the last 24 hours. Wait before emailing more, or create private links.` },
});
// One mailbox however it is written: the saved (lowercase) address with any +tag removed from the local part.
const mailbox = address => { const at = address.lastIndexOf('@'); return at < 0 ? address : address.slice(0, at).split('+')[0] + address.slice(at); };
const EVENTS = Object.freeze({ member_invited: 'invited', invite_resent: 'resent', sign_in_reset: 'reset' });
// Audit details keep only the fields that have a value.
const detail = value => Object.fromEntries(Object.entries(value || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
// The member's own record keeps its last HISTORY access changes (who, when, role, generation), so a later invitation never erases a revoke.
function remember(member, entry) { member.accessHistory = [...(Array.isArray(member.accessHistory) ? member.accessHistory : []), detail(entry)].slice(-HISTORY); }
// Delivery outcomes that certainly emailed nothing: they do not count toward the daily email limit.
const NOT_EMAILED = new Set(['not_sent', 'dry_run', 'suppressed', 'needs_contact', 'contact_mismatch', 'not_configured', 'unavailable', 'failed']);
const cookie = (token, age = 7 * 86400) => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
function readCookie(request) { return (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || ''; }
function response(status, data, extra = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } }); }
async function body(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw fail(415, 'Use a JSON request.');
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site' || request.headers.get('X-EGC-Business') !== '1') throw fail(403, 'Reload this page before submitting.');
  const reader = request.body?.getReader(); if (!reader) throw fail(400, 'A request is required.');
  const chunks = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 20000) { await reader.cancel(); throw fail(413, 'This request is too large.'); } chunks.push(value); }
  const buffer = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { const result = JSON.parse(new TextDecoder().decode(buffer)); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { throw fail(400, 'The request could not be read.'); }
}
// Built-in actions always win; extension modules register new names through `actions`, `exports` and `decorate`.
const BUILT_IN = new Set(['redeem', 'logout', 'create_account', 'invite_member', 'resend_invite', 'reset_sign_in', 'revoke_member', 'save_account', 'save_property', 'request_service', 'update_request', 'message', 'link_project', 'unlink_project', 'open_project']);
const EXTENSION = /^[a-z][a-z0-9_]{0,49}$/;
function registry(value, kind) {
  for (const [name, fn] of Object.entries(value || {})) if (!EXTENSION.test(name) || BUILT_IN.has(name) || typeof fn !== 'function') throw new TypeError(`Invalid business hub ${kind}: ${name}`);
  return value || {};
}
// Copy first: Response.redirect() and fetch() results have immutable headers.
function noStore(res) { const out = new Response(res.body, res); for (const [k, v] of [['Cache-Control', 'no-store'], ['X-Content-Type-Options', 'nosniff'], ['Referrer-Policy', 'no-referrer']]) out.headers.set(k, v); return out; }
export function createBusinessHandler({ store, getStaff, finance, needsReview, projectCookie, clearProjectCookie, now = () => Date.now(), invites = null, waitUntil = null, actions = {}, exports: exporters = {}, decorate = [] }) {
  const emailInvites = invites?.enabled === true && typeof invites.deliver === 'function';
  actions = registry(actions, 'action'); exporters = registry(exporters, 'export');
  // Every account the hub reads is marked as the stored record save() accepts, whatever store is injected.
  const readAccount = async id => storedAccount(await store.read('business_accounts', id));
  // save(), actions and exports share this store. A business account read through it is savable with any injected store,
  // so tests and production agree, and no commit (a module's own or save()'s extra writes) can write an account that is
  // not a stored one (a scoped view, a spread, a clone or a partial patch) or one that lost a recorded entry: it is
  // refused with 503 and nothing is written. Each write is copied once and only the copy is checked and committed.
  const hubStore = Object.freeze({
    read: (collection, id) => collection === 'business_accounts' ? readAccount(id) : store.read(collection, id),
    async commit(changes) {
      const writes = Array.from(changes, w => { if (!plainWrite(w)) throw fail(503, SAVE_REFUSED); return { ...w }; });
      for (const w of writes) if (w.collection === 'business_accounts') w.data = accountWrite(w.data, w.id);
      return store.commit(writes);
    },
    list: (...args) => store.list(...args), jobs: ids => store.jobs(ids),
  });
  if (!Array.isArray(decorate) || decorate.some(fn => typeof fn !== 'function')) throw new TypeError('Business hub decorators must be functions.');
  async function context(request, url) {
    if (url.searchParams.get('staff') === '1') {
      const profile = await getStaff(request);
      if (!staffAllowed(profile)) throw fail(403, 'Sign in with an authorized EGC business or sales account.');
      const accountId = url.searchParams.get('account');
      if (!accountId) return { staff: true, manager: profile.businessAccess === true, profile };
      if (!isId(accountId)) throw fail(400, 'Choose a valid account.');
      const account = await readAccount(accountId);
      if (!account || !staffCanAccess(profile, account)) throw fail(403, 'This business account is not assigned to you.');
      return { staff: true, manager: profile.businessAccess === true, profile, account, member: { id: `staff:${profile.user}`, name: profile.displayName || profile.user, role: 'staff' } };
    }
    const raw = readCookie(request);
    if (!/^[a-f0-9]{64}$/.test(raw)) throw fail(401, 'Open your private business sign-in link or contact Zoe.');
    const session = await store.read('business_sessions', await digest(raw));
    if (!session || session.expiresAt <= now()) throw fail(401, 'Your session expired. Ask your account administrator for a new sign-in link.');
    const account = await readAccount(session.accountId);
    const member = activeMember(account, session.memberId, session.memberVersion);
    return { staff: false, manager: false, account, member, session };
  }
  // details: {hub, requestId, before, after} (B2B-SCOPE) extend the business_audit row, and details.hub also writes a hub_audit
  // row in the same commit. Every other key (B2B-INVITE: which member changed, the role granted, the generation and channel)
  // goes into the row's details. Only the stored account itself (or copyStoredAccount of it) is saved: never a scoped view or a
  // copy, and never one that lost an entry it was read with.
  async function save(ctx, action, extra = [], details = null) {
    const account = ctx.account;
    if (!savable(account)) throw fail(503, SAVE_REFUSED);
    account.updatedAt = new Date(now()).toISOString();
    if (new TextEncoder().encode(JSON.stringify(account)).length > 750000) throw fail(409, 'This workspace is at its storage limit. Contact EGC to archive older records; your existing records are unchanged.');
    const { hub: hubAction, requestId, before, after, ...change } = details && typeof details === 'object' ? details : {};
    const trail = details && ['hub', 'requestId', 'before', 'after'].some(key => Object.hasOwn(details, key)) ? { requestId: requestId ?? null, before: before ?? null, after: after ?? null } : {};
    const hub = hubAction ? [businessHubAudit(ctx, { hub: hubAction, requestId, before, after, at: account.updatedAt })] : [];
    const audit = { accountId: account.id, actorId: ctx.member.id, action, at: account.updatedAt, ...trail, ...(Object.keys(change).length ? { details: detail(change) } : {}) };
    await hubStore.commit([
      { collection: 'business_accounts', id: account.id, data: account, version: account._version },
      { collection: 'business_audit', id: uid(), data: audit }, ...extra, ...hub,
    ]);
  }
  function requirePermission(ctx, p) { if (!ctx.staff) permitted(ctx.member, p); }
  function requireManager(ctx) { if (!ctx.staff || !ctx.manager) throw fail(403, 'An EGC business manager must authorize project sharing.'); }
  function property(ctx, id) { return requireScopedProperty(ctx.account, ctx.staff ? null : ctx.member, id); }
  const scopedContext = ctx => ctx.staff ? ctx : { ...ctx, account: scopeAccount(ctx.account, ctx.member) };
  // A client administrator can never leave the company without an active administrator; EGC staff can restore one.
  function keepAdmin(ctx, member) {
    if (member?.role === 'admin' && member.status === 'active' && !ctx.staff && !ctx.account.members.some(m => m.id !== member.id && m.role === 'admin' && m.status === 'active')) throw fail(409, 'Keep at least one active account administrator.');
  }
  // A private link unless staff ask for email; email is used only while BUSINESS_HUB_INVITE_DELIVERY is on.
  function deliveryMode(ctx, input) {
    if (input.deliver == null || input.deliver === 'manual') return 'manual';
    if (input.deliver !== 'email') throw fail(400, 'Choose email or a private link for this invitation.');
    if (!ctx.staff) throw fail(403, 'EGC staff send invitation emails. Create a private link and share it with this person yourself.');
    return 'email';
  }
  const recentEmails = member => (Array.isArray(member.invite?.sends) ? member.invite.sends : []).filter(at => Number.isFinite(at) && at > now() - EMAIL_WINDOW);
  // business_operations/{requestId} receipts: a retry reports the saved invitation status. Tokens are never replayed and nothing is re-sent.
  async function receipt(ctx, operation, action, parts) {
    const fingerprint = await digest(JSON.stringify([action, ctx.member.id, ...parts])), saved = await store.read('business_operations', operation);
    if (saved && (saved.action !== action || saved.actorId !== ctx.member.id || saved.fingerprint !== fingerprint)) throw fail(409, 'Request reference already exists.');
    const at = now();
    return { saved, data: { action, actorId: ctx.member.id, fingerprint, accountId: ctx.account.id, at: new Date(at).toISOString(), expireAt: receiptExpiry(at) } };
  }
  // The saved status only while that invitation generation is still the member's current access; a later resend, reset or revoke supersedes it.
  async function replayed(saved, account) {
    account ||= await store.read('business_accounts', saved.accountId);
    const member = account?.members?.find(m => m.id === saved.memberId), current = Boolean(member) && member.version === saved.generation && member.invite?.generation === saved.generation;
    return { ok: true, duplicate: true, accountId: saved.accountId, memberId: saved.memberId, email: member?.email || '', delivery: { channel: saved.deliver || 'manual', status: current ? member.invite.status : member?.status === 'revoked' ? 'revoked' : 'superseded' } };
  }
  // Cross-account email caps in business_operations: one record per EGC sender and one per mailbox (hashed ids), each holding
  // the attempts of the last 24 hours. They are written in the same version-preconditioned commit as the invitation.
  async function quotaIds(ctx, member) {
    return { address: await digest('invite-address:' + mailbox(member.email)), sender: await digest('invite-quota:' + String(ctx.profile?.user || '').toLowerCase()) };
  }
  const quotaSends = doc => (Array.isArray(doc?.sends) ? doc.sends : []).filter(entry => Number.isFinite(entry?.at) && entry.at > now() - EMAIL_WINDOW);
  async function claimQuotas(ctx, member, attemptId, at) {
    const ids = await quotaIds(ctx, member), writes = [];
    for (const scope of Object.keys(QUOTAS)) {
      const doc = await store.read('business_operations', ids[scope]), sends = quotaSends(doc);
      if (sends.length >= QUOTAS[scope].limit) throw fail(429, QUOTAS[scope].message);
      const next = [...sends, { at, attemptId, accountId: ctx.account.id, memberId: member.id }];
      writes.push({ collection: 'business_operations', id: ids[scope], version: doc?._version,
        data: { kind: 'invite_email_quota', scope, sends: next, updatedAt: new Date(at).toISOString(), expireAt: quotaExpiry(next, at) } });
    }
    return { ids: Object.values(ids), writes };
  }
  // Save the email outcome against this exact generation and claim. A re-read that finds another stops; the send is never repeated.
  // An outcome that emailed nothing also takes this attempt back off the member, mailbox and sender limits, even after a newer change.
  async function recordDelivery(ctx, memberId, generation, attemptId, issuedAt, sent, quotas = []) {
    const release = NOT_EMAILED.has(sent.status);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const account = await readAccount(ctx.account.id), member = account?.members?.find(m => m.id === memberId);
        const current = Boolean(member) && member.version === generation && member.invite?.attemptId === attemptId;
        const sends = Array.isArray(member?.invite?.sends) ? member.invite.sends : [], index = release ? sends.lastIndexOf(issuedAt) : -1;
        const freed = [], at = now();
        for (const id of release ? quotas : []) {
          const doc = await store.read('business_operations', id), list = Array.isArray(doc?.sends) ? doc.sends : [], kept = list.filter(entry => entry?.attemptId !== attemptId);
          if (kept.length !== list.length) freed.push({ collection: 'business_operations', id, version: doc._version, data: { kind: doc.kind, scope: doc.scope, sends: kept, updatedAt: new Date(at).toISOString(), expireAt: quotaExpiry(kept, at) } });
        }
        if (!account || (!current && index < 0 && !freed.length)) return false;
        if (index >= 0) sends.splice(index, 1);
        if (current) Object.assign(member.invite, { status: sent.status, reason: sent.reason || '', messageId: sent.messageId || '', completedAt: new Date(now()).toISOString() });
        await save({ account, member: ctx.member }, current ? 'invite_delivery_recorded' : 'invite_email_released', freed,
          { memberId, generation, channel: 'email', status: sent.status, reason: sent.reason, released: release || undefined });
        return current;
      } catch { /* Re-read and retry the record only. */ }
    }
    return false;
  }
  // One atomic commit writes the new link hash, member.invite, the receipt and the email caps. The email is sent in this same
  // request because the raw token is never stored; a new generation (resend or reset) makes every earlier link fail.
  async function issue(ctx, member, action, { requested = 'manual', operation = null, receiptData = null, details = {}, trail = null } = {}) {
    const channel = requested === 'email' && emailInvites ? 'email' : 'manual', sends = recentEmails(member), at = now();
    if (channel === 'email' && sends.length >= EMAIL_LIMIT) throw fail(429, 'This person was already emailed three invitations in the last 24 hours. Wait before emailing another, or create a private link.');
    // A name saved before names were checked is never put into an EGC email greeting.
    if (channel === 'email' && !safeName(member.name)) throw fail(409, 'This person’s saved name is not a plain name, so EGC will not email it. Invite them again with the name corrected, or create a private link.');
    const token = randomToken(), attemptId = channel === 'email' ? uid() : '';
    const quotas = channel === 'email' ? await claimQuotas(ctx, member, attemptId, at) : { ids: [], writes: [] };
    const previousStatus = member.status;
    delete member.sessionExpiresAt; delete member.revokedAt; delete member.revokedBy;
    Object.assign(member, { version: member.version + 1, status: 'invited', inviteHash: await digest(token), inviteExpiresAt: at + INVITE_HOURS * HOURS });
    member.invite = { generation: member.version, channel, status: channel === 'email' ? 'sending' : 'manual', ...(attemptId ? { attemptId } : {}), sentBy: ctx.member.id,
      requestedAt: new Date(at).toISOString(), sends: channel === 'email' ? [...sends, at] : sends };
    const change = { memberId: member.id, role: member.role, generation: member.version, channel, requestedChannel: requested !== channel ? requested : undefined, previousStatus, ...details };
    remember(member, { event: EVENTS[action] || action, at: new Date(at).toISOString(), by: ctx.member.id, role: member.role, previousRole: details.previousRole, generation: member.version, channel, previousStatus });
    // trail {hub, requestId, before} (B2B-SCOPE): the member summary after this change joins the audit rows.
    await save(ctx, action, [...(receiptData ? [{ collection: 'business_operations', id: operation, data: { ...receiptData, memberId: member.id, generation: member.version, deliver: channel } }] : []), ...quotas.writes], trail ? { ...change, ...trail, after: memberSummary(member) } : change);
    const code = `${ctx.account.id}.${member.id}.${token}`, result = { email: member.email, expiresInHours: INVITE_HOURS, memberId: member.id };
    if (channel !== 'email') return { invite: code, ...result, ...(requested === 'email' ? { delivery: { channel, status: 'manual', reason: 'email_delivery_off' } } : {}) };
    const link = new URL('/business-hub', INVITE_ORIGIN); link.hash = `invite=${code}`;
    const sent = await invites.deliver({ actor: ctx.profile, accountId: ctx.account.id, memberId: member.id, generation: member.version, link: link.href, requestId: operation || '', read: (c, id) => store.read(c, id), now });
    const recorded = await recordDelivery(ctx, member.id, member.version, attemptId, at, sent, quotas.ids);
    // The link is returned only when the email was not accepted, as the manual fallback for the same single-use invitation.
    return { ...(sent.status === 'submitted' ? {} : { invite: code }), ...result, delivery: { channel, status: sent.status, reason: sent.reason, recorded } };
  }
  async function invite(ctx, input, { operation = null, receiptData = null } = {}) {
    requirePermission(ctx, 'team');
    const role = text(input.role, 20, true); if (!Object.hasOwn(ROLES, role)) throw fail(400, 'Select an available account role.');
    const address = email(input.email), name = personName(input.name), requested = deliveryMode(ctx, input);
    // Omitted propertyIds keep a renewed member's saved scope; administrators always see every property.
    const propertyIds = requestedPropertyIds(ctx.account, input.propertyIds);
    if (role === 'admin' && propertyIds) throw fail(400, 'Account administrators always have access to every property.');
    if (requested === 'email' && !operation) throw fail(400, 'Reload the form and try again.');
    // A replayed invitation is not re-issued and its link is never replayed (only its hash is stored).
    if (operation && !receiptData) {
      const found = await receipt(ctx, operation, 'invite_member', [ctx.account.id, address, name, role, requested, scopeKey(propertyIds)]);
      if (found.saved) return replayed(found.saved, ctx.account);
      receiptData = found.data;
    }
    let member = ctx.account.members.find(m => m.email === address);
    if (member && !ctx.staff && member.id === ctx.member.id) throw fail(409, 'You are already signed in. When this sign-in ends, ask another administrator or EGC for a new link.');
    keepAdmin(ctx, member);
    // A signed-in person keeps their session. Pending, expired and revoked access, and active members whose seven-day
    // sign-in has ended (or who signed out), can be renewed. Members saved before sessionExpiresAt existed stay renewable.
    if (member?.status === 'active' && member.sessionExpiresAt > now()) throw fail(409, 'This person is still signed in; their current sign-in lasts up to seven days. Revoke their access first if they need a replacement link now.');
    const before = memberSummary(member), previousRole = member ? member.role : undefined;
    if (!member) { bounded(ctx.account, 'members'); member = { id: uid(), version: 0 }; ctx.account.members.push(member); }
    Object.assign(member, { name, email: address, role });
    applyPropertyIds(member, propertyIds);
    return issue(ctx, member, 'member_invited', { requested, operation, receiptData, details: previousRole === undefined ? { created: true } : { previousRole: previousRole !== role ? previousRole : undefined },
      trail: { hub: 'business.member_invited', requestId: operation, before } });
  }
  // Bounded, best-effort removal of expired session records on sign-in and sign-out; it never changes the action's result.
  // It runs after the response through waitUntil, or delays the response by at most PURGE_WAIT when there is none.
  async function purgeSessions() {
    if (typeof store.purgeExpiredSessions !== 'function') return;
    const task = Promise.resolve().then(() => store.purgeExpiredSessions(now(), PURGE_LIMIT)).catch(() => 0);
    if (typeof waitUntil === 'function') { try { waitUntil(task); } catch { /* No background work: the purge is simply skipped. */ } return; }
    let timer; await Promise.race([task, new Promise(done => { timer = setTimeout(done, PURGE_WAIT); })]); clearTimeout(timer);
  }
  async function redeem(request, input) {
    const match = /^([a-f0-9]{32})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(text(input.invite, 140, true));
    if (!match) throw fail(401, 'Invalid or expired business invitation. Ask for a new link.');
    const account = await readAccount(match[1]);
    const member = account?.members?.find(m => m.id === match[2] && m.status === 'invited');
    if (!account || account.status !== 'active' || !member || member.inviteExpiresAt <= now() || member.inviteHash !== await digest(match[3])) throw fail(401, 'Invalid or expired business invitation. Ask for a new link.');
    // Redeeming is the only way to get a session, so each member generation has at most one; the member records when it ends.
    member.status = 'active'; member.sessionExpiresAt = now() + SESSION; delete member.inviteHash; delete member.inviteExpiresAt;
    const raw = randomToken();
    await save({ account, member }, 'invitation_redeemed', [{ collection: 'business_sessions', id: await digest(raw), data: { accountId: account.id, memberId: member.id, memberVersion: member.version, expiresAt: member.sessionExpiresAt } }],
      { memberId: member.id, role: member.role, generation: member.version });
    // A new sign-in in the same browser ends the one it replaces (best effort), and the earlier company's project cookie goes too.
    await endSession(readCookie(request), { via: 'new_sign_in', liveOnly: true }).catch(() => false);
    await purgeSessions();
    const res = response(200, { ok: true }, { 'Set-Cookie': cookie(raw) }); res.headers.append('Set-Cookie', clearProjectCookie()); return res;
  }
  // Best effort after the session is ended: record that this member's sign-in is over so an administrator can renew it.
  async function signedOut(session, via) {
    const account = await readAccount(session.accountId);
    const member = account?.members?.find(m => m.id === session.memberId && m.status === 'active' && m.version === session.memberVersion && m.sessionExpiresAt > now());
    if (!member) return;
    member.sessionExpiresAt = now();
    await save({ account, member }, 'signed_out', [], { memberId: member.id, generation: member.version, via });
  }
  // Ends the session behind a raw cookie value: the record expires at once and its member's sign-in is marked over.
  // Returns whether a record was found. liveOnly skips records that already expired.
  async function endSession(raw, { via, liveOnly = false } = {}) {
    if (!/^[a-f0-9]{64}$/.test(raw)) return false;
    const id = await digest(raw), saved = await store.read('business_sessions', id);
    if (!saved || (liveOnly && !(saved.expiresAt > now()))) return false;
    await store.commit([{ collection: 'business_sessions', id, data: { ...saved, expiresAt: 0 }, version: saved._version }]);
    if (saved.expiresAt > now()) await signedOut(saved, via).catch(() => {});
    return true;
  }
  // Restricted members see (and decorators and exports receive) only their properties' requests, projects and jobs.
  async function snapshot(ctx) {
    const scoped = scopedContext(ctx), links = scoped.account.projects.filter(p => p.active !== false);
    const jobs = await store.jobs(links.map(p => p.jobId));
    const projects = links.map(link => { const job = jobs.get(link.jobId); return projectView(scoped.account, link, job, job ? finance(job) : {}, job ? needsReview(job) : false); });
    let view = scopedAccountView(ctx.account, ctx.member, projects, { ...ctx, now: now() });
    if (ctx.staff) view.inviteDelivery = { email: emailInvites };
    for (const fn of decorate) view = (await fn(view, scoped, jobs)) ?? view;
    return view;
  }
  const canSee = (ctx, propertyId) => ctx.staff || canSeeProperty(ctx.member, propertyId), scoped = ctx => scopedContext(ctx).account;
  const helpers = Object.freeze({ save, requirePermission, requireManager, property, canSeeProperty: canSee, scoped, response, now, store: hubStore, finance, needsReview, snapshot });
  const operationId = value => { if (value != null && !isId(value)) throw fail(400, 'Reload the form and try again.'); return value ?? null; };
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const ctx = await context(request, url);
        if (url.searchParams.has('export')) {
          const kind = url.searchParams.get('export');
          if (!Object.hasOwn(exporters, kind)) throw fail(400, 'Unknown business hub export.');
          if (!ctx.account) throw fail(400, 'Choose a business account first.');
          const result = await exporters[kind](scopedContext(ctx), url, helpers);
          if (!(result instanceof Response)) throw fail(503, 'The export could not be prepared. Please retry.');
          return noStore(result);
        }
        if (ctx.staff && !ctx.account) {
          const result = await store.list(ctx.profile, text(url.searchParams.get('cursor'), 2500));
          return response(200, { staff: true, manager: ctx.manager, inviteDelivery: { email: emailInvites }, accounts: result.accounts.filter(a => staffCanAccess(ctx.profile, a)).map(a => ({ id: a.id, company: a.company, status: a.status, properties: (a.properties || []).length, requests: (a.requests || []).filter(r => r.status === 'submitted').length, updatedAt: a.updatedAt })), next: result.next, limited: Boolean(result.limited) });
        }
        return response(200, await snapshot(ctx));
      }
      if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      const input = await body(request), action = text(input.action, 50, true);
      if (action === 'redeem') return await redeem(request, input);
      if (action === 'logout') {
        if (await endSession(readCookie(request), { via: 'sign_out' })) await purgeSessions();
        const res = response(200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); res.headers.append('Set-Cookie', clearProjectCookie()); return res;
      }
      const ctx = await context(request, url);
      if (action === 'create_account') {
        if (!ctx.staff) throw fail(403, 'EGC must onboard this business account.');
        const at = new Date(now()).toISOString();
        ctx.account = storedAccount({ id: uid(), company: text(input.company, 150, true), billingEmail: email(input.billingEmail || input.email), reference: '', status: 'active', ownerStaff: ctx.profile.user,
          acquisition: { channel: 'b2b', originatedBy: ctx.profile.user, createdAt: at }, properties: [], requests: [], projects: [], members: [], messages: [], createdAt: at, updatedAt: at });
        ctx.member = { id: `staff:${ctx.profile.user}`, name: ctx.profile.displayName || ctx.profile.user, role: 'staff' };
        // A retried onboarding (same requestId) returns the first account instead of creating a duplicate; invitation tokens are never replayed.
        const operation = operationId(input.requestId), requested = deliveryMode(ctx, input);
        let receiptData = null;
        if (operation) {
          const found = await receipt(ctx, operation, 'create_account', [ctx.account.company, ctx.account.billingEmail, text(input.name, 100, true), email(input.email), ...(requested === 'email' ? ['email'] : [])]);
          if (found.saved) return response(200, found.saved.deliver === 'email' ? await replayed(found.saved) : { ok: true, duplicate: true, accountId: found.saved.accountId });
          receiptData = found.data;
        }
        const result = await invite(ctx, { name: input.name, email: input.email, role: 'admin', deliver: input.deliver }, { operation, receiptData });
        return response(201, { ...result, accountId: ctx.account.id });
      }
      if (!ctx.account) throw fail(400, 'Choose a business account first.');
      if (ctx.account.status !== 'active') throw fail(403, 'This business account is inactive.');
      if (action === 'invite_member') { const result = await invite(ctx, input, { operation: operationId(input.requestId) }); return response(result.duplicate ? 200 : 201, result); }
      if (action === 'resend_invite' || action === 'reset_sign_in') {
        requirePermission(ctx, 'team');
        const operation = operationId(input.requestId); if (!operation) throw fail(400, 'Reload the page and try again.');
        const target = isId(input.memberId) ? ctx.account.members.find(m => m.id === input.memberId) : null; if (!target) throw fail(404, 'Member not found.');
        const requested = deliveryMode(ctx, input), found = await receipt(ctx, operation, action, [ctx.account.id, target.id, requested, input.confirm === true]);
        if (found.saved) return response(200, await replayed(found.saved, ctx.account));
        if (!ctx.staff && target.id === ctx.member.id) throw fail(409, 'You cannot renew your own sign-in. Ask another administrator or EGC.');
        const state = inviteState(target, now());
        if (action === 'resend_invite' && !['pending', 'expired', 'sign_in_ended'].includes(state)) throw fail(409, state === 'active' ? 'This person is still signed in. Use Reset sign-in if they need a new link now.' : 'This access was revoked. Invite the person again from the invite form if they should have access.');
        if (action === 'reset_sign_in' && state !== 'active') throw fail(409, 'This person is not signed in. Resend their invitation instead.');
        if (action === 'reset_sign_in' && input.confirm !== true) throw fail(400, 'Confirm that this ends the person’s current sign-in.');
        keepAdmin(ctx, target);
        return response(201, { ok: true, ...await issue(ctx, target, action === 'reset_sign_in' ? 'sign_in_reset' : 'invite_resent', { requested, operation, receiptData: found.data }) });
      }
      if (action === 'revoke_member') {
        requirePermission(ctx, 'team');
        const requestId = operationId(input.requestId), target = ctx.account.members.find(m => m.id === input.memberId); if (!target) throw fail(404, 'Member not found.');
        // A replay never revokes a member who was renewed after the original revocation.
        const replay = await operationReceipt(store, ctx, action, requestId, { memberId: target.id }, new Date(now()).toISOString());
        if (replay.duplicate) return response(200, { ok: true, duplicate: true });
        // Revoking twice (a retry or a second click) changes nothing, so the first revokedAt/revokedBy stands.
        if (target.status === 'revoked') return response(200, { ok: true, unchanged: true });
        if (!ctx.staff && target.role === 'admin' && !ctx.account.members.some(m => m.id !== target.id && m.status === 'active' && m.role === 'admin')) throw fail(409, 'Keep at least one active account administrator.');
        const before = memberSummary(target), previousStatus = target.status, at = new Date(now()).toISOString();
        target.status = 'revoked'; target.version += 1; target.revokedAt = at; target.revokedBy = ctx.member.id; delete target.inviteHash; delete target.inviteExpiresAt; delete target.sessionExpiresAt;
        remember(target, { event: 'revoked', at, by: ctx.member.id, role: target.role, generation: target.version, previousStatus });
        await save(ctx, action, replay.writes, { memberId: target.id, role: target.role, generation: target.version, previousStatus, hub: 'business.member_revoked', requestId, before, after: memberSummary(target) }); return response(200, { ok: true });
      }
      if (action === 'save_account') {
        requirePermission(ctx, 'team');
        ctx.account.billingEmail = email(input.billingEmail); ctx.account.reference = text(input.reference, 150);
        await save(ctx, action); return response(200, { ok: true });
      }
      if (action === 'save_property') {
        requirePermission(ctx, 'request');
        let item = input.propertyId ? property(ctx, input.propertyId) : null;
        // A new property is outside every restricted member's list, so only all-property access can create one.
        if (!item && !ctx.staff && memberPropertyIds(ctx.member)) throw fail(403, 'Only people with access to every property can add a property. Ask your account administrator.');
        const fields = { name: text(input.name, 100, true), address: text(input.address, 300, true), contact: text(input.contact, 150), access: text(input.access, 800) };
        // A new property saved with a requestId uses it as the property id, so a retry cannot add a second copy.
        const operation = item ? null : operationId(input.requestId), existing = operation && ctx.account.properties.find(p => p.id === operation);
        if (existing) { if (Object.keys(fields).some(k => existing[k] !== fields[k])) throw fail(409, 'Property reference already exists.'); return response(200, { ok: true, propertyId: existing.id, duplicate: true }); }
        const before = propertySummary(item), requestId = operation || (item && isId(input.requestId) ? input.requestId : null);
        if (!item) { bounded(ctx.account, 'properties'); item = { id: operation || uid() }; ctx.account.properties.push(item); }
        Object.assign(item, { ...fields, updatedAt: new Date(now()).toISOString() });
        await save(ctx, action, [], { requestId, before, after: propertySummary(item) }); return response(200, { ok: true, propertyId: item.id });
      }
      if (action === 'request_service') {
        requirePermission(ctx, 'request'); property(ctx, input.propertyId);
        if (!isId(input.requestId)) throw fail(400, 'Reload the form and try again.');
        const existing = ctx.account.requests.find(r => r.id === input.requestId);
        if (existing) { if (existing.createdBy !== ctx.member.id || existing.propertyId !== input.propertyId || existing.service !== text(input.service, 120, true) || existing.scope !== text(input.scope, 1600, true) || existing.payer !== text(input.payer, 160, true) || existing.preferredDate !== date(input.preferredDate) || existing.purchaseOrder !== text(input.purchaseOrder, 100) || existing.onsiteContact !== text(input.onsiteContact, 160)) throw fail(409, 'Request reference already exists.'); return response(200, { ok: true, requestId: existing.id, duplicate: true }); }
        bounded(ctx.account, 'requests');
        ctx.account.requests.push({ id: input.requestId, propertyId: input.propertyId, service: text(input.service, 120, true), scope: text(input.scope, 1600, true), preferredDate: date(input.preferredDate), purchaseOrder: text(input.purchaseOrder, 100), onsiteContact: text(input.onsiteContact, 160), payer: text(input.payer, 160, true), status: 'submitted', referralAccountId: ctx.account.id, createdBy: ctx.member.id, createdByName: ctx.member.name, createdAt: new Date(now()).toISOString() });
        await save(ctx, action); return response(201, { ok: true, requestId: input.requestId });
      }
      if (action === 'update_request') {
        if (!ctx.staff) throw fail(403, 'EGC updates request progress after review.');
        const item = ctx.account.requests.find(r => r.id === input.requestId); if (!item) throw fail(404, 'Request not found.');
        if (!['reviewing', 'awaiting_customer', 'closed'].includes(input.status)) throw fail(400, 'Select a valid request status.');
        item.status = input.status; item.updatedAt = new Date(now()).toISOString();
        await save(ctx, action); return response(200, { ok: true });
      }
      if (action === 'message') {
        if (!ctx.staff && !['admin', 'manager', 'billing'].includes(ctx.member.role)) throw fail(403, 'This account role is read-only.');
        if (!isId(input.messageId)) throw fail(400, 'Reload the message form and try again.');
        const topic = input.requestId && ctx.account.requests.find(r => r.id === input.requestId);
        if (topic && !ctx.staff && !canSeeProperty(ctx.member, topic.propertyId)) throw fail(403, PROPERTY_DENIED);
        const duplicate = ctx.account.messages.find(m => m.id === input.messageId);
        if (duplicate) { if (duplicate.authorId !== ctx.member.id || duplicate.body !== text(input.body, 1600, true) || duplicate.requestId !== text(input.requestId, 40)) throw fail(409, 'Message reference already exists.'); return response(200, { ok: true, duplicate: true }); }
        bounded(ctx.account, 'messages');
        if (input.requestId && !ctx.account.requests.some(r => r.id === input.requestId)) throw fail(400, 'Choose a request from this account.');
        ctx.account.messages.push({ id: input.messageId, requestId: text(input.requestId, 40), body: text(input.body, 1600, true), authorId: ctx.member.id, author: ctx.member.name, fromStaff: ctx.staff, at: new Date(now()).toISOString() });
        await save(ctx, action); return response(201, { ok: true });
      }
      if (action === 'link_project') {
        requireManager(ctx); property(ctx, input.propertyId);
        if (input.sharingAuthorized !== true) throw fail(400, 'Confirm that this company is authorized to access the selected project and its billing.');
        const jobId = requireJobId(input.jobId), job = await store.read('jobs', jobId);
        if (!job || ['blocked', 'availability'].includes(job.type) || (job.businessAccountId && job.businessAccountId !== ctx.account.id)) throw fail(409, 'This project is unavailable or belongs to another business account.');
        if (input.requestId && !ctx.account.requests.some(r => r.id === input.requestId && r.propertyId === input.propertyId)) throw fail(400, 'The selected request belongs to a different property.');
        let link = ctx.account.projects.find(p => p.jobId === jobId);
        if (!link) { bounded(ctx.account, 'projects'); link = { jobId }; ctx.account.projects.push(link); }
        Object.assign(link, { propertyId: input.propertyId, active: true, sharedBy: ctx.profile.user, sharedAt: new Date(now()).toISOString() });
        if (input.requestId) { const item = ctx.account.requests.find(r => r.id === input.requestId); item.jobId = jobId; item.status = 'project_linked'; }
        // FUN-29: work linked to a business account is commercial B2B on the B2B path, unless a staff pick or better evidence says otherwise.
        const project = funnelHubId(job.projectId) ? await store.read('projects', job.projectId) : null;
        const dimensions = project ? projectDimensionPatch(project, resolveDimensions(visitDimensionFacts({ ...job, businessAccountId: ctx.account.id })), { actor: ctx.profile.user, now: link.sharedAt }) : null;
        await save(ctx, action, [{ collection: 'jobs', id: jobId, version: job._version, patch: true, data: { businessAccountId: ctx.account.id, businessPropertyId: input.propertyId, businessSharingApprovedBy: ctx.profile.user, businessSharingApprovedAt: link.sharedAt } },
          ...(dimensions ? [{ collection: 'projects', id: project.id, version: project._version, patch: true, data: { ...dimensions, updatedAt: link.sharedAt } }] : [])]);
        return response(200, { ok: true });
      }
      if (action === 'unlink_project') {
        requireManager(ctx);
        const jobId = requireJobId(input.jobId), job = await store.read('jobs', jobId);
        const link = ctx.account.projects.find(p => p.jobId === jobId && p.active !== false); if (!link) throw fail(404, 'Project not linked.');
        link.active = false;
        const extra = job?.businessAccountId === ctx.account.id ? [{ collection: 'jobs', id: jobId, version: job._version, patch: true, data: { businessAccountId: '', businessPropertyId: '' } }] : [];
        await save(ctx, action, extra); return response(200, { ok: true });
      }
      if (action === 'open_project') {
        if (ctx.staff) throw fail(403, 'Use the Employee Hub for staff project access.');
        const jobId = requireJobId(input.jobId), job = await store.read('jobs', jobId); requireScopedLinkedJob(ctx.account, ctx.member, jobId, job);
        const e = job.estimate || {}, quoteStatus = String(job.customerApproval?.status || e.status || job.quoteStatus || '');
        if (!e.sentAt && !['sent', 'approved', 'accepted'].includes(quoteStatus)) throw fail(409, 'EGC has not released this project quote yet. Contact the account team.');
        const p = rights(ctx.member), actorId = businessActor(ctx.account.id, ctx.member);
        return response(200, { url: '/customer-portal' }, { 'Set-Cookie': await projectCookie(jobId, { actorId, permissions: { view: true, decide: p.decide === true, pay: p.pay === true, rebook: p.request === true } }) });
      }
      if (Object.hasOwn(actions, action)) {
        const result = await actions[action](ctx, input, helpers);
        return noStore(result instanceof Response ? result : response(result?.status || 200, result?.data ?? { ok: true }, result?.headers));
      }
      throw fail(400, 'Unknown business hub action.');
    } catch (error) { return response(error.status || 503, { error: error.publicMessage || 'The business hub could not complete that action. Please retry or contact Zoe.' }); }
  };
}
