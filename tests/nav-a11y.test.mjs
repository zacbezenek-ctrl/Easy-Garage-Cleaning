import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from './helpers/vm-realm.mjs';
import { sourceFiles } from './source-files.mjs';
import { renderPublicGallery } from '../functions/before-after.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// Mirrors PRIVATE_HTML / PRIVATE_DIRS in _generate_site.py.
const privateNames = new Set(['business-hub.html', 'client-login.html', 'copilot.html', 'customer-portal.html', 'dispatch.html', 'hub-login-setup.html', 'message-templates.html', 'quote.html', 'sop.html', 'tyler-contract.html']);
const privateDirs = new Set(['crew', 'contracts', 'docs', 'egc-platform', 'functions', 'tests', 'tools', 'scripts', 'auth-verifier', 'internal-gallery-assets', 'venv', 'field-qa', 'test-results', 'dist', 'node_modules']);
const isPrivateDir = part => part.startsWith('.') || privateDirs.has(part);
const publicPages = sourceFiles(root)
  .map(entry => relative(root, join(entry.parentPath, entry.name)))
  .filter(rel => rel.endsWith('.html'))
  .filter(rel => !privateNames.has(rel.split(sep).at(-1)) && !rel.split(sep).at(-1).startsWith('employee'))
  .filter(rel => !rel.split(sep).slice(0, -1).some(isPrivateDir))
  .map(rel => ({ rel, html: readFileSync(join(root, rel), 'utf8') }));
const pages = [...publicPages, { rel: 'functions/before-after.js renderPublicGallery()', html: renderPublicGallery() }];
const drawerPages = pages.filter(page => page.html.includes('<aside class="nav-drawer"'));
const INIT = /function initNavDrawer\(\)\{[\s\S]*?\n\}\s*if\(document\.readyState==='loading'\)\{document\.addEventListener\('DOMContentLoaded',initNavDrawer\);\}else\{initNavDrawer\(\);\}/;

class FakeElement {
  constructor(document, tagName, className = '') {
    this.document = document; this.tagName = tagName.toUpperCase(); this.classes = new Set(className.split(' ').filter(Boolean));
    this.attributes = {}; this.listeners = {}; this.children = []; this.dataset = {}; this.hidden = false; this.offsetParent = {}; this.inert = false;
    this.classList = { toggle: (name, force) => { const on = force === undefined ? !this.classes.has(name) : Boolean(force); if (on) this.classes.add(name); else this.classes.delete(name); return on; }, contains: name => this.classes.has(name) };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type, init = {}) { const event = { ...init, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } }; for (const listener of this.listeners[type] || []) listener(event); return event; }
  focus() { this.document.activeElement = this; }
  querySelectorAll(selector) {
    const tags = new Set(selector.split(',').map(part => part.trim().match(/^[a-z]+/)?.[0]?.toUpperCase()).filter(Boolean));
    return this.children.filter(child => tags.has(child.tagName));
  }
}

function fakePage() {
  const document = { readyState: 'complete', activeElement: null, listeners: {} };
  document.addEventListener = (type, listener) => { (document.listeners[type] ||= []).push(listener); };
  document.keydown = init => { const event = { ...init, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } }; for (const listener of document.listeners.keydown || []) listener(event); return event; };
  const make = (tag, className) => new FakeElement(document, tag, className);
  const toggle = make('button', 'nav-toggle'), overlay = make('div', 'nav-overlay'), drawer = make('aside', 'nav-drawer');
  const close = make('button', 'nav-drawer-close'), phone = make('a', 'drawer-phone'), cta = make('a', 'drawer-cta');
  drawer.children = [close, phone, cta];
  const header = make('nav', 'nav'), main = make('main'), footer = make('footer', 'site-footer'), script = make('script');
  header.children = [toggle];
  document.body = { children: [header, overlay, drawer, main, footer, script], classList: make('body').classList };
  const byId = { 'nav-drawer': drawer, 'nav-overlay': overlay };
  const bySelector = { '.nav-toggle': toggle, '.nav-drawer-close': close };
  document.getElementById = id => byId[id] || null;
  document.querySelector = selector => bySelector[selector] || null;
  document.querySelectorAll = () => [];
  return { document, toggle, overlay, drawer, close, phone, cta, background: [header, main, footer], script };
}

function exerciseDrawer(source, label) {
  const page = fakePage();
  vm.runInNewContext(source, { document: page.document, setTimeout: fn => fn(), Array });
  const { document, toggle, drawer, close, cta, background } = page;
  assert.equal(drawer.inert, true, `${label}: a closed drawer must be inert after init`);

  toggle.focus();
  toggle.dispatch('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', label);
  assert.equal(drawer.getAttribute('aria-hidden'), 'false', label);
  assert.equal(drawer.inert, false, `${label}: an open drawer must be interactive`);
  assert.ok(background.every(el => el.inert), `${label}: page behind the open drawer must be inert`);
  assert.equal(document.activeElement, close, `${label}: focus moves into the drawer`);

  cta.focus();
  assert.equal(document.keydown({ key: 'Tab' }).defaultPrevented, true, label);
  assert.equal(document.activeElement, close, `${label}: Tab wraps from the last drawer item to the first`);
  document.keydown({ key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, cta, `${label}: Shift+Tab wraps from the first drawer item to the last`);

  document.keydown({ key: 'Escape' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', label);
  assert.equal(drawer.getAttribute('aria-hidden'), 'true', label);
  assert.equal(drawer.inert, true, `${label}: closing makes the drawer inert again`);
  assert.ok(background.every(el => !el.inert), `${label}: page is interactive again after closing`);
  assert.equal(document.activeElement, toggle, `${label}: focus returns to the menu button`);

  const outside = new FakeElement(document, 'a'); outside.focus();
  assert.equal(document.keydown({ key: 'Tab' }).defaultPrevented, false, `${label}: a closed drawer never traps Tab`);
  assert.equal(document.keydown({ key: 'Escape' }).defaultPrevented, false, label);
  assert.equal(document.activeElement, outside, `${label}: Escape with a closed drawer leaves focus alone`);
}

test('every public nav drawer ships closed and inert', () => {
  assert.ok(drawerPages.length >= 60, `expected the whole marketing site, found ${drawerPages.length} drawer pages`);
  const failures = [];
  for (const page of drawerPages) {
    for (const [tag] of page.html.matchAll(/<aside class="nav-drawer"[^>]*>/g)) {
      if (!/\sinert(?=[\s>])/.test(tag)) failures.push(`${page.rel}: ${tag}`);
      if (!/aria-hidden="true"/.test(tag)) failures.push(`${page.rel}: drawer must start aria-hidden`);
    }
  }
  assert.deepEqual(failures, []);
});

test('every drawer page runs the one shared init that toggles drawer.inert', () => {
  const variants = new Map();
  for (const page of drawerPages) {
    const init = page.html.match(INIT)?.[0];
    if (init) { variants.set(init, [...(variants.get(init) || []), page.rel]); continue; }
    assert.match(page.html, /<script[^>]+src="\/gallery-simple\.js\?v=[^"]+"/, `${page.rel} has a drawer but no drawer script`);
  }
  assert.equal(variants.size, 1, `drawer init drifted between pages: ${[...variants.values()].map(list => list[0]).join(', ')}`);
  exerciseDrawer([...variants.keys()][0], 'shared initNavDrawer');
});

test('the public gallery drawer script follows the same focus contract', () => {
  exerciseDrawer(readFileSync(join(root, 'gallery-simple.js'), 'utf8'), 'gallery-simple.js');
});

test('footer links are 44px tap targets on phones on every page with the site footer', () => {
  const failures = [];
  for (const page of pages.filter(page => page.html.includes('class="site-footer"'))) {
    const style = page.html.match(/<style id="footer-tap">([\s\S]*?)<\/style>/)?.[1];
    if (!style) { failures.push(page.rel); continue; }
    // Every link group in the shared footer: brand/contact/partner links, columns and the bottom bar.
    const rule = style.match(/@media\(max-width:640px\)\{([^{]*)\{([^}]*)\}\}/);
    assert.ok(rule, `${page.rel}: footer tap rule must be a max-width:640px media query`);
    assert.deepEqual(rule[1].split(',').sort(), ['.site-footer .foot-bar a', '.site-footer .foot-brand a', '.site-footer .foot-col a'], page.rel);
    assert.match(rule[2], /min-height:44px/, page.rel);
    assert.ok(page.html.indexOf('<style id="footer-tap">') < page.html.indexOf('</head>'), `${page.rel}: tap-target rule belongs in <head>`);
  }
  assert.deepEqual(failures, []);
});
