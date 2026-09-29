/* Crew schedule notices (CREW-NOTIFY). A dispatch save compares each crew
   member's work slots before and after (one slot per assignment segment, or
   the job itself) and, with EGC_CREW_NOTIFICATIONS_ENABLED, queues one
   crewNotifications row per affected employee in the same commit as the
   schedule change and its receipt. Nothing is sent here: the signed messaging
   cron drains the rows through the approved-send crew policies, and each
   employee reads and acknowledges their own rows through
   /api/crew-notifications. Rows carry schedule facts only (dates, times,
   service type): never customer contact details, notes or money. */
import { assignmentKey, jobCrewNames } from './job-assignment.js';
import { jobSegments } from './dispatch-segments.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';

// Server-only collections; firestore.rules denies every browser read and write.
export const CREW_NOTIFICATIONS = 'crewNotifications';
export const CREW_NOTIFICATION_PREFS = 'crewNotificationPrefs';
// One record per job and employee: what that employee last heard about the
// job (the slots of the newest notice texted to them, or the schedule before
// their first notice while none was), written in the same commit that closes
// a notice. The cron's text baseline and the Hub's covered-by-a-later-text view.
export const CREW_NOTICE_HEARD = 'crewNoticeHeard';
export const CREW_NOTICE_INTENTS = Object.freeze(['assigned', 'unassigned', 'time_changed', 'cancelled', 'restored']);
export const REMOVAL_INTENTS = Object.freeze(['unassigned', 'cancelled']);
// The approved-send kind (owner-approved wording) each intent is queued with. A
// move or new work that also takes days (or hours) away is one
// crew_schedule_change text naming both. The messaging cron decides the kind
// again from everything that changed since the employee's last text.
export const CREW_MESSAGE_KINDS = Object.freeze({ assigned: 'crew_assignment', time_changed: 'crew_assignment', restored: 'crew_assignment', unassigned: 'crew_unassignment', cancelled: 'crew_unassignment' });
export const CREW_SEND_KINDS = Object.freeze(['crew_assignment', 'crew_unassignment', 'crew_schedule_change']);
/** True when `kind` is a kind a notice with `intent` may be queued with. */
export const noticeKindValid = (intent, kind) => kind === CREW_MESSAGE_KINDS[intent] || (intent === 'time_changed' && kind === 'crew_schedule_change');
export const SLOT_LIMIT = 31;
const TERMINAL = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show','superseded','lost']);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const state = job => String(job?.pipelineStatus || job?.status || 'unscheduled').toLowerCase();
const live = job => object(job) && !TERMINAL.has(state(job));
const cancelled = job => object(job) && ['cancelled', 'canceled'].includes(state(job));
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';

/** Exactly "true" queues notices on dispatch saves and lets the cron drain them. */
export const crewNotificationsEnabled = env => env?.EGC_CREW_NOTIFICATIONS_ENABLED === 'true';

// Identity as dispatch resolves it: an explicit account id wins and a display
// label only counts when exactly one roster member carries it. Without a
// roster only stable usernames match.
function member(value, roster) {
  const explicit = object(value) ? value.username || value.user || value.id : null;
  const key = assignmentKey(typeof value === 'string' ? value : explicit || value?.name || '');
  if (!key) return null;
  if (!roster || roster.some(person => person.id === key)) return key;
  if (explicit) return null;
  const aliases = roster.filter(person => assignmentKey(person.name) === key);
  return aliases.length === 1 ? aliases[0].id : null;
}
const rowCrew = (row, roster) => (Array.isArray(row.assignedCrew) && row.assignedCrew.length ? row.assignedCrew : jobCrewNames(row)).map(value => member(value, roster)).filter(Boolean);
/** Roster ids of a job's crew as dispatch resolves them, so a legacy job whose
 * crew is stored by a unique display name still names its employees. */
export const jobCrewIds = (job, roster = null) => new Set(object(job) ? rowCrew(job, roster) : []);

export const slotKey = slot => `${slot?.date || ''}|${slot?.time || ''}|${slot?.endDate || ''}|${slot?.endTime || ''}`;
const bySlot = (a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`) || a.segmentId.localeCompare(b.segmentId);
export const sameSlots = (left = [], right = []) => left.map(slotKey).join(',') === right.map(slotKey).join(',');
export const validSlot = slot => object(slot) && validDate(slot.date) && validDate(slot.endDate) && slot.endDate >= slot.date && (slot.time === '' || TIME.test(slot.time)) && (slot.endTime === '' || TIME.test(slot.endTime)) && typeof slot.segmentId === 'string';

const instant = (date, time) => Date.parse(localInstant(date, time) || '');
/** A slot's work is over at its end time, or at its start when it has no end
 * time (a multi-day slot, or one with no times, runs to the end of its last
 * day). Denver wall clock; a wall time DST makes ambiguous falls back to the
 * calendar day. */
export function slotUpcoming(slot, now) {
  const at = now instanceof Date ? now : new Date(now);
  const end = slot.endTime ? instant(slot.endDate, slot.endTime) : slot.endDate > slot.date || !slot.time ? instant(addDays(slot.endDate, 1), '00:00') : instant(slot.date, slot.time);
  return Number.isFinite(end) ? end > at.getTime() : slot.endDate >= denverToday(at);
}
// The Denver days a slot works; an end at midnight releases its last day.
function slotDays(slot) {
  const days = [];
  for (let date = slot.date; date && date <= slot.endDate && days.length < 62; date = addDays(date, 1)) {
    if (date === slot.endDate && date !== slot.date && slot.endTime === '00:00') break;
    days.push(date);
  }
  return days;
}
// A slot that only drops whole days from one they had (a shorter multi-day
// job or segment) is not a move: the days it dropped are removals.
const trims = (slot, was) => slot.segmentId === was.segmentId && slot.date >= was.date && slot.endDate <= was.endDate && (slot.date !== was.date || slot.time === was.time)
  && (slot.endDate !== was.endDate || slot.endTime === was.endTime) && slotDays(slot).length < slotDays(was).length;
const asDate = now => now instanceof Date ? now : new Date(now);

/** What an employee no longer works, as cuts of the upcoming slots they had:
 * every day they no longer work at all (a whole lost slot, the days a
 * shorter one dropped, or the day a slot moved away from), and, on a day they
 * still work, the hours of a slot whose segment no longer has them that day
 * (a lost afternoon segment, or one moved to another day). A time change
 * within the same segment and day is a change, not a loss. */
export function lostSlots(previous = [], current = [], now) {
  const at = asDate(now), held = new Set(current.map(slotKey)), kept = new Set(current.flatMap(slotDays)), today = denverToday(at), found = new Map();
  for (const slot of previous) {
    if (held.has(slotKey(slot))) continue;
    const carried = new Set(current.filter(row => row.segmentId === slot.segmentId).flatMap(slotDays));
    let run = [], hours = false;
    const flush = () => {
      if (!run.length) return;
      const date = run[0], endDate = run.at(-1), cut = { segmentId: slot.segmentId, date, time: date === slot.date ? slot.time : '', endDate, endTime: endDate === slot.endDate ? slot.endTime : '' };
      if (slotUpcoming(cut, at)) found.set(slotKey(cut), cut);
      run = [];
    };
    for (const day of slotDays(slot)) {
      // A whole day off, or hours off on a day still worked, each as its own cut.
      const lost = day >= today && (!kept.has(day) || !carried.has(day)), partial = kept.has(day);
      if (!lost || (run.length && partial !== hours)) flush();
      if (lost) { hours = partial; run.push(day); }
    }
    flush();
  }
  return [...found.values()].sort(bySlot).slice(0, SLOT_LIMIT);
}

/** Everything an employee has to hear about going from `previous` to
 * `current` (upcoming slot lists): `lost` (see lostSlots) and `added`, the
 * upcoming slots that are new or changed (not ones that only dropped days). */
export function scheduleChange(previous = [], current = [], now) {
  const at = asDate(now), held = new Set(previous.map(slotKey));
  const added = current.filter(row => !held.has(slotKey(row)) && !previous.some(prior => trims(row, prior)) && slotUpcoming(row, at)).sort(bySlot);
  return { lost: lostSlots(previous, current, at), added };
}

/** The approved-send kind that says a change, or '' when nothing is left to
 * say: new or changed work, work taken away, or both in one text. */
export const changeKind = ({ lost = [], added = [] } = {}) => added.length ? (lost.length ? 'crew_schedule_change' : 'crew_assignment') : lost.length ? 'crew_unassignment' : '';

/** Each employee's dated work slots on a live job, earliest first; with
 * `now`, only slots whose work is not over yet. Segments are honoured as
 * dispatch saves them (a malformed list reads as the job's hull and union). */
export function crewSlots(job, roster = null, now = null) {
  const slots = new Map();
  if (!live(job)) return slots;
  for (const row of jobSegments(job)) {
    if (!validDate(row.date)) continue;
    const slot = { segmentId: row.segmentId || '', date: row.date, time: TIME.test(row.time || '') ? row.time : '', endDate: validDate(row.endDate) && row.endDate >= row.date ? row.endDate : row.date, endTime: TIME.test(row.endTime || '') ? row.endTime : '' };
    if (now && !slotUpcoming(slot, now)) continue;
    for (const id of new Set(rowCrew(row, roster))) { if (!slots.has(id)) slots.set(id, []); slots.get(id).push(slot); }
  }
  for (const [id, list] of slots) slots.set(id, list.sort(bySlot).slice(0, SLOT_LIMIT));
  return slots;
}

/** One employee's slots at send time: rows whose crew names them by their
 * username, or, resolved with the roster, by a display name only they carry
 * (a legacy job saved with names), so both kinds of job are checked alike. */
export function employeeSlots(job, employeeId, roster = null, now = null) {
  const merged = new Map();
  for (const slot of [...crewSlots(job, null, now).get(employeeId) || [], ...(roster ? crewSlots(job, roster, now).get(employeeId) || [] : [])]) merged.set(`${slot.segmentId}|${slotKey(slot)}`, slot);
  return [...merged.values()].sort(bySlot).slice(0, SLOT_LIMIT);
}

/** Per-employee intents for one saved change. `before`/`after` are the
 * receipt's before/after snapshots (null before a create); `now` decides
 * which slots are still upcoming in Denver, so editing finished work is
 * silent. New or changed work is 'time_changed' naming the first such slot,
 * queued as crew_schedule_change when the same save also took days or hours
 * away (so a move never hides a loss); only losing work is 'unassigned'
 * naming the first lost slot, never a reassurance about what they kept.
 * Every lost cut is on the row (lostSlots) for the text and the Hub. */
export function buildCrewNotifications(before, after, roster, now, { jobId = '', requestId = '', type = '' } = {}) {
  if (!jobId || !requestId || type === 'blocked' || !object(after)) return [];
  // Completion and other closing states are not crew schedule news.
  if (!live(after) && !cancelled(after)) return [];
  const at = new Date(now), was = crewSlots(before, roster, at), is = crewSlots(after, roster, at), notices = [];
  for (const employeeId of [...new Set([...was.keys(), ...is.keys()])].sort()) {
    const previous = was.get(employeeId) || [], current = is.get(employeeId) || [], { lost, added } = scheduleChange(previous, current, at);
    let intent = null, slot = null;
    if (previous.length && !current.length) { intent = cancelled(after) ? 'cancelled' : 'unassigned'; slot = lost[0] || previous[0]; }
    else if (!previous.length && current.length) { intent = cancelled(before) ? 'restored' : 'assigned'; slot = current[0]; }
    else if (added.length) { intent = 'time_changed'; slot = added[0]; }
    else if (lost.length) { intent = 'unassigned'; slot = lost[0]; }
    if (!intent) continue;
    const messageKind = intent === 'time_changed' && lost.length ? 'crew_schedule_change' : CREW_MESSAGE_KINDS[intent];
    notices.push({ jobId, employeeId, intent, messageKind, dedupeKey: `${jobId}:${requestId}:${employeeId}:${intent}`, slot, slots: current, previousSlots: previous, lostSlots: lost });
  }
  return notices;
}

// Denver wall-clock wording for crew texts; dates are shown as saved.
const LONG_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
const SHORT_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const dayText = (date, short) => short ? SHORT_DAY.format(new Date(`${date}T12:00:00Z`)).replace(',', '') : LONG_DAY.format(new Date(`${date}T12:00:00Z`));
const clockText = time => { const match = TIME.exec(time || ''); if (!match) return ''; const hour = Number(time.slice(0, 2)); return `${hour % 12 || 12}:${time.slice(3)} ${hour < 12 ? 'AM' : 'PM'}`; };
const joined = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const rangeText = (days, short) => days.length > 1 ? `${dayText(days[0], short)} through ${dayText(days.at(-1), short)}` : dayText(days[0], short);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// Days in `items` (each {text, days}) that `named` does not already name.
const unnamedDays = (items, named = new Set()) => new Set(items.flatMap(item => item.days).filter(day => !named.has(day))).size;
// Hours matter only on a day the employee still works; a whole day off is named by its date.
function cutItems(cut, working, mode) {
  const days = slotDays(cut), short = mode === 'short';
  if (!days.length) return [];
  if (days.length === 1 && working.has(days[0])) {
    const start = clockText(cut.time), end = clockText(cut.endTime);
    if (!start) return [{ text: dayText(days[0], short), days }];
    return [{ text: short ? `${dayText(days[0], true)} ${start}${end ? `–${end}` : ''}` : `${dayText(days[0])} from ${start}${end ? ` to ${end}` : ''}`, days }];
  }
  // Up to three days are each named; a longer stretch is a range.
  return mode === 'long' && days.length <= 3 ? days.map(day => ({ text: dayText(day), days: [day] })) : [{ text: rangeText(days, short), days }];
}
// Options are ranked by what they keep: `unnamed` is how many changed dates
// (or visits) a reader only learns as a count, `style` how readable a
// complete form is (full dates, ranges, short dates). A form never drops a
// change without counting it and never cuts a date short.
const optionList = () => {
  const list = [];
  list.add = (text, unnamed, style = 0) => { if (text && !list.some(option => option.text === text)) list.push({ text, unnamed, style }); };
  return list;
};
const size = text => [...text].length;
const pick = (options, max) => options.find(option => size(option.text) <= max)?.text ?? shortestOption(options)?.text ?? '';
/** The most compact of a list of date options (null for none). */
export const shortestOption = options => options.reduce((short, option) => !short || size(option.text) < size(short.text) ? option : short, null);

/** Every lossless way to name the days (and, on a day still worked, the
 * hours) in `cuts`, most informative first: every day in full, as ranges,
 * then short; then the first few short and how many more dates; then only
 * how many dates. */
export function lostOptions(cuts = [], { working = [] } = {}) {
  const worked = new Set(working.flatMap(slotDays)), valid = cuts.filter(validSlot), options = optionList();
  ['long', 'range', 'short'].forEach((mode, index) => options.add(joined(valid.flatMap(cut => cutItems(cut, worked, mode)).map(item => item.text)), 0, 2 - index));
  const items = valid.flatMap(cut => cutItems(cut, worked, 'short'));
  for (let keep = items.length - 1; keep >= 1; keep -= 1) {
    const rest = unnamedDays(items.slice(keep), new Set(items.slice(0, keep).flatMap(item => item.days)));
    if (rest) options.add(`${items.slice(0, keep).map(item => item.text).join(', ')} and ${plural(rest, 'more date')}`, rest);
  }
  const total = unnamedDays(items);
  if (total > 1) options.add(plural(total, 'date'), total);
  return options.map(({ text, unnamed, style }) => ({ text, unnamed, style }));
}
/** The most informative of lostOptions within `max` characters, else the most
 * compact one (which may be longer: a caller with a hard limit refuses it). */
export const describeLost = (cuts = [], { working = [], max = 90 } = {}) => pick(lostOptions(cuts, { working }), max);

/** Every lossless way to name the work a positive text is about, most
 * informative first: its first new or changed slot (a range when it spans
 * days) with any other new slots, or with the other visits of one recurring
 * run (`batch`: {count, lastDate}), in full then short; then the first slot
 * short with the next few and how many more dates, or how many more visits.
 * The first slot is always named: the arrival window is its time. */
export function workOptions(added = [], { batch = null } = {}) {
  const [lead, ...others] = added.filter(validSlot), options = optionList();
  if (!lead) return [];
  const visits = batch && Number.isInteger(batch.count) && batch.count > 0 && validDate(batch.lastDate) ? batch : null;
  for (const short of [false, true]) {
    const first = rangeText(slotDays(lead), short), style = short ? 0 : 1;
    if (visits) options.add(`${first}, plus ${plural(visits.count, 'more visit')} through ${dayText(visits.lastDate, short)}`, visits.count - 1, style);
    else options.add(others.length ? `${first}, plus ${joined(others.map(slot => rangeText(slotDays(slot), short)))}` : first, 0, style);
  }
  const first = rangeText(slotDays(lead), true);
  if (visits) options.add(`${first}, plus ${plural(visits.count, 'more visit')}`, visits.count);
  else {
    const items = others.map(slot => ({ text: rangeText(slotDays(slot), true), days: slotDays(slot) }));
    for (let keep = items.length - 1; keep >= 0; keep -= 1) {
      const rest = unnamedDays(items.slice(keep), new Set([...slotDays(lead), ...items.slice(0, keep).flatMap(item => item.days)]));
      if (rest) options.add(`${first}, plus ${keep ? `${items.slice(0, keep).map(item => item.text).join(', ')} and ` : ''}${plural(rest, 'more date')}`, rest);
    }
  }
  return options.map(({ text, unnamed, style }) => ({ text, unnamed, style }));
}
/** The most informative of workOptions within `max` characters, else the most
 * compact one. */
export const describeWork = (added = [], { batch = null, max = 90 } = {}) => pick(workOptions(added, { batch }), max);

const hex = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** The row id is derived from the dedupe key, so one save can only ever queue
 * one notice per employee and intent. */
export const crewNoticeId = async dedupeKey => `crew_${(await hex(`egc-crew-notice:${dedupeKey}`)).slice(0, 40)}`;
/** The crewNoticeHeard record id for one job and employee. */
export const crewHeardId = async (jobId, employeeId) => `heard_${(await hex(`egc-crew-heard:${jobId}\n${employeeId}`)).slice(0, 40)}`;

/** The approved-send key a notice's text is recorded under, whichever of the
 * crew wordings it goes out with, so one notice is texted at most once. */
export const crewNoticeSendKey = ({ jobId, employeeId, id }) => `crew_notice:${jobId}:${employeeId}:${id}`;

/** Create-only outbox writes for dispatch's commit. `batch` names one
 * recurring-plan run (recurring-plan-service sets it on the store it hands
 * dispatch): the new visits it creates for an employee are one text, naming
 * how many there are and their last date. A dispatcher's own "repeat this
 * job" create has no batch, so each such visit is its own text. */
export async function crewNotificationWrites({ jobId, requestId, action = '', actorId = '', type = '', before = null, after = null, roster = [], now, batch = '', baseRevision }) {
  const notices = buildCrewNotifications(before, after, roster, now, { jobId, requestId, type });
  const serviceType = text(after?.serviceType || before?.serviceType, 80), batchKey = !before ? text(batch, 240) : '';
  // The job revision this save was made against orders a job's saves without
  // trusting worker clocks: each save is preconditioned on the one before it.
  const base = !before ? '' : typeof baseRevision === 'string' ? baseRevision.slice(0, 64) : null;
  return Promise.all(notices.map(async notice => ({ collection: CREW_NOTIFICATIONS, id: await crewNoticeId(notice.dedupeKey), patch: {
    ...notice, jobType: text(type, 40), serviceType, dispatchRequestId: requestId, baseRevision: base, action: text(action, 60), actorId: assignmentKey(actorId), batchKey: notice.intent === 'assigned' ? batchKey : '', batchedInto: '',
    status: 'pending', attempts: 0, nextAttemptAt: '', lastStatus: '', lastReason: '', attentionUntil: '', deliveredAt: '', acknowledged: false, acknowledgedAt: '', createdAt: now, updatedAt: now,
  } })));
}
