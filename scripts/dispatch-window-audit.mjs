/** Windowed dispatch read audit (P1-DS-14). READ ONLY: it never writes. Runs the
 * complete jobs scan and the windowed dispatch queries for today's Denver window,
 * then reports every row the complete scan treats as conflict evidence that the
 * windowed queries cannot find: a malformed date string that sorts before the
 * window floor, a non-string date or endDate, or no date field at all. With
 * EGC_DISPATCH_WINDOWED_READS=true such rows are not conflict evidence and do not
 * show on the board, so run this weekly and after any import (the browser SDK
 * and imports can still write such rows), and repair each reported job's date
 * in the Hub. Shadow mode reports the same rows per request
 * (dispatch_window_shadow).
 *
 *   node scripts/dispatch-window-audit.mjs
 *   node scripts/dispatch-window-audit.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. Exit code 1 when any row is missing.
 * The report lists counts and job IDs (masked when they embed a phone or
 * email), never names, addresses, phones or emails. */
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {denverToday,addDays} from '../functions/_lib/dispatch-time.js';
import {windowDiff,windowFloor} from '../functions/_lib/dispatch-window-reads.js';
import {backfillStorage,maskId,writeReport} from './backfill-customer-identity.mjs';

// What windowRelevant() reads; the scan never loads job bodies.
export const AUDIT_FIELDS=['type','recordType','date','endDate'];

/** `jobs()` is the complete scan and `jobsNear(startDate,endDate)` the windowed
 * read dispatch uses; `now` is a Date. */
export async function runDispatchWindowAudit({jobs,jobsNear},{now=new Date(),runId=randomUUID()}={}) {
  const startDate=denverToday(now),endDate=addDays(startDate,1);
  const [full,near]=await Promise.all([jobs(),jobsNear(startDate,endDate)]);
  const {missing}=windowDiff(full,near,startDate),byReason={};
  for(const {reason} of missing)byReason[reason]=(byReason[reason]||0)+1;
  return {mode:'read_only',runId,generatedAt:now.toISOString(),startDate,floor:windowFloor(startDate),jobs:{scanned:full.length,windowed:near.length},
    missing:{count:missing.length,byReason,jobIds:missing.map(row=>maskId(row.id)).sort()}};
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
  if(options.help){console.error('Usage: node scripts/dispatch-window-audit.mjs [--report <file>]\nRead only; exit code 1 when a job the windowed reads cannot find needs its date repaired.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  const scan=backfillStorage(env),windowed=dispatchStorage({...env,EGC_DISPATCH_WINDOWED_READS:'true'});
  let report;
  try{report=await runDispatchWindowAudit({jobs:()=>scan.jobs(AUDIT_FIELDS),jobsNear:windowed.jobsNear});}
  catch(error){console.error(error.code?error.message:'The audit could not read the complete jobs records. Rerun it.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report) {
    try{await writeReport(options.report,json);}
    catch{console.error('The report file could not be written privately, so it was not saved.');process.exitCode=1;}
  }
  process.stdout.write(json+'\n');
  console.error(report.missing.count?`${report.missing.count} jobs are conflict evidence only in the complete scan; repair their dates in the Hub.`:'Every job the complete scan uses as conflict evidence is in the windowed reads.');
  if(report.missing.count)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
