/** Signed jobs held for the owner's prices (EGC_QUOTE_BUILDER_ENABLED; walkthrough-handoff.js pricesPendingApproval).
 * A held job is released when the owner saves an approval that covers it (POST /api/catalog menu.approve). A price the
 * pricing-menu file itself approves (a new menu version, e.g. the truck loads approved on 2026-10-21) has no such save,
 * so the Hub asks here: Catalog & pricing and the Hub home post {action:'sweep'} when an owner or manager opens them,
 * and the sweeps after each menu version release every held job the menu now covers. A run stops cleanly at its
 * subrequest budget (HELD_SUBREQUEST_BUDGET) and records where it stopped (pricingMenuApprovals/heldRelease sweepVersion,
 * sweepAfter), so the next open continues from there; the menu version itself (menuVersion) is recorded only after a
 * pass that checked every held job with no failed release (sweepRetry: a release that did not commit restarts the pass
 * on the next open). A failed run records nothing and is tried again on the next open; a release commits under the
 * job's revision, so two sweeps never release one job twice. The owner's "Release held jobs" button runs the same
 * release on demand, from the same place.
 * Session cookie: owner and managers sweep; only the owner releases on demand.
 * POST {action:'sweep'}   => {ok, enabled, ran, menuVersion, released:[jobId], held, more}
 * POST {action:'release'} => the same, always run (owner).
 *   ran: a release ran (false: this version was swept already; only counted).
 *   held: the jobs still waiting (for prices the owner has not approved, a walkthrough-priced quote the owner releases
 *   from the job, a closed job); more: there are more held jobs than were counted or checked. enabled:false with the
 *   builder off (nothing else). Customers and HighLevel get nothing new here: a released job asks for its portal invitation
 *   exactly as an approval save does (releasePatch).
 * READ-BUDGET: a sweep with nothing to do reads the marker and the held job names (one query per 100); a run reads the
 *   owner's two pricing documents and each held job once.
 * Errors: {ok:false, code, error}; 400, 401, 403, 415, 503 retry. */
import { getHubSession } from '../_lib/hub-session.js';
import { MENU_APPROVALS, catalogStorage, quoteBuilderEnabled, readCompositeState, requireCatalogOwner, requireCatalogViewer } from '../_lib/catalog-store.js';
import { bundledPricingMenu } from '../_lib/composite-quote.js';
import { HELD_SUBREQUEST_BUDGET, releaseAllHeldHandoffs } from '../_lib/walkthrough-handoff.js';
import { countHeldJobs, heldReleaseStorage } from '../_lib/handoff-price-holds.js';

export const HELD_RELEASE_MARKER = 'heldRelease';
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

// storage: the catalog documents (the marker and the owner's pricing); held: the jobs (handoff-price-holds.js).
// budget: the storage calls one release run may make (the route's own marker and pricing reads come on top).
export function heldJobsHandlers({ session = getHubSession, storage = catalogStorage, held = heldReleaseStorage, compositeState, menuVersion = () => bundledPricingMenu().menuVersion, budget = HELD_SUBREQUEST_BUDGET, now = () => new Date() } = {}) {
  return {
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'held_jobs_origin_forbidden', error: 'Open the Employee Hub to release held jobs.' });
      try {
        const actor = await session(request, env);
        requireCatalogViewer(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'held_jobs_json_required', error: 'Send the request as JSON.' });
        let input; try { input = JSON.parse(await request.text()); } catch { input = null; }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'action') || !['sweep', 'release'].includes(input.action)) return reply(400, { ok: false, code: 'held_jobs_request_invalid', error: 'Choose sweep or release.' });
        if (input.action === 'release') requireCatalogOwner(actor);
        if (!quoteBuilderEnabled(env)) return reply(200, { ok: true, enabled: false });
        const catalog = storage(env), jobs = held(env), version = menuVersion(), marker = await catalog.read(MENU_APPROVALS, HELD_RELEASE_MARKER);
        const resume = marker?.sweepVersion === version ? marker : null, after = resume && typeof resume.sweepAfter === 'string' ? resume.sweepAfter : '';
        if (input.action === 'sweep' && marker?.menuVersion === version && !resume) {
          const { count, more } = await countHeldJobs(jobs);
          return reply(200, { ok: true, enabled: true, ran: false, menuVersion: version, released: [], held: count, more });
        }
        const at = now().toISOString();
        const run = await releaseAllHeldHandoffs(jobs, actor, at, { env, after, budget, source: input.action === 'sweep' ? 'menu.version' : 'held.release', compositeState: compositeState || (() => readCompositeState(catalog)) });
        const retry = Boolean(resume?.sweepRetry) || run.failed.length > 0;
        // Done: every held job was checked and every release committed. Otherwise the next open continues (or restarts the
        // pass after a failed release). A sweep that wrote the marker first wins and this one changes nothing.
        const patch = run.complete && !retry ? { menuVersion: version, sweepVersion: '', sweepAfter: '', sweepRetry: false, releasedAt: at, releasedBy: actor.user, released: run.released.length }
          : { sweepVersion: version, sweepAfter: run.complete ? '' : run.next, sweepRetry: !run.complete && retry, updatedAt: at };
        try { await catalog.commit([{ collection: MENU_APPROVALS, id: HELD_RELEASE_MARKER, revision: marker?.revision || null, patch }]); }
        catch (error) { if (error?.code !== 'catalog_revision_conflict') throw error; }
        // A pass that began mid-way counts the jobs before it too; a stopped run says there are more.
        const still = run.complete && after ? (await countHeldJobs(jobs)).count : run.waiting;
        return reply(200, { ok: true, enabled: true, ran: true, menuVersion: version, released: run.released, held: still, more: !run.complete });
      } catch (error) {
        if (/^catalog_(sign_in_required|forbidden|owner_required)$/.test(error?.code || '')) return reply(error.status, { ok: false, code: error.code, error: error.message });
        return reply(503, { ok: false, code: 'held_jobs_unavailable', error: 'The held jobs could not be checked. They stay held; try again in a moment.' });
      }
    },
  };
}

const handlers = heldJobsHandlers();
export const onRequestPost = handlers.post;
