import { haulingOnly } from './pickup-minimum.js';
import { priceCompositeQuote } from './composite-quote.js';
import { quoteBuilderEnabled } from './catalog-store.js';

/*
 * OFFICE (owner request 2026-10-30, "an office role to book photo-only removal"): what an office-role session may do
 * through /api/quote-draft (quote-permissions.js officeQuoteSession marks it). The office user prices a quote from the
 * photos the customer sent, with no walkthrough, from the owner's pricing menu, and only removal: truck loads,
 * special-handling items and access charges (HAULING_GROUPS, the D-JUNK groups). The server prices every line as for any
 * builder quote (composite-quote.js): a junk-only quote is $1,000 per truck with no Labor line, special items or access
 * without a truck keep their Labor line, a hauling-only quote under $250 gets the Minimum pickup line, and an unapproved
 * menu price can be saved but never sent. A new quote takes the sent-quote terms (SENT_25_75: 25% when the customer
 * approves it, 75% on the job day), as every quote saved through /api/quote-draft does.
 * Each check throws 403 quote_draft_office_removal_only (or 404 when the builder is off) and changes nothing:
 *   - previews and saves: the builder selection prices to removal lines only; no catalog or hand-typed lines;
 *   - saves: no source walkthrough; a revision only of a quote the office may work on (below);
 *   - reads, send previews and sends: only a quote with no walkthrough whose builder lines are all removal lines.
 * The library checks the rest (quote author, customer identity, revisions, approvals, the minimum pickup, the send).
 */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 403, code = 'quote_draft_office_removal_only') => Object.assign(new Error(message), { code, status });
export const OFFICE_REMOVAL_ONLY = 'The office role quotes removal only: truck loads, special-handling items and access charges from the pricing menu, with no walkthrough. Ask a manager or an estimator for anything else.';
const REFUSED_ACTIONS = new Set(['catalog_preview', 'sync_capture']);

/** A builder quote's itemized lines (priceCompositeQuote breakdown.lines) are removal lines only. */
export const removalOnly = lines => haulingOnly(lines);

/** A stored job an office user may read, revise or send: builder-priced removal only, and no walkthrough. */
export function officeQuoteJob(job) {
  return plain(job) && !job.sourceWalkthroughId && plain(job.quoteDraft) && !job.quoteDraft.sourceWalkthroughId && !plain(job.quoteDraft.catalogPricing)
    && plain(job.quoteDraft.compositePricing) && removalOnly(job.quoteDraft.breakdown?.lines);
}

/** Throws unless the priced selection (priceCompositeQuote's result) is removal only. */
export function requireRemovalPricing(priced) {
  if (!removalOnly(priced?.breakdown?.lines) || priced.compositePricing?.shelving?.length || priced.compositePricing?.storage?.length) throw fail(OFFICE_REMOVAL_ONLY);
  return priced;
}

const jobOf = async (store, jobId) => typeof jobId === 'string' && jobId ? store.read('jobs', jobId) : null;
async function requireOfficeJob(store, jobId) {
  const job = await jobOf(store, jobId);
  // A missing job is the library's to answer (404 quote_draft_job_not_found); one that exists must be the office's kind.
  if (job && !officeQuoteJob(job)) throw fail(OFFICE_REMOVAL_ONLY);
}

/**
 * The office check for one /api/quote-draft request, before the library runs it. action: the POST action, or 'read'
 * for GET ?jobId. Returns the pricing state a save already read, so the save prices against the same menu.
 */
export async function checkOfficeQuote(action, input, { store, env, compositeState }) {
  if (REFUSED_ACTIONS.has(action)) throw fail(OFFICE_REMOVAL_ONLY);
  if (action === 'read' || action === 'send_preview' || action === 'send') return void await requireOfficeJob(store, input?.jobId);
  if (action !== 'save') return undefined;
  if (!quoteBuilderEnabled(env)) throw fail('The quote builder is turned off, so photo quotes are not available. Ask the owner.', 404, 'quote_draft_office_builder_disabled');
  const draft = plain(input?.draft) ? input.draft : null;
  if (input?.sourceWalkthroughId || input?.sourceRevision || !draft || draft.catalog_pricing !== undefined || !plain(draft.composite_pricing)) throw fail(OFFICE_REMOVAL_ONLY);
  if (input.jobId) await requireOfficeJob(store, input.jobId);
  const state = await compositeState(env);
  requireRemovalPricing(priceCompositeQuote(state, draft.composite_pricing, { complete: true }));
  return state;
}
