import { verifiedAccountRoot } from './dispatch-lineage.js';
import { hasBusinessAccess } from './hub-session.js';
import { customerPortalLinkVersion } from './customer-portal.js';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value)&&!/^(_egc_|secure_)/.test(value);
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code:'CUSTOMER_PORTAL_REVOKE_'+code,status});
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':plain(value)?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>JSON.stringify(key)+':'+canonical(value)).join(',')+'}':JSON.stringify(value);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const RECEIPTS='customerPortalOperations';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FIELDS=['requestId','jobId','expectedRevision','clearCollaborators'];
// Collaborator tokens are rechecked against the root's saved list on every
// request (readCustomerPortalContext), so emptying it ends them immediately.
const activeCollaborators=root=>(Array.isArray(root.customerCollaborators)?root.customerCollaborators:[]).filter(person=>plain(person)&&(person.status||'active')==='active').length;

/** Resolve the account root whose version governs every homeowner link for a
 * job, exactly as readCustomerPortalContext does when the link is opened. */
export async function customerPortalLinkAccount(read,job) {
  const cache=new Map([[job.id,Promise.resolve(job)]]);
  const load=id=>{if(!cache.has(id))cache.set(id,read(id));return cache.get(id);};
  const ownerId=job.customerAccountOwnerJobId||job.id;
  const account=ownerId!==job.id?await verifiedAccountRoot(load,ownerId,job.customerId):job;
  const linkVersion=customerPortalLinkVersion(account);
  if(linkVersion===null)throw fail('ACCOUNT_REVIEW','This customer account has an invalid portal link version. Ask an owner to review it.',409);
  return {account,linkVersion};
}

function requireManager(session) {
  if(!session)throw fail('SIGN_IN_REQUIRED','Sign in to the EGC Hub.',401);
  if(!hasBusinessAccess(session)||!['owner','manager'].includes(session.role))throw fail('FORBIDDEN','Only an owner or manager can revoke customer portal links.',403);
}

async function account(store,jobId) {
  const job=await store.read('jobs',jobId);
  if(!job||job.recordType)throw fail('JOB_NOT_FOUND','That job is no longer available.',404);
  try {return await customerPortalLinkAccount(id=>store.read('jobs',id),job);}
  catch(problem) {
    if(problem.code?.startsWith('CUSTOMER_PORTAL_REVOKE_'))throw problem;
    if(problem.code==='dispatch_lineage_missing')throw fail('STORAGE_UNAVAILABLE','The customer account could not be loaded. Retry shortly.',503);
    if(problem.code?.startsWith('dispatch_lineage_'))throw fail('ACCOUNT_REVIEW','This job’s customer account link needs review before its portal links can be revoked.',409);
    throw problem;
  }
}

const status=({account:root,linkVersion},jobId)=>({jobId,accountJobId:root.id,linkVersion,revision:root.revision,collaboratorCount:activeCollaborators(root),revokedAt:root.customerPortalLinksRevokedAt||'',revokedBy:root.customerPortalLinksRevokedBy||''});

export async function customerPortalLinkStatus(store,session,jobId) {
  requireManager(session);
  if(!safeId(jobId))throw fail('INVALID_REQUEST','Choose a valid job.');
  return {ok:true,...status(await account(store,jobId),jobId)};
}

/** Bump the account's link version so every earlier homeowner link and portal
 * session stops working. Nothing is sent to the customer; staff share a fresh
 * link separately when they choose to.
 *
 * input.clearCollaborators (boolean, default true when omitted; Hub callers
 * omit it unless staff choose to keep the saved people): in the same atomic
 * commit, empty the account root's saved customerCollaborators list. A leaked
 * owner link can add its holder as an authorized person and mint an invitation
 * before revocation; clearing the list ends every such invitation and session
 * at once. Only the number of people removed is recorded, never names or
 * contacts. Pass false to keep the list (collaborator invitations that carry a
 * link version still end). */
export async function revokeCustomerPortalLinks(store,session,input,{now=new Date().toISOString()}={}) {
  requireManager(session);
  // Type-check before any RegExp: .test() coerces ['<uuid>'] to a string.
  if(!plain(input)||Object.keys(input).some(key=>!FIELDS.includes(key))||typeof input.requestId!=='string'||!UUID.test(input.requestId))throw fail('INVALID_REQUEST','Revoking portal links needs a unique request ID, a job and its expected revision.');
  if(!safeId(input.jobId))throw fail('INVALID_REQUEST','Choose a valid job.');
  if(typeof input.expectedRevision!=='string'||!input.expectedRevision||input.expectedRevision.length>64)throw fail('INVALID_REQUEST','Refresh the portal link status before revoking.');
  if(input.clearCollaborators!==undefined&&typeof input.clearCollaborators!=='boolean')throw fail('INVALID_REQUEST','Choose whether to also remove the account’s authorized people.');
  const clearCollaborators=input.clearCollaborators!==false;
  // Fingerprint the normalized request so an omitted flag and an explicit true
  // are the same retry, while true and false conflict.
  const request={requestId:input.requestId,jobId:input.jobId,expectedRevision:input.expectedRevision,clearCollaborators};
  const fingerprint=await hash({actor:session.user,input:request}),receiptId=input.requestId.toLowerCase();
  async function replay() {
    const receipt=await store.read(RECEIPTS,receiptId);
    if(!receipt)return null;
    if(receipt.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','This request ID was already used for a different revocation. Refresh and retry.',409);
    const saved=await store.read('jobs',receipt.accountJobId),version=customerPortalLinkVersion(saved);
    if(!saved||version===null||version<receipt.linkVersion)throw fail('CHANGED_SINCE_OPERATION','The portal link version changed after this revocation was saved. Ask an owner to review it.',409);
    return {ok:true,jobId:receipt.jobId,accountJobId:receipt.accountJobId,linkVersion:receipt.linkVersion,previousLinkVersion:receipt.previousLinkVersion,clearCollaborators:receipt.clearCollaborators===true,removedCollaboratorCount:receipt.removedCollaboratorCount||0,revokedAt:receipt.createdAt,revokedBy:receipt.actorId,replayed:true};
  }
  const previous=await replay();if(previous)return previous;
  const {account:root,linkVersion}=await account(store,input.jobId);
  if(root.revision!==input.expectedRevision)throw fail('REVISION_CONFLICT','The customer account changed. Refresh the portal link status and try again.',409);
  const next=linkVersion+1;
  if(!Number.isSafeInteger(next))throw fail('ACCOUNT_REVIEW','This customer account has an invalid portal link version. Ask an owner to review it.',409);
  // Counted from the same revision the commit is conditioned on, so it is exact.
  const removedCollaboratorCount=clearCollaborators?activeCollaborators(root):0;
  try {
    await store.commit([
      {collection:'jobs',id:root.id,revision:root.revision,patch:{customerPortalLinkVersion:next,customerPortalLinksRevokedAt:now,customerPortalLinksRevokedBy:session.user,...(clearCollaborators?{customerCollaborators:[],collaboratorsUpdatedAt:now}:{})}},
      {collection:RECEIPTS,id:receiptId,patch:{requestId:input.requestId,fingerprint,actorId:session.user,jobId:input.jobId,accountJobId:root.id,previousLinkVersion:linkVersion,linkVersion:next,clearCollaborators,removedCollaboratorCount,createdAt:now}},
    ]);
  } catch(problem) {
    const recovered=await replay().catch(()=>null);if(recovered)return recovered;
    if(problem.code==='dispatch_revision_conflict')throw fail('REVISION_CONFLICT','The customer account changed while links were being revoked. Refresh and try again.',409);
    throw fail('OUTCOME_UNKNOWN','The revocation could not be confirmed. Retry the same request to check whether it saved.',503);
  }
  const saved=await store.read('jobs',root.id);
  if(!(customerPortalLinkVersion(saved)>=next))throw fail('OUTCOME_UNKNOWN','The revocation could not be confirmed. Retry the same request to check whether it saved.',503);
  return {ok:true,jobId:input.jobId,accountJobId:root.id,linkVersion:next,previousLinkVersion:linkVersion,clearCollaborators,removedCollaboratorCount,revision:saved.revision,revokedAt:now,revokedBy:session.user};
}
