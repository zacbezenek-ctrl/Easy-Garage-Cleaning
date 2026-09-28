/** Job contact-key backfill (LEGACY-SEND). DRY RUN BY DEFAULT: scans jobs and
 * prints how many need the derived phoneE164/emailLower lookup keys, without
 * writing anything. `--apply` writes only those two keys (plus
 * contactKeysNormalizedAt) on operational jobs whose saved phone/email they do
 * not match yet, each fenced on that job's revision. Nothing else on a job changes.
 * The sales follow-up exit looks jobs up by these keys, so a job saved with an
 * unusual phone spelling ('970/555/0123', a number value, a trailing space) or a
 * differently cased email is still found as the same customer's job. Hub pages
 * and imports do not keep the keys current, so rerun it after a large import; a
 * rerun with nothing changed writes nothing.
 *
 *   node scripts/backfill-job-contact-keys.mjs                  # dry run
 *   node scripts/backfill-job-contact-keys.mjs --apply          # write
 *   node scripts/backfill-job-contact-keys.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report lists job IDs and counts,
 * never phone numbers or emails. Run it in a quiet window: a written job gets a
 * new revision, so a Hub editor open on that job is asked to refresh. */
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {customerIdentityFields,jobContactKeysPatch,operationalJob} from '../functions/_lib/customer-identity.js';
import {backfillStorage,parseArgs,writeReport} from './backfill-customer-identity.mjs';

const JOB_FIELDS=['type','recordType','phone','email','phoneE164','emailLower'];
const MAX_COMMIT_WRITES=450;
const present=value=>typeof value==='string'?Boolean(value.trim()):typeof value==='number';
const fail=(code,message)=>Object.assign(new Error(message),{code:'job_contact_keys_backfill_'+code});

/** Pure plan from one complete jobs snapshot: one revision-fenced key write per
 * operational job whose keys are missing or stale. Private and server rows are skipped. */
export function planJobContactKeys(jobs,now) {
  const writes=[],unusablePhone=[],unusableEmail=[];let operational=0;
  for(const row of jobs) {
    if(!operationalJob(row))continue;
    operational++;
    const fields=customerIdentityFields(row),patch=jobContactKeysPatch(row,now);
    if(present(row.phone)&&!fields.phoneE164)unusablePhone.push(row.id);
    if(present(row.email)&&!fields.emailLower)unusableEmail.push(row.id);
    if(patch)writes.push({collection:'jobs',id:row.id,revision:row.revision,patch});
  }
  return {writes:writes.sort((a,b)=>a.id.localeCompare(b.id)),report:{jobs:{scanned:jobs.length,operational,needsKeys:writes.length,unusablePhone:unusablePhone.sort(),unusableEmail:unusableEmail.sort()}}};
}

export async function runJobContactKeysBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=100}={}) {
  const jobs=await store.jobs(JOB_FIELDS);
  if(!Array.isArray(jobs))throw fail('storage_incomplete','The complete job records could not be verified.');
  const plan=planJobContactKeys(jobs,now),committed=[],changed=[];
  const summary=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,...plan.report,writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort()},...extra});
  if(!apply)return summary();
  const size=Math.max(1,Math.min(Math.trunc(batchSize)||1,MAX_COMMIT_WRITES));
  try {
    for(let start=0;start<plan.writes.length;start+=size) {
      const batch=plan.writes.slice(start,start+size);
      try{await store.commit(batch);committed.push(...batch.map(write=>write.id));continue;}
      catch(error){if(error.code!=='dispatch_revision_conflict')throw error;}
      // A job edited during the run skips only itself; a rerun picks it up.
      for(const write of batch) {
        try{await store.commit([write]);committed.push(write.id);}
        catch(error){if(error.code!=='dispatch_revision_conflict')throw error;changed.push(write.id);}
      }
    }
  } catch(error) {
    return summary({aborted:{code:error.code||'job_contact_keys_backfill_failed',message:'The backfill stopped before finishing. Rerun it: it reads every job again and writes only the keys still missing.'}});
  }
  return summary();
}

async function main() {
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/backfill-job-contact-keys.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply writes with revision preconditions.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runJobContactKeysBackfill(backfillStorage(env),{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report) {
    try{await writeReport(options.report,json);}
    catch{console.error('The report file could not be written privately, so it was not saved.');process.exitCode=1;}
  }
  process.stdout.write(json+'\n');
  const w=report.writes;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${w.committed}/${w.planned} jobs given phone/email lookup keys; ${report.jobs.unusablePhone.length} saved phones and ${report.jobs.unusableEmail.length} saved emails could not be normalized.${w.changedDuringRun.length?` ${w.changedDuringRun.length} jobs changed during the run; rerun to pick them up.`:''}${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
