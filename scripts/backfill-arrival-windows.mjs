/** Arrival window backfill (P1-04). DRY RUN BY DEFAULT: scans jobs and prints the
 * derived `arrivalWindow` label that each future scheduled job lacking one would
 * get, without writing anything.
 *
 * Dispatch materializes the derived default label when a job is saved, so turning
 * on EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED changes a job's customer portal
 * text only when that job is next saved (and turning it off never removes saved
 * labels). Run this after enabling the flag to label the remaining future jobs at
 * once, so every upcoming visit shows the same kind of window.
 *
 * `--apply` writes ONLY the missing `arrivalWindow` label. Each job write carries
 * its Firestore updateTime precondition (a job saved meanwhile is skipped and
 * reported, never overwritten), and each commit atomically creates a receipt in
 * dispatchOperations/<requestId> listing every job it labeled with before/after
 * values. Explicit windows that no longer contain the start time, past, cancelled,
 * unscheduled, blocked and private records are never written. Re-running after
 * an apply is a no-op.
 *
 *   node scripts/backfill-arrival-windows.mjs                 # dry run
 *   node scripts/backfill-arrival-windows.mjs --apply         # write
 *   node scripts/backfill-arrival-windows.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. Uses the same
 * EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED / _MINUTES values as the deployed
 * Pages Functions; --apply refuses to write unless the flag is 'true'. The report
 * holds job IDs, dates, times and labels only (no customer details). */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {arrivalWindowFields,arrivalWindowMinutes,arrivalWindowProblem} from '../functions/_lib/dispatch-arrival.js';
import {localInstant} from '../functions/_lib/operations-portal-records.js';

const ACTOR='arrival-window-backfill';
const TERMINAL=new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const CUSTOMER_TYPES=new Set(['job','walkthrough','cleanout','reorg']);
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(id)&&!/^(secure_|_egc_)/.test(id);
const state=job=>job.pipelineStatus||job.status||'unscheduled';
const fail=(code,message)=>Object.assign(new Error(message),{code:'arrival_window_backfill_'+code});
const byId=(a,b)=>String(a.id||a).localeCompare(String(b.id||b));

/** Pure plan from one complete jobs snapshot. `settings` are the dispatch arrival
 * settings; the preview always derives with their window length so the owner can
 * review it before enabling the flag. */
export function planArrivalWindowBackfill(jobs,settings,now) {
  const nowMs=Date.parse(now);
  if(!Array.isArray(jobs)||!Number.isFinite(nowMs))throw fail('input_invalid','A complete job list and a valid current time are required.');
  const derive={defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:arrivalWindowMinutes(settings)};
  const report={scanned:jobs.length,skippedRecords:0,inactive:0,unscheduled:0,past:0,alreadyLabeled:0,differentLabel:[],noDerivableWindow:[],needsDispatchReview:[]};
  const writes=[];
  for(const job of jobs) {
    if(!job||!safeId(job.id)||job.recordType||!CUSTOMER_TYPES.has(job.type)){report.skippedRecords++;continue;}
    if(TERMINAL.has(state(job))){report.inactive++;continue;}
    const startAt=localInstant(job.date,job.time);
    if(!startAt){report.unscheduled++;continue;}
    if(Date.parse(startAt)<=nowMs){report.past++;continue;}
    const problem=arrivalWindowProblem(job);
    // Dispatch clears such a window with a warning on the next save; a human
    // should choose the replacement there, so the backfill leaves it alone.
    if(problem){report.needsDispatchReview.push({id:job.id,reason:problem});continue;}
    const label=arrivalWindowFields(job,derive).arrivalWindow;
    if(job.arrivalWindow){report.alreadyLabeled++;if(label&&job.arrivalWindow!==label)report.differentLabel.push(job.id);continue;}
    if(!label){report.noDerivableWindow.push(job.id);continue;}
    const brief=job.jobInstructions&&typeof job.jobInstructions==='object'?job.jobInstructions.arrivalWindow:'';
    writes.push({id:job.id,revision:job.revision,date:job.date,time:job.time,before:job.arrivalWindow??null,arrivalWindow:label,explicit:Boolean(job.arrivalWindowStart&&job.arrivalWindowEnd),supersedesBriefText:Boolean(brief)});
  }
  writes.sort(byId);
  for(const key of ['differentLabel','noDerivableWindow','needsDispatchReview'])report[key].sort(byId);
  return {writes,report};
}

function receiptWrite(group,{runId,now,minutes}) {
  const requestId=randomUUID().toLowerCase();
  return {requestId,write:{collection:'dispatchOperations',id:requestId,patch:{scope:'arrival_window_backfill',action:'arrival_window.backfill',actorId:ACTOR,requestId,runId,createdAt:now,defaultArrivalWindowMinutes:minutes,
    targets:group.map(row=>({id:row.id,revision:row.revision,before:{arrivalWindow:row.before},after:{arrivalWindow:row.arrivalWindow}}))}}};
}

export async function runArrivalWindowBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=100}={}) {
  const settings=store.settings?await store.settings():{};
  const enabled=settings?.defaultArrivalWindowEnabled===true,minutes=arrivalWindowMinutes(settings);
  const plan=planArrivalWindowBackfill(await store.jobs(),settings,now);
  const committed=[],changed=[],receipts=[];
  const summary=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,settings:{enabled,minutes},jobs:plan.report,
    preview:plan.writes.map(({id,date,time,arrivalWindow,explicit,supersedesBriefText})=>({id,date,time,arrivalWindow,explicit,supersedesBriefText})),
    writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort(),receipts:[...receipts]},...extra});
  if(!apply)return summary({});
  if(!enabled)return summary({aborted:{code:'arrival_window_backfill_disabled',message:'EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED is not true, so dispatch would not save these labels. Enable it in production first; nothing was written.'}});
  async function commit(group) {
    const {requestId,write}=receiptWrite(group,{runId,now,minutes});
    try{await store.commit([...group.map(row=>({collection:'jobs',id:row.id,revision:row.revision,patch:{arrivalWindow:row.arrivalWindow}})),write]);}
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
    return summary({aborted:{code:error.code||'arrival_window_backfill_failed',message:'The backfill stopped before finishing. Rerun it; jobs already labeled are skipped and their receipts are listed.'}});
  }
  return summary({});
}

export function parseArgs(argv) {
  const options={apply:false,report:'',help:false};let dryRun=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--apply')options.apply=true;
    else if(arg==='--dry-run')dryRun=true;
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
  if(options.help){console.error('Usage: node scripts/backfill-arrival-windows.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply writes missing labels with updateTime preconditions and a receipt.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||'',EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED:process.env.EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED||'',EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES:process.env.EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runArrivalWindowBackfill(dispatchStorage(env),{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {settings,writes,jobs}=report;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${writes.committed}/${writes.planned} future jobs labeled with a ${settings.minutes}-minute default window (flag ${settings.enabled?'on':'OFF'}); ${jobs.needsDispatchReview.length} need review in Dispatch, ${writes.changedDuringRun.length} changed during the run.${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
