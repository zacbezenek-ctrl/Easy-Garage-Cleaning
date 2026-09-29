/** FUN-32 Jobber coexistence guard. While Jobber and the Hub run side by side,
 * a read-only check lists every stray created in Jobber after the owner's
 * cutover day (funnel definitions `jobber.cutoverDate`, America/Denver):
 * requests, jobs and invoices created on or after it, visits on or after it,
 * payments entered on or after it, imported Hub balances that Jobber has since
 * settled or changed, and HighLevel contacts and opportunities the Jobber app
 * created. It never writes to Jobber or HighLevel. Findings are matched to Hub
 * customers (imported Jobber id, CRM contact, then unique phone or email; a
 * phone or email match alone is reported but never holds) and saved
 * server-only in jobberGuard/latest, but only from a complete check. Holds use
 * a saved check only while its cutover day is the deployed one.
 *
 * Three switches, each off unless exactly 'true', act only once the cutover day
 * is set and reached; with every switch off nothing here is read and the Hub
 * behaves as before:
 *   EGC_JOBBER_GUARD_BOOKING   /api/crew-hook stops forwarding signed game plans
 *                              to the Zap that creates a Jobber job.
 *   EGC_JOBBER_GUARD_BILLING   the money API and the invoice batch refuse
 *                              invoice.issue, and the messaging cron holds deposit
 *                              reminders, while an open Jobber bill for the customer
 *                              (or a settled imported balance for the job) is saved.
 *   EGC_JOBBER_GUARD_MESSAGING the messaging cron holds automatic customer
 *                              reminders while the customer has open Jobber work
 *                              or an open Jobber invoice that Jobber may message.
 * A hold never cancels Hub work or sends anything; clearing the stray in Jobber
 * and saving a new check releases it. */
import { funnelDefinitions, definitionsHash, ghlTagKey } from './funnel-definitions.js';
import { denverDate } from './funnel-calendar.js';
import { denverToday, validDate } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { normalizeEmail, normalizePhoneE164 } from './customer-identity.js';
import { OPEN_INVOICE_STATUSES, invoiceStatus, jobberMoneyCents, jobberNumericId, maskEmail, maskName, maskPhone } from './jobber-import-map.js';
import { jobberGraphql } from './jobber-graphql.js';

export const JOBBER_GUARD_COLLECTION = 'jobberGuard';
export const JOBBER_GUARD_STATE_ID = 'latest';
export const JOBBER_GUARD_RUNS = 'jobberGuardRuns';
// Keeps jobberGuard/latest well under Firestore's 1 MiB document limit.
export const JOBBER_GUARD_FINDING_LIMIT = 1000;
export const JOBBER_GUARD_SCHEMA = 1;
// The cron's automatic customer messages (messaging-scheduler SCHEDULED_KINDS
// with a customer audience); billing holds only the money reminders.
export const GUARDED_MESSAGE_KINDS = Object.freeze({ billing: Object.freeze(['deposit_reminder']), messaging: Object.freeze(['day_before_reminder', 'deposit_reminder', 'estimate_expiring']) });
// What each finding can hold while its surface switch is on. Requests, payments
// and HighLevel records are report-only: the Hub never refuses its own work
// because of them.
const HOLDS = { jobber_job_after_cutover: ['messaging'], jobber_visit_after_cutover: ['messaging'], jobber_invoice_after_cutover: ['billing', 'messaging'], jobber_imported_balance_changed: ['billing'] };
// Only an identity match can hold: a phone or email is often shared (spouse,
// landlord, property manager), so a match on it alone is report-only.
const HOLDING_MATCHES = new Set(['jobber_client', 'crm_contact', 'imported']);
export const JOBBER_GUARD_ACTIONS = Object.freeze({
  jobber_request_after_cutover: 'Book this walkthrough in the Hub, then archive the request in Jobber.',
  jobber_job_after_cutover: 'Create or confirm this work in the Hub through Dispatch, then close the job in Jobber.',
  jobber_visit_after_cutover: 'Make sure every listed visit is scheduled in the Hub, then remove the visits from Jobber so Jobber sends no reminder and no crew goes twice.',
  jobber_invoice_after_cutover: 'Bill only from the Hub: delete an unpaid Jobber invoice and issue the bill in the Hub; if the customer paid it in Jobber, record that payment in Hub finance.',
  jobber_payment_after_cutover: 'Record this payment in Hub finance (method, date and reference) so the Hub never bills it again.',
  jobber_imported_balance_changed: 'Jobber shows this imported balance paid or changed: record the payment in Hub finance, or correct the Hub balance.',
  ghl_contact_from_jobber: 'The Jobber app is still creating HighLevel contacts: uninstall the Official Jobber Integration (docs/JOBBER-CUTOVER.md section 8) and check which HighLevel workflows fired.',
  ghl_opportunity_from_jobber: 'The Jobber app is still creating HighLevel opportunities: uninstall the Official Jobber Integration and move or close the opportunity so no nurture workflow texts the customer.',
});
const GHL_API = 'https://services.leadconnectorhq.com';
const CLOSED_REQUEST = new Set(['archived', 'converted', 'completed']);
const PAID_HUB = new Set(['paid', 'closed', 'cancelled', 'canceled', 'void', 'superseded']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(_egc_|secure_)/.test(value);
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code: `jobber_guard_${code}`, status });
const iso = value => { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const lower = value => String(value ?? '').toLowerCase();
const providerId = (value, type) => jobberNumericId(value, type) || (typeof value === 'string' && /^[A-Za-z0-9=_-]{1,200}$/.test(value) ? value : '');

/** The owner's Jobber cutover day ({date, at}: the Denver date and its midnight instant); both null until it is set. */
export function jobberCutover(definitions = funnelDefinitions()) {
  const date = definitions.jobber?.cutoverDate ?? null;
  return validDate(date) ? { date, at: localInstant(date, '00:00') } : { date: null, at: null };
}

/** The three switches and whether each blocks now. With every switch off the
 * definitions are not even read, so today's behaviour is unchanged. */
export function jobberGuardSwitches(env, now, definitions) {
  const enabled = { booking: env?.EGC_JOBBER_GUARD_BOOKING === 'true', billing: env?.EGC_JOBBER_GUARD_BILLING === 'true', messaging: env?.EGC_JOBBER_GUARD_MESSAGING === 'true' };
  if (!enabled.booking && !enabled.billing && !enabled.messaging) return { enabled, cutoverDate: null, reached: false, booking: false, billing: false, messaging: false };
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw fail('clock_invalid', 'The Jobber guard needs a valid current time.', 500);
  const { date } = jobberCutover(definitions || funnelDefinitions()), reached = Boolean(date) && denverToday(at) >= date;
  return { enabled, cutoverDate: date, reached, booking: enabled.booking && reached, billing: enabled.billing && reached, messaging: enabled.messaging && reached };
}

const CLIENT = 'client { id name phones { number } emails { address } receivesReminders receivesInvoiceFollowUps }';
const PAGE = 'pageInfo { hasNextPage endCursor }';
/** The five read-only queries (validated against Jobber's published schema). */
export const JOBBER_GUARD_QUERIES = Object.freeze({
  requests: `query EgcGuardRequests($after: String, $filter: RequestFilterAttributes) { requests(first: 50, after: $after, filter: $filter) { nodes { id title createdAt requestStatus ${CLIENT} } ${PAGE} } }`,
  jobs: `query EgcGuardJobs($after: String, $filter: JobFilterAttributes) { jobs(first: 50, after: $after, filter: $filter) { nodes { id jobNumber title createdAt jobStatus ${CLIENT} } ${PAGE} } }`,
  visits: `query EgcGuardVisits($after: String, $filter: VisitFilterAttributes) { visits(first: 50, after: $after, filter: $filter) { nodes { id startAt createdAt isComplete job { jobNumber } ${CLIENT} } ${PAGE} } }`,
  invoices: `query EgcGuardInvoices($after: String, $filter: InvoiceFilterAttributes) { invoices(first: 50, after: $after, filter: $filter) { nodes { id invoiceNumber invoiceStatus createdAt updatedAt amounts { total invoiceBalance } ${CLIENT} } ${PAGE} } }`,
  payments: `query EgcGuardPayments($after: String, $filter: PaymentRecordFilterAttributes) { paymentRecords(first: 50, after: $after, filter: $filter) { nodes { id amount entryDate invoice { invoiceNumber } ${CLIENT} } ${PAGE} } }`,
});

function jobberClient(node) {
  const client = plain(node) ? node : {};
  const flag = value => typeof value === 'boolean' ? value : null;
  return { jobberId: jobberNumericId(client.id, 'Client'), name: text(client.name, 200),
    phones: [...new Set((Array.isArray(client.phones) ? client.phones : []).map(phone => normalizePhoneE164(phone?.number)).filter(Boolean))],
    emails: [...new Set((Array.isArray(client.emails) ? client.emails : []).map(email => normalizeEmail(email?.address)).filter(Boolean))],
    receivesReminders: flag(client.receivesReminders), receivesInvoiceFollowUps: flag(client.receivesInvoiceFollowUps) };
}

/** Reads the Jobber records the guard needs, created (visits: starting, payments:
 * entered, invoices: updated) on or after `since` (an ISO instant). Read-only. */
export async function readJobberActivity(env, { since, fetcher = fetch, sleep, version, maxPages = 400 } = {}) {
  const sinceMs = Date.parse(since ?? '');
  if (!Number.isFinite(sinceMs)) throw fail('since_invalid', 'The guard needs the cutover instant.', 500);
  const { pages } = await jobberGraphql(env, { fetcher, sleep, version, maxPages, codePrefix: 'jobber_guard_', task: 'check', scopes: 'requests, jobs, visits, invoices and payments' });
  // A second of margin for how Jobber rounds the range; every row is also checked against `since` below.
  const after = new Date(sinceMs - 1000).toISOString(), q = JOBBER_GUARD_QUERIES;
  const requests = await pages(q.requests, 'requests', { filter: { createdAt: { after } } });
  const jobs = await pages(q.jobs, 'jobs', { filter: { createdAt: { after } } });
  const visits = await pages(q.visits, 'visits', { filter: { startAt: { after }, isComplete: false } });
  const invoices = await pages(q.invoices, 'invoices', { filter: { updatedAt: { after } } });
  const payments = await pages(q.payments, 'paymentRecords', { filter: { entryDate: { after } } });
  return {
    requests: requests.map(node => ({ id: providerId(node?.id, 'Request'), title: text(node?.title), createdAt: iso(node?.createdAt), status: lower(node?.requestStatus), client: jobberClient(node?.client) })),
    jobs: jobs.map(node => ({ id: providerId(node?.id, 'Job'), number: Number.isInteger(node?.jobNumber) ? String(node.jobNumber) : '', title: text(node?.title), createdAt: iso(node?.createdAt), status: lower(node?.jobStatus), client: jobberClient(node?.client) })),
    visits: visits.map(node => ({ id: providerId(node?.id, 'Visit'), number: Number.isInteger(node?.job?.jobNumber) ? String(node.job.jobNumber) : '', startAt: iso(node?.startAt), createdAt: iso(node?.createdAt), complete: node?.isComplete === true, client: jobberClient(node?.client) })),
    invoices: invoices.map(node => ({ id: providerId(node?.id, 'Invoice'), number: text(node?.invoiceNumber, 40), status: invoiceStatus(node?.invoiceStatus), createdAt: iso(node?.createdAt), updatedAt: iso(node?.updatedAt),
      totalCents: node?.amounts?.total == null ? null : jobberMoneyCents(node.amounts.total), balanceCents: node?.amounts?.invoiceBalance == null ? null : jobberMoneyCents(node.amounts.invoiceBalance), client: jobberClient(node?.client) })),
    payments: payments.map(node => ({ id: providerId(node?.id), createdAt: iso(node?.entryDate), amountCents: node?.amount == null ? null : jobberMoneyCents(node.amount), invoiceNumber: text(node?.invoice?.invoiceNumber, 40), client: jobberClient(node?.client) })),
  };
}

/** Which Jobber-app marker (source, tag or creating app id) a HighLevel contact or opportunity carries, or null. */
export function ghlJobberMarker(record, markers = funnelDefinitions().jobber.ghlAppMarkers) {
  const words = value => ghlTagKey(value).split('-').filter(Boolean);
  const source = words(record?.source);
  if (markers.sources.some(marker => { const want = words(marker); return want.length && want.every(word => source.includes(word)); })) return 'source';
  const tags = [...(Array.isArray(record?.tags) ? record.tags : []), ...(Array.isArray(record?.contact?.tags) ? record.contact.tags : [])];
  if (tags.some(tag => markers.tags.includes(ghlTagKey(tag)))) return 'tag';
  const creator = plain(record?.createdBy) ? String(record.createdBy.sourceId || record.createdBy.appId || '') : '';
  if (creator && markers.createdBySourceIds.includes(creator)) return 'app';
  return null;
}

/** HighLevel contacts and opportunities added on or after `since`, newest first,
 * stopping at the first older row, that carry a Jobber-app marker. Read-only. */
export async function readGhlJobberRecords(env, { since, fetcher = fetch, markers = funnelDefinitions().jobber.ghlAppMarkers, pageLimit = 100, maxPages = 100 } = {}) {
  const token = env?.HIGHLEVEL_API_KEY || env?.GHL_API_KEY || '', locationId = env?.HIGHLEVEL_LOCATION_ID || env?.GHL_LOCATION_ID || '', sinceMs = Date.parse(since ?? '');
  if (!token || !locationId) throw fail('ghl_not_configured', 'Set HIGHLEVEL_API_KEY and HIGHLEVEL_LOCATION_ID to check HighLevel, or skip HighLevel explicitly.', 503);
  if (!Number.isFinite(sinceMs)) throw fail('since_invalid', 'The guard needs the cutover instant.', 500);
  async function call(path, init, version) {
    let response;
    try { response = await fetcher(GHL_API + path, { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, Version: version, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('ghl_unavailable', 'HighLevel could not be reached. Nothing was saved; retry.'); }
    if (!response.ok) throw fail('ghl_unavailable', `HighLevel refused the check (HTTP ${response.status}). Check the key's contact and opportunity read scopes; nothing was saved.`);
    return response.json().catch(() => null);
  }
  async function newest(page, field, timeOf) {
    const rows = []; let previous = Infinity;
    for (let number = 1; number <= maxPages; number += 1) {
      const list = (await page(number))?.[field];
      if (!Array.isArray(list)) throw fail('ghl_incomplete', 'HighLevel returned an incomplete page. Nothing was saved; retry.');
      let older = false;
      for (const row of list) {
        const ms = Date.parse(timeOf(row) ?? '');
        if (Number.isFinite(ms)) {
          // The stop rule needs newest-first order, checked over the whole page:
          // anything else is not proof that no newer row follows.
          if (ms > previous + 1000) throw fail('ghl_incomplete', 'HighLevel did not return records newest first. Nothing was saved; retry.');
          previous = ms;
          if (ms < sinceMs) { older = true; continue; }
        }
        if (!older) rows.push(row);
      }
      if (older || list.length < pageLimit) return rows;
    }
    throw fail('ghl_incomplete', 'HighLevel paging did not finish. Nothing was saved; retry.');
  }
  const contacts = await newest(page => call('/contacts/search', { method: 'POST', body: JSON.stringify({ locationId, page, pageLimit, sort: [{ field: 'dateAdded', direction: 'desc' }] }) }, '2021-07-28'), 'contacts', row => row?.dateAdded ?? row?.createdAt);
  const opportunities = await newest(page => call(`/opportunities/search?${new URLSearchParams({ locationId, status: 'all', order: 'added_desc', limit: String(pageLimit), page: String(page) })}`, { method: 'GET' }, 'v3'), 'opportunities', row => row?.createdAt ?? row?.dateAdded);
  const keep = (rows, contact) => rows.map(row => ({ row, marker: ghlJobberMarker(row, markers) })).filter(item => item.marker).map(({ row, marker }) => {
    const person = contact(row);
    return { id: text(row?.id), createdAt: iso(row?.dateAdded ?? row?.createdAt), marker, contactId: text(person?.id || row?.contactId), name: text(person?.name || [person?.firstName, person?.lastName].filter(Boolean).join(' '), 200), phone: normalizePhoneE164(person?.phone), email: normalizeEmail(person?.email) };
  }).filter(item => item.id);
  return { contacts: keep(contacts, row => row), opportunities: keep(opportunities, row => ({ ...(plain(row?.contact) ? row.contact : {}), id: row?.contact?.id || row?.contactId })) };
}

function hubIndex(hub) {
  const byJobber = new Map(), byContact = new Map(), byPhone = new Map(), byEmail = new Map(), imported = new Map();
  const add = (map, key, id) => { if (key && safeId(id)) map.set(key, new Set([...(map.get(key) || []), id])); };
  for (const row of Array.isArray(hub?.customers) ? hub.customers : []) {
    if (!safeId(row?.id)) continue;
    add(byJobber, /^jobber_client_(\d{1,15})$/.exec(row.id)?.[1], row.id);
    add(byContact, typeof row.highlevelContactId === 'string' ? row.highlevelContactId : '', row.id);
    add(byPhone, normalizePhoneE164(row.phone || row.phoneE164 || ''), row.id);
    add(byEmail, normalizeEmail(row.email || row.emailLower || ''), row.id);
  }
  for (const row of Array.isArray(hub?.jobs) ? hub.jobs : []) {
    if (!/^jobber_(job|visit|invoice)_/.test(row?.id || '') || !safeId(row.customerId)) continue;
    add(byJobber, String(row.jobber?.jobberClientId || ''), row.customerId);
    if (row.id.startsWith('jobber_invoice_')) imported.set(row.id, row);
  }
  return { byJobber, byContact, byPhone, byEmail, imported };
}

function matchCustomer(index, { jobberId = '', contactId = '', phones = [], emails = [] }) {
  for (const [match, map, keys] of [['jobber_client', index.byJobber, [jobberId]], ['crm_contact', index.byContact, [contactId]], ['phone', index.byPhone, phones], ['email', index.byEmail, emails]]) {
    const ids = new Set(keys.filter(Boolean).flatMap(key => [...(map.get(key) || [])]));
    if (ids.size === 1) return { customerId: [...ids][0], match };
    if (ids.size > 1) return { customerId: null, match: 'ambiguous' };
  }
  return { customerId: null, match: 'none' };
}

/** Pure: the findings for one check. `since` is {date, at}; jobber/ghl are the
 * readers' results or null when that source was not read; hub is
 * {customers, jobs} (imported jobber_* jobs with customerId and jobber fields). */
export function jobberGuardFindings({ jobber = null, ghl = null, hub, since, definitions = funnelDefinitions() }) {
  const rules = definitions.jobber, sinceMs = Date.parse(since?.at ?? ''), index = hubIndex(hub), found = new Map();
  if (!Number.isFinite(sinceMs)) throw fail('since_invalid', 'The guard needs the cutover instant.', 500);
  // Unknown times are kept: a row the filter returned is a stray unless it is provably older.
  const onOrAfter = value => { const ms = Date.parse(value ?? ''); return !Number.isFinite(ms) || ms >= sinceMs; };
  function add(code, { ref, open, at, provider = 'jobber', person, jobId = null, matched = null, messaging = true, details = {} }) {
    const spec = rules.findings[code], surfaces = spec.surfaces.filter(surface => surface !== 'messaging' || messaging !== false);
    const { customerId, match } = matched || matchCustomer(index, person);
    const holds = open && HOLDING_MATCHES.has(match) ? (HOLDS[code] || []).filter(surface => surfaces.includes(surface) && (spec.scope === 'job' ? safeId(jobId) : Boolean(customerId))) : [];
    const id = `${code}:${ref}`;
    if (!found.has(id)) found.set(id, { id, code, provider, surfaces, scope: spec.scope, holds, open, at: at || null, customerId: customerId || null, jobId: safeId(jobId) ? jobId : null, match,
      ref: { id: String(ref), ...details }, masked: { name: maskName(person?.name), phone: maskPhone(person?.phones?.[0] || ''), email: maskEmail(person?.emails?.[0] || '') }, action: JOBBER_GUARD_ACTIONS[code] });
  }
  const person = client => ({ jobberId: client.jobberId, name: client.name, phones: client.phones, emails: client.emails });
  if (jobber) {
    for (const request of jobber.requests) if (request.id && onOrAfter(request.createdAt)) add('jobber_request_after_cutover', { ref: request.id, open: !CLOSED_REQUEST.has(request.status), at: request.createdAt, person: person(request.client), details: { status: request.status || null } });
    for (const job of jobber.jobs) if (job.id && onOrAfter(job.createdAt)) add('jobber_job_after_cutover', { ref: job.number || job.id, open: job.status !== 'archived', at: job.createdAt, person: person(job.client), messaging: job.client.receivesReminders, details: { number: job.number || null, status: job.status || null } });
    // Visits group per Jobber job: one finding lists how many remain and their first and last Denver days.
    const visits = new Map();
    for (const visit of jobber.visits) if (visit.id && !visit.complete && onOrAfter(visit.startAt)) { const key = visit.number || visit.id, group = visits.get(key) || []; group.push(visit); visits.set(key, group); }
    for (const [key, group] of visits) {
      const days = group.map(visit => visit.startAt ? denverDate(visit.startAt) : null).filter(Boolean).sort();
      add('jobber_visit_after_cutover', { ref: `job:${key}`, open: true, at: group.map(visit => visit.startAt).filter(Boolean).sort()[0] || null, person: person(group[0].client), messaging: group[0].client.receivesReminders, details: { number: group[0].number || null, visits: group.length, firstDate: days[0] || null, lastDate: days.at(-1) || null } });
    }
    for (const invoice of jobber.invoices) {
      if (!invoice.id) continue;
      const details = { number: invoice.number || null, status: invoice.status || null, balanceCents: invoice.balanceCents ?? null };
      if (onOrAfter(invoice.createdAt)) { add('jobber_invoice_after_cutover', { ref: invoice.number || invoice.id, open: !['paid', 'bad_debt', 'void'].includes(invoice.status), at: invoice.createdAt, person: person(invoice.client), messaging: invoice.client.receivesInvoiceFollowUps, details }); continue; }
      const hubRow = invoice.number ? index.imported.get(`jobber_invoice_${invoice.number}`) : null;
      if (!hubRow) continue;
      const saved = Number.isInteger(hubRow.jobber?.balanceCents) ? hubRow.jobber.balanceCents : null;
      const changed = !OPEN_INVOICE_STATUSES.includes(invoice.status) || Number.isInteger(invoice.balanceCents) && saved !== null && invoice.balanceCents !== saved;
      const hubOpen = ![hubRow.status, hubRow.pipelineStatus, hubRow.invoice?.status].some(value => PAID_HUB.has(lower(value)));
      if (changed) add('jobber_imported_balance_changed', { ref: invoice.number, open: hubOpen, at: invoice.updatedAt, person: person(invoice.client), jobId: hubRow.id, matched: { customerId: hubRow.customerId, match: 'imported' }, details: { ...details, importedBalanceCents: saved } });
    }
    for (const payment of jobber.payments) if (payment.id && onOrAfter(payment.createdAt)) add('jobber_payment_after_cutover', { ref: payment.id, open: false, at: payment.createdAt, person: person(payment.client), details: { amountCents: payment.amountCents ?? null, invoiceNumber: payment.invoiceNumber || null } });
  }
  if (ghl) for (const [code, rows] of [['ghl_contact_from_jobber', ghl.contacts], ['ghl_opportunity_from_jobber', ghl.opportunities]]) for (const row of rows) {
    if (!onOrAfter(row.createdAt)) continue;
    add(code, { ref: row.id, open: true, at: row.createdAt, provider: 'ghl', person: { contactId: row.contactId, name: row.name, phones: row.phone ? [row.phone] : [], emails: row.email ? [row.email] : [] }, details: { marker: row.marker, contactId: row.contactId || null } });
  }
  return [...found.values()].sort((left, right) => left.code.localeCompare(right.code) || String(left.at).localeCompare(String(right.at)) || left.id.localeCompare(right.id));
}

/** One check: reads Jobber (and HighLevel unless skipped) and the Hub snapshot,
 * and returns the PII-masked report. Writes nothing. A source that fails is
 * reported as incomplete coverage, never as "no strays". */
export async function runJobberGuardCheck({ env, store, now, since, runId, definitions = funnelDefinitions(), ghl = true, fetcher = fetch, sleep, version, maxPages } = {}) {
  const checkedAt = iso(now);
  if (!checkedAt) throw fail('clock_invalid', 'The Jobber guard needs a valid current time.', 500);
  if (!since?.date || !validDate(since.date) || !since.at) throw fail('cutover_unset', 'Set jobber.cutoverDate in the funnel definitions (docs/JOBBER-CUTOVER.md), or preview a day with --since.', 409);
  const sources = { hub: 'complete', jobber: 'not_read', ghl: ghl ? 'not_read' : 'skipped' };
  const [customers, jobs] = await Promise.all([store.customers(), store.jobRecords(['type', 'recordType', 'customerId', 'status', 'pipelineStatus', 'invoice.status', 'jobber.jobberClientId', 'jobber.invoiceNumber', 'jobber.balanceCents'])]);
  const read = async (name, reader) => { try { const result = await reader(); sources[name] = 'complete'; return result; } catch (error) { sources[name] = /^jobber_guard_[a-z_]+$/.test(error?.code || '') ? error.code.slice('jobber_guard_'.length) : 'unavailable'; return null; } };
  const jobber = await read('jobber', () => readJobberActivity(env, { since: since.at, fetcher, sleep, version, maxPages }));
  const crm = ghl ? await read('ghl', () => readGhlJobberRecords(env, { since: since.at, fetcher, markers: definitions.jobber.ghlAppMarkers })) : null;
  const all = jobberGuardFindings({ jobber, ghl: crm, hub: { customers, jobs: jobs.filter(row => /^jobber_/.test(row?.id || '')) }, since, definitions });
  const findings = all.slice(0, JOBBER_GUARD_FINDING_LIMIT), byCode = {};
  for (const finding of all) byCode[finding.code] = (byCode[finding.code] || 0) + 1;
  const reasons = Object.entries(sources).filter(([, status]) => status !== 'complete').map(([name, status]) => `${name}_${status}`);
  return { schemaVersion: JOBBER_GUARD_SCHEMA, runId: runId || null, checkedAt, cutoverDate: since.date, since: since.at, definitionsVersion: definitions.definitionsVersion, definitionsHash: definitionsHash(),
    coverage: { complete: !reasons.length, sources, reasons },
    counts: { findings: all.length, open: all.filter(item => item.open).length, holding: all.filter(item => item.holds.length).length, unmatched: all.filter(item => !item.customerId && !item.jobId).length, holdingCustomers: new Set(all.filter(item => item.holds.length && item.customerId).map(item => item.customerId)).size, byCode },
    truncated: all.length > findings.length, findings };
}

/** Saves a check as jobberGuard/latest (revision-checked) plus a create-only
 * jobberGuardRuns/<runId> summary in one commit. Only a check whose every source
 * was read (or deliberately skipped) and that the definitions' cutover day
 * governs may be saved: holds must never rest on a partial or preview check. */
export async function saveJobberGuardState(store, report, { actor, definitions = funnelDefinitions() } = {}) {
  if (!plain(report) || report.schemaVersion !== JOBBER_GUARD_SCHEMA || !safeId(report.runId)) throw fail('report_invalid', 'Only a complete guard report can be saved.', 400);
  if (Object.values(report.coverage?.sources || {}).some(status => !['complete', 'skipped'].includes(status)) || report.coverage?.sources?.jobber !== 'complete') throw fail('coverage_incomplete', 'Some sources could not be read, so this check was not saved. The last saved check stays in force; retry.', 409);
  if (report.truncated) throw fail('too_many_findings', `More than ${JOBBER_GUARD_FINDING_LIMIT} strays were found, so the check was not saved. Clear them in Jobber and check again.`, 409);
  if (report.cutoverDate !== jobberCutover(definitions).date) throw fail('preview_not_saved', 'A preview with another cutover day is never saved. Set jobber.cutoverDate in the funnel definitions first.', 409);
  const existing = await store.read(JOBBER_GUARD_COLLECTION, JOBBER_GUARD_STATE_ID);
  if (existing && iso(existing.checkedAt) && Date.parse(existing.checkedAt) > Date.parse(report.checkedAt)) throw fail('state_newer', 'A newer check is already saved. Nothing was changed.', 409);
  // The next-step text is derived from the code when read, so it is not stored.
  const { findings, ...summary } = report, savedBy = typeof actor === 'string' && actor ? actor.slice(0, 120) : 'jobber-guard-check';
  await store.commit([
    { collection: JOBBER_GUARD_COLLECTION, id: JOBBER_GUARD_STATE_ID, ...(existing ? { revision: existing.revision } : {}), patch: { ...summary, findings: findings.map(({ action, ...item }) => item), savedBy } },
    { collection: JOBBER_GUARD_RUNS, id: report.runId, patch: { ...summary, savedBy } },
  ]);
  return { saved: true, runId: report.runId, findings: findings.length };
}

/** The saved check, or null before the first one. A malformed document fails closed. */
export async function readJobberGuardState(store) {
  const row = await store.read(JOBBER_GUARD_COLLECTION, JOBBER_GUARD_STATE_ID);
  if (!row) return null;
  if (row.schemaVersion !== JOBBER_GUARD_SCHEMA || !Array.isArray(row.findings) || !iso(row.checkedAt)) throw fail('state_unreadable', 'The saved Jobber guard check could not be read. Retry, or save a new check.');
  return row;
}

/** Saved findings that hold `surface` for this customer or job. */
export function jobberGuardHolds(state, surface, { customerId = null, jobId = null } = {}) {
  if (!state) return [];
  return state.findings.filter(item => plain(item) && Array.isArray(item.holds) && item.holds.includes(surface) && HOLDING_MATCHES.has(item.match) && (item.scope === 'job' ? safeId(jobId) && item.jobId === jobId : safeId(customerId) && item.customerId === customerId));
}

/** What a hold may show a manager: codes, Jobber numbers and the next step, no contact details. */
export const jobberGuardHoldView = item => ({ id: item.id, code: item.code, ref: item.ref, at: item.at, action: JOBBER_GUARD_ACTIONS[item.code] || null });

/** Why a billing hold refuses invoice.issue, named from the held findings. */
export function jobberGuardBillingError(holds) {
  const codes = new Set(holds.map(item => item?.code)), reasons = [];
  if (codes.has('jobber_invoice_after_cutover')) reasons.push('Jobber billed this customer after the cutover: settle that bill in Jobber or record its payment in Hub finance.');
  if (codes.has('jobber_imported_balance_changed')) reasons.push('Jobber shows this job\'s imported balance as paid or changed: record the payment in Hub finance or correct the Hub balance.');
  return `${reasons.join(' ') || 'Jobber has an open bill or a changed imported balance for this job or customer.'} Save a new Jobber guard check before issuing this invoice. Nothing was changed.`;
}

// A check saved for another cutover day (the owner moved jobber.cutoverDate)
// covers other dates, so holds ignore it until a check for the deployed day is saved.
const inForce = (state, cutoverDate) => state && state.cutoverDate === cutoverDate ? state : null;

/** Billing hold for a money invoice.issue: the findings that refuse it, or []
 * when the switch is off, the cutover is not reached, no check for the deployed
 * cutover day is saved, the request already ran (its receipt exists, so a
 * replay returns the saved result) or nothing holds this job. */
export async function jobberGuardInvoiceHolds(store, env, input, now, { receipts, definitions } = {}) {
  const switches = input?.action === 'invoice.issue' ? jobberGuardSwitches(env, now, definitions) : null;
  if (!switches?.billing || !safeId(input.jobId)) return { holds: [], state: null };
  if (receipts && typeof input.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(input.requestId) && await store.read(receipts, input.requestId.toLowerCase())) return { holds: [], state: null };
  const state = inForce(await readJobberGuardState(store), switches.cutoverDate);
  if (!state) return { holds: [], state: null };
  const job = await store.read('jobs', input.jobId);
  return { holds: job ? jobberGuardHolds(state, 'billing', { customerId: job.customerId, jobId: job.id }) : [], state };
}

/** Wraps the messaging cron's approved-send service: an automatic customer
 * reminder for a held customer or job is not sent and reports status
 * 'suppressed' with reason jobber_guard_billing or jobber_guard_messaging (or
 * jobber_guard_unavailable when the saved check cannot be read), so it shows in
 * the run summary and messaging holds. Other kinds pass through unchanged, and
 * with both switches off (or no saved check for the deployed cutover day) the
 * service is returned as is. */
export async function jobberGuardSends(service, { store, env, now, definitions } = {}) {
  let surfaces = [env?.EGC_JOBBER_GUARD_BILLING === 'true' && 'billing', env?.EGC_JOBBER_GUARD_MESSAGING === 'true' && 'messaging'].filter(Boolean), state = null, unavailable = false, cutoverDate = null;
  if (!surfaces.length) return service;
  // Never throws into the tick: a switched-on surface whose cutover or saved check cannot be read holds its reminders.
  try { const switches = jobberGuardSwitches(env, now, definitions); surfaces = surfaces.filter(surface => switches[surface]); cutoverDate = switches.cutoverDate; } catch { unavailable = true; }
  if (!surfaces.length) return service;
  if (!unavailable) try { state = inForce(await readJobberGuardState(store), cutoverDate); } catch { unavailable = true; }
  if (!state && !unavailable) return service;
  async function hold(input) {
    const wanted = surfaces.filter(surface => GUARDED_MESSAGE_KINDS[surface].includes(input?.kind));
    if (!wanted.length || !safeId(input.jobId)) return null;
    if (unavailable) return { status: 'suppressed', reason: 'jobber_guard_unavailable' };
    let job;
    try { job = await store.read('jobs', input.jobId); } catch { return { status: 'suppressed', reason: 'jobber_guard_unavailable' }; }
    const surface = wanted.find(name => jobberGuardHolds(state, name, { customerId: job?.customerId, jobId: input.jobId }).length);
    return surface ? { status: 'suppressed', reason: `jobber_guard_${surface}` } : null;
  }
  return { ...service, async preview(actor, input) { return await hold(input) || service.preview(actor, input); }, async send(actor, input) { return await hold(input) || service.send(actor, input); } };
}
