import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { patchJob, readJob } from '../_lib/firestore-job.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function allowed(request) {
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function clean(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString().slice(0, 1000) : '';
  } catch { return ''; }
}

function slugify(value) {
  return clean(value, 160).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function finished(job) {
  const values = [job.status, job.pipelineStatus, job.paymentStatus, job.invoice?.status].map(value => String(value || '').toLowerCase());
  return values.some(value => ['completed', 'paid', 'review_requested', 'closed'].includes(value)) || Boolean(job.completedAt || job.postJobChecklist?.completedAt);
}

function containsPrivateCustomerData(job, values) {
  const privateValues = [job.customer, job.address]
    .map(value => clean(value, 300).toLowerCase())
    .filter(value => value.length >= 5);
  return privateValues.some(privateValue => values.some(value => clean(value, 2000).toLowerCase().includes(privateValue)));
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session || !hasBusinessAccess(session)) return reply(403, { ok: false, error: 'Manager access required' });
  const raw = await request.text();
  if (raw.length > 48 * 1024) return reply(413, { ok: false, error: 'Payload too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  const jobId = clean(body.jobId, 180);
  if (!jobId) return reply(400, { ok: false, error: 'Job is required' });
  const job = await readJob(env, jobId).catch(() => null);
  if (!job) return reply(404, { ok: false, error: 'Job not found' });

  const title = clean(body.title, 100);
  const city = clean(body.city, 80);
  const neighborhood = clean(body.neighborhood, 100);
  const serviceType = clean(body.serviceType || job.serviceType || job.type, 100);
  const customerProblem = clean(body.customerProblem, 800);
  const workCompleted = clean(body.workCompleted, 1200);
  const result = clean(body.result, 800);
  const duration = clean(body.duration, 80);
  if (!title || !city || !serviceType || !customerProblem || !workCompleted || !result) {
    return reply(400, { ok: false, error: 'Title, city, service, problem, work completed, and result are required' });
  }
  if (containsPrivateCustomerData(job, [title, neighborhood, customerProblem, workCompleted, result])) {
    return reply(400, { ok: false, error: 'Remove the customer name or street address from public case-study copy' });
  }

  const now = new Date().toISOString();
  const wantsPublish = clean(body.publishConfirmation, 20).toUpperCase() === 'PUBLISH';
  const consentConfirmed = clean(body.consentConfirmation, 20).toUpperCase() === 'YES';
  if (wantsPublish && !finished(job)) return reply(409, { ok: false, error: 'Only a finished job can be published' });
  if (wantsPublish && !consentConfirmed) return reply(409, { ok: false, error: 'Customer publication consent must be confirmed' });
  const status = wantsPublish ? 'published' : 'draft';
  const suffix = Date.now().toString(36).slice(-5);
  const caseStudy = {
    slug: job.caseStudy?.slug || `${slugify(`${title}-${city}`) || 'garage-project'}-${suffix}`,
    title,
    description: clean(body.description || `${serviceType} project in ${city}: ${result}`, 160),
    city,
    neighborhood,
    serviceType,
    customerProblem,
    workCompleted,
    result,
    duration,
    beforePhotoUrl: safeUrl(body.beforePhotoUrl),
    afterPhotoUrl: safeUrl(body.afterPhotoUrl),
    status,
    consentConfirmed: status === 'published',
    consentConfirmedAt: status === 'published' ? now : '',
    publishedAt: status === 'published' ? (job.caseStudy?.publishedAt || now) : '',
    updatedAt: now,
    updatedBy: session.user,
  };
  const updated = await patchJob(env, jobId, { caseStudy, updatedAt: now }, job.__updateTime || '');
  return reply(200, { ok: true, status, caseStudy, job: updated });
}
