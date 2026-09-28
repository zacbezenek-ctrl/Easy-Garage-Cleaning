/** business_operations TTL backfill (B2B-HARDEN). DRY RUN BY DEFAULT: scans business_operations and reports the records
 * written before `expireAt` existed (requestId receipts and invitation email cap records), without writing anything.
 *
 * The Firestore TTL policy on business_operations.expireAt deletes only records that carry that timestamp, so records
 * written before B2B-HARDEN are otherwise kept forever. `--apply` writes ONLY `expireAt` on them, the same value the hub
 * writes today, each fenced on the updateTime the scan saw (a record rewritten meanwhile already carries its own
 * expireAt; it is skipped and reported, never overwritten):
 *   - a requestId receipt: its `at` plus RECEIPT_DAYS;
 *   - an invitation email cap record (kind 'invite_email_quota'): one rolling day after the later of its updatedAt and
 *     its newest send.
 * A record whose time cannot be read is never written; it is listed for review. A date already in the past is written
 * as it is, so the TTL policy then removes that record, which changes no answer: an expired receipt's page closed long
 * ago and an expired cap record counts nothing. Re-running after an apply is a no-op.
 *
 *   node scripts/business-operations-ttl-backfill.mjs                 # dry run
 *   node scripts/business-operations-ttl-backfill.mjs --apply         # write
 *   node scripts/business-operations-ttl-backfill.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report holds record ids (request ids and hashes) and counts only: no
 * names, emails, account or member ids. */
import {pathToFileURL} from 'node:url';
import {firestoreFetch,firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {decodeFirestoreFields,encodeFirestoreFields} from '../functions/_lib/firestore-job.js';
import {commitConflict,commitFailure} from '../functions/_lib/firestore-errors.js';
import {receiptExpiry,quotaExpiry} from '../functions/_lib/business-hub-core.js';
import {scanBusinessCollection} from './business-members-scope-export.mjs';
import {parseArgs,writeReport} from './backfill-customer-identity.mjs';

const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const BASE=`https://firestore.googleapis.com/v1/${ROOT}`;
const FIELDS=['action','at','kind','sends','updatedAt','expireAt'];
const MAX_COMMIT_WRITES=450;
const fail=(code,message)=>Object.assign(new Error(message),{code:'business_operations_ttl_backfill_'+code});
const valid=date=>Number.isFinite(date.getTime())?date:null;

/** The expireAt the hub writes today for this legacy record, or null when its time cannot be read. */
export function legacyExpireAt(row){
  if(row.kind==='invite_email_quota'){
    const sends=Array.isArray(row.sends)?row.sends:[],updated=Date.parse(row.updatedAt);
    if(!Number.isFinite(updated)&&!sends.some(entry=>Number.isFinite(entry?.at)))return null;
    return valid(quotaExpiry(sends,Number.isFinite(updated)?updated:-Infinity));
  }
  if(row.kind===undefined&&typeof row.action==='string'&&typeof row.at==='string'){const at=Date.parse(row.at);return Number.isFinite(at)?valid(receiptExpiry(at)):null;}
  return null;
}

/** Pure plan from one complete business_operations scan (raw Firestore documents): one expireAt write per legacy record. */
export function planOperationsTtl(documents,now){
  const nowMs=Date.parse(now);
  if(!Array.isArray(documents)||!Number.isFinite(nowMs))throw fail('input_invalid','A complete business_operations scan and a valid current time are required.');
  const writes=[],report={scanned:documents.length,current:0,receipts:0,quotas:0,alreadyPast:0,unrecognized:[]};
  for(const document of documents){
    if(typeof document?.fields?.expireAt?.timestampValue==='string'){report.current++;continue;}
    const row=decodeFirestoreFields(document?.fields||{}),expireAt=legacyExpireAt(row);
    if(!expireAt||typeof document.updateTime!=='string'){report.unrecognized.push(document.id);continue;}
    report[row.kind==='invite_email_quota'?'quotas':'receipts']++;
    if(expireAt.getTime()<=nowMs)report.alreadyPast++;
    writes.push({id:document.id,updateTime:document.updateTime,expireAt});
  }
  writes.sort((a,b)=>a.id.localeCompare(b.id));report.unrecognized.sort();
  return {writes,report};
}

const commitBody=group=>JSON.stringify({writes:group.map(row=>({update:{name:`${ROOT}/business_operations/${row.id}`,fields:encodeFirestoreFields({expireAt:row.expireAt})},updateMask:{fieldPaths:['expireAt']},currentDocument:{updateTime:row.updateTime}}))});

export async function runOperationsTtlBackfill(env,{fetcher=firestoreFetch,apply=false,now=new Date().toISOString(),batchSize=100}={}){
  const documents=await scanBusinessCollection(env,fetcher,{collection:'business_operations',fields:FIELDS,id:/^[a-f0-9]{32,64}$/,code:'business_operations_ttl_backfill_scan_failed',outcome:'Nothing was written.'});
  const plan=planOperationsTtl(documents,now),committed=[],changed=[];
  const summary=extra=>({mode:apply?'apply':'dry_run',generatedAt:now,operations:plan.report,writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort()},...extra});
  if(!apply)return summary({});
  // True when committed, false when a record moved since the scan (nothing in that commit was applied).
  async function commit(group){
    const response=await fetcher(env,`${BASE}:commit`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(30000),body:commitBody(group)});
    if(response.ok)return true;
    if(commitConflict(await commitFailure(response)))return false;
    throw fail('commit_failed','A business_operations commit was refused.');
  }
  const size=Math.max(1,Math.min(Math.trunc(batchSize)||1,MAX_COMMIT_WRITES));
  try{
    for(let start=0;start<plan.writes.length;start+=size){
      const batch=plan.writes.slice(start,start+size);
      if(await commit(batch)){committed.push(...batch.map(row=>row.id));continue;}
      // One record rewritten during the run (it now has its own expireAt) must not block the rest.
      for(const row of batch){if(await commit([row]))committed.push(row.id);else changed.push(row.id);}
    }
  }catch(error){
    return summary({aborted:{code:error.code||'business_operations_ttl_backfill_failed',message:'The backfill stopped before finishing. Rerun it; records already given expireAt are skipped.'}});
  }
  return summary({});
}

async function main(){
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/business-operations-ttl-backfill.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply writes only expireAt, with updateTime preconditions.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runOperationsTtlBackfill(env,{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'business_operations could not be read. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeReport(options.report,json);
  process.stdout.write(json+'\n');
  const {operations,writes}=report;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${writes.committed}/${writes.planned} business_operations records given expireAt (${operations.receipts} receipts, ${operations.quotas} email cap records; ${operations.alreadyPast} already past, which the TTL policy then removes); ${operations.current} already had it, ${operations.unrecognized.length} unrecognized, ${writes.changedDuringRun.length} changed during the run.${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
