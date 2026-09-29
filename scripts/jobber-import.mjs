/** Jobber → EGC Hub import (JOB-CUT). DRY RUN BY DEFAULT: reads Jobber data and
 * the complete Hub customer and job snapshot, then prints a PII-masked report of
 * what an import would do (matches to existing Hub customers by normalized phone
 * or email, duplicates, conflicts, unmappable rows) and writes nothing.
 *
 * Sources:
 *   CSV (default) — Jobber exports: Clients → Export (CSV) plus the Insights →
 *     Reports Visits, Invoices and Recurring jobs reports exported to CSV. Only
 *     --clients is required. Header names follow docs/JOBBER-CUTOVER.md; a
 *     --mapping JSON file overrides any column ({"visits":{"date":"Visit date"}}).
 *   --source=graphql — reads Jobber's GraphQL API with JOBBER_CLIENT_ID,
 *     JOBBER_CLIENT_SECRET and JOBBER_REFRESH_TOKEN (the /api/jobber-auth app,
 *     which additionally needs the read_jobs, read_scheduled_items and
 *     read_invoices scopes). JOBBER_GRAPHQL_VERSION overrides the API version.
 *
 * `--apply` also requires `--expect-fingerprint <sha256>` (the Jobber data,
 * resolutions and options) and `--expect-plan <sha256>` (every write and client
 * decision, which also depend on the Hub and the clock) from the reviewed dry
 * run, so what is applied is exactly what was reviewed, and refuses while any
 * blocking item (conflict, unmappable open invoice or upcoming job, missing
 * column, jobs-collection limit) remains. It then creates, and only creates
 * (Firestore exists:false preconditions; existing documents are never changed):
 *   customers/jobber_client_<id>     new customers with provenance {source:'jobber', jobberId, importedAt}
 *   jobs/jobber_job_<jobNumber>      upcoming or unscheduled Jobber work: ONE unscheduled, unassigned
 *                                    job per Jobber job, needsDispatchReview:true, notifications off
 *   jobs/jobber_visit_<...>          completed past visits as history (recordType 'jobber_history')
 *   jobs/jobber_invoice_<number>     open invoices as an opening balance, flagged imported, never charged
 *   jobberImport/<runId>             the run receipt, updated in the same commit as every batch
 * Imported jobs and balances join the customer's single account root
 * (customerAccountOwnerJobId), as Dispatch and Garage Guard require. Recurring
 * plans are reported (and kept on the receipt) until P1-05's recurring plan
 * service is merged. Deterministic ids make a rerun a no-op. The script never
 * contacts HighLevel, Stripe or any messaging provider and never sends a message.
 *
 *   node scripts/jobber-import.mjs --clients clients.csv --visits visits.csv --invoices invoices.csv [--recurring recurring.csv]
 *   node scripts/jobber-import.mjs ... --report jobber-dry-run.json
 *   node scripts/jobber-import.mjs ... --resolutions resolutions.json --history-since 2024-10-01
 *   node scripts/jobber-import.mjs ... --apply --expect-fingerprint <sha256> --expect-plan <sha256> [--reviewed-report jobber-dry-run.json]
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON (reads even in a dry run). */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { firebaseServiceAccountConfigured } from '../functions/_lib/firebase-service-account.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { validDate } from '../functions/_lib/dispatch-time.js';
import { localInstant } from '../functions/_lib/operations-portal-records.js';
import * as map from '../functions/_lib/jobber-import-map.js';
import { DEFAULT_JOBBER_GRAPHQL_VERSION, jobberGraphql } from '../functions/_lib/jobber-graphql.js';

export const JOBS_COLLECTION_SAFE_LIMIT = 500;
export const DEFAULT_GQL_VERSION = DEFAULT_JOBBER_GRAPHQL_VERSION;
const fail = (code, message, details) => Object.assign(new Error(message), { code: 'jobber_import_' + code, ...(details ? { details } : {}) });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(_egc_|secure_)/.test(id);
const bump = (object, key, by = 1) => { object[key] = (object[key] || 0) + by; };

/** Validates the resolution file that settles conflicts by Jobber id:
 * clients:{<jobberClientId>:{customerId}|{action:'create'|'skip'}},
 * jobs:{<jobNumber>:{jobberClientId}|{action:'skip'}},
 * invoices:{<invoiceNumber>:{jobberClientId}|{action:'skip'|'import'}},
 * customers:{<hubCustomerId>:{accountRootJobId}} (a Hub customer with several
 * account roots: the existing root imported jobs and balances join). */
export function normalizeResolutions(input = {}) {
  if (!plain(input) || Object.keys(input).some(key => !['clients','jobs','invoices','customers'].includes(key))) throw fail('resolutions_invalid', 'The resolutions file may only contain clients, jobs, invoices and customers.');
  const output = { clients: Object.create(null), jobs: Object.create(null), invoices: Object.create(null), customers: Object.create(null) };
  const rules = { clients: [/^\d{1,15}$/, { customerId: safeId, action: value => ['create','skip'].includes(value) }], jobs: [/^\d{1,12}$/, { jobberClientId: value => /^\d{1,15}$/.test(value), action: value => value === 'skip' }], invoices: [/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/, { jobberClientId: value => /^\d{1,15}$/.test(value), action: value => ['skip','import'].includes(value) }], customers: [{ test: safeId }, { accountRootJobId: safeId }] };
  for (const [kind, entries] of Object.entries(input)) {
    if (!plain(entries)) throw fail('resolutions_invalid', `resolutions.${kind} must be an object keyed by ${kind === 'customers' ? 'Hub customer id' : 'Jobber id'}.`);
    const [idPattern, fields] = rules[kind];
    for (const [id, value] of Object.entries(entries)) {
      const keys = plain(value) ? Object.keys(value) : [];
      if (!idPattern.test(id) || keys.length !== 1 || !Object.hasOwn(fields, keys[0]) || !fields[keys[0]](value[keys[0]])) throw fail('resolutions_invalid', `resolutions.${kind}["${id}"] must be exactly one of: ${Object.keys(fields).join(', ')}.`);
      output[kind][id] = { [keys[0]]: value[keys[0]] };
    }
  }
  return output;
}

export function normalizeMapping(input = {}) {
  if (!plain(input) || Object.keys(input).some(kind => !map.JOBBER_EXPORT_KINDS.includes(kind) || !plain(input[kind]))) throw fail('mapping_invalid', `The mapping file must be an object keyed by ${map.JOBBER_EXPORT_KINDS.join(', ')}, each mapping field names to CSV headers.`);
  return input;
}

const PARSERS = { clients: map.clientsFromCsv, visits: map.visitsFromCsv, invoices: map.invoicesFromCsv, recurring: map.recurringFromCsv };
/** Builds the normalized source from CSV texts {clients, visits?, invoices?,
 * recurring?}; each may be an array when Jobber split the export (it emails
 * client exports over 1,499 rows as several files). Parts are merged before
 * grouping, so a client whose properties span two files stays one client. */
export function csvSource(files, mapping = {}) {
  const parts = kind => [files?.[kind]].flat().filter(value => value !== undefined);
  if (!parts('clients').length || parts('clients').some(text => typeof text !== 'string')) throw fail('clients_required', 'The Jobber client export (--clients) is required so visits and invoices can be linked to clients.');
  normalizeMapping(mapping);
  const source = { mode: 'csv', clients: [], visits: [], invoices: [], recurring: [], included: {}, files: {}, problems: [], blocking: [] };
  for (const kind of map.JOBBER_EXPORT_KINDS) {
    const texts = parts(kind), fields = Object.keys(map.JOBBER_COLUMNS[kind].fields), rows = [];
    if (!texts.length) continue;
    source.files[kind] = [];
    for (const [index, text] of texts.entries()) {
      const label = texts.length > 1 ? `${kind}#${index + 1}` : kind;
      let parsed;
      try { parsed = map.parseCsv(text); }
      catch (error) { source.files[kind].push({ error: error.message }); source.blocking.push({ code: 'csv_invalid', file: label, message: error.message }); continue; }
      const columns = map.mapColumns(kind, parsed.headers, mapping[kind] || {});
      source.files[kind].push({ rows: parsed.rows.length, matchedFields: Object.keys(columns.columns).sort(), missing: columns.missing, unknownHeaders: columns.unknownHeaders, duplicateHeaders: columns.duplicateHeaders, mappingProblems: columns.problems });
      if (columns.missing.length || columns.problems.length) { source.blocking.push({ code: 'columns_invalid', file: label, missing: columns.missing, problems: columns.problems }); continue; }
      for (const row of parsed.rows) rows.push({ line: texts.length > 1 ? `${index + 1}:${row.line}` : row.line, cells: fields.map(field => columns.columns[field] === undefined ? '' : row.cells[columns.columns[field]] ?? '') });
    }
    if (source.blocking.some(entry => entry.file === kind || entry.file.startsWith(kind + '#'))) continue;
    const result = PARSERS[kind]({ rows }, Object.fromEntries(fields.map((field, index) => [field, index])));
    source[kind] = result[kind];
    source.included[kind] = true;
    source.problems.push(...result.problems);
  }
  return source;
}

const CLIENTS_QUERY = `query EgcImportClients($after: String) { clients(first: 50, after: $after) { nodes { id name firstName lastName companyName isCompany isArchived isLead leadSource
  phones { number primary } emails { address primary } billingAddress { street1 street2 city province postalCode }
  properties { id name street1 street2 city province postalCode } } pageInfo { hasNextPage endCursor } } }`;
const VISITS_QUERY = `query EgcImportVisits($after: String, $filter: VisitFilterAttributes) { visits(first: 50, after: $after, filter: $filter) { nodes { id title startAt endAt allDay completedAt isComplete instructions
  client { id } property { street1 street2 city province postalCode } job { jobNumber jobType title instructions }
  assignedUsers(first: 10) { nodes { name { full } } } amounts { visitBasedBillingTotal } } pageInfo { hasNextPage endCursor } } }`;
const RECURRING_QUERY = `query EgcImportRecurring($after: String) { jobs(first: 25, after: $after, filter: { jobType: RECURRING, status: active }) { nodes { jobNumber title client { id }
  property { street1 street2 city province postalCode }
  visitSchedule { startDate endDate startTime endTime next { date } recurrenceSchedule { calendarRule friendly } assignedTo(first: 10) { nodes { name { full } } } } }
  pageInfo { hasNextPage endCursor } } }`;
const INVOICES_QUERY = `query EgcImportInvoices($after: String, $filter: InvoiceFilterAttributes) { invoices(first: 50, after: $after, filter: $filter) { nodes { id invoiceNumber subject invoiceStatus issuedDate dueDate
  client { id } properties(first: 1) { nodes { street1 street2 city province postalCode } } jobs(first: 10) { nodes { jobNumber } }
  amounts { total invoiceBalance taxAmount } } pageInfo { hasNextPage endCursor } } }`;

/** Read-only Jobber GraphQL reader through the shared client
 * (functions/_lib/jobber-graphql.js): the refresh-token grant of
 * functions/api/jobber-clients.js, rate-limit backoff, and errors that never
 * include provider bodies or tokens. */
export async function graphqlSource(env, { fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), historySince = '', version = DEFAULT_GQL_VERSION, maxPages = 2000 } = {}) {
  const { pages } = await jobberGraphql(env, { fetcher, sleep, version, maxPages, codePrefix: 'jobber_import_', task: 'export', alternative: ', or use the CSV exports' });
  const since = historySince ? localInstant(historySince, '00:00') : null, problems = [];
  const visitNodes = [...await pages(VISITS_QUERY, 'visits', since ? { filter: { startAt: { after: since } } } : {}), ...(since ? await pages(VISITS_QUERY, 'visits', { filter: { status: 'UNSCHEDULED' } }) : [])];
  const invoiceNodes = new Map();
  for (const status of map.OPEN_INVOICE_STATUSES) for (const node of await pages(INVOICES_QUERY, 'invoices', { filter: { status } })) invoiceNodes.set(node?.id, node);
  const keep = (records, kind, valid) => records.filter(record => valid(record) || void problems.push({ file: kind, line: null, reason: 'jobber_id_invalid' }));
  return { mode: 'graphql', included: { clients: true, visits: true, invoices: true, recurring: true }, files: {}, problems, blocking: [],
    clients: keep((await pages(CLIENTS_QUERY, 'clients')).map(map.clientFromGraphql), 'clients', record => record.jobberId),
    visits: keep([...new Map(visitNodes.map(node => [node?.id, node])).values()].map(map.visitFromGraphql), 'visits', record => record.jobNumber && record.client.jobberId),
    invoices: keep([...invoiceNodes.values()].map(map.invoiceFromGraphql), 'invoices', record => record.invoiceNumber && record.client.jobberId),
    recurring: keep((await pages(RECURRING_QUERY, 'jobs')).map(map.recurringFromGraphql), 'recurring', record => record.jobNumber && record.client.jobberId) };
}

/** The reviewed input: Jobber data, resolutions and options, independent of the
 * Hub snapshot and the clock. --apply must quote it. */
export function sourceFingerprint(source, resolutions = {}, historySince = '') {
  const strip = records => records.map(({ line, lines, ...record }) => record);
  return sha256({ mode: source.mode, clients: strip(source.clients), visits: strip(source.visits), invoices: strip(source.invoices), recurring: strip(source.recurring), problems: source.problems, blocking: source.blocking, resolutions, historySince: historySince || '' });
}

/** What apply would do, which the Hub snapshot and the clock also shape: every
 * write id with a digest of its content (this run's timestamps and runId masked)
 * and every client decision. --apply must quote its fingerprint. */
function reviewablePlan(writes, matches, { now, runId }) {
  const stable = value => Array.isArray(value) ? value.map(stable) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stable(item)])) : value === now ? '<now>' : runId && value === runId ? '<run>' : value;
  return { writes: Object.fromEntries(writes.map(write => [`${write.collection}/${write.id}`, sha256(stable(write.patch)).slice(0, 16)])), clients: Object.fromEntries(matches.map(match => [match.jobberClientId, [match.action, match.customerId].filter(Boolean).join(' ')])) };
}

/** Difference between the reviewed dry run's `plan` and the plan apply
 * recomputed, for the operator to read before running the dry run again. */
export function planDifference(reviewed, current) {
  const before = plain(reviewed?.writes) ? reviewed.writes : {}, after = current.writes, clientsBefore = plain(reviewed?.clients) ? reviewed.clients : {};
  const list = items => ({ count: items.length, items: items.slice(0, 50) }), own = (object, key) => Object.hasOwn(object, key) ? object[key] : null;
  return { writesAdded: list(Object.keys(after).filter(id => !Object.hasOwn(before, id)).sort()), writesRemoved: list(Object.keys(before).filter(id => !Object.hasOwn(after, id)).sort()),
    writesChanged: list(Object.keys(after).filter(id => Object.hasOwn(before, id) && before[id] !== after[id]).sort()),
    clientsChanged: list([...new Set([...Object.keys(clientsBefore), ...Object.keys(current.clients)])].sort().filter(id => own(clientsBefore, id) !== own(current.clients, id)).map(id => ({ jobberClientId: id, reviewed: own(clientsBefore, id), now: own(current.clients, id) }))) };
}

const indexBy = (rows, keys) => { const index = new Map(); for (const row of rows) for (const key of keys(row)) if (key) index.set(key, [...new Set([...(index.get(key) || []), row.id ?? row.jobberId])]); return index; };
const maskedRef = ref => ({ name: map.maskName(ref?.name), phone: map.maskPhone(ref?.phones?.[0]), email: map.maskEmail(ref?.emails?.[0]) });

/** Pure plan from the source and a COMPLETE Hub snapshot. Decides every Jobber
 * client (match/create/conflict), links visits and invoices to clients, and
 * returns create-only writes plus a PII-masked report. */
export function planJobberImport(source, hub, { now, runId = '', resolutions = {}, historySince = '', safeJobsLimit = JOBS_COLLECTION_SAFE_LIMIT, allowLargeJobsCollection = false } = {}) {
  if (!Number.isFinite(Date.parse(now))) throw fail('clock_invalid', 'A valid current time is required.');
  if (historySince && !validDate(historySince)) throw fail('history_since_invalid', 'Use YYYY-MM-DD for --history-since.');
  const res = normalizeResolutions(resolutions || {});
  const hubCustomers = new Map(hub.customers.filter(row => safeId(row.id)).map(row => [row.id, row])), hubJobs = new Map(hub.jobs.map(row => [row.id, row])), imported = hub.imported || new Map();
  // The saved phone/email are authoritative; P4-02's derived keys can be stale.
  const hubPhone = row => map.normalizePhoneE164(row.phone || row.phoneE164 || ''), hubEmail = row => map.normalizeEmail(row.email || row.emailLower || '');
  const hubByPhone = indexBy([...hubCustomers.values()], row => [hubPhone(row)]), hubByEmail = indexBy([...hubCustomers.values()], row => [hubEmail(row)]);
  const counts = { clients: { rows: source.clients.length, matchedExisting: 0, alreadyImported: 0, create: 0, skipped: 0, conflicts: 0, withoutContact: 0, invalidContactValues: 0 },
    visits: { rows: source.visits.length, upcomingJobs: 0, upcomingVisits: 0, history: 0, historyAlreadyImported: 0, pastNotCompleted: 0, beforeHistorySince: 0, skippedByResolution: 0, timeNeedsReview: 0 },
    jobs: { create: 0, alreadyImported: 0 }, invoices: { rows: source.invoices.length, open: 0, openBalanceCents: 0, create: 0, alreadyImported: 0, skippedByStatus: {}, skippedNoBalance: 0, skippedByResolution: 0 },
    recurring: { rows: source.recurring.length, proposals: 0, needsManualSetup: 0 } };
  const conflicts = [], unmappable = source.problems.map(problem => ({ ...problem, blocking: true })), warnings = [], duplicates = [], changedSinceImport = [];

  const clients = new Map();
  for (const client of source.clients) {
    if (clients.has(client.jobberId)) { conflicts.push({ code: 'duplicate_jobber_client_id', jobberClientId: client.jobberId }); continue; }
    clients.set(client.jobberId, client);
    counts.clients.invalidContactValues += client.invalidContacts || 0;
  }
  const byPhone = indexBy([...clients.values()], client => client.phones), byEmail = indexBy([...clients.values()], client => client.emails), byName = indexBy([...clients.values()], client => [map.nameKey(client.name)]);
  function link(ref, override) {
    if (override?.action === 'skip') return { skip: true };
    const id = override?.jobberClientId || ref.jobberId;
    if (id) return clients.has(id) ? { jobberClientId: id } : { error: 'client_not_in_export' };
    const found = [...new Set([...ref.phones.flatMap(phone => byPhone.get(phone) || []), ...ref.emails.flatMap(email => byEmail.get(email) || [])])];
    if (found.length === 1) return { jobberClientId: found[0] };
    if (found.length > 1) return { error: 'ambiguous_jobber_client', candidates: found };
    const named = ref.name && ref.street ? (byName.get(map.nameKey(ref.name)) || []).filter(clientId => clients.get(clientId).properties.some(property => { const key = map.addressKey(property.address.street1); return key && (ref.street === key || ref.street.startsWith(key + ' ')); })) : [];
    return named.length === 1 ? { jobberClientId: named[0] } : { error: named.length ? 'ambiguous_jobber_client' : 'client_not_found', ...(named.length ? { candidates: named } : {}) };
  }

  // Visits: completed past visits are history; upcoming and unscheduled visits
  // group into one dispatch-review job per Jobber job; late visits are reported.
  const groups = new Map(), history = new Map(), targetsByClient = new Map(), addTarget = (clientId, id) => targetsByClient.set(clientId, [...(targetsByClient.get(clientId) || []), id]);
  for (const visit of source.visits) {
    const timing = map.visitTiming(visit.schedule, now);
    if (visit.schedule.timeNeedsReview) bump(counts.visits, 'timeNeedsReview');
    if (!visit.completed && timing === 'past') { bump(counts.visits, 'pastNotCompleted'); warnings.push({ code: 'past_visit_not_completed', jobNumber: visit.jobNumber, date: visit.schedule.date }); continue; }
    if (visit.completed && historySince && visit.schedule.date && visit.schedule.date < historySince) { bump(counts.visits, 'beforeHistorySince'); continue; }
    const linked = link(visit.client, res.jobs[visit.jobNumber]);
    if (linked.skip) { bump(counts.visits, 'skippedByResolution'); continue; }
    if (visit.completed) {
      const id = map.hubIds.visit(visit.jobNumber, visit.schedule);
      if (linked.error || !id) { warnings.push({ code: linked.error || 'completed_visit_without_date', kind: 'history', jobNumber: visit.jobNumber, line: visit.line ?? null, client: maskedRef(visit.client) }); continue; }
      if (history.has(id)) { duplicates.push({ kind: 'history_visit', id }); continue; }
      history.set(id, { ...visit, jobberClientId: linked.jobberClientId });
      addTarget(linked.jobberClientId, id);
      continue;
    }
    if (linked.error) { unmappable.push({ kind: 'upcoming_job', jobNumber: visit.jobNumber, line: visit.line ?? null, reason: linked.error, ...(linked.candidates ? { jobberClientCandidates: linked.candidates } : {}), client: maskedRef(visit.client), blocking: true }); continue; }
    const group = groups.get(visit.jobNumber) || { jobNumber: visit.jobNumber, jobType: visit.jobType, jobberClientId: linked.jobberClientId, visits: [] };
    if (group.jobberClientId !== linked.jobberClientId) { conflicts.push({ code: 'job_links_to_several_clients', jobNumber: visit.jobNumber, jobberClientIds: [group.jobberClientId, linked.jobberClientId] }); continue; }
    group.visits.push(visit);
    if (!groups.has(visit.jobNumber)) { groups.set(visit.jobNumber, group); addTarget(linked.jobberClientId, map.hubIds.job(visit.jobNumber)); }
  }

  const invoices = new Map(), statusByNumber = new Map();
  for (const invoice of source.invoices) {
    const override = res.invoices[invoice.invoiceNumber], seen = invoices.get(invoice.invoiceNumber);
    statusByNumber.set(invoice.invoiceNumber, invoice.status || 'unknown');
    if (override?.action === 'skip') { bump(counts.invoices, 'skippedByResolution'); continue; }
    const open = map.OPEN_INVOICE_STATUSES.includes(invoice.status) || override?.action === 'import';
    if (!invoice.status && !override) { unmappable.push({ kind: 'invoice', invoiceNumber: invoice.invoiceNumber, line: invoice.line ?? null, reason: 'invoice_status_unknown', blocking: true }); continue; }
    if (!open) { bump(counts.invoices.skippedByStatus, invoice.status); continue; }
    if (!Number.isInteger(invoice.balanceCents)) { unmappable.push({ kind: 'invoice', invoiceNumber: invoice.invoiceNumber, line: invoice.line ?? null, reason: 'invoice_balance_unknown', blocking: true }); continue; }
    if (invoice.balanceCents <= 0) { bump(counts.invoices, 'skippedNoBalance'); continue; }
    if (seen) { if (canonical({ ...seen, line: 0, jobberClientId: 0 }) !== canonical({ ...invoice, line: 0, jobberClientId: 0 })) conflicts.push({ code: 'duplicate_invoice_number', invoiceNumber: invoice.invoiceNumber }); else duplicates.push({ kind: 'invoice', invoiceNumber: invoice.invoiceNumber }); continue; }
    const linked = link(invoice.client, override?.jobberClientId ? override : undefined);
    if (linked.error) { unmappable.push({ kind: 'invoice', invoiceNumber: invoice.invoiceNumber, line: invoice.line ?? null, reason: linked.error, ...(linked.candidates ? { jobberClientCandidates: linked.candidates } : {}), client: maskedRef(invoice.client), blocking: true }); continue; }
    invoices.set(invoice.invoiceNumber, { ...invoice, jobberClientId: linked.jobberClientId });
    addTarget(linked.jobberClientId, map.hubIds.invoice(invoice.invoiceNumber));
    bump(counts.invoices, 'open'); counts.invoices.openBalanceCents += invoice.balanceCents;
  }

  // Client decisions: a resolution wins, then an earlier import of this client,
  // then one Hub customer sharing a normalized phone or email; otherwise create.
  const decisions = new Map(), conflict = (client, code, extra = {}) => ({ action: 'conflict', code, ...extra, client: map.maskedClient(client) });
  for (const client of clients.values()) {
    const override = res.clients[client.jobberId], ownId = map.hubIds.customer(client.jobberId);
    if (override?.action === 'skip') { decisions.set(client.jobberId, { action: 'skip' }); continue; }
    if (override?.customerId) { decisions.set(client.jobberId, { action: 'match', customerId: override.customerId, matchedBy: ['resolution'] }); continue; }
    if (!client.name) { decisions.set(client.jobberId, conflict(client, 'client_name_missing')); continue; }
    const prior = new Set(hubCustomers.has(ownId) ? [ownId] : []);
    for (const id of targetsByClient.get(client.jobberId) || []) if (hubJobs.get(id)?.customerId) prior.add(hubJobs.get(id).customerId);
    if (prior.size > 1) { decisions.set(client.jobberId, conflict(client, 'inconsistent_prior_import', { candidates: [...prior].sort() })); continue; }
    if (prior.size === 1 && !hubCustomers.has([...prior][0])) { decisions.set(client.jobberId, conflict(client, 'previous_customer_missing', { candidates: [...prior] })); continue; }
    if (prior.size === 1) { decisions.set(client.jobberId, { action: 'already_imported', customerId: [...prior][0], matchedBy: ['previous_import'] }); continue; }
    if (override?.action === 'create') { decisions.set(client.jobberId, { action: 'create', customerId: ownId, matchedBy: ['resolution'] }); continue; }
    const byContact = new Map();
    for (const phone of client.phones) for (const id of hubByPhone.get(phone) || []) byContact.set(id, [...(byContact.get(id) || []), 'phone']);
    for (const email of client.emails) for (const id of hubByEmail.get(email) || []) byContact.set(id, [...(byContact.get(id) || []), 'email']);
    if (byContact.size > 1) { decisions.set(client.jobberId, conflict(client, 'ambiguous_customer', { candidates: [...byContact.keys()].sort() })); continue; }
    if (byContact.size === 1) {
      const [[customerId, how]] = byContact, row = hubCustomers.get(customerId), differences = [], phone = hubPhone(row), email = hubEmail(row);
      if (phone && client.phones.length && !client.phones.includes(phone)) differences.push('phone');
      if (email && client.emails.length && !client.emails.includes(email)) differences.push('email');
      if (map.nameKey(row.name || [row.firstName, row.lastName].filter(Boolean).join(' ')) !== map.nameKey(client.name)) differences.push('name');
      if (differences.length) warnings.push({ code: 'matched_customer_differs', jobberClientId: client.jobberId, customerId, differences });
      decisions.set(client.jobberId, { action: 'match', customerId, matchedBy: [...new Set(how)].sort() });
      continue;
    }
    if (!client.phones.length && !client.emails.length) { bump(counts.clients, 'withoutContact'); warnings.push({ code: 'client_without_contact', jobberClientId: client.jobberId }); }
    decisions.set(client.jobberId, { action: 'create', customerId: ownId, matchedBy: [] });
  }
  // Two Jobber clients sharing a phone or email would become two Hub customers
  // that the Hub's own customer lookup could never tell apart.
  const creating = new Set([...decisions].filter(([, decision]) => decision.action === 'create').map(([jobberId]) => jobberId));
  for (const jobberId of creating) {
    if (res.clients[jobberId]?.action === 'create') continue;
    const client = clients.get(jobberId), others = [...new Set([...client.phones.flatMap(phone => byPhone.get(phone) || []), ...client.emails.flatMap(email => byEmail.get(email) || [])])].filter(id => id !== jobberId && creating.has(id));
    if (others.length) decisions.set(jobberId, conflict(client, 'duplicate_in_jobber', { jobberClientIds: others.sort() }));
  }
  const plannedIds = new Set([...decisions.values()].filter(decision => decision.action === 'create' || decision.action === 'already_imported').map(decision => decision.customerId));
  for (const [jobberId, decision] of decisions) if (decision.matchedBy?.[0] === 'resolution' && decision.action === 'match' && !hubCustomers.has(decision.customerId) && !plannedIds.has(decision.customerId)) decisions.set(jobberId, conflict(clients.get(jobberId), 'resolution_customer_missing', { candidates: [decision.customerId] }));
  const mergedInto = new Map();
  for (const [jobberId, decision] of decisions) {
    if (decision.action === 'conflict') { bump(counts.clients, 'conflicts'); conflicts.push({ code: decision.code, jobberClientId: jobberId, ...(decision.candidates ? { customerCandidates: decision.candidates } : {}), ...(decision.jobberClientIds ? { jobberClientIds: decision.jobberClientIds } : {}), client: decision.client }); continue; }
    bump(counts.clients, { match: 'matchedExisting', already_imported: 'alreadyImported', create: 'create', skip: 'skipped' }[decision.action]);
    if (decision.customerId && decision.action !== 'create') mergedInto.set(decision.customerId, [...(mergedInto.get(decision.customerId) || []), jobberId]);
  }
  for (const [customerId, jobberClientIds] of mergedInto) if (jobberClientIds.length > 1) duplicates.push({ kind: 'jobber_clients_share_customer', customerId, jobberClientIds: jobberClientIds.sort() });

  const records = { customers: [], jobs: [] }, context = { now, runId }, customerFor = new Map(), blockedByClient = [], createdById = new Map();
  for (const client of clients.values()) if (decisions.get(client.jobberId).action === 'create') { const record = map.customerRecord(client, { ...context, sourceMode: source.mode }); records.customers.push(record); createdById.set(record.id, record); }
  for (const [jobberId, decision] of decisions) if (decision.customerId && decision.action !== 'conflict') customerFor.set(jobberId, hubCustomers.get(decision.customerId) || createdById.get(decision.customerId));
  const target = (jobberClientId, id, kind) => {
    const decision = decisions.get(jobberClientId);
    if (decision?.action === 'skip') return null;
    if (!customerFor.has(jobberClientId)) { blockedByClient.push({ kind, id, jobberClientId }); return null; }
    return customerFor.get(jobberClientId);
  };
  for (const group of [...groups.values()].sort((a, b) => Number(a.jobNumber) - Number(b.jobNumber))) {
    const id = map.hubIds.job(group.jobNumber), customer = target(group.jobberClientId, id, 'upcoming_job');
    if (!customer) continue;
    bump(counts.visits, 'upcomingJobs'); counts.visits.upcomingVisits += group.visits.length;
    const fingerprint = sha256({ jobType: group.jobType, jobberClientId: group.jobberClientId, visits: group.visits.map(visit => ({ title: visit.title, schedule: visit.schedule, valueCents: visit.valueCents, assignedTo: visit.assignedTo })) });
    if (hubJobs.has(id)) { bump(counts.jobs, 'alreadyImported'); if (imported.has(id) && imported.get(id).jobber?.importFingerprint !== fingerprint) changedSinceImport.push({ id, kind: 'upcoming_job', jobNumber: group.jobNumber }); continue; }
    records.jobs.push(map.futureJobRecord(group, customer, { ...context, fingerprint })); bump(counts.jobs, 'create');
  }
  for (const [id, visit] of [...history].sort(([a], [b]) => a.localeCompare(b))) {
    const customer = target(visit.jobberClientId, id, 'history_visit');
    if (!customer) continue;
    if (hubJobs.has(id)) { bump(counts.visits, 'historyAlreadyImported'); continue; }
    records.jobs.push(map.historyRecord(visit, customer, context)); bump(counts.visits, 'history');
  }
  for (const invoice of [...invoices.values()].sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber))) {
    const id = map.hubIds.invoice(invoice.invoiceNumber), customer = target(invoice.jobberClientId, id, 'invoice');
    if (!customer) continue;
    const fingerprint = sha256({ status: invoice.status, totalCents: invoice.totalCents, balanceCents: invoice.balanceCents, issuedDate: invoice.issuedDate, dueDate: invoice.dueDate, subject: invoice.subject, jobNumbers: invoice.jobNumbers, jobberClientId: invoice.jobberClientId });
    if (hubJobs.has(id)) { bump(counts.invoices, 'alreadyImported'); if (imported.has(id) && imported.get(id).jobber?.importFingerprint !== fingerprint) changedSinceImport.push({ id, kind: 'invoice', invoiceNumber: invoice.invoiceNumber }); continue; }
    records.jobs.push(map.invoiceRecord(invoice, customer, { ...context, fingerprint })); bump(counts.invoices, 'create');
  }
  // An imported balance that Jobber no longer shows as open was probably paid
  // through an old Jobber link: record that payment in the Hub by hand.
  if (source.included.invoices) for (const id of [...hubJobs.keys()].filter(id => id.startsWith('jobber_invoice_')).sort()) {
    const number = id.slice('jobber_invoice_'.length);
    if (!invoices.has(number) && !res.invoices[number]) warnings.push({ code: 'imported_invoice_no_longer_open', id, jobberStatus: statusByNumber.get(number) || 'not_in_export' });
  }

  // Account lineage. Dispatch schedule.create and Garage Guard linking need
  // exactly one account root per customer (dispatch-lineage.js), so imported
  // jobs and balances join the customer's verified root, or the first of them
  // (lowest job, else lowest invoice) becomes it. History carries recordType and
  // is never a candidate. Chains are followed on the snapshot exactly as
  // verifiedAccountRoot does; apply fences an existing root's revision.
  const lineageRow = row => row && !row.recordType && ['job','cleanout','reorg','walkthrough'].includes(row.type);
  const hubRoot = (firstId, customerId) => {
    const seen = new Set();let id = firstId;
    for (let depth = 0; depth < 12; depth++) {
      if (!safeId(id) || seen.has(id)) return null;
      seen.add(id);
      const row = hubJobs.get(id);
      if (!lineageRow(row) || row.customerId !== customerId || !row.revision) return null;
      if (!row.customerAccountOwnerJobId || row.customerAccountOwnerJobId === id) return row;
      id = row.customerAccountOwnerJobId;
    }
    return null;
  };
  const accountRoots = [], importedByCustomer = new Map(), candidatesByCustomer = new Map();
  const add = (index, key, row) => (index.get(key) || index.set(key, []).get(key)).push(row);
  for (const record of records.jobs) if (!record.recordType) add(importedByCustomer, record.customerId, record);
  for (const row of hubJobs.values()) if (lineageRow(row) && row.type !== 'walkthrough' && importedByCustomer.has(row.customerId)) add(candidatesByCustomer, row.customerId, row);
  for (const [customerId, rows] of importedByCustomer) {
    const roots = new Map(), broken = [], chosen = res.customers[customerId]?.accountRootJobId;
    for (const row of candidatesByCustomer.get(customerId) || []) {
      const root = hubRoot(row.customerAccountOwnerJobId || row.id, customerId);
      if (root) roots.set(root.id, root); else broken.push(row.id);
    }
    const accountConflict = (code, extra) => conflicts.push({ code, customerId, jobberClientIds: [...new Set(rows.map(row => row.jobber.jobberClientId))].sort(), rootCandidates: [...roots.keys()].sort().slice(0, 50), ...extra });
    if (chosen && !roots.has(chosen)) { accountConflict('account_root_resolution_invalid', { accountRootJobId: chosen }); continue; }
    if (!chosen && broken.length) { accountConflict('customer_account_link_invalid', { jobIds: broken.sort().slice(0, 50) }); continue; }
    if (!chosen && roots.size > 1) { accountConflict('customer_has_multiple_account_roots'); continue; }
    const root = roots.get(chosen) || [...roots.values()][0];
    if (root) for (const row of rows) row.customerAccountOwnerJobId = root.id;
    else for (const row of rows.slice(1)) row.customerAccountOwnerJobId = rows[0].id;
    accountRoots.push(root ? { customerId, rootJobId: root.id, source: chosen ? 'resolution' : 'existing', revision: root.revision } : { customerId, rootJobId: rows[0].id, source: 'imported' });
  }

  const recurringPlans = [];
  for (const recurring of source.recurring) {
    const linked = link(recurring.client, res.jobs[recurring.jobNumber]);
    if (linked.skip) continue;
    const customer = linked.error ? null : customerFor.get(linked.jobberClientId);
    if (!customer) { warnings.push({ code: linked.error || 'recurring_client_unresolved', kind: 'recurring', jobNumber: recurring.jobNumber, client: maskedRef(recurring.client) }); continue; }
    const next = groups.get(recurring.jobNumber) ? [...groups.get(recurring.jobNumber).visits].sort((a, b) => (a.schedule.date || '9999').localeCompare(b.schedule.date || '9999'))[0].schedule : null;
    const { title, ...proposal } = map.recurringPlanProposal(recurring, { customerId: customer.id, nextVisit: next?.date ? next : null });
    recurringPlans.push(proposal); bump(counts.recurring, 'proposals');
    if (proposal.needsManualSetup) bump(counts.recurring, 'needsManualSetup');
  }
  // One Hub job stands for a Jobber job, so every further upcoming visit of a
  // one-off job (or of a recurring job with no plan proposal) is added by hand.
  // Per-visit ids would not survive a reschedule in Jobber: the CSV reports carry
  // no visit id, so a rerun would duplicate them.
  const proposed = new Set(recurringPlans.map(plan => plan.jobNumber));
  const multiVisitJobs = [...groups.values()].filter(group => customerFor.has(group.jobberClientId) && group.visits.length > 1 && !(group.jobType === 'recurring' && proposed.has(group.jobNumber)))
    .sort((a, b) => Number(a.jobNumber) - Number(b.jobNumber)).map(group => {
      const visits = map.sortVisits(group.visits), id = map.hubIds.job(group.jobNumber);
      return { id, jobNumber: group.jobNumber, jobType: group.jobType || '', visitCount: visits.length, alreadyImported: hubJobs.has(id), dates: visits.map(visit => visit.schedule.date || 'unscheduled'), visits: visits.map(visit => map.scheduleLabel(visit.schedule)) };
    });
  counts.visits.multiVisitJobs = multiVisitJobs.length;
  counts.visits.visitsToAddByHand = multiVisitJobs.reduce((sum, job) => sum + job.visitCount - 1, 0);

  const planned = records.jobs.length, current = hub.jobs.length, projected = current + planned;
  const jobsCollection = { current, planned, projected, safeLimit: safeJobsLimit, overLimit: projected > safeJobsLimit, allowed: allowLargeJobsCollection };
  const blocking = [...source.blocking];
  if (conflicts.length) blocking.push({ code: 'unresolved_conflicts', count: conflicts.length, message: 'Resolve every conflict in Jobber or with a resolutions file, then run the dry run again.' });
  const unmappableBlocking = unmappable.filter(row => row.blocking).length;
  if (unmappableBlocking) blocking.push({ code: 'unmappable_records', count: unmappableBlocking, message: 'Upcoming jobs, open invoices and export rows that cannot be linked would be lost. Fix them in Jobber, map them in the resolutions file, or skip them explicitly.' });
  if (blockedByClient.length) blocking.push({ code: 'records_blocked_by_client_conflict', count: blockedByClient.length, message: 'These records belong to a client with an unresolved conflict.' });
  if (jobsCollection.overLimit && !allowLargeJobsCollection) blocking.push({ code: 'jobs_collection_limit', ...jobsCollection, message: `The jobs collection would hold ${projected} documents. The sales follow-up exit check (functions/_lib/sales-followup-exit.js) refuses above ${safeJobsLimit}, so HighLevel nurture would keep texting customers who already accepted. Narrow --history-since, or pass --allow-large-jobs-collection once a bounded exit check is deployed (crew schedule pagination already shipped in P1-01).` });
  const writes = [...records.customers.map(patch => ({ collection: 'customers', id: patch.id, patch })), ...records.jobs.map(patch => ({ collection: 'jobs', id: patch.id, patch }))];
  const matches = [...decisions].filter(([, decision]) => decision.action !== 'conflict').map(([jobberClientId, decision]) => ({ jobberClientId, action: decision.action, customerId: decision.customerId || null, matchedBy: decision.matchedBy || [] }));
  const plan = reviewablePlan(writes, matches, { now, runId });
  return { writes, records, accountRoots, plan, planFingerprint: sha256(plan), report: { counts: { ...counts, jobsCollection }, blocking, conflicts, unmappable, duplicates, changedSinceImport, warnings, blockedByClient, matches, recurringPlans, multiVisitJobs,
    accountRoots: accountRoots.map(({ customerId, rootJobId, source }) => ({ customerId, rootJobId, source })),
    preview: { customers: records.customers.map(record => record.id), upcomingJobs: records.jobs.filter(record => record.id.startsWith('jobber_job_')).map(record => record.id), history: records.jobs.filter(record => record.recordType === 'jobber_history').length, invoices: records.jobs.filter(record => record.id.startsWith('jobber_invoice_')).map(record => record.id) } } };
}

const receiptProposal = ({ jobNumber, customerId, cadence, cadenceText, startDate, time, endTime, endsOn, needsManualSetup }) => ({ jobNumber, customerId, cadence, cadenceText, startDate, time, endTime, endsOn, needsManualSetup });

/** Reads the Hub, plans, and (only with apply + both reviewed fingerprints + no
 * blocking items) commits create-only batches. Every batch commit also advances
 * jobberImport/<runId> with an updateTime precondition. Batches that create
 * customers advance customerIdentityState/revision like customer resolution;
 * batches that create jobs or balances advance dispatchState/revision like every
 * dispatch writer and verify the revision of an existing account root they join.
 * A concurrent customer creation, dispatch change, re-rooted account or a second
 * run therefore aborts the batch instead of duplicating or splitting an account. */
export async function runJobberImport(store, { source, apply = false, now = new Date().toISOString(), runId = randomUUID(), resolutions = {}, historySince = '', expectFingerprint = '', expectPlanFingerprint = '', reviewedPlan = null, allowLargeJobsCollection = false, batchSize = 100, safeJobsLimit = JOBS_COLLECTION_SAFE_LIMIT } = {}) {
  const fingerprint = sourceFingerprint(source, resolutions, historySince);
  // Read both guards BEFORE the customer and job snapshot they protect.
  const guard = await store.read('customerIdentityState', 'revision'), dispatchGuard = await store.read('dispatchState', 'revision');
  const [customers, jobs] = await Promise.all([store.customers(), store.jobs()]);
  const imported = new Map(), ids = jobs.filter(row => /^jobber_(job|invoice)_/.test(row.id)).map(row => row.id);
  for (let start = 0; start < ids.length; start += 25) for (const saved of await Promise.all(ids.slice(start, start + 25).map(id => store.read('jobs', id)))) if (saved) imported.set(saved.id, saved);
  const plan = planJobberImport(source, { customers, jobs, imported }, { now, runId, resolutions, historySince, safeJobsLimit, allowLargeJobsCollection });
  const committed = { customers: 0, jobs: 0 }, batches = [];
  let receipt = null, receiptCreated = false, guardRevision = guard?.revision, dispatchRevision = dispatchGuard?.revision;
  const summary = extra => ({ mode: apply ? 'apply' : 'dry_run', runId, generatedAt: now, sourceFingerprint: fingerprint, planFingerprint: plan.planFingerprint, source: { mode: source.mode, files: source.files }, options: { historySince: historySince || null, allowLargeJobsCollection },
    ...plan.report, writes: { planned: { customers: plan.records.customers.length, jobs: plan.records.jobs.length }, committed: { ...committed }, batches: batches.map(batch => ({ ...batch })), receipt: receiptCreated ? `jobberImport/${runId}` : null }, plan: plan.plan, ...extra });
  if (!apply) return summary({});
  if (expectFingerprint !== fingerprint) return summary({ aborted: { code: 'jobber_import_fingerprint_mismatch', message: 'Apply needs --expect-fingerprint with the sourceFingerprint of the dry run you reviewed, run on the same exports and resolutions. Nothing was written.' } });
  if (plan.report.blocking.length) return summary({ aborted: { code: 'jobber_import_blocked', message: 'The dry run still has blocking items. Nothing was written.' } });
  if (expectPlanFingerprint !== plan.planFingerprint) {
    const difference = reviewedPlan ? planDifference(reviewedPlan, plan.plan) : null;
    const counted = difference ? ` Since the reviewed dry run: ${difference.writesAdded.count} writes added, ${difference.writesRemoved.count} removed, ${difference.writesChanged.count} changed, ${difference.clientsChanged.count} client decisions changed.` : '';
    return summary({ aborted: { code: 'jobber_import_plan_changed', message: `Apply needs --expect-plan with the planFingerprint of the dry run you reviewed, and the Hub or the clock must not have changed what would be written.${counted} Nothing was written. Run the dry run again, review it and apply with its planFingerprint.`, ...(difference ? { difference } : {}) } });
  }
  if (!plan.writes.length) return summary({});
  const counts = writes => ({ customers: writes.filter(write => write.collection === 'customers').length, jobs: writes.filter(write => write.collection === 'jobs').length });
  const roots = new Map(plan.accountRoots.map(root => [root.rootJobId, { ...root }]));
  const stop = async (code, message) => {
    if (receipt) await store.commit([{ collection: 'jobberImport', id: runId, revision: receipt.revision, patch: { status: 'aborted', abortedCode: code, updatedAt: now } }]).catch(() => null);
    return summary({ aborted: { code, message } });
  };
  const hubChanged = (batch = false) => `Hub customers, dispatch work or imported records changed during the import, so ${batch ? 'this batch was not written' : 'it stopped'}. Run the dry run again and apply; records already imported are skipped.`;
  try {
    await store.commit([{ collection: 'jobberImport', id: runId, patch: { runId, scope: 'jobber_import', actorId: map.JOBBER_IMPORT_ACTOR, status: 'running', sourceMode: source.mode, sourceFingerprint: fingerprint, planFingerprint: plan.planFingerprint, historySince: historySince || null,
      createdAt: now, updatedAt: now, planned: counts(plan.writes), committed: { customers: 0, jobs: 0 }, committedBatches: [], lastBatchId: '', recurringPlanProposals: plan.report.recurringPlans.map(receiptProposal) } }]);
  } catch { /* a lost response is resolved by the read below */ }
  receipt = await store.read('jobberImport', runId);
  if (receipt?.sourceFingerprint !== fingerprint || receipt.status !== 'running' || receipt.committedBatches?.length) { receipt = null; return stop('jobber_import_receipt_unavailable', 'The import receipt could not be created. Nothing was written; retry.'); }
  receiptCreated = true;
  for (let start = 0; start < plan.writes.length; start += batchSize) {
    const group = plan.writes.slice(start, start + batchSize), batchId = `${runId}-${String(batches.length + 1).padStart(4, '0')}`, added = counts(group);
    const entry = { batchId, ids: group.map(write => `${write.collection}/${write.id}`) }, next = { customers: committed.customers + added.customers, jobs: committed.jobs + added.jobs };
    const operational = group.some(write => write.collection === 'jobs' && !write.patch.recordType), fences = [];
    for (const rootId of new Set(group.map(write => write.patch.customerAccountOwnerJobId).filter(Boolean))) {
      if (group.some(write => write.id === rootId)) continue;
      const root = roots.get(rootId);
      if (root && !root.revision) {
        // An imported root committed in an earlier batch must still be a root.
        const saved = await store.read('jobs', rootId).catch(() => null);
        if (!saved?.revision || saved.customerId !== root.customerId || saved.recordType || saved.type !== 'job' || saved.customerAccountOwnerJobId && saved.customerAccountOwnerJobId !== rootId) return stop('jobber_import_hub_changed', hubChanged());
        root.revision = saved.revision;
      }
      if (!root?.revision) return stop('jobber_import_hub_changed', hubChanged());
      fences.push({ collection: 'jobs', id: rootId, revision: root.revision, verify: true });
    }
    const writes = [...group.map(({ collection, id, patch }) => ({ collection, id, patch })), ...fences,
      ...(added.customers ? [{ collection: 'customerIdentityState', id: 'revision', revision: guardRevision, patch: { updatedAt: now, lastRequestId: batchId } }] : []),
      ...(operational ? [{ collection: 'dispatchState', id: 'revision', revision: dispatchRevision, patch: { updatedAt: now, lastRequestId: batchId } }] : []),
      { collection: 'jobberImport', id: runId, revision: receipt.revision, patch: { committedBatches: [...(receipt.committedBatches || []), entry], committed: next, lastBatchId: batchId, updatedAt: now } }];
    try { await store.commit(writes); }
    catch (error) {
      // A lost response may still have committed; the receipt is the proof.
      const saved = await store.read('jobberImport', runId).catch(() => null);
      if (saved?.lastBatchId !== batchId) return stop(error.code === 'dispatch_revision_conflict' ? 'jobber_import_hub_changed' : 'jobber_import_interrupted', error.code === 'dispatch_revision_conflict'
        ? hubChanged(true)
        : 'The import stopped before finishing. Run it again; records already imported are skipped and the receipt lists every committed batch.');
    }
    receipt = await store.read('jobberImport', runId);
    if (receipt?.lastBatchId !== batchId) return stop('jobber_import_receipt_changed', 'The import receipt changed unexpectedly. Stop and review jobberImport/' + runId + '.');
    const identity = added.customers ? await store.read('customerIdentityState', 'revision') : null, dispatch = operational ? await store.read('dispatchState', 'revision') : null;
    if (added.customers && identity?.lastRequestId !== batchId || operational && dispatch?.lastRequestId !== batchId) { Object.assign(committed, next); batches.push(entry); return stop('jobber_import_hub_changed', hubChanged()); }
    if (added.customers) guardRevision = identity.revision;
    if (operational) dispatchRevision = dispatch.revision;
    Object.assign(committed, next); batches.push(entry);
  }
  try { await store.commit([{ collection: 'jobberImport', id: runId, revision: receipt.revision, patch: { status: 'completed', finishedAt: now, updatedAt: now } }]); }
  catch { return summary({ warnings: [...plan.report.warnings, { code: 'receipt_not_finalized', receipt: `jobberImport/${runId}` }] }); }
  return summary({});
}

export function parseArgs(argv) {
  const options = { source: 'csv', files: {}, mapping: '', resolutions: '', historySince: '', report: '', apply: false, expectFingerprint: '', expectPlan: '', reviewedReport: '', allowLargeJobsCollection: false, help: false };
  const FILES = { '--clients': 'clients', '--visits': 'visits', '--invoices': 'invoices', '--recurring': 'recurring' };
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const [arg, inline] = /^--[a-z-]+=/.test(argv[i]) ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    const value = () => { const next = inline ?? argv[++i]; if (!next || inline === undefined && next.startsWith('--')) throw new Error('Unknown or incomplete argument: ' + arg); return next; };
    if (arg === '--apply' && inline === undefined) options.apply = true;
    else if (arg === '--dry-run' && inline === undefined) dryRun = true;
    else if (arg === '--allow-large-jobs-collection' && inline === undefined) options.allowLargeJobsCollection = true;
    else if ((arg === '--help' || arg === '-h') && inline === undefined) options.help = true;
    else if (arg === '--source') options.source = value();
    else if (FILES[arg]) options.files[FILES[arg]] = [...(options.files[FILES[arg]] || []), value()];
    else if (arg === '--mapping') options.mapping = value();
    else if (arg === '--resolutions') options.resolutions = value();
    else if (arg === '--history-since') options.historySince = value();
    else if (arg === '--report') options.report = value();
    else if (arg === '--expect-fingerprint') options.expectFingerprint = value();
    else if (arg === '--expect-plan') options.expectPlan = value();
    else if (arg === '--reviewed-report') options.reviewedReport = value();
    else throw new Error('Unknown or incomplete argument: ' + argv[i]);
  }
  if (options.apply && dryRun) throw new Error('Choose either --dry-run or --apply.');
  if (!['csv','graphql'].includes(options.source)) throw new Error('--source must be csv or graphql.');
  if (options.source === 'csv' && !options.files.clients && !options.help) throw new Error('The Jobber client export is required: --clients <file.csv>.');
  if (options.source === 'graphql' && (Object.keys(options.files).length || options.mapping)) throw new Error('CSV files and --mapping cannot be combined with --source=graphql.');
  if (options.historySince && !validDate(options.historySince)) throw new Error('Use YYYY-MM-DD for --history-since.');
  if (options.expectFingerprint && (!options.apply || !/^[a-f0-9]{64}$/.test(options.expectFingerprint))) throw new Error('--expect-fingerprint takes the 64-character sourceFingerprint and is only used with --apply.');
  if (options.expectPlan && (!options.apply || !/^[a-f0-9]{64}$/.test(options.expectPlan))) throw new Error('--expect-plan takes the 64-character planFingerprint and is only used with --apply.');
  if (options.reviewedReport && !options.apply) throw new Error('--reviewed-report is only used with --apply.');
  return options;
}

const USAGE = 'Usage: node scripts/jobber-import.mjs --clients clients.csv [--clients part2.csv] [--visits visits.csv] [--invoices invoices.csv] [--recurring recurring.csv] [--mapping map.json] [--resolutions resolutions.json] [--history-since YYYY-MM-DD] [--report out.json] [--dry-run|--apply --expect-fingerprint <sha256> --expect-plan <sha256> [--reviewed-report dry-run.json]] [--allow-large-jobs-collection]\n       node scripts/jobber-import.mjs --source=graphql [same options without CSV files]\nDry run is the default and writes nothing. See docs/JOBBER-CUTOVER.md.';
async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw fail('file_invalid', `The ${label} file could not be read as JSON.`); }
}

/** Creates the report as a new 0600 file and renames it over the target, so a
 * report that already exists with a looser mode never keeps that mode. */
export async function writeReportFile(path, text) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
  try { await chmod(temp, 0o600); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => null); throw error; }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message + '\n' + USAGE); process.exitCode = 2; return; }
  if (options.help) { console.error(USAGE); return; }
  const env = { FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '' };
  if (!firebaseServiceAccountConfigured(env)) { console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required (the dry run reads Hub customers and jobs).'); process.exitCode = 2; return; }
  let source, resolutions = {}, reviewedPlan = null;
  try {
    resolutions = options.resolutions ? normalizeResolutions(await readJson(options.resolutions, 'resolutions')) : {};
    if (options.reviewedReport) {
      const reviewed = await readJson(options.reviewedReport, 'reviewed report');
      if (reviewed?.mode !== 'dry_run' || reviewed.planFingerprint !== options.expectPlan || !plain(reviewed.plan)) throw fail('reviewed_report_mismatch', 'The --reviewed-report must be the dry-run report whose planFingerprint is the --expect-plan value.');
      reviewedPlan = reviewed.plan;
    }
    if (options.source === 'graphql') source = await graphqlSource({ JOBBER_CLIENT_ID: process.env.JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET: process.env.JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN: process.env.JOBBER_REFRESH_TOKEN }, { historySince: options.historySince, version: process.env.JOBBER_GRAPHQL_VERSION || DEFAULT_GQL_VERSION });
    else {
      const files = {};
      for (const [kind, paths] of Object.entries(options.files)) { try { files[kind] = await Promise.all(paths.map(path => readFile(path, 'utf8'))); } catch { throw fail('file_invalid', `The ${kind} export could not be read.`); } }
      source = csvSource(files, options.mapping ? await readJson(options.mapping, 'mapping') : {});
    }
  } catch (error) { console.error(error.code ? error.message : 'The Jobber data could not be read. Nothing was written.'); process.exitCode = 1; return; }
  let report;
  try { report = await runJobberImport(dispatchStorage(env), { source, apply: options.apply, now: new Date().toISOString(), resolutions, historySince: options.historySince, expectFingerprint: options.expectFingerprint, expectPlanFingerprint: options.expectPlan, reviewedPlan, allowLargeJobsCollection: options.allowLargeJobsCollection }); }
  catch (error) { console.error(error.code ? error.message : 'The Hub records could not be read completely. Nothing was written.'); process.exitCode = 1; return; }
  const json = JSON.stringify(report, null, 2);
  if (options.report) {
    try { await writeReportFile(options.report, json + '\n'); }
    catch { console.error('The report file could not be written; the report follows on stdout.'); process.exitCode = 1; }
  }
  process.stdout.write(json + '\n');
  const { counts, writes, blocking } = report;
  console.error(`${report.mode === 'apply' ? (report.aborted ? 'APPLY STOPPED' : 'APPLIED') : 'DRY RUN (nothing written)'}: ${counts.clients.rows} Jobber clients (${counts.clients.matchedExisting} match Hub customers, ${counts.clients.create} new, ${counts.clients.alreadyImported} already imported, ${counts.clients.conflicts} conflicts); ${counts.visits.upcomingJobs} upcoming Jobber jobs for dispatch review, ${counts.visits.multiVisitJobs} of them with several upcoming visits (${counts.visits.visitsToAddByHand} more visits to add in Dispatch, see multiVisitJobs); ${counts.visits.history} history visits; ${counts.invoices.create} open invoices (${map.moneyLabel(counts.invoices.openBalanceCents)} open in Jobber); ${counts.recurring.proposals} recurring plans reported. Writes ${writes.committed.customers + writes.committed.jobs}/${writes.planned.customers + writes.planned.jobs}. Blocking items: ${blocking.length}.${report.aborted ? ' ' + report.aborted.message : ''}\nsourceFingerprint ${report.sourceFingerprint}\nplanFingerprint ${report.planFingerprint}${report.mode === 'dry_run' && !blocking.length ? `\nTo apply exactly this: add --apply --expect-fingerprint ${report.sourceFingerprint} --expect-plan ${report.planFingerprint}${options.report ? ` --reviewed-report ${options.report}` : ''}` : ''}`);
  if (report.aborted) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
