/* HighLevel owns the 6-month garage check-in (GHL-ALIGN). A verified field
   completion creates it as a HighLevel contact task, the same task the
   closeout handoff in functions/api/highlevel.js creates, unless the
   operations platform reports that it opened its own task (egc-api
   EGC_OPERATIONS_CHECKIN_TASKS_ENABLED=true), so one check-in never lives in
   both places. A field completion gets here only while the bridge is on (Hub
   operations and egc-api EGC_OPERATIONS_ENABLED=true) and after the egc-api
   note is verified. When an earlier attempt may already have written the
   task, it is only read (readOnly) before a platform task is accepted. It is
   an internal task: nothing is sent to the customer. */
const API = 'https://services.leadconnectorhq.com';
export const CHECKIN_TASK_TITLE = '6-month garage check-in';
export const CHECKIN_TASK_BODY = 'Ask how the system is holding up and offer maintenance / Garage Guard if useful.';
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const utcDay = value => { const ms = Date.parse(typeof value === 'string' ? value : ''); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''; };

// Six calendar months after the completion instant, clamped to the last day
// of a shorter month (the rule the platform task used), in whole minutes so
// HighLevel stores exactly what was sent.
export function checkinDueDate(completedAt) {
  const at = new Date(typeof completedAt === 'string' ? completedAt : NaN);
  if (!Number.isFinite(at.getTime())) return '';
  const day = at.getUTCDate();
  at.setUTCDate(1); at.setUTCMonth(at.getUTCMonth() + 6);
  at.setUTCDate(Math.min(day, new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate()));
  at.setUTCSeconds(0, 0);
  return at.toISOString();
}

// The contact's tasks are read first, so a retry after a lost response finds
// the task it already created instead of adding a second one. A task matches
// by title and UTC due day, whatever precision HighLevel returns. Outcomes:
// created/exists (done), not_configured/invalid (nothing called), failed (a
// definite 4xx rejection, nothing written), unavailable (nothing written) and
// uncertain (the POST may have landed; the next retry reads before writing).
// readOnly stops after the read: exists, or absent when HighLevel has none.
export async function ensureHighLevelCheckin(env = {}, { contactId = '', completedAt = '', readOnly = false } = {}, fetcher = fetch) {
  const token = env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '', locationId = env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID || '';
  if (!token || !locationId) return { status: 'not_configured' };
  const dueDate = checkinDueDate(completedAt), id = String(contactId || '');
  if (!ID.test(id) || !dueDate) return { status: 'invalid' };
  const path = `${API}/contacts/${encodeURIComponent(id)}/tasks`, headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, Version: 'v3' };
  const rejected = status => status >= 400 && status < 500 && status !== 408 && status !== 429;
  let response;
  try { response = await fetcher(path, { headers, signal: AbortSignal.timeout(15000) }); } catch { return { status: 'unavailable' }; }
  const listed = response.ok ? await response.json().catch(() => null) : null;
  if (!Array.isArray(listed?.tasks)) return { status: rejected(response.status) ? 'failed' : 'unavailable', ...(response.ok ? {} : { httpStatus: response.status }) };
  const existing = listed.tasks.find(task => task?.title === CHECKIN_TASK_TITLE && utcDay(task.dueDate) === dueDate.slice(0, 10) && ID.test(String(task.id || '')));
  if (existing) return { status: 'exists', taskId: String(existing.id), dueDate };
  if (readOnly === true) return { status: 'absent', dueDate };
  try {
    response = await fetcher(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({
      title: CHECKIN_TASK_TITLE, body: CHECKIN_TASK_BODY, dueDate, completed: false, assignedTo: env.HIGHLEVEL_USER_ID || env.GHL_USER_ID || 'w92vfhwm3a8twTIowpQz',
    }) });
  } catch { return { status: 'uncertain' }; }
  const created = await response.json().catch(() => ({})), taskId = String(created?.task?.id || created?.id || '');
  if (response.ok && ID.test(taskId)) return { status: 'created', taskId, dueDate };
  return { status: response.status === 429 ? 'unavailable' : rejected(response.status) ? 'failed' : 'uncertain', httpStatus: response.status };
}
