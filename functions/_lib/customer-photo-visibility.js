import { fieldFailure, fieldPhotos, fieldRequestId, fieldStage, fieldText } from './field-execution.js';
import { localInstant } from './operations-portal-records.js';

// The single answer to "may the customer see this field photo?". Verified
// before/after photos on the portal session's own job appear once the job is
// complete (or earlier when a manager shares one). Every other category —
// damage, progress, walkthrough, anything new — stays hidden until a manager
// shares that one photo with an explicit confirmation. A manager hide always
// wins, and a malformed share record never counts as a share. The optional
// FIELD_CUSTOMER_PHOTOS_SINCE (a Denver date) limits the automatic rule to
// photos added from that day on, so enabling the flag need not expose older jobs.
export const CUSTOMER_PHOTO_STANDARD = Object.freeze(['before', 'after']);
const ORDER = ['before', 'progress', 'after', 'damage', 'walkthrough'];
const NAMES = { before: 'Before', after: 'After', progress: 'Progress', damage: 'Damage', walkthrough: 'Walkthrough' };
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const stamp = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.at === 'string' && INSTANT.test(value.at) && typeof value.actorId === 'string' && value.actorId ? value : null;
const category = photo => Object.hasOwn(NAMES, photo?.category) ? photo.category : 'other';

export const customerPhotosEnabled = (env = {}) => env?.FIELD_CUSTOMER_PHOTOS_ENABLED === 'true';
// autoFrom '' = no cutoff; an instant = Denver midnight of the configured day;
// null = the value is unreadable, so only explicit manager shares show.
export function customerPhotoPolicy(env = {}) {
  const since = String(env?.FIELD_CUSTOMER_PHOTOS_SINCE ?? '').trim();
  return { autoFrom: since ? localInstant(since, '00:00') : '' };
}
const automatic = (photo, { autoFrom = '' } = {}) => autoFrom === '' || typeof autoFrom === 'string' && INSTANT.test(photo.createdAt || '') && Date.parse(photo.createdAt) >= Date.parse(autoFrom);
export const customerPhotoSensitive = photo => !CUSTOMER_PHOTO_STANDARD.includes(photo?.category);

// Mirrors the completed/paid steps of the portal progress (customer-portal.js portalStatus).
export function customerPhotoJobComplete(job) {
  const stage = fieldStage(job);
  return ['completed', 'paid', 'review_requested', 'closed'].includes(stage) || stage === 'invoiced' && Boolean(job.completedAt || job.postJobChecklist?.completedAt);
}

// `photo` must come from fieldPhotos(job): unverified uploads never reach here.
export function customerPhotoState(job, photo, policy = {}) {
  if (photo.customerHidden) return { visible: false, state: 'hidden', reason: 'hidden' };
  const shared = stamp(photo.customerVisible), sensitive = customerPhotoSensitive(photo);
  if (shared && (!sensitive || shared.confirmed === true)) return { visible: true, state: 'shared', reason: 'shared' };
  if (sensitive) return { visible: false, state: 'default', reason: 'not_shared' };
  if (!automatic(photo, policy)) return { visible: false, state: 'default', reason: 'before_cutoff' };
  return customerPhotoJobComplete(job) ? { visible: true, state: 'default', reason: 'completed' } : { visible: false, state: 'default', reason: 'awaiting_completion' };
}

const sorted = photos => photos.map((photo, index) => ({ photo, index })).sort((a, b) => {
  const rank = item => { const position = ORDER.indexOf(category(item.photo)); return position < 0 ? ORDER.length : position; };
  return rank(a) - rank(b) || String(a.photo.createdAt || '').localeCompare(String(b.photo.createdAt || '')) || a.index - b.index;
}).map(item => item.photo);

export const customerVisiblePhotos = (job, policy = {}) => sorted(fieldPhotos(job).filter(photo => customerPhotoState(job, photo, policy).visible)).slice(0, 100);

// Portal DTO rows. photoId is the field upload's request UUID — never a Drive
// file id or URL — and captions stay internal because crews write them for staff.
// addedAt is when the server verified the upload, not when the camera took it
// (offline drafts can upload later), so the portal says "Added".
export function customerPhotoProjection(job, policy = {}) {
  return customerVisiblePhotos(job, policy).map(photo => ({ photoId: photo.id, category: category(photo), addedAt: INSTANT.test(photo.createdAt || '') ? photo.createdAt : '', label: `${NAMES[category(photo)] || 'Project'} photo` }));
}

export function customerPortalPhoto(job, photoId, policy = {}) {
  if (!fieldRequestId(photoId)) return null;
  return customerVisiblePhotos(job, policy).find(photo => photo.id === photoId) || null;
}

// Manager-only view of every verified photo's sharing state (no Drive ids).
export function photoSharingView(job, policy = {}) {
  const person = value => fieldText(value?.actorName || value?.actorId, 200);
  return {
    jobId: job.id, expectedRevision: job.__updateTime || '', jobComplete: customerPhotoJobComplete(job),
    photos: sorted(fieldPhotos(job)).map(photo => {
      const shared = stamp(photo.customerVisible), hidden = photo.customerHidden && typeof photo.customerHidden === 'object' ? photo.customerHidden : null;
      return { photoId: photo.id, category: category(photo), sensitive: customerPhotoSensitive(photo), ...customerPhotoState(job, photo, policy), sharedAt: shared?.at || '', sharedBy: person(shared), hiddenAt: typeof hidden?.at === 'string' ? hidden.at : '', hiddenBy: person(hidden) };
    }),
  };
}

// Pure mutation: one photo per request. Returns the job patch and the
// management-only fieldEvents receipt written in the same commit.
export function photoSharingCommand(job, actor, input, now = new Date().toISOString()) {
  if (!fieldRequestId(input.photoId) || typeof input.customerVisible !== 'boolean' || input.confirm !== undefined && typeof input.confirm !== 'boolean') throw fieldFailure('Choose a saved photo and whether the customer may see it.');
  const photo = fieldPhotos(job).find(item => item.id === input.photoId);
  if (!photo) throw fieldFailure('This photo is not part of the current job record.', 404, 'FIELD_PHOTO_NOT_FOUND');
  const sensitive = customerPhotoSensitive(photo), name = NAMES[category(photo)] || 'Project';
  if (input.customerVisible && sensitive && input.confirm !== true) throw fieldFailure(`${name} photos stay hidden from customers unless a manager confirms sharing this one photo.`, 409, 'FIELD_PHOTO_SHARE_CONFIRMATION_REQUIRED');
  const actorId = actor.user, actorName = actor.displayName || actor.user, record = { at: now, actorId, actorName, requestId: input.requestId };
  const state = job.fieldExecution || {};
  const photos = (Array.isArray(state.photos) ? state.photos : []).map(item => {
    if (item?.id !== photo.id || item.verified !== true) return item;
    const { customerVisible, customerHidden, ...rest } = item;
    return input.customerVisible ? { ...rest, customerVisible: { ...record, ...(sensitive ? { confirmed: true } : {}) } } : { ...rest, customerHidden: record };
  });
  const event = { id: input.requestId, action: 'photo_visibility', actorId, actorName, createdAt: now, state: 'applied', visibility: 'management', photoId: photo.id, customerVisible: input.customerVisible, summary: `${name} photo ${input.customerVisible ? 'shared with' : 'hidden from'} the customer`, body: '' };
  return { patch: { fieldExecution: { ...state, photos }, updatedAt: now }, event };
}
