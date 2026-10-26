/* Billing review uses server-owned balances and recipients. It never opens checkout or sends messages. */
(() => {
'use strict';
const hub = window.EGCBusinessHub; if (!hub) return;
const esc = hub.esc, pending = new Map();
let preparation = null, preparationAccount = null, generation = 0;
function reset(){ preparation = null; preparationAccount = null; pending.clear(); generation++; }
hub.registerSessionResetHook?.(reset);
const cents = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
const exactCents = value => typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001 ? Math.round(value * 100) : null;
function reviewStillCurrent(data) {
  if (preparationAccount !== data.account.id || !data.billing || !(data.viewer.permissions.pay || data.viewer.permissions.link)) return false;
  return preparation.invoices.every(row => {
    const project = data.projects.find(project => project.jobId === row.jobId);
    const recipient = data.billing.routes.find(route => route.propertyId === row.propertyId)?.recipient;
    return project && !project.unavailable && !project.paymentNeedsReview && project.propertyId === row.propertyId &&
      !['cancelled','canceled','lost','superseded'].includes(project.status) && project.invoiceNumber === row.invoiceNumber &&
      exactCents(project.balance) === row.amountCents && exactCents(project.total) === row.totalCents && recipient &&
      ['memberId','version','name','email'].every(key => recipient[key] === preparation.recipient[key]);
  });
}
const options = (members, selected, all = false) => `<option value="">${all ? 'No account billing contact' : 'Use account billing contact'}</option>` + members.map(m => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)} (${esc(m.email)})</option>`).join('');
hub.registerRenderHook((content, data, tab) => {
  if (preparation && !reviewStillCurrent(data)) preparation = null;
  if (tab !== 'billing' || !data.billing) return;
  const box = document.createElement('section'); box.className = 'card';
  box.innerHTML = '<h2>Prepare invoice payment review</h2><p>Select invoices for one authorized billing contact. This saves a review only. It does not charge a card, send a message, or mark an invoice paid.</p>';
  if (data.viewer.permissions.pay || data.viewer.permissions.link) {
    const invoices = data.projects.filter(p => !p.unavailable && p.invoiceNumber && !p.paymentNeedsReview && p.balance > 0);
    box.insertAdjacentHTML('beforeend', invoices.map(p => `<label class="check"><input type="checkbox" data-billing-job="${esc(p.jobId)}"><span>${esc(p.invoiceNumber)} — ${esc(hub.propName(p.propertyId))}: ${esc(hub.money(p.balance))}</span></label>`).join('') || '<p>No outstanding invoices are available for review.</p>');
    if (invoices.length) box.insertAdjacentHTML('beforeend', '<button type="button" data-billing-prepare>Prepare review</button>');
    box.insertAdjacentHTML('beforeend', '<label>Resume a saved review<input data-billing-reference maxlength="32" autocomplete="off" spellcheck="false" placeholder="Review reference"></label><button type="button" data-billing-resume>Open review</button>');
  }
  if (preparation && (data.viewer.permissions.pay || data.viewer.permissions.link)) {
    const summary = document.createElement('div'); summary.setAttribute('role', 'status');
    summary.innerHTML = `<h3>Saved payment review</h3><p>Review reference: ${esc(preparation.id)}</p><p>${esc(preparation.recipient.name)} (${esc(preparation.recipient.email)}): ${esc(cents(preparation.totalCents))}</p><ul>${preparation.invoices.map(row => `<li>${esc(row.invoiceNumber)}: ${esc(cents(row.amountCents))}</li>`).join('')}</ul><p><a href="${esc(hub.exportUrl('billing_review') + '&review=' + encodeURIComponent(preparation.id))}" download="EGC-invoice-review.csv">Download reviewed invoices CSV</a></p><p>No payment has been collected. Continue to pay each invoice through its existing project, or cancel this review.</p><button type="button" data-billing-cancel="${esc(preparation.id)}">Cancel review</button>`;
    box.append(summary);
  }
  content.append(box);
  if (data.billing.canManage) {
    const contact = document.createElement('section'); contact.className = 'card';
    contact.innerHTML = `<h2>Authorized billing recipients</h2><p>Choose an active administrator or billing member. An email typed in account details alone does not authorize a recipient. Revoking a member or limiting their property access also stops their billing route.</p><label>Account billing contact<select data-billing-contact="">${options(data.billing.candidates.filter(m => !m.propertyIds), data.billing.accountContactMemberId, true)}</select></label>` + data.billing.routes.map(route => `<label>${esc(hub.propName(route.propertyId))}<select data-billing-contact="${esc(route.propertyId)}">${options(data.billing.candidates.filter(m => !m.propertyIds || m.propertyIds.includes(route.propertyId)), route.contactMemberId)}</select></label><p class="small">${route.recipient ? `Effective recipient: ${esc(route.recipient.name)} (${esc(route.recipient.email)})` : 'No authorized billing recipient configured.'}</p>`).join('') + '<button type="button" data-billing-save>Save billing recipients</button>';
    content.append(contact);
  }
});
async function operation(payload) {
  const key = JSON.stringify([hub.data()?.account?.id, payload]);
  if (!pending.has(key)) pending.set(key, hub.newId());
  const result = await hub.api({ ...payload, requestId: pending.get(key) });
  pending.delete(key); return result;
}
document.addEventListener('click', async event => {
  if (event.target.closest('button')?.id === 'logout') { reset(); return; }
  const button = event.target.closest('[data-billing-prepare],[data-billing-save],[data-billing-cancel],[data-billing-resume]');
  if (!button || button.disabled) return;
  const epoch = generation, accountId = hub.data()?.account?.id;
  let savedContacts = false;
  button.disabled = true;
  try {
    if (button.hasAttribute('data-billing-save')) {
      for (const select of button.closest('section').querySelectorAll('[data-billing-contact]')) {
        await operation({ action: 'set_billing_contact', propertyId: select.dataset.billingContact || null, memberId: select.value || null });
        if (generation !== epoch) return;
        savedContacts = true;
      }
      hub.toast('Authorized billing recipients saved.');
    } else if (button.hasAttribute('data-billing-resume')) {
      const requestId = button.closest('section').querySelector('[data-billing-reference]').value.trim();
      const result = await hub.api({ action: 'review_business_payment', requestId });
      if (generation !== epoch) return;
      preparation = result.preparation; preparationAccount = accountId;
    } else if (button.hasAttribute('data-billing-cancel')) {
      await hub.api({ action: 'cancel_business_payment', requestId: button.dataset.billingCancel });
      if (generation !== epoch) return;
      preparation = null; hub.toast('Payment review cancelled. No invoice or payment was changed.');
    } else {
      const jobIds = [...button.closest('section').querySelectorAll('[data-billing-job]:checked')].map(input => input.dataset.billingJob).sort();
      if (!jobIds.length) throw new Error('Select at least one invoice.');
      const result = await operation({ action: 'prepare_business_payment', jobIds });
      if (generation !== epoch) return;
      preparation = result.preparation; preparationAccount = accountId;
    }
    await hub.reload();
  } catch (error) {
    if (generation !== epoch) return;
    if (savedContacts) { await hub.reload(); hub.toast('Some billing recipients were saved. The account was refreshed; review the remaining choices. ' + error.message, true); }
    else hub.toast(error.message, true);
  }
  finally { button.disabled = false; }
});
})();
