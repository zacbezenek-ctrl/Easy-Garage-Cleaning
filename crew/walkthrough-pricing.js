/* Walkthrough price tables from /api/pricing-config. This page ships no prices: the
   tables are fetched after sign-in and kept on this device per signed-in user and
   config version, so a walkthrough opened offline later still prices. Sign-out clears
   them. With no saved copy the walkthrough shows prices as unavailable instead of
   guessing, and says whether the device is offline or the Hub answered without prices. */
(function () {
  'use strict';
  const PREFIX = 'egc_walkthrough_pricing.v1.';
  const OFFLINE = 'Pricing unavailable offline — connect once to load prices';
  // The Hub answered but sent no usable tables (for example 503 pricing_config_unavailable).
  const UNAVAILABLE = 'Prices could not be loaded from the Hub. Retry shortly or tell the office.';
  const TIMEOUT = 15000;
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
  const minutes = value => Number.isSafeInteger(value) && value >= 0 && value <= 1440;
  const keyed = (value, keys, check) => plain(value) && keys.every(key => check(value[key]));
  const priced = value => plain(value) && Object.keys(value).length > 0 && Object.values(value).every(amount);
  const service = value => plain(value) && amount(value.amount) && minutes(value.minutes);
  const SIZES = ['1', '2', '3', 'other'], FILLS = ['light', 'medium', 'full', 'packed'], SHELVES = ['metal', 'wood', 'plastic'];

  function valid(p) {
    if (!plain(p) || typeof p.version !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(p.version)) return false;
    if (!keyed(p.sizeBase, SIZES, amount) || !SIZES.includes(p.defaultSize) || !keyed(p.fill, FILLS, amount)) return false;
    if (!amount(p.perLoad) || !priced(p.special) || !priced(p.access) || !amount(p.minimum) || !(amount(p.roundTo) && p.roundTo > 0)) return false;
    const s = p.services, m = p.minutes;
    if (!plain(s) || !service(s.pressure_wash) || !service(s.totes) || !service(s.mouse_trapping) || !plain(p.hazards) || !service(p.hazards['Pest waste'])) return false;
    if (!plain(s.deep_clean) || !keyed(s.deep_clean.bySize, SIZES, service) || !plain(s.shelving) || !keyed(s.shelving.byType, SHELVES, service) || !SHELVES.includes(s.shelving.defaultType)) return false;
    if (!plain(m) || !['base', 'perLoad', 'defaultFill', 'perSpecial', 'min', 'max'].every(key => minutes(m[key])) || !keyed(m.fill, FILLS, minutes) || !plain(m.access) || !Object.values(m.access).every(minutes)) return false;
    return amount(m.minLoads) && amount(m.defaultLoads) && Number.isSafeInteger(m.calibratedCrew) && m.calibratedCrew > 0 && Number.isSafeInteger(m.roundTo) && m.roundTo > 0 && m.min <= m.max;
  }
  const person = user => encodeURIComponent(String(user || '').trim().toLowerCase());
  function keys(prefix) {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const name = localStorage.key(i) || ''; if (name.startsWith(prefix)) out.push(name); } } catch {}
    return out;
  }
  const remove = names => { try { names.forEach(name => localStorage.removeItem(name)); } catch {} };
  function cached(user) {
    if (!person(user)) return null;
    for (const name of keys(PREFIX + person(user) + '.')) {
      try {
        const saved = JSON.parse(localStorage.getItem(name) || 'null');
        if (plain(saved) && saved.user === person(user) && name === PREFIX + saved.user + '.' + saved.version && valid(saved.pricing)) return { version: saved.version, pricing: saved.pricing };
      } catch {}
    }
    return null;
  }
  function store(user, version, pricing) {
    const name = PREFIX + person(user) + '.' + version;
    remove(keys(PREFIX + person(user) + '.').filter(key => key !== name));
    try { localStorage.setItem(name, JSON.stringify({ user: person(user), version, pricing, savedAt: new Date().toISOString() })); } catch {}
  }
  const clear = () => remove(keys(PREFIX));

  async function load(user, { fetcher = (...args) => window.EGCHubAuth.fetch(...args), timeoutMs = TIMEOUT } = {}) {
    if (!person(user)) return { pricing: null, source: 'none', error: OFFLINE };
    const controller = typeof AbortController === 'function' ? new AbortController() : null, timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let error = OFFLINE;
    try {
      const response = await fetcher('/api/pricing-config?parts=walkthrough', { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
      const body = await response.json().catch(() => ({}));
      // A reply cut off by the timeout is a connection problem; anything else came from the Hub.
      if (!controller?.signal.aborted) error = UNAVAILABLE;
      if (response.ok && body.ok === true && typeof body.version === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(body.version) && valid(body.parts?.walkthrough)) {
        store(user, body.version, body.parts.walkthrough);
        return { pricing: body.parts.walkthrough, source: 'network', version: body.version };
      }
      // A login that may no longer see prices keeps no copy of them.
      if (response.status === 401 || response.status === 403) { remove(keys(PREFIX + person(user) + '.')); return { pricing: null, source: 'none', error: 'This login cannot load walkthrough prices. Ask the office to check your access.' }; }
    } catch (failure) {
      if (failure?.code === 'HUB_AUTH_REQUIRED') { remove(keys(PREFIX + person(user) + '.')); return { pricing: null, source: 'none', error: 'Sign in again to load walkthrough prices.' }; }
    } finally { if (timer) clearTimeout(timer); }
    // Either way the saved copy still prices the walkthrough.
    const saved = cached(user);
    return saved ? { pricing: saved.pricing, source: 'cache', version: saved.version } : { pricing: null, source: 'none', error };
  }

  window.EGCWalkthroughPricing = Object.freeze({ load, cached, clear, valid, OFFLINE, UNAVAILABLE });
  window.addEventListener('egc:signout', clear);
})();
