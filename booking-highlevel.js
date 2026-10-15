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
      if (typeof candidate === 'string' && candidate.length <= 512 && candidate.trim() && !/[\u0000-\u001f\u007f]/.test(candidate)) target.searchParams.set(key, candidate);
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
    const heading = doc.createElement('h2');
    heading.textContent = 'A fresh start for your garage';
    const intro = doc.createElement('p');
    intro.textContent = 'Tell us what you have in mind. We will contact you to confirm a walkthrough time. Your request does not confirm an appointment.';
    const status = doc.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Loading the request form…';
    const frame = doc.createElement('iframe');
    frame.title = 'Easy Garage Cleaning walkthrough request';
    frame.referrerPolicy = 'no-referrer';
    const retry = doc.createElement('button');
    retry.type = 'button'; retry.textContent = 'Reload request form';
    const fallback = doc.createElement('button');
    fallback.type = 'button'; fallback.textContent = 'Use the standard request form';
    const help = doc.createElement('a');
    help.href = 'tel:+19709991818'; help.textContent = 'Or call (970) 999-1818';
    const children = [...card.children];
    const restore = () => {
      clearTimeout(timer); frame.removeAttribute('src'); shell.remove();
      card.classList.remove('ghl-enabled');
      children.forEach(child => { child.hidden = originalHidden.get(child); });
      card.querySelector('input:not([type="hidden"]):not([hidden]), button, a')?.focus();
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
      status.textContent = 'If the form is blank or does not respond, use the standard form below. If you already submitted, call us before sending another request.';
    });
    frame.addEventListener('error', () => { clearTimeout(timer); status.textContent = 'The request form could not load. Use the standard form below or call us.'; });
    retry.addEventListener('click', load);
    fallback.addEventListener('click', restore);
    shell.append(heading, intro, status, retry, fallback, help, frame);
    children.forEach(child => { child.hidden = true; });
    card.classList.add('ghl-enabled');
    card.prepend(shell); load();
  }
  root.EGCBookingHighLevel = Object.freeze({ verifiedUrl, attributedUrl, mount });
  if (typeof document !== 'undefined') document.querySelectorAll('.book-page .quote-form[data-highlevel-form-url]').forEach(mount);
})(globalThis);
