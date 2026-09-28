/* EGC lead attribution capture + HighLevel relay.
   Fills hidden fbc/fbp/fbclid/landing/referrer/utm/click-id inputs on the lead
   form so Web3Forms → Zapier → Meta Conversions API can match a completed job
   back to the ad that drove it, and mirrors every lead to /api/web-lead
   (same-origin relay → HighLevel as the CRM source of truth).
   Meta's _fbc/_fbp cookies are set by the Pixel; we also synthesize fbc from
   fbclid and persist across the visit so a lead submitted later still carries it.
   Click IDs (Google/Microsoft and fbclid) are stored with a timestamp
   (egc_<k>_ts) and are ignored once they are older than 90 days (the Google
   Ads click window). A new tagged visit is a new touch: stored click IDs it
   does not carry are dropped, so an old ad click never outranks it. */
(function () {
  var CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'msclkid'];
  var UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var ATTRIBUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  var RELAY_DEDUPE_MS = 3000;
  // In-area ZIPs for the 7 service towns — the one list in this file.
  var SERVICE_ZIPS = {
    '80521': 1, '80522': 1, '80523': 1, '80524': 1, '80525': 1, '80526': 1, '80527': 1, '80528': 1, // Fort Collins
    '80537': 1, '80538': 1, '80539': 1, // Loveland
    '80550': 1, '80551': 1, // Windsor (80550 also covers part of Severance)
    '80547': 1, // Timnath
    '80549': 1, // Wellington
    '80546': 1, // Severance
    '80535': 1  // LaPorte
  };

  function cookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : '';
  }
  function param(name) {
    try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; }
  }
  function store(k, v) { try { if (v) localStorage.setItem(k, v); } catch (e) {} }
  function put(k, v) { try { localStorage.setItem(k, v || ''); } catch (e) {} }
  function recall(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  var now = Date.now();
  function fresh(tsKey) {
    var ts = Number(recall(tsKey)) || 0;
    return ts > 0 && now - ts <= ATTRIBUTION_TTL_MS;
  }

  // A new ad click or tagged link starts a new attribution touch.
  var newTouch = ['fbclid'].concat(CLICK_IDS, UTMS).some(function (k) { return !!param(k); });

  var urlFbclid = param('fbclid');
  if (urlFbclid) {
    store('egc_fbclid', urlFbclid);
    store('egc_fbclid_ts', String(now));
  } else if (recall('egc_fbclid') && (newTouch || !fresh('egc_fbclid_ts'))) {
    put('egc_fbclid', ''); put('egc_fbclid_ts', ''); put('egc_fbc', '');
  }
  var fbclid = urlFbclid || recall('egc_fbclid');

  // _fbc: prefer the Pixel cookie; else synthesize from a fresh fbclid
  // (fb.1.<ts>.<fbclid>); else the one synthesized when the click arrived.
  var fbc = cookie('_fbc');
  if (!fbc && urlFbclid) { fbc = 'fb.1.' + now + '.' + urlFbclid; }
  fbc = fbc || recall('egc_fbc');
  if (!fbc && fbclid) { fbc = 'fb.1.' + now + '.' + fbclid; }
  if (fbc) store('egc_fbc', fbc);

  var fbp = cookie('_fbp') || recall('egc_fbp');
  if (fbp) store('egc_fbp', fbp);

  var landing = recall('egc_landing');
  var ref = recall('egc_referrer');
  if (newTouch || !landing) {
    landing = location.href; store('egc_landing', landing);
    ref = document.referrer || ''; put('egc_referrer', ref);
  }

  // Google's conversion linker keeps its own dated copy (GCL.<unix seconds>.<id>);
  // use it when our stored copy is missing or stale.
  function linkerId(cookieName) {
    var m = /^GCL\.(\d+)\.(.+)$/.exec(cookie(cookieName));
    if (!m) return '';
    var ts = Number(m[1]) * 1000;
    return ts > 0 && now - ts <= ATTRIBUTION_TTL_MS ? m[2] : '';
  }

  var campaign = {};
  CLICK_IDS.forEach(function (k) {
    var fromUrl = param(k);
    if (fromUrl) {
      campaign[k] = fromUrl;
      store('egc_' + k, fromUrl);
      store('egc_' + k + '_ts', String(now));
      return;
    }
    var saved = recall('egc_' + k);
    if (saved && !newTouch && fresh('egc_' + k + '_ts')) { campaign[k] = saved; return; }
    if (saved) { put('egc_' + k, ''); put('egc_' + k + '_ts', ''); }
    campaign[k] = '';
  });
  if (!newTouch) {
    if (!campaign.gclid) campaign.gclid = linkerId('_gcl_aw');
    if (!campaign.gbraid) campaign.gbraid = linkerId('_gcl_gb');
  }

  // UTMs travel as one set: a newly tagged link replaces the whole set so a
  // stale utm_content from an older ad never mixes with the new campaign.
  if (UTMS.some(function (k) { return !!param(k); })) {
    UTMS.forEach(function (k) { campaign[k] = param(k); put('egc_' + k, campaign[k]); });
    store('egc_utm_ts', String(now));
  } else {
    var utmsFresh = fresh('egc_utm_ts');
    UTMS.forEach(function (k) { campaign[k] = utmsFresh ? recall('egc_' + k) : ''; });
  }

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

  function newRequestId() {
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) {}
    return 'egc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function serviceArea(zip) {
    var z = String(zip || '').replace(/\D/g, '').slice(0, 5);
    if (z.length !== 5) return 'unknown';
    return SERVICE_ZIPS[z] ? 'yes' : 'no';
  }

  /* Mirror one lead to /api/web-lead. Fire-and-forget: never blocks or delays
     the native Web3Forms POST, and a relay failure is silent — the Web3Forms
     email remains the fallback. Pages that cancel the native submit (AJAX
     forms) call window.EGCLeadRelay.relay(form) themselves after validation;
     a form relayed in the last 3 seconds, or one whose exact payload (same
     request id) was already relayed, is not sent again — a retry after a
     Web3Forms error must not text the lead twice. A relay the server rejects
     can be sent again. Returns true when a request was sent. */
  function relayLead(f) {
    if (!f) return false;
    try {
      var bot = f.querySelector('input[name="botcheck"]');
      if (bot && bot.checked) return false;
      var state = f.dataset;
      var sentAt = state ? Number(state.egcRelayedAt) || 0 : 0;
      if (sentAt && Date.now() - sentAt < RELAY_DEDUPE_MS) return false;

      var fd = new FormData(f);
      var pick = function () { for (var i = 0; i < arguments.length; i++) { var v = fd.get(arguments[i]); if (v != null && String(v).trim()) return String(v); } return ''; };
      var requestId = pick('request_id');
      if (!requestId) {
        requestId = newRequestId();
        var ridInput = f.querySelector('input[name="request_id"]');
        if (ridInput && !ridInput.value) ridInput.value = requestId;
      }
      var serviceZip = pick('serviceZip', 'Zip code', 'ZIP', 'zip');
      var payload = {
        page_url: location.href, request_id: requestId,
        name: pick('name', 'Name'), phone: pick('phone', 'Phone'), email: pick('email', 'Email'),
        items: pick('items', 'Service type', 'What to remove', 'Job size'), service_type: pick('Service type', 'service_type'), job_size: pick('Job size', 'Garage size'), what_to_remove: pick('What to remove'), photo_description: pick('Photo description'), source: pick('source'), subject: pick('subject'),
        page_service: pick('page_service'), page_variant: pick('page_variant'),
        city: pick('city', 'City'), serviceZip: serviceZip, in_service_area: pick('in_service_area') || serviceArea(serviceZip),
        preferred_date: pick('preferred_date', 'Preferred date'), preferred_timing: pick('preferred_timing', 'Preferred timing'),
        booking_slot: pick('booking_slot', 'booking_slot_choice'), estimated_range: pick('estimated_range'), flow_type: pick('flow_type'),
        sms_consent: pick('sms_consent'), fbc: pick('fbc') || fbc, fbp: pick('fbp') || fbp, fbclid: pick('fbclid') || fbclid,
        landing_url: pick('landing_url') || landing, referrer: pick('referrer') || ref,
        utm_source: campaign.utm_source, utm_medium: campaign.utm_medium, utm_campaign: campaign.utm_campaign,
        utm_content: campaign.utm_content, utm_term: campaign.utm_term,
        gclid: campaign.gclid, gbraid: campaign.gbraid, wbraid: campaign.wbraid, msclkid: campaign.msclkid
      };
      var body = JSON.stringify(payload);
      if (state && state.egcRelayedBody === body) return false;
      if (state) { state.egcRelayed = requestId; state.egcRelayedAt = String(Date.now()); state.egcRelayedBody = body; }
      var unmark = function () { if (state && state.egcRelayedBody === body) state.egcRelayedBody = ''; };
      if (window.fetch) {
        fetch('/api/web-lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
          .then(function (r) { if (r && r.ok === false) unmark(); }, unmark);
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/web-lead', body);
      } else {
        return false;
      }
      return true;
    } catch (err) { return false; }
  }
  window.EGCLeadRelay = { relay: relayLead };

  /* Native-POST forms: relay from the document bubble phase so the page's own
     submit handler has already finalized its fields. A handler that cancels
     the submit (defaultPrevented) owns the relay via EGCLeadRelay.relay. */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (e.defaultPrevented || !f || !f.classList ||
        (!f.classList.contains('lead-form-lite') && !f.classList.contains('multi-step-form'))) return;
    relayLead(f);
  });
})();
