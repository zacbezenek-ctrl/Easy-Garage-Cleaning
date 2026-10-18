/** Builder quotes to save again (owner decisions D-JUNK and D-LABOR-TEXT, 2026-10-18). READ ONLY: it never writes.
 *
 * A quote builder quote sent before those Labor rules carries a Labor line priced by the earlier ones: its estimate
 * counted truck-load time the truck price already pays, its line named the man-hours, and a junk-only quote had one at
 * all. Since the rules, such a quote that the customer has not approved is treated as unsent (quote-model.js
 * staleBuilderQuote): the portal shows it as being updated and nothing can approve or pay it. This lists them so the
 * office reopens each one (Walkthroughs > the quote, or the walkthrough's Send options for review > Edit quote), saves it
 * again in the builder (the Labor line follows the new rules) and sends it, and tells the customer a corrected quote is
 * on its way. Quotes the customer approved, and jobs signed in person, keep what was agreed and are not listed.
 *
 *   node scripts/stale-builder-quotes.mjs
 *   node scripts/stale-builder-quotes.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. Exit code 1 when any quote needs saving again. The report lists job IDs
 * (masked when they embed a phone or email), estimate numbers and revisions and the reason, never names or amounts. */
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {BUILDER_LABOR_VERSION,staleBuilderQuote} from '../functions/_lib/quote-model.js';
import {backfillStorage,maskId,writeReport} from './backfill-customer-identity.mjs';

// What staleBuilderQuote() reads.
export const AUDIT_FIELDS=['type','recordType','quoteDraft','estimate','customerApproval','compositeQuote'];

/** Pure report from one complete jobs snapshot. sent: the customer was sent this revision (estimate.status 'sent'); the
 * others are unsent drafts, already withheld, which the estimator saves again before sending. */
export function staleBuilderQuoteReport(jobs,{now=new Date(),runId=randomUUID()}={}) {
  if(!Array.isArray(jobs))throw Object.assign(new Error('A complete job list is required.'),{code:'stale_builder_quotes_input_invalid'});
  const rows=jobs.filter(job=>job&&typeof job.id==='string'&&!/^(_egc_|secure_)/.test(job.id)&&!job.recordType&&staleBuilderQuote(job)).map(job=>{
    const labor=job.quoteDraft.breakdown.labor;
    return {id:maskId(job.id),estimate:String(job.estimate?.number||'').slice(0,80),revision:Number.isSafeInteger(job.estimate?.revision)?job.estimate.revision:null,
      sent:String(job.estimate?.status||'').toLowerCase()==='sent',reason:labor.version!==BUILDER_LABOR_VERSION?'labor_before_2026_10_18':'junk_only_with_labor'};
  }).sort((a,b)=>Number(b.sent)-Number(a.sent)||a.id.localeCompare(b.id));
  return {mode:'read_only',runId,generatedAt:now.toISOString(),jobs:{scanned:jobs.length},quotes:{count:rows.length,sent:rows.filter(row=>row.sent).length,rows}};
}

function parseArgs(argv) {
  const options={report:'',help:false};
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--report'&&argv[i+1]&&!argv[i+1].startsWith('--'))options.report=argv[++i];
    else if(argv[i]==='--help'||argv[i]==='-h')options.help=true;
    else throw new Error('Unknown or incomplete argument: '+argv[i]);
  }
  return options;
}

async function main() {
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/stale-builder-quotes.mjs [--report <file>]\nRead only; exit code 1 when a builder quote priced before the Labor rules of 2026-10-18 must be saved again and sent.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=staleBuilderQuoteReport(await backfillStorage(env).jobs(AUDIT_FIELDS));}
  catch(error){console.error(error.code?error.message:'The list could not read the complete jobs records. Rerun it.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report) {
    try{await writeReport(options.report,json);}
    catch{console.error('The report file could not be written privately, so it was not saved.');process.exitCode=1;}
  }
  process.stdout.write(json+'\n');
  console.error(report.quotes.count?`${report.quotes.count} builder quotes (${report.quotes.sent} sent to the customer) must be saved again in the quote builder and sent.`:'No builder quote waits to be saved again.');
  if(report.quotes.count)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
