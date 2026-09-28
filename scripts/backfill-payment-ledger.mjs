/** Payment ledger backfill (M3). DRY RUN BY DEFAULT: scans jobs and reports the
 * job.paymentLedger[] each job would get, without writing anything.
 *
 * The ledger itemizes the recorded paid total (payment.amount, which stays
 * authoritative for every existing reader): one entry per verified Stripe
 * session in payment.stripeSessions (and gift credit), entries recorded through
 * /api/money, and ONE 'legacy:manual' aggregate for the rest of the recorded
 * money (manual payments saved before the ledger existed). The money API
 * derives the same ledger on read, so this backfill only persists it; jobs are
 * never required to have one.
 *
 * `--apply` writes ONLY the ledger fields (paymentLedger, paymentLedgerVersion,
 * paymentLedgerStatus, paymentLedgerIssues, paymentLedgerUpdatedAt) for jobs
 * whose ledger reconciles cleanly. Each job write carries its Firestore
 * updateTime precondition (a job saved meanwhile is skipped and reported, never
 * overwritten) and joins a hub_audit entry and a moneyOperations/<requestId>
 * receipt in the same commit. Jobs whose evidence needs review (unverified card
 * payments, conflicting receipts, refunds, unreadable money) are listed and
 * never written. It also reserves each existing invoice number in
 * moneyInvoiceNumbers (create-only) so a new invoice can never reuse it; a
 * number two jobs already share is reported instead. Re-running after an
 * apply is a no-op.
 *
 * jobs.needsVerification lists jobs whose recorded money is not marked
 * verified (paymentNeedsVerification, the rule the portal and crew payments
 * already follow). With MONEY_API_ENABLED on, /api/money records no new money
 * on them until the owner confirms each against the check, bank or Stripe
 * record and sets payment.verified (and deposit.verified) to true on the job.
 *
 *   node scripts/backfill-payment-ledger.mjs                 # dry run
 *   node scripts/backfill-payment-ledger.mjs --apply         # write
 *   node scripts/backfill-payment-ledger.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report holds job IDs, invoice
 * numbers, cents and issue codes only (no customer details). */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {auditWrite} from '../functions/_lib/hub-audit.js';
import {LEDGER_VERSION,ledgerPatch,reconcileLedger} from '../functions/_lib/money-ledger.js';
import {INVOICE_NUMBERS,MONEY_RECEIPTS,invoiceNumberId,moneyJob,paymentNeedsVerification} from '../functions/_lib/money-service.js';
import {moneyStorage} from '../functions/_lib/money-storage.js';

const ACTOR='payment-ledger-backfill';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:plain(value)?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value??null);
const byId=(a,b)=>String(a.id||a).localeCompare(String(b.id||b));
const fail=(code,message)=>Object.assign(new Error(message),{code:'payment_ledger_backfill_'+code});
const summary=ledger=>({entries:ledger.entries.length,paidCents:ledger.paidCents,itemizedCents:ledger.itemizedCents,legacyCents:ledger.legacyCents,stripeEntries:ledger.entries.filter(row=>row.source==='stripe_session').length});
const current=(job,ledger)=>Array.isArray(job.paymentLedger)&&job.paymentLedgerVersion===LEDGER_VERSION&&job.paymentLedgerStatus==='complete'&&Array.isArray(job.paymentLedgerIssues)&&!job.paymentLedgerIssues.length&&canonical(job.paymentLedger)===canonical(ledger.entries);

/** Pure plan from one complete jobs snapshot. */
export function planPaymentLedgerBackfill(jobs) {
  if(!Array.isArray(jobs))throw fail('input_invalid','A complete job list is required.');
  const report={scanned:jobs.length,skippedRecords:0,noPayments:0,current:0,needsReview:[],needsVerification:[]},writes=[],numbers=new Map();
  for(const job of jobs) {
    if(!moneyJob(job)){report.skippedRecords++;continue;}
    const number=typeof job.invoice?.number==='string'?job.invoice.number.trim():'';
    if(number)numbers.set(number,[...(numbers.get(number)||[]),job.id]);
    const ledger=reconcileLedger(job);
    if(paymentNeedsVerification(job))report.needsVerification.push({id:job.id,paidCents:ledger.paidCents});
    if(!ledger.complete){report.needsReview.push({id:job.id,issues:ledger.issues,unreconciledCents:ledger.unreconciledCents});continue;}
    if(current(job,ledger)){report.current++;continue;}
    if(!ledger.entries.length&&job.paymentLedger===undefined){report.noPayments++;continue;}
    writes.push({id:job.id,revision:job.revision,ledger,before:{status:job.paymentLedgerStatus??null,entries:Array.isArray(job.paymentLedger)?job.paymentLedger.length:null},after:summary(ledger)});
  }
  const invoiceNumbers=[],duplicateInvoiceNumbers=[];
  for(const [number,ids] of numbers){if(ids.length>1)duplicateInvoiceNumbers.push({number,jobIds:ids.sort()});else invoiceNumbers.push({number,jobId:ids[0]});}
  writes.sort(byId);report.needsReview.sort(byId);report.needsVerification.sort(byId);invoiceNumbers.sort((a,b)=>a.number.localeCompare(b.number));duplicateInvoiceNumbers.sort((a,b)=>a.number.localeCompare(b.number));
  return {writes,invoiceNumbers,duplicateInvoiceNumbers,report};
}

function batchWrites(group,{runId,now}) {
  const requestId=randomUUID().toLowerCase();
  const audits=group.map(row=>auditWrite({actor:{id:ACTOR,kind:'system'},via:'cron',action:'money.ledger.backfill',entity:{collection:'jobs',id:row.id},before:row.before,after:row.after,requestId,reason:'Payment ledger backfill',now}));
  return {requestId,writes:[...group.map(row=>({collection:'jobs',id:row.id,revision:row.revision,patch:ledgerPatch(row.ledger,now)})),...audits,
    {collection:MONEY_RECEIPTS,id:requestId,patch:{scope:'payment_ledger_backfill',action:'ledger.backfill',actorId:ACTOR,requestId,runId,createdAt:now,targets:group.map(row=>({id:row.id,revision:row.revision,before:row.before,after:row.after}))}}]};
}

export async function runPaymentLedgerBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=50}={}) {
  const plan=planPaymentLedgerBackfill(await store.jobs());
  const reserve=[],reserved=[],reservedByOther=[],committed=[],changed=[],receipts=[];
  for(const row of plan.invoiceNumbers) {
    const saved=await store.read(INVOICE_NUMBERS,invoiceNumberId(row.number));
    if(!saved)reserve.push(row);else if(saved.jobId!==row.jobId)reservedByOther.push({...row,reservedFor:saved.jobId});
  }
  const result=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,jobs:plan.report,
    preview:plan.writes.map(({id,before,after})=>({id,before,after})),
    invoiceNumbers:{toReserve:reserve.map(row=>row.number),alreadyReserved:plan.invoiceNumbers.length-reserve.length-reservedByOther.length,reservedByOther,duplicates:plan.duplicateInvoiceNumbers},
    writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort(),reservationsPlanned:reserve.length,reservationsCommitted:reserved.length,receipts:[...receipts]},...extra});
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
    for(const row of reserve) {
      try{await store.commit([{collection:INVOICE_NUMBERS,id:invoiceNumberId(row.number),patch:{number:row.number,jobId:row.jobId,reservedAt:now,source:'backfill',runId}}]);reserved.push(row.number);}
      catch(error) {
        const saved=await store.read(INVOICE_NUMBERS,invoiceNumberId(row.number)).catch(()=>null);
        if(saved?.jobId===row.jobId&&saved.runId===runId)reserved.push(row.number);
        else if(error.code!=='money_revision_conflict')throw error;
      }
    }
  } catch(error) {
    return result({aborted:{code:error.code||'payment_ledger_backfill_failed',message:'The backfill stopped before finishing. Rerun it; jobs already backfilled are skipped and their receipts are listed.'}});
  }
  return result({});
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
  if(options.help){console.error('Usage: node scripts/backfill-payment-ledger.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply writes clean ledgers with updateTime preconditions, an audit entry and a receipt.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runPaymentLedgerBackfill(moneyStorage(env),{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  const {writes,jobs,invoiceNumbers}=report;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${writes.committed}/${writes.planned} job ledgers written, ${writes.reservationsCommitted}/${writes.reservationsPlanned} invoice numbers reserved; ${jobs.current} already current, ${jobs.needsReview.length} need review, ${jobs.needsVerification.length} have unverified payments, ${invoiceNumbers.duplicates.length} duplicate invoice numbers, ${writes.changedDuringRun.length} changed during the run.${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
