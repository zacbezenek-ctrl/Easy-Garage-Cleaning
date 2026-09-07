import { readJob } from './firestore-job.js';

function accessError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export async function readCustomerPortalContext(env, session) {
  if (!session) throw accessError(401, 'CUSTOMER_PORTAL_AUTH_REQUIRED', 'Open the private link from Easy Garage Cleaning');
  let job, accountJob;
  try {
    job = await readJob(env, session.jobId);
    if (!job) throw accessError(404, 'CUSTOMER_PORTAL_JOB_UNAVAILABLE', 'This job is no longer available');
    const accountJobId = String(job.customerAccountOwnerJobId || job.id).trim().slice(0, 120);
    accountJob = accountJobId !== job.id ? await readJob(env, accountJobId) : job;
    // Recurring jobs can hold an old display copy of the authorized people.
    // Never use that copy when the authoritative account cannot be loaded.
    if (!accountJob) throw accessError(503, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', 'Your project could not be loaded. Please try again shortly.');
  } catch (error) {
    if (error.code?.startsWith('CUSTOMER_PORTAL_')) throw error;
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
    job: {
      ...job,
      customerMemory: accountJob.customerMemory || job.customerMemory,
      customerCollaborators: accountJob.customerCollaborators || [],
      giftWallet: accountJob.giftWallet || job.giftWallet,
      garageGuard: accountJob.garageGuard || job.garageGuard,
    },
  };
}
