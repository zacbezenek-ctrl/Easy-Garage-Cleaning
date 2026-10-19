/** Garage catalog and owner pricing settings API (P2-03). Session cookie; owner and manager business sessions
 * read, only the owner writes. CATALOG_QUOTES_ENABLED=true turns it on; unset, GET answers {ok,enabled:false}
 * with no catalog data and every POST is 404. Storage and rules: functions/_lib/catalog-store.js.
 * GET /api/catalog?view=status => {ok,enabled}
 * GET /api/catalog[?view=full] => {ok,authority,enabled,asOf,view:'summary'|'full',catalog,publication:{source:
 *   'seed'|'firestore',version,revision,basedOnVersion,sha256,itemCount,publishedAt,publishedBy},settings:{revision,
 *   source:'defaults'|'firestore',settingsVersion,readyForCustomers,updatedAt,updatedBy,values},prices:{[itemId]:
 *   {quotable,stale,quantity:1,unitCents,totalCents,customerSupplied,durationMinutes,split}|{quotable:false,reason,
 *   stale}},stale:{afterDays,count,items},viewer}
 *   The default catalog leaves out auditLog and each item's sources, verificationNote, auditStatus and
 *   auditActions; view=full returns the complete document to edit and publish. prices are catalogLine() for one
 *   unit with the settings in force; readyForCustomers false means internal estimates only. stale lists items
 *   never verified or verified more than staleAfterDays (90) Denver days ago. Managers see the cost split (owner
 *   and managers are the only readers today). A 503 catalog_storage_invalid names details.currentVersion, the
 *   basedOnVersion to publish over to repair it (null when the published pointer itself is unreadable).
 * POST {action:'settings.update',requestId,expectedRevision,settings,confirmCustomerUse?} (owner)
 *   expectedRevision is settings.revision (null while the defaults are in use); settings is the complete
 *   validatePricingSettings() document whose settingsVersion was never saved before (409
 *   catalog_settings_version_used); turning mustSetBeforeCustomerUse off also needs confirmCustomerUse:true.
 *   => {ok,requestId,replayed,settings:{...,current}}; current false (revision null) means a newer save
 *   replaced this one before it could be read back.
 * POST {action:'catalog.publish',requestId,basedOnVersion,catalog} (owner)
 *   basedOnVersion is publication.version (null only to replace an unreadable pointer); catalog is a complete
 *   validateCatalog() document with a later catalogVersion, stored immutably. => {ok,requestId,replayed,publication}
 * POST {action:'menu.approve',requestId,expectedRevision,menuVersion,settingsVersion,approve:[{id,unitCents}],revoke:[id],goodsInstallationIncluded?,laborRatePerManHourCents?}
 *   (owner; only with EGC_QUOTE_BUILDER_ENABLED=true, which also allows it while CATALOG_QUOTES_ENABLED is off)
 *   bulk-approves draft pricing-menu prices for the quote builder; expectedRevision is the approvals revision from
 *   GET /api/quote-draft?view=builder (internal.approvalsRevision). goodsInstallationIncluded (boolean) answers the
 *   builder's installation question for quotes saved before the Labor line existed, the only way to answer it while
 *   catalog pricing is off. laborRatePerManHourCents (whole cents, 100 to 100000) sets the labor rate per man-hour of
 *   every builder quote's Labor line ($53.00 until the owner changes it, owner decision of 2026-10-19). Each counts as one
 *   change.
 *   => {ok,requestId,replayed,approvals:{revision,current,count,items,goodsInstallationIncluded?,laborRatePerManHourCents?}}
 * With EGC_QUOTE_BUILDER_ENABLED a fresh menu.approve or settings.update also releases the signed jobs held for the
 *   owner's price approval that it now covers (walkthrough-handoff.js releaseHeldHandoffs: their estimate and deposit
 *   request go to the customer) and adds heldJobs {released:[jobId], waiting, more} or {status:'deferred'} when they
 *   could not be checked (they stay held; the approval itself is saved either way).
 * Keep the same requestId and body when retrying; the same requestId with another body is a 409.
 * Errors: {ok:false,code,error,details?}; 400 validation, 401, 403, 404 disabled, 409 revision/version/
 * idempotency, 413, 415, 503 retry the same request. */
import { getHubSession } from '../_lib/hub-session.js';
import { catalogOverview, catalogQuotesEnabled, catalogStorage, mutateCatalog, quoteBuilderEnabled, readCompositeState, requireCatalogOwner, requireCatalogViewer } from '../_lib/catalog-store.js';
import { releaseHeldHandoffs } from '../_lib/walkthrough-handoff.js';
import { heldReleaseStorage } from '../_lib/handoff-price-holds.js';

// A published catalog is about 0.55 MB of JSON; settings documents are small.
const LIMIT = 1000000, SETTINGS_LIMIT = 32000;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' } });
const tooLarge = () => reply(413, { ok:false, code:'catalog_request_too_large', error:'The catalog request is too large.' });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (/^catalog_/.test(error?.code || '')) return reply(error.status || 503, { ok:false, code:error.code, error:error.message, ...(error.details ? { details:error.details } : {}) });
  return reply(503, { ok:false, code:'catalog_unavailable', error:'The catalog could not complete this request. Keep your changes and retry the same request; it will not be saved twice.' });
}

// EGC_QUOTE_BUILDER_ENABLED: the held signed jobs an owner's approval or settings save now covers are released after
// it is saved (heldJobs); a failure there never undoes the save.
async function releaseHeld(held, env, actor, at, input, pricing) {
  try { return await releaseHeldHandoffs(held(env), actor, at, { env, source: input.action, requestId: input.requestId, compositeState: pricing }); }
  catch { return { status: 'deferred' }; }
}

// cache: this isolate's verified catalogs (catalog-store.js); tests pass a new Map for a cold isolate.
// held (tests): the jobs storage releaseHeldHandoffs reads and commits through (handoff-price-holds.js heldReleaseStorage).
export function catalogHandlers({ session = getHubSession, storage = catalogStorage, now = () => new Date(), cache, compositeState, held = heldReleaseStorage } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireCatalogViewer(actor);
        const params = new URL(request.url).searchParams, names = [...params.keys()];
        if (new Set(names).size !== names.length || names.some(name => name !== 'view') || params.has('view') && !['status','full'].includes(params.get('view'))) return reply(400, { ok:false, code:'catalog_request_invalid', error:'The only catalog option is view=status or view=full.' });
        // quoteBuilder tells the Hub screen to load the pricing-menu approvals; absent (flag off) the answer is unchanged.
        const builder = quoteBuilderEnabled(env) && params.get('view') !== 'status' ? { quoteBuilder: true } : {};
        if (!catalogQuotesEnabled(env)) return reply(200, { ok:true, authority:'employee_hub', enabled:false, ...builder });
        if (params.get('view') === 'status') return reply(200, { ok:true, authority:'employee_hub', enabled:true });
        return reply(200, { ...await catalogOverview(storage(env), actor, now(), { full: params.get('view') === 'full', cache }), ...builder });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok:false, code:'catalog_origin_forbidden', error:'Open the catalog in the Employee Hub to save changes.' });
      try {
        const actor = await session(request, env); requireCatalogOwner(actor);
        const builder = quoteBuilderEnabled(env), disabled = () => reply(404, { ok:false, code:'catalog_disabled', error:'Catalog pricing is not enabled.' });
        if (!catalogQuotesEnabled(env) && !builder) return disabled();
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok:false, code:'catalog_json_required', error:'Catalog changes must be submitted as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return tooLarge();
        const raw = await request.text(), bytes = new TextEncoder().encode(raw).byteLength;
        if (bytes > LIMIT) return tooLarge();
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok:false, code:'catalog_json_invalid', error:'The catalog request was incomplete. Reload and try again.' }); }
        // The quote builder flag alone opens only the pricing-menu approval, never settings or publishing.
        if (!catalogQuotesEnabled(env) && input?.action !== 'menu.approve') return disabled();
        if ((input?.action === 'settings.update' || builder && input?.action === 'menu.approve') && bytes > SETTINGS_LIMIT) return tooLarge();
        const at = now().toISOString(), result = await mutateCatalog(storage(env), actor, input, at, builder ? { menuApprovals: true, ...(compositeState ? { compositeState } : {}) } : {});
        if (builder && result?.replayed === false && ['menu.approve', 'settings.update'].includes(input.action)) result.heldJobs = await releaseHeld(held, env, actor, at, input, () => (compositeState || readCompositeState)(storage(env)));
        return reply(200, result);
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = catalogHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
