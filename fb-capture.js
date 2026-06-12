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

  function fill() {
    var map = { fbc: fbc, fbp: fbp, fbclid: fbclid, landing_url: landing, referrer: ref };
    document.querySelectorAll('form.lead-form-lite').forEach(function (f) {
      Object.keys(map).forEach(function (k) {
        var el = f.querySelector('input[name="' + k + '"]');
        if (el && !el.value) el.value = map[k];
      });
    });
  }
  if (document.readyState !== 'loading') fill();
  else document.addEventListener('DOMContentLoaded', fill);
})();
