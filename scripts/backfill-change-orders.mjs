/** Change-order backfill (P2-11). DRY RUN BY DEFAULT: scans jobs and reports
 * the change-order lines it would add, without writing anything.
 *
 * Before CHANGE_ORDER_BILLING_ENABLED, a priced crew decision the customer
 * approved in the portal was saved with no change-order line: money-core (the
 * Hub money API and money documents) counts it through approvedChangeTotal,
 * but the portal balance and Stripe checkout do not, and the documents say to
 * call to pay. Run this after turning billing on to close that gap: for every
 * approved, priced, portal-answered decision without a line it adds the same
 * line a live approval adds (functions/_lib/change-orders.js), marked
 * backfilled:true with the evidence copied from the decision (respondedAt,
 * responseBy, responseSource, request id, actor), links the decision to it
 * (changeOrderId) and recomputes approvedChangeTotal. An issued invoice whose
 * amount is the portal total without these changes is raised by them exactly
 * as a live approval raises it; one that already includes them (issued from
 * the Hub money API) is left as it is.
 *
 * Jobs are listed for the owner instead of written when anything is unclear:
 * a price that is not dollars and cents, repeated decision ids, a line id
 * already taken, a closed job (cancelled, lost, declined, a no-show or
 * superseded; CLOSED_STAGES), an answer with no time or name, an answer
 * recorded after the crew finished or more than DECISION_APPROVAL_DAYS after
 * the question (the portal no longer bills those), an issued invoice that
 * matches neither figure, or a saved approvedChangeTotal that differs from
 * what the job's decisions and change-order lines add up to
 * (stored_total_mismatch, with both figures in cents: typically a legacy
 * approval a stale Hub write turned back into a question, which money-core
 * still bills while the portal asks it again). Every job with such a total is
 * listed, including jobs that need no line; the owner corrects it (the
 * customer's answer recomputes it). A finished job whose money is settled (its invoice
 * is paid, or nothing is owed) is held as job_finished by default: a line
 * there reopens a closed balance and can restart payment reminders. After
 * reviewing the dry run, pass --include-finished to write those too, and
 * --only / --exclude to choose jobs by id.
 *
 * Every saved line is billed whatever CHANGE_ORDER_BILLING_ENABLED says (the
 * flag only stops new lines), so `--apply` also needs --billing-enabled: run
 * it only after CHANGE_ORDER_BILLING_ENABLED and MONEY_API_ENABLED are "true".
 * A line written by mistake is voided from the Hub (change_order.void).
 *
 * `--apply` writes only changeOrders, customerDecisions, approvedChangeTotal
 * and (when raised) invoice. Each job write carries its Firestore updateTime
 * precondition (a job saved meanwhile is skipped and reported, never
 * overwritten) and joins a hub_audit entry and a moneyOperations/<requestId>
 * receipt in the same commit. Re-running after an apply is a no-op. Nothing is
 * sent to any customer.
 *
 *   node scripts/backfill-change-orders.mjs                                   # dry run
 *   node scripts/backfill-change-orders.mjs --apply --billing-enabled         # write
 *   node scripts/backfill-change-orders.mjs --apply --billing-enabled --include-finished --exclude job-a,job-b
 *   node scripts/backfill-change-orders.mjs --only job-c --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report holds job and decision
 * IDs, cents and issue codes only (no customer details). */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {auditWrite} from '../functions/_lib/hub-audit.js';
import {DECISION_APPROVAL_DAYS,MAX_CHANGE_ORDERS,approvedChangeTotal,billedChangeCents,billedChangeOrders,changeOrderDraft,changeOrderLineId,decisionDeltaCents,jobClosed,jobFinished,raisedInvoice} from '../functions/_lib/change-orders.js';
import {customerMoneyState} from '../functions/_lib/customer-payments.js';
import {MAX_TOTAL_CENTS,customerMoneyTotals,moneyCents} from '../functions/_lib/money-core.js';
import {MONEY_RECEIPTS,moneyJob} from '../functions/_lib/money-service.js';
import {moneyStorage} from '../functions/_lib/money-storage.js';

const ACTOR='change-order-backfill';
const JOB_ID=/^[A-Za-z0-9_-]{1,180}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clean=(value,max)=>String(value||'').replace(/[\r\n\t]/g,' ').trim().slice(0,max);
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const byId=(a,b)=>String(a.id).localeCompare(String(b.id));
const cents=value=>Math.round(Number(value||0)*100);
const fail=(code,message)=>Object.assign(new Error(message),{code:'change_order_backfill_'+code});
const snapshot=job=>({approvedChangeTotal:job.approvedChangeTotal??null,billedCents:billedChangeCents(job),lines:billedChangeOrders(job).map(line=>({id:line.id,decisionId:line.decisionId,totalCents:line.totalCents})),invoice:plain(job.invoice)?{status:job.invoice.status??null,amount:job.invoice.amount??null,balance:job.invoice.balance??null}:null});

// A finished job whose balance was settled: a line would reopen it.
const settled=job=>String(job.invoice?.status||'').toLowerCase()==='paid'||cents(customerMoneyState(job).balance)===0;

// The saved approvedChangeTotal when it differs from what the decisions and
// saved lines add up to (the figure every portal answer and void saves), else
// null. money-core bills the saved figure and flags it; the owner corrects it.
function storedTotalMismatch(job) {
  const stored=job.approvedChangeTotal;
  if(stored===undefined||stored===null)return null;
  const saved=Array.isArray(job.changeOrders)?job.changeOrders:[],derivedCents=Math.round(approvedChangeTotal(job.customerDecisions,billedChangeOrders(job),saved)*100),storedCents=moneyCents(stored);
  return storedCents===derivedCents?null:{decisionId:'',code:'stored_total_mismatch',storedCents,derivedCents};
}

// The lines one job needs, or the reasons it must be reviewed instead.
function planJob(job,now,{includeFinished=false}={}) {
  const decisions=Array.isArray(job.customerDecisions)?job.customerDecisions:[],saved=Array.isArray(job.changeOrders)?job.changeOrders:[];
  const covered=item=>saved.some(line=>plain(line)&&(line.decisionId===item.id||line.id===changeOrderLineId(item.id)));
  const candidates=decisions.filter(item=>plain(item)&&item.status==='approved'&&item.responseSource==='customer_portal'&&!item.changeOrderVoidedAt&&typeof item.id==='string'&&!covered(item)&&decisionDeltaCents(item)!==0);
  const mismatch=storedTotalMismatch(job);
  if(!candidates.length)return mismatch?{issues:[mismatch]}:null;
  const issues=[],lines=[],ids=new Set(saved.filter(plain).map(line=>line.id));
  const completed=instant(job.completedAt||job.postJobChecklist?.completedAt);
  for(const item of candidates) {
    const issue=code=>issues.push({decisionId:clean(item.id,100),code});
    const amount=decisionDeltaCents(item),answeredAt=instant(item.respondedAt),askedAt=instant(item.promptedAt),by=clean(item.responseBy,120),lineId=changeOrderLineId(item.id);
    if(amount===null){issue('price_invalid');continue;}
    if(decisions.filter(other=>plain(other)&&other.id===item.id).length>1||ids.has(lineId)){issue('decision_ambiguous');continue;}
    if(jobClosed(job)){issue('job_closed');continue;}
    if(!answeredAt||by.length<2){issue('answer_evidence_missing');continue;}
    // The portal no longer bills a question answered more than DECISION_APPROVAL_DAYS after it was sent.
    if(askedAt&&Date.parse(answeredAt)-Date.parse(askedAt)>DECISION_APPROVAL_DAYS*86400000){issue('answered_after_expiry');continue;}
    // The portal no longer bills a change approved after the crew finished.
    if(jobFinished(job)&&!(completed&&answeredAt<completed)){issue(completed?'answered_after_completion':'completion_time_unknown');continue;}
    ids.add(lineId);
    lines.push({...changeOrderDraft(item,amount),approvedAt:answeredAt,approvedBy:by,...(typeof item.responseRequestId==='string'&&item.responseRequestId?{requestId:item.responseRequestId}:{}),...(typeof item.responseActorId==='string'&&item.responseActorId?{actorId:item.responseActorId}:{}),approvalSource:item.responseSource,backfilled:true,backfilledAt:now,backfilledBy:ACTOR});
  }
  // Writing would silently replace the saved total the owner has not reviewed.
  if(mismatch)issues.push(mismatch);
  const added=lines.reduce((sum,line)=>sum+line.totalCents,0);
  if(lines.length&&!includeFinished&&jobFinished(job)&&settled(job))issues.push({decisionId:'',code:'job_finished'});
  if(!issues.length&&saved.length+lines.length>MAX_CHANGE_ORDERS)issues.push({decisionId:'',code:'too_many_lines'});
  if(!issues.length&&billedChangeCents(job)+added>MAX_TOTAL_CENTS)issues.push({decisionId:'',code:'total_too_large'});
  let invoice=null,invoiceAction='none';
  const current=plain(job.invoice)?job.invoice:null,status=String(current?.status||'').toLowerCase(),amount=current?moneyCents(current.amount):null;
  if(!issues.length&&amount!==null&&!['draft','void','superseded'].includes(status)) {
    const base=cents(customerMoneyState(job).total);
    if(amount===base){invoice=current;const paid=customerMoneyTotals(job).appliedCents;for(const line of lines)invoice=raisedInvoice(invoice,line,now,paid,job.payment?.verified===true);invoiceAction='raised';}
    else if(amount===base+added)invoiceAction='already_included';
    else issues.push({decisionId:'',code:'invoice_amount_mismatch'});
  }
  if(issues.length)return{issues};
  const changeOrders=[...saved,...lines],linked=new Map(lines.map(line=>[line.decisionId,line.id]));
  const customerDecisions=decisions.map(item=>plain(item)&&linked.has(item.id)?{...item,changeOrderId:linked.get(item.id)}:item);
  const patch={changeOrders,customerDecisions,approvedChangeTotal:approvedChangeTotal(customerDecisions,billedChangeOrders({changeOrders}),changeOrders),...(invoice?{invoice}:{})};
  return{patch,lines,invoiceAction};
}

const idList=(value,name)=>{
  if(value===undefined)return null;
  if(!Array.isArray(value)||!value.length||value.some(id=>typeof id!=='string'||!JOB_ID.test(id)||/^(secure_|_egc_)/.test(id)))throw fail('input_invalid',`--${name} takes a comma-separated list of job ids.`);
  return new Set(value);
};

/**
 * Pure plan from one complete jobs snapshot. options: includeFinished (write
 * settled finished jobs too), only / exclude (job id lists: only those jobs,
 * or every job but those, are planned; the rest count as notSelected).
 */
export function planChangeOrderBackfill(jobs,now,{includeFinished=false,only,exclude}={}) {
  if(!Array.isArray(jobs))throw fail('input_invalid','A complete job list is required.');
  if(!instant(now))throw fail('now_required','Pass the current time in.');
  const chosen=idList(only,'only'),skipped=idList(exclude,'exclude');
  const report={scanned:jobs.length,skippedRecords:0,current:0,needsReview:[]},writes=[];
  if(chosen||skipped) {
    const ids=new Set(jobs.map(job=>job?.id));
    Object.assign(report,{notSelected:0,unknownIds:[...(chosen||[]),...(skipped||[])].filter(id=>!ids.has(id)).sort()});
  }
  for(const job of jobs) {
    if(!moneyJob(job)){report.skippedRecords++;continue;}
    if(chosen&&!chosen.has(job.id)||skipped&&skipped.has(job.id)){report.notSelected++;continue;}
    const planned=planJob(job,now,{includeFinished});
    if(!planned){report.current++;continue;}
    if(planned.issues){report.needsReview.push({id:job.id,issues:planned.issues});continue;}
    writes.push({id:job.id,revision:job.revision,patch:planned.patch,finished:jobFinished(job),invoice:planned.invoiceAction,lines:planned.lines.map(line=>({decisionId:line.decisionId,totalCents:line.totalCents})),before:snapshot(job),after:snapshot({...job,...planned.patch})});
  }
  writes.sort(byId);report.needsReview.sort(byId);
  return{writes,report};
}

function batchWrites(group,{runId,now}) {
  const requestId=randomUUID().toLowerCase();
  const audits=group.map(row=>auditWrite({actor:{id:ACTOR,kind:'system'},via:'cron',action:'money.change_order.backfill',entity:{collection:'jobs',id:row.id},before:row.before,after:row.after,requestId,reason:'Change-order backfill of portal approvals saved before billing',now}));
  return{requestId,writes:[...group.map(row=>({collection:'jobs',id:row.id,revision:row.revision,patch:row.patch})),...audits,
    {collection:MONEY_RECEIPTS,id:requestId,patch:{scope:'change_order_backfill',action:'change_order.backfill',actorId:ACTOR,requestId,runId,createdAt:now,targets:group.map(row=>({id:row.id,revision:row.revision,lines:row.lines,invoice:row.invoice}))}}]};
}

export async function runChangeOrderBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=50,includeFinished=false,only,exclude}={}) {
  const plan=planChangeOrderBackfill(await store.jobs(),now,{includeFinished,only,exclude}),committed=[],changed=[],receipts=[];
  const result=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,jobs:plan.report,
    preview:plan.writes.map(({id,lines,invoice,finished,before,after})=>({id,lines,invoice,finished,approvedChangeTotal:{before:before.approvedChangeTotal,after:after.approvedChangeTotal}})),
    writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort(),receipts:[...receipts]},...extra});
  if(!apply)return result({});
  async function commit(group) {
    const {requestId,writes}=batchWrites(group,{runId,now});
    try{await store.commit(writes);}
    catch(error) {
      if(error.code==='money_revision_conflict')return false;
      // A lost response may still have committed; the receipt is the proof.
      const receipt=await store.read(MONEY_RECEIPTS,requestId).catch(()=>null);
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
    return result({aborted:{code:error.code||'change_order_backfill_failed',message:'The backfill stopped before finishing. Rerun it; jobs already backfilled are skipped and their receipts are listed.'}});
  }
  return result({});
}

// Options beyond apply/report/help appear only when given.
export function parseArgs(argv) {
  const options={apply:false,report:'',help:false};let dryRun=false;
  const ids=value=>value.split(',').map(id=>id.trim()).filter(Boolean);
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--apply')options.apply=true;
    else if(arg==='--dry-run')dryRun=true;
    else if(arg==='--report'&&argv[i+1]&&!argv[i+1].startsWith('--'))options.report=argv[++i];
    else if(arg==='--billing-enabled')options.billingEnabled=true;
    else if(arg==='--include-finished')options.includeFinished=true;
    else if((arg==='--only'||arg==='--exclude')&&argv[i+1]&&!argv[i+1].startsWith('--')){const key=arg.slice(2);if(options[key])throw new Error(`Pass ${arg} once, with a comma-separated list of job ids.`);options[key]=ids(argv[++i]);if(!options[key].length||options[key].some(id=>!JOB_ID.test(id)))throw new Error(`${arg} takes a comma-separated list of job ids.`);}
    else if(arg==='--help'||arg==='-h')options.help=true;
    else throw new Error('Unknown or incomplete argument: '+arg);
  }
  if(options.apply&&dryRun)throw new Error('Choose either --dry-run or --apply.');
  if(options.only&&options.exclude)throw new Error('Choose either --only or --exclude.');
  return options;
}

/** Why an --apply must not run, or '' when it may: every saved line is charged whatever the billing flag says. */
export function applyRefusal(options) {
  return options.apply&&options.billingEnabled!==true?'--apply bills customers for every line it adds, even while CHANGE_ORDER_BILLING_ENABLED is off. Turn CHANGE_ORDER_BILLING_ENABLED and MONEY_API_ENABLED on first, then pass --billing-enabled with --apply to confirm.':'';
}

async function main() {
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/backfill-change-orders.mjs [--dry-run|--apply --billing-enabled] [--include-finished] [--only <ids>|--exclude <ids>] [--report <file>]\nDry run is the default; --apply adds change-order lines with updateTime preconditions, an audit entry and a receipt. Every saved line is billed whatever CHANGE_ORDER_BILLING_ENABLED says, so --apply also needs --billing-enabled: run it only after CHANGE_ORDER_BILLING_ENABLED and MONEY_API_ENABLED are on. Settled finished jobs are held as job_finished unless --include-finished; --only/--exclude take comma-separated job ids.');return;}
  const refusal=applyRefusal(options);
  if(refusal){console.error(refusal);process.exitCode=2;return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runChangeOrderBackfill(moneyStorage(env),{apply:options.apply,now:new Date().toISOString(),includeFinished:options.includeFinished===true,only:options.only,exclude:options.exclude});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {writes,jobs}=report;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${writes.committed}/${writes.planned} jobs given change-order lines; ${jobs.current} already current, ${jobs.needsReview.length} need review, ${writes.changedDuringRun.length} changed during the run.${jobs.notSelected!==undefined?` ${jobs.notSelected} not selected${jobs.unknownIds.length?`; unknown ids: ${jobs.unknownIds.join(', ')}`:''}.`:''}${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
