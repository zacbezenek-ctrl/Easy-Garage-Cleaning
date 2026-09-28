/* Business hub member invitations by email, sent only through the approved-send core (policy b2b_invite, owner-approved
   wording). The staff click that issues the invitation is the human approval. The raw invite link exists only in the
   request that created it: it reaches the send as an in-memory link provider and is never stored. */
import { createApprovedSendService, messagingFlags } from './approved-send.js';
import { createGhlMessenger } from './ghl-messenger.js';
import { messagingStorage } from './message-send-store.js';
import { safeName } from './business-hub-core.js';

export const INVITE_KIND = 'b2b_invite';
export const inviteDeliveryEnabled = (env = {}) => env.BUSINESS_HUB_INVITE_DELIVERY === 'true';
export const memberRecipientId = (accountId, memberId, generation) => `${accountId}_${memberId}_${generation}`;
const RECIPIENT = /^([a-f0-9]{32})_([a-f0-9]{32})_([1-9][0-9]{0,8})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CODE = /^messaging_[a-z_]+$/;
// Anything the ledger holds for a brand-new generation is treated as possibly delivered: never sent again.
const STATUS = { submitted: 'submitted', failed: 'failed', attempts_exhausted: 'failed', uncertain: 'uncertain', sending: 'uncertain', already_sent: 'uncertain',
  dry_run: 'dry_run', suppressed: 'suppressed', needs_contact: 'needs_contact', contact_mismatch: 'contact_mismatch', not_configured: 'not_configured', unavailable: 'unavailable' };

// A saved member name reaches the greeting and the HighLevel contact only when it is a plain name. Anything else (for
// example a web address saved before names were validated) resolves as no name, so the approved-send core refuses the
// {{firstName}} greeting before any provider call and nothing is emailed.
const plainName = name => safeName(String(name || '').trim()) ? String(name).trim() : '';
// readAccount resolver: the recipient is one member invitation generation, re-read from the saved business account on
// every call. Only a member still invited at that generation with an email claim in flight resolves, so a revoke,
// resend or sign-in reset during the send stops it before the provider call. The address is the saved member email.
export function businessMemberRecipient(read) {
  return async (target, id) => {
    const match = RECIPIENT.exec(typeof id === 'string' ? id : '');
    if (!match) return null;
    const account = await read('business_accounts', match[1]);
    const member = account?.status === 'active' ? (account.members || []).find(m => m.id === match[2]) : null;
    if (!member || member.status !== 'invited' || member.version !== Number(match[3]) || member.invite?.channel !== 'email' || member.invite.status !== 'sending') return null;
    return { id, name: plainName(member.name), email: String(member.email || ''), phone: '', highlevelContactId: '', ownerStaff: String(account.ownerStaff || '') };
  };
}

// 'account_staff' for b2b_invite: only sales staff pass the pre-read gate, and then send only for the business accounts they own.
export const salesStaff = actor => actor?.role === 'sales' && typeof actor.user === 'string' && Boolean(actor.user);
export const ownsBusinessAccount = async (actor, record) => salesStaff(actor) && record?.ownerStaff === actor.user;

function outcome(result) {
  const raw = String(result?.status || ''), status = STATUS[raw] || 'uncertain';
  return { status, reason: String(result?.reason || (status !== raw ? raw || 'unknown' : '')).slice(0, 80),
    messageId: status === 'submitted' ? String(result.messageId || '').slice(0, 180) : '', masked: String(result?.recipient?.masked || '') };
}

// deliver() never throws: every approved-send error is raised before the provider call, so it means nothing was sent.
export function createInviteDelivery({ env = {}, store = null, messenger = null } = {}) {
  async function deliver({ actor, accountId, memberId, generation, link, requestId = '', read, now }) {
    const clock = () => new Date(now()), linked = new Set();
    // The link provider notes each purpose it served, so wording that never asks for {{inviteLink}} is caught at preview.
    const service = createApprovedSendService({
      store: store || messagingStorage(env), messenger: messenger || createGhlMessenger({ env, clock }), clock, env, secret: env.HUB_SESSION_SECRET || '',
      readAccount: businessMemberRecipient(read), staffGate: salesStaff, accountAccess: ownsBusinessAccount, links: { inviteLink: async ({ purpose } = {}) => { linked.add(purpose); return link; } },
    });
    const person = { user: String(actor?.user || ''), role: String(actor?.role || ''), businessAccess: actor?.businessAccess === true, displayName: String(actor?.displayName || actor?.user || ''), kind: 'human', source: 'hub' };
    const input = { kind: INVITE_KIND, accountId: memberRecipientId(accountId, memberId, generation) };
    const ledgerRequest = String(requestId).replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/, '$1-$2-$3-$4-$5');
    try {
      if (!messagingFlags(env).enabled) return { status: 'not_sent', reason: 'messaging_disabled', messageId: '', masked: '' };
      const preview = await service.preview(person, input);
      if (preview.status !== 'ready') return outcome(preview);
      // Approved wording without the link would email no way in while the hub withholds the link from staff: send nothing.
      if (!linked.has('preview')) return { status: 'not_sent', reason: 'template_missing_invite_link', messageId: '', masked: String(preview.recipient?.masked || '') };
      return outcome(await service.send(person, { ...input, confirmToken: preview.confirmToken, ...(UUID.test(ledgerRequest) ? { requestId: ledgerRequest } : {}) }));
    } catch (error) {
      return { status: 'not_sent', reason: CODE.test(error?.code || '') ? error.code : 'messaging_unavailable', messageId: '', masked: '' };
    }
  }
  return { enabled: inviteDeliveryEnabled(env), deliver };
}
