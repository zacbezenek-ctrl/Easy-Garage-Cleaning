import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { businessActor } from '../functions/_lib/business-hub-core.js';
import { createCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { sendAcceptedQuotePortal } from '../functions/_lib/portal-invitation.js';
import { createCustomerPortalHandlers } from '../functions/api/customer-portal.js';
import { customerPortalLinkHandler } from '../functions/api/customer-portal-link.js';
import { UNVERSIONED_PAGE_TERMS_VERSION } from '../functions/_lib/customer-portal-content.js';
import { applyFirestoreCommit } from './helpers/firestore-commit.mjs';

// B2B-SAFE: company projects shared through the business hub never receive a
// homeowner owner-level portal link, and company approvals name the member.
const NOW = '2026-09-22T12:00:00.000Z', origin = 'https://easygaragecleaning.com';
const env = {
  CUSTOMER_PORTAL_SECRET: 'synthetic-b2b-safe-portal-secret', HUB_SESSION_SECRET: 'synthetic-b2b-safe-hub-secret', FIREBASE_API_KEY: 'firebase-test-b2b-safe',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', role: 'owner' } }),
};
const withHighLevel = { ...env, HIGHLEVEL_API_KEY: 'synthetic-highlevel-key', HIGHLEVEL_LOCATION_ID: 'location-1' };
const ACCOUNT = 'a1'.repeat(16), PROPERTY = 'b2'.repeat(16);
const member = (id, role, name) => ({ id, role, name, version: 2, status: 'active', email: `${role}@example.invalid` });
const ADMIN = member('c3'.repeat(16), 'admin', 'Synthetic AP Admin'), BILLING = member('d4'.repeat(16), 'billing', 'Synthetic Billing Clerk');
const account = { company: 'Synthetic Property Co', status: 'active', members: [ADMIN, BILLING], projects: [{ jobId: 'job-1', propertyId: PROPERTY, active: true }] };
const LINK = { businessAccountId: ACCOUNT, businessPropertyId: PROPERTY }, UNLINKED = { businessAccountId: '', businessPropertyId: '' };
const person = { id: 'person-1', name: 'Synthetic Family', email: 'family@example.invalid', status: 'active', permissions: { view: true, decide: true, pay: false, rebook: false } };
const job = (extra = {}) => ({
  type: 'job', customer: 'Synthetic Tenant', customerId: 'customer-1', phone: '(970) 555-0142', email: 'tenant@example.invalid', highlevelContactId: 'contact-1',
  address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled', customerCollaborators: [person],
  estimate: { number: 'EST-1', status: 'sent', amount: 800, sentAt: '2026-09-20T12:00:00.000Z', revision: 1 }, ...extra,
});
const ACTOR_FIELDS = ['approvedByActorId', 'approvedByBusinessAccountId', 'approvedByBusinessMemberId'];
const approve = { action: 'approve_estimate', signed_name: 'Synthetic Signer', confirmed: true };

// Firestore REST emulation for any collection (versioned updateTime, updateMask
// patches, 412 on a stale precondition) plus HighLevel call capture.
function firestore(t, jobs, accounts = { [ACCOUNT]: account }) {
  const documents = new Map(), writes = [], highLevel = [], events = [];
  let counter = 0;
  const put = (path, data) => documents.set(path, { data: structuredClone(data), updateTime: `2026-09-22T00:00:00.${String(++counter).padStart(6, '0')}Z` });
  for (const [id, data] of Object.entries(jobs)) put(`jobs/${id}`, data);
  for (const [id, data] of Object.entries(accounts)) put(`business_accounts/${id}`, data);
  const body = path => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(documents.get(path).data), updateTime: documents.get(path).updateTime });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'services.leadconnectorhq.com') { highLevel.push(url.pathname); return Response.json({}, { status: 500 }); }
    assert.equal(url.hostname, 'firestore.googleapis.com', `Unexpected external request to ${url.hostname}`);
    // FUN-03: portal writers commit the job change with its funnel events.
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(options.body);
      const result = applyFirestoreCommit(commit, { read: path => documents.has(path) ? structuredClone(documents.get(path)) : null, write: (path, data, { mask }) => {
        assert.equal(path.startsWith('business_accounts/'), false, 'the portal never writes business accounts');
        put(path, data); if (path.startsWith('jobs/')) writes.push({ path, fields: mask }); else events.push(structuredClone(data));
      } });
      return result.stale ? Response.json({}, { status: 412 }) : Response.json({ commitTime: NOW });
    }
    const path = decodeURIComponent(url.pathname.split('/documents/')[1] || '');
    if (method === 'GET') return documents.has(path) ? Response.json(body(path)) : Response.json({}, { status: 404 });
    assert.equal(method, 'PATCH');
    assert.equal(path.startsWith('business_accounts/'), false, 'the portal never writes business accounts');
    const existing = documents.get(path), expected = url.searchParams.get('currentDocument.updateTime');
    if (expected ? existing?.updateTime !== expected : url.searchParams.get('currentDocument.exists') === 'false' && existing) return Response.json({}, { status: 412 });
    const patch = decodeFirestoreFields(JSON.parse(options.body).fields), mask = url.searchParams.getAll('updateMask.fieldPaths');
    put(path, mask.length ? { ...(existing?.data || {}), ...Object.fromEntries(mask.map(key => [key, patch[key]])) } : patch);
    writes.push({ path, fields: mask });
    return Response.json(body(path));
  });
  return { writes, highLevel, events, doc: path => structuredClone(documents.get(path)?.data), job: id => structuredClone(documents.get(`jobs/${id}`)?.data) };
}

const handlers = createCustomerPortalHandlers({ now: () => new Date(NOW) });
const cookie = async (claims = { linkVersion: 0 }) => `egc_customer_portal=${await createCustomerPortalSessionToken(env, 'job-1', Date.parse(NOW), claims)}`;
const company = (who = ADMIN) => cookie({ actorId: businessActor(ACCOUNT, who), permissions: { view: true, decide: true, pay: true, rebook: true } });
const call = async (viewer, payload) => {
  // P2-05: a portal approval names the revision, amount and fingerprint of the
  // estimate the page displayed, so read it as the same viewer first.
  if (payload?.action === 'approve_estimate' && payload.estimate_fingerprint === undefined) {
    const shown = (await call(viewer)).body.estimate;
    if (shown) payload = { ...payload, estimate_revision: shown.revision, amount_cents: Math.round(Number(shown.amount) * 100), estimate_fingerprint: shown.fingerprint };
  }
  const request = new Request(`${origin}/api/customer-portal`, { method: payload ? 'POST' : 'GET', headers: { Origin: origin, Cookie: viewer, 'Content-Type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const response = await (payload ? handlers.onRequestPost : handlers.onRequestGet)({ env, request });
  return { status: response.status, body: await response.json() };
};
// P4-09: approvals record the terms version the page showed; these requests send none, so the unversioned marker is stored.
const publicApproval = { status: 'approved', approvedAt: NOW, approvedBy: 'Synthetic Signer', amount: 800, source: 'customer_portal', termsVersion: UNVERSIONED_PAGE_TERMS_VERSION };
// FUN-03: the saved approval also names the request that saved it (a server id when the page sends none) and the revision it binds.
const savedApproval = saved => {
  const { requestId, estimateRevision, ...approval } = saved.customerApproval;
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.equal(estimateRevision, 1);
  return approval;
};

test('a company member approval is attributed to that member for accounts payable', async t => {
  const earlier = { approvedByActorId: businessActor(ACCOUNT, BILLING), approvedByBusinessAccountId: ACCOUNT, approvedByBusinessMemberId: BILLING.id };
  const f = firestore(t, { 'job-1': job({ ...LINK, estimate: { ...job().estimate, ...earlier } }) });
  const actor = businessActor(ACCOUNT, ADMIN), attribution = { approvedByActorId: actor, approvedByBusinessAccountId: ACCOUNT, approvedByBusinessMemberId: ADMIN.id };
  const result = await call(await company(), approve);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.approval, publicApproval, 'the response never returns member ids');
  const saved = f.job('job-1');
  assert.deepEqual(savedApproval(saved), { ...publicApproval, ...attribution });
  assert.deepEqual(saved.estimate, { number: 'EST-1', status: 'approved', amount: 800, sentAt: '2026-09-20T12:00:00.000Z', revision: 1, acceptedAt: NOW, acceptedBy: 'Synthetic Signer', depositRequired: 400, acceptedTermsVersion: UNVERSIONED_PAGE_TERMS_VERSION, ...attribution }, 'the current signer replaces an earlier approver');
  assert.equal(saved.quoteStatus, 'approved');
  // FUN-03: the sale is recorded in the same commit and names the company member, not a person's name.
  assert.deepEqual(f.events.map(event => [event.type, event.actor, event.businessAccountId, event.data.amountCents, event.idempotencyKey]), [['deal.sold', { id: actor, kind: 'customer', role: 'business' }, ACCOUNT, 80000, `portalRequest:${saved.customerApproval.requestId}`]]);
  const view = await call(await company());
  assert.equal(view.status, 200);
  assert.deepEqual([view.body.estimate.status, view.body.estimate.approvedBy], ['approved', 'Synthetic Signer']);
  for (const key of ACTOR_FIELDS) assert.equal(key in view.body.estimate, false, `${key} stays out of the portal DTO`);
  assert.deepEqual(f.highLevel, []);
});

test('a company member without approval rights cannot approve and nothing is saved', async t => {
  const f = firestore(t, { 'job-1': job(LINK) });
  const result = await call(await company(BILLING), approve);
  assert.equal(result.status, 403);
  assert.deepEqual(f.writes, []);
  assert.equal(f.job('job-1').customerApproval, undefined);
});

test('homeowner and family approvals keep their existing shape', async t => {
  for (const [name, viewer] of [['homeowner', () => cookie()], ['family', () => cookie({ actorId: 'person-1', permissions: person.permissions })]]) await t.test(name, async st => {
    const f = firestore(st, { 'job-1': job() });
    const result = await call(await viewer(), approve);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.approval, publicApproval);
    const saved = f.job('job-1');
    assert.deepEqual(savedApproval(saved), publicApproval, 'no actor fields are added');
    assert.deepEqual(Object.keys(saved.estimate).sort(), ['acceptedAt', 'acceptedBy', 'acceptedTermsVersion', 'amount', 'depositRequired', 'number', 'revision', 'sentAt', 'status']);
  });
});

test('a homeowner re-approval never credits an earlier company approver', async t => {
  const stale = { approvedByActorId: businessActor(ACCOUNT, ADMIN), approvedByBusinessAccountId: ACCOUNT, approvedByBusinessMemberId: ADMIN.id };
  const f = firestore(t, { 'job-1': job({ ...UNLINKED, estimate: { ...job().estimate, ...stale } }) });
  assert.equal((await call(await cookie(), approve)).status, 200);
  const saved = f.job('job-1');
  for (const key of ACTOR_FIELDS) assert.equal(key in saved.estimate, false, key);
  assert.deepEqual(savedApproval(saved), publicApproval);
  assert.deepEqual([saved.estimate.number, saved.estimate.sentAt, saved.estimate.acceptedBy], ['EST-1', '2026-09-20T12:00:00.000Z', 'Synthetic Signer'], 'other estimate fields carry forward');
});

test('an approved company project records a suppression and never calls HighLevel', async t => {
  const f = firestore(t, { 'job-1': job(LINK) });
  assert.equal((await call(await company(), approve)).status, 200);
  const state = await sendAcceptedQuotePortal(withHighLevel, 'job-1', { now: () => new Date(NOW) });
  assert.deepEqual(state, { jobId: 'job-1', requestedAt: NOW, attemptedAt: NOW, attempts: 1, status: 'suppressed', reason: 'business_account_job' });
  assert.deepEqual(f.doc('portal_invitations/job-1'), state, 'the server-only ledger holds the suppression');
  assert.deepEqual(f.job('job-1').customerPortalInvitation, state);
  assert.deepEqual(f.highLevel, [], 'no contact lookup, upsert or message');
});

test('a homeowner link on a company project cannot mint collaborator invitations', async t => {
  const f = firestore(t, { 'job-1': job(LINK) });
  const refused = await call(await cookie(), { action: 'create_collaborator_invite', person_id: 'person-1' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'CUSTOMER_PORTAL_BUSINESS_PROJECT');
  assert.equal(refused.body.url, undefined);
  assert.equal((await call(await company(), { action: 'create_collaborator_invite', person_id: 'person-1' })).status, 403, 'company members are never owners');
  assert.deepEqual(f.writes, []);
});

test('a homeowner project still issues collaborator invitations', async t => {
  firestore(t, { 'job-1': job(UNLINKED) });
  const invite = await call(await cookie(), { action: 'create_collaborator_invite', person_id: 'person-1' });
  assert.equal(invite.status, 200);
  assert.match(invite.body.url, /^https:\/\/easygaragecleaning\.com\/api\/customer-portal-session\?access=/);
});

test('staff cannot copy a homeowner owner link for a company project', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const f = firestore(t, { 'job-1': job(LINK), 'job-2': job(UNLINKED) });
  const staff = (await createHubSessionCookie(env, 'ZacB')).split(';')[0], link = customerPortalLinkHandler({ now: () => new Date(NOW) });
  const request = jobId => new Request(`${origin}/api/customer-portal-link`, { method: 'POST', headers: { Origin: origin, Cookie: staff, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: jobId }) });
  const refused = await link({ env, request: request('job-1') });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.url, undefined);
  assert.match(body.error, /Business Hub/);
  assert.deepEqual(f.writes, [], 'the job is not marked as having a portal link');
  const homeowner = await link({ env, request: request('job-2') });
  assert.equal(homeowner.status, 200);
  assert.match((await homeowner.json()).url, /access=/);
});

test('the portal offers collaborator invitations only on an owner session for a homeowner project', async t => {
  for (const [name, links, viewer, expected] of [
    ['homeowner project owner', UNLINKED, () => cookie(), true],
    ['company project homeowner link', LINK, () => cookie(), false],
    ['company member', LINK, () => company(), false],
    ['family collaborator', UNLINKED, () => cookie({ actorId: 'person-1', permissions: person.permissions }), false],
  ]) await t.test(name, async st => {
    firestore(st, { 'job-1': job(links) });
    const view = await call(await viewer());
    assert.equal(view.status, 200);
    assert.equal(view.body.experience.invitesAvailable, expected);
  });
});

const portalHtml = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
const sourceLine = (source, prefix) => { const found = source.split(/\r?\n/).find(item => item.startsWith(prefix)); assert.ok(found, `${prefix} is missing`); return found; };
function fakeNode(tag = 'div') {
  const node = { tag, children: [], dataset: {}, className: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} } };
  node.append = (...items) => { node.children.push(...items); };
  node.replaceChildren = (...items) => { node.children = items; };
  node.closest = () => node; node.querySelector = () => null;
  return node;
}
const texts = node => [node.textContent, ...node.children.flatMap(texts)].filter(Boolean);

test('a company project hides the copy-invite control and says why', () => {
  const nodes = new Map(), context = { document: { createElement: fakeNode }, $: id => nodes.get(id) || nodes.set(id, fakeNode()).get(id), personEditor: item => ({ editor: item.id }), copyInvite: () => assert.fail('no invite is created while rendering') };
  vm.runInNewContext([sourceLine(portalHtml, 'const make='), sourceLine(portalHtml, 'function renderCollaborators(')].join('\n'), context);
  const people = [{ id: 'person-1', name: 'Synthetic Family', role: 'Family', status: 'active', permissions: { decide: true } }];
  context.renderCollaborators(people, true, true);
  assert.deepEqual(texts(context.$('collaborator-list')).filter(value => value === 'Copy invite'), ['Copy invite']);
  context.renderCollaborators(people, true, false);
  const list = texts(context.$('collaborator-list'));
  assert.equal(list.includes('Copy invite'), false);
  assert.ok(list.includes('Synthetic Family'), 'the people stay visible');
  assert.ok(list.some(value => /managed through a business account/.test(value)));
  context.renderCollaborators(people, false, false);
  assert.equal(texts(context.$('collaborator-list')).some(value => /Copy invite|business account/.test(value)), false, 'non-owners never see either');
});

test('the portal page follows the server invite flag and treats an older response as available', () => {
  const calls = [], context = { document: { createElement: fakeNode }, $: () => fakeNode(), setText() {} };
  for (const name of ['renderDecisions', 'renderMemory', 'renderRules', 'renderRebooking', 'renderWallet', 'renderGuard']) context[name] = () => {};
  context.renderCollaborators = (...args) => calls.push(args.slice(1));
  vm.runInNewContext([sourceLine(portalHtml, 'const make='), sourceLine(portalHtml, 'function renderExperience(')].join('\n'), context);
  const data = experience => ({ experience, payment: { balance: 0 }, viewer: { owner: true, permissions: {} } });
  context.renderExperience(data({ collaborators: [], invitesAvailable: false }));
  context.renderExperience(data({ collaborators: [], invitesAvailable: true }));
  context.renderExperience(data({ collaborators: [] }));
  context.renderExperience({ ...data({ collaborators: [], invitesAvailable: true }), viewer: { owner: false, permissions: {} } });
  assert.deepEqual(calls, [[true, false], [true, true], [true, true], [false, false]]);
});

// Older writers spread the previous approval or estimate forward. A later staff
// or walkthrough approval must never keep naming an earlier company approver.
const LATER = '2026-09-25T15:00:00.000Z';
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), walkthrough = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [Date.parse(LATER)])); } static now() { return Date.parse(LATER); } }
async function staffFinance(saved, action, input) {
  const captured = {};
  const context = vm.createContext({ window: {}, Date: FixedDate, jobs: () => [saved], financeDatePlus: () => '2026-10-09', money: String, askAction: async () => input, patchJob: async (id, update) => { captured.update = update; }, syncCustomerCommunication: async () => true, render: () => {}, employeeIdentity: () => 'ZacB' });
  vm.runInContext(suite.slice(suite.indexOf('window.opsFinanceAction='), suite.indexOf('function addCalendarMonths')), context);
  await context.window.opsFinanceAction(saved.id, action);
  return captured.update;
}
async function companyApproved(t) {
  const f = firestore(t, { 'job-1': job({ ...LINK, estimate: { ...job().estimate, scope: 'Synthetic garage reset' } }) });
  assert.equal((await call(await company(), approve)).status, 200);
  const saved = { id: 'job-1', ...f.job('job-1') };
  assert.equal(saved.estimate.approvedByBusinessMemberId, ADMIN.id, 'fixture: the company approval is attributed');
  return saved;
}
const unattributed = (record, label) => { for (const key of ACTOR_FIELDS) assert.equal(key in record, false, `${label}: ${key}`); };

test('a staff-recorded approval after a company approval names no company approver', async t => {
  const saved = await companyApproved(t), update = await staffFinance(saved, 'accept', { acceptedBy: 'Synthetic Tenant' });
  unattributed(update.estimate, 'estimate'); unattributed(update.customerApproval, 'customerApproval');
  assert.deepEqual([update.estimate.acceptedBy, update.estimate.acceptanceMethod, update.estimate.acceptedAt, update.customerApproval.source], ['Synthetic Tenant', 'employee_recorded', LATER, 'employee_recorded']);
  assert.deepEqual([update.estimate.number, update.estimate.sentAt, update.estimate.scope], ['EST-1', '2026-09-20T12:00:00.000Z', 'Synthetic garage reset'], 'other estimate fields carry forward');
});

test('a material estimate revision drops the company approver while an unchanged save keeps it', async t => {
  const saved = await companyApproved(t);
  const revised = await staffFinance(saved, 'estimate', { amount: '950', scope: 'Synthetic garage reset and shelving', deposit: '475', validUntil: '2026-10-09' });
  assert.deepEqual([revised.estimate.status, revised.customerApproval.status], ['draft', 'superseded']);
  unattributed(revised.estimate, 'revised estimate');
  assert.equal(revised.customerApproval.approvedByBusinessMemberId, ADMIN.id, 'the superseded record still shows who approved the earlier version');
  const unchanged = await staffFinance(saved, 'estimate', { amount: '800', scope: 'Synthetic garage reset', deposit: '400', validUntil: '2026-10-09' });
  assert.equal(unchanged.estimate.status, 'approved');
  assert.equal(unchanged.customerApproval, undefined);
  assert.deepEqual(ACTOR_FIELDS.map(key => unchanged.estimate[key]), ACTOR_FIELDS.map(key => saved.estimate[key]), 'an unchanged approved estimate keeps its signer');
});

test('a walkthrough signature after a company approval names no company approver', async t => {
  const saved = await companyApproved(t), context = vm.createContext({});
  vm.runInContext([sourceLine(walkthrough, 'function walkthroughDeposit('), sourceLine(walkthrough, 'function applyWalkthroughFinance(')].join('\n'), context);
  const signed = { total: 900, scope: { finish: ['cleanout'] }, acceptance: { acceptedAt: LATER, acceptedBy: 'Synthetic Tenant' }, updatedAt: LATER };
  context.applyWalkthroughFinance(signed, saved);
  unattributed(signed.customerApproval, 'customerApproval');
  assert.deepEqual([signed.customerApproval.status, signed.customerApproval.approvedBy, signed.customerApproval.source, signed.customerApproval.amount], ['approved', 'Synthetic Tenant', 'in_person_signature', 900]);
  assert.equal(saved.customerApproval.approvedByBusinessMemberId, ADMIN.id, 'the saved previous record is not mutated');
});

test('the Hub names the business suppression instead of a generic pause', () => {
  const context = {};
  vm.runInNewContext(['const esc=', 'function portalInvitationState(', 'function portalInvitationLabel(', 'function portalInvitationControl('].map(prefix => sourceLine(suite, prefix)).join('\n'), context);
  const hub = (status, reason) => ({ id: 'job-1', customerPortalInvitationRequestedAt: NOW, customerPortalInvitation: { jobId: 'job-1', status, reason } });
  assert.equal(context.portalInvitationLabel(hub('suppressed', 'business_account_job')), 'Business Hub project · no homeowner portal link');
  assert.equal(context.portalInvitationLabel(hub('suppressed', 'job_notifications_off')), 'Portal delivery paused');
  assert.equal(context.portalInvitationLabel({ id: 'job-1', customerPortalInvitation: { jobId: 'other-job', status: 'suppressed', reason: 'business_account_job' } }), 'Portal delivery pending', 'a copied marker from another job is ignored');
  assert.match(context.portalInvitationControl(hub('suppressed', 'business_account_job')), /Business Hub project · no homeowner portal link<\/span><button[^>]*>Recheck portal delivery</, 'staff can recheck after unlinking');
});
