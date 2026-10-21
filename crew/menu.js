(function () {
  'use strict';
  // LANE catalog (owner, 2026-10-19: "make sure the walkthrough has all of the items we sell and offer and it's integrated
  // natively into crew hub and walkthrough"). "What we sell", read only, from GET /api/quote-draft?view=menu: every service
  // and product on the quote builder's menu, by step and group, with its size. The server decides who sees money: a quote
  // author (owner, manager, sales/walkthrough employee) gets EGC's customer price with its Draft or Approved chip and the
  // labor rate; a crew member gets names and sizes only. Never a cost, a retail price or a retailer link. Nothing here is
  // stored on the phone.
  const API = '/api/quote-draft?view=menu', TIMEOUT = 30000, OFFLINE = 'You’re offline. What we sell loads when you reconnect.';
  const S = { data: null, loading: false, error: '', signedOut: false, disabled: false, search: '', section: 'all', seq: 0 };
  const main = document.getElementById('menu-main');

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false).map(child => typeof child === 'string' ? document.createTextNode(child) : child));
    return node;
  }
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const UNIT = { load: 'per load', item: 'each', bundle: 'per bundle', job: 'per job' };
  const SIZE = { 1: 'One-car garage', 2: 'Two-car garage', 3: 'Three-car garage', other: 'Larger garage' };
  const plainRow = row => Boolean(row) && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.section === 'string' && typeof row.group === 'string';
  const valid = data => Boolean(data) && data.ok === true && typeof data.prices === 'boolean' && Array.isArray(data.sections) && Array.isArray(data.services) && Array.isArray(data.products) && [...data.services, ...data.products].every(plainRow);

  async function load() {
    if (!main) return;
    const seq = ++S.seq;
    S.loading = true; S.error = ''; render();
    if (navigator.onLine === false) { S.loading = false; S.error = OFFLINE; render(); return; }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
    let response = null, data = null;
    try { response = await fetch(API, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); data = await response.json().catch(() => null); }
    catch { response = null; }
    finally { clearTimeout(timer); }
    if (seq !== S.seq) return;
    S.loading = false;
    if (response && response.ok && valid(data)) Object.assign(S, { data, signedOut: false, disabled: false });
    else {
      S.signedOut = response?.status === 401; S.disabled = data?.code === 'quote_draft_menu_disabled';
      S.error = !response ? 'What we sell did not load. Check your connection, then try again.' : data?.error || 'What we sell is unavailable right now. Try again shortly.';
      if (S.signedOut || S.disabled) S.data = null;
    }
    render();
  }

  // A row's size: a service's garage size or truck fraction and unit; a product's pack and size.
  function detail(item, service) {
    if (service) return [item.garageSize ? SIZE[item.garageSize] || '' : '', Number.isFinite(item.junkFraction) && item.junkFraction < 1 ? `${item.junkFraction * 100}% of a truck` : ''].filter(Boolean).join(' · ');
    return [item.unitsPerPack > 1 ? `Pack of ${item.unitsPerPack}` : '', item.size || ''].filter(Boolean).join(' · ');
  }
  function row(item, service, prices) {
    const price = prices && Number.isSafeInteger(item.unitCents) ? h('span', { class: 'price' }, h('b', {}, money(item.unitCents)), h('small', {}, service ? UNIT[item.unit] || '' : 'per pack'),
      h('em', { class: `tag${item.approved ? ' ok' : ''}` }, item.approved ? 'Approved' : 'Draft price')) : null;
    const more = detail(item, service);
    return h('li', { class: 'item', 'data-item': item.id }, h('span', {}, h('strong', {}, item.name), more ? h('small', {}, more) : null), price);
  }
  function list(data) {
    const words = S.search.toLowerCase().split(/\s+/).filter(Boolean), match = item => words.every(word => item.name.toLowerCase().includes(word));
    const blocks = [];
    for (const section of data.sections) {
      if (S.section !== 'all' && S.section !== section.id) continue;
      const groups = (Array.isArray(section.groups) ? section.groups : []).map(group => {
        const services = data.services.filter(item => item.section === section.id && item.group === group.id && match(item));
        const products = data.products.filter(item => item.section === section.id && item.group === group.id && match(item));
        return services.length || products.length ? h('div', { class: 'group', 'data-group': group.id }, h('h3', {}, group.label), h('ul', { class: 'items' }, services.map(item => row(item, true, data.prices)), products.map(item => row(item, false, data.prices)))) : null;
      }).filter(Boolean);
      if (groups.length) blocks.push(h('section', { class: 'section', 'data-section': section.id }, h('h2', {}, section.label), groups));
    }
    return blocks.length ? blocks : [h('p', { class: 'empty' }, 'Nothing matches. Try another search or step.')];
  }
  function controls(data) {
    const search = h('input', { class: 'search', type: 'search', value: S.search, placeholder: 'Search services and products', 'aria-label': 'Search what we sell', oninput: event => { S.search = event.target.value; const host = document.getElementById('menu-list'); if (host) host.replaceChildren(...list(data)); } });
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Step' }, [['all', 'Everything'], ...data.sections.map(section => [section.id, section.label])].map(([value, label]) =>
      h('button', { type: 'button', 'data-section': value, 'aria-pressed': String(S.section === value), onclick: () => { S.section = value; render(); } }, label)));
    return h('div', { class: 'controls' }, search, chips);
  }

  function render() {
    if (!main) return;
    const data = S.data, nodes = [h('div', { class: 'eyebrow' }, 'Crew tools'), h('h1', {}, 'What we sell')];
    if (S.signedOut) {
      nodes.push(h('section', { class: 'card' }, h('h2', {}, 'Sign in first'), h('p', {}, 'Sign in to the crew app, then come back to what we sell.'), h('a', { class: 'btn primary', href: '/crew/?next=%2Fcrew%2Fmenu' }, 'Sign in')));
      main.replaceChildren(...nodes); return;
    }
    if (S.disabled) {
      nodes.push(h('section', { class: 'card', role: 'status' }, h('h2', {}, 'Not available yet'), h('p', {}, S.error), h('a', { class: 'btn primary', href: '/crew/' }, 'Back to crew home')));
      main.replaceChildren(...nodes); return;
    }
    nodes.push(h('p', { class: 'sub' }, !data ? 'Every service and product on EGC’s quote menu.' : data.prices
      ? 'EGC’s customer prices from the owner’s pricing menu. A draft price is not approved yet: a quote that uses one waits for the owner before it is sent.'
      : 'Every service and product we offer, with sizes. Prices come from your estimator or the office.'));
    if (S.error) nodes.push(h('div', { class: 'notice', role: 'alert' }, h('p', {}, S.error), h('button', { type: 'button', class: 'btn', onclick: load }, 'Try again')));
    if (S.loading && !data) nodes.push(h('p', { class: 'load-note', role: 'status' }, 'Loading what we sell…'));
    if (data) {
      if (data.prices && Number.isSafeInteger(data.labor?.rateCents)) nodes.push(h('section', { class: 'card', 'data-labor': '' }, h('h2', {}, `Labor · ${money(data.labor.rateCents)} per man-hour`),
        h('p', {}, 'Every quote with garage work has one Labor line: the estimated man-hours at this rate. Installing shelving and storage is billed through it. A junk-only quote (truck loads, special items and access) has none.'), h('em', { class: 'tag ok' }, 'Approved')));
      nodes.push(controls(data), h('div', { id: 'menu-list' }, list(data)));
    }
    main.replaceChildren(...nodes);
  }

  addEventListener('online', () => { if (!S.data || S.error) load(); });
  addEventListener('offline', () => { if (!S.loading && !S.data) { S.error = OFFLINE; render(); } });
  window.EGCCrewMenu = { load, state: S };
  load();
})();
