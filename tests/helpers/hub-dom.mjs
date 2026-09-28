// A small DOM for vm tests of the Employee Hub shell, screen registry and UI kit.
// It parses the suite's well-formed template HTML into elements so selectors,
// focus and node identity behave like a page; it is not a browser.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'path', 'source', 'col', 'wbr']);
const decode = text => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]));
const simple = (node, selector) => {
  const match = /^([a-z0-9-]*|\*)((?:[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(selector.trim());
  if (!match || !node.tagName) return false;
  if (match[1] && match[1] !== '*' && node.tagName !== match[1].toUpperCase()) return false;
  for (const part of match[2].match(/[#.][\w-]+|\[[^\]]+\]/g) || []) {
    if (part[0] === '#' && node.id !== part.slice(1)) return false;
    if (part[0] === '.' && !node.classList.contains(part.slice(1))) return false;
    if (part[0] === '[') { const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part); if (!node.hasAttribute(name) || value !== undefined && node.getAttribute(name) !== value) return false; }
  }
  return true;
};
// Descendant (' ') and child ('>') combinators, matched right to left.
const matches = (node, selector) => selector.split(',').some(group => {
  const tokens = group.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  if (!simple(node, tokens.at(-1))) return false;
  let cursor = node.parentNode, child = false;
  for (let index = tokens.length - 2; index >= 0; index--) {
    if (tokens[index] === '>') { child = true; continue; }
    if (child) { if (!cursor || !simple(cursor, tokens[index])) return false; }
    else { while (cursor && !simple(cursor, tokens[index])) cursor = cursor.parentNode; if (!cursor) return false; }
    cursor = cursor.parentNode; child = false;
  }
  return true;
});

export function createDocument() {
  const document = { activeElement: null, listeners: {}, assets: [], onAsset: node => queueMicrotask(() => node.onload?.()) };
  class Node {}
  class Text extends Node { constructor(text) { super(); this.nodeType = 3; this.data = String(text); this.parentNode = null; } get textContent() { return this.data; } remove() { detach(this); } }
  const detach = node => { if (node.parentNode) { node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node); node.parentNode = null; } };
  class Element extends Node {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase(); this.nodeType = 1; this.childNodes = []; this.parentNode = null; this.attributes = new Map();
      this.listeners = {}; this.style = {}; this.replacements = 0; this.value = ''; this.defaultValue = ''; this.checked = false; this.defaultChecked = false;
      const self = this, dataName = key => 'data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
      // dataset reflects data-* attributes both ways, as in a browser.
      this.dataset = new Proxy({}, {
        get: (_, key) => typeof key === 'string' ? self.getAttribute(dataName(key)) ?? undefined : undefined,
        set: (_, key, value) => { self.setAttribute(dataName(key), value); return true; },
        deleteProperty: (_, key) => { self.removeAttribute(dataName(key)); return true; },
        has: (_, key) => typeof key === 'string' && self.hasAttribute(dataName(key)),
      });
      this.classList = {
        contains: name => self.className.split(/\s+/).includes(name),
        add: (...names) => { self.className = [...new Set([...self.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { self.className = self.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
        toggle: (name, force) => { const on = force === undefined ? !self.classList.contains(name) : Boolean(force); if (on) self.classList.add(name); else self.classList.remove(name); return on; },
      };
    }
    get id() { return this.getAttribute('id') || ''; } set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; } set className(value) { this.setAttribute('class', value); }
    get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : this.tagName === 'INPUT' ? 'text' : ''); } set type(value) { this.setAttribute('type', value); }
    get name() { return this.getAttribute('name') || ''; } set name(value) { this.setAttribute('name', value); }
    get hidden() { return this.hasAttribute('hidden'); } set hidden(value) { this.toggleAttribute('hidden', Boolean(value)); }
    get src() { return this.getAttribute('src') || ''; } set src(value) { this.setAttribute('src', value); }
    get href() { return this.getAttribute('href') || ''; } set href(value) { this.setAttribute('href', value); }
    get rel() { return this.getAttribute('rel') || ''; } set rel(value) { this.setAttribute('rel', value); }
    get htmlFor() { return this.getAttribute('for') || ''; } set htmlFor(value) { this.setAttribute('for', value); }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { let cursor = this; while (cursor) { if (cursor === document.documentElement) return true; cursor = cursor.parentNode; } return false; }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(new Text(value)); }
    get innerHTML() { return this.html || ''; }
    set innerHTML(html) { this.childNodes.forEach(node => { node.parentNode = null; }); this.childNodes = []; this.html = String(html); this.replacements++; parse(this, this.html); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, force) { const on = force === undefined ? !this.hasAttribute(name) : Boolean(force); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on; }
    append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? new Text(node) : node); }
    appendChild(node) { detach(node); node.parentNode = this; this.childNodes.push(node); if (this === document.head && node.nodeType === 1) { document.assets.push(node); document.onAsset(node); } return node; }
    insertBefore(node, before) { detach(node); const index = before ? this.childNodes.indexOf(before) : -1; node.parentNode = this; if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node); return node; }
    replaceChildren(...nodes) { this.childNodes.forEach(node => { node.parentNode = null; }); this.childNodes = []; this.html = ''; this.append(...nodes); }
    remove() { detach(this); }
    after(node) { const parent = this.parentNode; detach(node); parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, node); node.parentNode = parent; }
    replaceWith(node) { const parent = this.parentNode; detach(node); parent.childNodes.splice(parent.childNodes.indexOf(this), 1, node); node.parentNode = parent; this.parentNode = null; }
    contains(node) { let cursor = node; while (cursor) { if (cursor === this) return true; cursor = cursor.parentNode; } return false; }
    matches(selector) { return matches(this, selector); }
    closest(selector) { let cursor = this; while (cursor?.nodeType === 1) { if (matches(cursor, selector)) return cursor; cursor = cursor.parentNode; } return null; }
    querySelectorAll(selector) { const found = []; const walk = node => { for (const child of node.children) { if (matches(child, selector)) found.push(child); walk(child); } }; walk(this); return found; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== listener); }
    dispatchEvent(event) { event.target ||= this; event.currentTarget = this; for (const listener of this.listeners[type(event)] || []) listener(event); return true; }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    click() { this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} }); }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  const type = event => event.type;
  function parse(root, html) {
    const stack = [root];
    for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
      const [, closing, tag, attributes, selfClosing, text] = match, parent = stack.at(-1);
      if (text !== undefined) { if (parent.tagName === 'TEXTAREA') { parent.value = parent.defaultValue = decode(text); } parent.childNodes.push(Object.assign(new Text(decode(text)), { parentNode: parent })); continue; }
      const name = tag.toLowerCase();
      if (closing) { while (stack.length > 1 && stack.pop().tagName !== name.toUpperCase()); continue; }
      const node = new Element(name);
      for (const [, key, value] of (attributes || '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.setAttribute(key, decode(value ?? ''));
      if (node.hasAttribute('value')) node.value = node.defaultValue = node.getAttribute('value');
      if (node.hasAttribute('checked')) node.checked = node.defaultChecked = true;
      node.parentNode = parent; parent.childNodes.push(node);
      if (!VOID.has(name) && !selfClosing) stack.push(node);
    }
    for (const select of root.querySelectorAll('select')) { const options = select.querySelectorAll('option'); const chosen = options.find(option => option.hasAttribute('selected')) || options[0]; select.value = select.defaultValue = chosen?.getAttribute('value') ?? ''; }
  }
  Object.assign(document, {
    createElement: tag => new Element(tag),
    createTextNode: text => new Text(text),
    addEventListener(event, listener) { (this.listeners[event] ||= []).push(listener); },
    removeEventListener() {},
    dispatch(event) { for (const listener of this.listeners[event.type] || []) listener(event); },
    querySelector(selector) { return this.documentElement.querySelector(selector); },
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); },
    getElementById(id) { return this.documentElement.querySelector('#' + id); },
    Node, Element, Text,
  });
  document.documentElement = new Element('html');
  document.head = new Element('head');
  document.body = new Element('body');
  document.documentElement.append(document.head, document.body);
  return document;
}

export function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] ?? null, get length() { return values.size; }, values,
  };
}

export const NOW = Date.parse('2026-09-22T18:00:00.000Z');
export class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

// Browser-like globals for employee-suite.js (and optionally the registry) running in one vm context.
// business and owner model the signed-in server profile (/api/hub-auth businessAccess and owner), which
// rememberHubProfile stores as egc_business_access and egc_owner; the default viewer is the owner.
export function hubPage({ user = 'ZacB', business = true, role = 'owner', owner = business && role === 'owner', search = '', fetcher, loadRegistry = true, before } = {}) {
  const document = createDocument(), timers = [], events = {}, calls = [], toasts = [], history = [];
  const session = storage({ egc_u: user, egc_business_access: business ? 'true' : 'false', egc_owner: owner ? 'true' : 'false', egc_role: role, egc_name: user });
  const location = { href: 'https://easygaragecleaning.com/employee' + search, pathname: '/employee', search, hash: '' };
  const setUrl = url => { const next = new URL(url, location.href); location.href = next.href; location.search = next.search; location.pathname = next.pathname; };
  const context = {
    console, URL, URLSearchParams, Intl, Promise, Set, Map, Error, JSON, Object, Array, Math, Symbol, AbortController, structuredClone, crypto, queueMicrotask,
    Date: FixedDate, Node: document.Node, document, location, navigator: {}, innerWidth: 390, me: user, jobsCache: [],
    sessionStorage: session, localStorage: storage(),
    setTimeout: (callback, delay = 0) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    addEventListener(name, listener) { (events[name] ||= []).push(listener); }, removeEventListener() {},
    history: {
      pushState(state, title, url) { history.push({ method: 'push', state, url }); setUrl(url); },
      replaceState(state, title, url) { history.push({ method: 'replace', state, url }); setUrl(url); },
    },
    showToast: text => toasts.push(String(text)),
    FormData: class {
      constructor(form) { this.entries = form.querySelectorAll('input,textarea,select').filter(field => field.name && !(['checkbox', 'radio'].includes(field.type) && !field.checked)).map(field => [field.name, field.value]); }
      forEach(callback) { this.entries.forEach(([key, value]) => callback(value, key)); }
      has(key) { return this.entries.some(([name]) => name === key); }
      get(key) { return this.entries.find(([name]) => name === key)?.[1] ?? null; }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    },
    hubFetch: async (url, init = {}) => { calls.push({ url, method: init.method || 'GET' }); return fetcher ? fetcher(url, init) : { ok: false, status: 503, json: async () => ({ ok: false, error: 'Synthetic service unavailable' }) }; },
  };
  context.window = context;
  const dashboard = document.createElement('div');
  dashboard.id = 'dashboard';
  document.body.append(dashboard, Object.assign(document.createElement('div'), { id: 'toast' }));
  before?.(context);
  vm.createContext(context);
  if (loadRegistry) vm.runInContext(readFileSync(new URL('../../employee-hub-screens.js', import.meta.url), 'utf8'), context, { filename: 'employee-hub-screens.js' });
  const exposed = 'globalThis.ui={S,render,go,install,visibleNav,canView,hubCapabilities,actionModal,askAction,loadAll,loadGhl};})();';
  const source = readFileSync(new URL('../../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, exposed);
  vm.runInContext(source, context, { filename: 'employee-suite.js' });
  const fire = (name, event = {}) => { for (const listener of events[name] || []) listener({ type: name, ...event }); };
  const flush = async (rounds = 25) => { for (let index = 0; index < rounds; index++) await Promise.resolve(); };
  const runTimers = async () => { while (timers.length) { timers.shift().callback(); await flush(); } };
  return { context, document, api: context.ui, events, fire, calls, toasts, history, timers, flush, runTimers, session, location, main: () => document.querySelector('#ops-main') };
}
