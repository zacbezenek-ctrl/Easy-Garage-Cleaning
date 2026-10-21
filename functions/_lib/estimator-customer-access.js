import { can } from './staff-roles.js';
import { assignmentKey, createJobAssignmentAccess } from './job-assignment.js';
import { namesAgree } from './knock-bridge.js';

/*
 * What an estimator (a quote author who is neither a dispatcher nor a booker) may learn about a stored customer.
 * Owners, managers and dispatchers (dispatch.write) and bookers (schedule.book, who read the whole schedule) are
 * unrestricted. An estimator sees a customer's stored contact details (name, phone, email, address, CRM link) only for
 * a customer they created themselves (customers.createdBy), the customer of a walkthrough assigned to them or started
 * by them, or the customer of a job the office assigned to them. Every other customer reaches them masked, and by an
 * opaque reference instead of its record id (customer-resolve hands out `cref_<resolve request>`, bound to the
 * estimator's own resolve receipt), so a phone number alone never reveals or attaches someone else's record.
 * Attaching such a customer to a quote also needs the typed name to agree with the stored one (the Knock bridge's
 * namesAgree rule); otherwise nothing is saved and the office attaches it.
 * A reference does not expire: only the estimator who resolved it can use it, and they can resolve again at any time,
 * so an expiry would only strand a quote saved offline.
 */
const REF = /^cref_[a-f0-9]{32}$/;
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const phone = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const email = value => String(value || '').trim().toLowerCase();
const same = (left, right) => Boolean(assignmentKey(left)) && assignmentKey(left) === assignmentKey(right);

export const customerRef = requestId => 'cref_' + String(requestId).toLowerCase().replace(/-/g, '');
export const isCustomerRef = value => typeof value === 'string' && REF.test(value);
const receiptOf = ref => ref.slice(5).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** access: requireQuoteAuthor's (or requireCustomerResolver's) answer for this actor. */
export const restrictedAuthor = (actor, access, env = {}) => access?.author === true && access.dispatcher !== true && !can(actor, 'schedule.book', env);

// The masked customer an estimator may see: which record (its reference), and contact hints only.
const maskPhone = value => { const digits = phone(value); return digits ? '(•••) •••-' + digits.slice(-4) : ''; };
const maskEmail = value => { const [name, domain] = email(value).split('@'); return name && domain ? name[0] + '•••@' + domain : ''; };
export const maskedCustomer = (row, id) => ({ id: id || '', revision: row.revision, phone: maskPhone(row.phone), email: maskEmail(row.email), contactDetails: 'masked' });

async function walkthroughVisible(source, actor, env) {
  if (!plain(source) || source.type !== 'walkthrough' || source.recordType) return false;
  return same(source.walkthroughVisit?.startedBy, actor.user) || await createJobAssignmentAccess(env, actor).assigned(source);
}

/** Whether an estimator sees this customer in full: their own customer, their walkthrough's or their assigned job's. */
export async function fullCustomerAccess(customer, actor, { env = {}, source = null, job = null } = {}) {
  if (!plain(customer) || !customer.id) return false;
  if (same(customer.createdBy, actor.user)) return true;
  if (source && source.customerId === customer.id && await walkthroughVisible(source, actor, env)) return true;
  return Boolean(job) && job.customerId === customer.id && !job.recordType && await createJobAssignmentAccess(env, actor).assigned(job);
}

/** The reference this estimator saved a job with (authorCustomerRef), or ''. */
export const jobRef = (job, actor) => plain(job?.authorCustomerRef) && isCustomerRef(job.authorCustomerRef.ref) && same(job.authorCustomerRef.by, actor.user) ? job.authorCustomerRef.ref : '';
export const refPatch = (pick, actor) => pick?.ref ? { authorCustomerRef: { ref: pick.ref, by: actor.user } } : {};

/**
 * The stored customer a quote save names (value: a record id or a cref_ reference) and what the author may see of it:
 * {customer, restricted, full, ref}. A restricted author names a customer they may not see only by their own
 * reference, and only under a name that agrees with the stored one. The caller still checks the record's revision and
 * that the phone, email or CRM link match (identityMatches).
 */
export async function authorCustomer(store, actor, access, value, { env = {}, clientName = '', source = null, job = null, prefix = '' } = {}) {
  let id = value, ref = '';
  if (isCustomerRef(value)) {
    const receipt = await store.read('customerOperations', receiptOf(value));
    if (!plain(receipt) || !same(receipt.actorId, actor.user) || typeof receipt.customerId !== 'string' || !receipt.customerId) throw fail(prefix + 'customer_ref_invalid', 'This customer selection belongs to another sign-in. Find the customer again before saving.', 403);
    id = receipt.customerId; ref = value;
  }
  const customer = await store.read('customers', id);
  if (!restrictedAuthor(actor, access, env)) return { customer, restricted: false, full: true, ref };
  const full = await fullCustomerAccess(customer, actor, { env, source, job });
  if (!full && !ref) throw fail(prefix + 'customer_ref_required', 'Find this customer again before saving the quote.', 403);
  if (!full && plain(customer) && !namesAgree(customer.name, clientName)) throw fail(prefix + 'customer_review_required', 'This phone or email belongs to an existing customer under a different name. Nothing was saved. Ask the office to attach this quote to the right customer.', 409);
  return { customer, restricted: true, full, ref };
}

/** What an author is shown of a saved job's customer: {restricted, full, ref}, read from the stored records. */
export async function jobCustomerAccess(store, actor, access, job, { env = {} } = {}) {
  if (!restrictedAuthor(actor, access, env)) return { restricted: false, full: true, ref: '' };
  const ref = jobRef(job, actor);
  const customer = job?.customerId ? await store.read('customers', job.customerId) : null;
  const source = job?.sourceWalkthroughId ? await store.read('jobs', job.sourceWalkthroughId) : null;
  return { restricted: true, full: await fullCustomerAccess(customer, actor, { env, source, job }), ref };
}

/** Whether an author may open a saved job's quote: always, unless restricted; then a draft they started or saved, a
 * job they created, or one whose customer they may see. Another estimator's draft stays with them and the office. */
export async function authorOpensJob(store, actor, access, job, env = {}) {
  if (!restrictedAuthor(actor, access, env)) return true;
  if (same(job?.quoteDraft?.createdBy, actor.user) || same(job?.createdBy, actor.user) || jobRef(job, actor)) return true;
  return (await jobCustomerAccess(store, actor, access, job, { env })).full;
}

/** The customer id an author is shown: the reference they used, else the record id when they may see it, else ''. */
export const shownCustomerId = (id, seen) => seen.ref || (seen.full ? id || '' : '');
