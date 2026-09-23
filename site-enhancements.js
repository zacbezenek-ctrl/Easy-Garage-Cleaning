/* Lightweight first-party contact widget. No customer data is collected in-page. */
(function () {
  'use strict';

  var widget = document.getElementById('chat-widget');
  if (!widget) return;

  var toggle = widget.querySelector('.contact-widget-toggle');
  var panel = widget.querySelector('.contact-widget-panel');
  var close = widget.querySelector('.contact-widget-close');
  if (!toggle || !panel) return;

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    widget.classList.toggle('is-open', open);
    if (open) {
      var firstAction = panel.querySelector('a');
      if (firstAction) firstAction.focus();
    }
  }

  toggle.addEventListener('click', function () {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  if (close) close.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', function (event) {
    if (toggle.getAttribute('aria-expanded') === 'true' && !widget.contains(event.target)) setOpen(false);
  });
}());

/* Public customer entry points only. Project access still requires the existing
   private-link flow; this code never reads a token or requests customer data. */
(function () {
  'use strict';

  function makeLink(label, href, className) {
    var link = document.createElement('a');
    link.textContent = label;
    link.href = href;
    if (className) link.className = className;
    return link;
  }

  function installCustomerAccess() {
    var main = document.getElementById('main-content');
    if (!main || document.getElementById('egc-customer-access')) return;
    var portalPath = '/customer-portal';
    var style = document.createElement('style');
    style.id = 'egc-customer-access-style';
    style.textContent =
      '.egc-customer-access{background:#f4f2ec;border-bottom:1px solid #dfe4ea;color:#102d4d;}' +
      '.egc-customer-access-inner{max-width:1200px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}' +
      '.egc-customer-access-label{font-size:13px;font-weight:600;}' +
      '.egc-customer-access-links{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}' +
      '.egc-customer-access-links a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 14px;border:1px solid #102d4d;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;line-height:1.4;}' +
      '.egc-customer-access-links a:last-child{background:#102d4d;color:#fff;}' +
      '.egc-customer-access a:focus-visible{outline:3px solid #d14a17;outline-offset:3px;}' +
      '.egc-business-contact{flex-basis:100%;margin:0;padding-top:10px;border-top:1px solid #d5dce4;font-size:13px;line-height:1.7;}' +
      '.egc-business-contact a{font-weight:600;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere;}' +
      '@media(max-width:520px){.egc-customer-access-inner{padding:12px 16px;}.egc-customer-access-label{flex-basis:100%;}.egc-customer-access-links{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;}.egc-customer-access-links a{padding:8px 10px;font-size:12px;}}';
    document.head.appendChild(style);

    var nav = document.createElement('nav');
    nav.id = 'egc-customer-access';
    nav.className = 'egc-customer-access';
    nav.setAttribute('aria-label', 'Booking and customer portal');
    var inner = document.createElement('div');
    inner.className = 'egc-customer-access-inner';
    var label = document.createElement('span');
    label.className = 'egc-customer-access-label';
    label.textContent = 'Start a project or manage your existing one.';
    var links = document.createElement('div');
    links.className = 'egc-customer-access-links';
    links.appendChild(makeLink('Book a Free Walkthrough', '/book'));
    links.appendChild(makeLink('Customer Portal', portalPath));
    inner.appendChild(label);
    inner.appendChild(links);

    if (/^\/book(?:\.html)?\/?$/.test(window.location.pathname)) {
      var business = document.createElement('p');
      business.className = 'egc-business-contact';
      business.appendChild(document.createTextNode('Business partnerships: Zoe Zoll | '));
      business.appendChild(makeLink('(970) 999-1403', 'tel:+19709991403'));
      business.appendChild(document.createTextNode(' | '));
      business.appendChild(makeLink('zoe.zoll@easygaragecleaning.com', 'mailto:zoe.zoll@easygaragecleaning.com'));
      inner.appendChild(business);
    }
    nav.appendChild(inner);
    // Keep the new navigation inside main so the existing mobile drawer's
    // background inert/focus handling continues to cover these links.
    main.insertBefore(nav, main.firstChild);

    var drawer = document.getElementById('nav-drawer');
    if (drawer && !drawer.querySelector('a[href="' + portalPath + '"]')) {
      drawer.insertBefore(makeLink('Customer Portal', portalPath, 'drawer-link-row'), drawer.querySelector('.drawer-cta'));
    }
    var headings = document.querySelectorAll('footer h3, footer h4');
    for (var i = 0; i < headings.length; i += 1) {
      if (headings[i].textContent.trim().toLowerCase() !== 'company') continue;
      var list = headings[i].parentElement.querySelector('ul');
      if (list && !list.querySelector('a[href="' + portalPath + '"]')) {
        var item = document.createElement('li');
        item.appendChild(makeLink('Customer Portal', portalPath));
        list.appendChild(item);
      }
    }
    var actions = document.querySelector('.contact-widget-actions');
    if (actions && !actions.querySelector('a[href="' + portalPath + '"]')) {
      actions.appendChild(makeLink('Open Customer Portal', portalPath));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installCustomerAccess, { once: true });
  } else {
    installCustomerAccess();
  }
}());
