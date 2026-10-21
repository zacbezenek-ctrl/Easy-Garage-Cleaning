/* Count conversions only after an accepted landing-page submission. */
(function () {
  'use strict';
  var KEY = 'egc_lp_confirmed', pending;
  if (/\/lp-thank-you(?:\.html)?\/?$/.test(location.pathname)) {
    try { pending = JSON.parse(sessionStorage.getItem(KEY) || 'null'); sessionStorage.removeItem(KEY); } catch (_) {}
    if (pending && Date.now() - pending.at >= 0 && Date.now() - pending.at < 600000) {
      if (typeof window.gtag === 'function') window.gtag('event', 'generate_lead', { event_category: 'lead', event_label: pending.label });
      if (typeof window.fbq === 'function') window.fbq('track', 'Lead', { content_name: pending.label }, pending.id ? { eventID: pending.id } : {});
    }
  }
  document.querySelectorAll('form[data-lp]').forEach(function (form) {
    var busy = false, button = form.querySelector('[type="submit"]'), original = button.textContent;
    var status = document.createElement('p');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.className = 'lp-note'; form.appendChild(status);
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      busy = true; button.disabled = true; button.textContent = 'Sending…'; status.textContent = '';
      try {
        var fd = new FormData(form), destination = new URL(fd.get('redirect'), location.origin);
        if (destination.origin !== location.origin || !/^\/lp-thank-you(?:\.html)?$/.test(destination.pathname)) throw new Error('invalid confirmation');
        fd.delete('redirect');
        var response = await fetch(form.action, { method: 'POST', body: fd }), result = await response.json();
        if (!response.ok || result.success !== true) throw new Error('not accepted');
        var id = window.EGCLeadCapture ? window.EGCLeadCapture.relay(form) : '';
        try { sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), label: form.getAttribute('data-meta-lead'), id: id || '' })); } catch (_) {}
        location.assign(destination.href);
      } catch (_) {
        busy = false; button.disabled = false; button.textContent = original;
        status.textContent = 'Your request could not be confirmed. Please try again, or call (970) 999-1818.';
      }
    });
  });
}());
