/* Request conversations and explicit conversion preview. No automatic sends or bookings. */
(() => {
'use strict';
const hub = window.EGCBusinessHub; if (!hub) return;
const pending = new Map(); let dialog = null, generation = 0, account = null, searchController = null;
const esc = hub.esc;
function reset() { generation++; searchController?.abort(); pending.clear(); dialog?.close(); dialog?.remove(); dialog = null; }
hub.registerSessionResetHook?.(reset);
hub.registerRenderHook((_, data) => { if (account && account !== data.account.id) reset(); account = data.account.id; });
hub.registerRequestActions((request, data) => {
  const p = data.viewer.permissions;
  return `${p.link && !request.jobId && ['submitted','reviewing','awaiting_customer'].includes(request.status) ? `<button type="button" data-business-convert="${esc(request.id)}">Review job conversion</button>` : ''}${(p.staff || p.request || p.pay) ? `<button type="button" data-business-reply="${esc(request.id)}">Request conversation</button>` : ''}`;
});
function open(title) {
  searchController?.abort();
  if (dialog) { dialog.close(); dialog.remove(); }
  dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<button type="button" data-close-request>Close</button><h2>${esc(title)}</h2><div data-request-body></div><p data-request-error role="alert"></p>`;
  dialog.querySelector('[data-close-request]').addEventListener('click', () => dialog.close());
  document.body.append(dialog); dialog.showModal(); return dialog.querySelector('[data-request-body]');
}
function operation(payload) {
  const key = JSON.stringify([hub.data().account.id, payload]);
  if (!pending.has(key)) pending.set(key, hub.newId());
  return { ...payload, requestId: pending.get(key) };
}
function error(message) { if (dialog) dialog.querySelector('[data-request-error]').textContent = message; }
function conversion(request) {
  const data = hub.data(), epoch = generation, body = open('Review service request');
  body.innerHTML = `<p>Find the existing customer. The preview will show the saved customer and property before you confirm.</p><form method="dialog"><label>Customer name, phone or email<input name="customerQuery" maxlength="200" autocomplete="off"></label><button type="button" data-customer-search>Search customers</button><label>Customer<select name="customerId" required><option value="">Search and select a customer</option></select></label><button type="submit">Review conversion</button></form>`;
  const form = body.querySelector('form');
  const search = form.querySelector('[data-customer-search]');
  search.addEventListener('click', async () => {
    const query = form.elements.customerQuery.value.trim();
    if (query.length < 2) { error('Enter at least two characters to find a customer.'); return; }
    searchController?.abort(); const controller = searchController = new AbortController();
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    search.disabled = true; error('');
    try {
      const response = await fetch('/api/dispatch?view=customers&q=' + encodeURIComponent(query), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (generation !== epoch || searchController !== controller || !body.isConnected) return;
      if (!response.ok || result.ok !== true || !Array.isArray(result.customers)) throw new Error(result.error || 'Customer search is unavailable.');
      form.elements.customerId.innerHTML = '<option value="">Select a customer</option>' + result.customers.map(customer => `<option value="${esc(customer.id)}">${esc(customer.name)} — ${esc(customer.phone || customer.email || '')}</option>`).join('');
      if (!result.customers.length) error('No matching customer found. Create the customer through the existing staff workflow first.');
    } catch (failure) { if (generation === epoch && (timedOut || !controller.signal.aborted)) error(timedOut ? 'Customer search timed out. Try again.' : failure.message); }
    finally { clearTimeout(timer); if (searchController === controller) search.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation(); const button = form.querySelector('button[type="submit"]'); if (button.disabled) return;
    button.disabled = true; error('');
    const input = { serviceRequestId: request.id, customerId: form.elements.customerId.value.trim(), accountRevision: data.businessRequestRevision };
    if (!input.customerId) { error('Select an existing customer before reviewing.'); button.disabled = false; return; }
    try {
      const preview = await hub.api({ ...input, action: 'preview_business_request_conversion' }); if (generation !== epoch) return;
      body.innerHTML = `<h3>${esc(preview.customer.name)}</h3><p>${esc(preview.customer.email)} · ${esc(preview.customer.phone)}</p><p>${esc(preview.property.name)} - ${esc(preview.property.address)}</p><p>${esc(preview.request.scope)}</p><p>Payer: ${esc(preview.request.payer)} · PO: ${esc(preview.request.purchaseOrder || 'None')} · Preferred date: ${esc(preview.request.preferredDate || 'Flexible')} (not booked)</p><p>This creates one unpriced, unscheduled job. Staff must review pricing and book it through Dispatch. No customer message is sent.</p><label><input type="checkbox" data-conversion-confirm> I verified this company's authority for the selected customer, property, scope and billing.</label><button type="button" data-conversion-save>Create unscheduled job</button>`;
      const save = body.querySelector('[data-conversion-save]');
      const payload = operation({ ...input, previewToken: preview.previewToken, action: 'convert_business_request', sharingAuthorized: true });
      save.addEventListener('click', async () => {
        if (save.disabled) return;
        if (!body.querySelector('[data-conversion-confirm]').checked) { error('Confirm the company authorization before continuing.'); return; }
        save.disabled = true; error('');
        try {
          const result = await hub.api(payload); if (generation !== epoch) return;
          dialog.close(); hub.toast(`Saved unscheduled job ${result.jobId}. No price, appointment or message was created.`); await hub.reload();
        } catch (failure) { if (generation === epoch) error(failure.message); }
        finally { save.disabled = false; }
      });
    } catch (failure) { if (generation === epoch) error(failure.message); }
    finally { button.disabled = false; }
  });
}
function conversation(request) {
  const data = hub.data(), epoch = generation, body = open('Request conversation');
  body.innerHTML = `<p>${esc(request.service)} — ${esc(hub.propName(request.propertyId))}</p><p>Saved in this account only. No email or text notification is sent.</p><div>${data.messages.filter(m => m.requestId === request.id).map(m => `<p><b>${esc(m.author)}</b>: ${esc(m.body)}</p>`).join('') || '<p>No replies yet.</p>'}</div><form method="dialog"><label>Reply<textarea name="body" maxlength="1600" required></textarea></label><button type="submit">Save account reply</button></form>`;
  const form = body.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation(); const button = form.querySelector('button'); if (button.disabled) return;
    const text = form.elements.body.value.trim(); if (!text) return;
    const key = JSON.stringify([data.account.id, 'reply', request.id, text]); if (!pending.has(key)) pending.set(key, hub.newId());
    button.disabled = true;
    try { await hub.api({ action: 'message', requestId: request.id, body: text, messageId: pending.get(key) }); if (epoch !== generation) return; pending.delete(key); dialog.close(); await hub.reload(); }
    catch (failure) { if (epoch === generation) error(failure.message); }
    finally { button.disabled = false; }
  });
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-business-convert],[data-business-reply]'); if (!button) return;
  const request = hub.data()?.requests.find(r => r.id === (button.dataset.businessConvert || button.dataset.businessReply));
  if (request) button.dataset.businessConvert ? conversion(request) : conversation(request);
});
})();
