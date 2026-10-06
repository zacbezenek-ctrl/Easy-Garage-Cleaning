// Who may do what in canvassing. Identity is the existing Hub session; canvassing adds its own
// profile per rep (knock_reps) that an admin must approve before the rep can do anything.
// Admins are the Hub's business users (owner and managers); leads and knockers are set per rep.
import { hasBusinessAccess } from './hub-session.js';
import { knockFailure, write } from './knock-store.js';
import { mergeSettings, ROLES } from '../../crew/knock-settings.js';

const SAFE_KEY = /^[a-z0-9._-]{1,64}$/;

function hexKey(text) {
  return [...new TextEncoder().encode(text)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 120);
}

// The canvassing record id for a Hub username (lowercase; unusual characters hex-encoded).
export function repKeyFor(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return '';
  return SAFE_KEY.test(key) ? key : `u_${hexKey(key)}`;
}

export const isAdmin = session => Boolean(session?.user) && hasBusinessAccess(session);

export async function loadSettings(store) {
  const doc = await store.get('knock_settings', 'current');
  return mergeSettings(doc?.settings || {});
}

const publicRep = rep => rep && ({
  repKey: rep.repKey || rep.id, username: rep.username || '', displayName: rep.displayName || rep.username || rep.id,
  role: rep.role || 'knocker', status: rep.status || 'pending', permitListed: rep.permitListed === true,
  premiumCleared: rep.premiumCleared === true, leadKey: rep.leadKey || '', trainingMinutes: Number(rep.trainingMinutes || 0),
  approvedAt: rep.approvedAt || null, deactivatedAt: rep.deactivatedAt || null, createdAt: rep.createdAt || null,
});

export { publicRep };

/* The signed-in user's canvassing profile, created as "pending" on first visit. Business users
   start active as admins (they still need the City permit flag before starting a shift). */
export async function ensureRep(store, session, nowIso) {
  if (!session?.user) throw knockFailure('Sign in to use canvassing.', 401, 'knock_sign_in_required');
  const repKey = repKeyFor(session.user);
  let rep = await store.get('knock_reps', repKey);
  if (!rep) {
    const admin = isAdmin(session);
    const created = {
      repKey, username: String(session.user).trim(), displayName: String(session.displayName || session.user).slice(0, 80),
      role: admin ? 'admin' : 'knocker', status: admin ? 'active' : 'pending', permitListed: false, premiumCleared: admin,
      leadKey: '', trainingMinutes: 0, createdAt: nowIso, updatedAt: nowIso,
      approvedAt: admin ? nowIso : null, approvedBy: admin ? 'hub-business-access' : null, deactivatedAt: null,
    };
    try {
      await store.commit([write.create('knock_reps', repKey, created)]);
      rep = { ...created, id: repKey };
    } catch (error) {
      if (error.code !== 'knock_exists') throw error;
      rep = await store.get('knock_reps', repKey);
    }
  }
  const profile = publicRep(rep);
  // A business user is always an admin in canvassing; nobody else can be.
  profile.role = isAdmin(session) ? 'admin' : (profile.role === 'admin' ? 'knocker' : profile.role);
  return profile;
}

export function requireActive(rep) {
  if (rep?.status === 'active') return rep;
  if (rep?.status === 'inactive') throw knockFailure('Your canvassing access is turned off. Talk to Zac.', 403, 'knock_rep_inactive');
  throw knockFailure('Your canvassing account is waiting for approval.', 403, 'knock_rep_pending');
}

export function requireAdmin(session) {
  if (!session?.user) throw knockFailure('Sign in to use canvassing.', 401, 'knock_sign_in_required');
  if (!isAdmin(session)) throw knockFailure('Only an admin can do that.', 403, 'knock_admin_required');
  return session;
}

// Whether a rep may start a shift (active and on the City permit list).
export function shiftEligibility(rep) {
  if (rep?.status !== 'active') return { ok: false, reason: rep?.status === 'inactive' ? 'Your canvassing access is turned off.' : 'Your account is waiting for approval.' };
  if (!rep.permitListed) return { ok: false, reason: 'You are not on the City permit list yet. Ask Zac to add you.' };
  return { ok: true, reason: '' };
}

/* Admin edits to a rep. patch keys: status ('active'|'inactive'|'pending'), role ('knocker'|'lead'),
   permitListed, premiumCleared, leadKey, displayName. Returns the stored patch. */
export function repPatch(current, changes, adminSession, nowIso) {
  const patch = {};
  if ('status' in changes) {
    if (!['active', 'inactive', 'pending'].includes(changes.status)) throw knockFailure('Unknown status.', 400, 'knock_invalid_status');
    patch.status = changes.status;
    if (changes.status === 'active') { patch.approvedAt = current.approvedAt || nowIso; patch.approvedBy = current.approvedBy || adminSession.user; patch.deactivatedAt = null; }
    if (changes.status === 'inactive') patch.deactivatedAt = nowIso;
  }
  if ('role' in changes) {
    if (!ROLES.includes(changes.role) || changes.role === 'admin') throw knockFailure('Choose knocker or lead. Admins are the Hub\'s business users.', 400, 'knock_invalid_role');
    patch.role = changes.role;
  }
  for (const flag of ['permitListed', 'premiumCleared']) {
    if (flag in changes) {
      if (typeof changes[flag] !== 'boolean') throw knockFailure(`${flag} must be yes or no.`, 400, 'knock_invalid_flag');
      patch[flag] = changes[flag];
    }
  }
  if ('leadKey' in changes) {
    const leadKey = String(changes.leadKey || '');
    if (leadKey && !SAFE_KEY.test(leadKey) && !/^u_[0-9a-f]+$/.test(leadKey)) throw knockFailure('Unknown lead.', 400, 'knock_invalid_lead');
    if (leadKey && leadKey === (current.repKey || current.id)) throw knockFailure('A rep cannot be their own lead.', 400, 'knock_invalid_lead');
    patch.leadKey = leadKey;
  }
  if ('displayName' in changes) {
    const name = String(changes.displayName || '').trim().slice(0, 80);
    if (!name) throw knockFailure('Name is required.', 400, 'knock_invalid_name');
    patch.displayName = name;
  }
  if (!Object.keys(patch).length) throw knockFailure('Nothing to change.', 400, 'knock_nothing_to_change');
  patch.updatedAt = nowIso;
  return patch;
}
