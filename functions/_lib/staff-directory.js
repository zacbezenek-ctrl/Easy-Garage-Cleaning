import { addDays, denverToday, validDate } from './dispatch-time.js';
import { STAFF_ROLES, can, defaultStaffRoles, primaryStaffRole, sanitizeStaffRoles, staffCapabilities, staffPasswordResetEnabled } from './staff-roles.js';
import { SKILL_CATALOG, SKILL_CATALOG_VERSION, SKILL_LEVELS, storedSkills, validateSkills } from './staff-skills.js';
import { auditWrite } from './hub-audit.js';
import { payOwnerOnly } from './pay-visibility.js';
import { firebaseRevocationTime, recordStaffFirebaseIntent, revokeStaffFirebaseSessions, settleStaffFirebaseIntent } from './firebase-revocation.js';
import { isHubOwner, staffRoleAccessEnabled } from './hub-session.js';

// Staff directory: roles, skills, effective-dated pay, weekly availability and the Gusto
// employee ID are additive fields on the existing encrypted 'profiles' payload (no new
// vault family, so older readers keep working). Employee-account roles are authoritative on the
// encrypted account (sessions read them there) and mirrored onto the profile.
// hourlyRate stays on the profile, mirrored to the current effective rate.
export const WEEK_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const LEGACY_EFFECTIVE_FROM = '2000-01-01';
const PAY_TYPES = ['hourly', 'salary'];
const HISTORY_LIMIT = 200, PAY_RATE_LIMIT = 60, VIEW_HISTORY = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const COMMON = ['action', 'requestId', 'username', 'expectedRevision', 'expectedUser', 'reason'];
// Profile (D10, owner 2026-10-17): the uniform shirt size, the birth date and whether teammates see the birthday's month and
// day (birthdayVisibleToTeam, absent means yes), plus the manager-set HighLevel user ID for later appointment assignment.
// Age is derived from birthDate on the Denver calendar date at read time and never stored. Birth year and age reach only the
// person themselves, the owner and managers; teammates see the month and day, never customers or the public.
export const SHIRT_SIZES = Object.freeze(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']);
export const PERSONAL_FIELDS = Object.freeze(['shirtSize', 'birthDate', 'birthdayVisibleToTeam', 'highlevelUserId']);
// What an employee sets on their own profile; the HighLevel user ID is a manager's.
export const SELF_PERSONAL_FIELDS = Object.freeze(['shirtSize', 'birthDate', 'birthdayVisibleToTeam']);
const ACTIONS = { set_roles: ['staffRoles'], set_skills: ['skills'], set_pay: ['effectiveFrom', 'hourlyRate', 'payType', 'overtimeMultiplier'], set_availability: ['weeklyAvailability'], set_gusto_id: ['gustoEmployeeId', 'gustoExcluded'], set_personal: PERSONAL_FIELDS };
// The employee's ID in Gusto (GUSTO-EXPORT): the owner copies it from Gusto, and the Gusto hours file is keyed by it.
// Letters, digits, dots, dashes and underscores, so Gusto's numeric IDs and UUIDs both fit. Owner-only, never shown to crew.
// gustoExcluded (true) marks someone not paid through Gusto (the owner's own field time, a 1099 worker): the Gusto file
// leaves them out and says so. Absent means paid through Gusto, as before.
const GUSTO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const storedGustoEmployeeId = value => typeof value === 'string' && GUSTO_ID.test(value) ? value : null;

export const staffDirectoryEnabled = env => env?.EGC_STAFF_DIRECTORY_ENABLED === 'true';
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'staff_directory_' + code, status, ...(details ? { details } : {}) });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const personKey = value => String(value || '').trim().toLowerCase();
// Same legacy profile ids employee-hub.js reads, in the same order.
export const legacyPersonKeys = value => [...new Set([
  personKey(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee',
  personKey(value).replace(/[^a-z0-9]/g, ''),
])].filter(key => key && key !== personKey(value));
const same = (left, right) => personKey(left) === personKey(right);
const auditActor = value => personKey(value).replace(/[^a-z0-9_.@:+-]/g, '_');
const auditEntity = value => personKey(value).replace(/[^a-z0-9_.:-]/g, '_');
export const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : record(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);

const minutes = value => value === '24:00' ? 1440 : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export function normalizeWeeklyAvailability(value) {
  const invalid = message => fail('invalid_availability', message);
  if (!record(value) || Object.keys(value).some(day => !WEEK_DAYS.includes(day))) throw invalid('Weekly availability uses the days mon through sun only.');
  return Object.fromEntries(WEEK_DAYS.map(day => {
    const windows = value[day] ?? [];
    if (!Array.isArray(windows) || windows.length > 4) throw invalid('Each day can have at most four available windows.');
    const parsed = windows.map(window => {
      if (!record(window) || Object.keys(window).some(key => !['start', 'end'].includes(key)) || typeof window.start !== 'string' || typeof window.end !== 'string' ||
          !TIME.test(window.start) || !(TIME.test(window.end) || window.end === '24:00') || minutes(window.end) <= minutes(window.start)) throw invalid('Each window needs a start before its end as HH:MM Denver time.');
      return { start: window.start, end: window.end };
    }).sort((a, b) => a.start.localeCompare(b.start));
    if (parsed.some((window, index) => index && minutes(window.start) < minutes(parsed[index - 1].end))) throw invalid('Available windows on the same day cannot overlap.');
    return [day, parsed];
  }));
}
// Readers tolerate a missing or malformed stored week; it is never repaired silently.
export function storedWeeklyAvailability(value) {
  if (value === undefined || value === null) return null;
  try { return normalizeWeeklyAvailability(value); } catch { return null; }
}

// A birthday is 14 to 100 years before today (Denver); never in the future.
const MIN_AGE = 14, MAX_AGE = 100;
// HighLevel user IDs are letters and digits (20 today); dashes and underscores are kept in case that changes.
const HIGHLEVEL_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const storedShirtSize = value => SHIRT_SIZES.includes(value) ? value : null;
export const storedBirthDate = value => validDate(value) ? value : null;
export const storedHighlevelUserId = value => typeof value === 'string' && HIGHLEVEL_USER_ID.test(value) ? value : null;
/** Whole years from birthDate to the Denver date today (both YYYY-MM-DD), or null. A Feb 29 birthday counts on Mar 1 in other years. */
export function ageOn(birthDate, today) {
  if (!validDate(birthDate) || !validDate(today) || birthDate > today) return null;
  const [year, month, day] = birthDate.split('-').map(Number), [nowYear, nowMonth, nowDay] = today.split('-').map(Number);
  return nowYear - year - (nowMonth < month || nowMonth === month && nowDay < day ? 1 : 0);
}
function personalValue(key, value, today) {
  const invalid = message => fail('invalid_personal', message);
  if (key === 'birthdayVisibleToTeam') {
    if (typeof value !== 'boolean') throw invalid('Choose whether teammates see the birthday.');
    return value;
  }
  if (value === null || value === '') return null;
  if (key === 'shirtSize') {
    const size = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!SHIRT_SIZES.includes(size)) throw invalid(`Choose a shirt size: ${SHIRT_SIZES.join(', ')}.`);
    return size;
  }
  if (key === 'birthDate') {
    if (!validDate(value)) throw invalid('Enter the birthday as a calendar date (YYYY-MM-DD).');
    const age = ageOn(value, today);
    if (age === null) throw invalid('The birthday cannot be in the future.');
    if (age < MIN_AGE || age > MAX_AGE) throw invalid(`Enter a birthday from ${MIN_AGE} to ${MAX_AGE} years ago.`);
    return value;
  }
  const id = typeof value === 'string' ? value.trim() : '';
  if (!HIGHLEVEL_USER_ID.test(id)) throw invalid('Enter the HighLevel user ID as HighLevel shows it: letters and digits, at most 64 characters. Leave it blank to remove it.');
  return id;
}
/** The personal fields an input sets, validated ({} when it names none). null or '' clears a field; birthdayVisibleToTeam
 * takes true or false. today is the Denver date the birthday is checked against. lenient (an onboarding draft autosave)
 * leaves out a value it cannot use instead of refusing the save. */
export function personalInput(input, today, { fields = PERSONAL_FIELDS, lenient = false } = {}) {
  const out = {};
  for (const key of fields) {
    if (!record(input) || !Object.hasOwn(input, key)) continue;
    try { out[key] = personalValue(key, input[key], today); }
    catch (error) { if (!lenient) throw error; }
  }
  return out;
}
const personalShape = profile => ({ shirtSize: storedShirtSize(profile?.shirtSize), birthDate: storedBirthDate(profile?.birthDate),
  birthdayVisibleToTeam: profile?.birthdayVisibleToTeam !== false, highlevelUserId: storedHighlevelUserId(profile?.highlevelUserId) });
// Emergency contact: the crew onboarding names, else the older manager form's single emergencyContact text (as the name).
export function emergencyContact(profile) {
  const text = value => typeof value === 'string' ? value.trim().slice(0, 100) : '';
  return { name: text(profile?.emergencyContactName) || text(profile?.emergencyContact), phone: text(profile?.emergencyContactPhone).slice(0, 40) };
}

function dollars(value, label = 'Hourly rate') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 500 || Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw fail('invalid_pay', `${label} must be between $0 and $500, exact to the cent.`);
  return Math.round(value * 100) / 100;
}
function multiplier(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 3 || Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw fail('invalid_pay', 'The overtime multiplier must be between 1 and 3.');
  return Math.round(value * 100) / 100;
}
const validRate = entry => record(entry) && validDate(entry.effectiveFrom) && typeof entry.hourlyRate === 'number' && Number.isFinite(entry.hourlyRate) && entry.hourlyRate >= 0 &&
  typeof entry.payType === 'string' && typeof entry.overtimeMultiplier === 'number' && entry.overtimeMultiplier >= 1 && entry.overtimeMultiplier <= 3;
// The effective-dated schedule, oldest first. A malformed schedule is ignored as a
// whole (null) so pay falls back to the legacy hourlyRate instead of a guess.
export function storedPayRates(value) {
  if (!Array.isArray(value) || !value.length || !value.every(validRate)) return null;
  const rates = [...value].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return rates.some((entry, index) => index && entry.effectiveFrom === rates[index - 1].effectiveFrom) ? null : rates.map(clone);
}

const legacyRate = profile => { const rate = Number(profile?.hourlyRate); return profile && Number.isFinite(rate) && rate >= 0 ? rate : null; };
// The rate in effect on a Denver calendar date. hourlyRate is the legacy mirror; if a
// legacy editor (the employee-hub profile form) set it to a value the schedule never
// produced since the directory last mirrored it, that edit wins and is reported as drift.
export function effectivePayRate(profile, date) {
  const rates = storedPayRates(profile?.payRates), legacy = legacyRate(profile);
  const fallback = source => ({ hourlyRate: legacy, payType: typeof profile?.payType === 'string' && profile.payType ? profile.payType : 'hourly', overtimeMultiplier: null, effectiveFrom: null, source, drift: false });
  if (!rates) return fallback(profile?.payRates === undefined ? 'legacy_hourly_rate' : 'pay_rates_need_review');
  const effective = rates.filter(entry => entry.effectiveFrom <= date), entry = effective.at(-1);
  if (!entry) return fallback('legacy_hourly_rate');
  const mirror = profile.payRateMirror, since = record(mirror) && validDate(mirror.effectiveFrom) ? mirror.effectiveFrom : '';
  if (legacy !== null && !effective.some(item => item.effectiveFrom >= since && item.hourlyRate === legacy)) return { ...fallback('legacy_profile_edit'), drift: true };
  return { hourlyRate: entry.hourlyRate, payType: entry.payType, overtimeMultiplier: entry.overtimeMultiplier, effectiveFrom: entry.effectiveFrom, source: 'pay_rates', drift: false };
}
// The pay rate snapshotted at clock-in: null when the profile has no usable rate.
export function profileHourlyRate(profile, now = new Date().toISOString()) {
  return effectivePayRate(profile, denverToday(new Date(now))).hourlyRate;
}
// The legacy payType string kept as it was in a seeded schedule entry; only a missing one is 'hourly'.
export const legacyPayType = value => typeof value === 'string' && value.trim() && value.length <= 40 ? value : 'hourly';

// Legacy /api/employee-hub profile writes keep hourlyRate in step with the schedule: unless
// the save deliberately set hourlyRate, the stored rate becomes the rate in effect today,
// and payRateMirror moves to that entry so a later legacy edit is measured from it (drift).
export function mirrorLegacyPay(previous, next, now, edited = false) {
  const current = effectivePayRate(record(previous) ? previous : {}, denverToday(new Date(now)));
  if (current.source !== 'pay_rates') return next;
  const mirror = record(previous?.payRateMirror) ? previous.payRateMirror : {};
  const moved = mirror.hourlyRate !== current.hourlyRate || mirror.effectiveFrom !== current.effectiveFrom;
  return { ...next, hourlyRate: edited ? next.hourlyRate : current.hourlyRate, ...(moved ? { payRateMirror: { hourlyRate: current.hourlyRate, effectiveFrom: current.effectiveFrom, at: now } } : {}) };
}

function reasonText(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 500) throw fail('invalid_request', 'The reason must be text of at most 500 characters.');
  return value.trim();
}
function validateInput(input) {
  if (!record(input) || !Object.hasOwn(ACTIONS, input.action)) throw fail('invalid_request', 'Choose a supported staff directory change.');
  if (Object.keys(input).some(key => !COMMON.includes(key) && !ACTIONS[input.action].includes(key))) throw fail('invalid_request', 'The staff directory request contains unsupported fields. Refresh and try again.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('invalid_request', 'The change needs a request id. Refresh and try again.');
  if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 80) throw fail('invalid_request', 'Choose a staff member.');
  if (typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 100) throw fail('invalid_request', 'The change needs the revision you reviewed. Refresh and try again.');
  if (input.expectedUser !== undefined && (typeof input.expectedUser !== 'string' || !input.expectedUser.trim() || input.expectedUser.length > 80)) throw fail('invalid_request', 'The change names an invalid account. Refresh and try again.');
  return reasonText(input.reason);
}

function staffRolesChange(person, input, session) {
  if (person.source !== 'employee_account') throw fail('configured_account', 'Configured Hub users keep the roles and pay set in the Hub user configuration.', 409);
  const roles = input.staffRoles;
  if (!Array.isArray(roles) || !roles.length || roles.length > STAFF_ROLES.length || roles.some(role => typeof role !== 'string' || !STAFF_ROLES.includes(role)) || new Set(roles).size !== roles.length) throw fail('invalid_roles', 'Choose one or more staff roles: manager, crew_lead, crew, sales or phone.');
  if (roles.includes('owner')) throw fail('owner_role_reserved', 'The owner role belongs only to the configured owner account.', 403);
  const next = STAFF_ROLES.filter(role => roles.includes(role));
  // A manager the owner lets approve accounts (STAFF-ACCESS) sets roles, but never gives or removes the manager role and
  // never changes a manager's roles (as for their account review and sign-in reset).
  if (!isHubOwner(session) && (next.includes('manager') || person.staffRoles.includes('manager'))) throw fail('owner_role_reserved', 'Only the owner can give or remove the manager role, or change a manager\'s roles.', 403);
  return canonicalJson(next) === canonicalJson(person.staffRoles) ? null : { scope: 'roles', staffRoles: next, before: { staffRoles: person.staffRoles }, after: { staffRoles: next } };
}

// employee-hub.js falls back to the account's rate when the profile has none.
export const payProfile = person => {
  const profile = person.profile || {};
  return legacyRate(profile) === null && legacyRate({ hourlyRate: person.accountHourlyRate }) !== null ? { ...profile, hourlyRate: person.accountHourlyRate } : profile;
};

// STAFF-ACCESS (EGC_STAFF_PASSWORD_RESET on): an employee account's first rate (no rate above $0 yet: no pay schedule, or
// one holding only $0 entries such as the legacy baseline the staff-profile-pay-roles-v1 migration or a $0 set_pay
// writes) may take effect from the Denver day its account was first approved, so the owner can pay shifts worked before
// the rate was set ('Apply rate to open weeks' then updates those $0 timecards). '' when there is no earlier floor.
export function firstRateFrom(person, today, env) {
  if (!staffPasswordResetEnabled(env) || person?.source !== 'employee_account') return '';
  const profile = payProfile(person), rates = storedPayRates(profile.payRates);
  if (profile.payRates !== undefined && !rates?.every(entry => entry.hourlyRate === 0) || (legacyRate(profile) ?? 0) > 0) return '';
  const approved = Date.parse(person.approvedAt || ''), day = Number.isFinite(approved) ? denverToday(new Date(approved)) : '';
  return validDate(day) && day < today ? day : '';
}

export function payChange(person, input, actor, nowIso, today, firstFrom = '') {
  if (person.source !== 'employee_account') throw fail('configured_account', 'Configured Hub users keep the roles and pay set in the Hub user configuration.', 409);
  if (firstFrom && validDate(input.effectiveFrom) && input.effectiveFrom < today && input.effectiveFrom < firstFrom) throw fail('invalid_pay', `This first rate can take effect from ${firstFrom}, the day the account was approved (Denver time), through one year ahead.`);
  if (!validDate(input.effectiveFrom) || input.effectiveFrom < (firstFrom || today) || input.effectiveFrom > addDays(today, 366)) throw fail('invalid_pay', 'Choose an effective date from today through one year ahead (Denver time). Earlier timecards keep the rate saved at clock-in.');
  const profile = payProfile(person), stored = storedPayRates(profile.payRates);
  if (profile.payRates !== undefined && !stored) throw fail('pay_needs_review', 'The saved pay schedule needs owner review before it can be changed.', 409);
  const current = effectivePayRate(profile, today);
  let rates = stored;
  if (!rates) rates = [{ effectiveFrom: LEGACY_EFFECTIVE_FROM, hourlyRate: current.hourlyRate ?? 0, payType: legacyPayType(profile.payType), overtimeMultiplier: 1.5, setBy: 'legacy_profile', setAt: nowIso, source: 'legacy_hourly_rate' }];
  else if (current.drift) rates = [...rates.filter(entry => entry.effectiveFrom !== today), { effectiveFrom: today, hourlyRate: current.hourlyRate, payType: current.payType, overtimeMultiplier: 1.5, setBy: 'legacy_profile', setAt: nowIso, source: 'legacy_profile_edit' }];
  const previous = rates.filter(entry => entry.effectiveFrom <= input.effectiveFrom).at(-1) || null;
  const payType = input.payType === undefined ? (PAY_TYPES.includes(previous?.payType) ? previous.payType : 'hourly') : input.payType;
  if (!PAY_TYPES.includes(payType)) throw fail('invalid_pay', 'Choose hourly or salary pay.');
  const entry = { effectiveFrom: input.effectiveFrom, hourlyRate: dollars(input.hourlyRate), payType, overtimeMultiplier: input.overtimeMultiplier === undefined ? 1.5 : multiplier(input.overtimeMultiplier), setBy: actor, setAt: nowIso };
  const replaced = rates.find(item => item.effectiveFrom === entry.effectiveFrom);
  if (stored && !current.drift && replaced && ['hourlyRate', 'payType', 'overtimeMultiplier'].every(key => replaced[key] === entry[key])) return null;
  const next = [...rates.filter(item => item.effectiveFrom !== entry.effectiveFrom), entry].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (next.length > PAY_RATE_LIMIT) throw fail('invalid_pay', 'This pay schedule is full. Ask the owner to archive older rates.', 409);
  const resolved = next.filter(item => item.effectiveFrom <= today).at(-1) || { hourlyRate: current.hourlyRate ?? 0, effectiveFrom: '' };
  // Amounts stay in the sealed profile history; the plaintext audit log gets only the schedule shape.
  const shape = rate => ({ effectiveFrom: rate.effectiveFrom, payType: rate.payType, overtimeMultiplier: rate.overtimeMultiplier });
  return { scope: 'pay', payRates: next, hourlyRate: resolved.hourlyRate, payRateMirror: { hourlyRate: resolved.hourlyRate, effectiveFrom: resolved.effectiveFrom, at: nowIso },
    before: { hourlyRate: current.hourlyRate, entry: replaced ? clone(replaced) : null }, after: { hourlyRate: resolved.hourlyRate, entry },
    auditView: { before: replaced ? shape(replaced) : null, after: { ...shape(entry), currentRateChanged: resolved.hourlyRate !== current.hourlyRate } } };
}

// An empty ID removes it. Two people never share one ID, active or not: the Gusto file would pay one of them twice
// (holders: gustoPayrollProfiles of every stored profile). gustoExcluded left out keeps the saved marker. The plaintext
// audit log gets only whether an ID is set and the marker; the IDs stay in the sealed, owner-only profile history.
function gustoIdChange(person, input, holders) {
  const value = typeof input.gustoEmployeeId === 'string' ? input.gustoEmployeeId.trim() : null;
  if (value === null || value && !GUSTO_ID.test(value)) throw fail('invalid_gusto_id', 'Enter the Gusto employee ID as Gusto shows it: letters, digits, dots, dashes or underscores, at most 64 characters. Leave it blank to remove it.');
  if (input.gustoExcluded !== undefined && typeof input.gustoExcluded !== 'boolean') throw fail('invalid_gusto_id', 'Choose whether this person is paid through Gusto.');
  const next = value || null, stored = person.profile?.gustoEmployeeId ?? null, before = storedGustoEmployeeId(stored);
  const wasExcluded = person.profile?.gustoExcluded === true, excluded = input.gustoExcluded ?? wasExcluded;
  if (next === stored && excluded === wasExcluded) return null;
  const other = next && [...holders].find(([key, holder]) => key !== person.key && holder.gustoEmployeeId?.toLowerCase() === next.toLowerCase());
  if (other) throw fail('gusto_id_in_use', `That Gusto employee ID is already saved for ${other[1].displayName || other[0]}. Each employee needs their own.`, 409);
  return { scope: 'gusto', gustoEmployeeId: next, gustoExcluded: excluded, before: { gustoEmployeeId: before, gustoExcluded: wasExcluded }, after: { gustoEmployeeId: next, gustoExcluded: excluded },
    auditView: { before: { gustoEmployeeIdSet: Boolean(before), gustoExcluded: wasExcluded }, after: { gustoEmployeeIdSet: Boolean(next), gustoExcluded: excluded } } };
}

// set_personal: the person themselves or a manager; only a manager sets the HighLevel user ID. The plaintext audit log
// gets the shirt size, the visibility and whether a birthday and HighLevel user are set, never the date or the ID; the
// sealed profile history (shown to the person and managers) keeps the detail.
function personalChange(person, input, manages, today) {
  if (Object.hasOwn(input, 'highlevelUserId') && !manages) throw fail('forbidden', 'Only a manager can set the HighLevel user ID.', 403);
  const fields = personalInput(input, today);
  if (!Object.keys(fields).length) throw fail('invalid_personal', 'Choose a shirt size, birthday or HighLevel user ID to save.');
  const before = personalShape(person.profile), after = personalShape({ ...(person.profile || {}), ...fields });
  if (canonicalJson(before) === canonicalJson(after)) return null;
  const shape = value => ({ shirtSize: value.shirtSize, birthDateSet: Boolean(value.birthDate), birthdayVisibleToTeam: value.birthdayVisibleToTeam, highlevelUserIdSet: Boolean(value.highlevelUserId) });
  return { scope: 'personal', ...fields, before, after, auditView: { before: shape(before), after: shape(after) } };
}

/** What the Gusto hours file (GUSTO-EXPORT) needs from each username's profile, read from the profile the staff directory
 * writes: the one saved under the username's key, else a legacy key for it, as the directory and the dispatch roster pick
 * it. Each entry is { gustoEmployeeId (null when unset or unreadable), gustoExcluded, displayName (null when unset) }. A
 * username with no such profile has no entry, so the Gusto file names that employee instead of guessing. */
export function gustoPayrollProfiles(profiles) {
  const chosen = new Map();
  for (const row of Array.isArray(profiles) ? profiles : []) {
    const key = personKey(row?.username), rank = key ? [key, ...legacyPersonKeys(key)].indexOf(row.id) : -1;
    if (rank >= 0 && (!chosen.has(key) || rank < chosen.get(key).rank)) chosen.set(key, { rank, row });
  }
  return new Map([...chosen].map(([key, { row }]) => [key, { gustoEmployeeId: storedGustoEmployeeId(row.gustoEmployeeId), gustoExcluded: row.gustoExcluded === true,
    displayName: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim().slice(0, 180) : null }]));
}

// The plaintext audit log gets skill ids and levels only; verifications stay in the sealed history.
const skillLevels = skills => skills.map(({ id, level }) => ({ id, level }));
function skillsChange(person, input, actor, nowIso) {
  const next = validateSkills(input.skills, person.profile?.skills, actor, nowIso), before = storedSkills(person.profile?.skills);
  return canonicalJson(next) === canonicalJson(before) && person.profile?.skillCatalogVersion === SKILL_CATALOG_VERSION ? null
    : { scope: 'skills', skills: next, skillCatalogVersion: SKILL_CATALOG_VERSION, before: { skills: before }, after: { skills: next },
      auditView: { before: { skills: skillLevels(before) }, after: { skills: skillLevels(next) } } };
}

// The plaintext audit log gets per-day window counts and the changed days, not the hours.
const windowsPerDay = week => Object.fromEntries(WEEK_DAYS.map(day => [day, week[day].length]));
function availabilityChange(person, input) {
  const next = normalizeWeeklyAvailability(input.weeklyAvailability), before = storedWeeklyAvailability(person.profile?.weeklyAvailability);
  if (canonicalJson(next) === canonicalJson(before)) return null;
  const changedDays = WEEK_DAYS.filter(day => canonicalJson(next[day]) !== canonicalJson(before?.[day] ?? []));
  return { scope: 'availability', weeklyAvailability: next, before: { weeklyAvailability: before }, after: { weeklyAvailability: next },
    auditView: { before: { weeklyAvailability: before ? { windowsPerDay: windowsPerDay(before) } : null }, after: { weeklyAvailability: { windowsPerDay: windowsPerDay(next), changedDays } } } };
}

export function appendHistory(history, entry) {
  return [...(Array.isArray(history) ? history : []), entry].slice(-HISTORY_LIMIT);
}

// Fields only the staff directory (and vault migrations) write. The legacy
// /api/employee-hub profile save cannot set them, and its reads omit the audit trail
// and the pay schedule: /api/staff-directory serves those with its own permissions.
// The personal fields (D10) are written by set_personal; the one exception is an employee's own onboarding form
// (employee-hub.js, EGC_STAFF_DIRECTORY_ENABLED), which sets their SELF_PERSONAL_FIELDS through personalInput().
export const DIRECTORY_PROFILE_FIELDS = Object.freeze(['staffRoles', 'skills', 'skillCatalogVersion', 'payRates', 'payRateMirror', 'weeklyAvailability', 'gustoEmployeeId', 'gustoExcluded', 'history', 'migrations', 'directoryRequestId', 'directoryUpdatedAt', 'directoryUpdatedBy', ...PERSONAL_FIELDS]);
const LEGACY_HIDDEN = new Set(['history', 'payRates', 'payRateMirror', 'gustoEmployeeId', 'gustoExcluded']), LEGACY_PAY_FIELDS = ['hourlyRate', 'payType'];
export const legacyProfileInput = (incoming, { stripPay = false } = {}) => Object.fromEntries(Object.entries(incoming || {}).filter(([key]) => !DIRECTORY_PROFILE_FIELDS.includes(key) && !(stripPay && LEGACY_PAY_FIELDS.includes(key))));
// Legacy readers (team board, profile form) see hourlyRate as the rate in effect today.
export function legacyProfileView(profile, now = new Date().toISOString()) {
  if (!record(profile)) return profile;
  const view = Object.fromEntries(Object.entries(profile).filter(([key]) => !LEGACY_HIDDEN.has(key))), current = effectivePayRate(profile, denverToday(new Date(now)));
  return current.source === 'pay_rates' ? { ...view, hourlyRate: current.hourlyRate } : view;
}
// With the directory on, pay changes go only through set_pay, and with EGC_STAFF_PAY_OWNER_ONLY on (the default)
// pay is the owner's: legacy profile saves by anyone without pay.manage cannot set hourlyRate or payType.
export const legacyPayLocked = (session, env) => (staffDirectoryEnabled(env) || payOwnerOnly(env)) && !can(session, 'pay.manage', env);
// A manager's legacy /api/employee-hub profile save. With pay locked, the manager's own
// profile keeps mirroring the Hub configuration (what ensureOwnProfile sends); every other
// profile keeps its stored pay.
export function legacyManagerProfile({ env, session, existing, incoming, id, now }) {
  const stripPay = legacyPayLocked(session, env), input = legacyProfileInput(incoming, { stripPay });
  const own = stripPay && same(existing?.username || incoming?.username || '', session.user);
  const next = { ...(existing || {}), ...input, ...(own ? { payType: session.payType, hourlyRate: session.hourlyRate } : {}), id };
  return mirrorLegacyPay(existing, next, now, own || Object.hasOwn(input, 'hourlyRate'));
}

function payView(person, today, firstFrom = '') {
  const profile = payProfile(person);
  const current = effectivePayRate(profile, today), rates = storedPayRates(profile?.payRates) || [];
  // Configured Hub users' pay lives in the Hub configuration, which set_pay cannot change.
  return { current, upcoming: rates.filter(entry => entry.effectiveFrom > today), schedule: rates, needsReview: person.source !== 'configured' && (current.source === 'pay_rates_need_review' || current.drift), ...(firstFrom ? { firstRateFrom: firstFrom } : {}) };
}

// The profile record the directory reads and writes for a person: the one saved under their key, else a legacy key.
// Profiles for their username under any other id make the record ambiguous (profileNeedsReview) instead of guessed.
export function withProfile(person, records) {
  const candidates = records.filter(row => record(row.data) && same(row.data.username, person.username));
  const target = [person.key, ...legacyPersonKeys(person.username)].map(id => candidates.find(row => row.data.id === id)).find(Boolean);
  const chosen = target || candidates.at(-1);
  return Object.assign(person, { record: target || null, profile: chosen ? chosen.data : null, revision: target ? target.updateTime : '', profileNeedsReview: !target && candidates.length > 0 });
}

// An employee account's roles as the directory reads them: the stored roles, else the default its account role names.
const accountRoles = account => {
  const stored = sanitizeStaffRoles(account.staffRoles, { user: account.username, businessAccess: false });
  return { staffRoles: stored || defaultStaffRoles({ role: account.role }), staffRolesSource: stored ? 'account' : 'default' };
};

// revocations(): the Firebase session revocation service (firebase-revocation.js), or null.
export function createStaffDirectoryService({ store, env = {}, now = () => new Date(), revocations = () => null }) {
  const managesStaff = session => can(session, 'time.approve', env) || can(session, 'dispatch.write', env);

  async function roster() {
    const [{ configured, accounts }, records] = await Promise.all([store.staff(), store.profiles()]);
    const people = new Map(), add = person => {
      if (!person.key || people.has(person.key)) throw fail('roster_ambiguous', 'Employee identities need review before the staff directory can be used.', 409);
      people.set(person.key, person);
    };
    for (const profile of configured) {
      const stored = sanitizeStaffRoles(profile.staffRoles, profile);
      add({ key: personKey(profile.user), username: profile.user, displayName: profile.displayName || profile.user, source: 'configured', staffRoles: stored || defaultStaffRoles(profile), staffRolesSource: stored ? 'configuration' : 'default' });
    }
    for (const account of accounts.filter(account => account?.status === 'approved')) {
      add({ key: personKey(account.username), username: String(account.username), displayName: account.displayName || account.username, source: 'employee_account', accountStatus: account.status, accountHourlyRate: account.hourlyRate,
        ...accountRoles(account),
        // The first approval day (STAFF-ACCESS stamps approvedAt once); older accounts have only their last review time.
        approvedAt: typeof account.approvedAt === 'string' && account.approvedAt ? account.approvedAt : typeof account.reviewedAt === 'string' ? account.reviewedAt : '' });
    }
    for (const person of people.values()) withProfile(person, records);
    return { people, records, accounts };
  }

  // Former staff (GUSTO-EXPORT): people outside the active directory with a stored profile or a rejected employee account
  // (how an employee is let go), who may still have approved hours in a week the owner has not paid yet. The owner sets
  // only their Gusto fields (set_gusto_id); nothing here gives them Hub access or changes anything else of theirs.
  function formerStaff({ people, records, accounts }) {
    const former = new Map(), add = (username, displayName, accountStatus) => {
      const key = personKey(username), known = former.get(key);
      if (!key || people.has(key)) return;
      former.set(key, { key, username: known?.username || String(username).trim(), displayName: known?.displayName || (typeof displayName === 'string' && displayName.trim() ? displayName.trim() : String(username).trim()),
        source: 'former', ...(accountStatus || known?.accountStatus ? { accountStatus: accountStatus || known.accountStatus } : {}) });
    };
    for (const account of accounts) if (account?.status === 'rejected') add(account.username, account.displayName, account.status);
    for (const row of records) if (record(row.data) && typeof row.data.username === 'string') add(row.data.username, row.data.displayName);
    for (const person of former.values()) withProfile(person, records);
    return former;
  }
  const formerView = person => {
    const profile = person.profile || {};
    return { username: person.username, displayName: person.displayName, source: 'former', ...(person.accountStatus ? { accountStatus: person.accountStatus } : {}),
      gustoEmployeeId: storedGustoEmployeeId(profile.gustoEmployeeId), gustoExcluded: profile.gustoExcluded === true,
      history: (Array.isArray(profile.history) ? profile.history : []).filter(entry => record(entry) && entry.scope === 'gusto').slice(-VIEW_HISTORY), revision: person.revision, profileNeedsReview: person.profileNeedsReview };
  };

  // A full record goes only to the person themselves and to managers (list() and mutate() check that first).
  function view(person, session, today) {
    if (person.source === 'former') return formerView(person);
    const owner = can(session, 'pay.manage', env), self = same(person.username, session.user), pay = self || owner, profile = person.profile || {};
    const history = (Array.isArray(profile.history) ? profile.history : []).filter(entry => record(entry) && (pay || entry.scope !== 'pay') && (owner || entry.scope !== 'gusto')).slice(-VIEW_HISTORY);
    // The personal fields (D10) are served by the team directory card (teamCard), so this record keeps its shape.
    return {
      username: person.username, displayName: person.displayName, source: person.source, ...(person.accountStatus ? { accountStatus: person.accountStatus } : {}),
      staffRoles: person.staffRoles, staffRolesSource: person.staffRolesSource, primaryRole: primaryStaffRole(person.staffRoles),
      skills: storedSkills(profile.skills), weeklyAvailability: storedWeeklyAvailability(profile.weeklyAvailability),
      weeklyAvailabilityNeedsReview: profile.weeklyAvailability !== undefined && profile.weeklyAvailability !== null && !storedWeeklyAvailability(profile.weeklyAvailability),
      ...(pay ? { pay: payView(person, today, firstRateFrom(person, today, env)) } : {}),
      ...(owner ? { gustoEmployeeId: storedGustoEmployeeId(profile.gustoEmployeeId), gustoExcluded: profile.gustoExcluded === true } : {}),
      history, revision: person.revision, profileNeedsReview: person.profileNeedsReview,
    };
  }

  // The team directory card (GET ?view=team): what every signed-in staff member sees of everyone on the active roster
  // (name, photo, roles, crews, shirt size, the birthday's month and day when it is shared), plus the person's own birth
  // date, age and revision (to edit their own card). Managers also get everyone's birth date, age, phone, emergency
  // contact and HighLevel user ID. Pay, skills, availability, Gusto IDs and history stay in the full record.
  function teamCard(person, session, today, { manages, crewsOf, photos, accounts }) {
    const profile = person.profile || {}, self = same(person.username, session.user), personal = personalShape(profile), birthday = personal.birthDate && personal.birthdayVisibleToTeam;
    const name = typeof profile.preferredName === 'string' && profile.preferredName.trim() ? profile.preferredName.trim().slice(0, 80) : person.displayName;
    const phone = [profile.phone, accounts.get(person.key)?.phone].map(value => typeof value === 'string' ? value.trim().slice(0, 40) : '').find(Boolean) || '';
    return {
      username: person.username, displayName: String(name), staffRoles: person.staffRoles, primaryRole: primaryStaffRole(person.staffRoles), crews: crewsOf(person.key),
      photoUrl: photos?.get(person.key) || null, shirtSize: personal.shirtSize,
      birthday: birthday ? { month: Number(personal.birthDate.slice(5, 7)), day: Number(personal.birthDate.slice(8, 10)) } : null, self,
      ...(self || manages ? { birthDate: personal.birthDate, age: ageOn(personal.birthDate, today), birthdayVisibleToTeam: personal.birthdayVisibleToTeam, revision: person.revision, profileNeedsReview: person.profileNeedsReview } : {}),
      ...(manages ? { phone, emergencyContact: emergencyContact(profile), highlevelUserId: personal.highlevelUserId } : {}),
    };
  }

  function permitted(session, action, person) {
    if (action === 'set_roles') return can(session, 'accounts.approve', env);
    if (action === 'set_pay' || action === 'set_gusto_id') return can(session, 'pay.manage', env);
    if (action === 'set_skills') return managesStaff(session);
    return managesStaff(session) || same(person?.username ?? '', session.user);
  }

  // Every stored profile's Gusto ID, named as the directory names them, so an ID held by former staff is caught too.
  function gustoHolders(staff) {
    const former = formerStaff(staff);
    return new Map([...gustoPayrollProfiles(staff.records.map(row => row.data))].map(([key, holder]) => [key, { ...holder, displayName: (staff.people.get(key) || former.get(key))?.displayName || holder.displayName }]));
  }

  // The person a change is for: the active directory, or former staff for the owner's Gusto fields (set_gusto_id is
  // owner-only, checked before this).
  const target = (staff, action, key) => staff.people.get(key) || (action === 'set_gusto_id' ? formerStaff(staff).get(key) : undefined);

  // The saved outcome is returned only while the record still carries this request.
  async function replay(session, receipt, requestId, today) {
    const person = target(await roster(), receipt.action, receipt.target);
    return person?.record?.data.directoryRequestId === requestId ? { ok: true, authority: 'employee_hub', replayed: true, person: view(person, session, today) } : null;
  }

  // A crew's place in the pick order (D3): priority 1..99, lower first; absent or invalid is 99.
  const crewPriority = crew => Number.isInteger(crew?.priority) && crew.priority >= 1 && crew.priority <= 99 ? crew.priority : 99;
  function crewMembership(crews) {
    const active = (crews || []).filter(crew => record(crew) && crew.status === 'active' && Array.isArray(crew.memberIds) && typeof crew.id === 'string')
      .sort((a, b) => crewPriority(a) - crewPriority(b) || String(a.name || '').localeCompare(String(b.name || '')));
    return key => active.filter(crew => crew.memberIds.some(id => personKey(id) === key))
      .map(crew => ({ id: crew.id, name: typeof crew.name === 'string' && crew.name.trim() ? crew.name.trim().slice(0, 80) : 'Crew', lead: personKey(crew.leadId) === key }));
  }

  return {
    // GET ?view=team: any signed-in staff member. Crews (dispatchResources) and approved headshots are read with it; when
    // either cannot be read the cards still show, without them, and coverage says which part is missing.
    async team(session) {
      if (!session?.user) throw fail('sign_in_required', 'Sign in to view the team directory.', 401);
      // The crew read starts with the roster read; the photos need the roster's usernames.
      const crewsRead = typeof store.crews === 'function' ? store.crews().catch(() => null) : Promise.resolve(null);
      const date = now(), today = denverToday(date), staff = await roster(), people = [...staff.people.values()], manages = managesStaff(session);
      const [crews, photos] = await Promise.all([crewsRead, typeof store.photoUrls === 'function' ? store.photoUrls(people.map(person => person.key)).catch(() => null) : null]);
      const accounts = new Map(staff.accounts.filter(account => record(account)).map(account => [personKey(account.username), account]));
      const context = { manages, crewsOf: crewMembership(crews), photos, accounts };
      const cards = people.map(person => teamCard(person, session, today, context)).sort((a, b) => a.displayName.localeCompare(b.displayName));
      // Uniform ordering (managers): how many of each size, and how many people have none saved.
      const shirtSizes = manages ? Object.fromEntries([...SHIRT_SIZES, 'unknown'].map(size => [size, cards.filter(card => (card.shirtSize || 'unknown') === size).length])) : null;
      return { ok: true, authority: 'employee_hub', timeZone: 'America/Denver', today, viewer: { user: session.user, manager: manages }, sizes: SHIRT_SIZES,
        people: cards, ...(shirtSizes ? { shirtSizes } : {}), coverage: { complete: true, crews: crews !== null, photos: photos !== null, asOf: date.toISOString() } };
    },

    async list(session, query = {}) {
      if (!session?.user) throw fail('sign_in_required', 'Sign in to view the staff directory.', 401);
      const date = now(), today = denverToday(date), staff = await roster(), people = [...staff.people.values()], byName = (a, b) => String(a.displayName).localeCompare(String(b.displayName));
      const selected = people.filter(person => managesStaff(session) || same(person.username, session.user)).filter(person => !query.username || same(person.username, query.username));
      if (query.username && !selected.length) throw managesStaff(session) || same(query.username, session.user) ? fail('not_found', 'That staff member is not in the active directory.', 404) : fail('forbidden', 'You can view only your own staff record.', 403);
      // The owner's whole directory also lists former staff, for their Gusto fields only.
      const former = !query.username && can(session, 'pay.manage', env) ? { formerStaff: [...formerStaff(staff).values()].sort(byName).map(formerView) } : {};
      return { ok: true, authority: 'employee_hub', timeZone: 'America/Denver', today,
        viewer: { user: session.user, capabilities: staffCapabilities(session, env) },
        catalog: { version: SKILL_CATALOG_VERSION, skills: SKILL_CATALOG, levels: SKILL_LEVELS, roles: STAFF_ROLES, days: WEEK_DAYS },
        people: selected.sort(byName).map(person => view(person, session, today)), ...former,
        coverage: { complete: true, asOf: date.toISOString() } };
    },

    async mutate(session, input) {
      if (!session?.user) throw fail('sign_in_required', 'Sign in to change the staff directory.', 401);
      const reason = validateInput(input), date = now(), nowIso = date.toISOString(), today = denverToday(date), actor = String(session.user);
      // expectedUser (optional): the account the change was made under. The session cookie is shared by every tab, so a
      // change kept in one tab is refused after another tab signs in as someone else; the client keeps it (401).
      if (input.expectedUser !== undefined && !same(input.expectedUser, session.user)) throw fail('account_changed', 'This change was made while signed in as another account. Sign in as that account to retry it, or discard it.', 401);
      if (!permitted(session, input.action, { username: input.username })) throw fail('forbidden', input.action === 'set_roles' || input.action === 'set_pay' ? 'Only the owner can change staff roles and pay.' : input.action === 'set_gusto_id' ? 'Only the owner can set Gusto employee IDs.' : 'Only a manager can change another staff member.', 403);
      if (store.readOnly()) throw fail('recovery_read_only', 'Employee setup is being verified. Existing records are preserved and cannot be changed yet.', 503);
      const requestId = input.requestId.toLowerCase(), fingerprint = await store.fingerprint(canonicalJson({ actor: personKey(actor), input }));
      const receipt = await store.readReceipt(requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request id was already used for a different change. Refresh and try again.', 409);
        const saved = await replay(session, receipt, requestId, today);
        if (saved) return saved;
        throw fail('changed_since_operation', 'This change was saved and the record has changed since. Refresh to see the latest.', 409);
      }
      const staff = await roster(), person = target(staff, input.action, personKey(input.username));
      if (!person) throw fail('not_found', input.action === 'set_gusto_id' ? 'That person has no staff profile or employee account.' : 'That staff member is not in the active directory.', 404);
      if (person.profileNeedsReview) throw fail('profile_ambiguous', 'This employee has a profile saved under an unrecognized id. Ask the owner to review it before changing the directory.', 409);
      if (input.expectedRevision !== person.revision) throw fail('revision_conflict', 'This staff record changed since you opened it. Refresh and review the latest before saving.', 409, { currentRevision: person.revision });
      const change = input.action === 'set_roles' ? staffRolesChange(person, input, session) : input.action === 'set_pay' ? payChange(person, input, actor, nowIso, today, firstRateFrom(person, today, env))
        : input.action === 'set_skills' ? skillsChange(person, input, actor, nowIso) : input.action === 'set_gusto_id' ? gustoIdChange(person, input, gustoHolders(staff))
        : input.action === 'set_personal' ? personalChange(person, input, managesStaff(session), today) : availabilityChange(person, input);
      if (!change) return { ok: true, authority: 'employee_hub', unchanged: true, person: view(person, session, today) };
      const { scope, before, after, auditView = { before, after }, ...fields } = change, current = person.record?.data || {};
      const profileId = person.record?.data.id || person.key;
      const data = { ...current, ...fields, id: profileId, username: current.username || person.username,
        history: appendHistory(current.history, { action: input.action, scope, actor, at: nowIso, requestId, reason, changes: { before, after } }),
        directoryRequestId: requestId, directoryUpdatedAt: nowIso, directoryUpdatedBy: actor, updatedAt: nowIso };
      let account = null;
      if (input.action === 'set_roles') {
        const saved = await store.readAccount(person.username);
        if (!saved?.account || saved.account.status !== 'approved' || !same(saved.account.username, person.username)) throw fail('revision_conflict', 'This employee account changed since you opened it. Refresh and review the latest before saving.', 409);
        // The account write is fenced on this read, so the roles checked above (from the roster read) must still be its
        // roles: a review or role change that landed in between (the owner making this person a manager, even at a rate
        // that leaves the profile unwritten) refuses the change instead of landing on the newer account. The manager
        // rule runs again on the saved roles as well.
        const savedRoles = accountRoles(saved.account).staffRoles;
        if (canonicalJson(savedRoles) !== canonicalJson(person.staffRoles)) throw fail('revision_conflict', 'This employee account changed since you opened it. Refresh and review the latest before saving.', 409);
        if (!isHubOwner(session) && (fields.staffRoles.includes('manager') || savedRoles.includes('manager'))) throw fail('owner_role_reserved', 'Only the owner can give or remove the manager role, or change a manager\'s roles.', 403);
        // A role change revokes existing Hub sessions (sessionVersion).
        account = { account: { ...saved.account, staffRoles: fields.staffRoles, sessionVersion: crypto.randomUUID(), rolesUpdatedAt: nowIso, rolesUpdatedBy: actor, updatedAt: nowIso }, version: saved.version };
      }
      // With EGC_STAFF_ROLE_ACCESS it can also add or remove business access (a stored manager), which a
      // minted Firebase session keeps until its refresh tokens are revoked. Intent first, as for an
      // account review (employee-accounts.js): a change that lands after this request stops is still revoked.
      // Flag off, stored roles never reach a claim firestore.rules reads (business_access, role), so a role
      // change records and calls nothing and answers exactly as before AUTH-ROLES.
      const firebaseAccess = Boolean(account) && staffRoleAccessEnabled(env);
      const firebase = firebaseAccess ? revocations() : null, users = [person.username];
      const intent = firebaseAccess ? await recordStaffFirebaseIntent(firebase, users, 'account_status', nowIso) : '';
      const revoke = async () => firebaseAccess ? { firebaseRevocation: await revokeStaffFirebaseSessions(firebase, users, 'account_status', firebaseRevocationTime(now()), intent) } : {};
      const receiptData = { kind: 'staff_directory_receipt_v1', action: input.action, actor: personKey(actor), target: person.key, fingerprint, createdAt: nowIso };
      // SEC-02: the audit entry joins the same commit; pay snapshots and Gusto ID changes are owner-only.
      const audit = auditWrite({ actor: { id: auditActor(actor), kind: 'human', role: session.role || null }, via: 'hub', action: `staff_directory.${input.action}`,
        entity: { collection: 'staff', id: auditEntity(person.key) }, before: auditView.before, after: auditView.after, requestId, reason: reason || null, visibility: ['pay', 'gusto'].includes(scope) ? 'owner' : 'business', now: nowIso });
      let saved;
      try {
        saved = await store.commit({ profile: { id: profileId, documentId: person.record?.documentId || '', revision: person.revision, data }, account, receipt: { id: requestId, data: receiptData }, audit, now: nowIso });
      } catch (error) {
        const known = ['staff_directory_revision_conflict', 'staff_directory_outcome_unknown'].includes(error?.code);
        // A lost response or a racing retry of this same request may already have applied it.
        const applied = known ? await store.readReceipt(requestId).then(found => found?.fingerprint === fingerprint ? replay(session, found, requestId, today) : null, () => null) : null;
        if (applied) return { ...applied, ...await revoke() };
        // A refused change needs no revocation; any other failure may have saved it.
        if (error?.code === 'staff_directory_revision_conflict') await settleStaffFirebaseIntent(firebase, users, intent, now().toISOString());
        else await revoke();
        throw error;
      }
      const updated = { ...person, profile: data, record: { documentId: person.record?.documentId || '', updateTime: saved.profileRevision, data }, revision: saved.profileRevision,
        ...(fields.staffRoles ? { staffRoles: fields.staffRoles, staffRolesSource: 'account' } : {}) };
      return { ok: true, authority: 'employee_hub', person: view(updated, session, today), ...(account ? { sessionsRevoked: true, ...await revoke() } : {}) };
    },
  };
}
