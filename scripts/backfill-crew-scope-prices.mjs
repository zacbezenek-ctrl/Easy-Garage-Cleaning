/** Crew scope price backfill (FIX-CREW-PRICE-LEAK). DRY RUN BY DEFAULT: nothing is written without `--apply`.
 *
 * Before the fix, a signed walkthrough saved its priced internal brief ("HAZARDS: Pest waste (+$200)") as the job's
 * crew-visible scope (operationalScope.text). /api/field-jobs and /api/crew-jobs now strip amounts from a signed
 * brief when they project it, and new handoffs save a crew brief without prices; this script removes the prices from
 * the stored copies so every other reader (Dispatch, a recurring visit copied from the job) sees the same clean text.
 *
 * The dry run lists the jobs whose operationalScope.text or jobInstructions contain a currency amount. By default only
 * signed walkthrough briefs are rewritten (a job the handoff saved, or a visit whose scope is a copy of that brief). A
 * job whose scope staff wrote in Dispatch is listed in staffWritten and left as it is, because its amounts may be
 * instructions the crew need ("Collect the $300 balance by check"): review that list, then either edit those scopes in
 * Dispatch or rerun with `--include-staff`, which removes their amounts too. The priced brief stays in the
 * manager-only internalNotes, and the audit entry keeps the text as it was (for a staff scope, the only other copy).
 *
 * `--apply` writes only the stripped text: each job write carries its Firestore updateTime precondition (a job saved
 * meanwhile is skipped and reported, never overwritten), and each commit adds a hub_audit entry per job and one
 * dispatchOperations/<requestId> receipt for the batch in the same commit. Re-running after an apply finds no signed
 * brief to clean (and, after an `--include-staff` apply, no staff scope with an amount either).
 *
 *   node scripts/backfill-crew-scope-prices.mjs                 # dry run
 *   node scripts/backfill-crew-scope-prices.mjs --apply         # write
 *   node scripts/backfill-crew-scope-prices.mjs --include-staff [--apply]   # staff-written scopes as well
 *   node scripts/backfill-crew-scope-prices.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report holds job IDs and field names only (no prices or customer text). */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {auditWrite} from '../functions/_lib/hub-audit.js';
import {hasCrewMoney,signedBriefJob,stripCrewMoney,stripCrewMoneyDeep} from '../functions/_lib/crew-money.js';

const ACTOR='crew-scope-price-backfill';
// The whole maps load: a rewrite keeps every other key of operationalScope and jobInstructions as it is.
export const SCOPE_FIELDS=Object.freeze(['type','recordType','handoffVersion','jobInstructions','operationalScope']);
const fail=(code,message)=>Object.assign(new Error(message),{code:'crew_scope_backfill_'+code});
const byId=(a,b)=>String(a.id).localeCompare(String(b.id));
// Private rows in jobs (locks, receipts, encrypted Hub records) are never job briefs.
const privateRow=row=>typeof row?.id!=='string'||/^(_egc_|secure_)/.test(row.id)||Boolean(row.recordType);
const priced=value=>typeof value==='string'?hasCrewMoney(value):Array.isArray(value)?value.some(priced):value&&typeof value==='object'?Object.values(value).some(priced):false;

/** Pure plan from one complete jobs snapshot. */
export function planCrewScopeBackfill(jobs,{includeStaff=false}={}) {
  if(!Array.isArray(jobs))throw fail('input_invalid','A complete job list is required.');
  const report={scanned:jobs.length,skippedRecords:0,clean:0,staffWritten:[]},writes=[];
  for(const job of jobs) {
    if(privateRow(job)){report.skippedRecords++;continue;}
    const scoped=typeof job.operationalScope?.text==='string'&&hasCrewMoney(job.operationalScope.text),instructed=priced(job.jobInstructions);
    const fields=[...(scoped?['operationalScope.text']:[]),...(instructed?['jobInstructions']:[])];
    if(!fields.length){report.clean++;continue;}
    const staff=!signedBriefJob(job);
    if(staff&&!includeStaff){report.staffWritten.push({id:job.id,fields});continue;}
    const before={},after={},patch={};
    if(scoped){patch.operationalScope={...job.operationalScope,text:stripCrewMoney(job.operationalScope.text)};before.operationalScopeText=job.operationalScope.text;after.operationalScopeText=patch.operationalScope.text;}
    if(instructed){patch.jobInstructions=stripCrewMoneyDeep(job.jobInstructions);before.jobInstructions=job.jobInstructions;after.jobInstructions=patch.jobInstructions;}
    writes.push({id:job.id,revision:job.revision,fields,...(staff?{staffWritten:true}:{}),patch,before,after});
  }
  writes.sort(byId);report.staffWritten.sort(byId);
  return {writes,report};
}

function batchWrites(group,{runId,now}) {
  const requestId=randomUUID().toLowerCase();
  const audits=group.map(row=>auditWrite({actor:{id:ACTOR,kind:'system'},via:'cron',action:'jobs.crew_scope.prices_removed',entity:{collection:'jobs',id:row.id},
    before:row.before,after:row.after,requestId,reason:row.staffWritten?'Removed amounts from a staff-written crew scope (FIX-CREW-PRICE-LEAK, --include-staff). The text as it was is kept in this entry.':'Removed quoted prices from the crew-visible walkthrough brief (FIX-CREW-PRICE-LEAK). The priced brief stays in internalNotes.',now}));
  return {requestId,writes:[...group.map(row=>({collection:'jobs',id:row.id,revision:row.revision,patch:row.patch})),...audits,
    {collection:'dispatchOperations',id:requestId,patch:{scope:'crew_scope_price_backfill',action:'crew_scope.backfill',actorId:ACTOR,requestId,runId,createdAt:now,
      targets:group.map(row=>({id:row.id,revision:row.revision,fields:row.fields,...(row.staffWritten?{staffWritten:true}:{})}))}}]};
}

export async function runCrewScopeBackfill(store,{apply=false,includeStaff=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=50}={}) {
  const plan=planCrewScopeBackfill(await store.jobRecords([...SCOPE_FIELDS]),{includeStaff});
  const committed=[],changed=[],receipts=[];
  const result=extra=>({mode:apply?'apply':'dry_run',includeStaff,runId,generatedAt:now,jobs:plan.report,
    preview:plan.writes.map(({id,fields,staffWritten})=>({id,fields,...(staffWritten?{staffWritten}:{})})),
    writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort(),receipts:[...receipts]},...extra});
  if(!apply)return result({});
  async function commit(group) {
    const {requestId,writes}=batchWrites(group,{runId,now});
    try{await store.commit(writes);}
    catch(error) {
      if(error.code==='dispatch_revision_conflict')return false;
      // A lost response may still have committed; the receipt is the proof.
      const receipt=await store.read('dispatchOperations',requestId).catch(()=>null);
      if(receipt?.runId!==runId)throw error;
    }
    committed.push(...group.map(row=>row.id));receipts.push(requestId);return true;
  }
  try {
    for(let start=0;start<plan.writes.length;start+=batchSize) {
      const batch=plan.writes.slice(start,start+batchSize);
      if(await commit(batch))continue;
      // One job saved meanwhile must not block the rest; a rerun picks it up.
      for(const row of batch)if(!await commit([row]))changed.push(row.id);
    }
  } catch(error) {
    return result({aborted:{code:error.code||'crew_scope_backfill_failed',message:'The backfill stopped before finishing. Rerun it; jobs already cleaned are skipped and their receipts are listed.'}});
  }
  return result({});
}

export function parseArgs(argv) {
  const options={apply:false,includeStaff:false,report:'',help:false};let dryRun=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--apply')options.apply=true;
    else if(arg==='--dry-run')dryRun=true;
    else if(arg==='--include-staff')options.includeStaff=true;
    else if(arg==='--report'&&argv[i+1]&&!argv[i+1].startsWith('--'))options.report=argv[++i];
    else if(arg==='--help'||arg==='-h')options.help=true;
    else throw new Error('Unknown or incomplete argument: '+arg);
  }
  if(options.apply&&dryRun)throw new Error('Choose either --dry-run or --apply.');
  return options;
}

async function main() {
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/backfill-crew-scope-prices.mjs [--dry-run|--apply] [--include-staff] [--report <file>]\nDry run is the default; --apply removes quoted prices from signed walkthrough briefs with updateTime preconditions, an audit entry per job and a receipt.\n--include-staff also removes amounts from staff-written Dispatch scopes (listed as staffWritten otherwise); review that list first.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runCrewScopeBackfill(dispatchStorage(env),{apply:options.apply,includeStaff:options.includeStaff,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {writes,jobs}=report;
  const staff=report.includeStaff?`${report.preview.filter(row=>row.staffWritten).length} of them staff-written scopes (--include-staff)`:`${jobs.staffWritten.length} staff-written scopes with amounts left as they are (review them, or rerun with --include-staff)`;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${writes.committed}/${writes.planned} crew scopes cleaned of quoted prices; ${staff}; ${writes.changedDuringRun.length} changed during the run.${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
