import { dispatchRoster, dispatchStorage } from './dispatch-storage.js';
import { firestoreFetch } from './firebase-service-account.js';
import { assignmentKey, jobCrewNames } from './job-assignment.js';
import { can } from './staff-roles.js';
import { auditWrite } from './hub-audit.js';
import { PURPOSES, purposeSign, purposeVerify } from './purpose-keys.js';
import { decodeFieldPhoto, verifyFieldPhotoMetadata } from './field-execution-photos.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { denverToday, validDate } from './dispatch-time.js';

/**
 * P4-07 crew public profiles. crew_public_profiles/{username} is the ONE
 * customer-facing identity record for a crew member, kept outside the
 * encrypted employee vault and deliberately minimal:
 *   {username, firstName, active, photo, pendingPhoto, pendingUpload, createdAt, updatedAt, updatedBy}
 * photo is the manager-approved headshot {fileId, requestId, mime, bytes, sha256, uploadedAt, uploadedBy,
 * approvedAt, approvedBy}; pendingPhoto the latest upload awaiting approval; pendingUpload the Drive claim
 * written before any bytes are sent. Customers only ever see {firstName, photo link, lead} for an active
 * profile on their own job; the Drive file id never leaves the server. Receipts live in
 * crew_profile_operations/{requestId} and every change writes a hub_audit entry in the same commit.
 */
export const CREW_PROFILES = 'crew_public_profiles';
export const CREW_PROFILE_OPERATIONS = 'crew_profile_operations';
// Signed customer photo links expire one to two hours after the portal read; the hour bucket keeps the
// URL stable across the portal's 20 s refreshes so the browser does not reload the image each time.
export const CREW_PHOTO_LINK_SECONDS = 2 * 60 * 60;
const LINK_BUCKET = 60 * 60, REF_LENGTH = 22, MAX_CREW = 8, MAX_PROFILES = 2000;
// "On the way" is a same-day note: a departure older than this (or on another day) is stale.
const ON_THE_WAY_MS = 12 * 60 * 60 * 1000, CLOCK_SKEW_MS = 5 * 60 * 1000;
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
// One given name, no spaces: customers never see a surname unless it is typed into this one word.
const FIRST_NAME = /^\p{L}[\p{L}\p{M}'’.-]{0,29}$/u;
const COMMON = ['action', 'requestId', 'username', 'expectedRevision'];
const ACTIONS = { upload_photo: ['dataUrl'], approve_photo: ['photoRequestId'], reject_photo: ['photoRequestId'], remove_photo: [], set_profile: ['firstName', 'active'] };
const MANAGER_ACTIONS = new Set(['approve_photo', 'reject_photo', 'set_profile']);

export const crewPublicProfilesEnabled = env => env?.CREW_PUBLIC_PROFILES_ENABLED === 'true';
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'crew_profile_' + code, status, ...(details ? { details } : {}) });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));

/** The profile document id for a username (lowercase, trimmed), or '' when it cannot be one. */
export function crewProfileKey(value) {
  const key = assignmentKey(typeof value === 'string' ? value : '');
  return USERNAME.test(key) ? key : '';
}
// Headshots reuse the field photo Drive client under a reserved owner id. fieldId() refuses the _egc_ prefix,
// so no job can ever claim (or be served) a headshot, and no headshot link can reach a job's field photo.
export const crewPhotoOwner = key => `_egc_crew_profile_${key}`;
export const cleanFirstName = value => { const name = text(value, 40); return FIRST_NAME.test(name) ? name : ''; };
const photoRecord = value => plain(value) && DRIVE_ID.test(String(value.fileId || '')) && UUID.test(String(value.requestId || '')) ? value : null;
/** The approved headshot; an unapproved or malformed record is never treated as one. */
export function approvedCrewPhoto(profile) {
  const photo = photoRecord(profile?.photo);
  return photo && INSTANT.test(String(photo.approvedAt || '')) && typeof photo.approvedBy === 'string' && photo.approvedBy ? photo : null;
}
export const pendingCrewPhoto = profile => photoRecord(profile?.pendingPhoto);

/** The customer-safe allowlist: an active profile with a valid first name, plus its approved photo. */
export function publicCrewProfile(profile) {
  if (!plain(profile) || profile.active !== true) return null;
  const firstName = cleanFirstName(profile.firstName);
  return firstName ? { firstName, photo: approvedCrewPhoto(profile) } : null;
}

export const crewProfileManager = (session, env = {}) => can(session, 'dispatch.write', env);
export const staffCrewPhotoUrl = (key, photo, state = 'approved') => `/api/crew-public-profile?photo=${encodeURIComponent(key)}${state === 'pending' ? '&state=pending' : ''}&v=${photo.requestId.toLowerCase()}`;

/**
 * Staff view of one profile. Never a Drive id; the pending photo only for its owner or a manager. onRoster is
 * true/false only where the roster was read (the manager overview) and null elsewhere.
 */
export function crewProfileView(profile, key, { manager = false, self = false, displayName = '', onRoster = null } = {}) {
  const photo = approvedCrewPhoto(profile), waiting = pendingCrewPhoto(profile), person = value => text(value, 80);
  return {
    username: key, displayName: text(displayName, 120), firstName: cleanFirstName(profile?.firstName), active: profile?.active === true, onRoster: typeof onRoster === 'boolean' ? onRoster : null,
    customerVisible: Boolean(publicCrewProfile(profile)),
    photo: photo ? { requestId: photo.requestId.toLowerCase(), uploadedAt: text(photo.uploadedAt, 40), uploadedBy: person(photo.uploadedBy), approvedAt: photo.approvedAt, approvedBy: person(photo.approvedBy), url: staffCrewPhotoUrl(key, photo) } : null,
    pendingPhoto: waiting && (manager || self) ? { requestId: waiting.requestId.toLowerCase(), uploadedAt: text(waiting.uploadedAt, 40), uploadedBy: person(waiting.uploadedBy), url: staffCrewPhotoUrl(key, waiting, 'pending') } : null,
    uploadInProgress: plain(profile?.pendingUpload), revision: profile?.revision || '', updatedAt: text(profile?.updatedAt, 40), updatedBy: person(profile?.updatedBy),
  };
}

/** crew_public_profiles over the shared revisioned Firestore store, with this module's error codes. */
export function crewProfileStorage(env, fetcher = firestoreFetch) {
  const store = dispatchStorage(env, fetcher);
  const translate = problem => {
    if (problem?.code?.startsWith('crew_profile_')) return problem;
    if (problem?.code === 'dispatch_revision_conflict') return fail('revision_conflict', 'This crew profile changed. Refresh and review it before trying again.', 409);
    if (problem?.code === 'dispatch_outcome_unknown') return fail('outcome_unknown', 'The save could not be verified. Retry the same change to safely check whether it saved.', 503);
    if (problem?.code?.startsWith('EMPLOYEE_ACCOUNT') || ['HUB_AUTH_CONFIGURATION', 'dispatch_roster_ambiguous'].includes(problem?.code)) return fail('roster_unavailable', 'The employee roster could not be verified. Retry shortly.', 503);
    return fail('storage_unavailable', 'Crew profiles could not be loaded. Retry shortly.', 503);
  };
  const guard = action => async (...args) => { try { return await action(...args); } catch (problem) { throw translate(problem); } };
  const incomplete = () => fail('storage_unavailable', 'Crew profiles could not be loaded completely. Retry shortly.', 503);
  // Every stored profile (a small, server-only collection), so a manager still sees people who left the roster.
  async function list() {
    const rows = [], ids = new Set(), tokens = new Set();
    let token = '';
    do {
      const url = new URL(`https://firestore.googleapis.com/v1/${ROOT}/${CREW_PROFILES}`);
      url.searchParams.set('pageSize', '300');
      if (token) url.searchParams.set('pageToken', token);
      const response = await fetcher(env, url.toString(), { signal: AbortSignal.timeout(20000) });
      const page = response.ok ? await response.json().catch(() => null) : null;
      if (!plain(page) || page.documents !== undefined && !Array.isArray(page.documents) || page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string') throw incomplete();
      for (const document of page.documents || []) {
        const name = typeof document?.name === 'string' ? document.name : '', prefix = `/documents/${CREW_PROFILES}/`, id = name.includes(prefix) ? name.slice(name.indexOf(prefix) + prefix.length) : '';
        if (!id || id.includes('/') || ids.has(id) || typeof document.updateTime !== 'string' || !document.updateTime || rows.length >= MAX_PROFILES) throw incomplete();
        if (document.fields !== undefined && !plain(document.fields)) throw incomplete();
        ids.add(id); rows.push({ ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime });
      }
      token = page.nextPageToken || '';
      if (token && tokens.has(token)) throw incomplete();
      tokens.add(token);
    } while (token);
    return rows;
  }
  return {
    read: guard((collection, id) => store.read(collection, id)),
    readMany: guard(ids => ids.length ? store.readMany(CREW_PROFILES, ids) : []),
    list: guard(list),
    commit: guard(writes => store.commit(writes)),
    roster: guard(() => dispatchRoster(env)),
  };
}

/** The saved profiles for these usernames as a Map (missing ones are absent). */
export async function readCrewPublicProfiles(env, keys, { storage = crewProfileStorage } = {}) {
  const ids = [...new Set(keys.map(crewProfileKey).filter(Boolean))];
  return new Map((await storage(env).readMany(ids)).map(row => [row.id, row]));
}

const crewKeys = job => [...new Set(jobCrewNames(job).map(crewProfileKey).filter(Boolean))];
const leadKey = job => crewProfileKey(typeof job?.crewLead === 'string' ? job.crewLead : job?.crewLead?.username || job?.crewLead?.user || job?.crewLead?.id || '');
const linkMessage = (jobId, ref, photo, exp) => `link|${jobId}|${ref}|${photo.requestId.toLowerCase()}|${exp}`;
/** An opaque per-job reference for a crew member: the username itself never reaches the customer. */
export async function crewPhotoRef(env, jobId, key) {
  return (await purposeSign(env, PURPOSES.crewPhotoLink, `ref|${jobId}|${key}`)).slice(0, REF_LENGTH);
}
export const crewPhotoLinkExpiry = now => (Math.floor(Math.floor(new Date(now).getTime() / 1000) / LINK_BUCKET) + 2) * LINK_BUCKET;

/** A signed, expiring customer link for an approved photo on this job, bound to that exact photo. */
export async function crewPhotoLink(env, jobId, key, photo, now) {
  const ref = await crewPhotoRef(env, jobId, key), exp = crewPhotoLinkExpiry(now);
  const sig = await purposeSign(env, PURPOSES.crewPhotoLink, linkMessage(jobId, ref, photo, exp));
  return `/api/customer-crew-photo?u=${ref}&exp=${exp}&sig=${sig}`;
}

/**
 * The en-route note for the portal read at `now`: only while the crew has marked the job en route
 * (fieldExecution.activity 'dispatched' on a dispatched job), on the job's Denver service date, and within
 * 12 hours of the departure. Without a readable departure time the service date must be today.
 */
function onTheWayNote(job, leader, now) {
  const execution = job?.fieldExecution || {}, stage = String(job?.pipelineStatus || job?.status || '').toLowerCase(), read = new Date(now ?? NaN), at = read.getTime();
  if (execution.activity !== 'dispatched' || stage !== 'dispatched' || !Number.isFinite(at)) return null;
  const day = validDate(job?.date) ? job.date : '', left = INSTANT.test(String(execution.activityAt || '')) && Number.isFinite(Date.parse(execution.activityAt)) ? execution.activityAt : '', ms = Date.parse(left);
  if (day && day !== denverToday(read)) return null;
  if (left ? at - ms > ON_THE_WAY_MS || ms - at > CLOCK_SKEW_MS || day && denverToday(new Date(ms)) !== day : !day) return null;
  return { at: left, leadFirstName: leader?.firstName || '' };
}

/**
 * The portal DTO additions for a read at `now`. crew lists only active profiles of crew assigned to this job
 * (the lead first): {firstName, photoUrl, lead}. onTheWay is {at, leadFirstName} while the crew is en route
 * today (see onTheWayNote), else null.
 */
export function customerCrewProjection(job, profiles, links = new Map(), now) {
  const lead = leadKey(job);
  const crew = crewKeys(job).map(key => ({ key, profile: publicCrewProfile(profiles.get(key)) })).filter(item => item.profile)
    .sort((a, b) => Number(b.key === lead) - Number(a.key === lead)).slice(0, MAX_CREW)
    .map(({ key, profile }) => ({ firstName: profile.firstName, photoUrl: profile.photo ? links.get(key) || '' : '', lead: Boolean(lead) && key === lead }));
  return { crew, onTheWay: onTheWayNote(job, lead ? publicCrewProfile(profiles.get(lead)) : null, now) };
}

/** Reads the job's crew profiles and signs photo links. Photos drop out (names stay) if links cannot be signed. */
export async function customerCrew(env, job, { profiles = readCrewPublicProfiles, now = new Date() } = {}) {
  const keys = crewKeys(job), saved = keys.length ? await profiles(env, keys) : new Map(), links = new Map();
  for (const key of keys) {
    const visible = publicCrewProfile(saved.get(key));
    if (!visible?.photo) continue;
    try { links.set(key, await crewPhotoLink(env, job.id, key, visible.photo, now)); } catch { /* No purpose key: first names only. */ }
  }
  return customerCrewProjection(job, saved, links, now);
}

/**
 * Resolves a customer link against the session's own job: {status:'ok', key, photo} or a refusal
 * ('invalid' for an expired, malformed or tampered link: 403; 'missing' for crew no longer on the job,
 * hidden profiles and unapproved photos: 404). The signature binds the job, the crew member and the
 * approved photo, so a replaced or withdrawn photo's old links stop working at once.
 */
export async function resolveCustomerCrewPhoto(env, job, { u, exp, sig }, { read, now }) {
  const seconds = Number(exp), at = Math.floor(new Date(now).getTime() / 1000);
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(u)) || !/^\d{10}$/.test(String(exp)) || !/^[A-Za-z0-9_-]{43}$/.test(String(sig))) return { status: 'invalid' };
  if (!(seconds > at) || seconds > at + CREW_PHOTO_LINK_SECONDS + LINK_BUCKET) return { status: 'invalid' };
  let key = '';
  for (const candidate of crewKeys(job)) if (await crewPhotoRef(env, job.id, candidate) === u) { key = candidate; break; }
  if (!key) return { status: 'missing' };
  const visible = publicCrewProfile(await read(CREW_PROFILES, key));
  if (!visible?.photo) return { status: 'missing' };
  if (!await purposeVerify(env, PURPOSES.crewPhotoLink, linkMessage(job.id, u, visible.photo, seconds), sig)) return { status: 'invalid' };
  return { status: 'ok', key, photo: visible.photo };
}

/** True only when the Drive file is still this profile's own verified headshot upload. */
export const crewPhotoMetadataMatches = (metadata, key, photo) => Boolean(metadata && metadata.trashed !== true && metadata.appProperties?.egcJobId === crewPhotoOwner(key) && metadata.appProperties?.egcFieldRequestId === photo.requestId.toLowerCase());

/**
 * Staff photo links for the dispatch roster (approved photos only). The returned store starts the profile
 * batchGet as soon as dispatch has read its roster, so it runs alongside the job scans instead of after them;
 * attach(roster) then adds the links. Any read failure leaves the roster as it was.
 */
export function crewRosterPhotoStore(store) {
  if (typeof store?.readMany !== 'function' || typeof store.roster !== 'function') return { store, attach: async roster => roster };
  let rows = null;
  const load = async roster => {
    const ids = Array.isArray(roster) ? [...new Set(roster.map(person => crewProfileKey(person?.id)).filter(Boolean))] : [];
    return new Map((ids.length ? await store.readMany(CREW_PROFILES, ids) : []).map(row => [row.id, row]));
  };
  return {
    store: { ...store, roster: async (...args) => { const roster = await store.roster(...args); rows ||= load(roster).catch(() => null); return roster; } },
    async attach(roster) {
      const saved = rows && await rows;
      if (!saved || !Array.isArray(roster)) return roster;
      return roster.map(person => { const key = crewProfileKey(person?.id), photo = approvedCrewPhoto(saved.get(key)); return photo ? { ...person, photoUrl: staffCrewPhotoUrl(key, photo) } : person; });
    },
  };
}

export function requireCrewProfileStaff(session) {
  if (!session?.user || !crewProfileKey(session.user)) throw fail('sign_in_required', 'Sign in to the Employee Hub to manage crew photos.', 401);
  return crewProfileKey(session.user);
}

/**
 * The signed-in employee's own profile; for a manager every roster profile plus every stored profile of someone
 * no longer on the roster (onRoster:false), so a departed employee's photo can still be removed and hidden.
 */
export async function crewProfileOverview(store, session, env = {}) {
  const me = requireCrewProfileStaff(session), manager = crewProfileManager(session, env), own = session.displayName || session.user;
  const view = (rows, keys, names, roster) => ({
    ok: true, authority: 'employee_hub', viewer: { username: me, manager }, customerProfilesEnabled: crewPublicProfilesEnabled(env),
    profiles: keys.map(key => crewProfileView(rows.get(key), key, { manager, self: key === me, displayName: names.has(key) ? names.get(key) || key : '', onRoster: roster ? roster.has(key) : null })),
  });
  if (!manager) return view(new Map((await store.readMany([me])).map(row => [row.id, row])), [me], new Map([[me, own]]), null);
  const [people, saved] = await Promise.all([store.roster(), store.list()]);
  const names = new Map();
  for (const person of people) { const key = crewProfileKey(person?.id); if (key && !names.has(key)) names.set(key, person.name); }
  const roster = new Set(names.keys()), rows = new Map(saved.filter(row => crewProfileKey(row.id) === row.id).map(row => [row.id, row]));
  if (!names.has(me)) names.set(me, own);
  const departed = [...rows.keys()].filter(key => !roster.has(key) && key !== me).sort();
  return view(rows, [...new Set([...(roster.has(me) ? [] : [me]), ...roster, ...departed])], names, roster);
}

/** One profile the viewer may see: their own, or any for a manager. */
export async function crewProfileDetail(store, session, username, env = {}) {
  const me = requireCrewProfileStaff(session), manager = crewProfileManager(session, env), key = crewProfileKey(username);
  if (!key) throw fail('username_invalid', 'Choose a valid employee.');
  if (key !== me && !manager) throw fail('forbidden', 'You can only open your own crew profile.', 403);
  return { ok: true, authority: 'employee_hub', viewer: { username: me, manager }, profile: crewProfileView(await store.read(CREW_PROFILES, key), key, { manager, self: key === me, displayName: key === me ? session.displayName || '' : '' }) };
}

function parseInput(input) {
  if (!plain(input) || typeof input.action !== 'string' || !Object.hasOwn(ACTIONS, input.action)) throw fail('action_invalid', 'Choose a supported crew profile change.');
  if (Object.keys(input).some(key => ![...COMMON, ...ACTIONS[input.action]].includes(key))) throw fail('request_invalid', 'This crew profile change has unexpected fields. Refresh and try again.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'A unique request ID is required. Refresh and retry.');
  const username = crewProfileKey(input.username);
  if (!username) throw fail('username_invalid', 'Choose a valid employee.');
  if (typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 80) throw fail('request_invalid', 'Refresh the crew profile before changing it.');
  const request = { action: input.action, requestId: input.requestId.toLowerCase(), username, expectedRevision: input.expectedRevision };
  if (['approve_photo', 'reject_photo'].includes(input.action)) {
    if (typeof input.photoRequestId !== 'string' || !UUID.test(input.photoRequestId)) throw fail('request_invalid', 'Choose the pending photo you reviewed.');
    request.photoRequestId = input.photoRequestId.toLowerCase();
  }
  if (input.action === 'set_profile') {
    const firstName = typeof input.firstName === 'string' ? input.firstName.trim() : null;
    if (firstName === null || firstName && !cleanFirstName(firstName) || typeof input.active !== 'boolean') throw fail('first_name_invalid', 'Enter one first name (letters, apostrophes, periods or hyphens; no spaces, up to 30 characters) and whether customers may see this profile.');
    if (input.active && !firstName) throw fail('first_name_required', 'Add a first name before showing this profile to customers.');
    Object.assign(request, { firstName, active: input.active });
  }
  if (input.action === 'upload_photo') {
    try { request.picture = decodeFieldPhoto(input.dataUrl); }
    catch (problem) { throw fail('photo_invalid', problem?.code ? problem.message : 'Choose a JPG, PNG or WebP photo.', 400); }
  }
  return request;
}

const summary = profile => ({ firstName: cleanFirstName(profile?.firstName), active: profile?.active === true, photo: approvedCrewPhoto(profile) ? 'approved' : 'none', pendingPhoto: Boolean(pendingCrewPhoto(profile)), uploadInProgress: plain(profile?.pendingUpload) });
const conflict = (message, current) => fail('revision_conflict', message, 409, { currentRevision: current?.revision || '' });

async function commitOrRecover(store, writes, recover) {
  try { await store.commit(writes); }
  catch (problem) {
    if (!['crew_profile_revision_conflict', 'crew_profile_outcome_unknown'].includes(problem?.code)) throw problem;
    const recovered = await recover().catch(() => null);
    if (recovered) return recovered;
    throw problem;
  }
  return null;
}

// Drive failures keep their actionable message under this module's code; nothing else leaks.
async function drive(action) {
  try { return await action(); }
  catch (problem) { throw fail('photo_storage_unavailable', problem?.code ? problem.message : 'Photo storage is unavailable. Retry the same upload shortly.', 503); }
}

/**
 * Applies one crew profile change. Employees upload or remove their own headshot; managers (dispatch.write)
 * do that for anyone and alone approve or reject a pending photo and set the first name and customer
 * visibility; approving a photo or showing a profile needs the person on the current roster. The same requestId
 * replays; a different body under it is a 409. Every commit carries the profile (compare-and-set on its
 * revision) and an audit entry, and the final one also the receipt.
 */
export async function mutateCrewProfile({ store, photos }, session, input, env = {}, now = new Date().toISOString()) {
  const actor = requireCrewProfileStaff(session), manager = crewProfileManager(session, env), request = parseInput(input), key = request.username;
  if ((MANAGER_ACTIONS.has(request.action) || key !== actor) && !manager) throw fail('forbidden', MANAGER_ACTIONS.has(request.action) ? 'Only an owner or manager can approve crew photos or change what customers see.' : 'You can only change your own crew photo.', 403);
  const { picture, expectedRevision, ...body } = request;
  if (picture) body.photo = { mime: picture.mime, bytes: picture.bytes.length, sha256: await sha256(picture.bytes) };
  const print = await sha256(new TextEncoder().encode(canonical({ actor, input: body })));
  const view = async replayed => ({ ok: true, authority: 'employee_hub', action: request.action, requestId: request.requestId, replayed, profile: crewProfileView(await store.read(CREW_PROFILES, key), key, { manager, self: key === actor }) });
  const receipt = async () => {
    const saved = await store.read(CREW_PROFILE_OPERATIONS, request.requestId);
    if (!saved) return null;
    if (saved.fingerprint !== print || saved.actorId !== actor || saved.action !== request.action) throw fail('idempotency_conflict', 'This request ID was already used for a different crew profile change. Refresh and make the change again.', 409);
    return saved;
  };
  const replay = async () => await receipt() ? view(true) : null;
  const replayed = await replay();
  if (replayed) return replayed;
  // Only people on the current roster can be shown to customers; someone who left can still be hidden and have their photo removed.
  if ((request.action === 'approve_photo' || request.action === 'set_profile' && request.active) && !(await store.roster()).some(person => crewProfileKey(person?.id) === key)) throw fail('not_on_roster', 'This person is no longer on the employee roster. Remove their photo or hide them from customers instead.', 409);
  let profile = await store.read(CREW_PROFILES, key);
  const created = profile ? {} : { username: key, firstName: key === actor ? cleanFirstName(String(session.displayName || '').split(/\s+/)[0]) : '', active: false, photo: null, pendingPhoto: null, pendingUpload: null, createdAt: now };
  const stamp = { updatedAt: now, updatedBy: actor };
  const audit = (action, before, after) => auditWrite({ actor: { id: actor, kind: 'human', role: session.role }, via: 'hub', action, entity: { collection: CREW_PROFILES, id: key }, before, after, requestId: request.requestId, now });
  const writes = (current, patch) => [
    { collection: CREW_PROFILES, id: key, ...(current ? { revision: current.revision } : {}), patch: { ...(current ? {} : created), ...patch, ...stamp } },
    { collection: CREW_PROFILE_OPERATIONS, id: request.requestId, patch: { action: request.action, fingerprint: print, actorId: actor, username: key, requestId: request.requestId, at: now } },
    audit(`crew_profile.${request.action}`, current ? summary(current) : null, summary({ ...(current || created), ...patch })),
  ];
  const recover = async () => await receipt() ? view(false) : null;

  if (request.action === 'upload_photo') {
    let claim = plain(profile?.pendingUpload) && profile.pendingUpload.requestId === request.requestId ? profile.pendingUpload : null;
    if (claim && claim.fingerprint !== print) throw fail('idempotency_conflict', 'This upload ID was already used for a different photo. Start a new upload.', 409);
    if (!claim && (profile?.revision || '') !== expectedRevision) throw conflict('This crew profile changed. Refresh before uploading a new photo.', profile);
    const client = await drive(() => photos(env));
    if (!claim) {
      claim = { requestId: request.requestId, fingerprint: print, fileId: await drive(() => client.allocate()), actorId: actor, startedAt: now };
      // The Drive claim is audited too: it can be the commit that first creates the profile.
      await store.commit([
        { collection: CREW_PROFILES, id: key, ...(profile ? { revision: profile.revision } : {}), patch: { ...(profile ? {} : created), pendingUpload: claim, ...stamp } },
        audit('crew_profile.upload_started', profile ? summary(profile) : null, summary({ ...(profile || created), pendingUpload: claim })),
      ]);
      profile = await store.read(CREW_PROFILES, key);
      if (profile?.pendingUpload?.requestId !== request.requestId) throw conflict('Another photo upload started for this profile. Refresh before trying again.', profile);
    }
    const owner = crewPhotoOwner(key), check = { jobId: owner, requestId: request.requestId, picture };
    const verified = metadata => { try { verifyFieldPhotoMetadata(metadata, check); return true; } catch { return false; } };
    if (!verified(await drive(() => client.metadata(claim.fileId)))) {
      await drive(() => client.upload(claim.fileId, owner, request.requestId, picture, 'headshot'));
      if (!verified(await drive(() => client.metadata(claim.fileId)))) throw fail('photo_unverified', 'Photo storage has not confirmed the complete photo. Retry the same upload.', 503);
    }
    const photo = { fileId: claim.fileId, requestId: request.requestId, mime: picture.mime, bytes: picture.bytes.length, sha256: body.photo.sha256, uploadedAt: now, uploadedBy: actor };
    // Re-read after the slow upload: a manager edit in between is kept, a removal or newer upload wins.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) { const done = await replay(); if (done) return done; profile = await store.read(CREW_PROFILES, key); }
      if (profile?.pendingUpload?.requestId !== request.requestId) throw conflict('This photo upload was replaced or removed while it was sending. Refresh before trying again.', profile);
      try { const recovered = await commitOrRecover(store, writes(profile, { pendingPhoto: photo, pendingUpload: null }), recover); return recovered || await view(false); }
      catch (problem) { if (problem?.code !== 'crew_profile_revision_conflict' || attempt === 2) throw problem; }
    }
  }

  if ((profile?.revision || '') !== expectedRevision) throw conflict('This crew profile changed. Refresh and review it before trying again.', profile);
  let patch;
  if (request.action === 'set_profile') patch = { firstName: request.firstName, active: request.active };
  else if (!profile) throw fail('not_found', 'This employee has no crew photo yet.', 404);
  else if (request.action === 'remove_photo') {
    if (!approvedCrewPhoto(profile) && !pendingCrewPhoto(profile) && !plain(profile.pendingUpload)) throw fail('nothing_to_remove', 'There is no photo to remove.', 409);
    patch = { photo: null, pendingPhoto: null, pendingUpload: null };
  } else {
    const waiting = pendingCrewPhoto(profile);
    if (!waiting || waiting.requestId.toLowerCase() !== request.photoRequestId) throw fail('photo_changed', 'This photo was replaced or already reviewed. Refresh to review the current photo.', 409);
    patch = request.action === 'approve_photo' ? { photo: { ...waiting, approvedAt: now, approvedBy: actor }, pendingPhoto: null } : { pendingPhoto: null };
  }
  return await commitOrRecover(store, writes(profile, patch), recover) || view(false);
}
