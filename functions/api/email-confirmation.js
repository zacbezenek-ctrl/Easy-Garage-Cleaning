import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { readJob } from '../_lib/firestore-job.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

const safe = (value, max = 180) => String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '')) ? String(value).toLowerCase() : '';

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!hasBusinessAccess(session)) return reply(403, { ok: false, error: 'Business access required' });

  const raw = await request.text();
  if (raw.length > 4 * 1024) return reply(413, { ok: false, error: 'Request too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  const jobId = safe(body.job_id, 180);
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(jobId)) return reply(400, { ok: false, error: 'A valid job is required' });

  const serviceId = safe(env.EMAILJS_SERVICE_ID, 120);
  const templateId = safe(env.EMAILJS_TEMPLATE_ID, 120);
  const publicKey = safe(env.EMAILJS_PUBLIC_KEY, 180);
  if (!serviceId || !templateId || !publicKey) return reply(501, { ok: false, error: 'Confirmation email is not configured' });

  const job = await readJob(env, jobId).catch(() => null);
  if (!job) return reply(404, { ok: false, error: 'Job not found' });
  const recipient = email(job.email);
  if (!recipient) return reply(409, { ok: false, error: 'This customer does not have a valid email address' });
  const appointmentDate = /^\d{4}-\d{2}-\d{2}$/.test(job.date || '')
    ? new Date(`${job.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' })
    : 'Date TBD';
  const upstream = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: {
        to_email: recipient,
        to_name: safe(job.customer || job.name || 'Customer', 120),
        appointment_type: safe(job.type || job.serviceType || 'Walkthrough', 100),
        appointment_date: appointmentDate,
        appointment_time: safe(job.time || 'Time TBD', 40),
        address: safe(job.address || 'TBD', 240),
        employee_name: safe(job.assignedTo || session.displayName || session.user, 120),
        notes: safe(job.notes, 600),
      },
    }),
  }).catch(() => null);
  if (!upstream?.ok) return reply(502, { ok: false, error: 'Confirmation email could not be sent' });
  return reply(200, { ok: true, sent: true });
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}
