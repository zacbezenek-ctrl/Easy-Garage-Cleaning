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
