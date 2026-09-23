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

/* Add gallery discovery without changing customer-approved project links or form behavior. */
(function () {
  'use strict';
  var path = '/before-after';
  function addLink(parent, asList, label, className) {
    if (!parent || parent.querySelector('a[href="' + path + '"]')) return;
    var link = document.createElement('a');
    link.href = path;
    link.textContent = label;
    if (className) link.className = className;
    if (asList) {
      var item = document.createElement('li');
      item.appendChild(link);
      parent.appendChild(item);
    } else parent.appendChild(link);
  }
  var gallery = document.querySelector('#work > .wrap');
  if (gallery && !gallery.querySelector('a[href="' + path + '"]')) {
    var paragraph = document.createElement('p');
    paragraph.style.marginTop = '24px';
    addLink(paragraph, false, 'Explore the before & after gallery →', 'btn-primary');
    gallery.appendChild(paragraph);
  }
  document.querySelectorAll('.foot-col').forEach(function (column) {
    var heading = column.querySelector('h3');
    if (heading && heading.textContent.trim() === 'Company') addLink(column.querySelector('ul'), true, 'Before & After');
  });
}());
