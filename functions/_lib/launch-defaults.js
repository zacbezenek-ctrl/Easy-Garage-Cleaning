/* Launch defaults (owner decision, 2026-10-18): the switches the owner asked to have on without setting them in
   Cloudflare. functions/_middleware.js fills them into the Pages env before any handler reads it, so every reader
   (crewAutoAssignEnabled, jobMaterialsEnabled, quoteBuilderEnabled, knockJobBridgeEnabled, staffDirectoryEnabled,
   staffRolePermissionsEnabled, walkthroughVisitEnabled, walkthroughNotesEnabled, winterSaleEnabled, moneyApiEnabled,
   changeOrderBillingEnabled) sees exactly "true".
   A variable set in Cloudflare always wins: setting one to "false" (or anything but "true") turns that feature off
   again, with a retried deployment. Handlers called directly (tests, scripts) see their env unchanged.

   Staff roles (owner decision, 2026-10-20): EGC_STAFF_DIRECTORY_ENABLED and EGC_STAFF_ROLE_PERMISSIONS are on so
   the owner can give a crew member the Sales role in the Staff directory, which opens the Walkthrough for them. The
   directory reads un-migrated records (pay falls back to the legacy hourly rate, roles to the account's role) and
   EGC_STAFF_ROLE_PERMISSIONS only acts on roles that are actually stored, so without the account backfill only the
   people whose roles the owner saves change; everyone else keeps the hard-coded checks.

   Left out on purpose, each needing the owner first:
   - EGC_STAFF_ROLE_ACCESS: Sales/Phone booking and full customer contact in Dispatch, stored managers' business access.
   - EGC_GHL_SCHEDULE_MIRROR and EGC_GHL_D2D_TAGS: the HighLevel workflow audit and the egc-worker drain switch.
   - EGC_DISPATCH_WINDOWED_READS: the customer search-key backfill.
   - MONEY_DOCUMENT_ENABLED, MONEY_UNIFIED_TOTALS and MONEY_INVOICE_STATE_ENABLED: change-order billing does not need
     them (customerMoneyState bills the saved change-order lines either way); each has its own go-live steps. */
export const LAUNCH_DEFAULTS = Object.freeze({
  EGC_JOB_MATERIALS: 'true',
  EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true',
  EGC_QUOTE_BUILDER_ENABLED: 'true',
  EGC_KNOCK_JOB_BRIDGE: 'true',
  EGC_STAFF_DIRECTORY_ENABLED: 'true',
  EGC_STAFF_ROLE_PERMISSIONS: 'true',
  // Owner decision 2026-10-19: the iPad walkthrough recorder (Start / Finish / No-show) and its transcript, edited into
  // job notes the estimator confirms for the crew, on the website's own OpenAI key (the openaiapi secret).
  EGC_WALKTHROUGH_VISIT_ENABLED: 'true',
  EGC_WALKTHROUGH_NOTES: 'true',
  // Owner decisions 2026-10-21: the Early-bird winter sale (up to $400 off any job, accepted by Jan 31, work Dec 1 to
  // Feb 28, the amount capped by the owner's margin floor on the Job actuals cost settings; no sale applies until the
  // owner enters that floor and the cost settings; functions/_lib/winter-sale.js).
  EGC_WINTER_SALE: 'true',
  // Owner decision 2026-10-30: change-order billing on by default. A priced crew decision the customer approves in the
  // portal is billed as a change-order line (functions/_lib/change-orders.js), which needs the Hub money API too: the
  // Hub's estimate, approval, deposit, payment and invoice buttons then save on the server (/api/money), and a manager
  // stops billing a change with its change_order.void. Approvals saved before this are billed by
  // scripts/backfill-change-orders.mjs (docs/OWNER-GO-LIVE-CHECKLIST.md).
  MONEY_API_ENABLED: 'true',
  CHANGE_ORDER_BILLING_ENABLED: 'true',
});

/** Fills each unset launch default into env, in place; a value already present (any value) is kept. An env that
 *  cannot be written leaves the switch as it was (off), never failing the request. */
export function applyLaunchDefaults(env) {
  if (!env || typeof env !== 'object') return env;
  for (const [name, value] of Object.entries(LAUNCH_DEFAULTS)) {
    if (env[name] !== undefined) continue;
    try { env[name] = value; } catch { /* a read-only env keeps the switch off */ }
  }
  return env;
}
