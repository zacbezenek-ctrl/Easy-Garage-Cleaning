import { validDate, addDays } from './dispatch-time.js';

/** The legacy Hub calendar "Block day" toggle stores one blocked_days/<YYYY-MM-DD>
 * document per Denver date; its existence is the whole block. Dispatch only reads
 * those documents. It never migrates, rewrites or deletes them.
 * EGC_DISPATCH_LEGACY_BLOCKED_DAYS: off (default and any unknown value: no
 * blocked_days reads; conflicts and openings are unchanged) | warn (opt-in:
 * openings skip the day and placing work returns a warning) | enforce (opt-in:
 * placing work or picking up a shift on the day is a 409 conflict). */
export const LEGACY_BLOCK_MODES = ['off','warn','enforce'];
export function legacyBlockMode(env) {
  const value = String(env?.EGC_DISPATCH_LEGACY_BLOCKED_DAYS ?? '').trim().toLowerCase();
  return LEGACY_BLOCK_MODES.includes(value) ? value : 'off';
}

export const legacyBlockId = date => `legacy_blocked_day_${date.replaceAll('-','')}`;
/** A company-wide, full Denver-day block in the native schedule row shape. */
export function legacyBlockRow(date) {
  return {id:legacyBlockId(date),type:'blocked',legacySource:'blocked_days',title:'Blocked day',date,time:'00:00',endDate:addDays(date,1),endTime:'00:00',assignedCrew:[],assignedTo:'',status:'scheduled',pipelineStatus:'scheduled'};
}

export function legacyBlockWarning(jobId, row) {
  return {code:'legacy_blocked_day',jobId,date:row.date,legacyBlockId:row.id,message:`${row.date} is blocked on the Hub calendar. Confirm the day is open or choose another date.`};
}

/** Stores without the reader or without an explicit warn/enforce mode keep the
 * current behavior and perform no reads. A store read failure propagates so
 * callers fail closed. */
export async function legacyBlockedDays(store, dates) {
  const mode = typeof store?.legacyBlockedDays === 'function' && LEGACY_BLOCK_MODES.includes(store.legacyBlockMode) ? store.legacyBlockMode : 'off';
  const wanted = [...new Set(dates || [])].filter(validDate).sort();
  if (mode === 'off' || !wanted.length) return {mode,rows:[]};
  const found = await store.legacyBlockedDays(wanted);
  if (!Array.isArray(found)) throw Object.assign(new Error('Legacy blocked calendar days could not be verified. Retry before scheduling.'),{code:'dispatch_storage_incomplete',status:503});
  return {mode,rows:wanted.filter(date => found.includes(date)).map(legacyBlockRow)};
}
