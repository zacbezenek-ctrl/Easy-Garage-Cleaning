/* Optional crew tip on a card balance payment: 10/15/20% chips, a custom
   amount and "No tip" (the default). Shared by the customer portal and crew
   closeout. Money is whole cents; the server checks the tip limit again and
   never trusts this picker. DOM is built with h() and textContent only. */
(function () {
  'use strict';
  const PRESETS = [10, 15, 20];
  const usd = cents => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
    return node;
  }
  /** A percentage of the balance being paid, rounded to the cent. */
  const percentCents = (balanceCents, percent) => Math.round(Math.max(0, balanceCents) * percent / 100);
  /** Dollars typed by the customer as whole cents: '' is 0, and unreadable text is null. */
  function parseDollars(text) {
    const raw = String(text ?? '').trim().replace(/^\$\s*/, '').replace(/,/g, '');
    if (!raw) return 0;
    if (!/^(?:\d{1,6}(?:\.\d{0,2})?|\.\d{1,2})$/.test(raw)) return null;
    const [whole, part = ''] = raw.split('.');
    return Number(whole || 0) * 100 + Number((part + '00').slice(0, 2));
  }

  /** Mounts the picker in `host`; onChange(cents) gets the chosen tip, or null while a custom amount is invalid. */
  function mount(host, { balanceCents = 0, maxCents = 0, presets = PRESETS, onChange = () => {}, idPrefix = 'egc-tip' } = {}) {
    const state = { choice: 'none', custom: '', balanceCents, maxCents, presets: presets.filter(value => Number.isInteger(value) && value > 0 && value <= 100).slice(0, 4) };
    const chips = new Map(), inputId = `${idPrefix}-custom`, errorId = `${idPrefix}-error`, titleId = `${idPrefix}-title`;
    const input = h('input', { id: inputId, class: 'egc-tip-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', placeholder: '0.00', 'aria-describedby': errorId, oninput: () => { state.custom = input.value; emit(); } });
    const customRow = h('div', { class: 'egc-tip-custom', hidden: true }, h('label', { for: inputId, text: 'Tip amount' }), h('div', { class: 'egc-tip-field' }, h('span', { 'aria-hidden': 'true', text: '$' }), input));
    const error = h('p', { id: errorId, class: 'egc-tip-error', role: 'alert' });
    const summary = h('p', { class: 'egc-tip-summary', 'aria-live': 'polite' });
    const chip = (key, label) => { const button = h('button', { type: 'button', class: 'egc-tip-chip', 'aria-pressed': 'false', onclick: () => choose(key) }, h('b', { text: label }), h('small')); chips.set(key, button); return button; };
    const grid = h('div', { class: 'egc-tip-chips' }, ...state.presets.map(value => chip(String(value), `${value}%`)), chip('custom', 'Custom'), chip('none', 'No tip'));
    const root = h('div', { class: 'egc-tip', role: 'group', 'aria-labelledby': titleId },
      h('p', { id: titleId, class: 'egc-tip-title' }, 'Add a tip for your crew ', h('span', { text: '(optional)' })), grid, customRow, error, summary,
      h('p', { class: 'egc-tip-note', text: 'Tips go to the crew who did the work and are not part of the service total.' }));
    host.replaceChildren(root);

    function value() {
      if (state.choice === 'none') return 0;
      const cents = state.choice === 'custom' ? parseDollars(state.custom) : percentCents(state.balanceCents, Number(state.choice));
      return cents === null || cents > state.maxCents ? null : cents;
    }
    function paint() {
      for (const [key, button] of chips) {
        button.setAttribute('aria-pressed', String(key === state.choice));
        const small = button.querySelector('small');
        small.textContent = /^\d+$/.test(key) ? usd(percentCents(state.balanceCents, Number(key))) : '';
        button.disabled = /^\d+$/.test(key) && percentCents(state.balanceCents, Number(key)) > state.maxCents;
      }
      customRow.hidden = state.choice !== 'custom';
      const cents = value(), typed = state.choice === 'custom' ? parseDollars(state.custom) : 0;
      error.textContent = cents !== null ? '' : typed === null ? 'Enter the tip in dollars and cents, like 25 or 25.50.' : `A tip can be at most ${usd(state.maxCents)} on this balance.`;
      summary.textContent = cents > 0 ? `${usd(cents)} tip for your crew, charged with ${usd(state.balanceCents)} balance: ${usd(state.balanceCents + cents)} total.` : '';
    }
    function emit() { paint(); onChange(value()); }
    function choose(key) {
      state.choice = key; emit();
      if (key === 'custom') input.focus();
    }
    paint();
    return {
      value,
      /** New balance or limit (the portal refreshes): the choice stays, and a percentage follows the new balance. */
      update(next = {}) {
        const changed = next.balanceCents !== undefined && next.balanceCents !== state.balanceCents || next.maxCents !== undefined && next.maxCents !== state.maxCents;
        Object.assign(state, { balanceCents: next.balanceCents ?? state.balanceCents, maxCents: next.maxCents ?? state.maxCents });
        if (changed) emit();
      },
      reset() { state.choice = 'none'; state.custom = ''; input.value = ''; emit(); },
      root,
    };
  }

  window.EGCTip = { PRESETS, percentCents, parseDollars, mount };
})();
