/** Project service line and funnel path backfill (FUN-29). DRY RUN BY DEFAULT: scans
 * projects and jobs and prints the serviceLine / funnelPath each existing project
 * would get from the legacy mapping (functions/_lib/funnel-dimensions.js
 * legacyDimensionFacts, the same rules a live booking uses), without writing.
 *
 * `--apply` writes ONLY the dimension a project lacks (null or absent) with its
 * rule source, dimensionRulesVersion and dimensionsUpdatedAt/By; a recorded value,
 * including a staff "Not sure yet" (serviceLine 'unknown'), is never replaced.
 * Each project write carries its Firestore updateTime precondition (a project
 * saved meanwhile is skipped and reported, never overwritten), and each commit
 * atomically creates a receipt in dispatchOperations/<requestId> listing every
 * project it changed with before/after values. Re-running after an apply is a
 * no-op. A dimension no Hub record decides stays null (metrics show it in the
 * unknown bucket) and is listed for review; the GHL lead field is not a Hub record
 * and is never read here.
 *
 *   node scripts/backfill-project-dimensions.mjs                 # dry run
 *   node scripts/backfill-project-dimensions.mjs --apply         # write
 *   node scripts/backfill-project-dimensions.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report holds project ids, values and
 * rule sources only (no customer details or money). */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {dimensionRulesVersion, funnelHubId} from '../functions/_lib/funnel-definitions.js';
import {legacyDimensionFacts, resolveDimensions, seedCatalogCategory} from '../functions/_lib/funnel-dimensions.js';

export const BACKFILL_ACTOR='project-dimensions-backfill';
// Only the fields the legacy mapping reads (estimate.lineItems for catalog references).
export const JOB_FIELDS=['type','recordType','projectId','customerId','visitPurpose','bookingChannel','businessAccountId','estimate.lineItems','serviceType','recurringPlanId','recurrence','sourceWalkthroughId','sourceTemplateJobId','sourceRebookingRequestId'];
const VISIT_TYPES=new Set(['job','walkthrough','cleanout','reorg']);
const DIMENSIONS=[['serviceLine','serviceLineSource'],['funnelPath','funnelPathSource']];
const REVIEW_LIMIT=500;
const fail=(code,message)=>Object.assign(new Error(message),{code:'project_dimensions_backfill_'+code});
const byId=(a,b)=>String(a.id||a).localeCompare(String(b.id||b));
const missing=value=>value===undefined||value===null;

/** Pure plan from one complete projects and jobs snapshot. */
export function planProjectDimensionBackfill(projects,jobs,{now,categoryOf=seedCatalogCategory}={}) {
  if(!Array.isArray(projects)||!Array.isArray(jobs)||!Number.isFinite(Date.parse(now)))throw fail('input_invalid','Complete project and job lists and a valid current time are required.');
  const report={scanned:projects.length,skippedRecords:0,complete:0,noVisits:[],decided:{serviceLine:{},funnelPath:{}},undecided:{serviceLine:[],funnelPath:[]}};
  const rows=projects.filter(project=>{const ok=project&&funnelHubId(project.id)&&!project.recordType;if(!ok)report.skippedRecords++;return ok;});
  // A project's visits: jobs that name it, plus its source record when that record predates project links.
  const jobsById=new Map(),linked=new Map();
  for(const job of jobs) {
    if(!job||!funnelHubId(job.id)||job.recordType||!VISIT_TYPES.has(job.type))continue;
    jobsById.set(job.id,job);
    if(job.projectId){if(!linked.has(job.projectId))linked.set(job.projectId,[]);linked.get(job.projectId).push(job);}
  }
  const visits=new Map(rows.map(project=>[project.id,[...(linked.get(project.id)||[]),...[...new Set([project.sourceRecordId,project.sourceWalkthroughId])].map(id=>jobsById.get(id)).filter(job=>job&&!job.projectId)]]));
  // A repeat inherits the service line of the project it continues: stored, or decided earlier in this run.
  const first=new Map(rows.map(project=>[project.id,resolveDimensions(legacyDimensionFacts(project,visits.get(project.id),{categoryOf}))]));
  const byProject=new Map(rows.map(project=>[project.id,project]));
  const writes=[];
  for(const project of rows) {
    const gaps=DIMENSIONS.filter(([field])=>missing(project[field]));
    if(!gaps.length){report.complete++;continue;}
    if(!visits.get(project.id).length)report.noVisits.push(project.id);
    const previous=funnelHubId(project.previousProjectId)?byProject.get(project.previousProjectId):null;
    const related=previous?{...previous,serviceLine:previous.serviceLine??first.get(previous.id)?.serviceLine??null}:null;
    const resolved=resolveDimensions(legacyDimensionFacts(project,visits.get(project.id),{related,categoryOf}));
    const patch={};
    for(const [field,sourceField] of gaps) {
      if(resolved[field]===null){report.undecided[field].push(project.id);continue;}
      Object.assign(patch,{[field]:resolved[field],[sourceField]:resolved[sourceField]});
      report.decided[field][resolved[sourceField]]=(report.decided[field][resolved[sourceField]]||0)+1;
    }
    if(Object.keys(patch).length)writes.push({id:project.id,revision:project.revision,before:Object.fromEntries(Object.keys(patch).map(key=>[key,project[key]??null])),patch:{...patch,dimensionRulesVersion:dimensionRulesVersion(),dimensionsUpdatedAt:now,dimensionsUpdatedBy:BACKFILL_ACTOR}});
  }
  writes.sort(byId);
  for(const list of [report.noVisits,report.undecided.serviceLine,report.undecided.funnelPath])list.sort(byId);
  return {writes,report};
}

function receiptWrite(group,{runId,now}) {
  const requestId=randomUUID().toLowerCase();
  return {requestId,write:{collection:'dispatchOperations',id:requestId,patch:{scope:'project_dimensions_backfill',action:'project_dimensions.backfill',actorId:BACKFILL_ACTOR,requestId,runId,createdAt:now,dimensionRulesVersion:dimensionRulesVersion(),
    targets:group.map(row=>({id:row.id,revision:row.revision,before:row.before,after:Object.fromEntries(Object.keys(row.before).map(key=>[key,row.patch[key]]))}))}}};
}

export async function runProjectDimensionBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=100,categoryOf=seedCatalogCategory}={}) {
  if(typeof store.projects!=='function'||typeof store.jobRecords!=='function')throw fail('store_invalid','The store cannot list projects and jobs.');
  const [projects,jobs]=await Promise.all([store.projects(),store.jobRecords(JOB_FIELDS)]);
  const plan=planProjectDimensionBackfill(projects,jobs,{now,categoryOf});
  const committed=[],changed=[],receipts=[];
  const cap=list=>({count:list.length,ids:list.slice(0,REVIEW_LIMIT)});
  const summary=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,rulesVersion:dimensionRulesVersion(),
    projects:{scanned:plan.report.scanned,skippedRecords:plan.report.skippedRecords,complete:plan.report.complete,noVisits:cap(plan.report.noVisits),decided:plan.report.decided,undecided:{serviceLine:cap(plan.report.undecided.serviceLine),funnelPath:cap(plan.report.undecided.funnelPath)}},
    preview:plan.writes.map(({id,patch})=>({id,...Object.fromEntries(DIMENSIONS.flat().filter(key=>key in patch).map(key=>[key,patch[key]]))})),
    writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort(),receipts:[...receipts]},...extra});
  if(!apply)return summary({});
  async function commit(group) {
    const {requestId,write}=receiptWrite(group,{runId,now});
    try{await store.commit([...group.map(row=>({collection:'projects',id:row.id,revision:row.revision,patch:row.patch})),write]);}
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
      // One project saved meanwhile must not block the rest; a rerun picks it up.
      for(const row of batch)if(!await commit([row]))changed.push(row.id);
    }
  } catch(error) {
    return summary({aborted:{code:error.code||'project_dimensions_backfill_failed',message:'The backfill stopped before finishing. Rerun it; projects already filled are skipped and their receipts are listed.'}});
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
  if(options.help){console.error('Usage: node scripts/backfill-project-dimensions.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply fills only missing service lines and funnel paths, with updateTime preconditions and a receipt.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runProjectDimensionBackfill(dispatchStorage(env),{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete project and job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {projects,writes}=report;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${writes.committed}/${writes.planned} projects filled under dimension rules v${report.rulesVersion}; ${projects.complete} already complete; ${projects.undecided.serviceLine.count} service lines and ${projects.undecided.funnelPath.count} funnel paths stay unknown; ${writes.changedDuringRun.length} changed during the run.${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
