/* Review-only business billing. This module never creates a charge, modifies an invoice,
   or sends a message. A later collector must revalidate the saved allocation under locks. */
import { fail, isId, digest, receiptExpiry, requireJobId, requireLinkedJob, rights } from './business-hub-core.js';
import { canSeeProperty, memberPropertyIds, operationReceipt } from './business-hub-scope.js';
import { customerMoneyTotals, invoiceIssued, refundsRecorded } from './money-core.js';

function allowed(ctx, helpers, permission) {
  if (ctx.staff && !ctx.manager) throw fail(403, 'An EGC business manager must review billing.');
  helpers.requirePermission(ctx, permission);
}
const activePayer = member => member?.status === 'active' && rights(member).pay === true;
export function resolveBusinessBillingRecipient(account, propertyId) {
  const property = (account.properties || []).find(p => p.id === propertyId);
  if (!property) return null;
  const memberId = property.billingContactMemberId || account.billingContactMemberId;
  const member = (account.members || []).find(m => m.id === memberId);
  if (!activePayer(member) || !canSeeProperty(member, propertyId)) return null;
  // A free-form legacy billingEmail is not evidence of company authorization.
  return { memberId: member.id, name: member.name, email: member.email, version: member.version };
}
function reference(input) {
  if (!isId(input.requestId)) throw fail(400, 'Reload this form before trying again.');
  return input.requestId;
}
async function setContact(ctx, input, h) {
  allowed(ctx, h, 'team');
  const requestId = reference(input), propertyId = input.propertyId ?? null;
  if (propertyId !== null && !isId(propertyId)) throw fail(400, 'Choose a company property.');
  const property = propertyId ? h.property(ctx, propertyId) : null;
  const memberId = input.memberId ?? null;
  if (memberId !== null && !isId(memberId)) throw fail(400, 'Choose an authorized billing member.');
  const at = new Date(h.now()).toISOString();
  const receipt = await operationReceipt(h.store, ctx, 'set_billing_contact', requestId, { propertyId, memberId }, at);
  if (receipt.duplicate) return h.response(200, { ok: true, duplicate: true });
  const member = (ctx.account.members || []).find(m => m.id === memberId);
  if (memberId && (!activePayer(member) || (propertyId ? !canSeeProperty(member, propertyId) : memberPropertyIds(member)))) {
    throw fail(409, 'Choose an active administrator or billing member with access to these properties.');
  }
  const target = property || ctx.account, before = target.billingContactMemberId || null;
  if (memberId) target.billingContactMemberId = memberId; else delete target.billingContactMemberId;
  await h.save(ctx, 'set_billing_contact', receipt.writes, {
    hub: 'business.billing_contact', requestId, before: { propertyId, memberId: before }, after: { propertyId, memberId },
  });
  return h.response(200, { ok: true });
}

function idsFrom(input) {
  if (!Array.isArray(input.jobIds) || !input.jobIds.length || input.jobIds.length > 25) throw fail(400, 'Select between one and 25 invoices.');
  const ids = input.jobIds.map(requireJobId);
  if (new Set(ids).size !== ids.length) throw fail(400, 'Select each invoice only once.');
  return ids.sort();
}
async function allocation(ctx, jobIds, h) {
  const jobs = await h.store.jobs(jobIds), rows = [];
  for (const jobId of jobIds) {
    const job = jobs.get(jobId), link = requireLinkedJob(ctx.account, jobId, job);
    h.property(ctx, link.propertyId);
    const recipient = resolveBusinessBillingRecipient(ctx.account, link.propertyId);
    if (!recipient) throw fail(409, 'An authorized billing contact is required for every selected property.');
    const totals = customerMoneyTotals(job, { unified: true });
    const rawAmount = job.invoice?.amount, roundedAmount = Math.round(rawAmount * 100);
    const amountCents = typeof rawAmount === 'number' && Number.isFinite(rawAmount) && Math.abs(rawAmount * 100 - roundedAmount) < 0.000001 ? roundedAmount : null;
    const issuedCents = Number.isSafeInteger(job.invoice?.amountCents) ? job.invoice.amountCents : amountCents;
    const invoiceConsistent = (job.invoice?.amount === undefined || amountCents === issuedCents) &&
      (job.invoice?.amountCents === undefined || Number.isSafeInteger(job.invoice.amountCents));
    if (!invoiceIssued(job.invoice) || [job.pipelineStatus, job.status].some(value => ['cancelled', 'canceled', 'lost', 'superseded'].includes(String(value).toLowerCase())) ||
        h.needsReview(job) || refundsRecorded(job) || !totals.complete || !invoiceConsistent || totals.purpose !== 'balance' || issuedCents !== totals.totalCents ||
        !Number.isSafeInteger(totals.balanceCents) || totals.balanceCents <= 0) {
      throw fail(409, 'A selected invoice is not ready for payment review. Refresh its project before continuing.');
    }
    rows.push({ jobId, propertyId: link.propertyId, invoiceNumber: job.invoice.number, invoiceIssuedAt: job.invoice.issuedAt || '', totalCents: issuedCents,
      jobVersion: job._version, amountCents: totals.balanceCents, recipient });
  }
  const totalCents = rows.reduce((total, row) => total + row.amountCents, 0);
  if (!Number.isSafeInteger(totalCents)) throw fail(409, 'The selected total could not be verified.');
  // Mixed recipients must be reviewed separately; never send a portfolio to the wrong payer.
  if (new Set(rows.map(row => row.recipient.memberId)).size !== 1) throw fail(409, 'Select invoices for one billing contact at a time.');
  return { currency: 'usd', totalCents, invoices: rows };
}
const publicPreparation = (record, duplicate = false) => ({ ok: true, duplicate, preparation: {
  id: record.id, status: record.status, paymentExecutionEnabled: false, currency: record.allocation.currency,
  totalCents: record.allocation.totalCents, recipient: record.allocation.invoices[0].recipient,
  invoices: record.allocation.invoices.map(({ jobVersion, recipient, ...row }) => row), createdAt: record.at,
} });
async function prepare(ctx, input, h) {
  allowed(ctx, h, 'pay');
  const requestId = reference(input), jobIds = idsFrom(input);
  const fingerprint = await digest(JSON.stringify({ accountId: ctx.account.id, actorId: ctx.member.id, jobIds }));
  const saved = await h.store.read('business_operations', requestId);
  if (saved && (saved.action !== 'prepare_business_payment' || saved.accountId !== ctx.account.id || saved.actorId !== ctx.member.id || saved.fingerprint !== fingerprint)) {
    throw fail(409, 'Request reference already exists.');
  }
  const current = await allocation(ctx, jobIds, h);
  const allocationHash = await digest(JSON.stringify({ ...current, invoices: current.invoices.map(({ jobVersion, ...row }) => row) }));
  if (saved) {
    if (saved.status !== 'prepared' || allocationHash !== saved.allocationHash) throw fail(409, 'This payment review changed or was cancelled. Refresh and prepare a new review.');
    return h.response(200, publicPreparation(saved, true));
  }
  const at = h.now(), record = { id: requestId, action: 'prepare_business_payment', accountId: ctx.account.id, actorId: ctx.member.id,
    fingerprint, allocationHash, allocation: current, status: 'prepared', at: new Date(at).toISOString(), expireAt: receiptExpiry(at) };
  // Read-only precondition writes pin the account and each canonical invoice to the reviewed revisions.
  // No financial field is changed. If any revision changed during preparation the atomic commit fails.
  const jobs = await h.store.jobs(jobIds);
  for (const row of current.invoices) if (jobs.get(row.jobId)?._version !== row.jobVersion) throw fail(409, 'An invoice changed. Refresh before preparing this review.');
  await h.save(ctx, 'prepare_business_payment', [
    ...current.invoices.map(row => ({ collection: 'jobs', id: row.jobId, data: { id: row.jobId }, version: row.jobVersion, patch: true })),
    { collection: 'business_operations', id: requestId, data: record },
  ], { hub: 'business.payment_prepared', requestId, after: { invoiceCount: current.invoices.length, paymentExecutionEnabled: false } });
  return h.response(201, publicPreparation(record));
}
async function cancel(ctx, input, h) {
  allowed(ctx, h, 'pay');
  const requestId = reference(input), record = await h.store.read('business_operations', requestId);
  if (!record || record.action !== 'prepare_business_payment' || record.accountId !== ctx.account.id || record.actorId !== ctx.member.id) throw fail(404, 'Payment review not found.');
  for (const row of record.allocation.invoices) h.property(ctx, row.propertyId);
  if (record.status === 'cancelled') return h.response(200, { ok: true, duplicate: true });
  record.status = 'cancelled'; record.cancelledAt = new Date(h.now()).toISOString();
  await h.save(ctx, 'cancel_business_payment', [{ collection: 'business_operations', id: requestId, data: record, version: record._version }], {
    hub: 'business.payment_preparation_cancelled', requestId, after: { status: 'cancelled' },
  });
  return h.response(200, { ok: true });
}
async function review(ctx, input, h) {
  allowed(ctx, h, 'pay');
  const requestId = reference(input), record = await h.store.read('business_operations', requestId);
  if (!record || record.action !== 'prepare_business_payment' || record.accountId !== ctx.account.id || record.actorId !== ctx.member.id) throw fail(404, 'Payment review not found.');
  return prepare(ctx, { requestId, jobIds: record.allocation.invoices.map(row => row.jobId) }, h);
}

const csvCell = value => {
  let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  // Quote escaping alone does not stop spreadsheet formula execution. Include
  // leading whitespace/BOM because spreadsheet readers may strip it first.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
const dollars = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
async function exportReview(ctx, url, h) {
  allowed(ctx, h, 'pay');
  const requestId = reference({ requestId: url.searchParams.get('review') });
  const saved = await h.store.read('business_operations', requestId);
  if (!saved || saved.action !== 'prepare_business_payment' || saved.accountId !== ctx.account.id || saved.actorId !== ctx.member.id) throw fail(404, 'Payment review not found.');
  if (saved.status !== 'prepared' || !Array.isArray(saved.allocation?.invoices)) throw fail(409, 'This payment review changed or was cancelled. Refresh and prepare a new review.');
  const jobIds = idsFrom({ jobIds: saved.allocation.invoices.map(row => row?.jobId) });
  const fingerprint = await digest(JSON.stringify({ accountId: ctx.account.id, actorId: ctx.member.id, jobIds }));
  const current = await allocation(ctx, jobIds, h);
  const allocationHash = await digest(JSON.stringify({ ...current, invoices: current.invoices.map(({ jobVersion, ...row }) => row) }));
  if (fingerprint !== saved.fingerprint || allocationHash !== saved.allocationHash) throw fail(409, 'This payment review changed. Refresh and prepare a new review.');
  // Read-only export: detect mutations observed during verification without
  // changing an account, financial record or operation receipt. Later payment
  // collection must still revalidate in its own atomic transaction.
  const [account, latest, jobs] = await Promise.all([
    h.store.read('business_accounts', ctx.account.id), h.store.read('business_operations', requestId), h.store.jobs(jobIds),
  ]);
  if (!ctx.account._version || account?._version !== ctx.account._version || !saved._version || latest?._version !== saved._version ||
      current.invoices.some(row => !row.jobVersion || jobs.get(row.jobId)?._version !== row.jobVersion)) {
    throw fail(409, 'The account or an invoice changed during export. Refresh and try again.');
  }
  const header = ['Invoice', 'Property', 'Billing recipient', 'Billing email', 'Currency', 'Outstanding cents', 'Outstanding amount'];
  const rows = current.invoices.map(row => [row.invoiceNumber, ctx.account.properties.find(p => p.id === row.propertyId)?.name || '', row.recipient.name, row.recipient.email, current.currency.toUpperCase(), row.amountCents, dollars(row.amountCents)]);
  rows.push(['TOTAL', '', '', '', current.currency.toUpperCase(), current.totalCents, dollars(current.totalCents)]);
  const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="egc-invoice-review.csv"',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
export const actions = { set_billing_contact: setContact, prepare_business_payment: prepare, review_business_payment: review, cancel_business_payment: cancel };
export const exporters = { billing_review: exportReview };
export const decorate = [(view, ctx) => {
  const allowed = ctx.staff ? ctx.manager : rights(ctx.member).pay || rights(ctx.member).team;
  if (!allowed) return view;
  const candidates = rights(ctx.member).team || ctx.staff ? (ctx.account.members || []).filter(activePayer).map(m => ({
    id: m.id, name: m.name, email: m.email, propertyIds: memberPropertyIds(m) ? [...memberPropertyIds(m)] : null,
  })) : [];
  view.billing = { paymentExecutionEnabled: false, canManage: ctx.staff ? ctx.manager : rights(ctx.member).team === true,
    accountContactMemberId: ctx.account.billingContactMemberId || '', candidates,
    routes: (ctx.account.properties || []).map(p => ({ propertyId: p.id, contactMemberId: p.billingContactMemberId || '', recipient: resolveBusinessBillingRecipient(ctx.account, p.id) })),
  };
  return view;
}];
