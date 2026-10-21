/* LANE catalog (owner, 2026-10-19: "make sure the walkthrough has all of the items we sell and offer and it's integrated
   natively into crew hub and walkthrough"). With the quote builder on (EGC_QUOTE_BUILDER_ENABLED: the Hub's
   /api/pricing-config answer, crew/walkthrough-pricing.js quoteBuilder()) the walkthrough's Scope and Finish steps show the
   builder menu's own prices (GET /api/quote-draft?view=builder, the menu the quote is built, sent and signed from), each
   with its Draft or Approved chip, never the legacy walkthrough tables (their per-load rate). Finish picks shelving, totes and
   extra storage from the builder's own products into S.builderGoods: the quote builder opens with them already chosen
   (crew/quote-draft.js options.goods) and writes back what it saves (options.onGoods), so nothing is picked twice. The
   menu is read once per page load and kept in memory only (sign-out drops it); without it the steps say why, and Finish
   keeps the walkthrough's own shelving and tote counts so the need is still recorded. */
(function (root) {
  'use strict';
  if (typeof S === 'undefined') return;
  const TIMEOUT = 15000, PAGE = 12, STEPS = ['shelving', 'storage'];
  // What the estimator is browsing (group, search, how many shown, Browse all) is kept while the steps re-render; a new
  // walkthrough (resetUi, from the page's resetForWalkthrough) and a sign-out start it over.
  const FRESH_UI = Object.freeze({ group: '', search: '', limit: PAGE, browse: false });
  const M = { menu: null, error: '', loading: false, off: false, failed: false, ...FRESH_UI, seq: 0 };
  const resetUi = () => { Object.assign(M, FRESH_UI); };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = cents => Number.isSafeInteger(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) : 'Needs review';
  function h(tag, props, ...children) { const node = document.createElement(tag); for (const [name, value] of Object.entries(props || {})) { if (value == null || value === false) continue; if (name === 'class') node.className = value; else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value); else if (name in node && !name.startsWith('aria-')) node[name] = value; else node.setAttribute(name, String(value)); } for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child))); return node; }
  function builderOn() { try { return root.EGCWalkthroughPricing?.quoteBuilder?.() === true; } catch { return false; } }
  // Scope and Finish show builder prices while the Hub says the builder is on and has not answered that it is off.
  const active = () => builderOn() && !M.off;
  // The menu failed to load (offline, or the Hub did not answer) and has not loaded since: a retry keeps this until it does.
  const unavailable = () => active() && !M.menu && M.failed;
  const services = () => Array.isArray(M.menu?.services) ? M.menu.services : [];
  const products = () => Array.isArray(M.menu?.products) ? M.menu.products : [];
  const sections = () => Array.isArray(M.menu?.sections) ? M.menu.sections : [];
  const chipHtml = item => `<span class="qb-chip${item.approved === true ? ' qb-ok' : ''}" title="${esc(item.reason || '')}">${item.approved === true ? 'Approved' : 'Draft price'}</span>`;
  const chip = item => h('span', { class: 'qb-chip' + (item.approved === true ? ' qb-ok' : ''), title: item.reason || '' }, item.approved === true ? 'Approved' : 'Draft price');
  // An item's builder price and chip, as markup for the page's own templates.
  const tag = (item, prefix = '+') => item ? ` <span class="gp-price">${prefix}${money(item.unitCents)} ${chipHtml(item)}</span>` : '';
  const service = test => services().find(test) || null;
  const special = key => service(item => item.group === 'special' && item.walkthroughKey === key);
  const access = key => service(item => item.group === 'access' && item.walkthroughKey === key);
  const cleaning = key => service(item => item.group === 'cleaning' && !item.garageSize && item.walkthroughKey === key);
  const deepClean = size => service(item => item.group === 'cleaning' && item.garageSize === size);

  // ---- The menu ----
  // Read once the Hub says the builder is on (after /api/pricing-config); a Hub that answers the builder is off (400 or
  // 404) keeps the walkthrough's own labels, any other failure says so with a retry.
  async function load(force = false) {
    if (!builderOn() || M.loading || (M.menu && !force) || !root.EGCHubAuth?.fetch) return;
    const seq = ++M.seq, controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
    M.loading = true; M.error = ''; refresh();
    try {
      let response;
      // No answer (offline, a dropped connection or the time limit): the Hub was not reached.
      try { response = await root.EGCHubAuth.fetch('/api/quote-draft?view=builder', { cache: 'no-store', signal: controller.signal }); }
      catch { throw new Error(navigator.onLine === false ? 'The quote builder prices load when you are connected.' : 'The quote builder prices could not load. Check the connection and retry.'); }
      const data = await response.json().catch(() => null);
      if (seq !== M.seq) return;
      if ([400, 404].includes(response.status)) { M.off = true; return; }
      if (!response.ok || data?.ok !== true || data.enabled !== true || !Array.isArray(data.services) || !Array.isArray(data.products)) throw new Error(data?.error || 'The quote builder prices could not load.');
      Object.assign(M, { menu: data, off: false, failed: false });
    } catch (error) {
      if (seq === M.seq) Object.assign(M, { error: error?.message || 'The quote builder prices could not load.', failed: true });
    } finally { clearTimeout(timer); if (seq === M.seq) { M.loading = false; refresh(); } }
  }
  const ready = () => typeof render === 'function' && typeof walkthroughReady !== 'undefined' && walkthroughReady;
  // The menu arriving (or failing) re-renders only Scope and Finish, the steps that show it: another step is left alone (a
  // field being typed in on Customer, a signature on Review), and the field in focus keeps its focus and caret.
  const refresh = () => {
    if (!ready() || typeof index !== 'undefined' && ![2, 3].includes(index)) return;
    const focused = document.activeElement, id = focused && focused !== document.body && focused.id ? focused.id : '';
    let caret = null; try { caret = id && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null; } catch { caret = null; }
    render();
    const again = id ? document.getElementById(id) : null;
    if (!again || again === document.activeElement) return;
    try { again.focus({ preventScroll: true }); if (caret) again.setSelectionRange(...caret); } catch { /* a field without a caret keeps the focus */ }
  };
  const status = () => M.loading || !M.error ? 'Loading the quote builder prices…' : M.error;
  const statusHtml = () => `<p class="note gp-status" role="status">${esc(status())}${M.error && !M.loading ? ' <button type="button" class="small-btn gp-retry" onclick="EGCGameplanCatalog.load(true)">Retry builder prices</button>' : ''}</p>`;

  // ---- Scope and Finish labels ----
  // A Scope check label with the builder's price: special-handling items, access charges and the pest-waste cleanup.
  function label(kind, key) {
    const item = kind === 'special' ? special(key) : kind === 'access' ? access(key) : kind === 'hazard' && key === 'Pest waste' ? cleaning('Pest waste') : null;
    return esc(key) + tag(item);
  }
  // The truck loads the builder quotes: full trucks plus at most one quarter, half or three-quarter load.
  function loadsNote() {
    if (!M.menu) return statusHtml();
    const loads = services().filter(item => item.group === 'junk').sort((a, b) => b.junkFraction - a.junkFraction);
    return `<div class="note gp-loads" id="builder-loads"><strong>Quote builder truck loads</strong><ul>${loads.map(item => `<li><span>${esc(item.name)}</span>${tag(item, '')}</li>`).join('')}</ul>Enter quarters (0.75, 1.25): the builder quotes full trucks plus one partial load.</div>`;
  }
  // A Finish card's price: the deep clean for the walkthrough's garage size, the one-car pressure wash, mouse trapping.
  function finishTag(key, size) {
    if (!M.menu) return '';
    const item = key === 'deep_clean' ? deepClean(size) : cleaning(key);
    return item ? tag(item).trim() : '';
  }

  // ---- Finish: shelving, totes and storage from the builder's products ----
  const rows = list => (Array.isArray(list) ? list : []).filter(row => row && typeof row.id === 'string' && Number.isInteger(row.quantity) && row.quantity > 0);
  // What the walkthrough holds as chosen: its own picks, else the goods of the quote already built (a quote built before
  // Finish had picks), else none.
  function picks() {
    const own = S.builderGoods && typeof S.builderGoods === 'object' ? S.builderGoods : null, from = own || S.builderQuote?.compositePricing || {};
    return { shelving: rows(from.shelving), storage: rows(from.storage) };
  }
  // A pick as the walkthrough keeps it: the product and quantity the builder reads, and the group and install time the
  // bring list and the job time estimate read (crew/gameplan.html buildJobInstructions and estimatedJobMinutes).
  const entry = (item, quantity) => ({ id: item.id, quantity, group: item.group, name: item.name, ...(Number.isFinite(item.installPersonMinutes) ? { installPersonMinutes: item.installPersonMinutes } : {}) });
  const enrich = row => { const item = products().find(product => product.id === row.id); return item ? entry(item, row.quantity) : { id: row.id, quantity: row.quantity }; };
  const goodsKey = value => STEPS.map(step => rows(value?.[step]).map(row => `${row.id}:${row.quantity}`).sort().join(',')).join('|');
  function setPick(item, quantity) {
    const now = picks(), step = item.section;
    if (!STEPS.includes(step)) return;
    const list = now[step].map(enrich), at = list.findIndex(row => row.id === item.id);
    if (quantity > 0) { if (at >= 0) list[at] = entry(item, quantity); else list.push(entry(item, quantity)); } else if (at >= 0) list.splice(at, 1);
    if (typeof invalidateAcceptance === 'function') invalidateAcceptance();
    if (!S.priceManuallySet) S.lockedPrice = '';
    S.builderGoods = { ...Object.fromEntries(STEPS.map(name => [name, name === step ? list : now[name].map(enrich)])), by: 'finish' };
    if (typeof save === 'function') save();
    mountGoods();
    // The parking fit check below reads the picks (shelving, overhead racks): it shows them now, not after the quote is saved.
    if (typeof mountCustomerVehicles === 'function') mountCustomerVehicles();
  }
  // The walkthrough's picks for the builder to open with, only when Finish changed them after the builder last wrote them
  // back (by: 'finish'); otherwise the builder keeps its own selection (this device's, else the saved quote's).
  function selection() {
    const own = S.builderGoods;
    return own && typeof own === 'object' && own.by === 'finish' ? { shelving: rows(own.shelving).map(({ id, quantity }) => ({ id, quantity })), storage: rows(own.storage).map(({ id, quantity }) => ({ id, quantity })) } : null;
  }
  // The shelving and storage of a quote the builder saved: the walkthrough holds the same picks. Only a save writes them
  // back, so looking around in the builder without saving leaves the walkthrough, and the homeowner's signature, as they were.
  function fromBuilder(goods) {
    const next = { shelving: rows(goods?.shelving), storage: rows(goods?.storage) }, changed = goodsKey(next) !== goodsKey(picks());
    S.builderGoods = { ...next, by: 'builder' };
    if (changed && typeof invalidateAcceptance === 'function') invalidateAcceptance();
    if (typeof save === 'function') save();
    if (changed && ready()) render();
  }
  function qtyControl(name, value, set) {
    return h('div', { class: 'qb-qty', role: 'group', 'aria-label': `${name} quantity` },
      h('button', { type: 'button', 'aria-label': `One fewer: ${name}`, onclick: () => set(value - 1) }, '−'),
      h('output', { 'aria-live': 'polite' }, String(value)),
      h('button', { type: 'button', 'aria-label': `One more: ${name}`, disabled: value >= 999, onclick: () => set(value + 1) }, '+'));
  }
  function productRow(item, quantity) {
    const details = root.EGCQuoteDraft?.builder?.productDetails ? root.EGCQuoteDraft.builder.productDetails(item) : [];
    return h('li', { class: 'qb-product' + (quantity ? ' on' : '') },
      item.photoUrl ? h('img', { src: item.photoUrl, alt: '', loading: 'lazy', width: 56, height: 56, referrerpolicy: 'no-referrer' }) : h('span', { class: 'qb-thumb', 'aria-hidden': 'true' }),
      h('div', { class: 'qb-info' }, h('strong', {}, item.name),
        h('small', {}, `${item.unitsPerPack > 1 ? `Pack of ${item.unitsPerPack} · ` : ''}${money(item.unitCents)} per pack `, chip(item)),
        ...details),
      quantity ? qtyControl(item.name, quantity, n => setPick(item, n)) : h('button', { type: 'button', class: 'qd-secondary qb-add', 'aria-label': `Add ${item.name}`, onclick: () => setPick(item, 1) }, 'Add'));
  }
  function goodsPanel() {
    const head = [h('h2', {}, 'Shelving, totes and storage'), h('p', {}, 'Chosen here, they open in the quote builder already in the quote: nothing is picked twice. Prices are per purchase pack; installing them is billed through the quote’s Labor line.')];
    // Without the menu the walkthrough's own shelving and tote cards (above) record the need; the builder shows those
    // counts as a walkthrough note, and once the menu loads this panel offers the products and clears the note.
    if (!M.menu) return [...head, h('p', { class: 'note gp-status', role: 'status' }, status(), M.error && !M.loading ? h('button', { type: 'button', class: 'small-btn gp-retry', onclick: () => load(true) }, 'Retry builder prices') : null),
      M.failed ? h('p', { class: 'qb-help gp-legacy-help' }, 'Until the prices load, record shelving and totes with Add shelving and Add labeled totes above. Choose the products here once they load.') : null].filter(Boolean);
    const finish = Array.isArray(S.finish) ? S.finish : [], legacy = [finish.includes('shelving') && Number(S.shelfQty) > 0 ? `${Number(S.shelfQty)} ${String(S.shelfType || 'metal').replace(/[^a-z]/gi, '')} shelving unit${Number(S.shelfQty) === 1 ? '' : 's'}` : '', finish.includes('totes') && Number(S.toteQty) > 0 ? `${Number(S.toteQty)} labeled tote${Number(S.toteQty) === 1 ? '' : 's'}` : ''].filter(Boolean);
    // A walkthrough begun before Finish had the builder's products keeps its earlier counts until the estimator clears them.
    const clear = () => { if (typeof invalidateAcceptance === 'function') invalidateAcceptance(); S.finish = finish.filter(key => !['shelving', 'totes'].includes(key)); S.shelfQty = 0; S.toteQty = 0; if (!S.priceManuallySet) S.lockedPrice = ''; if (typeof save === 'function') save(); refresh(); };
    const earlier = legacy.length ? h('div', { class: 'note gp-legacy', role: 'status' }, `Recorded earlier on this walkthrough: ${legacy.join('; ')}. Choose the products below, then clear this note.`, ' ', h('button', { type: 'button', class: 'small-btn', onclick: clear }, 'Clear note')) : null;
    const now = picks(), all = products().filter(item => STEPS.includes(item.section)), chosenIds = new Set([...now.shelving, ...now.storage].map(row => row.id));
    const qty = id => [...now.shelving, ...now.storage].find(row => row.id === id)?.quantity || 0;
    const chosen = all.filter(item => chosenIds.has(item.id));
    const groups = sections().filter(entry => STEPS.includes(entry.id)).flatMap(entry => Array.isArray(entry.groups) ? entry.groups : []);
    const results = h('ul', { class: 'qb-products', id: 'finish-goods-results' }), more = h('div', {});
    const fill = () => {
      const words = String(M.search || '').toLowerCase().split(/\s+/).filter(Boolean);
      // Products show once a search or a group narrows them (or Browse all): an unfiltered list of photos made Finish
      // several phone screens long, with the vehicles to park far below it.
      if (!words.length && !M.group && !M.browse) {
        const offered = all.filter(item => !chosenIds.has(item.id)).length;
        results.replaceChildren();
        more.replaceChildren(...(offered ? [h('p', { class: 'qb-help' }, 'Search or choose a group to see the products.'), h('button', { type: 'button', class: 'qd-secondary qb-more', onclick: () => { M.browse = true; M.limit = PAGE; fill(); } }, `Browse all ${offered} products`)] : []));
        return;
      }
      const matches = all.filter(item => !chosenIds.has(item.id) && (!M.group || item.group === M.group) && words.every(word => item.name.toLowerCase().includes(word)));
      results.replaceChildren(...matches.slice(0, M.limit).map(item => productRow(item, 0)));
      more.replaceChildren(...(matches.length > M.limit ? [h('button', { type: 'button', class: 'qd-secondary qb-more', onclick: () => { M.limit += PAGE; fill(); } }, `Show more (${matches.length - M.limit} left)`)] : matches.length ? [] : [h('p', { class: 'qb-help' }, 'No products match. Try another search or group.')]));
    };
    fill();
    const filters = h('div', { class: 'qb-filters' },
      h('select', { class: 'qd-input', 'aria-label': 'Product group', onchange: event => { M.group = event.target.value; M.browse = !M.group; M.limit = PAGE; fill(); } }, h('option', { value: '' }, 'All shelving and storage'), groups.map(group => h('option', { value: group.id, selected: M.group === group.id }, group.label))),
      h('input', { class: 'qd-input', type: 'search', value: M.search || '', placeholder: 'Search shelving, totes, hooks, racks…', 'aria-label': 'Search shelving and storage products', oninput: event => { M.search = event.target.value; M.limit = PAGE; fill(); } }));
    return [...head, earlier,
      chosen.length ? h('div', { class: 'gp-chosen' }, h('h3', {}, `In this quote (${chosen.length})`), h('ul', { class: 'qb-products' }, chosen.map(item => productRow(item, qty(item.id))))) : h('p', { class: 'qb-help' }, 'No shelving, totes or storage yet. Add products below, or continue with none.'),
      filters, results, more].filter(Boolean);
  }
  function mountGoods() {
    const host = document.getElementById('finish-goods');
    if (host) host.replaceChildren(...goodsPanel());
  }

  root.addEventListener('egc:signout', () => { M.seq++; Object.assign(M, { menu: null, error: '', loading: false, off: false, failed: false, ...FRESH_UI }); });
  root.EGCGameplanCatalog = Object.freeze({ load, active, unavailable, label, loadsNote, finishTag, statusHtml, mountGoods, picks, selection, fromBuilder, resetUi, menu: () => M.menu });
})(window);
