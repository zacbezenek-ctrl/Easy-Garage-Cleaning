// Synthetic FUN-32 fixtures: a fake Jobber GraphQL API, a fake HighLevel
// search API and a Hub snapshot. No live provider or real clock is used; any
// other host fails the test.
import assert from 'node:assert/strict';
import { funnelDefinitions } from '../../functions/_lib/funnel-definitions.js';
import { JOBBER_GRAPHQL_URL, JOBBER_TOKEN_URL } from '../../functions/_lib/jobber-graphql.js';

export const CUTOVER = '2026-10-01'; // midnight in Denver is 2026-10-01T06:00:00.000Z
export const CUTOVER_AT = '2026-10-01T06:00:00.000Z';
export const NOW = '2026-10-07T18:00:00.000Z';
export const JOBBER_ENV = Object.freeze({ JOBBER_CLIENT_ID: 'synthetic-client', JOBBER_CLIENT_SECRET: 'synthetic-jobber-secret', JOBBER_REFRESH_TOKEN: 'synthetic-refresh-token' });
export const GHL_ENV = Object.freeze({ HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1' });

/** The shipped definitions with a cutover day set (the shipped value is null). */
export function definitionsWith(cutoverDate = CUTOVER, change = () => {}) {
  const copy = structuredClone(funnelDefinitions());
  copy.jobber.cutoverDate = cutoverDate;
  change(copy);
  return copy;
}

export const gid = (type, id) => Buffer.from(`gid://Jobber/${type}/${id}`).toString('base64');
const client = (id, name, { phone, email, reminders, invoiceFollowUps } = {}) => ({ id: gid('Client', id), name, phones: phone ? [{ number: phone }] : [], emails: email ? [{ address: email }] : [], ...(reminders === undefined ? {} : { receivesReminders: reminders }), ...(invoiceFollowUps === undefined ? {} : { receivesInvoiceFollowUps: invoiceFollowUps }) });
export const CLIENTS = {
  alpha: client(1001, 'Synthetic Alpha', { phone: '(970) 555-0101', email: 'alpha@example.invalid', reminders: true, invoiceFollowUps: true }),
  bravo: client(1002, 'Synthetic Bravo', { phone: '970-555-0102', invoiceFollowUps: false }),
  charlie: client(1003, 'Synthetic Charlie', { email: 'charlie@example.invalid' }),
  delta: client(1004, 'Synthetic Delta', { phone: '970 555 0199', reminders: false }),
};

/** Jobber records around the cutover. */
export function jobberData() {
  const { alpha, bravo, charlie, delta } = CLIENTS;
  return {
    requests: [
      { id: gid('Request', 501), title: 'Garage walkthrough', createdAt: '2026-10-02T15:00:00Z', requestStatus: 'new', client: delta },
      { id: gid('Request', 502), title: 'Before the cutover', createdAt: '2026-10-01T05:59:00Z', requestStatus: 'new', client: alpha },
      { id: gid('Request', 503), title: 'Archived', createdAt: '2026-10-03T15:00:00Z', requestStatus: 'archived', client: alpha },
      { id: gid('Request', 504), title: 'Shared email', createdAt: '2026-10-03T16:00:00Z', requestStatus: 'upcoming', client: charlie },
    ],
    jobs: [
      { id: gid('Job', 7101), jobNumber: 2101, title: 'Cleanout', createdAt: '2026-10-02T16:00:00Z', jobStatus: 'upcoming', client: delta },
      { id: gid('Job', 7102), jobNumber: 2102, title: 'Reset', createdAt: '2026-10-04T16:00:00Z', jobStatus: 'active', client: alpha },
    ],
    visits: [
      { id: gid('Visit', 8001), startAt: '2026-10-13T15:00:00Z', createdAt: '2026-09-01T12:00:00Z', isComplete: false, job: { jobNumber: 2001 }, client: bravo },
      { id: gid('Visit', 8002), startAt: '2026-10-06T15:00:00Z', createdAt: '2026-09-01T12:00:00Z', isComplete: false, job: { jobNumber: 2001 }, client: bravo },
      { id: gid('Visit', 8003), startAt: '2026-10-20T15:00:00Z', createdAt: '2026-09-01T12:00:00Z', isComplete: false, job: { jobNumber: 2001 }, client: bravo },
      { id: gid('Visit', 8004), startAt: '2026-10-01T05:00:00Z', createdAt: '2026-09-01T12:00:00Z', isComplete: false, job: { jobNumber: 2001 }, client: bravo },
      { id: gid('Visit', 8005), startAt: '2026-10-08T15:00:00Z', createdAt: '2026-09-01T12:00:00Z', isComplete: true, job: { jobNumber: 2002 }, client: alpha },
    ],
    invoices: [
      { id: gid('Invoice', 9101), invoiceNumber: '3101', invoiceStatus: 'awaiting_payment', createdAt: '2026-10-05T16:00:00Z', updatedAt: '2026-10-05T16:00:00Z', amounts: { total: 300, invoiceBalance: 300 }, client: bravo },
      { id: gid('Invoice', 9102), invoiceNumber: '3102', invoiceStatus: 'paid', createdAt: '2026-10-05T17:00:00Z', updatedAt: '2026-10-06T16:00:00Z', amounts: { total: 120, invoiceBalance: 0 }, client: alpha },
      { id: gid('Invoice', 9001), invoiceNumber: '3001', invoiceStatus: 'paid', createdAt: '2026-08-01T16:00:00Z', updatedAt: '2026-10-03T16:00:00Z', amounts: { total: 500, invoiceBalance: 0 }, client: alpha },
      { id: gid('Invoice', 9002), invoiceNumber: '3002', invoiceStatus: 'awaiting_payment', createdAt: '2026-08-02T16:00:00Z', updatedAt: '2026-10-03T16:00:00Z', amounts: { total: 200, invoiceBalance: 200 }, client: bravo },
      { id: gid('Invoice', 9003), invoiceNumber: '3003', invoiceStatus: 'paid', createdAt: '2026-08-03T16:00:00Z', updatedAt: '2026-10-03T16:00:00Z', amounts: { total: 90, invoiceBalance: 0 }, client: delta },
    ],
    payments: [{ id: gid('CashPaymentRecord', 6001), amount: 500, entryDate: '2026-10-03T16:00:00Z', invoice: { invoiceNumber: '3001' }, client: alpha }],
  };
}

export function ghlData() {
  return {
    contacts: [
      { id: 'contact-new', dateAdded: '2026-10-05T10:00:00.000Z', source: 'Jobber', firstName: 'Synthetic', lastName: 'Echo', phone: '+19705550105', email: 'echo@example.invalid', tags: [] },
      { id: 'contact-web', dateAdded: '2026-10-04T10:00:00.000Z', source: 'Website form', tags: ['web-lead'], phone: '+19705550106' },
      { id: 'contact-tag', dateAdded: '2026-10-03T10:00:00.000Z', source: '', tags: ['JOBBER'], firstName: 'Synthetic', lastName: 'Foxtrot' },
      { id: 'contact-old', dateAdded: '2026-09-20T10:00:00.000Z', source: 'Jobber', tags: [] },
      { id: 'contact-older', dateAdded: '2026-09-10T10:00:00.000Z', source: 'Jobber', tags: [] },
    ],
    opportunities: [
      { id: 'opp-1', createdAt: '2026-10-06T10:00:00.000Z', source: 'Jobber', contactId: 'contact-echo', contact: { id: 'contact-echo', name: 'Synthetic Echo', phone: '+19705550105', tags: [] } },
      { id: 'opp-2', createdAt: '2026-10-02T10:00:00.000Z', source: 'Website', contactId: 'contact-web', contact: { id: 'contact-web', name: 'Synthetic Web', tags: [] } },
      { id: 'opp-3', createdAt: '2026-09-25T10:00:00.000Z', source: 'Jobber', contactId: 'contact-old' },
    ],
  };
}

/** Hub customers and imported Jobber rows. */
export function hubData() {
  return {
    customers: [
      { id: 'jobber_client_1001', name: 'Synthetic Alpha', phone: '9705550101', email: 'alpha@example.invalid' },
      { id: 'cust-bravo', name: 'Synthetic Bravo', phone: '970-555-0102' },
      { id: 'cust-c1', name: 'Synthetic Charlie', email: 'Charlie@example.invalid' },
      { id: 'cust-c2', name: 'Synthetic Charlie Two', email: 'charlie@example.invalid' },
      { id: 'cust-echo', name: 'Synthetic Echo', phone: '9705550105', highlevelContactId: 'contact-echo' },
      { id: 'secure_vault', phone: '9705550199' },
    ],
    jobs: [
      { id: 'jobber_invoice_3001', type: 'job', customerId: 'jobber_client_1001', status: 'invoiced', pipelineStatus: 'invoiced', invoice: { status: 'issued' }, jobber: { jobberClientId: '1001', invoiceNumber: '3001', balanceCents: 50000 } },
      { id: 'jobber_invoice_3002', type: 'job', customerId: 'cust-bravo', status: 'invoiced', pipelineStatus: 'invoiced', invoice: { status: 'issued' }, jobber: { jobberClientId: '1002', invoiceNumber: '3002', balanceCents: 20000 } },
      { id: 'jobber_job_2001', type: 'job', customerId: 'cust-bravo', status: 'unscheduled', jobber: { jobberClientId: '1002' } },
      { id: 'job-plain', type: 'job', customerId: 'cust-bravo', status: 'scheduled' },
    ],
  };
}

/** Routes Jobber and HighLevel calls to the fakes. `pages` splits each Jobber connection into pages of that size. */
export function providers({ jobber = jobberData(), ghl = ghlData(), pageSize = 2, ghlStatus = 200, jobberFails = null, grant = { access_token: 'synthetic-access-token' } } = {}) {
  const calls = [];
  const fields = { EgcGuardRequests: ['requests', 'requests'], EgcGuardJobs: ['jobs', 'jobs'], EgcGuardVisits: ['visits', 'visits'], EgcGuardInvoices: ['invoices', 'invoices'], EgcGuardPayments: ['paymentRecords', 'payments'] };
  async function fetcher(input, init = {}) {
    const url = String(input);
    if (url === JOBBER_TOKEN_URL) { calls.push({ kind: 'jobber_token', body: String(init.body) }); return Response.json(grant, { status: grant.access_token ? 200 : 401 }); }
    if (url === JOBBER_GRAPHQL_URL) {
      const body = JSON.parse(init.body), name = /^\s*query (\w+)/.exec(body.query)?.[1];
      assert.ok(fields[name], `unexpected Jobber document ${body.query.slice(0, 40)}`);
      assert.equal(init.headers.Authorization, 'Bearer synthetic-access-token');
      calls.push({ kind: 'jobber', name, variables: body.variables, query: body.query });
      if (jobberFails === name) return Response.json({ errors: [{ message: 'synthetic-provider-detail' }] }, { status: 200 });
      const [field, key] = fields[name], rows = jobber[key], start = body.variables.after ? Number(body.variables.after) : 0, page = rows.slice(start, start + pageSize), next = start + pageSize < rows.length;
      return Response.json({ data: { [field]: { nodes: page, pageInfo: { hasNextPage: next, endCursor: next ? String(start + pageSize) : null } } } });
    }
    if (url.startsWith('https://services.leadconnectorhq.com/')) {
      const parsed = new URL(url);
      calls.push({ kind: 'ghl', path: parsed.pathname, method: init.method, version: init.headers.Version, body: init.body ? JSON.parse(init.body) : null, query: Object.fromEntries(parsed.searchParams) });
      if (ghlStatus !== 200) return Response.json({ message: 'synthetic-ghl-detail' }, { status: ghlStatus });
      if (parsed.pathname === '/contacts/search') { const { page, pageLimit } = JSON.parse(init.body); return Response.json({ contacts: ghl.contacts.slice((page - 1) * pageLimit, page * pageLimit) }); }
      if (parsed.pathname === '/opportunities/search') { const page = Number(parsed.searchParams.get('page')), limit = Number(parsed.searchParams.get('limit')); return Response.json({ opportunities: ghl.opportunities.slice((page - 1) * limit, page * limit) }); }
    }
    assert.fail(`unexpected host ${url}`);
  }
  return { fetcher, calls };
}

/** A Hub store for the check: complete customer and masked job scans plus revisioned read/commit. */
export function hubStore(hub = hubData(), rows = {}) {
  const docs = new Map(Object.entries(rows).map(([key, value]) => [key, { ...structuredClone(value), revision: `${key}-r0` }]));
  const commits = [];
  let n = 0;
  return {
    docs, commits,
    customers: async () => structuredClone(hub.customers),
    async jobRecords(fields) { assert.ok(fields.includes('jobber.jobberClientId') && fields.includes('jobber.balanceCents'), 'the job scan is masked to the guard fields'); return structuredClone(hub.jobs); },
    read: async (collection, id) => { const row = docs.get(`${collection}/${id}`); return row ? { ...structuredClone(row), id } : null; },
    async commit(writes) {
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = docs.get(key);
        assert.ok(!keys.has(key), 'one write per document per commit'); keys.add(key);
        if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), revision: `r${++n}` }); }
    },
  };
}
