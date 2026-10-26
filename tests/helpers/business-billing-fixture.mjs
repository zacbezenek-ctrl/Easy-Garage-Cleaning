import { createBusinessHandler } from '../../functions/_lib/business-hub-service.js';
import { businessHubModules } from '../../functions/_lib/business-hub-modules.js';
import { customerMoneyState, customerPaymentNeedsReview } from '../../functions/_lib/customer-payments.js';
import { uid } from '../../functions/_lib/business-hub-core.js';

// Same atomic precondition semantics as the existing business-hub fixtures; no external hosts.
export function billingFixture({ canCreateJob } = {}) {
  const records = new Map(); let version = 0, clock = Date.UTC(2026, 9, 24, 12);
  let staff = { user: 'synthetic.owner', role: 'owner', businessAccess: true };
  const store = {
    async read(collection, id) { return structuredClone(records.get(`${collection}/${id}`) || null); },
    async commit(writes) {
      for (const w of writes) {
        const old = records.get(`${w.collection}/${w.id}`);
        if (w.version ? old?._version !== w.version : old) throw Object.assign(new Error('Conflict'), { status: 409, publicMessage: 'Conflict' });
      }
      for (const w of writes) records.set(`${w.collection}/${w.id}`, { ...(w.patch ? records.get(`${w.collection}/${w.id}`) : {}), ...structuredClone(w.data), id: w.id, _version: String(++version) });
    },
    async jobs(ids) { return new Map((await Promise.all(ids.map(id => store.read('jobs', id)))).filter(Boolean).map(job => [job.id, job])); },
    async list() { return { accounts: [], next: '' }; },
  };
  const handler = createBusinessHandler({ store, getStaff: async () => staff, finance: customerMoneyState, needsReview: customerPaymentNeedsReview,
    projectCookie: async () => '', clearProjectCookie: () => '', now: () => clock, ...businessHubModules, ...(canCreateJob ? { canCreateJob } : {}) });
  const call = async (input, cookie = '', query = '') => {
    const res = await handler(new Request(`https://example.invalid/api/business-hub${query}`, { method: input ? 'POST' : 'GET',
      headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json', 'X-EGC-Business': '1', Cookie: cookie },
      ...(input ? { body: JSON.stringify(input) } : {}) }));
    return { status: res.status, data: await res.json(), cookie: res.headers.get('Set-Cookie')?.split(';')[0] };
  };
  const download = (requestId, cookie = '', query = '') => {
    const url = new URL(`https://example.invalid/api/business-hub${query}`);
    url.searchParams.set('export', 'billing_review'); url.searchParams.set('review', requestId);
    return handler(new Request(url, { headers: { Cookie: cookie } }));
  };
  async function account() {
    const created = await call({ action: 'create_account', company: 'Synthetic Company', name: 'Synthetic Admin', email: 'admin@example.invalid' }, '', '?staff=1');
    const signed = await call({ action: 'redeem', invite: created.data.invite });
    return { id: created.data.accountId, cookie: signed.cookie, query: '?staff=1&account=' + created.data.accountId };
  }
  async function member(a, role, propertyIds) {
    const invited = await call({ action: 'invite_member', name: 'Synthetic Member', email: `${uid()}@example.invalid`, role, ...(propertyIds ? { propertyIds } : {}) }, a.cookie);
    const signed = await call({ action: 'redeem', invite: invited.data.invite });
    return { id: invited.data.invite.split('.')[1], cookie: signed.cookie };
  }
  async function project(a, jobId, amount = 120.11) {
    const property = await call({ action: 'save_property', name: jobId, address: '1 Example Way' }, a.cookie);
    const propertyId = property.data.propertyId;
    await store.commit([{ collection: 'jobs', id: jobId, data: { type: 'job', status: 'completed', estimate: { amount, status: 'accepted' },
      invoice: { number: 'INV-' + jobId, status: 'issued', amount, amountCents: Math.round(amount * 100), issuedAt: '2026-10-23T12:00:00Z' } } }]);
    await call({ action: 'link_project', propertyId, jobId, sharingAuthorized: true }, '', a.query);
    return propertyId;
  }
  async function change(collection, id, values) {
    const old = await store.read(collection, id); await store.commit([{ collection, id, data: { ...old, ...values }, version: old._version }]);
  }
  return { store, records, call, download, account, member, project, change, setStaff: value => staff = value, advance: ms => clock += ms };
}
