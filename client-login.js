/* Client Login page. Posts one phone or email to /api/customer-login and
   always shows the same message, whatever the server found. On load it asks
   the API whether sign-in can work at all (GET: 404 off, 503 not ready, 405
   ready), so a disabled or unavailable service shows "Text us for a secure
   link" straight away. On the link-confirm page it only stops a second tap
   from spending the link twice. Text is only ever set through textContent. */
(function () {
  'use strict';
  var GENERIC = 'If we find a project for that phone or email, we’ll send a sign-in link. It expires in 15 minutes.';
  var STATUS = {
    expired: 'That sign-in link expired or is no longer valid. Request a new one below.',
    used: 'That sign-in link was already used. If you just tapped it, open your projects. Otherwise wait 10 minutes, then request a new link. We send up to 3 links a day, so if no link arrives, text us at (970) 999-1818.',
    invalid: 'That sign-in link isn’t valid. Request a new one below.',
    retry: 'Your sign-in didn’t finish. Open the link from your text or email again.',
    unavailable: 'Sign-in is temporarily unavailable. Try your link again shortly, or text us for a secure link.',
    signed_in: 'You’re signed in, but we couldn’t find an active project to open yet. Text us at (970) 999-1818 and we’ll help.'
  };
  var TIMEOUT_MS = 20000, PROBE_MS = 10000;
  var $ = function (id) { return document.getElementById(id); };
  var form, phone, email, error, submit, busy = false;

  function method() { var checked = form.querySelector('input[name="method"]:checked'); return checked && checked.value === 'email' ? 'email' : 'phone'; }
  function field() { return method() === 'email' ? email : phone; }
  function digits(value) { return String(value || '').replace(/\D/g, ''); }
  function validPhone(value) { var d = digits(value); return /^[\d\s().+-]{10,30}$/.test(String(value).trim()) && (d.length === 10 || (d.length === 11 && d.charAt(0) === '1')); }
  function validEmail(value) { var v = String(value || '').trim(); return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function showError(message) {
    error.textContent = message; error.hidden = !message;
    field().setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function setBusy(value) {
    busy = value; submit.disabled = value;
    submit.textContent = value ? 'Sending…' : 'Send my sign-in link';
  }

  function switchMethod() {
    var isEmail = method() === 'email';
    $('cl-phone-field').hidden = isEmail; $('cl-email-field').hidden = !isEmail;
    phone.removeAttribute('aria-invalid'); email.removeAttribute('aria-invalid');
    error.hidden = true; error.textContent = '';
  }

  function show(panel) {
    form.hidden = panel !== 'form'; $('cl-sent').hidden = panel !== 'sent'; $('cl-fallback').hidden = panel !== 'fallback';
  }

  function sent(message) {
    $('cl-sent-message').textContent = message || GENERIC;
    show('sent'); $('cl-again').focus();
  }

  function fallback() { show('fallback'); }

  function readStatus() {
    var params = new URLSearchParams(window.location.search), key = params.get('status');
    if (!key || !Object.prototype.hasOwnProperty.call(STATUS, key)) return;
    var status = $('cl-status');
    status.textContent = STATUS[key]; status.hidden = false;
    if (key === 'used') $('cl-status-portal').hidden = false;
    try { window.history.replaceState(null, '', window.location.pathname); } catch (ignore) { /* The message still shows. */ }
  }

  async function request(identifier) {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    try {
      return await fetch('/api/customer-login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-EGC-Portal': '1' },
        body: JSON.stringify({ identifier: identifier, botcheck: form.elements.botcheck.value })
      });
    } finally { clearTimeout(timer); }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    var input = field(), value = input.value.trim();
    if (method() === 'email' ? !validEmail(value) : !validPhone(value)) {
      showError(method() === 'email' ? 'Enter the email address you use with Easy Garage Cleaning.' : 'Enter a 10-digit mobile number, like 970 555 0123.');
      input.focus(); return;
    }
    showError(''); setBusy(true);
    var response;
    try { response = await request(value); } catch (ignore) { setBusy(false); fallback(); return; }
    setBusy(false);
    if (response.status === 202) {
      var data = await response.json().catch(function () { return null; });
      sent(data && data.ok === true && typeof data.message === 'string' ? data.message : GENERIC);
      return;
    }
    if (response.status === 400) {
      var problem = await response.json().catch(function () { return null; });
      if (problem && problem.code === 'CUSTOMER_LOGIN_IDENTIFIER_INVALID') { showError(problem.error); input.focus(); return; }
    }
    // Disabled (404), unavailable (503) or anything unexpected: never guess, offer the text line.
    fallback();
  }

  // Off (404), not ready (503) or unreachable: offer the text line before anyone types. Anything else leaves the form to the POST.
  async function probe() {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, PROBE_MS), status = 0;
    try { status = (await fetch('/api/customer-login', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal })).status; }
    catch (ignore) { status = 0; }
    finally { clearTimeout(timer); }
    if ((status === 404 || status === 503 || status === 0) && !busy && !form.hidden) fallback();
  }

  // The link is single-use: the first tap submits, a second tap (or Enter) is ignored.
  function confirmOnce(confirm) {
    var button = confirm.querySelector('button[type="submit"]'), label = button.textContent, sent = false;
    confirm.addEventListener('submit', function (event) {
      if (sent) { event.preventDefault(); return; }
      sent = true; button.disabled = true; button.textContent = 'Signing in…';
    });
    window.addEventListener('pageshow', function (event) { if (event.persisted) { sent = false; button.disabled = false; button.textContent = label; } });
  }

  function start() {
    var confirm = $('cl-confirm');
    if (confirm) { confirmOnce(confirm); return; }
    form = $('cl-form'); phone = $('cl-phone'); email = $('cl-email'); error = $('cl-error'); submit = $('cl-submit');
    if (!form) return;
    form.addEventListener('submit', onSubmit);
    Array.prototype.forEach.call(form.querySelectorAll('input[name="method"]'), function (radio) { radio.addEventListener('change', switchMethod); });
    $('cl-again').addEventListener('click', function () { form.reset(); switchMethod(); show('form'); phone.focus(); });
    readStatus();
    probe();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());
