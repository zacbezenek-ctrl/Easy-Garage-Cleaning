/** FUN-32 Jobber coexistence guard check. READ-ONLY toward Jobber and HighLevel:
 * it lists every stray created in Jobber after the cutover day (requests, jobs
 * and invoices created on or after it, visits on or after it, payments entered
 * on or after it, imported Hub balances that Jobber has since settled) and every
 * HighLevel contact or opportunity the Jobber app created on or after it, each
 * matched to a Hub customer, and prints a PII-masked report. The cutover day is
 * `jobber.cutoverDate` in functions/_data/funnel-definitions.data.json.
 *
 *   node scripts/jobber-guard.mjs                     check; writes nothing
 *   node scripts/jobber-guard.mjs --since 2026-10-05  preview another cutover day (never saved)
 *   node scripts/jobber-guard.mjs --without-ghl       skip HighLevel (recorded as skipped)
 *   node scripts/jobber-guard.mjs --report out.json   also write the report (mode 0600)
 *   node scripts/jobber-guard.mjs --save              save a complete check as jobberGuard/latest,
 *                                                     which the EGC_JOBBER_GUARD_* switches use
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON (reads Hub customers and imported
 * Jobber rows), JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET and JOBBER_REFRESH_TOKEN
 * (the /api/jobber-auth app with read access to requests, jobs, visits, invoices
 * and payments), and HIGHLEVEL_API_KEY with HIGHLEVEL_LOCATION_ID unless
 * --without-ghl. JOBBER_GRAPHQL_VERSION overrides the API version. See
 * docs/JOBBER-CUTOVER.md. */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { firebaseServiceAccountConfigured } from '../functions/_lib/firebase-service-account.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { validDate } from '../functions/_lib/dispatch-time.js';
import { localInstant } from '../functions/_lib/operations-portal-records.js';
import { funnelDefinitions } from '../functions/_lib/funnel-definitions.js';
import { DEFAULT_JOBBER_GRAPHQL_VERSION } from '../functions/_lib/jobber-graphql.js';
import { jobberCutover, runJobberGuardCheck, saveJobberGuardState } from '../functions/_lib/jobber-guard.js';
import { writeReportFile } from './jobber-import.mjs';

const USAGE = 'Usage: node scripts/jobber-guard.mjs [--since YYYY-MM-DD] [--without-ghl] [--report out.json] [--save]\nA check is read-only toward Jobber and HighLevel. --save stores a complete check for the EGC_JOBBER_GUARD_* switches; a --since preview is never saved. See docs/JOBBER-CUTOVER.md.';
const fail = (code, message) => Object.assign(new Error(message), { code: 'jobber_guard_' + code });

export function parseArgs(argv) {
  const options = { since: '', ghl: true, report: '', save: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index], value = () => { const next = argv[++index]; if (!next || next.startsWith('--')) throw fail('usage', `${arg} needs a value.`); return next; };
    if (arg === '--since') options.since = value();
    else if (arg === '--report') options.report = value();
    else if (arg === '--without-ghl') options.ghl = false;
    else if (arg === '--save') options.save = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw fail('usage', `Unknown option ${arg}.`);
  }
  if (options.since && !validDate(options.since)) throw fail('usage', 'Use YYYY-MM-DD for --since.');
  if (options.since && options.save) throw fail('usage', '--since previews another cutover day and cannot be combined with --save.');
  return options;
}

const summaryLine = (report, saved) => `${report.coverage.complete ? 'JOBBER GUARD CHECK' : 'JOBBER GUARD CHECK (INCOMPLETE)'}: cutover ${report.cutoverDate}; ${report.counts.findings} strays (${report.counts.open} open, ${report.counts.holding} can hold Hub actions for ${report.counts.holdingCustomers} customers, ${report.counts.unmatched} not matched to a Hub customer). Sources: ${Object.entries(report.coverage.sources).map(([name, status]) => `${name} ${status}`).join(', ')}. ${saved ? `Saved as jobberGuard/latest (run ${report.runId}).` : 'Nothing was written.'}`;

/** The CLI with injectable dependencies; resolves to the exit code. */
export async function runCli(argv, { env = process.env, storage = dispatchStorage, now = () => new Date(), fetcher = fetch, sleep, runId = randomUUID, definitions = funnelDefinitions(), writeReport = writeReportFile, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  let options;
  try { options = parseArgs(argv); } catch (error) { stderr(`${error.message}\n${USAGE}\n`); return 2; }
  if (options.help) { stderr(USAGE + '\n'); return 0; }
  const hubEnv = { FIREBASE_SERVICE_ACCOUNT_JSON: env.FIREBASE_SERVICE_ACCOUNT_JSON || '', ...(env.FIREBASE_API_KEY ? { FIREBASE_API_KEY: env.FIREBASE_API_KEY } : {}) };
  if (!firebaseServiceAccountConfigured(hubEnv)) { stderr('FIREBASE_SERVICE_ACCOUNT_JSON is required (the check matches strays to Hub customers).\n'); return 2; }
  const since = options.since ? { date: options.since, at: localInstant(options.since, '00:00') } : jobberCutover(definitions);
  if (!since.date) { stderr('No Jobber cutover day is set. Set jobber.cutoverDate in functions/_data/funnel-definitions.data.json and run node scripts/funnel-definitions.mjs --write, or preview a day with --since YYYY-MM-DD.\n'); return 2; }
  const providers = { JOBBER_CLIENT_ID: env.JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET: env.JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN: env.JOBBER_REFRESH_TOKEN, HIGHLEVEL_API_KEY: env.HIGHLEVEL_API_KEY || env.GHL_API_KEY, HIGHLEVEL_LOCATION_ID: env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID };
  const store = storage(hubEnv);
  let report;
  try { report = await runJobberGuardCheck({ env: providers, store, now: now().toISOString(), since, runId: runId(), definitions, ghl: options.ghl, fetcher, sleep, version: env.JOBBER_GRAPHQL_VERSION || DEFAULT_JOBBER_GRAPHQL_VERSION }); }
  catch (error) { stderr(`${error.code ? error.message : 'The Hub records could not be read completely.'} Nothing was written.\n`); return 1; }
  // A source that could not be read fails the run even without --save; a deliberate skip does not.
  let code = Object.values(report.coverage.sources).every(status => ['complete', 'skipped'].includes(status)) ? 0 : 1, saved = false;
  if (options.save) {
    try { await saveJobberGuardState(store, report, { definitions }); saved = true; }
    catch (error) { stderr(`${error.code ? error.message : 'The check could not be saved. The last saved check stays in force; retry.'}\n`); code = 1; }
  }
  const json = JSON.stringify(report, null, 2);
  if (options.report) {
    try { await writeReport(options.report, json + '\n'); }
    catch { stderr('The report file could not be written; the report follows on stdout.\n'); code = 1; }
  }
  stdout(json + '\n');
  stderr(summaryLine(report, saved) + '\n');
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2));
