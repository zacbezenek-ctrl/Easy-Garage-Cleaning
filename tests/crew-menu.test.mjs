// LANE catalog (2026-10-19): the crew hub's read-only "What we sell" page (crew/menu.html, crew/menu.js) and its answer,
// GET /api/quote-draft?view=menu (composite-quote.js offeringsMenu). Every Hub employee reads every service and product
// on the builder menu with its size; only a quote author (owner, manager, sales/walkthrough) gets EGC's customer prices,
// their Draft/Approved status and the labor rate. Never a cost, a retail price or a retailer link. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDocument } from './helpers/hub-dom.mjs';
import { offeringsMenu, productSize } from '../functions/_lib/composite-quote.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { STAFF_GATED_PATHS, staffGatedPath } from '../staff-paths.js';
import { BASE_ENV, ON_ENV, builderState, estimator, menu, owner } from './helpers/estimator-fixture.mjs';

const crew = { user: 'crew.one', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
const plain = value => JSON.parse(JSON.stringify(value));
// Anything that would be money, a cost basis, a retailer or a link.
const NO_MONEY = /unitCents|rateCents|"approved"|retailPerPackCents|goodsMarkup|evidence|productUrl|photoUrl|homedepot|https?:|\$\d/;

function api(who, env = ON_ENV, state = builderState()) {
  const handlers = quoteDraftHandlers({ session: async () => who, storage: () => { throw new Error('the menu reads no jobs'); }, compositeState: async () => state });
  return async (query = '?view=menu') => { const response = await handlers.get({ request: new Request(`https://easygaragecleaning.com/api/quote-draft${query}`), env }); return { status: response.status, body: await response.json() }; };
}

test('every Hub employee reads what we sell; only a quote author gets prices, their status and the labor rate', async () => {
  const forCrew = await api(crew)();
  assert.equal(forCrew.status, 200);
  assert.equal(forCrew.body.prices, false);
  assert.equal(forCrew.body.services.length, menu.services.length, 'every service');
  assert.equal(forCrew.body.products.length, menu.products.length, 'every product');
  assert.doesNotMatch(JSON.stringify(forCrew.body), NO_MONEY, 'names and sizes only for crew');
  assert.deepEqual(forCrew.body.services.find(item => item.name === 'Quarter load'), { id: 'egc-023', section: 'removal', group: 'junk', name: 'Quarter load', unit: 'load', junkFraction: 0.25 });
  assert.deepEqual(forCrew.body.products.find(item => item.id === 'hd-100006678'), { id: 'hd-100006678', section: 'shelving', group: 'shelving', name: 'HDX plastic shelving, 36×72×24', unitsPerPack: 1, size: '36 W × 72 H × 24 D in' });
  assert.deepEqual(forCrew.body.sections.map(section => section.id), ['removal', 'shelving', 'storage']);
  for (const who of [estimator, owner]) {
    const priced = await api(who)();
    assert.equal(priced.status, 200, who.user);
    assert.equal(priced.body.prices, true);
    assert.deepEqual(priced.body.services.find(item => item.name === 'Full truck load'), { id: 'egc-026', section: 'removal', group: 'junk', name: 'Full truck load', unit: 'load', junkFraction: 1, unitCents: 75000, approved: true });
    assert.deepEqual(priced.body.products.find(item => item.id === 'hd-100006678'), { id: 'hd-100006678', section: 'shelving', group: 'shelving', name: 'HDX plastic shelving, 36×72×24', unitsPerPack: 1, size: '36 W × 72 H × 24 D in', unitCents: 11570, approved: false });
    assert.deepEqual(priced.body.labor, { rateCents: 5300, approved: true });
    assert.doesNotMatch(JSON.stringify(priced.body), /retailPerPackCents|goodsMarkup|evidence|productUrl|photoUrl|homedepot|https?:|"internal"|reason/, 'no cost basis, retailer, link or internal note, even for the owner');
  }
  // An owner approval shows as approved.
  const approved = await api(estimator, ON_ENV, builderState({ 'egc-027': 7000 }))();
  assert.equal(approved.body.services.find(item => item.id === 'egc-027').approved, true);
});

test('the menu answer needs a signed-in employee and the builder flag; the other views keep their own access', async () => {
  assert.deepEqual(await api(null)(), { status: 401, body: { ok: false, code: 'quote_sign_in_required', error: 'Sign in to the Employee Hub to see what we sell.' } });
  assert.deepEqual((await api(crew, BASE_ENV)()).body.code, 'quote_draft_menu_disabled');
  assert.equal((await api(crew, BASE_ENV)()).status, 404);
  // The builder menu itself, and any other lookup, stay quote authors only.
  assert.equal((await api(crew)('?view=builder')).status, 403);
  assert.equal((await api(crew)('?view=menu&extra=1')).status, 403, 'only the exact menu view is open to crew');
  assert.equal((await api(estimator)('?view=builder')).status, 200);
});

test('a product size comes from the listed width, height and depth, else a W × H × D phrase', () => {
  assert.equal(productSize('Width (in.): 48.00 in; Height (in.): 72.00 in; Depth (in.): 18.00 in Site/mounting review required.'), '48 W × 72 H × 18 D in');
  assert.equal(productSize('One hook. Height (in.): 6.5 in; Width (in.): 9.94 in'), '9.94 W × 6.5 H in');
  assert.equal(productSize('Hardware included. 7.87 W × 15.35 H in'), '7.87 W × 15.35 H in');
  assert.equal(productSize('Four of single tote 327528802. No quantity discount.'), '');
  assert.equal(productSize(undefined), '');
  assert.ok(offeringsMenu(builderState()).products.filter(item => item.size).length >= 40);
});

// ---- The page ----
const source = readFileSync(new URL('../crew/menu.js', import.meta.url), 'utf8');
const pageHtml = readFileSync(new URL('../crew/menu.html', import.meta.url), 'utf8');
const homeHtml = readFileSync(new URL('../crew/index.html', import.meta.url), 'utf8');
const answer = prices => ({ ok: true, authority: 'employee_hub', enabled: true, ...offeringsMenu(builderState(), { prices }) });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function page({ reply = () => ({ status: 200, body: answer(false) }), online = true } = {}) {
  const document = createDocument(), main = document.createElement('main'), calls = [];
  main.setAttribute('id', 'menu-main'); document.body.append(main);
  const context = { document, Node: document.Node, Intl, AbortController, setTimeout, clearTimeout, console, navigator: { onLine: online }, addEventListener() {},
    fetch: async (url, options) => { calls.push({ url, options }); const result = reply(url); if (result instanceof Error) throw result; return { ok: result.status < 300, status: result.status, json: async () => structuredClone(result.body) }; } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { main, calls, context, text: () => main.textContent, button: name => main.querySelectorAll('button').find(node => node.textContent === name) };
}

test('crew read every service and product with its size and never a price', async () => {
  const p = page();
  await flush();
  assert.deepEqual(p.calls.map(call => [call.url, call.options.credentials, call.options.cache]), [['/api/quote-draft?view=menu', 'same-origin', 'no-store']]);
  assert.match(p.text(), /^Crew toolsWhat we sellEvery service and product we offer, with sizes\. Prices come from your estimator or the office\./);
  for (const shown of ['Removal / cleanout', 'Garage cleaning base', 'One-car garage base', 'One-car garage', 'Quarter load', '25% of a truck', 'Hot tub dismantle and haul', 'Shelving', 'HDX plastic shelving, 36×72×24', '36 W × 72 H × 24 D in', 'Extra storage', 'Bins & totes', 'Pack of 4'])
    assert.ok(p.text().includes(shown), shown);
  assert.doesNotMatch(p.text(), /\$|Draft price|Approved(?! nonhazardous)|Labor ·|per man-hour/, 'no money and no price status for crew (one item is named "Approved nonhazardous paint")');
  assert.equal(p.main.querySelectorAll('a').length, 0, 'no retailer link');
  assert.equal(p.main.querySelectorAll('li').length, menu.services.length + menu.products.length);
  // Search and the step chips narrow the list.
  p.main.querySelector('input').dispatchEvent({ type: 'input', target: { value: 'garage base' } });
  assert.deepEqual(p.main.querySelectorAll('li strong').map(node => node.textContent), ['One-car garage base', 'Two-car garage base', 'Three-car garage base', 'Larger garage base']);
  p.main.querySelector('input').dispatchEvent({ type: 'input', target: { value: 'nothing like this' } });
  assert.match(p.text(), /Nothing matches\. Try another search or step\./);
  p.main.querySelector('input').dispatchEvent({ type: 'input', target: { value: '' } });
  p.main.querySelectorAll('button').find(node => node.getAttribute('data-section') === 'shelving').click();
  assert.deepEqual(p.main.querySelectorAll('section').map(node => node.getAttribute('data-section')), ['shelving']);
  assert.equal(p.main.querySelectorAll('button').find(node => node.getAttribute('data-section') === 'shelving').getAttribute('aria-pressed'), 'true');
});

test('an estimator reads EGC\'s customer prices with their Draft or Approved chip and the labor rate', async () => {
  const p = page({ reply: () => ({ status: 200, body: answer(true) }) });
  await flush();
  assert.match(p.text(), /EGC’s customer prices from the owner’s pricing menu\./);
  assert.match(p.text(), /Labor · \$53\.00 per man-hourEvery quote with garage work has one Labor line/);
  const row = id => p.main.querySelectorAll('li').find(node => node.getAttribute('data-item') === id).textContent;
  assert.equal(row('egc-026'), 'Full truck load$750.00per loadApproved');
  assert.equal(row('egc-023'), 'Quarter load25% of a truck$187.50per loadDraft price');
  assert.equal(row('egc-027'), 'Mattress$70.00eachDraft price');
  assert.equal(row('hd-100006678'), 'HDX plastic shelving, 36×72×2436 W × 72 H × 24 D in$115.70per packDraft price');
  assert.doesNotMatch(p.text(), /retail|cost|homedepot/i);
});

test('the page says when to sign in, when the menu is off, offline, or failing, with a retry', async () => {
  const signedOut = page({ reply: () => ({ status: 401, body: { ok: false, code: 'quote_sign_in_required', error: 'Sign in.' } }) });
  await flush();
  assert.match(signedOut.text(), /Sign in firstSign in to the crew app, then come back to what we sell\.Sign in/);
  assert.equal(signedOut.main.querySelector('a').getAttribute('href'), '/crew/?next=%2Fcrew%2Fmenu');
  assert.ok(staffGatedPath('/crew/menu') && STAFF_GATED_PATHS.includes('/crew/menu*'), 'the sign-in returns to a gated page');
  const off = page({ reply: () => ({ status: 404, body: { ok: false, code: 'quote_draft_menu_disabled', error: 'The menu of what we sell is not available yet. Ask the office.' } }) });
  await flush();
  assert.match(off.text(), /Not available yetThe menu of what we sell is not available yet\. Ask the office\.Back to crew home/);
  const offline = page({ online: false });
  await flush();
  assert.deepEqual([offline.calls.length, /You’re offline\. What we sell loads when you reconnect\./.test(offline.text())], [0, true]);
  let fail = true;
  const outage = page({ reply: () => fail ? new TypeError('Failed to fetch') : { status: 200, body: answer(false) } });
  await flush();
  assert.match(outage.text(), /What we sell did not load\. Check your connection, then try again\./);
  fail = false;
  outage.button('Try again').click(); await flush();
  assert.match(outage.text(), /HDX plastic shelving/);
  assert.doesNotMatch(outage.text(), /did not load/);
});

test('the crew home links What we sell at its clean URL, and the page loads only its own script and the Hub sign-in', () => {
  assert.match(homeHtml, /<a class="tool" id="menu-tool" href="\/crew\/menu"><span class="num">&#9636;<\/span><span class="tx"><h2>What we sell<\/h2>/);
  assert.doesNotMatch(homeHtml.slice(homeHtml.indexOf('id="menu-tool"'), homeHtml.indexOf('</a>', homeHtml.indexOf('id="menu-tool"'))), /\$/);
  assert.deepEqual([...pageHtml.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]), ['/crew/hub-auth.js?v=20260904c', '/crew/menu.js?v=20261019catalog']);
  assert.deepEqual(plain(Object.keys(answer(false))).sort(), ['authority', 'enabled', 'menuVersion', 'ok', 'prices', 'products', 'sections', 'services']);
});
