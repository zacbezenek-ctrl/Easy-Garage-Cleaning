/** Numberless invoice backfill (FIX-MONEY-INVOICE-STATE). DRY RUN BY DEFAULT: scans jobs and lists every job whose
 * invoice has neither a number nor issuedAt, without writing anything.
 *
 * Before MONEY_INVOICE_STATE_ENABLED, every card payment (portal, crew link, Stripe webhook) and every portal gift or
 * account credit wrote job.invoice = {amount, paid, balance, status: 'partial'|'paid', updatedAt} on the job even when
 * no invoice was ever issued. That invoice has no number and no issuedAt, yet it listed the job as invoiced, kept it
 * out of the Invoicing batch (already_invoiced) and printed INV-{last 6 of the job id} on receipts. Later saves may have
 * superseded, voided or raised it; it was still never issued.
 *
 * `--apply` removes that invoice from the job: its status and balance fields and the lifecycle marks later saves added
 * (superseded, void, a raised amount). payment, deposit and the payment ledger are never touched. A job is written only
 * when nothing read from it moves once the invoice is gone (moneyReviewReasons): money-core's totals in both
 * MONEY_UNIFIED_TOTALS modes, the portal and checkout (customerMoneyState, customerDepositState), the tip offer
 * (customer-payments tipRefusal), today's Hub finance board and the recurring price lock. Every other numberless
 * invoice is listed under jobs.needsReview with its reasons and never written:
 *   unknown_fields       the invoice holds a field this script does not know (listed in `fields`);
 *   paid_only_on_invoice there is no payment.amount, so invoice.paid or invoice.amountPaid is the job's only paid figure
 *                        (removing it would ask the customer to pay again). Leave it: the next payment recorded on the
 *                        job saves payment.amount, and a rerun then clears the invoice;
 *   money_totals_change  some other paid, balance or due figure would move;
 *   hub_total_changes    today's Hub finance board totals an active invoice's amount (employee-suite.js financeState),
 *                        and this one differs from the quote (for example it holds billed change orders). Once
 *                        MONEY_API_ENABLED and MONEY_UNIFIED_TOTALS are both "true" the board reads money-core's totals
 *                        instead: rerun with --hub-unified-totals, and only jobs whose money-core totals cannot be read
 *                        stay listed;
 *   tip_offer_changes    the portal and crew card would offer (or refuse) a tip differently: a void or superseded
 *                        invoice is what refuses a tip on this job today (tipRefusal), and removing it would reopen
 *                        the tip offer;
 *   price_lock_changes   the invoice is all that keeps a recurring plan from re-pricing the visit;
 *   money_unreadable     a money reader fails on this job's saved data, so nothing can be compared.
 * Each job write carries its Firestore updateTime precondition (a job saved meanwhile is skipped and reported, never
 * overwritten; a rerun picks it up) and joins a hub_audit entry (the invoice before) and a moneyOperations/<requestId>
 * receipt in the same commit. Re-running after an apply plans 0.
 *
 * jobs.numberedNotIssued lists (and never changes) invoices that have a number but no issuedAt and are not Jobber
 * imports: a Hub offline payment reserved that number without issuing the invoice. Payments keep such an invoice's
 * paid, balance and status current with the flag on, as before it (money-core invoiceTakesPayment). Issue each one from
 * Estimates & payments when the customer should get it.
 *
 *   node scripts/backfill-numberless-invoices.mjs                          # dry run
 *   node scripts/backfill-numberless-invoices.mjs --apply                  # write
 *   node scripts/backfill-numberless-invoices.mjs --apply --hub-unified-totals
 *   node scripts/backfill-numberless-invoices.mjs --report out.json
 *
 * Turn MONEY_API_ENABLED and MONEY_UNIFIED_TOTALS on, then MONEY_INVOICE_STATE_ENABLED, before --apply: without the
 * flag the next card payment writes such an invoice again. Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report holds job
 * IDs, invoice numbers, statuses, reasons and cents only (no customer details). */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {auditWrite} from '../functions/_lib/hub-audit.js';
import {customerDepositState,customerMoneyState,tipRefusal} from '../functions/_lib/customer-payments.js';
import {customerMoneyTotals,moneyCents} from '../functions/_lib/money-core.js';
import {MONEY_RECEIPTS,moneyJob} from '../functions/_lib/money-service.js';
import {moneyStorage} from '../functions/_lib/money-storage.js';
import {visitPriceBlocker} from '../functions/_lib/recurring-plan-price.js';

const ACTOR='numberless-invoice-backfill';
// What a payment, a credit or a later save wrote on an invoice no one issued.
export const WRITTEN_FIELDS=Object.freeze(['status','amount','amountCents','paid','paidCents','amountPaid','balance','balanceCents','updatedAt','approvedChangeCents','lineItems','supersededAt','supersededReason','voidedAt','voidedBy','voidReason']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const numbered=invoice=>typeof invoice.number==='string'&&Boolean(invoice.number.trim());
const given=value=>value!==undefined&&value!==null&&value!=='';
const byId=(a,b)=>String(a.id).localeCompare(String(b.id));
const fail=(code,message)=>Object.assign(new Error(message),{code:'numberless_invoice_backfill_'+code});
const cents=value=>given(value)?moneyCents(value):null;
const summary=invoice=>({status:typeof invoice.status==='string'?invoice.status.slice(0,40):null,amountCents:cents(invoice.amount),paidCents:cents(invoice.paid),balanceCents:cents(invoice.balance)});

/** An invoice a payment or credit wrote without issuing it: neither a number nor issuedAt, and some state on it. */
export function numberlessInvoice(job) {
  const invoice=job?.invoice;
  return plain(invoice)&&!numbered(invoice)&&!invoice.issuedAt&&Object.keys(invoice).some(key=>given(invoice[key]));
}

const saved=value=>value!==undefined&&value!==null;
const TOTAL_KEYS=['totalCents','paidCents','appliedCents','recordedCents','balanceCents','dueNowCents','depositPaidCents'];
function moneyFigures(job) {
  const core=unified=>{const totals=customerMoneyTotals(job,{unified});return TOTAL_KEYS.map(key=>totals[key]);};
  const state=customerMoneyState(job),deposit=customerDepositState(job,state);
  return JSON.stringify([core(false),core(true),state.total,state.paid,state.balance,deposit.paid,deposit.dueNow]);
}
// employee-suite.js financeState (today's Hub finance board): an active invoice's amount is the job's total, else the quote.
function hubBoardTotal(job) {
  const invoice=job.invoice,active=invoice?.amount&&!['draft','superseded','void'].includes(invoice?.status);
  return Number(active?invoice.amount:job.estimate?.amount||job.total||job.priceQuoted||0);
}
// EGCMoneyTotals (MONEY_API_ENABLED and MONEY_UNIFIED_TOTALS "true") serves money-core's unified totals when it can read them.
const boardReadsCore=job=>{const totals=customerMoneyTotals(job,{unified:true});return [totals.totalCents,totals.appliedCents,totals.balanceCents].every(Number.isSafeInteger);};

/** Why removing this job's invoice would change money someone reads (empty when nothing moves). See the header. */
export function moneyReviewReasons(job,{hubUnifiedTotals=false}={}) {
  const {invoice,...after}=job,reasons=[];
  try {
    if(!saved(job.payment?.amount)&&(saved(invoice?.paid)||saved(invoice?.amountPaid)))reasons.push('paid_only_on_invoice');
    else if(moneyFigures(job)!==moneyFigures(after))reasons.push('money_totals_change');
    if(!Object.is(hubBoardTotal(job),hubBoardTotal(after))&&!(hubUnifiedTotals&&boardReadsCore(job)))reasons.push('hub_total_changes');
    if(tipRefusal(job)!==tipRefusal(after))reasons.push('tip_offer_changes');
    if(visitPriceBlocker(job)!==visitPriceBlocker(after))reasons.push('price_lock_changes');
  } catch { return ['money_unreadable']; }
  return reasons;
}

/** Pure plan from one complete jobs snapshot. */
export function planNumberlessInvoiceBackfill(jobs,{hubUnifiedTotals=false}={}) {
  if(!Array.isArray(jobs))throw fail('input_invalid','A complete job list is required.');
  const report={scanned:jobs.length,skippedRecords:0,withInvoice:0,needsReview:[],numberedNotIssued:[]},writes=[];
  for(const job of jobs) {
    if(!moneyJob(job)){report.skippedRecords++;continue;}
    const invoice=job.invoice;
    if(!plain(invoice))continue;
    report.withInvoice++;
    if(numbered(invoice)&&!invoice.issuedAt&&invoice.source!=='jobber_import')report.numberedNotIssued.push({id:job.id,number:invoice.number.trim().slice(0,80),...summary(invoice)});
    if(!numberlessInvoice(job))continue;
    const unknown=Object.keys(invoice).filter(key=>given(invoice[key])&&!WRITTEN_FIELDS.includes(key)&&!['number','issuedAt'].includes(key));
    const reasons=[...(unknown.length?['unknown_fields']:[]),...moneyReviewReasons(job,{hubUnifiedTotals})];
    if(reasons.length){report.needsReview.push({id:job.id,reasons,...(unknown.length?{fields:unknown.sort().slice(0,20)}:{}),...summary(invoice)});continue;}
    writes.push({id:job.id,revision:job.revision,before:{invoice:structuredClone(invoice)},preview:summary(invoice)});
  }
  writes.sort(byId);report.needsReview.sort(byId);report.numberedNotIssued.sort(byId);
  return {writes,report};
}

function batchWrites(group,{runId,now}) {
  const requestId=randomUUID().toLowerCase();
  const audits=group.map(row=>auditWrite({actor:{id:ACTOR,kind:'system'},via:'cron',action:'money.invoice.numberless_backfill',entity:{collection:'jobs',id:row.id},before:row.before,after:{invoice:null},requestId,reason:'Removed an invoice a payment wrote without issuing it (no number, no issue time). Payments and the ledger are unchanged.',now}));
  return {requestId,writes:[...group.map(row=>({collection:'jobs',id:row.id,revision:row.revision,patch:{},remove:['invoice']})),...audits,
    {collection:MONEY_RECEIPTS,id:requestId,patch:{scope:'numberless_invoice_backfill',action:'invoice.numberless_backfill',actorId:ACTOR,requestId,runId,createdAt:now,targets:group.map(row=>({id:row.id,revision:row.revision,before:row.preview}))}}]};
}

export async function runNumberlessInvoiceBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=50,hubUnifiedTotals=false}={}) {
  const plan=planNumberlessInvoiceBackfill(await store.jobs(),{hubUnifiedTotals});
  const committed=[],changed=[],receipts=[];
  const result=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,hubUnifiedTotals,jobs:plan.report,
    preview:plan.writes.map(({id,preview})=>({id,...preview})),
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
    return result({aborted:{code:error.code||'numberless_invoice_backfill_failed',message:'The backfill stopped before finishing. Rerun it; jobs already cleared are not listed again and their receipts are listed.'}});
  }
  return result({});
}

export function parseArgs(argv) {
  const options={apply:false,report:'',help:false,hubUnifiedTotals:false};let dryRun=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--apply')options.apply=true;
    else if(arg==='--dry-run')dryRun=true;
    else if(arg==='--hub-unified-totals')options.hubUnifiedTotals=true;
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
  if(options.help){console.error('Usage: node scripts/backfill-numberless-invoices.mjs [--dry-run|--apply] [--hub-unified-totals] [--report <file>]\nDry run is the default; --apply removes invoices no one issued (no number, no issue time) whose removal moves no money figure, with updateTime preconditions, an audit entry and a receipt. Pass --hub-unified-totals only once MONEY_API_ENABLED and MONEY_UNIFIED_TOTALS are both "true" (the Hub board then reads money-core totals).');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runNumberlessInvoiceBackfill(moneyStorage(env),{apply:options.apply,hubUnifiedTotals:options.hubUnifiedTotals,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {writes,jobs}=report;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${writes.committed}/${writes.planned} numberless invoices removed; ${jobs.needsReview.length} need review (jobs.needsReview[].reasons; never written), ${jobs.numberedNotIssued.length} numbered but never issued (listed only), ${writes.changedDuringRun.length} changed during the run.${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
