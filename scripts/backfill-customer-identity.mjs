/** Customer identity backfill (P4-02). DRY RUN BY DEFAULT: scans customers and jobs,
 * then prints the plan and a manager-review report without writing anything.
 * `--apply` writes only (1) derived phoneE164/emailLower keys on customers and
 * (2) customerId on legacy jobs whose CRM contact/phone/email evidence names exactly
 * one customer. A lone phone or email match also needs a matching name or street.
 * A link never gives a customer a second account root. Related links commit
 * together, fenced on every record the plan relied on plus the shared customer
 * identity and dispatch revisions. Customers are never merged, renamed or deleted.
 * Re-running after an apply is a no-op.
 *
 *   node scripts/backfill-customer-identity.mjs                  # dry run
 *   node scripts/backfill-customer-identity.mjs --apply          # write
 *   node scripts/backfill-customer-identity.mjs --report out.json
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON. Phone/email values and phone- or
 * email-shaped customer IDs are masked, but the report still names records:
 * keep it private. */
import {randomUUID} from 'node:crypto';
import {rm,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firestoreFetch,firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {decodeFirestoreFields} from '../functions/_lib/firestore-job.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {customerIdentityFields,customerIdentityPatch,normalizeEmail,normalizePhoneE164,operationalJob} from '../functions/_lib/customer-identity.js';

const BASE='https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const CUSTOMER_FIELDS=['phone','email','phoneE164','emailLower','highlevelContactId','name','firstName','lastName','address'];
const REFERENCES=['customerAccountOwnerJobId','customerMemoryInheritedFrom','sourceWalkthroughId','recurrenceParentId','sourceTemplateJobId'];
const JOB_FIELDS=['type','recordType','customerId','highlevelContactId','phone','email','customer','customerName','name','address','projectId',...REFERENCES];
// Dispatch lineage (resolveDispatchLineage) resolves account roots over these types only.
const ROOT_TYPES=new Set(['job','cleanout','reorg']);
const MAX_COMMIT_WRITES=450;
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!/^(_egc_|secure_)/.test(value);
const present=value=>typeof value==='string'?Boolean(value.trim()):typeof value==='number';
const fail=(code,message)=>Object.assign(new Error(message),{code:'customer_identity_backfill_'+code});
const sorted=list=>[...list].sort((a,b)=>String(a.jobId||a).localeCompare(String(b.jobId||b)));
const words=value=>typeof value==='string'?value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(' ').filter(Boolean):[];
export const maskPhone=value=>value?(value.startsWith('+1')?'+1':'+')+'…'+value.slice(-4):'';
export const maskEmail=value=>{const at=value.lastIndexOf('@');return at>0?value[0]+'…'+value.slice(at):'';};
// Legacy gameplan customer IDs embed the phone (egc_<digits>); unsafe legacy IDs can be an email.
export const maskId=value=>{const id=String(value??'');return /^egc_\d{10,15}$/.test(id)?'egc_…'+id.slice(-4):id.includes('@')?maskEmail(id)||'…':id;};

/** Complete masked scans; a partial page or repeated token aborts before planning. */
export function backfillStorage(env,fetcher=firestoreFetch) {
  const base=dispatchStorage(env,fetcher);
  async function scan(collection,fields) {
    const rows=[],ids=new Set(),tokens=new Set(),prefix=`/documents/${collection}/`;let token='';
    for(let page=0;page<1000;page++) {
      const url=new URL(`${BASE}/${collection}`);url.searchParams.set('pageSize','300');if(token)url.searchParams.set('pageToken',token);
      for(const field of fields)url.searchParams.append('mask.fieldPaths',field);
      let response;try{response=await fetcher(env,url.toString(),{signal:AbortSignal.timeout(30000)});}catch{throw fail('storage_unavailable',`The ${collection} scan could not be read. Rerun the backfill.`);}
      if(!response.ok)throw fail('storage_unavailable',`The ${collection} scan could not be read. Rerun the backfill.`);
      const data=await response.json().catch(()=>null);
      if(!data||typeof data!=='object'||Array.isArray(data)||data.documents!==undefined&&!Array.isArray(data.documents)||data.nextPageToken!==undefined&&typeof data.nextPageToken!=='string')throw fail('storage_incomplete',`The ${collection} scan returned an incomplete page. Nothing was planned.`);
      for(const document of data.documents||[]) {
        const name=document?.name,id=typeof name==='string'&&name.includes(prefix)?name.slice(name.indexOf(prefix)+prefix.length):'';
        if(!id||id.includes('/')||ids.has(id)||typeof document.updateTime!=='string'||!document.updateTime)throw fail('storage_incomplete',`The ${collection} scan returned a record without a verifiable identity or revision.`);
        ids.add(id);rows.push({...decodeFirestoreFields(document.fields||{}),id,revision:document.updateTime});
      }
      token=data.nextPageToken||'';
      if(!token)return rows;
      if(tokens.has(token))throw fail('storage_incomplete',`The ${collection} scan did not finish.`);
      tokens.add(token);
    }
    throw fail('storage_incomplete',`The ${collection} scan did not finish.`);
  }
  return {read:base.read,commit:base.commit,customers:()=>scan('customers',CUSTOMER_FIELDS),jobs:(fields=JOB_FIELDS)=>scan('jobs',fields)};
}

function identityConflict(keys,customer,viaContact) {
  // A job naming a CRM contact links only to the customer holding that contact;
  // that saved provider link is authoritative, as in customer resolution.
  if(viaContact)return '';
  if(keys.crm_contact)return customer.highlevelContactId?'crm_contact_mismatch':'crm_contact_unmatched';
  if(keys.phone&&customer.phoneE164&&keys.phone!==customer.phoneE164)return 'phone_mismatch';
  if(keys.email&&customer.emailLower&&keys.email!==customer.emailLower)return 'email_mismatch';
  return '';
}

const customerName=row=>typeof row.name==='string'&&row.name.trim()?row.name:[row.firstName,row.lastName].filter(value=>typeof value==='string').join(' ');
// First and last name must both agree; a lone first name or an initial never confirms.
function sameName(left,right) {const a=words(left),b=words(right);return a.length>1&&b.length>1&&a[0]===b[0]&&a.at(-1)===b.at(-1);}
// The street line (before the first comma), house number included, must agree exactly.
function sameStreet(left,right) {const a=words(typeof left==='string'?left.split(',')[0]:''),b=words(typeof right==='string'?right.split(',')[0]:'');return /\d/.test(a.join(''))&&a.join(' ')===b.join(' ');}
/** A lone phone or email can be a recycled number or a shared inbox, so it links
 * only when the job's name or street also agrees with the customer. */
function corroboration(job,customer) {
  return [...(['customer','customerName','name'].some(field=>sameName(job[field],customerName(customer)))?['name']:[]),...(sameStreet(job.address,customer.address)?['address']:[])];
}

/** Pure plan from one complete snapshot. Ambiguous, conflicting or unconfirmed
 * evidence, lineage that would point related jobs at different customers, and links
 * that would give a customer a second account root are reported only. Links are
 * grouped into lineage components that commit atomically with their fences. */
export function planCustomerIdentityBackfill({customers,jobs,projects=new Map()},now) {
  const byId=new Map(),index={crm_contact:new Map(),phone:new Map(),email:new Map()},customerWrites=[],unusablePhone=[],unusableEmail=[],skipped=[];
  const put=(map,key,id)=>{if(key)map.set(key,[...(map.get(key)||[]),id]);};
  for(const row of customers) {
    const id=String(row?.id??''),fields=customerIdentityFields(row);
    // An unusable ID is never written or linked, but its keys still compete as evidence.
    if(safeId(id)) {
      const patch=customerIdentityPatch(row,now);
      byId.set(id,{...row,...fields});
      if(patch)customerWrites.push({collection:'customers',id,revision:row.revision,patch});
      if(present(row.phone)&&!fields.phoneE164)unusablePhone.push(id);
      if(present(row.email)&&!fields.emailLower)unusableEmail.push(id);
    } else skipped.push(id);
    put(index.crm_contact,safeId(row?.highlevelContactId)?row.highlevelContactId:'',id);put(index.phone,fields.phoneE164,id);put(index.email,fields.emailLower,id);
  }
  const duplicateIdentities=[];
  for(const [field,map] of Object.entries(index))for(const [value,ids] of map)if(ids.length>1)duplicateIdentities.push({field,value:field==='phone'?maskPhone(value):field==='email'?maskEmail(value):value,customerIds:[...ids].sort().map(maskId)});
  const jobsById=new Map(jobs.filter(operationalJob).map(row=>[row.id,row])),proposals=new Map(),ambiguous=[],conflicts=[],unmatched=[];let legacy=0;
  const conflict=(jobId,customerId,reason)=>conflicts.push({jobId,customerId:maskId(customerId),reason});
  for(const job of jobsById.values()) {
    if(job.customerId)continue;
    legacy++;
    const keys={crm_contact:safeId(job.highlevelContactId)?job.highlevelContactId:'',phone:normalizePhoneE164(job.phone),email:normalizeEmail(job.email)};
    const evidence=Object.fromEntries(Object.entries(keys).map(([how,key])=>[how,key?index[how].get(key)||[]:[]]));
    const ids=[...new Set(Object.values(evidence).flat())].sort();
    if(!ids.length){unmatched.push(job.id);continue;}
    if(ids.length>1){ambiguous.push({jobId:job.id,customerIds:ids.map(maskId),evidence:Object.fromEntries(Object.entries(evidence).filter(([,list])=>list.length).map(([how,list])=>[how,[...list].sort().map(maskId)]))});continue;}
    const customer=byId.get(ids[0]);
    if(!customer){conflict(job.id,ids[0],'customer_id_invalid');continue;}
    const matched=Object.keys(evidence).filter(how=>evidence[how].length),lone=matched.length===1&&matched[0]!=='crm_contact',confirmed=lone?corroboration(job,customer):[];
    const reason=identityConflict(keys,customer,evidence.crm_contact.length>0)||(lone&&!confirmed.length?'identity_unconfirmed':'');
    if(reason){conflict(job.id,customer.id,reason);continue;}
    proposals.set(job.id,{customerId:customer.id,evidence:[...matched,...confirmed]});
  }
  const currentCustomer=id=>jobsById.get(id)?.customerId||'',finalCustomer=id=>currentCustomer(id)||proposals.get(id)?.customerId||'',incoming=new Map();
  for(const job of jobsById.values())for(const field of REFERENCES)if(safeId(job[field])&&job[field]!==job.id)incoming.set(job[field],[...(incoming.get(job[field])||[]),job.id]);
  function accountRoot(row,customerId,customerOf) {
    // Mirrors verifiedAccountRoot: every account-owner hop is an operational job of this exact customer.
    const path=[row.id],seen=new Set();let id=row.customerAccountOwnerJobId||row.id;
    for(let depth=0;depth<12;depth++) {
      const hop=jobsById.get(id);
      if(!hop||seen.has(id)||customerOf(id)!==customerId)return {root:'',path};
      seen.add(id);if(!path.includes(id))path.push(id);
      if(!hop.customerAccountOwnerJobId||hop.customerAccountOwnerJobId===id)return {root:id,path};
      id=hop.customerAccountOwnerJobId;
    }
    return {root:'',path};
  }
  function lineageConflict(job,customerId) {
    if(!accountRoot(job,customerId,finalCustomer).root)return 'lineage_conflict';
    for(const field of REFERENCES)if(safeId(job[field])&&job[field]!==job.id&&finalCustomer(job[field])&&finalCustomer(job[field])!==customerId)return 'lineage_conflict';
    if((incoming.get(job.id)||[]).some(id=>finalCustomer(id)&&finalCustomer(id)!==customerId))return 'lineage_conflict';
    const project=safeId(job.projectId)?projects.get(job.projectId):null;
    return project?.customerId&&project.customerId!==customerId?'project_conflict':'';
  }
  // Dispatch, the walkthrough handoff and native booking need an explicit source job
  // once a customer has several account roots, so a link may never add a root to a
  // customer that would then have more than one. Every link on such a path is held.
  function rootConflicts() {
    const rows=new Map(),held=new Set(),key=({root,path})=>root||'broken:'+path[0];
    for(const job of jobsById.values()){const customerId=finalCustomer(job.id);if(customerId&&ROOT_TYPES.has(job.type))rows.set(customerId,[...(rows.get(customerId)||[]),job]);}
    for(const customerId of new Set([...proposals.values()].map(proposal=>proposal.customerId))) {
      const list=rows.get(customerId)||[],after=list.map(row=>accountRoot(row,customerId,finalCustomer));
      if(new Set(after.map(key)).size<2)continue;
      const before=new Set(list.filter(row=>currentCustomer(row.id)===customerId).map(row=>key(accountRoot(row,customerId,currentCustomer))));
      for(const entry of after)if(!before.has(key(entry)))for(const id of entry.path)if(proposals.get(id)?.customerId===customerId)held.add(id);
    }
    return held;
  }
  const hold=(id,reason)=>{conflict(id,proposals.get(id).customerId,reason);proposals.delete(id);};
  // Holding one link can invalidate a chain or an account root that depended on it.
  for(let changed=true;changed;) {
    changed=false;
    for(const [id,proposal] of proposals){const reason=lineageConflict(jobsById.get(id),proposal.customerId);if(reason){hold(id,reason);changed=true;}}
    if(!changed)for(const id of rootConflicts()){hold(id,'account_root_conflict');changed=true;}
  }
  // Links that depend on each other (owner chains and references) form one component.
  // It commits atomically, fenced on every existing record the checks above read.
  const parent=new Map([...proposals.keys()].map(id=>[id,id])),related=new Map();
  const find=id=>{while(parent.get(id)!==id){parent.set(id,parent.get(parent.get(id)));id=parent.get(id);}return id;};
  for(const [id,{customerId}] of proposals) {
    const job=jobsById.get(id),ids=new Set([...accountRoot(job,customerId,finalCustomer).path,...REFERENCES.map(field=>job[field]),...(incoming.get(id)||[])]);
    ids.delete(id);related.set(id,[...ids].filter(other=>jobsById.has(other)));
    for(const other of related.get(id))if(proposals.has(other))parent.set(find(other),find(id));
  }
  const components=new Map(),links=[],linkGroups=[];
  for(const id of [...proposals.keys()].sort())components.set(find(id),[...(components.get(find(id))||[]),id]);
  for(const ids of components.values()) {
    const writes=ids.map(id=>({collection:'jobs',id,revision:jobsById.get(id).revision,patch:{customerId:proposals.get(id).customerId,customerLinkSource:'identity_backfill',customerLinkEvidence:proposals.get(id).evidence,customerLinkedAt:now}}));
    const fences=new Map(),fence=(collection,id,row)=>{if(row?.revision&&!fences.has(collection+'/'+id))fences.set(collection+'/'+id,{collection,id,revision:row.revision,verify:true});};
    for(const id of ids) {
      const job=jobsById.get(id);
      fence('customers',proposals.get(id).customerId,byId.get(proposals.get(id).customerId));
      for(const other of related.get(id))if(!proposals.has(other))fence('jobs',other,jobsById.get(other));
      if(safeId(job.projectId))fence('projects',job.projectId,projects.get(job.projectId));
    }
    if(writes.length+fences.size>MAX_COMMIT_WRITES){for(const id of ids)conflict(id,proposals.get(id).customerId,'lineage_too_large');continue;}
    linkGroups.push({ids,writes:[...writes,...fences.values()]});
    links.push(...writes.map(write=>({...write,customerId:write.patch.customerId})));
  }
  links.sort((a,b)=>a.id.localeCompare(b.id));
  // Only a lone phone or email carries a name/address confirmation.
  const loneKeyLinks=links.filter(link=>link.patch.customerLinkEvidence.some(how=>how==='name'||how==='address')).map(link=>({jobId:link.id,customerId:maskId(link.customerId),evidence:link.patch.customerLinkEvidence}));
  return {customerWrites,links,linkGroups,report:{
    customers:{scanned:customers.length,needsNormalization:customerWrites.length,unusablePhone:sorted(unusablePhone).map(maskId),unusableEmail:sorted(unusableEmail).map(maskId),skippedIds:sorted(skipped).map(maskId),duplicateIdentities:duplicateIdentities.sort((a,b)=>a.field.localeCompare(b.field)||a.customerIds[0].localeCompare(b.customerIds[0]))},
    jobs:{scanned:jobs.length,operational:jobsById.size,legacyWithoutCustomer:legacy,linkable:links.length,loneKeyLinks,ambiguous:sorted(ambiguous),conflicts:sorted(conflicts),unmatched:sorted(unmatched)},
  }};
}

async function sharedUnchanged(store,shared) {
  for(const fence of shared) {
    const row=await store.read(fence.collection,fence.id);
    if(row?.revision===fence.revision)continue;
    if(fence.collection==='dispatchState')throw fail('schedule_changed','The schedule changed during the backfill. Nothing further was linked; rerun it in a quiet window to plan from the latest records.');
    throw fail('identity_changed','Customer identities changed during the backfill. Nothing further was linked; rerun it to plan from the latest records.');
  }
}

async function commitGroups(store,groups,{batchSize,shared=[],outcome}) {
  const merge=list=>{const writes=new Map();for(const write of [...list.flatMap(group=>group.writes),...shared]){const key=write.collection+'/'+write.id;if(!writes.has(key))writes.set(key,write);}return [...writes.values()];};
  for(let start=0;start<groups.length;) {
    const batch=[groups[start++]];
    while(start<groups.length&&batch.length<batchSize&&merge([...batch,groups[start]]).length<=MAX_COMMIT_WRITES)batch.push(groups[start++]);
    try{await store.commit(merge(batch));outcome.committed.push(...batch.flatMap(group=>group.ids));continue;}
    catch(error){if(error.code!=='dispatch_revision_conflict')throw error;}
    await sharedUnchanged(store,shared);
    // One changed record skips only its own group (a whole lineage component); a rerun picks it up.
    for(const group of batch) {
      try{await store.commit(merge([group]));outcome.committed.push(...group.ids);}
      catch(error){if(error.code!=='dispatch_revision_conflict')throw error;await sharedUnchanged(store,shared);outcome.changed.push(...group.ids);}
    }
  }
}

export async function runCustomerIdentityBackfill(store,{apply=false,now=new Date().toISOString(),runId=randomUUID(),batchSize=100}={}) {
  async function snapshot() {
    const [customers,jobs]=await Promise.all([store.customers(),store.jobs()]);
    if(!Array.isArray(customers)||!Array.isArray(jobs))throw fail('storage_incomplete','The complete customer and job records could not be verified.');
    const projects=new Map();
    for(const id of new Set(jobs.filter(row=>operationalJob(row)&&!row.customerId&&safeId(row.projectId)).map(row=>row.projectId)))projects.set(id,await store.read('projects',id));
    return planCustomerIdentityBackfill({customers,jobs,projects},now);
  }
  const summary=(plan,extra)=>({mode:apply?'apply':'dry_run',runId,generatedAt:now,...plan.report,...extra,managerReview:{required:Boolean(plan.report.jobs.ambiguous.length||plan.report.jobs.conflicts.length||plan.report.customers.duplicateIdentities.length),ambiguousJobs:plan.report.jobs.ambiguous.length,conflictingJobs:plan.report.jobs.conflicts.length,duplicateIdentities:plan.report.customers.duplicateIdentities.length,loneKeyLinks:plan.report.jobs.loneKeyLinks.length}});
  let plan=await snapshot();
  if(!apply)return summary(plan,{writes:{planned:{customers:plan.customerWrites.length,jobs:plan.links.length},committed:{customers:0,jobs:0}}});
  const customers={committed:[],changed:[]},jobs={committed:[],changed:[]};
  const planned={customers:plan.customerWrites.length,jobs:0},result=()=>({planned,committed:{customers:customers.committed.length,jobs:jobs.committed.length},changedDuringRun:{customers:sorted(customers.changed).map(maskId),jobs:sorted(jobs.changed)}});
  try {
    await commitGroups(store,plan.customerWrites.map(write=>({ids:[write.id],writes:[write]})),{batchSize,outcome:customers});
    // Read the shared customer-identity and dispatch revisions BEFORE the fresh
    // snapshot, as customer resolution and dispatch do. A customer created or
    // relinked, or any scheduling change, during the run aborts the links.
    const shared=[];
    for(const collection of ['customerIdentityState','dispatchState']) {
      let guard=await store.read(collection,'revision');
      if(!guard) {
        try{await store.commit([{collection,id:'revision',patch:{updatedAt:now,lastRequestId:'identity-backfill:'+runId}}]);}
        catch(error){if(error.code!=='dispatch_revision_conflict')throw error;}
        guard=await store.read(collection,'revision');
      }
      if(!guard?.revision)throw fail('storage_incomplete','The customer identity and schedule revisions could not be verified.');
      shared.push({collection,id:'revision',revision:guard.revision,verify:true});
    }
    plan=await snapshot();planned.jobs=plan.links.length;
    await commitGroups(store,plan.linkGroups,{batchSize,shared,outcome:jobs});
  } catch(error) {
    return summary(plan,{writes:result(),aborted:{code:error.code||'customer_identity_backfill_failed',message:error.code?error.message:'The backfill stopped before finishing. Rerun it; applied writes are not repeated.'}});
  }
  return summary(plan,{writes:result()});
}

export function parseArgs(argv) {
  const options={apply:false,report:'',help:false};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--apply')options.apply=true;
    else if(arg==='--dry-run')options.dryRun=true;
    else if(arg==='--report'&&argv[i+1]&&!argv[i+1].startsWith('--'))options.report=argv[++i];
    else if(arg==='--help'||arg==='-h')options.help=true;
    else throw new Error('Unknown or incomplete argument: '+arg);
  }
  if(options.apply&&options.dryRun)throw new Error('Choose either --dry-run or --apply.');
  delete options.dryRun;
  return options;
}

/** Replaces any earlier file, which would otherwise keep its old permissions. */
export async function writeReport(path,json) {
  await rm(path,{force:true});
  await writeFile(path,json+'\n',{mode:0o600,flag:'wx'});
}

async function main() {
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/backfill-customer-identity.mjs [--dry-run|--apply] [--report <file>]\nDry run is the default; --apply writes with revision preconditions.');return;}
  const env={FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(env)){console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');process.exitCode=2;return;}
  let report;
  try{report=await runCustomerIdentityBackfill(backfillStorage(env),{apply:options.apply,now:new Date().toISOString()});}
  catch(error){console.error(error.code?error.message:'The backfill could not read the complete customer and job records. Nothing was written.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report) {
    try{await writeReport(options.report,json);}
    catch{console.error('The report file could not be written privately, so it was not saved.');process.exitCode=1;}
  }
  process.stdout.write(json+'\n');
  const w=report.writes;
  console.error(`${report.mode==='apply'?'APPLIED':'DRY RUN (nothing written)'}: customers ${w.committed.customers}/${w.planned.customers} normalized, legacy jobs ${w.committed.jobs}/${w.planned.jobs} linked; ${report.managerReview.ambiguousJobs} ambiguous and ${report.managerReview.conflictingJobs} conflicting jobs, ${report.managerReview.duplicateIdentities} shared identities need manager review; ${report.managerReview.loneKeyLinks} single phone/email links to spot-check.${report.aborted?' ABORTED: '+report.aborted.message:''}`);
  if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
