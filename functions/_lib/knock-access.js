// Who may do what in canvassing. Identity is the existing Hub session; canvassing adds its own
// profile per rep (knock_reps) that an admin must approve before the rep can do anything.
// Admins are the Hub's business users (owner and managers); leads and knockers are set per rep.
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { knockFailure, write } from './knock-store.js';
import { mergeSettings, ROLES, validateSettings } from '../../crew/knock-settings.js';
import { SETTER_CONTRACT, validCollectionPolicy, validCommissionScope, validSetterTerms } from '../../crew/knock-money.js';

const SAFE_KEY = /^[a-z0-9._-]{1,64}$/;
// Every stored commission field an approval binds to.
export const COMMISSION_FIELDS = Object.freeze(['rate', 'acceleratorEnabled', 'acceleratorThreshold', 'acceleratorRate', 'leadOverrideEnabled', 'leadOverrideRate']);

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
// Compensation approval is the owner's alone; managers keep every other admin action.
export const isOwner = session => isAdmin(session) && isHubOwner(session) && session.role === 'owner';

export const sameSettings = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a).sort();
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameSettings(a[key], b[key]));
};

export async function loadSettings(store) {
  const doc = await store.get('knock_settings', 'current');
  const settings = mergeSettings(doc?.settings || {});
  // Known collection timing and cadence do not verify basis, attribution or the payroll anchor.
  // Only the owner's compensation.approve action (knock-admin.js) writes this approval, with
  // the evidence for the complete contract and garage-only scope, bound to its settings.
  const fields = COMMISSION_FIELDS;
  const approval = doc?.compensationApproval;
  settings.commission.verified = Boolean(doc?.updatedBy && Number.isFinite(Date.parse(doc?.updatedAt)) &&
    fields.every(key => Object.hasOwn(doc?.settings?.commission || {}, key)) && !validateSettings(doc.settings).length &&
    approval?.contract === 'knock-collected-v3' && settings.commission.rate === 0.25 && validCommissionScope(approval.scope) && validCollectionPolicy(approval.collectionPolicy) &&
    approval.payrollAnchorConfirmed === true && doc.settings.payroll?.period === 'biweekly' && Object.hasOwn(doc.settings.payroll, 'anchorDate') &&
    approval.reference && approval.reviewedBy && Number.isFinite(Date.parse(approval.reviewedAt)) &&
    sameSettings(approval.commission, doc.settings.commission) && sameSettings(approval.payroll, doc.settings.payroll));
  settings.commission.approvedAt = settings.commission.verified ? approval.reviewedAt : null;
  settings.commission.scope = settings.commission.verified ? structuredClone(approval.scope) : null;
  settings.commission.collectionPolicy = settings.commission.verified ? structuredClone(approval.collectionPolicy) : null;
  settings.commission.knownPolicy = { earnedOn: 'customer_collection', payoutCadence: 'biweekly' };
  settings.commission.policyGaps = [
    ...(!validCollectionPolicy(approval?.collectionPolicy) ? ['calculation_base_and_attribution'] : []),
    ...(!settings.commission.verified ? ['payroll_cycle_anchor'] : []),
    'partial_collections', 'refund_clawbacks',
  ];
  settings.payroll.anchorVerified = settings.commission.verified;
  settings.payroll.period = 'biweekly';
  // Direct-estimator economics are not a D2D benchmark. Keep measured results,
  // but show no targets or go/fix/stop verdict without a separate D2D approval.
  const planApproval = doc?.planApproval;
  settings.plan.verified = Boolean(planApproval?.channel === 'door_to_door' && planApproval.reference && planApproval.reviewedBy &&
    Number.isFinite(Date.parse(planApproval.reviewedAt)) && sameSettings(planApproval.plan, doc?.settings?.plan) && sameSettings(planApproval.gate, doc?.settings?.gate));
  // Only once the owner approved the setter terms (setterTermsState), so a rep's rule text says they pay; absent before.
  const setter = setterTermsState(doc, settings);
  if (setter.verified) settings.commission.setter = { verified: true, approvedAt: setter.approvedAt };
  return settings;
}

/* The owner's approval of the appointment-setter and estimator terms (crew/knock-money.js SETTER_TERMS, D6b), written
   only by knock-admin.js approveSetterTerms beside compensationApproval. Its shares are paid every two weeks with the
   door-to-door commission, so it verifies only while that approval (and its pay cycle) does. Kept out of loadSettings,
   whose settings go to every rep: callers that pay or show these shares read it with loadSetterTerms. */
export function setterTermsState(doc, settings) {
  const approval = doc?.setterApproval;
  const verified = Boolean(settings?.commission?.verified === true && approval && approval.contract === SETTER_CONTRACT && validSetterTerms(approval.terms) &&
    typeof approval.reference === 'string' && approval.reference.trim() && typeof approval.reviewedBy === 'string' && approval.reviewedBy && Number.isFinite(Date.parse(approval.reviewedAt)));
  return { verified, approvedAt: verified ? approval.reviewedAt : null, reference: verified ? approval.reference : null };
}

export async function loadSetterTerms(store, settings) {
  return setterTermsState(await store.get('knock_settings', 'current'), settings);
}

const publicRep = rep => rep && ({
  repKey: rep.repKey || rep.id, username: rep.username || '', displayName: rep.displayName || rep.username || rep.id,
  role: rep.role || 'knocker', status: rep.status || 'pending', permitListed: rep.permitListed === true,
  premiumCleared: rep.premiumCleared === true, walkthroughSelf: rep.walkthroughSelf === true, leadKey: rep.leadKey || '', trainingMinutes: Number(rep.trainingMinutes || 0),
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

export function requireOwner(session) {
  requireAdmin(session);
  if (!isOwner(session)) throw knockFailure('Only the owner can approve commission terms.', 403, 'knock_owner_required');
  return session;
}

// Whether a rep may start a shift (active and on the City permit list).
export function shiftEligibility(rep) {
  if (rep?.status !== 'active') return { ok: false, reason: rep?.status === 'inactive' ? 'Your canvassing access is turned off.' : 'Your account is waiting for approval.' };
  if (!rep.permitListed) return { ok: false, reason: 'You are not on the City permit list yet. Ask Zac to add you.' };
  return { ok: true, reason: '' };
}

/* Admin edits to a rep. patch keys: status ('active'|'inactive'|'pending'), role ('knocker'|'lead'),
   permitListed, premiumCleared, walkthroughSelf, leadKey, displayName. Returns the stored patch.
   REP-WALKTHROUGH: walkthroughSelf (Knock Admin > Walkthroughs) lets the rep run their own walkthrough at the door
   (knock-self-walkthrough.js); each change records who made it and when (walkthroughSelfBy, walkthroughSelfAt). */
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
  for (const flag of ['permitListed', 'premiumCleared', 'walkthroughSelf']) {
    if (flag in changes) {
      if (typeof changes[flag] !== 'boolean') throw knockFailure(`${flag} must be yes or no.`, 400, 'knock_invalid_flag');
      patch[flag] = changes[flag];
    }
  }
  if ('walkthroughSelf' in patch) Object.assign(patch, { walkthroughSelfBy: adminSession.user, walkthroughSelfAt: nowIso });
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
