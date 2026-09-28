/* Team extension: per-property member access. Property checkboxes on invitations, an edit dialog and access badges.
   DOM is built with h() and textContent; the server enforces every rule again on each request. */
(() => {
'use strict';
const hub = window.EGCBusinessHub; if (!hub) return;
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value] of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else if(name in node&&!name.startsWith('aria-'))node[name]=value;else node.setAttribute(name,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const limitText = n => `Access limited to ${n} ${n === 1 ? 'property' : 'properties'}`;
const limited = m => Array.isArray(m?.propertyIds);
const ADMIN_NOTE = 'Account administrators always have access to every property.', NONE = 'Select at least one property, or choose All properties.';
// A radio pair plus one checkbox per property. selected: null for every property, or an array of property ids.
function scopeField(properties, selected) {
 const list = h('div', { class: 'scope-list', hidden: !selected }, properties.map(p => h('label', { class: 'scope-option' }, h('input', { type: 'checkbox', value: p.id, checked: Boolean(selected?.includes(p.id)) }), h('span', null, p.name, h('small', null, p.address)))));
 const choice = (value, text) => h('label', { class: 'scope-option' }, h('input', { type: 'radio', name: 'propertyScope', value, checked: (value === 'some') === Boolean(selected), onchange: () => { list.hidden = value !== 'some'; } }), h('span', null, text));
 return h('fieldset', { class: 'scope-field' }, h('legend', null, 'Property access'), choice('all', 'All properties, including ones added later'), choice('some', 'Only selected properties'), list, h('p', { class: 'small scope-admin', hidden: true }, ADMIN_NOTE));
}
// null means every property; an empty array means "only selected" with nothing selected.
function chosen(field) { return field.querySelector('input[type=radio][value=some]:checked') ? [...field.querySelectorAll('.scope-list input:checked')].map(input => input.value) : null; }
function setChoice(field, selected) {
 field.querySelector(`input[type=radio][value=${selected ? 'some' : 'all'}]`).checked = true; field.querySelector('.scope-list').hidden = !selected;
 for (const input of field.querySelectorAll('.scope-list input')) input.checked = Boolean(selected?.includes(input.value));
}
function adminOnly(field, admin) {
 const some = field.querySelector('input[type=radio][value=some]'); some.disabled = admin; field.querySelector('.scope-admin').hidden = !admin;
 if (admin) setChoice(field, null);
}
hub.registerMemberColumns((m, data) => {
 if (!m.id) return '';
 const badge = m.role !== 'admin' && limited(m) ? `<span class="scope-badge limited">${hub.esc(limitText(m.propertyIds.length))}</span>` : '<span class="scope-badge">All properties</span>';
 const edit = data.viewer.permissions.team && m.role !== 'admin' && m.status !== 'revoked' && data.properties.length ? `<button type="button" data-ext-scope="${hub.esc(m.id)}">${limited(m) ? 'Edit property access' : 'Limit to properties'}</button>` : '';
 return badge + edit;
}, 'Property access', data => Boolean(data.viewer.permissions.team));
hub.registerRenderHook((content, data) => {
 if (Array.isArray(data.viewer?.propertyIds)) content.prepend(h('p', { class: 'scope-note' }, h('span', { class: 'scope-badge limited' }, limitText(data.viewer.propertyIds.length)), h('span', null, 'Ask your account administrator to change which properties you can see.')));
 const form = content.querySelector('form[data-form=invite]');
 if (!form || !data.properties.length || form.querySelector('.scope-field')) return;
 const field = scopeField(data.properties, null), role = form.querySelector('select[name=role]'), address = form.querySelector('input[name=email]'), note = h('p', { class: 'small scope-prefill', 'aria-live': 'polite' });
 field.append(note); form.insertBefore(field, form.querySelector('button.primary'));
 // Renewing someone by email starts from their saved property access, but never overrides a choice the administrator
 // made (programmatic setChoice fires no change event, so only their own clicks mark the field as touched).
 let touched = false;
 field.addEventListener('change', () => { touched = true; prefill(); });
 function prefill() {
  const member = data.members.find(m => m.email && m.email === address?.value.trim().toLowerCase()), admin = role?.value === 'admin';
  if (!touched && !admin) setChoice(field, member && limited(member) ? member.propertyIds : null);
  note.textContent = !member || admin ? '' : touched ? `Your choice here replaces ${member.name}’s saved property access.` : `Starting from ${member.name}’s saved property access.`;
 }
 role?.addEventListener('change', () => { adminOnly(field, role.value === 'admin'); prefill(); }); adminOnly(field, role?.value === 'admin');
 address?.addEventListener('change', prefill);
});
hub.registerSubmitHook('invite', (form, payload) => {
 delete payload.propertyScope;
 const field = form.querySelector('.scope-field'); if (!field) return;
 const ids = payload.role === 'admin' ? null : chosen(field);
 if (ids && !ids.length) throw new Error(NONE);
 payload.propertyIds = ids || [];
});
let dialog = null, opener = null, pending = null;
function close() { dialog?.close(); }
async function save(event, member) {
 event.preventDefault(); event.stopPropagation();
 const form = event.currentTarget, field = form.querySelector('.scope-field'), error = form.querySelector('.scope-error'), button = form.querySelector('button.primary'), ids = chosen(field);
 if (ids && !ids.length) { error.textContent = NONE; return; }
 const body = { action: 'set_member_properties', memberId: member.id, propertyIds: ids || [] }, key = JSON.stringify(body);
 // An unconfirmed save is retried with the same requestId; a changed selection is a new request.
 if (pending?.key !== key) pending = { key, requestId: hub.newId() };
 button.disabled = true; error.textContent = '';
 try { await hub.api({ ...body, requestId: pending.requestId }); pending = null; close(); hub.toast('Property access saved. It applies on their next page load or project action.'); await hub.reload(); }
 catch (failure) { error.textContent = failure.message; if (failure.status && failure.status < 500 && ![401, 403, 408, 429].includes(failure.status)) pending = null; }
 finally { button.disabled = false; }
}
function open(memberId, button) {
 const data = hub.data(), member = data?.members.find(m => m.id === memberId); if (!member) return;
 opener = button; pending = null;
 if (!dialog) { dialog = h('dialog', { id: 'scope-dialog', 'aria-labelledby': 'scope-title', onclose: () => opener?.focus() }); document.body.append(dialog); }
 const form = h('form', { method: 'dialog', onsubmit: event => save(event, member) },
  h('button', { type: 'button', class: 'dialog-close', 'aria-label': 'Close', onclick: close }, 'Close'),
  h('p', { class: 'eyebrow' }, 'PROPERTY ACCESS'), h('h2', { id: 'scope-title' }, member.name),
  h('p', { class: 'small' }, 'They see requests, projects, invoices and request messages only for the properties you choose. Changes apply on their next page load or project action; they stay signed in.'),
  scopeField(data.properties, limited(member) ? member.propertyIds : null), h('p', { class: 'scope-error', role: 'alert' }),
  h('button', { type: 'submit', class: 'primary' }, 'Save property access'));
 dialog.replaceChildren(form); dialog.showModal();
}
document.addEventListener('click', event => { const button = event.target.closest('button[data-ext-scope]'); if (button) open(button.dataset.extScope, button); });
})();
