(function (root) {
  'use strict';
  // P2-07: "Send options for review" from the walkthrough. The quote is saved
  // as an unsigned Hub draft (/api/quote-draft) and nothing reaches the customer
  // until the person previews and confirms the send. Every request is frozen in
  // sessionStorage before it is sent and a lost response retries it unchanged.
  const DAY = 86400000;
  function h(tag, props, ...children) { const node = document.createElement(tag); for (const [name, value] of Object.entries(props || {})) { if (value == null || value === false) continue; if (name === 'class') node.className = value; else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value); else if (name in node && !name.startsWith('aria-')) node[name] = value; else node.setAttribute(name, String(value)); } for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child))); return node; }
  const money = cents => Number.isSafeInteger(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) : 'Needs review';
  const dayText = date => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); } catch { return date; } };
  const denverDate = (ms, days = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms + days * DAY));
  const KEEP = new Set([401, 403, 408, 429]);
  // Only a definite refusal discards a frozen request: a 4xx other than sign-in,
  // permission, timeout or rate limit, or a confirmation the server refused
  // (mismatched, invalid, expired or used), which can never succeed unchanged.
  // A lost response, a 5xx and a 2xx whose body cannot be read are unknown
  // outcomes: the server may have committed, so the request is kept unchanged.
  const refused = error => /^confirm_token_/.test(error?.code || '') || error?.status >= 400 && error.status < 500 && !KEEP.has(error.status);
  const conflict = error => /_revision_conflict$/.test(error.code || '');
  // A refused save names each owner dispatch rule (or overlapping work) that
  // stopped it (details.conflicts), as the Hub's shift pickup does.
  const refusal = (data, fallback) => [data?.error || fallback, ...[...new Set((Array.isArray(data?.details?.conflicts) ? data.details.conflicts : []).filter(row => row && row.code !== 'legacy_blocked_day' && typeof row.message === 'string' && row.message.trim()).map(row => row.message.trim()))].slice(0, 3)].join(' ');
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
  const sameDraft = (a, b) => canonical(JSON.parse(JSON.stringify(a ?? null))) === canonical(JSON.parse(JSON.stringify(b ?? null)));
  // The customer details a /api/customer-resolve request carries. Its requestId is
  // reused only for exactly these details (the server fingerprints the body).
  const resolveCustomer = client => ({ name: client.name, phone: client.phone, email: client.email, address: client.address, highlevelContactId: client.highlevel_contact_id });
  const resolveIdentity = draft => canonical(resolveCustomer(draft?.client || {}));

  // The customer-facing quote from the walkthrough's itemized lines.
  function scopeText(lines) {
    const names = lines.filter(line => line.selected !== false && line.id !== 'adjustment').map(line => line.quantity !== 1 ? `${line.quantity} × ${line.name}` : line.name);
    const adjustment = lines.find(line => line.id === 'adjustment');
    return `Included: ${names.join('; ')}.${adjustment?.description ? ` ${adjustment.name}: ${adjustment.description}.` : ''}`.slice(0, 1600);
  }
  function draftFromWalkthrough(p, validUntil) {
    const lines = (Array.isArray(p?.quote?.line_items) ? p.quote.line_items : []).map(line => ({ ...line }));
    const crew = Number(p?.logistics?.crew_size || 0), minutes = Number(p?.quote?.estimated_duration_min || 0);
    return {
      client: { name: String(p?.client?.name || ''), phone: String(p?.client?.phone || ''), email: String(p?.client?.email || ''), address: String(p?.client?.address || ''), highlevel_contact_id: String(p?.client?.highlevel_contact_id || '') },
      title: String(p?.quote?.title || 'EGC Garage Service').slice(0, 200), scope: scopeText(lines), line_items: lines, valid_until: validUntil,
      catalog_version: String(p?.quote?.catalog_version || ''), crew_size: Number.isInteger(crew) && crew >= 1 && crew <= 20 ? crew : null, estimated_duration_min: Number.isInteger(minutes) && minutes >= 15 ? minutes : null,
      walkthrough_capture: captureFromWalkthrough(p),
    };
  }
  function captureFromWalkthrough(p) {
    const capture = {};
    // Pick explicit operational fields only. Let the server reject malformed
    // values rather than stringify objects, silently drop data or infer consent.
    for (const [key, value] of Object.entries({
      customerGoal: p?.discovery?.success, whyNow: p?.discovery?.why_now,
      sortMethod: p?.scope?.sort_method, keepItems: p?.scope?.keep_items,
      removeItems: p?.scope?.remove_items, exclusions: p?.scope?.exclusions,
      hazards: p?.scope?.hazards, access: p?.scope?.access,
      specialItems: p?.scope?.special_items, finish: p?.scope?.finish,
      accessNotes: p?.logistics?.notes,
      truckPlacement: p?.logistics?.truck_placement ?? p?.scope?.truck_placement,
      crewBrief: p?.crew_brief,
      // Only a walkthrough with vehicles to park has one (crew/gameplan-vehicles.js).
      parkingPlan: p?.scope?.parking_plan,
    })) if (value !== undefined) capture[key] = Array.isArray(value) ? [...value] : value;
    // The Finish step's shelving and tote counts, whole numbers only: with finish, the server reads them to tell whether
    // the walkthrough records garage work a junk-only quote does not price (D-JUNK). An unreadable count is left out,
    // which the server counts as work.
    for (const [key, value] of Object.entries({ shelfQty: p?.scope?.finish_details?.shelf_qty, toteQty: p?.scope?.finish_details?.tote_qty })) if (Number.isInteger(value) && value >= 0 && value <= 999) capture[key] = value;
    return capture;
  }
  function missing(draft) {
    const miss = [], lines = draft.line_items;
    if (!draft.client.name.trim()) miss.push('customer name');
    if (!draft.client.address.trim()) miss.push('service address');
    if (!draft.client.phone.trim() && !draft.client.email.trim()) miss.push('a phone number or email');
    if (!lines.length || lines.reduce((sum, line) => sum + (line.selected === false ? 0 : Number(line.totalCents) || 0), 0) <= 0) miss.push('a priced quote');
    const adjustment = lines.find(line => line.id === 'adjustment');
    if (adjustment && String(adjustment.description || '').trim().length < 3) miss.push('the customer-facing reason for the changed rate');
    return miss;
  }

  // ---- Guided quote builder (EGC_QUOTE_BUILDER_ENABLED) ----
  // The estimator builds the quote in a fixed order: removal / cleanout, then shelving, then extra storage, then
  // reviews the server-priced quote. Prices come from GET /api/quote-draft?view=builder; this file holds none.
  // The browser keeps only the selection {removal: {[id]: qty}, shelving: [{id, quantity}], storage: [...]};
  // the server re-prices it at every step and again on save.
  const BUILDER_STEPS = ['removal', 'shelving', 'storage'];
  const BUILDER_VIEWS = [...BUILDER_STEPS, 'quote'];
  // labor.manHours: the man-hours for the Labor line (D12), or null to use the server's estimate of the selection;
  // labor.adjusted: the estimator set them by hand (Adjust). Man-hours kept from an earlier estimate (a saved quote) are
  // a number that is not adjusted: they stay until the estimator changes the scope or resets to the estimate.
  const emptySelection = () => ({ removal: {}, shelving: [], storage: [], labor: { manHours: null, adjusted: false } });
  const clampQty = (value, max) => { const n = Math.floor(Number(value)); return Number.isFinite(n) && n >= 1 ? Math.min(max, n) : 0; };
  // ---- Labor (D12): man-hours x the owner's labor rate, on every builder quote with garage work ----
  // The rate and the man-hour limits come from the builder menu (menu.labor); the server prices the line itself.
  // D-JUNK ("$750 per truck covers the crew's time"): a junk-only quote (truck loads, special-handling items and access
  // charges only: menu.labor.haulingGroups) has no Labor line, and the estimate never counts loading, hauling or disposal.
  // D-LABOR-TEXT: the customer sees the line as one amount, "Labor"; the man-hours here are the estimator's, never theirs.
  const LABOR_LIMITS = { min: 0.5, max: 200, step: 0.25 }, LABOR_VERSION = 2, HAULING_GROUPS = ['junk', 'special', 'access'];
  // Send refusals the estimator fixes by editing and saving the quote again (composite-quote.js LABOR_ID and
  // INSTALLATION_ID, and a junk-only quote on a walkthrough that records garage work): never a wait for the owner's
  // approval alone.
  const JUNK_GARAGE_WORK = 'junk-garage-work', ESTIMATOR_FIXES = new Set(['labor', 'goods-installation', JUNK_GARAGE_WORK]);
  const laborLimits = menu => ({ min: Number(menu?.labor?.minManHours) || LABOR_LIMITS.min, max: Number(menu?.labor?.maxManHours) || LABOR_LIMITS.max });
  const validManHours = (value, menu) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value * 4 - Math.round(value * 4)) < 1e-9 && value >= laborLimits(menu).min && value <= laborLimits(menu).max;
  const hoursText = hours => `${Number(Number(hours).toFixed(2))} man-hour${hours === 1 ? '' : 's'}`;
  const clockHours = minutes => `${Number((minutes / 60).toFixed(2))} hour${minutes === 60 ? '' : 's'}`;
  const laborCents = (hours, rate) => Math.round(Math.round(hours * 4) * rate / 4);
  const haulingGroups = menu => Array.isArray(menu?.labor?.haulingGroups) ? menu.labor.haulingGroups : HAULING_GROUPS;
  // A junk-only selection (composite-quote.js junkOnly): at least one truck load, and the rest special items or access
  // (priced on top of a truck on the job: alone, they keep the Labor line).
  function junkOnly(menu, sel) {
    const services = new Map((menu?.services || []).map(item => [item.id, item])), picked = Object.entries(sel?.removal || {}).filter(([, qty]) => qty > 0);
    return picked.some(([id]) => services.get(id)?.group === 'junk') && !(sel.shelving || []).length && !(sel.storage || []).length && picked.every(([id]) => haulingGroups(menu).includes(services.get(id)?.group));
  }
  // The same test on saved breakdown lines (a saved quote's), by their step and group.
  const junkOnlyLines = (menu, lines) => Array.isArray(lines) && lines.some(line => line && line.group === 'junk') && lines.every(line => line && line.section === 'removal' && haulingGroups(menu).includes(line.group));
  // A saved Labor line priced before the owner's Labor decisions of 2026-10-18 (no version: its estimate counted the
  // truck loads) whose man-hours the estimator did not set by hand: reopened, it follows the new estimate.
  const staleLabor = (menu, breakdown) => Boolean(breakdown?.labor && typeof breakdown.labor === 'object' && breakdown.labor.version !== (Number(menu?.labor?.version) || LABOR_VERSION) && breakdown.labor.adjusted !== true);
  // D-JUNK: the garage work a walkthrough records beyond junk removal (walkthrough-handoff.js walkthroughGarageWork): crew
  // sorting and the reset of what stays ("Customer sorts with crew", "Crew stages keep / donate / haul zones"), the
  // cleaning add-ons, shelving, totes and pest-waste cleanup. A junk-only quote prices none of it, so the homeowner signs
  // one only on a walkthrough that records none; the builder says so while the estimator builds it.
  function walkthroughGarageWork(p) {
    const scope = p?.scope || {}, finish = Array.isArray(scope.finish) ? scope.finish : [], details = scope.finish_details || {};
    const count = (qty, label) => Number.isInteger(qty) && qty > 0 ? `${qty} ${label}${qty === 1 ? '' : 's'}` : '';
    return [{ customer: 'sorting with the customer and resetting what stays', zones: 'sorting into keep / donate / haul zones and resetting what stays' }[scope.sort_method] || '', finish.includes('deep_clean') ? 'a deep clean' : '', finish.includes('pressure_wash') ? 'a pressure wash' : '',
      finish.includes('mouse_trapping') ? 'mouse trapping' : '', finish.includes('shelving') ? count(details.shelf_qty, 'shelving unit') : '', finish.includes('totes') ? count(details.tote_qty, 'storage tote') : '', Array.isArray(scope.hazards) && scope.hazards.includes('Pest waste') ? 'pest-waste cleanup' : ''].filter(Boolean);
  }
  // A product's fit notes (the menu's fitWarnings) without its sourcing remarks about the retailer's price, cost, discounts
  // or markup, cut at a sentence end within 600 characters.
  const fitText = text => {
    let out = '';
    for (const part of String(text || '').split(/(?<=\.)\s+(?=[A-Z0-9])/).map(part => part.trim()).filter(part => part && !/pric|\$|cost|retail|discount|invoice|markup/i.test(part))) {
      const next = out ? `${out} ${part}` : part;
      if (next.length > 600) return out || `${part.slice(0, 599)}\u2026`;
      out = next;
    }
    return out;
  };
  // A product row's details: its size (the menu's size, composite-quote.js productSize) in the row, then its fit notes in
  // a closed disclosure. Never the retailer's product page or its retail price beside EGC's.
  const productDetails = item => { const fit = fitText(item?.fitWarnings); return [item?.size ? h('p', { class: 'qb-size' }, item.size) : null, fit ? h('details', { class: 'qb-fit' }, h('summary', {}, 'Fit notes'), h('p', {}, fit)) : null].filter(Boolean); };
  const garageWorkNote = work => work.length ? h('p', { class: 'qd-notice qb-garage-work', role: 'status' }, `The walkthrough records garage work this junk-only quote does not price: ${work.join(', ')}. The homeowner cannot sign it, and it cannot be sent, on that walkthrough. Add the work here (a garage cleaning base for sorting and reset, cleaning, shelving or storage), or, if they want junk removal only, change the walkthrough (Everything goes or Customer labels before arrival; no finish options).`) : null;
  // The walkthrough's garage fullness ("How full is it?"): the one input of the server's labor time estimate that the
  // builder selection does not hold. The crew size and the scheduled minutes are not inputs: the man-hours of the work
  // are the same for any crew.
  const FULLNESS = ['light', 'medium', 'full', 'packed'];
  const fullnessOf = p => { const value = String(p?.scope?.fullness || '').trim().toLowerCase(); return FULLNESS.includes(value) ? value : null; };
  // The walkthrough's garage size (Photos: 1-car, 2-car, 3-car or larger) as the menu's garageSize, or null. Without a
  // garage cleaning base (a quote with truck loads) it sizes the deep clean and allows the one-car pressure wash; the
  // server checks the same (composite-quote.js checkRemoval) from the size the selection names.
  const GARAGE_SIZES = ['1', '2', '3', 'other'];
  const garageOf = p => { const value = String(p?.scope?.garages ?? '').trim().toLowerCase(); return GARAGE_SIZES.includes(value) ? value : null; };
  // A selection without a garage cleaning base (a quote with truck loads) sizes its cleaning add-ons by the walkthrough's
  // garage, as the server checks them: a deep clean sized for another garage becomes this one's, and a pressure wash stays
  // with a one-car garage only. A selection with a base, or a walkthrough without a known size, is left as it is. True
  // when it changed the selection (the walkthrough's garage size changed after the quote was built).
  function fitGarage(menu, sel, size) {
    const services = Array.isArray(menu?.services) ? menu.services : [], on = item => sel.removal[item.id] > 0;
    if (!GARAGE_SIZES.includes(size) || services.some(item => item.group === 'cleaning-base' && on(item))) return false;
    const deep = services.filter(item => item.group === 'cleaning' && item.garageSize), sized = deep.find(item => item.garageSize === size);
    const wash = services.find(item => item.group === 'cleaning' && !item.garageSize && item.walkthroughKey === 'pressure_wash');
    let changed = false;
    if (deep.some(item => on(item) && item.garageSize !== size)) { for (const item of deep) delete sel.removal[item.id]; if (sized) sel.removal[sized.id] = 1; changed = true; }
    if (wash && on(wash) && size !== '1') { delete sel.removal[wash.id]; changed = true; }
    return changed;
  }
  // The server's estimate (composite-quote.js laborEstimate) from the menu's time model (menu.labor.time, person-minutes),
  // for the running total shown while choosing; the server's preview is authoritative. {manHours, personMinutes,
  // installNotEstimated: [names]} or null without a time model. Set-up and sweep-out, the sorting of a garage with a
  // cleaning base (its fullness), the cleaning add-ons and the install time count; truck loads, special-handling items
  // and access charges never do (their own prices pay for loading, hauling and disposal).
  function estimateLabor(menu, sel, fullness = null) {
    const t = menu?.labor?.time;
    if (!t || typeof t !== 'object' || !sel) return null;
    const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const services = new Map((menu.services || []).map(item => [item.id, item])), products = new Map((menu.products || []).map(item => [item.id, item]));
    let minutes = num(t.basePersonMinutes), sorted = false, install = 0;
    for (const [id, qty] of Object.entries(sel.removal || {})) {
      const item = services.get(id);
      if (!item || !(qty > 0) || haulingGroups(menu).includes(item.group)) continue;
      if (item.group === 'cleaning-base') sorted = true;
      minutes += num(item.laborPersonMinutes) * qty;
    }
    if (sorted) minutes += fullness && Number.isFinite(t.fillPersonMinutes?.[fullness]) ? t.fillPersonMinutes[fullness] : num(t.defaultFillPersonMinutes);
    const missing = [];
    for (const step of ['shelving', 'storage']) for (const row of sel[step] || []) {
      const item = products.get(row.id);
      if (!item) continue;
      if (Number.isFinite(item.installPersonMinutes)) install += item.installPersonMinutes * row.quantity; else missing.push(item.name);
    }
    const personMinutes = Math.round(minutes + install);
    return { manHours: Math.min(LABOR_LIMITS.max, Math.max(LABOR_LIMITS.min, Math.round(personMinutes / 15) / 4)), personMinutes, installNotEstimated: missing };
  }
  function validSelection(value, menu) {
    const out = emptySelection(), services = new Set((menu?.services || []).map(item => item.id)), products = new Map((menu?.products || []).map(item => [item.id, item.section]));
    if (value && typeof value === 'object') {
      for (const [id, qty] of Object.entries(value.removal || {})) if (services.has(id) && clampQty(qty, 99)) out.removal[id] = clampQty(qty, 99);
      for (const step of ['shelving', 'storage']) for (const entry of Array.isArray(value[step]) ? value[step] : []) {
        if (products.get(entry?.id) === step && clampQty(entry.quantity, 999) && !out[step].some(row => row.id === entry.id)) out[step].push({ id: entry.id, quantity: clampQty(entry.quantity, 999) });
      }
      if (validManHours(value.labor?.manHours, menu)) out.labor = { manHours: value.labor.manHours, adjusted: value.labor.adjusted === true };
    }
    return out;
  }
  // The walkthrough's own capture pre-fills the removal step: garage size, truckloads, special items, access and
  // cleaning add-ons. Shelving and storage are always chosen in the builder. The walkthrough's size base was its
  // full-service price, which already covered hauling, so a base is pre-selected only for a walkthrough without
  // truckloads; with loads the estimator chooses whether a cleaning base applies. The deep clean and the one-car
  // pressure wash follow the walkthrough's garage size, with or without a base.
  function selectionFromWalkthrough(p, menu) {
    const sel = emptySelection(), services = Array.isArray(menu?.services) ? menu.services : [], scope = p?.scope || {};
    const find = test => services.find(test), list = value => Array.isArray(value) ? value : [];
    const size = String(scope.garages || '');
    const loads = Number(scope.loads || 0), hauling = Number.isFinite(loads) && loads > 0;
    const base = hauling ? null : find(item => item.group === 'cleaning-base' && item.garageSize === size);
    if (base) sel.removal[base.id] = 1;
    if (hauling) {
      let full = Math.floor(loads), quarters = Math.round((loads - full) * 4);
      if (quarters === 4) { full += 1; quarters = 0; }
      const truck = find(item => item.junkFraction === 1), part = quarters ? find(item => item.junkFraction === quarters / 4) : null;
      if (truck && full) sel.removal[truck.id] = Math.min(20, full);
      if (part) sel.removal[part.id] = 1;
    }
    const counts = p?.raw?.specialQty || {};
    for (const key of list(scope.special_items)) { const item = find(row => row.group === 'special' && row.walkthroughKey === key); if (item) sel.removal[item.id] = clampQty(counts[key] ?? 1, 99) || 1; }
    for (const key of list(scope.access)) { const item = find(row => row.group === 'access' && row.walkthroughKey === key); if (item) sel.removal[item.id] = 1; }
    const finish = list(scope.finish), cleaning = key => find(row => row.group === 'cleaning' && row.walkthroughKey === key);
    if (finish.includes('deep_clean')) { const item = find(row => row.group === 'cleaning' && row.garageSize && row.garageSize === size); if (item) sel.removal[item.id] = 1; }
    if (finish.includes('pressure_wash') && size === '1' && cleaning('pressure_wash')) sel.removal[cleaning('pressure_wash').id] = 1;
    if (finish.includes('mouse_trapping') && cleaning('mouse_trapping')) sel.removal[cleaning('mouse_trapping').id] = 1;
    if (list(scope.hazards).includes('Pest waste') && cleaning('Pest waste')) sel.removal[cleaning('Pest waste').id] = 1;
    return sel;
  }
  // A saved quote's selection (job.compositePricing, the shape the server prices) in the builder's own shape: the saved
  // man-hours stay as they were saved (and adjusted only when the estimator had set them by hand), on any device, except
  // man-hours pre-filled before the owner's Labor decisions of 2026-10-18 (staleLabor, from the saved job.breakdown),
  // which follow the new estimate.
  function selectionOfPricing(pricing, breakdown = null, menu = null) {
    const sel = emptySelection(), rows = value => Array.isArray(value) ? value.filter(entry => entry && typeof entry.id === 'string') : [];
    for (const entry of rows(pricing?.removal)) sel.removal[entry.id] = entry.quantity;
    for (const step of ['shelving', 'storage']) sel[step] = rows(pricing?.[step]).map(entry => ({ id: entry.id, quantity: entry.quantity }));
    if (validManHours(pricing?.labor?.manHours) && !staleLabor(menu, breakdown)) sel.labor = { manHours: pricing.labor.manHours, adjusted: pricing.labor.adjusted === true };
    return sel;
  }
  // The selection the server prices: the finished steps (a prefix of removal, shelving, storage) and their items. The
  // whole quote (through storage) with garage work also carries the labor: the man-hours (null: the server's estimate),
  // whether the estimator set them by hand, and the walkthrough's garage fullness the estimate reads; a junk-only one has
  // none. The labor rate and the estimate are never sent: the server uses the owner's rate and works the estimate out
  // from the selection itself. Every step names the walkthrough's garage size when it is known (garageOf).
  function builderDescriptor(menu, sel, through, fullness = null, garageSize = null) {
    const steps = BUILDER_STEPS.slice(0, Math.max(1, BUILDER_STEPS.indexOf(through) + 1));
    return { menuVersion: menu.menuVersion, settingsVersion: menu.settingsVersion, steps, ...(GARAGE_SIZES.includes(garageSize) ? { garageSize } : {}),
      removal: (menu.services || []).filter(item => sel.removal[item.id] > 0).map(item => ({ id: item.id, quantity: sel.removal[item.id] })),
      shelving: steps.includes('shelving') ? sel.shelving.map(({ id, quantity }) => ({ id, quantity })) : [],
      storage: steps.includes('storage') ? sel.storage.map(({ id, quantity }) => ({ id, quantity })) : [],
      ...(steps.length === BUILDER_STEPS.length && !junkOnly(menu, sel) ? { labor: (hours => ({ manHours: hours, adjusted: hours !== null && sel.labor?.adjusted === true, fullness: FULLNESS.includes(fullness) ? fullness : null }))(validManHours(sel.labor?.manHours, menu) ? sel.labor.manHours : null) } : {}) };
  }
  // Running totals from the menu's per-unit prices, labor rate and time model, shown while choosing; the server's preview
  // is authoritative. laborHours is null while there is neither a time estimate nor a number of man-hours, and for a
  // junk-only selection (junkOnly), which has no Labor line.
  function runningTotals(menu, sel, fullness = null) {
    const price = new Map([...(menu?.services || []), ...(menu?.products || [])].map(item => [item.id, item]));
    const sum = rows => rows.reduce((total, [id, qty]) => total + (Number(price.get(id)?.unitCents) || 0) * qty, 0);
    const removal = sum(Object.entries(sel.removal)), shelving = sum(sel.shelving.map(row => [row.id, row.quantity])), storage = sum(sel.storage.map(row => [row.id, row.quantity]));
    const drafts = [...Object.keys(sel.removal), ...sel.shelving.map(row => row.id), ...sel.storage.map(row => row.id)].filter(id => price.get(id) && price.get(id).approved !== true).length;
    const junk = junkOnly(menu, sel), rate = Number.isSafeInteger(menu?.labor?.rateCents) ? menu.labor.rateCents : null;
    const laborHours = junk ? null : validManHours(sel.labor?.manHours, menu) ? sel.labor.manHours : estimateLabor(menu, sel, fullness)?.manHours ?? null;
    const labor = rate !== null && laborHours !== null ? laborCents(laborHours, rate) : 0;
    return { removal, shelving, storage, labor, laborHours, junkOnly: junk, total: removal + shelving + storage + labor, drafts };
  }
  // The customer-facing scope of a priced builder quote, step by step, then the labor: one word, never the man-hours
  // (D-LABOR-TEXT). A junk-only quote says it is junk removal only (D-JUNK). The same text as the server's
  // (composite-quote.js compositeScope), which a signed walkthrough builder quote saves.
  function builderScope(priced) {
    const lines = Array.isArray(priced?.breakdown?.lines) ? priced.breakdown.lines.filter(line => line && typeof line === 'object') : [];
    const names = section => lines.filter(line => line.section === section).map(line => line.qty !== 1 ? `${line.name} × ${line.qty}` : line.name);
    if (junkOnlyLines(null, lines)) return `Junk removal only: ${names('removal').join('; ')}. Loading, hauling and disposal; no sorting, organizing or reset.`.slice(0, 1600);
    const parts = (priced?.breakdown?.sections || []).map(section => names(section.id).length ? `${section.label}: ${names(section.id).join('; ')}` : '').filter(Boolean);
    if (typeof (priced?.labor ?? priced?.breakdown?.labor)?.manHours === 'number') parts.push('Labor');
    return `${parts.join('. ')}.`.slice(0, 1600);
  }
  // The draft a builder quote saves: the previewed server lines and the selection they were priced from.
  function compositeDraft(p, priced, validUntil) {
    const base = draftFromWalkthrough({ ...p, quote: { ...(p?.quote || {}), line_items: [] } }, validUntil);
    return { ...base, scope: builderScope(priced), line_items: (priced?.lineItems || []).map(line => ({ ...line })), catalog_version: String(priced?.menuVersion || ''), composite_pricing: priced?.compositePricing };
  }

  // One frozen, actor-scoped request per walkthrough (a manual walkthrough by its
  // draft identity); the send request is kept per quote job. Neither a reload nor
  // a lost response creates a second quote. The quote job to revise is always the
  // one the current walkthrough saved (d.savedJobId), never an earlier request's.
  function createClient(d) {
    const saveKey = (actor, source) => `egc-quote-draft-v1:${actor}:${source || `manual:${String(d.draftId?.() || '')}`}`, sendKey = (actor, job) => `egc-quote-send-v1:${actor}:${job.id}:r${job.estimate?.revision ?? ''}`;
    function read(key) { try { return JSON.parse(d.storage.getItem(key) || 'null'); } catch { throw new Error('The saved quote request is unreadable. Review the quote in the Hub before saving again.'); } }
    const remember = (key, value) => value ? d.storage.setItem(key, JSON.stringify(value)) : d.storage.removeItem(key);
    async function request(url, body, timeoutMs = 60000) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try { response = await d.fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal } : { cache: 'no-store', signal: controller.signal }); }
      catch { throw Object.assign(new Error('The server did not answer. Your request is kept; retry it unchanged.'), { status: 0 }); }
      finally { clearTimeout(timer); }
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      // A 2xx whose body is unreadable or not a success may still have committed.
      if (response.ok && data?.ok !== true) throw Object.assign(new Error('The server\'s answer could not be read. Your request is kept; retry it unchanged.'), { status: response.status, unknown: true, code: '' });
      if (!response.ok) throw Object.assign(new Error(refusal(data, 'The quote could not be verified. Retry without changing it.')), { status: response.status || 0, code: data?.code || '', details: data?.details || null });
      return data;
    }
    async function actor() { const user = await d.actor(); if (!user) throw Object.assign(new Error('Sign in to the Employee Hub before saving.'), { status: 401 }); return user; }
    // The frozen save of this walkthrough whose outcome is still unknown, if any.
    async function pendingSave() {
      const user = await d.actor(); if (!user) return null;
      const pending = read(saveKey(user, d.source()));
      return pending?.actor === user && pending.body && !pending.result ? pending : null;
    }
    // Returns {result, retrying, draft}: an unconfirmed earlier save is always
    // retried unchanged, and `draft` is what was actually saved.
    async function save(draft) {
      const user = await actor(), source = d.source(), key = saveKey(user, source);
      let pending = read(key);
      if (pending && pending.actor !== user) throw new Error('This request belongs to another signed-in employee.');
      const retrying = Boolean(pending?.body && !pending.result);
      // A resolve that may have committed is retried with its id only for the same
      // customer details; corrected details get a new id, never a 409 dead end.
      if (!retrying) { const identity = resolveIdentity(draft), reuse = pending?.resolveRequestId && pending.resolveIdentity === identity; pending = { actor: user, source, requestId: d.uuid(), resolveRequestId: reuse ? pending.resolveRequestId : d.uuid(), resolveIdentity: identity, draft, body: null, result: null }; remember(key, pending); }
      try {
        if (!pending.body) {
          const query = new URLSearchParams();
          if (source) query.set('sourceWalkthroughId', source);
          const known = d.savedJobId();
          if (known) query.set('jobId', known);
          const prepared = await request('/api/walkthrough-handoff?' + query);
          if (prepared.viewer?.id !== user) throw new Error('The signed-in account changed. Reload before saving.');
          let customerId = prepared.customerId;
          if (!customerId) customerId = (await request('/api/customer-resolve', { requestId: pending.resolveRequestId, customer: resolveCustomer(pending.draft.client) })).customer?.id;
          if (!customerId) throw new Error('The canonical customer could not be verified.');
          pending.body = { action: 'save', actorId: user, requestId: pending.requestId, customerId, sourceWalkthroughId: source || '', sourceRevision: prepared.sourceRevision || '', ...(prepared.jobId ? { jobId: prepared.jobId, expectedRevision: prepared.expectedRevision } : {}), draft: pending.draft };
          remember(key, pending);
        }
        if (await d.actor() !== user) throw new Error('The signed-in account changed. Reopen the original account to recover this request.');
        const result = await request('/api/quote-draft', pending.body);
        if (result.requestId !== pending.requestId || !result.job?.id || result.job.customerId !== pending.body.customerId) throw new Error('The saved quote did not match the request. Review it in the Hub before retrying.');
        pending.result = { job: result.job, warnings: result.warnings || [] }; remember(key, pending);
        d.accept?.(result);
        return { result, retrying, draft: pending.draft };
      } catch (error) {
        // A refused request that never saved is discarded; an unknown outcome is kept.
        // A resolve id the server already holds for other details is dropped too.
        if (refused(error)) { pending.body = null; pending.result = null; if (error.code === 'customer_resolve_idempotency_conflict') pending.resolveRequestId = pending.resolveIdentity = null; remember(key, pending); }
        throw Object.assign(error, { retrying, conflict: conflict(error) });
      }
    }
    async function preview(job) {
      await actor();
      return request('/api/quote-draft', { action: 'send_preview', jobId: job.id, expectedRevision: job.revision });
    }
    async function savedCapture() {
      const id = d.savedJobId();
      if (!id) return null;
      await actor();
      return request('/api/quote-draft?jobId=' + encodeURIComponent(id));
    }
    async function syncCapture(job) {
      const user = await actor();
      const result = await request('/api/quote-draft', { action: 'sync_capture', actorId: user, jobId: job.id, syncKey: job.captureSync?.key });
      if (await d.actor() !== user) throw new Error('The signed-in employee changed. Reopen the saved quote.');
      if (result.job?.id !== job.id) throw new Error('The walkthrough sync response did not match this job. Reload it in the Hub.');
      d.accept?.(result);
      return result;
    }
    async function send(job, previewed) {
      const user = await actor(), key = sendKey(user, job);
      let pending = read(key);
      if (!pending || pending.actor !== user) { pending = { actor: user, body: { action: 'send', requestId: d.uuid(), jobId: job.id, expectedRevision: job.revision, confirmToken: previewed.confirmToken } }; remember(key, pending); }
      try {
        const result = await request('/api/quote-draft', pending.body);
        if (result.requestId !== pending.body.requestId || result.job?.id !== job.id) throw new Error('The sent quote did not match the request. Review it in the Hub.');
        remember(key, null);
        return result;
      } catch (error) { if (refused(error)) remember(key, null); throw error; }
    }
    const pendingSend = async job => { const user = await d.actor(); return user ? read(sendKey(user, job)) : null; };
    function clear() { if (typeof d.storage.key !== 'function') return; for (let index = d.storage.length - 1; index >= 0; index -= 1) { const key = d.storage.key(index) || ''; if (/^egc-quote-(draft|send|builder)-v1:/.test(key)) d.storage.removeItem(key); } }
    // The guided builder (removal, then shelving, then extra storage): the server's priced menu for this login and
    // a server price check of the steps finished so far. Neither saves anything. The menu is asked for only while
    // the Hub says the builder is on, and gives up after 15 s so the dialog can offer a retry.
    async function builder() { await actor(); return request('/api/quote-draft?view=builder', null, 15000); }
    async function compositePreview(compositePricing) { await actor(); return request('/api/quote-draft', { action: 'composite_preview', compositePricing }); }
    // The builder selection of this walkthrough, kept on this device until the quote is saved or the person signs out.
    const builderKey = (user, source) => `egc-quote-builder-v1:${user}:${source || `manual:${String(d.draftId?.() || '')}`}`;
    async function builderState(value) {
      const user = await d.actor(); if (!user) return null;
      const key = builderKey(user, d.source());
      if (value === undefined) { try { return JSON.parse(d.storage.getItem(key) || 'null'); } catch { return null; } }
      try { remember(key, value); } catch { /* the selection still works for this visit */ }
      return value;
    }
    return { save, pendingSave, preview, savedCapture, syncCapture, send, pendingSend, clear, builder, compositePreview, builderState };
  }

  const MODES = {
    automation: recipient => `HighLevel's estimate-ready automation will notify the customer${recipient ? ` at ${recipient}` : ''}.`,
    dry_run: () => 'Customer messaging is in dry-run mode: the send is recorded, HighLevel is not triggered.',
    off: () => 'Customer messaging is off: the quote is marked sent, and you share it with the customer yourself.',
    suppressed: () => 'Customer notifications are off for this job: the quote is marked sent without a message.',
  };
  let active = null;
  function open(options) {
    if (active) return active.dialog;
    const client = options.client || createClient(options);
    // A walkthrough quote opens the guided builder when the Hub says it is on (EGC_QUOTE_BUILDER_ENABLED: the
    // walkthrough's /api/pricing-config answer, crew/walkthrough-pricing.js quoteBuilder()); otherwise the
    // walkthrough's own itemized quote is reviewed exactly as before, with no request of its own.
    const hint = () => { try { return root.EGCWalkthroughPricing?.quoteBuilder?.() === true; } catch { return false; } };
    const builderWanted = typeof options.draft !== 'function' && typeof options.plan === 'function' && typeof client.builder === 'function' && (options.builder === true || options.builder !== false && hint());
    const S = { step: 'review', mode: builderWanted ? 'probe' : 'legacy', busy: false, error: '', status: '', saved: null, preview: null, sent: null, validUntil: denverDate(options.now ? options.now() : Date.now(), 14), generation: 0 };
    const opener = document.activeElement, body = h('div', { class: 'qd-body' }), foot = h('div', { class: 'qd-foot' });
    const kicker = h('p', { class: 'qd-kicker' }, options.kicker || 'Not signing today?'), heading = h('h2', { id: 'qd-title' }, options.title || 'Send options for review');
    const dialog = h('dialog', { class: 'qd-dialog' + (options.variant === 'catalog' ? ' cq-review' : ''), 'aria-labelledby': 'qd-title' }, h('div', { class: 'qd-head' }, kicker, heading), body, foot);
    const close = () => { S.generation++; if (dialog.open) dialog.close(); dialog.remove(); active = null; window.removeEventListener('egc:signout', signout); if (opener?.focus) opener.focus(); };
    const signout = () => { client.clear(); close(); };
    const plan = () => { try { return options.plan() || {}; } catch { return {}; } };
    const draft = () => typeof options.draft === 'function' ? options.draft(S.validUntil) : S.mode === 'builder' ? compositeDraft(plan(), S.priced, S.validUntil) : draftFromWalkthrough(options.plan(), S.validUntil);
    // An earlier save whose answer was lost, and the quote job this walkthrough already saved (its walkthrough sync
    // status and, for a builder quote, its selection), read once when the dialog opens.
    const opening = (async () => {
      const pending = await client.pendingSave().catch(() => null);
      if (pending || typeof client.savedCapture !== 'function') return { pending, saved: null, failed: false };
      try { return { pending, saved: await client.savedCapture(), failed: false }; } catch { return { pending, saved: null, failed: true }; }
    })();
    // An earlier save whose answer was lost is shown and retried exactly as it
    // was frozen, never the walkthrough as it reads now.
    async function detectFrozen() {
      const generation = S.generation, { pending, saved, failed } = await opening;
      if (generation !== S.generation || S.busy) return;
      S.frozen = pending ? pending.draft : null; S.retry = Boolean(pending);
      if (pending?.draft?.valid_until) S.validUntil = pending.draft.valid_until;
      if (pending) S.step = 'review';
      if (failed) S.captureLoadError = 'Saved walkthrough sync status could not be loaded. Reopen the quote to retry.';
      else if (saved?.job?.captureSync) { S.saved = saved.job; S.syncEnabled = saved.captureSyncEnabled === true; }
      render();
    }
    // A sent quote's 25% deposit is due when the customer approves it and its 75% balance on the job day
    // (quote-payment-policy.js SENT_25_75), so a saved quote job with no date yet cannot be previewed or sent
    // (quote_draft_payment_dates_pending). Saving it again never adds a date: a quote from a Hub walkthrough waits for the
    // office to book the job; a quote from a manual walkthrough (or a catalog quote) is sent only from a walkthrough
    // booked in the Hub, so it is never sent.
    function datesNotice() {
      let walk = S.saved?.sourceWalkthroughId;
      if (typeof walk !== 'string') { try { walk = String(options.source?.() || ''); } catch { walk = ''; } }
      const lines = walk ? ['Sending waits for the job date: the 25% deposit is due when the customer approves the quote, and the 75% balance on the job day.',
        `Ask the office to book this job in Team schedule (To schedule). Then ${S.mode === 'builder' ? 'reopen this quote from the walkthrough and choose Send saved quote' : 'open Send options for review on the walkthrough again to send it'}.`]
        : options.variant === 'catalog' ? ['A catalog quote can\u2019t be sent for review: a quote is sent only from a walkthrough booked in the Hub, once the job date is booked.', 'Quote this customer from a walkthrough booked in the Hub instead.']
          : ['A quote from a manual walkthrough can\u2019t be sent for review: a quote is sent only from a walkthrough booked in the Hub.',
            'Get the homeowner\u2019s signature on the walkthrough\u2019s Review step and choose Save brief + schedule, or ask the office to book a walkthrough for this customer in the Hub and quote from that walkthrough.'];
      return h('div', { class: 'qd-notice', role: 'status', 'data-held': walk ? 'job-date' : 'no-walkthrough' }, lines.map(text => h('p', {}, text)));
    }
    const totalOf = list => list.reduce((sum, line) => sum + (line.selected === false ? 0 : Number(line.totalCents) || 0), 0);
    function lines(list) {
      return h('ul', { class: 'qd-lines' }, list.map(line => h('li', { class: line.included === false || line.selected === false ? 'qd-line qd-muted' : 'qd-line' }, h('span', {}, line.name, line.customerSupplied ? ' (customer supplied)' : '', line.quantity !== 1 ? ` × ${line.quantity}` : '', line.group ? ` (${line.group.label}${line.tier ? ` · ${line.tier}` : ''})` : line.optional ? ' (optional)' : ''), h('b', {}, money(line.totalCents)))));
    }
    function render() {
      // An unconfirmed earlier save (the review below) and any later step are shown whatever the builder is doing.
      if (S.mode === 'probe' && !S.frozen && S.step === 'review') {
        body.replaceChildren(...(S.probeError ? [h('p', { class: 'qd-error', role: 'alert' }, `The quote builder could not load. ${S.probeError}`), h('p', { class: 'qb-help' }, 'Walkthrough quotes are built in the quote builder from the owner\u2019s pricing menu. Check the connection and retry; nothing was saved.')]
          : [h('p', { class: 'qd-status', role: 'status' }, 'Loading the quote builder…'), h('div', { class: 'qd-skeleton', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'))]));
        foot.replaceChildren(...[h('button', { type: 'button', class: 'qd-secondary', onclick: close }, 'Close'), S.probeError ? h('button', { type: 'button', class: 'qd-primary', onclick: () => probeBuilder() }, 'Retry') : null].filter(Boolean));
        return;
      }
      if (S.mode === 'builder' && !S.frozen && (BUILDER_VIEWS.includes(S.step) || S.step === 'saved')) return renderBuilder();
      const children = [];
      if (S.step === 'held') {
        // Saved, but not sendable: draft prices wait for the owner, the estimator must edit and save the quote again
        // (its labor rate changed, it has no Labor line, or its man-hours leave out installing some goods), (builder
        // on) a walkthrough-priced quote must be rebuilt in the builder first, or its payment dates wait for a job date.
        const rebuild = S.heldKind === 'builder', resave = S.heldKind === 'resave', reasons = h('ul', { class: 'qb-reasons' }, (S.held || []).map(row => h('li', {}, String(row?.reason || row?.name || ''))));
        const editable = S.mode === 'builder' && S.savedBuild && (S.held || []).some(row => ESTIMATOR_FIXES.has(row?.id));
        children.push(h('p', { class: 'qd-done' }, S.status), S.heldKind === 'date' ? datesNotice() : rebuild
          ? h('div', { class: 'qd-notice', role: 'status' }, h('p', {}, 'Sending is blocked: with the quote builder on, this quote must be built in the builder before it is sent.'), reasons, h('p', {}, 'The saved draft is kept. Build the quote in the builder (removal, then shelving, then extra storage) and send that one.'))
          : resave ? h('div', { class: 'qd-notice', role: 'status' }, h('p', {}, 'Sending is blocked until you edit this quote and save it again:'), reasons, h('p', {}, (S.held || []).some(row => row?.id === JUNK_GARAGE_WORK) ? 'The saved draft is kept; no owner approval is needed for this.' : 'The saved draft is kept. Choose Edit quote, check the Labor line on the review step and save the quote again; no owner approval is needed for this.'))
            : h('div', { class: 'qd-notice', role: 'status' }, h('p', {}, editable ? 'Sending is blocked until the owner approves the draft prices below and you save the quote again:' : `Sending is blocked until the owner approves ${S.held.length === 1 ? 'this price' : `these ${S.held.length} prices`}:`), reasons, h('p', {}, `The owner approves draft prices in the Hub under Catalog & pricing.${editable ? ' The Labor or installation reason is yours to fix: choose Edit quote, check the man-hours and save the quote again.' : ''} The saved draft is kept: reopen this quote from the walkthrough and choose Send saved quote once they are approved.`)));
        body.replaceChildren(...children);
        const edit = () => { Object.assign(S, { step: 'removal', held: null, heldKind: '', status: '', error: '' }); render(); };
        foot.replaceChildren(...(rebuild && typeof client.builder === 'function' ? [h('button', { type: 'button', class: 'qd-secondary', onclick: close }, 'Close'), h('button', { type: 'button', class: 'qd-primary', onclick: openBuilder }, 'Open the quote builder')]
          : editable ? [h('button', { type: 'button', class: 'qd-secondary', onclick: close }, 'Done'), h('button', { type: 'button', class: 'qd-primary', onclick: edit }, 'Edit quote')]
            : [h('button', { type: 'button', class: 'qd-primary', onclick: close }, 'Done')]));
        return;
      }
      if (S.step === 'review' && S.frozen) {
        const frozen = S.frozen, list = Array.isArray(frozen.line_items) ? frozen.line_items : [];
        children.push(h('p', { class: 'qd-notice', role: 'status' }, 'An earlier save of this quote was not confirmed. Retry it exactly as it was submitted; later changes to the walkthrough are not part of it.'), lines(list), h('p', { class: 'qd-total' }, 'Total ', h('b', {}, money(totalOf(list)))), h('p', { class: 'qd-mode' }, `Options valid through ${dayText(frozen.valid_until)}`));
      } else if (S.step === 'review') {
        const current = draft(), total = totalOf(current.line_items);
        children.push(h('p', {}, 'Save this quote as an unsigned draft on the Hub job. The customer is not contacted until you preview and confirm the send.'), lines(current.line_items), h('p', { class: 'qd-total' }, 'Total ', h('b', {}, money(total))),
          h('label', { class: 'qd-label', for: 'qd-valid' }, 'Options valid through'),
          h('input', { id: 'qd-valid', class: 'qd-input', type: 'date', value: S.validUntil, min: denverDate(options.now ? options.now() : Date.now()), required: true, oninput: event => { S.validUntil = event.target.value; } }));
      } else if (S.step === 'confirm') {
        const job = S.preview.job;
        children.push(h('p', { class: 'qd-summary' }, S.preview.summary), lines(job.estimate.lineItems), h('p', { class: 'qd-total' }, 'Total ', h('b', {}, money(job.estimate.amountCents)), ` · valid through ${dayText(job.estimate.validUntil)}`), Number.isSafeInteger(job.estimate.depositRequiredCents) ? h('p', {}, 'Deposit due: ', money(job.estimate.depositRequiredCents)) : null, h('p', { class: 'qd-mode' }, (MODES[S.preview.delivery.mode] || MODES.off)(S.preview.delivery.recipient?.masked || '')));
      } else children.push(h('p', { class: 'qd-done' }, S.status));
      const capture = S.saved?.captureSync;
      if (capture) {
        const labels = { pending: 'Walkthrough saved in Hub; HighLevel sync pending.', syncing: 'Walkthrough HighLevel sync is in progress.', synced: 'Walkthrough note verified in HighLevel.', error: 'Walkthrough HighLevel sync failed. Retry the saved capture.', needs_link: 'Link the canonical HighLevel contact before retrying.', needs_review: 'This walkthrough needs review before it can sync to HighLevel.' };
        children.push(h('p', { class: 'qd-mode', role: 'status' }, labels[capture.status] || 'Walkthrough sync needs review.', !S.syncEnabled && capture.status !== 'synced' ? ' HighLevel capture sync is currently off.' : ''),
          h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy || !S.syncEnabled || ['synced', 'needs_review'].includes(capture.status), onclick: syncCapture }, 'Retry walkthrough sync'));
      }
      if (S.busy) children.push(h('div', { class: 'qd-skeleton', 'aria-hidden': 'true' }, h('span'), h('span')));
      children.push(h('p', { class: 'qd-status', 'aria-live': 'polite' }, S.step === 'done' ? '' : S.status), S.error || S.captureLoadError ? h('p', { class: 'qd-error', role: 'alert' }, S.error || S.captureLoadError) : null);
      body.replaceChildren(...children.filter(Boolean));
      const primary = S.step === 'review' ? h('button', { type: 'button', class: 'qd-primary', disabled: S.busy, onclick: S.reprice ? refreshPrices : saveDraft }, S.busy ? 'Saving draft…' : S.reprice ? 'Review updated prices' : S.retry ? 'Retry original save' : 'Save draft')
        : S.step === 'confirm' ? h('button', { type: 'button', class: 'qd-primary', disabled: S.busy, onclick: confirmSend }, S.busy ? 'Sending…' : S.retry ? 'Retry original send' : S.preview.delivery.mode === 'automation' ? 'Send to customer' : 'Mark as sent')
          : h('button', { type: 'button', class: 'qd-primary', onclick: close }, 'Done');
      foot.replaceChildren(...(S.step === 'done' ? [primary] : [h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: close }, 'Close'), primary]));
    }
    // ---- Guided builder views: removal / cleanout, shelving, extra storage, then the server-priced review ----
    const STEP_LABELS = { removal: 'Removal / cleanout', shelving: 'Shelving', storage: 'Extra storage', quote: 'Review' };
    // The walkthrough's Finish picks for the builder to open with (options.goods, crew/gameplan-catalog.js selection()), checked
    // against the menu like any saved selection, or null.
    const walkthroughGoods = menu => { let goods = null; try { goods = typeof options.goods === 'function' ? options.goods() : null; } catch { goods = null; } if (!goods || typeof goods !== 'object') return null; const checked = validSelection({ shelving: goods.shelving, storage: goods.storage }, menu); return { shelving: checked.shelving, storage: checked.storage }; };
    const goodsKey = sel => ['shelving', 'storage'].map(step => (sel?.[step] || []).map(row => `${row.id}:${row.quantity}`).sort().join(',')).join('|');
    const sameGoods = (a, b) => goodsKey(a) === goodsKey(b);
    const goodsOf = (menu, sel) => { const products = new Map((menu?.products || []).map(item => [item.id, item])); const row = ({ id, quantity }) => { const item = products.get(id); return { id, quantity, ...(item ? { group: item.group, name: item.name, ...(Number.isFinite(item.installPersonMinutes) ? { installPersonMinutes: item.installPersonMinutes } : {}) } : {}) }; }; return { shelving: (sel?.shelving || []).map(row), storage: (sel?.storage || []).map(row) }; };
    // The crew size on the Schedule tab: only the default of the Adjust control's people × hours.
    const crewOf = () => { const crew = Number(plan().logistics?.crew_size); return String(Number.isInteger(crew) && crew >= 1 && crew <= 20 ? crew : 2); };
    const keep = () => { Promise.resolve().then(() => client.builderState?.({ selection: S.sel, savedAt: Date.now() })).catch(() => {}); };
    // A saved quote's shelving and storage, from a walkthrough, go back to its Finish step (options.onGoods: the picks with
    // the group and install time the walkthrough's bring list and job time read). Only a save writes them back: changes
    // not saved stay in the builder, and the walkthrough (and the homeowner's signature) keeps the quote it has.
    const writeGoods = () => { if (typeof options.onGoods === 'function' && S.menu) { try { options.onGoods(goodsOf(S.menu, S.sel)); } catch { /* the walkthrough keeps its earlier picks */ } } };
    const chip = item => h('span', { class: 'qb-chip' + (item?.approved ? ' qb-ok' : ''), title: item?.reason || '' }, item?.approved ? 'Approved' : 'Draft price');
    const services = group => S.menu.services.filter(item => item.group === group);
    // A scope change re-estimates the labor unless the estimator set the man-hours by hand: man-hours kept from an earlier
    // estimate follow the new one.
    function changed() { if (S.sel.labor?.adjusted !== true) S.sel.labor = { manHours: null, adjusted: false }; S.priced = null; S.error = ''; keep(); render(); }
    function setRemoval(id, quantity) { if (quantity > 0) S.sel.removal[id] = quantity; else delete S.sel.removal[id]; changed(); }
    function setProduct(step, id, quantity) {
      const list = S.sel[step], at = list.findIndex(row => row.id === id);
      if (quantity > 0) { if (at >= 0) list[at].quantity = quantity; else list.push({ id, quantity }); } else if (at >= 0) list.splice(at, 1);
      changed();
    }
    // One garage base; a chosen deep clean follows the garage's size (the base's, else the walkthrough's) and a pressure
    // wash stays with a one-car garage only.
    function chooseBase(id) {
      const size = id ? S.menu.services.find(item => item.id === id)?.garageSize : garageOf(plan()), deep = services('cleaning').filter(item => item.garageSize);
      const hadDeep = deep.some(item => S.sel.removal[item.id]), wash = services('cleaning').find(item => item.walkthroughKey === 'pressure_wash');
      for (const item of [...services('cleaning-base'), ...deep]) delete S.sel.removal[item.id];
      if (id) S.sel.removal[id] = 1;
      const sized = deep.find(item => item.garageSize === size);
      if (hadDeep && sized) S.sel.removal[sized.id] = 1;
      if (wash && size !== '1') delete S.sel.removal[wash.id];
      changed();
    }
    function qtyControl(label, value, max, set) {
      return h('div', { class: 'qb-qty', role: 'group', 'aria-label': `${label} quantity` },
        h('button', { type: 'button', 'aria-label': `One fewer: ${label}`, disabled: S.busy || value <= 0, onclick: () => set(value - 1) }, '−'),
        h('output', { 'aria-live': 'polite' }, String(value)),
        h('button', { type: 'button', 'aria-label': `One more: ${label}`, disabled: S.busy || value >= max, onclick: () => set(value + 1) }, '+'));
    }
    function option(type, name, checked, onchange, label, item, { disabled = false, note = '' } = {}) {
      return h('label', { class: 'qb-option' + (checked ? ' on' : '') + (disabled ? ' off' : '') },
        h('input', { type, name: name || null, checked, disabled: S.busy || disabled, onchange }),
        h('span', { class: 'qb-name' }, label, note ? h('small', {}, note) : null),
        item ? h('span', { class: 'qb-price' }, money(item.unitCents), chip(item)) : null);
    }
    const section = (title, help, ...children) => h('section', { class: 'qb-section' }, h('h3', {}, title), help ? h('p', { class: 'qb-help' }, help) : null, ...children);
    function removalStep() {
      const bases = services('cleaning-base'), base = bases.find(item => S.sel.removal[item.id]), junk = services('junk');
      const full = junk.find(item => item.junkFraction === 1), partials = junk.filter(item => item.junkFraction < 1), partial = partials.find(item => S.sel.removal[item.id]);
      const pickPartial = id => { for (const item of partials) delete S.sel.removal[item.id]; if (id) S.sel.removal[id] = 1; changed(); };
      // The garage the cleaning add-ons are sized to: the base's, else the walkthrough's (a quote with truck loads).
      const walkSize = garageOf(plan()), size = base?.garageSize ?? walkSize, sizedBy = base ? 'Sized to the garage cleaning base.' : `Sized to the walkthrough\u2019s ${size === 'other' ? 'larger' : `${size}-car`} garage.`;
      const deep = services('cleaning').filter(item => item.garageSize), deepNow = deep.find(item => S.sel.removal[item.id]), deepFor = deep.find(item => item.garageSize === size);
      const toggle = item => event => setRemoval(item.id, event.target.checked ? 1 : 0);
      // A draft base is the walkthrough's old full-service price, which already covered hauling: say so next to the loads.
      const baseHelp = bases.some(item => !item.approved) ? 'Flat cleaning price by garage size. Draft amounts are the walkthrough\u2019s historical full-service base, which already included hauling: choose a base for the cleaning work, not to cover the truck loads below.' : 'Flat cleaning price by garage size.';
      return [
        section('Garage cleaning base', baseHelp, option('radio', 'qb-base', !base, () => chooseBase(''), 'No cleaning base'), ...bases.map(item => option('radio', 'qb-base', Boolean(S.sel.removal[item.id]), () => chooseBase(item.id), item.name, item))),
        section('Junk removal', 'Full truck loads plus at most one partial load.',
          full ? h('div', { class: 'qb-row' }, h('span', { class: 'qb-name' }, 'Full truck loads'), h('span', { class: 'qb-price' }, `${money(full.unitCents)} each`, chip(full)), qtyControl('full truck loads', S.sel.removal[full.id] || 0, 20, n => setRemoval(full.id, n))) : null,
          option('radio', 'qb-partial', !partial, () => pickPartial(''), 'No partial load'), ...partials.map(item => option('radio', 'qb-partial', item === partial, () => pickPartial(item.id), item.name, item))),
        section('Special-handling items', 'Items that need extra handling or disposal fees.', h('div', { class: 'qb-list' }, services('special').map(item => h('div', { class: 'qb-row' + (S.sel.removal[item.id] ? ' on' : '') }, h('span', { class: 'qb-name' }, item.name, item.scopeNote ? h('small', {}, item.scopeNote) : null), h('span', { class: 'qb-price' }, money(item.unitCents), chip(item)), qtyControl(item.name, S.sel.removal[item.id] || 0, 99, n => setRemoval(item.id, n)))))),
        section('Access', '', ...services('access').map(item => option('checkbox', '', Boolean(S.sel.removal[item.id]), toggle(item), item.name, item, { note: item.scopeNote || '' }))),
        section('Cleaning add-ons', '',
          // A checked add-on can always be unchecked, even when the garage no longer allows it.
          deep.length ? option('checkbox', '', Boolean(deepNow), event => { for (const item of deep) delete S.sel.removal[item.id]; if (event.target.checked && deepFor) S.sel.removal[deepFor.id] = 1; changed(); }, 'Deep clean', deepNow || deepFor, { disabled: !deepFor && !deepNow, note: deepFor ? sizedBy : 'Choose a garage cleaning base first.' }) : null,
          ...services('cleaning').filter(item => !item.garageSize).map(item => {
            const wash = item.walkthroughKey === 'pressure_wash', on = Boolean(S.sel.removal[item.id]);
            return option('checkbox', '', on, toggle(item), item.name, item, { disabled: wash && size !== '1' && !on, note: wash && size !== '1' ? 'One-car garage only.' : '' });
          })),
      ];
    }
    // A product's size is shown in the row and its fit notes one tap away (productDetails); the retailer's product page
    // (and its retail price beside EGC's) is never linked, so the estimator never leaves the quote.
    function productRow(item, step) {
      const quantity = S.sel[step].find(row => row.id === item.id)?.quantity || 0;
      return h('li', { class: 'qb-product' + (quantity ? ' on' : '') },
        item.photoUrl ? h('img', { src: item.photoUrl, alt: '', loading: 'lazy', width: 56, height: 56, referrerpolicy: 'no-referrer' }) : h('span', { class: 'qb-thumb', 'aria-hidden': 'true' }),
        h('div', { class: 'qb-info' }, h('strong', {}, item.name),
          h('small', {}, `${item.unitsPerPack > 1 ? `Pack of ${item.unitsPerPack} · ` : ''}${money(item.unitCents)} per pack${item.perOrderPackLimit ? ` · limit ${item.perOrderPackLimit} packs per order` : ''} `, chip(item)),
          ...productDetails(item)),
        quantity ? qtyControl(item.name, quantity, 999, n => setProduct(step, item.id, n)) : h('button', { type: 'button', class: 'qd-secondary qb-add', disabled: S.busy, 'aria-label': `Add ${item.name}`, onclick: () => setProduct(step, item.id, 1) }, 'Add'));
    }
    function productStep(step) {
      const all = S.menu.products.filter(item => item.section === step), chosen = S.sel[step].map(row => all.find(item => item.id === row.id)).filter(Boolean);
      const groups = (S.menu.sections || []).find(entry => entry.id === step)?.groups || [];
      const results = h('ul', { class: 'qb-products' }), more = h('div', {});
      const fill = () => {
        const words = String(S.search || '').toLowerCase().split(/\s+/).filter(Boolean);
        const matches = all.filter(item => !chosen.includes(item) && (!S.group || item.group === S.group) && words.every(word => item.name.toLowerCase().includes(word)));
        results.replaceChildren(...matches.slice(0, S.limit).map(item => productRow(item, step)));
        more.replaceChildren(...(matches.length > S.limit ? [h('button', { type: 'button', class: 'qd-secondary qb-more', onclick: () => { S.limit += 12; fill(); } }, `Show more (${matches.length - S.limit} left)`)] : matches.length ? [] : [h('p', { class: 'qb-help' }, 'No products match. Try another search or group.')]));
      };
      fill();
      const filters = step === 'storage' ? h('div', { class: 'qb-filters' },
        h('select', { class: 'qd-input', 'aria-label': 'Storage group', onchange: event => { S.group = event.target.value; S.limit = 12; fill(); } }, h('option', { value: '' }, 'All storage groups'), groups.map(group => h('option', { value: group.id, selected: S.group === group.id }, group.label))),
        h('input', { class: 'qd-input', type: 'search', value: S.search || '', placeholder: 'Search hooks, racks, bins…', 'aria-label': 'Search storage products', oninput: event => { S.search = event.target.value; S.limit = 12; fill(); } })) : null;
      // What the walkthrough's Finish step recorded, as a reminder; the builder never guesses a product from it.
      const finish = plan().scope?.finish_details || {}, noted = step === 'shelving' ? Number(finish.shelf_qty) : Number(finish.tote_qty);
      const note = Number.isInteger(noted) && noted > 0 ? h('p', { class: 'qd-mode' }, step === 'shelving' ? `Walkthrough note: ${noted} ${String(finish.shelf_type || '').replace(/[^a-z]/gi, '') || 'shelving'} shelving unit${noted === 1 ? '' : 's'}.` : `Walkthrough note: ${noted} labeled tote${noted === 1 ? '' : 's'}.`) : null;
      return [
        note,
        chosen.length ? section(`In this quote (${chosen.length})`, '', h('ul', { class: 'qb-products' }, chosen.map(item => productRow(item, step)))) : h('p', { class: 'qb-help' }, step === 'shelving' ? 'No shelving yet. Add units below, or continue with none.' : 'No extra storage yet. Add products below, or continue with none.'),
        section(step === 'shelving' ? 'Shelving units' : 'Storage products', S.menu.installation?.billedAs === 'labor' ? `Goods are priced per purchase pack. Installing them is billed through the Labor line (man-hours × ${money(S.menu.labor?.rateCents)}) on the review step.` : S.menu.installation?.included === true ? 'Goods are priced per purchase pack; installation is included in that price.' : 'Goods are priced per purchase pack, without installation. A quote with goods can be saved, and is sent once the owner confirms installation is included in the goods price.', filters, results, more),
      ];
    }
    // The Labor row of the review step: "N man-hours × $53.00 = $X" (the rate is the server's menu.labor.rateCents), where
    // the man-hours came from, and an Adjust control (total man-hours, or people × hours each) with a reset to the
    // estimate. Every change is priced on the server.
    function laborEditor(labor) {
      const edit = S.laborEdit, crewMode = edit.mode === 'crew', limits = laborLimits(S.menu);
      // The man-hours the fields say now (read when Apply is pressed, not when the row was drawn).
      const current = () => crewMode ? Math.round(Math.floor(Number(edit.people)) * Number(edit.hours) * 4) / 4 : Number(edit.total);
      const resultText = () => { const n = current(); return validManHours(n, S.menu) ? `= ${hoursText(n)} × ${money(labor.rateCents)} = ${money(laborCents(n, labor.rateCents))}` : `Enter ${limits.min} to ${limits.max} man-hours in quarter hours.`; };
      const refresh = () => { const out = dialog.querySelector('.qb-labor-result'); if (out) out.textContent = resultText(); };
      const mode = (id, label) => h('label', { class: 'qb-labor-mode' + (edit.mode === id ? ' on' : '') }, h('input', { type: 'radio', name: 'qb-labor-mode', checked: edit.mode === id, disabled: S.busy, onchange: () => { edit.mode = id; edit.error = ''; render(); } }), ' ', label);
      const number = (id, label, field, attrs) => h('label', { class: 'qb-labor-field', for: id }, h('span', {}, label), h('input', { id, class: 'qd-input', type: 'number', inputmode: 'decimal', step: '0.25', 'aria-label': label, value: edit[field], disabled: S.busy, oninput: event => { edit[field] = event.target.value; edit.error = ''; refresh(); }, ...attrs }));
      const apply = () => { const n = current(); if (!validManHours(n, S.menu)) { edit.error = `Enter ${limits.min} to ${limits.max} man-hours in quarter hours (like 6 or 6.25).`; render(); return; } setLabor(n); };
      return h('div', { class: 'qb-labor-edit', role: 'group', 'aria-label': 'Adjust labor' },
        h('div', { class: 'qb-labor-modes' }, mode('total', 'By total man-hours'), mode('crew', 'By people × hours')),
        crewMode ? h('div', { class: 'qb-labor-fields' },
          h('label', { class: 'qb-labor-field', for: 'qb-labor-people' }, h('span', {}, 'People'), h('select', { id: 'qb-labor-people', class: 'qd-input', 'aria-label': 'People', disabled: S.busy, onchange: event => { edit.people = event.target.value; edit.error = ''; refresh(); } }, Array.from({ length: 20 }, (_, index) => h('option', { value: String(index + 1), selected: String(index + 1) === String(edit.people) }, String(index + 1))))),
          number('qb-labor-each', 'Hours on site each', 'hours', { min: '0.25', max: '24' }))
          : h('div', { class: 'qb-labor-fields' }, number('qb-labor-hours', 'Total man-hours', 'total', { min: String(limits.min), max: String(limits.max) })),
        h('p', { class: 'qb-labor-result', 'aria-live': 'polite' }, resultText()),
        edit.error ? h('p', { class: 'qd-error', role: 'alert' }, edit.error) : null,
        h('div', { class: 'qb-labor-actions' }, labor.manHours === null ? null : h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: () => { S.laborEdit = null; render(); } }, 'Cancel'),
          h('button', { type: 'button', class: 'qd-primary', disabled: S.busy, onclick: apply }, 'Apply man-hours')));
    }
    // The man-hours the server's estimate leaves out the installation of: goods with no install time yet. Until the
    // estimator sets the man-hours by hand (or the owner confirms installation is included in the goods price), the quote
    // can be saved but not sent.
    const installGap = labor => S.menu?.installation?.included === true ? [] : (Array.isArray(labor?.estimate?.installNotEstimated) ? labor.estimate.installNotEstimated : []).filter(row => row && typeof row.name === 'string');
    function laborSection(priced) {
      // D-JUNK: a junk-only quote is the truck-load price alone; the review says why it has no Labor line.
      if (priced.junkOnly === true) return h('section', { class: 'qb-section qb-labor', 'data-labor': 'none' }, h('h3', {}, 'Labor · none'),
        h('p', { class: 'qb-help' }, 'Junk-only quote: the truck-load price covers the crew\u2019s time to load, haul and dispose, so this quote has no Labor line. Add a cleaning base, a cleaning add-on, shelving or storage and the Labor line comes back.'),
        garageWorkNote(walkthroughGarageWork(plan())));
      const labor = priced.labor || { manHours: null, rateCents: S.menu.labor?.rateCents, totalCents: null, prefilledManHours: null, adjusted: false, belowEstimate: false, estimate: null }, estimate = labor.estimate;
      const estimated = labor.prefilledManHours !== null && estimate, gap = installGap(labor);
      // The parts of the server's estimate (composite-quote.js laborEstimate), each named only when it counted (D-JUNK):
      // set-up and sweep-out always; sorting (and the fullness behind it) with a garage cleaning base; cleaning with a
      // timed cleaning add-on; installing the shelving or storage goods that have an install time.
      const lines = priced.breakdown.lines, sorted = lines.some(line => line.group === 'cleaning-base');
      const timedService = new Set((S.menu.services || []).filter(item => Number(item.laborPersonMinutes) > 0).map(item => item.id));
      const timedProduct = new Set((S.menu.products || []).filter(item => Number.isFinite(item.installPersonMinutes)).map(item => item.id));
      const cleaned = lines.some(line => line.group === 'cleaning' && timedService.has(line.id));
      const installed = ['shelving', 'storage'].filter(step => lines.some(line => line.section === step && line.sku && timedProduct.has(line.id)));
      const both = words => words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
      const parts = estimated ? [`${both(['set-up', sorted ? 'sorting' : '', cleaned ? 'cleaning' : ''].filter(Boolean))} ${hoursText(Math.round(estimate.removalPersonMinutes / 15) / 4)}`, estimate.installPersonMinutes ? `installing ${both(installed.length ? installed : ['shelving', 'storage'])} ${hoursText(Math.round(estimate.installPersonMinutes / 15) / 4)}` : '', estimate.fullness && sorted ? `${estimate.fullness} garage` : ''].filter(Boolean) : [];
      const basis = !estimated ? 'No time estimate is available, so the man-hours are entered by hand.'
        : `Estimate: ${hoursText(labor.prefilledManHours)} of crew time (${parts.join(', ')}), whatever the crew size. Truck loads, special items and access charges are not counted: their own prices pay for loading, hauling and disposal.`;
      const kept = labor.manHours !== null && !labor.adjusted && labor.prefilledManHours !== null && labor.manHours !== labor.prefilledManHours;
      const note = labor.manHours === null ? 'Enter the estimated man-hours before saving: the quote cannot be saved or sent without them.'
        : labor.adjusted && labor.prefilledManHours !== null ? `Adjusted by hand from the estimate of ${hoursText(labor.prefilledManHours)}.`
          : labor.adjusted ? 'Entered by hand.'
            : kept ? `Kept at the saved ${hoursText(labor.manHours)}: the estimate is now ${hoursText(labor.prefilledManHours)}.`
              : labor.prefilledManHours !== null ? 'Pre-filled from the estimate.' : '';
      const below = labor.belowEstimate ? `Below the estimate: the job shows the owner the estimate of ${hoursText(labor.prefilledManHours)}.` : '';
      const goods = priced.breakdown.lines.some(line => line.sku);
      if (labor.manHours === null && !S.laborEdit) S.laborEdit = { mode: 'total', total: '', people: crewOf(), hours: '', error: '' };
      const openEdit = () => { const base = labor.manHours ?? labor.prefilledManHours, crew = Number(crewOf());
        S.laborEdit = { mode: 'total', total: base === null ? '' : String(base), people: String(crew), hours: base === null ? '' : String(Math.round(base / crew * 4) / 4), error: '' }; render(); };
      return h('section', { class: 'qb-section qb-labor', 'data-labor': labor.manHours === null ? 'needed' : labor.adjusted ? 'adjusted' : kept ? 'kept' : 'estimate' },
        h('h3', {}, labor.manHours === null ? 'Labor · man-hours needed' : `Labor · ${money(labor.totalCents)}`),
        labor.manHours === null ? null : h('p', { class: 'qb-labor-row' }, h('b', {}, `${hoursText(labor.manHours)} × ${money(labor.rateCents)} = ${money(labor.totalCents)}`), ' ', h('span', { class: 'qb-chip qb-ok', title: S.menu.labor?.reason || '' }, 'Approved rate')),
        h('p', { class: 'qb-help' }, [basis, note, below, goods ? 'Installing the shelving and storage is billed through this line.' : ''].filter(Boolean).join(' ')),
        gap.length ? h('div', { class: 'qd-notice qb-install-gap', role: 'status' }, h('p', {}, `The estimate has no install time for: ${gap.map(row => `${row.name}${row.packs > 1 ? ` × ${row.packs}` : ''}`).join('; ')}.`),
          h('p', {}, labor.adjusted ? 'You set the man-hours by hand: make sure they include installing these.' : 'Adjust the man-hours to include installing them. Until you do, this quote can be saved but not sent.')) : null,
        S.laborEdit ? laborEditor(labor) : h('div', { class: 'qb-labor-actions' }, h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: openEdit }, 'Adjust'),
          (labor.adjusted || kept) && labor.prefilledManHours !== null ? h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: () => setLabor(null) }, `Reset to estimate (${hoursText(labor.prefilledManHours)})`) : null));
    }
    // A new man-hours number (null: back to the estimate) is priced on the server before the quote can be saved.
    function setLabor(manHours) {
      S.sel.labor = { manHours, adjusted: manHours !== null }; S.laborEdit = null; S.priced = null; S.error = ''; keep();
      advance('storage');
    }
    function quoteStep() {
      const priced = S.priced;
      if (!priced) return [h('p', { class: 'qb-help' }, S.busy ? 'Pricing the quote on the server…' : 'Price the quote on the server to review it.')];
      // The Labor row says itself when it still needs man-hours or leaves out installing some goods; the notice lists
      // only what waits for the owner.
      const lines = priced.breakdown.lines, blocked = priced.approval.blocked.filter(row => !ESTIMATOR_FIXES.has(row.id));
      return [
        ...priced.breakdown.sections.map(entry => section(`${entry.label} · ${money(entry.subtotalCents)}`, '', lines.some(line => line.section === entry.id)
          ? h('ul', { class: 'qd-lines' }, lines.filter(line => line.section === entry.id).map(line => h('li', { class: 'qd-line' }, h('span', {}, line.name, line.qty !== 1 ? ` × ${line.qty}${line.unit === 'pack' ? ' packs' : ''}` : '', ' ', chip(line)), h('b', {}, money(line.totalCents)))))
          : h('p', { class: 'qb-help' }, 'Nothing in this step.'))),
        laborSection(priced),
        h('p', { class: 'qd-total' }, 'Quote total ', h('b', {}, money(priced.totalCents))),
        // D-JUNK: a junk-only quote on a walkthrough that records garage work is saved but never sent (the server refuses it).
        priced.approval.ready ? h('p', { class: 'qd-mode' }, priced.junkOnly === true && walkthroughGarageWork(plan()).length ? 'Every price on this quote is owner-approved, but it cannot be sent while the walkthrough records garage work it does not price (see above). You can save it as a draft.' : 'Every price on this quote is owner-approved, so it can be sent after you save it.') : !blocked.length ? null
          : h('div', { class: 'qd-notice', role: 'status' }, h('p', {}, `You can save this quote as a draft, but it cannot be sent until the owner approves ${blocked.length === 1 ? 'this draft price' : `these ${blocked.length} draft prices`}:`), h('ul', { class: 'qb-reasons' }, blocked.map(row => h('li', {}, row.reason)))),
        priced.breakdown.purchaseList.length ? h('details', { class: 'qb-buy' }, h('summary', {}, `What to buy or grab (${priced.breakdown.purchaseList.length} products)`), h('ul', {}, priced.breakdown.purchaseList.map(row => h('li', {}, `${row.packs} pack${row.packs === 1 ? '' : 's'}${row.unitsPerPack > 1 ? ` (${row.units} units)` : ''} · ${row.name}`, row.overOrderLimit ? h('small', { class: 'qb-warn' }, ` More than the ${row.perOrderPackLimit}-pack order limit: split the purchase.`) : null)))) : null,
        h('label', { class: 'qd-label', for: 'qd-valid' }, 'Quote valid through'),
        h('input', { id: 'qd-valid', class: 'qd-input', type: 'date', value: S.validUntil, min: denverDate(options.now ? options.now() : Date.now()), required: true, oninput: event => { S.validUntil = event.target.value; } }),
      ];
    }
    // The saved Labor line: its man-hours and rate, how they relate to the estimate, and what the estimator must fix before
    // sending (a Labor line priced before the owner's Labor decisions of 2026-10-18, a labor rate the owner changed since,
    // or goods the estimate has no install time for).
    function savedLabor(labor) {
      const rateNow = S.menu?.labor?.rateCents, prefilled = typeof labor.prefilledManHours === 'number' ? labor.prefilledManHours : null, gap = labor.adjusted ? [] : installGap(labor);
      const note = prefilled === null || prefilled === labor.manHours ? '' : labor.adjusted ? `Adjusted by hand from the estimate of ${hoursText(prefilled)}.` : `The estimate was ${hoursText(prefilled)} when it was saved.`;
      return h('section', { class: 'qb-section qb-labor' }, h('h3', {}, `Labor · ${money(labor.totalCents)}`), h('p', { class: 'qb-labor-row' }, h('b', {}, `${hoursText(labor.manHours)} × ${money(labor.rateCents)} = ${money(labor.totalCents)}`)),
        note ? h('p', { class: 'qb-help' }, note) : null,
        labor.version !== (Number(S.menu?.labor?.version) || LABOR_VERSION) ? h('p', { class: 'qd-notice qb-labor-rules', role: 'status' }, 'This Labor line was priced before the owner\u2019s Labor decisions of 2026-10-18 (its estimate counted truck-load time, and the customer would see the man-hours). Edit the quote and save it again before sending it.') : null,
        Number.isSafeInteger(rateNow) && Number.isSafeInteger(labor.rateCents) && rateNow !== labor.rateCents ? h('p', { class: 'qd-notice qb-rate-changed', role: 'status' }, `The labor rate is now ${money(rateNow)} per man-hour, but this quote has ${money(labor.rateCents)}. Edit the quote and save it again before sending it.`) : null,
        gap.length ? h('p', { class: 'qd-notice qb-install-gap', role: 'status' }, `The man-hours leave out installing ${gap.map(row => row.name).join('; ')}. Edit the quote and adjust the man-hours before sending it.`) : null);
    }
    // The builder quote this walkthrough already saved and has not sent: send it as saved (for example once the owner
    // approved its draft prices), or edit it from its saved selection.
    function renderSaved() {
      const job = S.savedBuild, breakdown = job.breakdown && Array.isArray(job.breakdown.sections) ? job.breakdown : null, lines = Array.isArray(breakdown?.lines) ? breakdown.lines : [];
      // The walkthrough's Finish picks changed since the builder last saved and differ from this saved quote's goods: editing
      // the quote opens with the picks. Changes made here and not saved are not Finish's.
      const finish = walkthroughGoods(S.menu), finishChanged = Boolean(finish) && !sameGoods(finish, validSelection(selectionOfPricing(job.compositePricing), S.menu));
      body.replaceChildren(...[
        h('p', {}, `Quote ${job.estimate.number} revision ${job.estimate.revision} is saved as a draft and has not been sent.`),
        finishChanged ? h('p', { class: 'qd-notice qb-goods-changed', role: 'status' }, 'The shelving, totes and storage chosen on the walkthrough\u2019s Finish step are not the ones in this saved quote. Choose Edit quote: it opens with the Finish picks. Review it and save it again before sending.') : null,
        ...(breakdown ? breakdown.sections.filter(entry => lines.some(line => line.section === entry.id)).map(entry => section(`${entry.label} · ${money(entry.subtotalCents)}`, '', h('ul', { class: 'qd-lines' }, lines.filter(line => line.section === entry.id).map(line => h('li', { class: 'qd-line' }, h('span', {}, line.name, line.qty !== 1 ? ` × ${line.qty}${line.unit === 'pack' ? ' packs' : ''}` : ''), h('b', {}, money(line.totalCents))))))) : []),
        junkOnlyLines(S.menu, lines) ? h('div', { class: 'qb-junk' }, h('p', { class: breakdown.labor ? 'qd-notice' : 'qd-mode', role: 'status', 'data-labor': 'none' }, breakdown.labor ? 'This junk-only quote still has a Labor line from before the owner\u2019s decision of 2026-10-18: the truck-load price covers the crew\u2019s time. Edit the quote and save it again to drop it before sending it.' : 'Junk-only quote: the truck-load price covers the crew\u2019s time, so it has no Labor line.'), garageWorkNote(walkthroughGarageWork(plan())))
          : typeof breakdown?.labor?.manHours === 'number' ? savedLabor(breakdown.labor)
            : breakdown ? h('p', { class: 'qd-notice', role: 'status' }, 'This quote has no Labor line yet. Edit the quote to add the man-hours before sending it.') : null,
        h('p', { class: 'qd-total' }, 'Quote total ', h('b', {}, money(job.estimate.amountCents)), job.estimate.validUntil ? ` · valid through ${dayText(job.estimate.validUntil)}` : ''),
        h('p', { class: 'qd-mode' }, 'Sending checks every price against the owner\u2019s approvals now. To change the quote, edit it: it opens on the saved selection.'),
        S.busy ? h('div', { class: 'qd-skeleton', 'aria-hidden': 'true' }, h('span')) : null,
        S.error ? h('p', { class: 'qd-error', role: 'alert' }, S.error) : null].filter(Boolean));
      foot.replaceChildren(h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: close }, 'Close'),
        h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: () => { S.step = 'removal'; S.error = ''; render(); } }, 'Edit quote'),
        h('button', { type: 'button', class: 'qd-primary', disabled: S.busy, onclick: sendSaved }, S.busy ? 'Checking…' : 'Send saved quote'));
    }
    function renderBuilder() {
      if (S.step === 'saved') return renderSaved();
      const order = BUILDER_VIEWS, at = order.indexOf(S.step), totals = runningTotals(S.menu, S.sel, fullnessOf(plan()));
      const nav = h('ol', { class: 'qb-steps' }, order.map((step, index) => h('li', {}, h('button', { type: 'button', class: step === S.step ? 'on' : index < at ? 'done' : '', disabled: S.busy || index > at, 'aria-current': step === S.step ? 'step' : null, onclick: () => { S.step = step; S.error = ''; S.laborEdit = null; render(); } }, `${index + 1} ${STEP_LABELS[step]}`))));
      const laborText = totals.junkOnly ? 'No Labor line: junk only' : totals.laborHours === null ? 'Labor: man-hours on the review step' : `Labor ${money(totals.labor)} (${hoursText(totals.laborHours)})`;
      const running = S.step === 'quote' ? null : h('div', { class: 'qb-total', role: 'status' }, h('span', {}, 'Running total'), h('b', {}, money(totals.total)),
        h('small', {}, `Removal ${money(totals.removal)} · Shelving ${money(totals.shelving)} · Storage ${money(totals.storage)} · ${laborText}${totals.drafts ? ` · ${totals.drafts} draft price${totals.drafts === 1 ? '' : 's'} need owner approval before sending` : ''}`));
      const content = S.step === 'removal' ? removalStep() : S.step === 'quote' ? quoteStep() : productStep(S.step);
      body.replaceChildren(...[nav, running, ...content,
        S.busy ? h('div', { class: 'qd-skeleton', 'aria-hidden': 'true' }, h('span')) : null,
        S.status ? h('p', { class: 'qd-status', role: 'status' }, S.status) : null,
        S.error ? h('p', { class: 'qd-error', role: 'alert' }, S.error) : null,
        S.error && S.stale ? h('button', { type: 'button', class: 'qd-secondary qb-more', disabled: S.busy, onclick: reloadBuilder }, 'Reload current prices') : null].filter(Boolean));
      const back = at === 0 ? (S.savedBuild ? h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: () => { S.step = 'saved'; S.error = ''; render(); } }, 'Saved quote') : h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: close }, 'Close')) : h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: () => { S.step = order[at - 1]; S.error = ''; render(); } }, 'Back');
      // The labor must be priced (and any open Adjust applied or cancelled) before the quote is saved; a junk-only quote has none.
      const laborPending = S.step === 'quote' && S.priced && S.priced.junkOnly !== true && (S.laborEdit || typeof S.priced.labor?.manHours !== 'number');
      const next = S.step === 'quote' ? h('button', { type: 'button', class: 'qd-primary', disabled: S.busy || Boolean(laborPending), title: laborPending ? 'Apply the man-hours for the Labor line first.' : null, onclick: S.priced ? saveDraft : () => advance('storage') }, S.busy ? 'Working…' : !S.priced ? 'Price the quote' : S.retry ? 'Retry original save' : 'Save draft')
        : h('button', { type: 'button', class: 'qd-primary', disabled: S.busy, onclick: () => advance(S.step) }, S.busy ? 'Checking prices…' : S.step === 'storage' ? 'Review quote' : `Continue to ${STEP_LABELS[order[at + 1]].toLowerCase()}`);
      foot.replaceChildren(back, next);
    }
    // The server prices the finished steps (always in order) before the builder moves on.
    async function advance(through) {
      if (S.busy) return;
      const generation = S.generation;
      S.busy = true; S.error = ''; S.stale = false; render();
      try {
        const priced = await client.compositePreview(builderDescriptor(S.menu, S.sel, through, fullnessOf(plan()), garageOf(plan())));
        if (generation !== S.generation) return;
        if (through === 'storage') S.priced = priced;
        S.step = BUILDER_VIEWS[BUILDER_VIEWS.indexOf(through) + 1];
        S.group = ''; S.search = ''; S.limit = 12;
      } catch (error) {
        if (generation !== S.generation) return;
        S.error = error.message || 'The prices could not be checked. Your selections are kept; retry.';
        S.stale = /_composite_(version_changed|item_unavailable|wrong_step)$/.test(error.code || '');
        // A refused man-hours number goes back to the estimate; the estimator can adjust it again on the review step.
        if (/_composite_invalid_labor$/.test(error.code || '')) S.sel.labor = { manHours: null, adjusted: false };
      } finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    async function reloadBuilder() {
      if (S.busy) return;
      const generation = S.generation;
      S.busy = true; render();
      try {
        const menu = await client.builder();
        if (generation !== S.generation) return;
        if (menu?.enabled !== true) throw new Error('The quote builder is not available right now.');
        Object.assign(S, { menu, sel: validSelection(S.sel, menu), priced: null, error: '', stale: false, step: 'removal' });
        keep();
      } catch (error) { if (generation === S.generation) S.error = error.message || 'Current prices could not be loaded. Retry.'; }
      finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    // The builder menu, asked for only while the Hub said the builder is on. A Hub that answers the builder is off
    // (400 or 404) gets the walkthrough's own quote as before; no answer keeps the dialog on a retry, because a
    // walkthrough-priced quote cannot be sent while the builder is on. The selection comes from this device's
    // unsaved edits, else the saved builder quote, else the walkthrough capture.
    async function probeBuilder() {
      const generation = S.generation;
      if (S.probeError) { S.probeError = ''; render(); }
      let menu = null, failure = null;
      try { menu = await client.builder(); } catch (error) { failure = error; }
      if (generation !== S.generation) return;
      if (failure ? [400, 404].includes(failure.status) : menu?.enabled !== true) { S.mode = 'legacy'; render(); return; }
      if (failure || !Array.isArray(menu.services) || !Array.isArray(menu.products)) { S.probeError = failure?.message || 'The builder answer could not be read.'; render(); return; }
      const [kept, opened] = await Promise.all([Promise.resolve().then(() => client.builderState?.() ?? null).catch(() => null), opening]);
      if (generation !== S.generation) return;
      const job = opened?.saved?.job && opened.saved.job.compositePricing && typeof opened.saved.job.compositePricing === 'object' ? opened.saved.job : null;
      const unsent = job && job.estimate?.status === 'draft' && Number.isSafeInteger(job.estimate.amountCents) && job.estimate.number ? job : null;
      const sel = kept?.selection ? validSelection(kept.selection, menu) : job ? validSelection(selectionOfPricing(job.compositePricing, job.breakdown, menu), menu) : selectionFromWalkthrough(plan(), menu);
      // Shelving, totes and storage picked on the walkthrough's Finish step since the builder last wrote them back: the quote
      // opens with exactly those, and the labor follows the new estimate unless the estimator set it by hand.
      const picked = walkthroughGoods(menu);
      if (picked && !sameGoods(picked, sel)) { Object.assign(sel, { shelving: picked.shelving, storage: picked.storage }); if (sel.labor?.adjusted !== true) sel.labor = { manHours: null, adjusted: false }; }
      // A quote built before the walkthrough's garage size changed: its deep clean and pressure wash follow the new size when
      // it has no cleaning base, as the signed save checks them, and the labor follows the estimate unless set by hand.
      if (fitGarage(menu, sel, garageOf(plan())) && sel.labor?.adjusted !== true) sel.labor = { manHours: null, adjusted: false };
      // Man-hours this device kept from a quote saved before the owner's Labor decisions of 2026-10-18 follow the new
      // estimate too, unless the estimator set them by hand.
      if (staleLabor(menu, job?.breakdown) && sel.labor?.adjusted !== true) sel.labor = { manHours: null, adjusted: false };
      Object.assign(S, { mode: 'builder', menu, sel, priced: null, group: '', search: '', limit: 12, savedBuild: unsent });
      // An unconfirmed earlier save (detectFrozen) keeps the review step until it is retried.
      if (!S.frozen && !S.busy && S.step === 'review') S.step = unsent ? 'saved' : 'removal';
      kicker.textContent = 'Removal, then shelving, then extra storage'; heading.textContent = 'Build the itemized quote'; dialog.classList.add('qb-dialog');
      keep(); render();
    }
    // From a held walkthrough-priced quote: open the builder for this walkthrough.
    function openBuilder() {
      Object.assign(S, { step: 'review', held: null, heldKind: '', status: '', error: '', mode: 'probe', probeError: '' });
      render(); probeBuilder();
    }
    // Send the saved builder quote as it is: the server checks its prices against today's approvals and, for a new quote,
    // that its job is dated. A refusal held() takes shows the held step; the edit-and-save advice is only for the others.
    async function sendSaved() {
      if (S.busy || !S.savedBuild) return;
      const generation = S.generation, job = S.savedBuild;
      S.busy = true; S.error = ''; render();
      try {
        const preview = await client.preview(job);
        if (generation !== S.generation) return;
        const pending = await client.pendingSend(job);
        if (generation !== S.generation) return;
        S.saved = job; S.preview = preview; S.retry = Boolean(pending); S.step = 'confirm';
      } catch (error) {
        if (generation !== S.generation) return;
        if (held(error)) { S.saved = job; S.status = `Quote ${job.estimate.number} revision ${job.estimate.revision} stays saved as a draft.`; }
        else S.error = `${error.message || 'The saved quote could not be checked.'}${error.status === 409 && !/_payment_dates_/.test(String(error.code || '')) ? ' Edit the quote, review it and save it again.' : ''}`;
      } finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    // A send preview or send the server refused because the quote may not be sent yet: show why and keep the draft.
    // A refusal whose every reason is the estimator's to fix (the Labor line, or installation the man-hours leave out) is
    // a re-save, not a wait for the owner. Payment dates that wait for a job date (datesNotice) are neither.
    function held(error) {
      if (error?.code === 'quote_draft_payment_dates_pending') { S.step = 'held'; S.held = []; S.heldKind = 'date'; S.error = ''; return true; }
      // D-JUNK: a junk-only quote on a walkthrough that records garage work: the estimator adds the work or corrects the
      // walkthrough, then saves the quote again (the server names the work).
      if (error?.code === 'quote_draft_junk_only_garage_work') { S.step = 'held'; S.held = [{ id: JUNK_GARAGE_WORK, reason: error.message }]; S.heldKind = 'resave'; S.error = ''; return true; }
      if (!['quote_draft_composite_prices_unapproved', 'quote_draft_builder_required'].includes(error?.code)) return false;
      const rows = Array.isArray(error.details?.unapproved) ? error.details.unapproved : [];
      S.step = 'held'; S.held = rows; S.error = '';
      S.heldKind = error.code === 'quote_draft_builder_required' ? 'builder' : S.mode === 'builder' && rows.length && rows.every(row => ESTIMATOR_FIXES.has(row?.id)) ? 'resave' : 'prices';
      return true;
    }
    async function refreshPrices() {
      if (S.busy) return;
      const generation = S.generation;
      S.busy = true; S.error = ''; render();
      try { const reopen = await options.reprice(); if (generation !== S.generation) return; close(); await reopen(); }
      catch (error) { if (generation === S.generation) S.error = error.message || 'The latest prices could not be loaded. Retry.'; }
      finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    async function saveDraft() {
      const generation = S.generation, current = draft(), miss = missing(current);
      if (!S.retry && miss.length) { S.error = `Add ${miss.join(', ')} first.`; render(); return; }
      if (!S.retry && !/^\d{4}-\d{2}-\d{2}$/.test(S.validUntil)) { S.error = 'Choose the date these options stay valid.'; render(); return; }
      S.busy = true; S.error = ''; S.status = ''; render();
      let savedNow = false;
      try {
        const { result, retrying, draft: saved } = await client.save(current);
        if (generation !== S.generation) return;
        savedNow = true;
        S.saved = result.job; S.retry = false; S.frozen = null; S.status = [`Draft ${result.job.estimate.number} revision ${result.job.estimate.revision} saved.`, ...(result.warnings || []).map(warning => String(warning?.message || ''))].filter(Boolean).join(' ');
        S.syncEnabled = result.captureSyncEnabled === true;
        // The retried save was the frozen one: later walkthrough edits are not in
        // it, so they must be saved (and reviewed) before anything is previewed.
        if (retrying && !sameDraft(saved, current)) { S.status = `The original save is confirmed: ${S.status} Your later changes to the walkthrough are not saved yet. Review them and save again before sending.`; if (S.mode === 'builder') { S.step = 'removal'; S.priced = null; } return; }
        // The builder keeps the saved selection, man-hours included, on this device as on any other: reopening or editing
        // the quote starts from exactly what was saved, not from a fresh estimate.
        if (S.mode === 'builder' && result.job?.compositePricing && typeof result.job.compositePricing === 'object') { S.sel = validSelection(selectionOfPricing(result.job.compositePricing, result.job.breakdown, S.menu), S.menu); keep(); writeGoods(); }
        S.preview = await client.preview(result.job);
        if (generation !== S.generation) return;
        const pending = await client.pendingSend(result.job);
        S.retry = Boolean(pending); S.step = 'confirm';
      } catch (error) {
        if (generation !== S.generation) return;
        // Saved, but not sendable yet (a draft price, a walkthrough-priced quote while the builder is on, or payment
        // dates that wait for the job date): the quote is kept and the send waits, never a second Save draft.
        if (savedNow && held(error)) { if (S.mode === 'builder') S.savedBuild = S.saved; return; }
        const pending = await client.pendingSave().catch(() => null);
        if (generation !== S.generation) return;
        S.retry = Boolean(pending); S.frozen = pending ? pending.draft : null; S.error = error.message || 'The quote could not be saved. Retry.';
        if (!pending && S.mode === 'builder' && /^quote_draft_composite_(version_changed|price_changed|item_unavailable)$/.test(error.code || '')) { S.stale = true; S.priced = null; }
        S.reprice = !pending && typeof options.reprice === 'function' && /^quote_draft_catalog_(version_changed|price_changed|price_unverified|item_unavailable)$/.test(error.code || '');
      } finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    async function syncCapture() {
      if (S.busy || !S.saved || !S.syncEnabled) return;
      const generation = S.generation;
      const restorePreview = S.step === 'confirm';
      if (restorePreview) { S.preview = null; S.step = 'review'; }
      S.busy = true; S.error = ''; render();
      try {
        const result = await client.syncCapture(S.saved);
        if (generation !== S.generation) return;
        S.saved = result.job; S.syncEnabled = result.captureSyncEnabled === true;
        // Sync status writes change the job revision, so any prior send preview
        // must be replaced before the employee can confirm a customer send.
        if (restorePreview) { S.preview = await client.preview(S.saved); S.step = 'confirm'; }
      } catch (error) { if (generation === S.generation) S.error = error.message || 'The saved walkthrough sync needs a retry.'; }
      finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    async function confirmSend() {
      const generation = S.generation;
      S.busy = true; S.error = ''; render();
      try {
        const result = await client.send(S.saved, S.preview);
        if (generation !== S.generation) return;
        const status = result.delivery?.status;
        S.sent = result; S.step = 'done'; S.retry = false;
        S.status = `${result.job.estimate.number} revision ${result.job.estimate.revision} is marked sent. ${status === 'submitted' ? `The estimate-ready tag was applied in HighLevel; its workflow notifies the customer if that workflow is on.${result.delivery?.tagReset === 'unconfirmed' ? ' HighLevel did not confirm the old tag was cleared first, so a customer who already had it may not be notified again. Check Customer messages.' : ''}` : status === 'dry_run' ? 'Dry run: HighLevel was not triggered.' : ['uncertain', 'sending'].includes(status) ? 'HighLevel did not confirm the notification; it will not be resent automatically. Check Customer messages.' : status && !['messaging_disabled', 'suppressed', 'not_requested'].includes(status) ? 'The customer notification needs attention in Customer messages.' : 'Share the quote with the customer yourself.'}`;
        options.onSent?.(result);
      } catch (error) {
        if (generation !== S.generation) return;
        const pending = await client.pendingSend(S.saved).catch(() => null);
        if (generation !== S.generation) return;
        S.retry = Boolean(pending);
        if (!S.retry && held(error)) { /* the held step says why */ }
        else if (!S.retry && S.saved) { S.error = `${error.message || 'The send was refused.'} Save and preview the quote again.`; S.step = S.mode === 'builder' ? 'quote' : 'review'; }
        else S.error = error.message || 'The send could not be confirmed. Retry the original send.';
      } finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    dialog.addEventListener('cancel', event => { if (S.busy) event.preventDefault(); else { event.preventDefault(); close(); } });
    window.addEventListener('egc:signout', signout);
    document.body.append(dialog);
    render();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    active = { dialog, close };
    detectFrozen();
    if (S.mode === 'probe') probeBuilder();
    return dialog;
  }
  root.EGCQuoteDraft = { open, createClient, draftFromWalkthrough, scopeText, missing, builder: Object.freeze({ steps: BUILDER_STEPS, selectionFromWalkthrough, selectionOfPricing, validSelection, builderDescriptor, runningTotals, builderScope, compositeDraft, fullnessOf, garageOf, fitGarage, estimateLabor, junkOnly, walkthroughGarageWork, fitText, productDetails }) };
})(window);
