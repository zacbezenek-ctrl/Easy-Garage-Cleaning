/** Job labor privacy backfill and its rollback (JOB-COST-PRIVACY). DRY RUN BY DEFAULT: nothing is written without
 * `--apply`.
 *
 * Every business user can read jobs/{id}, and the Hub streams each job to every manager's browser, so a labor figure
 * on a job (on a one-person job, labor over hours is that employee's rate) is readable by any manager. Labor dollars
 * now live in the server-only jobLaborCosts/{jobId} record, which the finance board and /api/money read first and
 * which only a viewer who sees labor dollars gets. Run the backfill with EGC_STAFF_PAY_OWNER_ONLY on (unset); with it
 * set to "false" every save writes the figure back onto the job anyway.
 *
 * Backfill (default): scans jobs and reports which carry a labor dollar copy (costs.labor, costs.laborCents or the
 * older top-level laborCost). `--apply` moves each copy: when the job has no private record yet, the copy becomes one
 * (source legacy_job) and the copy's fields are deleted from the job; when a private record already exists it wins and
 * the stale copy is only deleted. A blank costs.labor (the Hub's "unknown" marker) is never a figure: it hides an older
 * laborCost, so such a job moves as a blank record and both fields go, and on its own it stays (it reveals nothing).
 * A copy is listed in needsReview and never written when it is not a readable dollar amount, or when the copies
 * disagree (the finance board showed costs.labor, else laborCost, while /api/money showed costs.laborCents): the owner
 * decides which figure is right, by entering it on the finance board.
 *
 * Restore (`--restore`, the rollback): writes every private record back onto its job as costs.labor (dollars, null
 * for a blank) and costs.laborCents (deleted for a blank), and deletes the record in the same write, so the code
 * before JOB-COST-PRIVACY, which reads only the job, shows the owner's figure again, and a later backfill moves the
 * figures the owner then saves rather than keeping a stale record. Run it (dry run, then `--restore --apply`) BEFORE
 * reverting the JOB-COST-PRIVACY code or firestore.rules; a record whose job no longer exists is listed and kept.
 *
 * Both modes put a Firestore updateTime precondition on every job and existing record they write (new records are
 * create-only), so a job or record saved meanwhile is skipped and reported, never overwritten; the writes join an
 * owner-only hub_audit entry per job and one jobLaborCostOperations/<requestId> receipt per batch in the same commit.
 * Re-running after an apply is a no-op.
 *
 *   node scripts/backfill-job-labor-private.mjs                    # backfill dry run
 *   node scripts/backfill-job-labor-private.mjs --apply            # backfill
 *   node scripts/backfill-job-labor-private.mjs --restore          # restore dry run
 *   node scripts/backfill-job-labor-private.mjs --restore --apply  # restore (before reverting the code)
 *   node scripts/backfill-job-labor-private.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report holds job IDs, field names and counts only: no labor figures
 * and no customer details. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {auditWrite} from '../functions/_lib/hub-audit.js';
import {JOB_LABOR_COSTS,JOB_LABOR_RECEIPTS,jobLaborDollars,legacyJobLabor,legacyLaborMove,validLaborFigure} from '../functions/_lib/job-labor-private.js';
import {moneyStorage} from '../functions/_lib/money-storage.js';

const ACTOR='job-labor-backfill';
const byId=(a,b)=>String(a.id).localeCompare(String(b.id));
const fail=(code,message)=>Object.assign(new Error(message),{code:'job_labor_backfill_'+code});
// Private rows in jobs (locks, receipts, encrypted Hub records) are never job documents with labor.
const privateRow=row=>typeof row?.id!=='string'||/^(_egc_|secure_)/.test(row.id)||Boolean(row.recordType);
const RESTORE_FIELDS=Object.freeze(['costs.labor','costs.laborCents']);

/** Pure plan from one complete jobs snapshot and the private records that already exist. */
export function planJobLaborBackfill(jobs,records) {
  if(!Array.isArray(jobs)||!Array.isArray(records))throw fail('input_invalid','Complete job and labor record lists are required.');
  const saved=new Map(records.map(row=>[row.id,row])),report={scanned:jobs.length,skippedRecords:0,clean:0,needsReview:[]},writes=[];
  for(const job of jobs) {
    if(privateRow(job)){report.skippedRecords++;continue;}
    const legacy=legacyJobLabor(job),record=saved.get(job.id)||null,fields=legacy.fields;
    // Nothing on the job, or only a blank that reveals nothing and that no record replaces.
    if(!fields.length||!record&&!legacy.figure){report.clean++;continue;}
    if(!record&&legacy.state==='review'){report.needsReview.push({id:job.id,fields,reason:legacy.reason});continue;}
    writes.push({id:job.id,revision:job.revision,job,record,fields,action:record?'remove_copy':'move'});
  }
  writes.sort(byId);report.needsReview.sort(byId);
  return {writes,report};
}

/** Pure restore plan: each readable record goes back onto its job; a record without its job is kept and listed. */
export function planJobLaborRestore(jobs,records) {
  if(!Array.isArray(jobs)||!Array.isArray(records))throw fail('input_invalid','Complete job and labor record lists are required.');
  const byJob=new Map(jobs.filter(job=>!privateRow(job)).map(job=>[job.id,job])),report={records:records.length,missingJobs:[],unreadableRecords:[]},writes=[];
  for(const record of records) {
    if(typeof record?.id!=='string'||!validLaborFigure(record.laborCents)||typeof record.revision!=='string'||!record.revision){report.unreadableRecords.push({id:String(record?.id??''),reason:'labor_record_unreadable'});continue;}
    const job=byJob.get(record.id);
    if(!job){report.missingJobs.push({id:record.id,reason:'job_missing'});continue;}
    writes.push({id:job.id,revision:job.revision,job,record,fields:[...RESTORE_FIELDS],action:'restore'});
  }
  writes.sort(byId);report.missingJobs.sort(byId);report.unreadableRecords.sort(byId);
  return {writes,report};
}

function backfillWrites(rows,now) {
  return rows.flatMap(row=>{const move=legacyLaborMove(row.job,row.record,now);return [...(row.action==='move'?move.writes:[]),{collection:'jobs',id:row.id,revision:row.revision,patch:{},remove:row.fields}];});
}
// The figure goes back where the older code reads it; a blank is costs.labor null with no costs.laborCents.
function restoreWrites(rows) {
  return rows.flatMap(({id,revision,record})=>[
    {collection:'jobs',id,revision,patch:{costs:{labor:jobLaborDollars(record.laborCents),...(record.laborCents===null?{}:{laborCents:record.laborCents})}},mask:[...RESTORE_FIELDS]},
    {collection:JOB_LABOR_COSTS,id,revision:record.revision,delete:true},
  ]);
}

function batchWrites(group,{runId,now,restore}) {
  const requestId=randomUUID().toLowerCase();
  const audits=group.map(row=>auditWrite({actor:{id:ACTOR,kind:'system'},via:'cron',action:restore?'money.labor.restore':'money.labor.backfill',entity:{collection:'jobs',id:row.id},
    before:restore?{fields:[],record:'present'}:{fields:row.fields},after:restore?{fields:row.fields,record:'deleted'}:{fields:[],record:row.action==='move'?'created':'kept'},
    requestId,reason:restore?'Job labor privacy rollback':'Job labor privacy backfill',visibility:'owner',now}));
  return {requestId,writes:[...(restore?restoreWrites(group):backfillWrites(group,now)),...audits,
    {collection:JOB_LABOR_RECEIPTS,id:requestId,patch:{scope:restore?'job_labor_restore':'job_labor_backfill',action:restore?'labor.restore':'labor.backfill',actorId:ACTOR,requestId,runId,createdAt:now,
      targets:group.map(row=>({id:row.id,revision:row.revision,action:row.action,fields:row.fields}))}}]};
}

export async function runJobLaborBackfill(store,{apply=false,restore=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=50}={}) {
  const jobs=await store.laborCopies(),records=await store.laborRecords();
  const plan=restore?planJobLaborRestore(jobs,records):planJobLaborBackfill(jobs,records);
  const committed=[],changed=[],receipts=[];
  const counts=restore?{restores:plan.writes.length}:{moves:plan.writes.filter(row=>row.action==='move').length,copiesRemovedOnly:plan.writes.filter(row=>row.action==='remove_copy').length};
  const result=extra=>({mode:(restore?'restore_':'')+(apply?'apply':'dry_run'),runId,generatedAt:now,[restore?'records':'jobs']:plan.report,
    preview:plan.writes.map(({id,action,fields})=>({id,action,fields})),
    writes:{planned:plan.writes.length,...counts,committed:committed.length,changedDuringRun:[...changed].sort(),receipts:[...receipts]},...extra});
  if(!apply)return result({});
  async function commit(group) {
    const {requestId,writes}=batchWrites(group,{runId,now,restore});
    try{await store.commit(writes);}
    catch(error) {
      if(error.code==='money_revision_conflict')return false;
      // A lost response may still have committed; the receipt is the proof.
      const receipt=await store.read(JOB_LABOR_RECEIPTS,requestId).catch(()=>null);
      if(receipt?.runId!==runId)throw error;
    }
    committed.push(...group.map(row=>row.id));receipts.push(requestId);return true;
  }
  try {
    for(let start=0;start<plan.writes.length;start+=batchSize) {
      const batch=plan.writes.slice(start,start+batchSize);
      if(await commit(batch))continue;
      // One job or record saved meanwhile must not block the rest; a rerun picks it up.
      for(const row of batch)if(!await commit([row]))changed.push(row.id);
    }
  } catch(error) {
    return result({aborted:{code:error.code||'job_labor_backfill_failed',message:`The ${restore?'restore':'backfill'} stopped before finishing. Rerun it; jobs already written are skipped and their receipts are listed.`}});
  }
  return result({});
}

export function parseArgs(argv) {
  const options={apply:false,restore:false,report:'',help:false};let dryRun=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--apply')options.apply=true;
    else if(arg==='--dry-run')dryRun=true;
    else if(arg==='--restore')options.restore=true;
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
  if(options.help){console.error('Usage: node scripts/backfill-job-labor-private.mjs [--restore] [--dry-run|--apply] [--report <file>]\nDry run is the default. --apply moves labor copies off jobs into jobLaborCosts; --restore --apply writes every jobLaborCosts record back onto its job and deletes it (run it before reverting JOB-COST-PRIVACY). Every write carries updateTime preconditions, an audit entry and a receipt.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runJobLaborBackfill(moneyStorage(env),{apply:options.apply,restore:options.restore,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The job labor records could not be read completely. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {writes}=report,done=report.mode.endsWith('apply')?'APPLIED':'DRY RUN (nothing written)',aborted=report.aborted?' ABORTED: '+report.aborted.message:'';
  if(options.restore)console.error(`RESTORE ${done}: ${writes.committed}/${writes.planned} records written back onto their jobs and deleted; ${report.records.missingJobs.length} kept because the job is gone, ${report.records.unreadableRecords.length} unreadable, ${writes.changedDuringRun.length} changed during the run.${aborted}`);
  else console.error(`${done}: ${writes.committed}/${writes.planned} jobs cleared (${writes.moves} copies moved to a private record, ${writes.copiesRemovedOnly} stale copies removed); ${report.jobs.clean} already clean, ${report.jobs.needsReview.length} need review, ${writes.changedDuringRun.length} changed during the run.${aborted}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
