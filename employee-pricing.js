/* Internal pricing for the Employee Hub, loaded from /api/pricing-config for the
   signed-in role and kept in memory only: the phone-quote table for staff who quote,
   and the owner's labor baseline, wages and targets. Nothing is cached on the device;
   sign-out drops it. A missing or malformed response leaves the part unavailable, and
   screens show "unknown" instead of a built-in number. */
(function () {
  'use strict';
  const state = { parts: {}, pending: {}, generation: 0 };
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
  const text = (value, max = 120) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const valid = {
    phone: p => plain(p) && ['baseFee', 'perCubicYard', 'perFloor', 'freeMiles', 'perMile', 'highSpread', 'roundTo'].every(key => amount(p[key])) && p.roundTo > 0 && p.highSpread >= 1 &&
      Array.isArray(p.specials) && p.specials.length <= 40 && p.specials.every(item => plain(item) && /^[a-z0-9_-]{1,40}$/.test(item.id) && text(item.name) && amount(item.price)) && new Set(p.specials.map(item => item.id)).size === p.specials.length,
    owner: p => plain(p) && amount(p.laborCostPerCrewHour) && plain(p.wages) && amount(p.wages.crew) && amount(p.wages.lead) && plain(p.truckRentalPerJob) && amount(p.truckRentalPerJob.low) && amount(p.truckRentalPerJob.high) &&
      plain(p.targets) && amount(p.targets.averageTicket) && amount(p.targets.walkthroughSetRatePct) && amount(p.targets.qualifiedCloseRatePct),
  };
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const request = (url, init) => typeof window.hubFetch === 'function' ? window.hubFetch(url, init) : fetch(url, { ...init, credentials: 'same-origin' });

  function load(part) {
    if (!Object.hasOwn(valid, part)) return Promise.resolve(null);
    if (state.parts[part]) return Promise.resolve(state.parts[part]);
    if (state.pending[part]) return state.pending[part];
    const generation = state.generation;
    const pending = (async () => {
      try {
        const response = await request('/api/pricing-config?parts=' + part, { cache: 'no-store' }), body = await response.json().catch(() => ({}));
        if (generation !== state.generation || !response.ok || body.ok !== true || typeof body.version !== 'string' || !valid[part](body.parts?.[part])) return null;
        state.parts[part] = freeze(body.parts[part]);
        return state.parts[part];
      } catch { return null; }
      finally { if (generation === state.generation) delete state.pending[part]; }
    })();
    state.pending[part] = pending;
    return pending;
  }
  function clear() { state.generation++; state.parts = {}; state.pending = {}; }

  window.EGCPricingConfig = Object.freeze({ load, clear, phone: () => state.parts.phone || null, owner: () => state.parts.owner || null });
  window.addEventListener('egc:signout', clear);
})();
