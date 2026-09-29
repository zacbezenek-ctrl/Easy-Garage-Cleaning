import { addDays, denverToday, validDate } from './dispatch-time.js';
import { STAFF_ROLES, can, defaultStaffRoles, primaryStaffRole, sanitizeStaffRoles, staffCapabilities } from './staff-roles.js';
import { SKILL_CATALOG, SKILL_CATALOG_VERSION, SKILL_LEVELS, storedSkills, validateSkills } from './staff-skills.js';
import { auditWrite } from './hub-audit.js';
import { payOwnerOnly } from './pay-visibility.js';

// Staff directory: roles, skills, effective-dated pay and weekly availability are
// additive fields on the existing encrypted 'profiles' payload (no new vault family,
// so older readers keep working). Employee-account roles are authoritative on the
// encrypted account (sessions read them there) and mirrored onto the profile.
// hourlyRate stays on the profile, mirrored to the current effective rate.
export const WEEK_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const LEGACY_EFFECTIVE_FROM = '2000-01-01';
const PAY_TYPES = ['hourly', 'salary'];
const HISTORY_LIMIT = 200, PAY_RATE_LIMIT = 60, VIEW_HISTORY = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const COMMON = ['action', 'requestId', 'username', 'expectedRevision', 'expectedUser', 'reason'];
const ACTIONS = { set_roles: ['staffRoles'], set_skills: ['skills'], set_pay: ['effectiveFrom', 'hourlyRate', 'payType', 'overtimeMultiplier'], set_availability: ['weeklyAvailability'] };

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

function staffRolesChange(person, input) {
  if (person.source !== 'employee_account') throw fail('configured_account', 'Configured Hub users keep the roles and pay set in the Hub user configuration.', 409);
  const roles = input.staffRoles;
  if (!Array.isArray(roles) || !roles.length || roles.length > STAFF_ROLES.length || roles.some(role => typeof role !== 'string' || !STAFF_ROLES.includes(role)) || new Set(roles).size !== roles.length) throw fail('invalid_roles', 'Choose one or more staff roles: manager, crew_lead, crew, sales or phone.');
  if (roles.includes('owner')) throw fail('owner_role_reserved', 'The owner role belongs only to the configured owner account.', 403);
  const next = STAFF_ROLES.filter(role => roles.includes(role));
  return canonicalJson(next) === canonicalJson(person.staffRoles) ? null : { scope: 'roles', staffRoles: next, before: { staffRoles: person.staffRoles }, after: { staffRoles: next } };
}

// employee-hub.js falls back to the account's rate when the profile has none.
const payProfile = person => {
  const profile = person.profile || {};
  return legacyRate(profile) === null && legacyRate({ hourlyRate: person.accountHourlyRate }) !== null ? { ...profile, hourlyRate: person.accountHourlyRate } : profile;
};

function payChange(person, input, actor, nowIso, today) {
  if (person.source !== 'employee_account') throw fail('configured_account', 'Configured Hub users keep the roles and pay set in the Hub user configuration.', 409);
  if (!validDate(input.effectiveFrom) || input.effectiveFrom < today || input.effectiveFrom > addDays(today, 366)) throw fail('invalid_pay', 'Choose an effective date from today through one year ahead (Denver time). Earlier timecards keep the rate saved at clock-in.');
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
export const DIRECTORY_PROFILE_FIELDS = Object.freeze(['staffRoles', 'skills', 'skillCatalogVersion', 'payRates', 'payRateMirror', 'weeklyAvailability', 'history', 'migrations', 'directoryRequestId', 'directoryUpdatedAt', 'directoryUpdatedBy']);
const LEGACY_HIDDEN = new Set(['history', 'payRates', 'payRateMirror']), LEGACY_PAY_FIELDS = ['hourlyRate', 'payType'];
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

function payView(person, today) {
  const profile = payProfile(person);
  const current = effectivePayRate(profile, today), rates = storedPayRates(profile?.payRates) || [];
  // Configured Hub users' pay lives in the Hub configuration, which set_pay cannot change.
  return { current, upcoming: rates.filter(entry => entry.effectiveFrom > today), schedule: rates, needsReview: person.source !== 'configured' && (current.source === 'pay_rates_need_review' || current.drift) };
}

export function createStaffDirectoryService({ store, env = {}, now = () => new Date() }) {
  const managesStaff = session => can(session, 'time.approve', env) || can(session, 'dispatch.write', env);

  async function directory() {
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
      const stored = sanitizeStaffRoles(account.staffRoles, { user: account.username, businessAccess: false });
      add({ key: personKey(account.username), username: String(account.username), displayName: account.displayName || account.username, source: 'employee_account', accountStatus: account.status, accountHourlyRate: account.hourlyRate,
        staffRoles: stored || defaultStaffRoles({ role: account.role }), staffRolesSource: stored ? 'account' : 'default' });
    }
    for (const person of people.values()) {
      const candidates = records.filter(row => record(row.data) && same(row.data.username, person.username));
      const target = [person.key, ...legacyPersonKeys(person.username)].map(id => candidates.find(row => row.data.id === id)).find(Boolean);
      const chosen = target || candidates.at(-1);
      Object.assign(person, { record: target || null, profile: chosen ? chosen.data : null, revision: target ? target.updateTime : '', profileNeedsReview: !target && candidates.length > 0 });
    }
    return people;
  }

  function view(person, session, today) {
    const self = same(person.username, session.user), pay = self || can(session, 'pay.manage', env), profile = person.profile || {};
    const history = (Array.isArray(profile.history) ? profile.history : []).filter(entry => record(entry) && (pay || entry.scope !== 'pay')).slice(-VIEW_HISTORY);
    return {
      username: person.username, displayName: person.displayName, source: person.source, ...(person.accountStatus ? { accountStatus: person.accountStatus } : {}),
      staffRoles: person.staffRoles, staffRolesSource: person.staffRolesSource, primaryRole: primaryStaffRole(person.staffRoles),
      skills: storedSkills(profile.skills), weeklyAvailability: storedWeeklyAvailability(profile.weeklyAvailability),
      weeklyAvailabilityNeedsReview: profile.weeklyAvailability !== undefined && profile.weeklyAvailability !== null && !storedWeeklyAvailability(profile.weeklyAvailability),
      ...(pay ? { pay: payView(person, today) } : {}),
      history, revision: person.revision, profileNeedsReview: person.profileNeedsReview,
    };
  }

  function permitted(session, action, person) {
    if (action === 'set_roles') return can(session, 'accounts.approve', env);
    if (action === 'set_pay') return can(session, 'pay.manage', env);
    if (action === 'set_skills') return managesStaff(session);
    return managesStaff(session) || same(person?.username ?? '', session.user);
  }

  // The saved outcome is returned only while the record still carries this request.
  async function replay(session, receipt, requestId, today) {
    const person = (await directory()).get(receipt.target);
    return person?.record?.data.directoryRequestId === requestId ? { ok: true, authority: 'employee_hub', replayed: true, person: view(person, session, today) } : null;
  }

  return {
    async list(session, query = {}) {
      if (!session?.user) throw fail('sign_in_required', 'Sign in to view the staff directory.', 401);
      const date = now(), today = denverToday(date), people = [...(await directory()).values()];
      const selected = people.filter(person => managesStaff(session) || same(person.username, session.user)).filter(person => !query.username || same(person.username, query.username));
      if (query.username && !selected.length) throw managesStaff(session) || same(query.username, session.user) ? fail('not_found', 'That staff member is not in the active directory.', 404) : fail('forbidden', 'You can view only your own staff record.', 403);
      return { ok: true, authority: 'employee_hub', timeZone: 'America/Denver', today,
        viewer: { user: session.user, capabilities: staffCapabilities(session, env) },
        catalog: { version: SKILL_CATALOG_VERSION, skills: SKILL_CATALOG, levels: SKILL_LEVELS, roles: STAFF_ROLES, days: WEEK_DAYS },
        people: selected.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName))).map(person => view(person, session, today)),
        coverage: { complete: true, asOf: date.toISOString() } };
    },

    async mutate(session, input) {
      if (!session?.user) throw fail('sign_in_required', 'Sign in to change the staff directory.', 401);
      const reason = validateInput(input), date = now(), nowIso = date.toISOString(), today = denverToday(date), actor = String(session.user);
      // expectedUser (optional): the account the change was made under. The session cookie is shared by every tab, so a
      // change kept in one tab is refused after another tab signs in as someone else; the client keeps it (401).
      if (input.expectedUser !== undefined && !same(input.expectedUser, session.user)) throw fail('account_changed', 'This change was made while signed in as another account. Sign in as that account to retry it, or discard it.', 401);
      if (!permitted(session, input.action, { username: input.username })) throw fail('forbidden', input.action === 'set_roles' || input.action === 'set_pay' ? 'Only the owner can change staff roles and pay.' : 'Only a manager can change another staff member.', 403);
      if (store.readOnly()) throw fail('recovery_read_only', 'Employee setup is being verified. Existing records are preserved and cannot be changed yet.', 503);
      const requestId = input.requestId.toLowerCase(), fingerprint = await store.fingerprint(canonicalJson({ actor: personKey(actor), input }));
      const receipt = await store.readReceipt(requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request id was already used for a different change. Refresh and try again.', 409);
        const saved = await replay(session, receipt, requestId, today);
        if (saved) return saved;
        throw fail('changed_since_operation', 'This change was saved and the record has changed since. Refresh to see the latest.', 409);
      }
      const person = (await directory()).get(personKey(input.username));
      if (!person) throw fail('not_found', 'That staff member is not in the active directory.', 404);
      if (person.profileNeedsReview) throw fail('profile_ambiguous', 'This employee has a profile saved under an unrecognized id. Ask the owner to review it before changing the directory.', 409);
      if (input.expectedRevision !== person.revision) throw fail('revision_conflict', 'This staff record changed since you opened it. Refresh and review the latest before saving.', 409, { currentRevision: person.revision });
      const change = input.action === 'set_roles' ? staffRolesChange(person, input) : input.action === 'set_pay' ? payChange(person, input, actor, nowIso, today)
        : input.action === 'set_skills' ? skillsChange(person, input, actor, nowIso) : availabilityChange(person, input);
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
        // A role change revokes existing Hub sessions (sessionVersion); Firebase claims refresh at the next sign-in.
        account = { account: { ...saved.account, staffRoles: fields.staffRoles, sessionVersion: crypto.randomUUID(), rolesUpdatedAt: nowIso, rolesUpdatedBy: actor, updatedAt: nowIso }, version: saved.version };
      }
      const receiptData = { kind: 'staff_directory_receipt_v1', action: input.action, actor: personKey(actor), target: person.key, fingerprint, createdAt: nowIso };
      // SEC-02: the audit entry joins the same commit; pay snapshots are owner-only.
      const audit = auditWrite({ actor: { id: auditActor(actor), kind: 'human', role: session.role || null }, via: 'hub', action: `staff_directory.${input.action}`,
        entity: { collection: 'staff', id: auditEntity(person.key) }, before: auditView.before, after: auditView.after, requestId, reason: reason || null, visibility: scope === 'pay' ? 'owner' : 'business', now: nowIso });
      let saved;
      try {
        saved = await store.commit({ profile: { id: profileId, documentId: person.record?.documentId || '', revision: person.revision, data }, account, receipt: { id: requestId, data: receiptData }, audit, now: nowIso });
      } catch (error) {
        if (!['staff_directory_revision_conflict', 'staff_directory_outcome_unknown'].includes(error?.code)) throw error;
        // A lost response or a racing retry of this same request may already have applied it.
        const applied = await store.readReceipt(requestId).then(found => found?.fingerprint === fingerprint ? replay(session, found, requestId, today) : null, () => null);
        if (applied) return applied;
        throw error;
      }
      const updated = { ...person, profile: data, record: { documentId: person.record?.documentId || '', updateTime: saved.profileRevision, data }, revision: saved.profileRevision,
        ...(fields.staffRoles ? { staffRoles: fields.staffRoles, staffRolesSource: 'account' } : {}) };
      return { ok: true, authority: 'employee_hub', person: view(updated, session, today), ...(account ? { sessionsRevoked: true } : {}) };
    },
  };
}
