import { readJob } from './firestore-job.js';
import { sameOperationalProperty, verifiedAccountRoot } from './dispatch-lineage.js';

function accessError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export async function readCustomerPortalContext(env, session, {read=readJob}={}) {
  if (!session) throw accessError(401, 'CUSTOMER_PORTAL_AUTH_REQUIRED', 'Open the private link from Easy Garage Cleaning');
  let job, accountJob, memoryJob;
  const cache=new Map();
  const load=id=>{
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,180}$/.test(id)||/^(secure_|_egc_)/.test(id))throw accessError(403,'CUSTOMER_PORTAL_ACCOUNT_INVALID','This project account link needs review by Easy Garage Cleaning.');
    if(!cache.has(id))cache.set(id,read(env,id));
    return cache.get(id);
  };
  try {
    job = await load(session.jobId);
    if (!job) throw accessError(404, 'CUSTOMER_PORTAL_JOB_UNAVAILABLE', 'This job is no longer available');
    if(job.id!==session.jobId)throw accessError(403,'CUSTOMER_PORTAL_ACCOUNT_INVALID','This project account link needs review by Easy Garage Cleaning.');
    const accountJobId = job.customerAccountOwnerJobId || job.id;
    accountJob = accountJobId !== job.id ? await verifiedAccountRoot(load,accountJobId,job.customerId) : job;
    // Recurring jobs can hold an old display copy of the authorized people.
    // Never use that copy when the authoritative account cannot be loaded.
    if (!accountJob) throw accessError(503, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', 'Your project could not be loaded. Please try again shortly.');
    memoryJob=sameOperationalProperty(job,accountJob)?accountJob:job;
    // A different property shares verified account identity, never the root's
    // garage instructions. Explicit property lineage is checked on each read.
    if(memoryJob===job&&!job.customerMemory&&job.customerMemoryInheritedFrom&&job.customerMemoryInheritedFrom!==job.id) {
      const seen=new Set([job.id]);let sourceId=job.customerMemoryInheritedFrom;
      for(let depth=0;sourceId&&depth<12;depth++) {
        if(seen.has(sourceId))throw accessError(403,'CUSTOMER_PORTAL_ACCOUNT_INVALID','This property history needs review by Easy Garage Cleaning.');
        seen.add(sourceId);
        const source=await load(sourceId);
        const sourceRoot=await verifiedAccountRoot(load,sourceId,job.customerId);
        if(sourceRoot.id!==accountJob.id)throw accessError(403,'CUSTOMER_PORTAL_ACCOUNT_INVALID','This property history belongs to another customer account.');
        if(!sameOperationalProperty(job,source))break;
        if(source.customerMemory) {memoryJob=source;break;}
        sourceId=source.customerMemoryInheritedFrom;
        if(depth===11&&sourceId)throw accessError(403,'CUSTOMER_PORTAL_ACCOUNT_INVALID','This property history needs review by Easy Garage Cleaning.');
      }
    }
  } catch (error) {
    if (error.code?.startsWith('CUSTOMER_PORTAL_')) throw error;
    if(error.code==='dispatch_lineage_missing')throw accessError(503,'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE','Your project account could not be loaded. Please try again shortly.');
    if(error.code?.startsWith('dispatch_lineage_'))throw accessError(403,'CUSTOMER_PORTAL_ACCOUNT_INVALID','This project account link needs review by Easy Garage Cleaning.');
    throw accessError(503, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', 'Your project could not be loaded. Please try again shortly.');
  }

  let viewer = session;
  if (session.actorId) {
    const people = Array.isArray(accountJob.customerCollaborators) ? accountJob.customerCollaborators : [];
    const person = people.find(item => item.id === session.actorId && (item.status || 'active') === 'active');
    if (!person || person.permissions?.view === false) {
      throw accessError(403, 'CUSTOMER_PORTAL_ACCESS_REVOKED', 'Your access to this private project has changed. Ask the customer for a new invitation.');
    }
    // The signed invitation identifies the person; the customer's saved
    // permissions determine what that person can do on every request.
    viewer = { ...session, permissions: {
      view: true,
      decide: person.permissions?.decide === true,
      pay: person.permissions?.pay === true,
      rebook: person.permissions?.rebook === true,
    } };
  }

  return {
    session: viewer,
    accountJobId: accountJob.id,
    jobUpdateTime: job.__updateTime || '',
    accountUpdateTime: accountJob.__updateTime || '',
    memoryJobId:memoryJob.id,
    memoryUpdateTime:memoryJob.__updateTime || '',
    job: {
      ...job,
      customerMemory: memoryJob.customerMemory || job.customerMemory,
      customerCollaborators: accountJob.customerCollaborators || [],
      giftWallet: accountJob.giftWallet,
      garageGuard: accountJob.garageGuard,
    },
  };
}
