/** Recurring plan backfill (P1-DS-11). DRY RUN BY DEFAULT: groups the legacy
 * repeating jobs (recurrence weekly|biweekly|monthly|quarterly) into series by
 * recurrenceParentId / sourceTemplateJobId and reports the recurringPlans/{planId}
 * document each series would become, without writing anything.
 *
 * A legacy series was booked as a fixed number of visits. Its plan continues the
 * same cadence after the series' LAST live future visit (the plan's template and
 * start date), so the plan never books a date next to an existing legacy visit.
 * Visits of the series already cancelled after that anchor become skipDates.
 * Series are reported, never converted, when they are:
 *   ambiguous       customer missing or different across visits, visits that
 *                   disagree on the repeat interval, a broken parent chain, or a
 *                   template/customer/schedule that is not valid for a plan;
 *   ended           no live visit today or later (the customer may have stopped);
 *   already_planned a visit is already a plan's template, occurrence or visit.
 *
 * `--apply` creates each converted plan PAUSED, create-only (currentDocument
 * exists:false) with a recurringPlanOperations receipt in the same commit. A
 * manager then reviews it in Dispatch > Recurring plans and presses Resume, which
 * also makes that manager accountable for the plan's scheduled runs. Plan ids and
 * receipt ids are derived from the series root, so a rerun skips what exists.
 * No job is changed and no price is set (the anchor's quoted amount is reported
 * as priceCandidateCents for the manager to confirm on the plan). Customer
 * reminders start OFF on every plan; reminderCandidate names the series whose
 * legacy visits had them on, for the manager to turn on in the plan editor.
 * The anchor's crew and vehicle are kept only while that crew is active and the
 * vehicle available; otherwise they are dropped and reported.
 *
 *   node scripts/backfill-recurring-plans.mjs                 # dry run
 *   node scripts/backfill-recurring-plans.mjs --apply         # write paused plans
 *   node scripts/backfill-recurring-plans.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON (and the Hub account variables used for
 * the active roster). The report holds job, customer and plan ids, dates and
 * times only (no names, addresses or contact details). */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {denverToday,scheduleInterval,validDate} from '../functions/_lib/dispatch-time.js';
import {assignmentKey} from '../functions/_lib/job-assignment.js';
import {moneyCents} from '../functions/_lib/money-core.js';
import {normalizeRecurringSchedule} from '../functions/_lib/recurring-plans.js';
import {occurrenceRequestId} from '../functions/_lib/recurring-plan-service.js';

export const BACKFILL_ACTOR='recurring-plan-backfill';
const CADENCES=['weekly','biweekly','monthly','quarterly'];
const HORIZON={weekly:56,biweekly:84,monthly:93,quarterly:190};
const TYPES=new Set(['job','cleanout','reorg']);
const TERMINAL=new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(id)&&!/^(secure_|_egc_)/.test(id);
const state=job=>job.pipelineStatus||job.status||'unscheduled';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>Object.assign(new Error(message),{code:'recurring_backfill_'+code});
const clip=(value,max)=>String(value??'').slice(0,max);
const byDate=(a,b)=>(a.date||'').localeCompare(b.date||'')||(a.time||'').localeCompare(b.time||'')||a.id.localeCompare(b.id);
const hex=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
export const backfillPlanId=async rootId=>`plan_legacy_${(await hex('legacy-series:'+rootId)).slice(0,32)}`;

function cadenceFor(recurrence,date){
  if(recurrence==='weekly'||recurrence==='biweekly')return {frequency:recurrence};
  return {frequency:recurrence,monthlyBy:'day_of_month',dayOfMonth:Number(date.slice(8,10))};
}
function assignmentFor(job,roster,resources){
  const ids=new Set(roster.map(person=>person.id)),assigned=(Array.isArray(job.assignedCrew)?job.assignedCrew:[]).map(value=>assignmentKey(object(value)?value.username||value.user||value.id:value));
  const assignedCrew=[...new Set(assigned.filter(id=>ids.has(id)))],lead=assignmentKey(job.crewLead||'');
  // The same checks a plan save applies: an active crew, an available vehicle.
  const crewId=safeId(job.crewId)&&resources.some(row=>row?.recordType==='crew'&&row.id===job.crewId&&row.status==='active')?job.crewId:null;
  const vehicleId=safeId(job.vehicleId)&&resources.some(row=>row?.recordType==='vehicle'&&row.id===job.vehicleId&&row.status==='available')?job.vehicleId:null;
  return {assignment:{assignedCrew,crewLead:assignedCrew.includes(lead)?lead:null,crewId,vehicleId},dropped:assigned.length>assignedCrew.length,crewIdDropped:Boolean(job.crewId)&&!crewId,vehicleDropped:Boolean(job.vehicleId)&&!vehicleId};
}

/** Pure plan from one complete snapshot. Returns {creates, report}; creates are
 * sorted by root id and hold the exact plan documents --apply would write. */
export async function planRecurringBackfill({jobs,plans=[],customers=[],roster=[],resources},now){
  const nowMs=Date.parse(now);
  if(!Array.isArray(jobs)||!Array.isArray(plans)||!Array.isArray(customers)||!Array.isArray(roster)||!Array.isArray(resources)||!Number.isFinite(nowMs))throw fail('input_invalid','Complete job, plan, customer, roster and crew/vehicle lists and a valid current time are required.');
  const today=denverToday(new Date(now)),byId=new Map(jobs.filter(job=>safeId(job?.id)).map(job=>[job.id,job])),customerIds=new Set(customers.map(row=>row?.id));
  const planned=new Set();
  for(const plan of plans){if(safeId(plan?.templateJobId))planned.add(plan.templateJobId);for(const entry of Object.values(object(plan?.occurrences)?plan.occurrences:{}))if(safeId(entry?.jobId))planned.add(entry.jobId);}
  const report={scanned:jobs.length,repeating:0,series:0,converted:[],ambiguous:[],ended:[],alreadyPlanned:[]},groups=new Map();
  const rootOf=job=>{const seen=new Set();let current=job;while(current){const parent=current.recurrenceParentId||current.sourceTemplateJobId;if(!safeId(parent)||parent===current.id)return {root:current.id};if(seen.has(parent))return {root:parent,cycle:true};seen.add(current.id);if(!byId.has(parent))return {root:parent};current=byId.get(parent);}return {root:job.id};};
  for(const job of jobs){
    if(!safeId(job?.id)||job.recordType||!TYPES.has(job.type)||!CADENCES.includes(job.recurrence))continue;
    report.repeating++;
    const {root,cycle}=rootOf(job),group=groups.get(root)||{root,members:[],cycle:false};
    group.members.push(job);group.cycle||=Boolean(cycle);groups.set(root,group);
  }
  // Members of a series may have been made from a root that no longer repeats.
  if(groups.size)for(const job of jobs)if(safeId(job?.id)&&!job.recordType&&TYPES.has(job.type)&&groups.has(job.id)&&!groups.get(job.id).members.some(row=>row.id===job.id))groups.get(job.id).members.push(job);
  const creates=[];
  for(const group of [...groups.values()].sort((a,b)=>a.root.localeCompare(b.root))){
    report.series++;
    const members=group.members.sort(byDate),ids=members.map(job=>job.id),row={rootJobId:group.root,jobIds:ids};
    const ambiguous=reason=>report.ambiguous.push({...row,reason});
    if(ids.some(id=>planned.has(id))||members.some(job=>safeId(job.recurringPlanId))){report.alreadyPlanned.push(row);continue;}
    if(group.cycle){ambiguous('parent_cycle');continue;}
    const customers=[...new Set(members.map(job=>job.customerId||''))];
    if(customers.some(id=>!safeId(id))){ambiguous('customer_missing');continue;}
    if(customers.length!==1){ambiguous('customer_mismatch');continue;}
    const cadences=[...new Set(members.map(job=>job.recurrence).filter(value=>value&&value!=='none'))];
    if(cadences.length!==1){ambiguous('cadence_mismatch');continue;}
    const live=members.filter(job=>!TERMINAL.has(state(job))&&validDate(job.date)&&job.date>=today);
    if(!live.length){report.ended.push({...row,lastDate:members.filter(job=>validDate(job.date)).at(-1)?.date||null});continue;}
    const anchor=live.at(-1),interval=scheduleInterval(anchor);
    if(!customerIds.has(customers[0])){ambiguous('customer_not_found');continue;}
    if(!interval){ambiguous('schedule_invalid');continue;}
    let schedule;
    // Visits already cancelled after the anchor stay cancelled: the plan skips those dates.
    const skipDates=[...new Set(members.filter(job=>TERMINAL.has(state(job))&&validDate(job.date)&&job.date>interval.date).map(job=>job.date))].sort().slice(0,200);
    try{schedule=normalizeRecurringSchedule({cadence:cadenceFor(cadences[0],interval.date),startDate:interval.date,time:interval.time,endTime:interval.endTime,spanDays:Math.round((Date.parse(interval.endDate+'T12:00:00Z')-Date.parse(interval.date+'T12:00:00Z'))/86400000),skipDates,horizonDays:HORIZON[cadences[0]]});}
    catch{ambiguous('schedule_invalid');continue;}
    const planId=await backfillPlanId(group.root),requestId=await occurrenceRequestId(planId,interval.date,'backfill'),{assignment,dropped,crewIdDropped,vehicleDropped}=assignmentFor(anchor,roster,resources),customer=customers[0];
    const warnings=[...(dropped?[{code:'template_crew_inactive',message:'Some employees on the template job are no longer active and were not added to the plan.'}]:[]),
      ...(crewIdDropped||vehicleDropped?[{code:'template_resource_unavailable',message:'The template job\u2019s crew or vehicle is no longer available and was not added to the plan.'}]:[])];
    // Reminders are a manager's explicit choice on the plan, never carried over silently.
    const plan={id:planId,recordType:'recurring_plan',version:1,status:'paused',customerId:customer,customer:clip(anchor.customer,200),address:clip(anchor.address,1000),templateJobId:anchor.id,...schedule,
      assignment,notifyCustomer:false,occurrences:{[interval.date]:{jobId:anchor.id,state:'template',createdAt:now}},warnings,lastRun:null,
      source:{kind:'legacy_series',rootJobId:group.root,jobIds:ids.slice(0,200),backfilledAt:now},pausedAt:now,pausedBy:BACKFILL_ACTOR,createdAt:now,createdBy:BACKFILL_ACTOR,updatedAt:now,updatedBy:BACKFILL_ACTOR,planRequestId:requestId};
    creates.push({planId,requestId,rootJobId:group.root,anchorJobId:anchor.id,plan});
    report.converted.push({...row,planId,templateJobId:anchor.id,customerId:customer,cadence:schedule.cadence.frequency,startDate:schedule.startDate,time:schedule.time,endTime:schedule.endTime,skipDates:schedule.skipDates,notifyCustomer:plan.notifyCustomer,reminderCandidate:anchor.notify!==false,crewDropped:dropped,crewIdDropped,vehicleDropped});
  }
  for(const key of ['ambiguous','ended','alreadyPlanned'])report[key].sort((a,b)=>a.rootJobId.localeCompare(b.rootJobId));
  return {creates,report};
}

export async function runRecurringBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID()}={}){
  const [jobs,plans,customers,roster,resources]=await Promise.all([store.jobs(),store.recurringPlans(),store.customers(),store.roster(),store.resources()]);
  const {creates,report}=await planRecurringBackfill({jobs,plans,customers,roster,resources},now);
  // Informational only: the anchor's saved quote, for a manager to confirm as the plan price.
  for(const row of report.converted){const anchor=await store.read('jobs',row.templateJobId).catch(()=>null);const cents=moneyCents(anchor?.estimate?.amount);row.priceCandidateCents=Number.isSafeInteger(cents)&&cents>0?cents:null;}
  const committed=[],existing=[];
  const summary=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,series:report,writes:{planned:creates.length,committed:[...committed],alreadyExisted:[...existing]},...extra});
  if(!apply)return summary({});
  try{
    for(const create of creates){
      const receipt={collection:'recurringPlanOperations',id:create.requestId.toLowerCase(),patch:{fingerprint:await hex(JSON.stringify({actor:BACKFILL_ACTOR,rootJobId:create.rootJobId,planId:create.planId})),actorId:BACKFILL_ACTOR,action:'backfill',planId:create.planId,requestId:create.requestId,runId,createdAt:now,before:null,warnings:create.plan.warnings}};
      try{await store.commit([{collection:'recurringPlans',id:create.planId,patch:create.plan},receipt]);committed.push(create.planId);}
      catch(error){
        // Create-only: an existing plan is left untouched. A lost response is verified from the receipt.
        const saved=await store.read('recurringPlanOperations',receipt.id).catch(()=>null);
        if(saved?.runId===runId){committed.push(create.planId);continue;}
        if(await store.read('recurringPlans',create.planId).catch(()=>null)){existing.push(create.planId);continue;}
        throw error;
      }
    }
  }catch(error){return summary({aborted:{code:error.code||'recurring_backfill_failed',message:'The backfill stopped before finishing. Rerun it; plans already created are skipped.'}});}
  return summary({});
}

export function parseArgs(argv){
  const options={apply:false,report:'',help:false};let dryRun=false;
  for(let i=0;i<argv.length;i++){
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

async function main(){
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/backfill-recurring-plans.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply creates PAUSED plans (create-only, with receipts) with customer reminders off. Nothing is scheduled until a manager resumes a plan.');return;}
  const env=process.env;
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runRecurringBackfill(dispatchStorage(env),{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {series,writes}=report;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${series.series} legacy series; ${series.converted.length} convertible (${writes.committed.length} paused plans created, ${writes.alreadyExisted.length} already existed), ${series.ambiguous.length} ambiguous, ${series.ended.length} ended, ${series.alreadyPlanned.length} already planned; ${series.converted.filter(row=>row.reminderCandidate).length} had customer reminders on (plans start with them off).${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
