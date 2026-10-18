/* Launch defaults (owner decision, 2026-10-18): the switches the owner asked to have on without setting them in
   Cloudflare. functions/_middleware.js fills them into the Pages env before any handler reads it, so every reader
   (crewAutoAssignEnabled, jobMaterialsEnabled, quoteBuilderEnabled, knockJobBridgeEnabled) sees exactly "true".
   A variable set in Cloudflare always wins: setting one to "false" (or anything but "true") turns that feature off
   again, with a retried deployment. Handlers called directly (tests, scripts) see their env unchanged.

   Left out on purpose, each needing the owner first:
   - EGC_STAFF_DIRECTORY_ENABLED and EGC_STAFF_ROLE_ACCESS: the two staff vault migrations, then roles.
   - EGC_GHL_SCHEDULE_MIRROR and EGC_GHL_D2D_TAGS: the HighLevel workflow audit and the egc-worker drain switch.
   - EGC_DISPATCH_WINDOWED_READS: the customer search-key backfill. */
export const LAUNCH_DEFAULTS = Object.freeze({
  EGC_JOB_MATERIALS: 'true',
  EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true',
  EGC_QUOTE_BUILDER_ENABLED: 'true',
  EGC_KNOCK_JOB_BRIDGE: 'true',
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
