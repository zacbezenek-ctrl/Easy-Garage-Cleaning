import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// M15: the retired quote modal and /quote?id= contract modal are gone from the
// Employee Hub, and every handler the page still wires up resolves to real code.
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const NOW = '2026-09-22T12:00:00.000Z';
const html = read('employee.html');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const inline = scripts.filter(match => !/\bsrc\s*=/.test(match[1])).map(match => match[2]);
const local = scripts.map(match => match[1].match(/\bsrc\s*=\s*"([^"]+)"/)?.[1]).filter(src => src && !/^(?:https?:)?\/\//.test(src))
  .map(src => read(src.replace(/[?#].*$/, '').replace(/^\//, '')));
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
const markupIds = new Set([...markup.matchAll(/\sid\s*=\s*"([^"]+)"/g)].map(match => match[1]));
const pageSources = [...inline, ...local];

// Instantiate every inline script without running a statement: top-level
// function/var/let/const bindings are exactly what inline handlers can see.
// Local scripts are IIFEs, so only explicit window/globalThis exports count.
const globals = vm.createContext({});
for (const source of inline) {
  try { vm.runInContext(`throw null;\n${source}`, globals); } catch (error) { if (error !== null) throw error; }
}
function defined(name) {
  if (Object.hasOwn(globals, name)) return true;
  try { if (vm.runInContext(`typeof ${name}`, globals) === 'function') return true; } catch (error) { if (error?.name === 'ReferenceError') return true; throw error; }
  return pageSources.some(source => new RegExp(`\\b(?:window|globalThis)\\s*(?:\\.\\s*${name}|\\[\\s*(['"])${name}\\1\\s*\\])\\s*=(?!=)`).test(source));
}
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'void', 'function', 'catch', 'async', 'confirm', 'alert', 'prompt', 'setTimeout', 'fetch', 'open', 'print', 'requestAnimationFrame']);
const calls = code => [...new Set([...code.replace(/\$\{[^}]*\}/g, '0').matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]))].filter(name => !NOT_CALLS.has(name));
const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => match[1] ?? match[2]);
const handlerNames = [...new Set(handlers.flatMap(calls))].sort();

const RETIRED_FUNCTIONS = ['saveQuoteModal', 'applyQuoteTier', 'closeQuoteModal', 'openQuoteModal', 'openContractModal', 'closeContractModal', 'contractModalBgClick', 'updateDepositPreview', 'generateContract', 'copyContractLink'];
const RETIRED_IDS = ['quote-modal', 'qm-job-id', 'qm-tier', 'qm-amount', 'qm-status', 'qm-pay-after', 'contract-modal'];
// Pre-existing non-quote legacy markup (job/customer/lead CRM modals and the
// calendar popup) that other units own. This list may only shrink.
const KNOWN_UNRELATED_UNDEFINED = new Set(['closeCustomerDetail', 'closeJobDetail', 'closeLeadDetail', 'closeLeadModal', 'filterCustomersTab', 'moveJobPipeline', 'openJobDetail', 'saveLeadForm', 'setPipelineFilter', 'toggleJobsView']);

test('the retired quote and contract modals are removed and nothing looks them up', () => {
  for (const id of RETIRED_IDS) {
    assert.equal(markupIds.has(id), false, `#${id} markup must be removed`);
    for (const source of pageSources) assert.doesNotMatch(source, new RegExp(`['"\`#]${id}['"\`]`), `nothing may look up #${id}`);
  }
  assert.equal([...markupIds].filter(id => id.startsWith('cm-')).length, 0, 'contract modal fields must be removed');
  for (const source of pageSources) assert.doesNotMatch(source, /getElementById\(\s*['"`]cm-/);
  for (const name of RETIRED_FUNCTIONS) {
    assert.equal(defined(name), false, `${name} must not survive as dead code`);
    assert.equal(handlerNames.includes(name), false, `no handler may call ${name}`);
    for (const source of pageSources) assert.doesNotMatch(source, new RegExp(`(?<![\\w$])${name}\\s*\\(`), `${name} must not be called`);
  }
  assert.doesNotMatch(html, /deposit required at booking \(25%\)|num \* 0\.25|rawNum \* 0\.25/, 'the retired 25%-over-$1,000 deposit rule must be gone');
});

test('inline handlers in employee.html resolve to defined functions; only known non-quote legacy gaps remain', () => {
  assert.ok(handlerNames.length > 30, 'handler extraction must see the page');
  const unresolved = handlerNames.filter(name => !defined(name));
  assert.deepEqual(unresolved.filter(name => !KNOWN_UNRELATED_UNDEFINED.has(name)), [], 'handlers must call real functions');
  for (const name of KNOWN_UNRELATED_UNDEFINED) assert.doesNotMatch(name, /quote|contract|deposit/i);
  for (const name of ['markQuoted', 'submitLeadQuote', 'closeLeadQuoteModal', 'leadQuoteBgClick', 'calcQuote', 'switchTab', 'openBooking']) assert.equal(defined(name), true, `${name} must stay defined`);
});

function fakeElement(id) {
  const classes = new Set(), listeners = {};
  return {
    id, value: '', textContent: '', focused: 0, listeners,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    focus() { this.focused++; },
  };
}

function fakePage() {
  const elements = new Map(), lookups = [];
  const document = {
    getElementById(id) {
      lookups.push(id);
      if (!markupIds.has(id)) return null;
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
  };
  return { document, elements, lookups };
}

test('page boot binds keyboard shortcuts only to modals that exist and every shortcut reaches real code', async () => {
  const start = html.indexOf("window.addEventListener('DOMContentLoaded', async () => {");
  assert.ok(start > 0, 'boot listener must exist');
  const boot = html.slice(start, html.indexOf('\n});', start) + 4);
  const page = fakePage(), invoked = [], events = {};
  const context = { document: page.document, window: { addEventListener: (type, callback) => { events[type] = callback; } } };
  for (const name of calls(boot)) if (!['addEventListener', 'getElementById', 'focus'].includes(name) && defined(name)) context[name] = async () => { invoked.push(name); };
  assert.ok(context.submitLeadQuote && context.closeLeadQuoteModal, 'the lead-quote shortcuts must still target defined functions');
  vm.runInNewContext(boot, context);
  await events.DOMContentLoaded();
  assert.deepEqual(page.lookups.filter(id => !markupIds.has(id)), [], 'boot must not look up missing elements');
  const bound = [...page.elements.values()].filter(element => element.listeners.keydown);
  assert.ok(bound.some(element => element.id === 'lqm-amount'));
  for (const element of bound) for (const key of ['Enter', 'Escape']) for (const listener of element.listeners.keydown) await listener({ key, preventDefault() {} });
  assert.equal(page.lookups.includes('qm-amount'), false, 'no listener may be bound to the retired quote modal');
  assert.ok(invoked.includes('submitLeadQuote') && invoked.includes('closeLeadQuoteModal') && invoked.includes('doLogin'));
});

test('Mark as Quoted still records the lead quote and starts the Zap 5 follow-up', () => {
  const cfgStart = html.indexOf('const CFG = {'), cfg = html.slice(cfgStart, html.indexOf('\n};', cfgStart) + 3);
  const leadStart = html.indexOf('let _quoteLeadId = null;'), lead = html.slice(leadStart, html.indexOf('function markDead(', leadStart));
  assert.ok(cfgStart > 0 && leadStart > 0 && lead.includes('function submitLeadQuote('), 'the lead-quote path must remain');
  const page = fakePage(), writes = [], webhooks = [], audit = [], toasts = [];
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } }
  const context = {
    document: page.document, Date: FixedDate, setTimeout: callback => callback(),
    leadsCache: [{ id: 'lead-1', name: 'Synthetic Lead', phone: '9705550100', email: 'synthetic@example.invalid' }],
    db: { collection: collection => ({ doc: id => ({ update: patch => { writes.push({ collection, id, patch: structuredClone(patch) }); return Promise.resolve(); } }) }) },
    fireWebhook: (url, data) => { webhooks.push([url, structuredClone(data)]); },
    addAuditLog: (action, detail) => { audit.push([action, detail]); },
    showToast: message => { toasts.push(message); },
  };
  const api = vm.runInNewContext(`${cfg}\n${lead}\n;({markQuoted,submitLeadQuote,leadQuoteBgClick})`, context);
  const modal = () => page.elements.get('lead-quote-modal'), amount = () => page.elements.get('lqm-amount');
  api.markQuoted('lead-1');
  assert.equal(modal().classList.contains('open'), true);
  assert.equal(page.elements.get('qm-lead-name').textContent, 'Synthetic Lead');
  assert.equal(amount().value, '');
  api.submitLeadQuote();
  assert.deepEqual(writes, [], 'an empty quote amount saves nothing');
  assert.equal(modal().classList.contains('open'), true);
  assert.equal(amount().focused, 2);
  amount().value = '  $350–$425 ';
  api.submitLeadQuote();
  assert.equal(modal().classList.contains('open'), false);
  assert.deepEqual(writes, [{ collection: 'leads', id: 'lead-1', patch: { status: 'quoted', conversationActive: false, quotedAt: NOW, quoteAmount: '$350–$425' } }]);
  assert.deepEqual(webhooks, [['operations:quote_followup', { leadId: 'lead-1', phone: '9705550100', name: 'Synthetic Lead', email: 'synthetic@example.invalid', quoteAmount: '$350–$425' }]]);
  assert.deepEqual(audit, [['mark_quoted', 'Lead: Synthetic Lead · Quote: $350–$425']]);
  assert.deepEqual(toasts, ['Quoted · Zap 5 follow-up started']);
  api.markQuoted('lead-1');
  api.leadQuoteBgClick({ target: {} });
  assert.equal(modal().classList.contains('open'), true, 'clicks inside the panel keep the modal open');
  api.leadQuoteBgClick({ target: modal() });
  assert.equal(modal().classList.contains('open'), false);
  amount().value = '$999';
  api.submitLeadQuote();
  assert.equal(writes.length, 1, 'a closed modal cannot resubmit the previous lead');
  assert.equal(webhooks.length, 1);
});
