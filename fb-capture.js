/* EGC Meta attribution capture — fills hidden fbc/fbp/fbclid/landing/referrer
   on the lead form so Web3Forms → Zapier → Meta Conversions API can match a
   completed garage job back to the Instagram/Facebook ad that drove it.
   Meta's _fbc/_fbp cookies are set by the Pixel; we also synthesize fbc from
   fbclid and persist across the visit so a lead submitted later still carries it. */
(function () {
  function cookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : '';
  }
  function param(name) {
    try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; }
  }
  function store(k, v) { try { if (v) localStorage.setItem(k, v); } catch (e) {} }
  function recall(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  var fbclid = param('fbclid') || recall('egc_fbclid');
  if (fbclid) store('egc_fbclid', fbclid);

  // _fbc: prefer the Pixel cookie; else synthesize from fbclid (fb.1.<ts>.<fbclid>); else recalled
  var fbc = cookie('_fbc');
  if (!fbc && fbclid) { fbc = 'fb.1.' + Date.now() + '.' + fbclid; }
  fbc = fbc || recall('egc_fbc');
  if (fbc) store('egc_fbc', fbc);

  var fbp = cookie('_fbp') || recall('egc_fbp');
  if (fbp) store('egc_fbp', fbp);

  var landing = recall('egc_landing');
  if (!landing) { landing = location.href; store('egc_landing', landing); }
  var ref = recall('egc_referrer');
  if (!ref) { ref = document.referrer || ''; store('egc_referrer', ref); }
  var campaign = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'msclkid'].forEach(function (k) {
    campaign[k] = param(k) || recall('egc_' + k);
    if (campaign[k]) store('egc_' + k, campaign[k]);
  });

  function fill() {
    var map = Object.assign({ fbc: fbc, fbp: fbp, fbclid: fbclid, landing_url: landing, referrer: ref }, campaign);
    document.querySelectorAll('form.lead-form-lite, form.multi-step-form').forEach(function (f) {
      Object.keys(map).forEach(function (k) {
        var el = f.querySelector('input[name="' + k + '"]');
        if (el && !el.value) el.value = map[k];
      });
    });
  }
  if (document.readyState !== 'loading') fill();
  else document.addEventListener('DOMContentLoaded', fill);

  function isLeadForm(f) {
    return !!(f && f.classList && (f.classList.contains('lead-form-lite') || f.classList.contains('multi-step-form')));
  }
  // A version-4 UUID for the inquiry; '' only where the browser has no crypto.
  function uuid() {
    try {
      var c = window.crypto || (typeof crypto !== 'undefined' ? crypto : null);
      if (c && c.randomUUID) return c.randomUUID();
      var b = c.getRandomValues(new Uint8Array(16)), h = '';
      b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128;
      for (var i = 0; i < 16; i++) h += (b[i] + 256).toString(16).slice(1);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    } catch (e) { return ''; }
  }
  // FUN-13: one inquiry id per submitted set of answers. The same answers are
  // sent again only after the relay failed, and then with the same id, so the
  // Hub records the lead once; changed answers are a new inquiry.
  var sent = typeof WeakMap === 'function' ? new WeakMap() : null;

  function payloadFor(f) {
    var fd = new FormData(f);
    var pick = function () { for (var i = 0; i < arguments.length; i++) { var v = fd.get(arguments[i]); if (v != null && String(v).trim()) return String(v); } return ''; };
    return {
      page_url: location.href,
      name: pick('name', 'Name'), phone: pick('phone', 'Phone'), email: pick('email', 'Email'),
      items: pick('items', 'Service type', 'What to remove', 'Job size'), service_type: pick('Service type'), job_size: pick('Job size'), what_to_remove: pick('What to remove'), photo_description: pick('Photo description'), source: pick('source'), subject: pick('subject'),
      city: pick('city', 'City'), serviceZip: pick('serviceZip', 'Zip code', 'ZIP'),
      preferred_date: pick('preferred_date', 'Preferred date'), preferred_timing: pick('preferred_timing', 'Preferred timing'),
      booking_slot: pick('booking_slot', 'booking_slot_choice'), estimated_range: pick('estimated_range'), flow_type: pick('flow_type'),
      sms_consent: pick('sms_consent'), fbc: pick('fbc') || fbc, fbp: pick('fbp') || fbp, fbclid: pick('fbclid') || fbclid,
      landing_url: pick('landing_url') || landing, referrer: pick('referrer') || ref,
      utm_source: campaign.utm_source, utm_medium: campaign.utm_medium, utm_campaign: campaign.utm_campaign,
      utm_content: campaign.utm_content, utm_term: campaign.utm_term, gclid: campaign.gclid, msclkid: campaign.msclkid
    };
  }

  /* Mirror a lead submission to /api/web-lead (same-origin relay → HighLevel
     as the CRM source of truth, plus the existing Zapier instant-text/CAPI leg).
     Fire-and-forget: never blocks or delays the native Web3Forms POST, and a
     relay failure is silent — Web3Forms email remains a fallback. Returns the
     answers' inquiry id (also the Meta Lead eventID), '' when the browser has
     no crypto, or false for a non-lead form or the honeypot. */
  function relay(f, extra) {
    if (!isLeadForm(f)) return false;
    try {
      var bot = f.querySelector('input[name="botcheck"]');
      if (bot && bot.checked) return false;
      var payload = payloadFor(f);
      if (extra) Object.keys(extra).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(payload, k) && typeof extra[k] === 'string') payload[k] = extra[k]; });
      var key = JSON.stringify(payload), last = sent && sent.get(f);
      if (last && last.key === key && last.state !== 'failed') return last.id;
      var entry = { key: key, id: last && last.key === key ? last.id : uuid(), state: 'sending' };
      if (sent) sent.set(f, entry);
      if (entry.id) payload.inquiry_id = entry.id;
      var body = JSON.stringify(payload);
      if (window.fetch) {
        fetch('/api/web-lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
          .then(function (r) { entry.state = r && r.ok ? 'sent' : 'failed'; }, function () { entry.state = 'failed'; });
      } else if (navigator.sendBeacon) {
        entry.state = navigator.sendBeacon('/api/web-lead', body) ? 'sent' : 'failed';
      }
      return entry.id;
    } catch (err) { return false; }
  }

  // Pages whose own submit handler cancels the native POST (ads.html sends
  // Web3Forms by fetch) call this directly, because the listener below never
  // sees a canceled submit.
  window.EGCLeadCapture = { relay: relay };

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (e.defaultPrevented || !isLeadForm(f)) return;
    var id = relay(f);
    // Forms marked data-meta-lead (book.html) report the Meta Lead here, with
    // the inquiry id as the eventID so the server-side CAPI Lead deduplicates.
    var label = f.getAttribute && f.getAttribute('data-meta-lead');
    if (id === false || !label || typeof window.fbq !== 'function') return;
    try {
      if (id) window.fbq('track', 'Lead', { content_name: label }, { eventID: id });
      else window.fbq('track', 'Lead', { content_name: label });
    } catch (err) {}
  });
})();
