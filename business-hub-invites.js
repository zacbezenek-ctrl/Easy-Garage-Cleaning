/* Team invitations: an Invitation column with Resend and Reset sign-in. The server decides whether EGC emails the link
   (staff only, while invitation email is on); this file never builds, keeps or logs an invitation link. */
(() => {
'use strict';
const hub = window.EGCBusinessHub; if (!hub) return;
const STATES = {pending:'Invitation pending', expired:'Invitation expired', active:'Signed in', sign_in_ended:'Sign-in ended', revoked:'Access revoked'};
const DELIVERY = {manual:'Private link', submitted:'Emailed', sending:'Email not confirmed', uncertain:'Email not confirmed', failed:'Email rejected', suppressed:'Email turned off by contact', needs_contact:'Email not sent', contact_mismatch:'Email not sent', not_configured:'Email not set up', unavailable:'Email not sent', dry_run:'Email test mode', not_sent:'Email not sent'};
const RESEND = new Set(['pending', 'expired', 'sign_in_ended']);
// A retry after a lost response reuses its requestId so the server reports the first outcome instead of issuing again.
const pending = new Map();
const when = value => value ? new Date(value).toLocaleString('en-US', {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) : '';
const button = (action, m, deliver, label) => `<button type="button" data-ext-invite="${action}" data-member="${hub.esc(m.id)}" data-deliver="${deliver}">${hub.esc(label)}</button>`;
function actions(m, data) {
 if (m.self || !m.id) return '';
 const email = data.viewer.permissions.staff && data.inviteDelivery?.email;
 if (RESEND.has(m.inviteStatus)) return (email ? button('resend_invite', m, 'email', 'Email new link') : '') + button('resend_invite', m, 'manual', 'New link');
 if (m.inviteStatus === 'active') return (email ? button('reset_sign_in', m, 'email', 'Reset & email') : '') + button('reset_sign_in', m, 'manual', 'Reset sign-in');
 return '';
}
function cell(m, data) {
 if (!data?.viewer?.permissions?.team || !m.inviteStatus) return '';
 const detail = [m.inviteStatus === 'revoked' ? '' : DELIVERY[m.deliveryStatus] || '', m.lastSentAt ? 'Issued ' + when(m.lastSentAt) : '', m.inviteStatus === 'pending' && m.expiresAt ? 'Expires ' + when(m.expiresAt) : ''].filter(Boolean).join(' · ');
 const buttons = actions(m, data);
 return `${hub.pill(STATES[m.inviteStatus] || m.inviteStatus)}${detail ? `<small>${hub.esc(detail)}</small>` : ''}${buttons ? `<div class="request-actions">${buttons}</div>` : ''}`;
}
function question(action, m, deliver) {
 if (action === 'reset_sign_in') return `End ${m.name}'s current sign-in and issue a new invitation${deliver === 'email' ? ' emailed to ' + m.email : ''}? Their current sign-in and earlier links stop working.`;
 // Staff see whose name the email will greet as well as the address, since a client administrator chose both.
 return deliver === 'email' ? `Email a new invitation to ${m.name} at ${m.email}? Their earlier link stops working.` : `Create a new private link for ${m.name}? Their earlier link stops working.`;
}
// Only people who manage the team see the column; everyone else gets no empty Invitation header.
hub.registerMemberColumns(cell, 'Invitation', data => data?.viewer?.permissions?.team === true);
document.addEventListener('click', async event => {
 const target = event.target.closest('button[data-ext-invite]'); if (!target) return;
 const data = hub.data(), m = data?.members?.find(item => item.id === target.dataset.member), action = target.dataset.extInvite;
 if (!m || !['resend_invite', 'reset_sign_in'].includes(action)) return;
 const deliver = target.dataset.deliver === 'email' ? 'email' : 'manual', key = `${action}:${m.id}:${deliver}`;
 if (!confirm(question(action, m, deliver))) return;
 if (!pending.has(key)) pending.set(key, hub.newId());
 const payload = {action, memberId: m.id, deliver, requestId: pending.get(key), ...(action === 'reset_sign_in' ? {confirm: true} : {})};
 target.disabled = true;
 try {
  const result = await hub.api(payload); pending.delete(key); await hub.reload();
  if (result.duplicate) hub.toast('This request was already completed. The team list shows its current status.');
  else hub.showInvite({...result, email: result.email || m.email});
 } catch (error) {
  // Keep the request for an unknown outcome (network, 5xx, 401, 403, 408, 429) so a retry cannot issue a second link.
  if (error.status && error.status < 500 && ![401, 403, 408, 429].includes(error.status)) pending.delete(key);
  hub.toast(error.message, true);
 } finally { target.disabled = false; }
});
})();
