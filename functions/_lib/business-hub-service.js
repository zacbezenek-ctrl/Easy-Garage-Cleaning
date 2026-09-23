import { LIMITS, ROLES, fail, uid, isId, text, email, date, digest, randomToken, rights, permitted, staffAllowed, staffCanAccess, activeMember, bounded, requireJobId, requireLinkedJob, businessActor, projectView, accountView } from './business-hub-core.js';
const COOKIE = '__Host-egc_business';
const HOURS = 3600000;
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
export function createBusinessHandler({ store, getStaff, finance, needsReview, projectCookie, clearProjectCookie, now = () => Date.now() }) {
  async function context(request, url) {
    if (url.searchParams.get('staff') === '1') {
      const profile = await getStaff(request);
      if (!staffAllowed(profile)) throw fail(403, 'Sign in with an authorized EGC business or sales account.');
      const accountId = url.searchParams.get('account');
      if (!accountId) return { staff: true, manager: profile.businessAccess === true, profile };
      if (!isId(accountId)) throw fail(400, 'Choose a valid account.');
      const account = await store.read('business_accounts', accountId);
      if (!account || !staffCanAccess(profile, account)) throw fail(403, 'This business account is not assigned to you.');
      return { staff: true, manager: profile.businessAccess === true, profile, account, member: { id: `staff:${profile.user}`, name: profile.displayName || profile.user, role: 'staff' } };
    }
    const raw = readCookie(request);
    if (!/^[a-f0-9]{64}$/.test(raw)) throw fail(401, 'Open your private business sign-in link or contact Zoe.');
    const session = await store.read('business_sessions', await digest(raw));
    if (!session || session.expiresAt <= now()) throw fail(401, 'Your session expired. Ask your account administrator for a new sign-in link.');
    const account = await store.read('business_accounts', session.accountId);
    const member = activeMember(account, session.memberId, session.memberVersion);
    return { staff: false, manager: false, account, member, session };
  }
  async function save(ctx, action, extra = []) {
    const account = ctx.account;
    account.updatedAt = new Date(now()).toISOString();
    if (new TextEncoder().encode(JSON.stringify(account)).length > 750000) throw fail(409, 'This workspace is at its storage limit. Contact EGC to archive older records; your existing records are unchanged.');
    await store.commit([
      { collection: 'business_accounts', id: account.id, data: account, version: account._version },
      { collection: 'business_audit', id: uid(), data: { accountId: account.id, actorId: ctx.member.id, action, at: account.updatedAt } }, ...extra,
    ]);
  }
  function requirePermission(ctx, p) { if (!ctx.staff) permitted(ctx.member, p); }
  function requireManager(ctx) { if (!ctx.staff || !ctx.manager) throw fail(403, 'An EGC business manager must authorize project sharing.'); }
  function property(ctx, id) { const item = ctx.account.properties.find(p => p.id === id); if (!item) throw fail(400, 'Select a property from this company account.'); return item; }
  async function invite(ctx, input) {
    requirePermission(ctx, 'team');
    const role = text(input.role, 20, true); if (!Object.hasOwn(ROLES, role)) throw fail(400, 'Select an available account role.');
    const address = email(input.email), name = text(input.name, 100, true);
    let member = ctx.account.members.find(m => m.email === address);
    if (member && !ctx.staff && member.id === ctx.member.id) throw fail(409, 'Ask another administrator to renew your own sign-in link.');
    if (member?.role === 'admin' && member.status === 'active' && !ctx.staff && !ctx.account.members.some(m => m.id !== member.id && m.role === 'admin' && m.status === 'active')) throw fail(409, 'Keep at least one active account administrator.');
    if (!member) { bounded(ctx.account, 'members'); member = { id: uid(), version: 0 }; ctx.account.members.push(member); }
    const token = randomToken();
    Object.assign(member, { name, email: address, role, version: member.version + 1, status: 'invited', inviteHash: await digest(token), inviteExpiresAt: now() + 48 * HOURS });
    await save(ctx, 'member_invited');
    return { invite: `${ctx.account.id}.${member.id}.${token}`, email: address, expiresInHours: 48 };
  }
  async function redeem(input) {
    const match = /^([a-f0-9]{32})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(text(input.invite, 140, true));
    if (!match) throw fail(401, 'Invalid or expired business invitation. Ask for a new link.');
    const account = await store.read('business_accounts', match[1]);
    const member = account?.members?.find(m => m.id === match[2] && m.status === 'invited');
    if (!account || account.status !== 'active' || !member || member.inviteExpiresAt <= now() || member.inviteHash !== await digest(match[3])) throw fail(401, 'Invalid or expired business invitation. Ask for a new link.');
    member.status = 'active'; delete member.inviteHash; delete member.inviteExpiresAt;
    const raw = randomToken();
    await save({ account, member }, 'invitation_redeemed', [{ collection: 'business_sessions', id: await digest(raw), data: { accountId: account.id, memberId: member.id, memberVersion: member.version, expiresAt: now() + 7 * 86400 * 1000 } }]);
    return response(200, { ok: true }, { 'Set-Cookie': cookie(raw) });
  }
  async function snapshot(ctx) {
    const links = ctx.account.projects.filter(p => p.active !== false);
    const jobs = await store.jobs(links.map(p => p.jobId));
    const projects = links.map(link => { const job = jobs.get(link.jobId); return projectView(ctx.account, link, job, job ? finance(job) : {}, job ? needsReview(job) : false); });
    return accountView(ctx.account, ctx.member, projects, ctx);
  }
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const ctx = await context(request, url);
        if (ctx.staff && !ctx.account) {
          const result = await store.list(ctx.profile, text(url.searchParams.get('cursor'), 2500));
          return response(200, { staff: true, manager: ctx.manager, accounts: result.accounts.filter(a => staffCanAccess(ctx.profile, a)).map(a => ({ id: a.id, company: a.company, status: a.status, properties: a.properties.length, requests: a.requests.filter(r => r.status === 'submitted').length, updatedAt: a.updatedAt })), next: result.next, limited: Boolean(result.limited) });
        }
        return response(200, await snapshot(ctx));
      }
      if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      const input = await body(request), action = text(input.action, 50, true);
      if (action === 'redeem') return await redeem(input);
      if (action === 'logout') {
        const raw = readCookie(request);
        if (/^[a-f0-9]{64}$/.test(raw)) { const id = await digest(raw), saved = await store.read('business_sessions', id); if (saved) await store.commit([{ collection: 'business_sessions', id, data: { ...saved, expiresAt: 0 }, version: saved._version }]); }
        const res = response(200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); res.headers.append('Set-Cookie', clearProjectCookie()); return res;
      }
      const ctx = await context(request, url);
      if (action === 'create_account') {
        if (!ctx.staff) throw fail(403, 'EGC must onboard this business account.');
        const at = new Date(now()).toISOString();
        ctx.account = { id: uid(), company: text(input.company, 150, true), billingEmail: email(input.billingEmail || input.email), reference: '', status: 'active', ownerStaff: ctx.profile.user,
          acquisition: { channel: 'b2b', originatedBy: ctx.profile.user, createdAt: at }, properties: [], requests: [], projects: [], members: [], messages: [], createdAt: at, updatedAt: at };
        ctx.member = { id: `staff:${ctx.profile.user}`, name: ctx.profile.displayName || ctx.profile.user, role: 'staff' };
        const result = await invite(ctx, { name: input.name, email: input.email, role: 'admin' });
        return response(201, { ...result, accountId: ctx.account.id });
      }
      if (!ctx.account) throw fail(400, 'Choose a business account first.');
      if (ctx.account.status !== 'active') throw fail(403, 'This business account is inactive.');
      if (action === 'invite_member') return response(201, await invite(ctx, input));
      if (action === 'revoke_member') {
        requirePermission(ctx, 'team');
        const target = ctx.account.members.find(m => m.id === input.memberId); if (!target) throw fail(404, 'Member not found.');
        if (!ctx.staff && target.role === 'admin' && !ctx.account.members.some(m => m.id !== target.id && m.status === 'active' && m.role === 'admin')) throw fail(409, 'Keep at least one active account administrator.');
        target.status = 'revoked'; target.version += 1; delete target.inviteHash; delete target.inviteExpiresAt;
        await save(ctx, action); return response(200, { ok: true });
      }
      if (action === 'save_account') {
        requirePermission(ctx, 'team');
        ctx.account.billingEmail = email(input.billingEmail); ctx.account.reference = text(input.reference, 150);
        await save(ctx, action); return response(200, { ok: true });
      }
      if (action === 'save_property') {
        requirePermission(ctx, 'request');
        let item = input.propertyId ? property(ctx, input.propertyId) : null;
        if (!item) { bounded(ctx.account, 'properties'); item = { id: uid() }; ctx.account.properties.push(item); }
        Object.assign(item, { name: text(input.name, 100, true), address: text(input.address, 300, true), contact: text(input.contact, 150), access: text(input.access, 800), updatedAt: new Date(now()).toISOString() });
        await save(ctx, action); return response(200, { ok: true, propertyId: item.id });
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
        await save(ctx, action, [{ collection: 'jobs', id: jobId, version: job._version, patch: true, data: { businessAccountId: ctx.account.id, businessPropertyId: input.propertyId, businessSharingApprovedBy: ctx.profile.user, businessSharingApprovedAt: link.sharedAt } }]);
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
        const jobId = requireJobId(input.jobId), job = await store.read('jobs', jobId); requireLinkedJob(ctx.account, jobId, job);
        const e = job.estimate || {}, quoteStatus = String(job.customerApproval?.status || e.status || job.quoteStatus || '');
        if (!e.sentAt && !['sent', 'approved', 'accepted'].includes(quoteStatus)) throw fail(409, 'EGC has not released this project quote yet. Contact the account team.');
        const p = rights(ctx.member), actorId = businessActor(ctx.account.id, ctx.member);
        return response(200, { url: '/customer-portal' }, { 'Set-Cookie': await projectCookie(jobId, { actorId, permissions: { view: true, decide: p.decide === true, pay: p.pay === true, rebook: p.request === true } }) });
      }
      throw fail(400, 'Unknown business hub action.');
    } catch (error) { return response(error.status || 503, { error: error.publicMessage || 'The business hub could not complete that action. Please retry or contact Zoe.' }); }
  };
}
