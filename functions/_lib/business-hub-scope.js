/* Per-property member access. A member without propertyIds (or with an empty list) sees every property, so existing
   members need no backfill; administrators always see every property. Scope is read from the saved member on every
   request, so narrowing applies to the next request (including delegated /customer-portal access) without a sign-out. */
import { LIMITS, fail, isId, digest, accountView, requireLinkedJob, businessActor, receiptExpiry } from './business-hub-core.js';
import { auditWrite } from './hub-audit.js';

export const PROPERTY_DENIED = 'Your property access does not include this property. Ask your account administrator.';
const PROJECT_DENIED = 'This project is not shared with this business account.';
const CHOOSE = 'Select properties from this company account.';
const SCOPED = Symbol('business-hub-scoped-account');

// null means every property. A malformed saved value fails closed to no properties.
export function memberPropertyIds(member) {
  if (!member || member.role === 'admin' || member.propertyIds == null) return null;
  if (!Array.isArray(member.propertyIds)) return new Set();
  return member.propertyIds.length ? new Set(member.propertyIds.filter(isId)) : null;
}
export function canSeeProperty(member, propertyId) {
  const ids = memberPropertyIds(member);
  return !ids || ids.has(propertyId);
}
const unlinked = ({ jobId, ...request }) => request;
// A read-only view: requests, linked projects and request-linked messages of other properties are removed. General
// account messages stay visible. A request keeps its jobId only while that project is an active link of a visible
// property, so a project re-linked to another property is not named here. The copy is marked, and it is not the stored
// account save() accepts (business-hub-service.js isStoredAccount), so neither it nor any copy of it can overwrite the full account.
export function scopeAccount(account, member) {
  const ids = memberPropertyIds(member);
  if (!ids) return account;
  const projects = (account.projects || []).filter(p => ids.has(p.propertyId)), linked = new Set(projects.filter(p => p.active !== false).map(p => p.jobId));
  const requests = (account.requests || []).filter(r => ids.has(r.propertyId)).map(r => r.jobId && !linked.has(r.jobId) ? unlinked(r) : r), visible = new Set(requests.map(r => r.id));
  return Object.defineProperty({ ...account, properties: (account.properties || []).filter(p => ids.has(p.id)), requests, projects,
    messages: (account.messages || []).filter(m => !m.requestId || visible.has(m.requestId)) }, SCOPED, { value: true });
}
export const isScopedAccount = account => Boolean(account?.[SCOPED]);
export function requireScopedProperty(account, member, propertyId) {
  const item = typeof propertyId === 'string' ? (account.properties || []).find(p => p.id === propertyId) : null;
  if (!item) throw fail(400, 'Select a property from this company account.');
  if (!canSeeProperty(member, propertyId)) throw fail(403, PROPERTY_DENIED);
  return item;
}
// The member-aware requireLinkedJob: an out-of-scope project answers exactly like an unshared one.
export function requireScopedLinkedJob(account, member, jobId, job, options) {
  const link = (account.projects || []).find(p => p.jobId === jobId && p.active !== false);
  if (link && !canSeeProperty(member, link.propertyId)) throw fail(403, PROJECT_DENIED);
  return requireLinkedJob(account, jobId, job, options);
}
// Input: undefined keeps the saved scope, null or [] means every property, otherwise ids of this account's properties.
export function requestedPropertyIds(account, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > LIMITS.properties || value.some(id => !isId(id))) throw fail(400, CHOOSE);
  if (!value.length) return null;
  const wanted = new Set(value), known = (account.properties || []).map(p => p.id);
  if ([...wanted].some(id => !known.includes(id))) throw fail(400, CHOOSE);
  return known.filter(id => wanted.has(id));
}
// The fingerprint form of requestedPropertyIds(): keep the saved scope, every property, or the sorted ids.
export const scopeKey = ids => ids === undefined ? 'keep' : ids === null ? 'all' : [...ids].sort();
export function applyPropertyIds(member, ids) {
  if (member.role === 'admin' || ids === null) delete member.propertyIds;
  else if (ids) member.propertyIds = ids;
}
// Audit summaries: who, which role and generation, and which properties. Never invite hashes or session data.
export function memberSummary(member) {
  if (!member) return null;
  const ids = memberPropertyIds(member);
  return { id: member.id, name: member.name || '', email: member.email || '', role: member.role || '', status: member.status || '', version: member.version ?? null, properties: ids ? [...ids] : 'all' };
}
export const propertySummary = item => item ? { id: item.id, name: item.name || '', address: item.address || '' } : null;
const uuid = id => {
  const value = isId(id) ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : null;
};
// The SEC-B hub_audit row that joins the same business commit (via 'b2b').
export function businessHubAudit(ctx, { hub, requestId = null, before = null, after = null, at }) {
  const actor = ctx.staff ? { id: ctx.profile.user, kind: 'human', role: ctx.profile.role || null } : { id: businessActor(ctx.account.id, ctx.member), kind: 'business', role: ctx.member.role };
  return auditWrite({ actor, via: 'b2b', action: hub, entity: { collection: 'business_accounts', id: ctx.account.id }, before, after, requestId: uuid(requestId), now: at });
}
// accountView over the member's scoped account, plus property ids for team viewers and the viewer's own limit.
export function scopedAccountView(account, member, projects, options = {}) {
  const scoped = options.staff ? account : scopeAccount(account, member), view = accountView(scoped, member, projects, options);
  const known = new Set((account.properties || []).map(p => p.id)), limited = m => { const ids = memberPropertyIds(m); return ids && [...ids].filter(id => known.has(id)); };
  if (view.viewer.permissions.team) {
    const byId = new Map((account.members || []).map(m => [m.id, m]));
    for (const item of view.members) { const ids = item.id && limited(byId.get(item.id)); if (ids) item.propertyIds = ids; }
  }
  const own = !options.staff && limited(member);
  if (own) view.viewer.propertyIds = own;
  return view;
}

// requestId receipts in business_operations (the create_account pattern). The same actor repeating the same change on
// the same account gets {duplicate:true} and nothing is re-applied, even if someone changed the record since; any other
// use of the id is refused with 409. The receipt is create-only and joins the change's own commit, so two racing
// requests with one id cannot both apply. Without a requestId there is no receipt. The receipt expires RECEIPT_DAYS later
// (expireAt, the business_operations TTL policy), so receipts stay bounded.
export async function operationReceipt(store, ctx, action, requestId, fields, at) {
  if (requestId == null) return { duplicate: false, writes: [] };
  const actorId = ctx.member.id, accountId = ctx.account.id;
  const fingerprint = await digest(JSON.stringify(Object.entries({ ...fields, action, accountId, actorId }).sort(([a], [b]) => a < b ? -1 : 1)));
  const saved = await store.read('business_operations', requestId);
  if (saved) {
    if (saved.action !== action || saved.actorId !== actorId || saved.accountId !== accountId || saved.fingerprint !== fingerprint) throw fail(409, 'Request reference already exists.');
    return { duplicate: true, writes: [] };
  }
  return { duplicate: false, writes: [{ collection: 'business_operations', id: requestId, data: { action, actorId, fingerprint, accountId, at, expireAt: receiptExpiry(Date.parse(at)) } }] };
}

// set_member_properties: team permission (client administrators and EGC staff). The change is live on the member's
// next request, so no sign-out or version bump is needed. Repeating the current setting changes nothing and writes only
// the requestId receipt (expiring like every receipt), so that id cannot later apply a different change and its replay
// still answers {duplicate:true}; the current state alone cannot tell a replay from a new request.
async function setMemberProperties(ctx, input, { save, requirePermission, response, store, now }) {
  requirePermission(ctx, 'team');
  if (!isId(input.memberId)) throw fail(400, 'Select a member of this account.');
  if (input.requestId != null && !isId(input.requestId)) throw fail(400, 'Reload the form and try again.');
  if (input.propertyIds === undefined) throw fail(400, 'Choose which properties this person can access.');
  const ids = requestedPropertyIds(ctx.account, input.propertyIds), requestId = input.requestId ?? null;
  const target = (ctx.account.members || []).find(m => m.id === input.memberId);
  if (!target) throw fail(404, 'Member not found.');
  // Checked before the member's current state: a replay after a later change must not re-apply this one.
  const receipt = await operationReceipt(store, ctx, 'set_member_properties', requestId, { memberId: target.id, propertyIds: scopeKey(ids) }, new Date(now()).toISOString());
  if (receipt.duplicate) return response(200, { ok: true, duplicate: true });
  if (target.status === 'revoked') throw fail(409, 'Renew this person’s access before changing their properties.');
  if (target.role === 'admin' && ids) throw fail(409, 'Account administrators always have access to every property.');
  const before = memberSummary(target), current = memberPropertyIds(target);
  if (!current && !ids || current && ids && current.size === ids.length && ids.every(id => current.has(id))) {
    if (receipt.writes.length) await store.commit(receipt.writes);
    return response(200, { ok: true, unchanged: true });
  }
  applyPropertyIds(target, ids);
  await save(ctx, 'member_properties_changed', receipt.writes, { hub: 'business.member_properties', requestId, before, after: memberSummary(target) });
  return response(200, { ok: true, propertyIds: ids || [] });
}
export const actions = Object.freeze({ set_member_properties: setMemberProperties });
