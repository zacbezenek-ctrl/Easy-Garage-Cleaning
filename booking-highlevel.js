/* Progressive enhancement only. Set data-highlevel-form-url on .quote-form
 * only after the public form and delivery workflow have passed verification. */
(function (root) {
  'use strict';
  function verifiedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['api.leadconnectorhq.com', 'links.easygaragecleaning.com'].includes(url.hostname) &&
        /^\/widget\/form\/[A-Za-z0-9_-]+$/.test(url.pathname) && !url.search && !url.hash &&
        !url.username && !url.password && !url.port ? url.href : null;
    } catch { return null; }
  }
  // Reuse the campaign values the existing capture script already retains.
  // Never forward arbitrary page query data, contact details, tokens, or cookies.
  function attributedUrl(value, pageUrl, storage) {
    const base = verifiedUrl(value);
    if (!base) return null;
    let query;
    try { query = new URL(pageUrl === undefined ? root.location.href : pageUrl).searchParams; }
    catch { query = new URLSearchParams(); }
    if (storage === undefined) { try { storage = root.localStorage; } catch {} }
    const target = new URL(base);
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'msclkid']) {
      const values = query.getAll(key);
      if (values.length > 1) continue;
      let candidate = values[0];
      if (candidate === undefined) { try { candidate = storage?.getItem('egc_' + key); } catch {} }
      if (typeof candidate === 'string' && candidate.length <= 512 && candidate.trim() && !/[\u0000-\u001f\u007f]/.test(candidate)) {
        target.searchParams.set(key, candidate);
        if (target.href.length > 4096) target.searchParams.delete(key);
      }
    }
    return target.href;
  }
  function mount(card) {
    const url = verifiedUrl(card.dataset.highlevelFormUrl);
    if (!url || card.querySelector('.ghl-booking')) return;
    const doc = card.ownerDocument;
    const shell = doc.createElement('section');
    shell.className = 'ghl-booking';
    shell.setAttribute('aria-label', 'Request a free walkthrough');
    const header = doc.createElement('header');
    header.className = 'ghl-booking-header';
    const logo = doc.createElement('img');
    logo.className = 'ghl-booking-logo';
    logo.src = '/images/brand/egc-logo-horizontal-white-368.png';
    logo.alt = 'Easy Garage Cleaning';
    logo.width = 184; logo.height = 44;
    const eyebrow = doc.createElement('p');
    eyebrow.className = 'ghl-booking-eyebrow';
    eyebrow.textContent = 'Garage cleanouts · Junk removal · Organization';
    const heading = doc.createElement('h2');
    heading.textContent = 'Request your free walkthrough';
    const intro = doc.createElement('p');
    intro.className = 'ghl-booking-intro';
    intro.textContent = 'Tell us what you need. We will contact you to confirm the details and a walkthrough time. No pressure. No obligation.';
    header.append(logo, eyebrow, heading, intro);
    const body = doc.createElement('div');
    body.className = 'ghl-booking-body';
    const note = doc.createElement('p');
    note.className = 'ghl-booking-note';
    note.textContent = 'Choose your service in the form below. Your request does not confirm an appointment.';
    const status = doc.createElement('p');
    status.className = 'ghl-booking-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Loading the request form…';
    const frame = doc.createElement('iframe');
    frame.className = 'ghl-booking-frame';
    frame.title = 'Easy Garage Cleaning walkthrough request';
    frame.referrerPolicy = 'no-referrer';
    const nativeLink = doc.createElement('a');
    nativeLink.className = 'ghl-booking-direct';
    nativeLink.href = attributedUrl(url);
    nativeLink.target = '_blank';
    nativeLink.rel = 'noopener noreferrer';
    nativeLink.textContent = 'Open the form in a new tab';
    const recovery = doc.createElement('details');
    recovery.className = 'ghl-booking-recovery';
    const summary = doc.createElement('summary');
    summary.textContent = 'Having trouble with the form?';
    const caution = doc.createElement('p');
    caution.textContent = 'If you already submitted, call us before sending another request.';
    const actions = doc.createElement('div');
    actions.className = 'ghl-booking-actions';
    const retry = doc.createElement('button');
    retry.type = 'button'; retry.textContent = 'Reload request form';
    const fallback = doc.createElement('button');
    fallback.type = 'button'; fallback.textContent = 'Use the standard request form';
    const help = doc.createElement('a');
    help.className = 'ghl-booking-call';
    help.href = 'tel:+19709991818'; help.textContent = 'Call (970) 999-1818';
    const children = [...card.children];
    const restore = () => {
      clearTimeout(timer); frame.removeAttribute('src'); shell.remove();
      card.classList.remove('ghl-enabled');
      children.forEach(child => { child.hidden = originalHidden.get(child); });
      const selectedChoice = card.querySelector('.form-panel.active input[type="radio"]:checked');
      const firstField = selectedChoice || card.querySelector('.form-panel.active select, .form-panel.active input:not([type="hidden"]):not([type="radio"]), .form-panel.active button');
      firstField?.focus();
    };
    const originalHidden = new Map(children.map(child => [child, child.hidden]));
    let timer;
    const load = () => {
      clearTimeout(timer);
      status.textContent = 'Loading the request form…';
      // A load event cannot prove a cross-origin form rendered or submitted.
      timer = setTimeout(() => { status.textContent = 'Taking longer than expected? Reload or use the standard form below. If you already submitted, call us before sending another request.'; }, 15000);
      frame.src = attributedUrl(url);
    };
    frame.addEventListener('load', () => {
      clearTimeout(timer);
      status.textContent = 'If the form is blank or does not respond, open it in a new tab or use the options below.';
    });
    frame.addEventListener('error', () => { clearTimeout(timer); status.textContent = 'The request form could not load. Use the standard form below or call us.'; });
    retry.addEventListener('click', load);
    fallback.addEventListener('click', restore);
    actions.append(retry, fallback);
    recovery.append(summary, caution, actions);
    body.append(note, frame, status, nativeLink, recovery, help);
    shell.append(header, body);
    children.forEach(child => { child.hidden = true; });
    card.classList.add('ghl-enabled');
    card.prepend(shell); load();
  }
  root.EGCBookingHighLevel = Object.freeze({ verifiedUrl, attributedUrl, mount });
  if (typeof document !== 'undefined') document.querySelectorAll('.book-page .quote-form[data-highlevel-form-url]').forEach(mount);
})(globalThis);
