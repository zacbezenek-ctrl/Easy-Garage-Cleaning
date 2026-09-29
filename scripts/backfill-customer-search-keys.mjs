/** Customer search-key backfill (P1-DS-14). DRY RUN BY DEFAULT: scans customers and
 * prints how many need the derived searchKeys (phone digits, email and name word
 * prefixes) that the indexed dispatch customer search queries, and which keyed
 * customers were edited without them (staleKeys), without writing anything. `--apply` writes only searchKeys, searchKeysVersion and
 * searchKeysUpdatedAt on customers whose saved keys are missing or stale, each
 * fenced on that customer's revision. Names, phones and emails never change.
 * With EGC_DISPATCH_WINDOWED_READS=true the index answers only while every
 * customer carries current keys (otherwise search scans as before), so run this
 * before switching it on and again after a bulk import such as the Jobber
 * cutover. Hub customer creation writes the keys itself; a rerun with nothing
 * changed writes nothing.
 *
 *   node scripts/backfill-customer-search-keys.mjs                  # dry run
 *   node scripts/backfill-customer-search-keys.mjs --apply          # write
 *   node scripts/backfill-customer-search-keys.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. The report lists counts and customer
 * IDs (masked when they embed a phone or email), never names, phones or emails. */
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {customerSearchPatch,SEARCH_KEYS_VERSION} from '../functions/_lib/customer-identity.js';
import {maskId,parseArgs,writeReport} from './backfill-customer-identity.mjs';

const CUSTOMER_FIELDS=['name','firstName','lastName','phone','email','searchKeys','searchKeysVersion'];
const MAX_COMMIT_WRITES=450;
const fail=(code,message)=>Object.assign(new Error(message),{code:'customer_search_keys_backfill_'+code});

/** Pure plan from one complete customers snapshot: one revision-fenced key write
 * per customer whose keys are missing or stale. Every customer is keyed, because
 * the index is used only when all of them are. staleKeys lists customers whose
 * keys carry the current version but no longer match their name, phone or
 * email (edited without customerSearchPatch): coverage cannot see those, so a
 * nonempty list means a writer needs fixing as well as this rerun. */
export function planCustomerSearchKeys(customers,now) {
  const writes=[],unsearchable=[],stale=[];
  for(const row of customers) {
    const patch=customerSearchPatch(row,now);
    if(patch&&!patch.searchKeys.length)unsearchable.push(row.id);
    if(patch&&row.searchKeysVersion===SEARCH_KEYS_VERSION)stale.push(row.id);
    if(patch)writes.push({collection:'customers',id:row.id,revision:row.revision,patch});
  }
  writes.sort((a,b)=>a.id.localeCompare(b.id));
  return {writes,report:{customers:{scanned:customers.length,current:customers.length-writes.length,needsKeys:writes.length,staleKeys:stale.sort().map(maskId),withoutSearchableDetails:unsearchable.sort().map(maskId)}}};
}

export async function runCustomerSearchKeysBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=100}={}) {
  const customers=await store.customerRecords(CUSTOMER_FIELDS);
  if(!Array.isArray(customers)||customers.some(row=>typeof row?.id!=='string'||!row.id||typeof row.revision!=='string'||!row.revision))throw fail('storage_incomplete','The complete customer records could not be verified.');
  const plan=planCustomerSearchKeys(customers,now),committed=[],changed=[];
  const summary=extra=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,...plan.report,writes:{planned:plan.writes.length,committed:committed.length,changedDuringRun:[...changed].sort().map(maskId)},...extra});
  if(!apply)return summary();
  const size=Math.max(1,Math.min(Math.trunc(batchSize)||1,MAX_COMMIT_WRITES));
  try {
    for(let start=0;start<plan.writes.length;start+=size) {
      const batch=plan.writes.slice(start,start+size);
      try{await store.commit(batch);committed.push(...batch.map(write=>write.id));continue;}
      catch(error){if(error.code!=='dispatch_revision_conflict')throw error;}
      // A customer edited during the run skips only itself; a rerun picks it up.
      for(const write of batch) {
        try{await store.commit([write]);committed.push(write.id);}
        catch(error){if(error.code!=='dispatch_revision_conflict')throw error;changed.push(write.id);}
      }
    }
  } catch(error) {
    return summary({aborted:{code:error.code||'customer_search_keys_backfill_failed',message:'The backfill stopped before finishing. Rerun it: it reads every customer again and writes only the keys still missing.'}});
  }
  return summary();
}

async function main() {
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/backfill-customer-search-keys.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply writes with revision preconditions.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runCustomerSearchKeysBackfill(dispatchStorage(env),{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete customer records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report) {
    try{await writeReport(options.report,json);}
    catch{console.error('The report file could not be written privately, so it was not saved.');process.exitCode=1;}
  }
  process.stdout.write(json+'\n');
  const w=report.writes;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: ${w.committed}/${w.planned} customers given search keys; ${report.customers.current} already current.${report.customers.staleKeys.length?` ${report.customers.staleKeys.length} customers had outdated keys: find the edit path that skipped customerSearchPatch.`:''}${w.changedDuringRun.length?` ${w.changedDuringRun.length} customers changed during the run; rerun to pick them up.`:''}${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
