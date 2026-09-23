/* Account boundaries and public DTOs. No browser-supplied price or role is trusted. */
export const LIMITS = Object.freeze({ properties: 100, requests: 300, projects: 100, members: 30, messages: 400 });
export const ROLES = Object.freeze({
  admin: { view: true, request: true, decide: true, pay: true, team: true },
  manager: { view: true, request: true, decide: true, pay: false, team: false },
  billing: { view: true, request: false, decide: false, pay: true, team: false },
  viewer: { view: true, request: false, decide: false, pay: false, team: false },
});
export const fail = (status, message) => Object.assign(new Error(message), { status, publicMessage: message });
export const uid = () => crypto.randomUUID().replaceAll('-', '');
export const isId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function text(value, max = 180, required = false) {
  if (value != null && typeof value !== 'string') throw fail(400, 'A text field has an invalid value.');
  const result = (value || '').trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (result.length > max || (required && !result)) throw fail(400, `Please complete the required fields (maximum ${max} characters).`);
  return result;
}
export function email(value, required = true) {
  const result = text(value, 180, required).toLowerCase();
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw fail(400, 'Enter a valid email address.');
  return result;
}
export function date(value) {
  const result = text(value, 10);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result + 'T12:00:00Z')) || new Date(result + 'T12:00:00Z').toISOString().slice(0, 10) !== result)) throw fail(400, 'Enter a valid date.');
  return result;
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export const randomToken = () => uid() + uid();
export const rights = member => member?.status === 'active' ? { ...(ROLES[member.role] || {}) } : {};
export function permitted(member, permission) {
  if (!rights(member)[permission]) throw fail(403, 'Your account role does not allow this action.');
}
export function staffAllowed(profile) {
  return Boolean(profile && (profile.businessAccess === true || profile.role === 'sales'));
}
export function staffCanAccess(profile, account) {
  return staffAllowed(profile) && (profile.businessAccess === true || account.ownerStaff === profile.user);
}
export function activeMember(account, memberId, version) {
  if (!account || account.status !== 'active') throw fail(401, 'Your business account is unavailable. Contact Zoe for access.');
  const member = (account.members || []).find(m => m.id === memberId && m.status === 'active');
  if (!member || member.version !== version) throw fail(401, 'Your access has changed. Ask for a new private sign-in link.');
  return member;
}
export function bounded(account, field) {
  if ((account[field] || []).length >= LIMITS[field]) throw fail(409, 'This account has reached its workspace limit. Contact EGC before adding more records. Existing records remain available.');
}
export function requireJobId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value) || /^(secure_|_egc_)/.test(value)) throw fail(400, 'Enter a valid EGC project ID.');
  return value;
}
export function requireLinkedJob(account, jobId, job) {
  requireJobId(jobId);
  const link = (account.projects || []).find(p => p.jobId === jobId && p.active !== false);
  if (!link || !job || job.id !== jobId || job.businessAccountId !== account.id || job.businessPropertyId !== link.propertyId) throw fail(403, 'This project is not shared with this business account.');
  return link;
}
export function businessActor(accountId, member) {
  if (!isId(accountId) || !isId(member.id) || !Number.isInteger(member.version)) throw fail(403, 'Business access is invalid.');
  return `biz_${accountId}_${member.id}_${member.version}`;
}
export function parseBusinessActor(actorId) {
  const match = /^biz_([a-f0-9]{32})_([a-f0-9]{32})_([1-9][0-9]{0,8})$/.exec(actorId || '');
  if (!match) throw fail(403, 'Business access is invalid.');
  return { accountId: match[1], memberId: match[2], version: Number(match[3]) };
}
export function projectView(account, link, job, finance, needsReview) {
  try { requireLinkedJob(account, link.jobId, job); }
  catch { return { jobId: link.jobId, propertyId: link.propertyId, unavailable: true }; }
  const e = job.estimate || {}, invoice = job.invoice || {};
  const quoteState = String(job.customerApproval?.status || e.status || job.quoteStatus || 'not_issued');
  const released = Boolean(e.sentAt || ['sent', 'approved', 'accepted'].includes(quoteState));
  const invoiceIssued = Boolean(invoice.number && !['draft', 'void', 'superseded'].includes(invoice.status || 'draft'));
  const receipt = job.payment?.verified === true && /^https:\/\/pay\.stripe\.com\/receipts\//.test(job.payment?.receiptUrl || '') ? job.payment.receiptUrl : '';
  return {
    jobId: job.id, propertyId: link.propertyId, service: String(job.serviceType || 'Property service').slice(0, 120),
    status: String(job.pipelineStatus || job.status || 'not_scheduled').slice(0, 60),
    date: typeof job.date === 'string' ? job.date.slice(0, 10) : '',
    time: typeof job.time === 'string' ? job.time.slice(0, 10) : '',
    quoteStatus: released ? quoteState : 'not_issued', quoteNumber: released ? String(e.number || '').slice(0, 100) : '',
    total: released ? finance.total : null, invoiceNumber: invoiceIssued ? String(invoice.number).slice(0, 100) : '',
    invoiceStatus: invoiceIssued ? String(invoice.status || '').slice(0, 60) : 'not_issued',
    dueDate: invoiceIssued ? String(invoice.dueDate || '').slice(0, 10) : '',
    balance: invoiceIssued && !needsReview ? finance.balance : null,
    paid: invoiceIssued && !needsReview ? finance.paid : null,
    paymentNeedsReview: Boolean(needsReview), receiptUrl: receipt,
  };
}
export function accountView(account, member, projects, { staff = false, manager = false } = {}) {
  const permissions = staff ? { view: true, request: true, team: true, staff: true, link: manager } : rights(member);
  const members = (account.members || []).map(m => ({ id: m.id, name: m.name, role: m.role, status: m.status, ...(permissions.team ? { email: m.email } : {}) }));
  return {
    account: { id: account.id, company: account.company, billingEmail: permissions.team || permissions.pay || staff ? account.billingEmail : '', reference: account.reference || '', status: account.status },
    viewer: { name: member.name, role: member.role, permissions },
    properties: account.properties || [], requests: account.requests || [], messages: account.messages || [], members, projects,
    manager: { name: 'Zoe Zoll', email: 'zoe.zoll@easygaragecleaning.com', phone: '+19709991403' },
    coverage: { linked: (account.projects || []).filter(p => p.active !== false).length, unavailable: projects.filter(p => p.unavailable).length, paymentReview: projects.filter(p => p.paymentNeedsReview).length },
    updatedAt: account.updatedAt,
  };
}
