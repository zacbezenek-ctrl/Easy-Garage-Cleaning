/* Full-size comparison for reviewed AI concepts; no generation or customer data. */
(function () {
  'use strict';
  var grid = document.getElementById('gallery-grid');
  if (!grid || !window.HTMLDialogElement) return;
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  var dialog = element('dialog');
  dialog.id = 'concept-dialog';
  dialog.setAttribute('aria-labelledby', 'concept-modal-title');
  var top = element('div', 'dialog-top');
  var title = element('h2', '', 'Before and after concept');
  title.id = 'concept-modal-title';
  var close = element('button', '', 'Close ×'); close.type = 'button';
  close.setAttribute('aria-label', 'Close concept comparison');
  top.append(title, close); dialog.appendChild(top);
  var compare = element('div', 'compare');
  var after = element('picture', 'compare-after');
  var before = element('picture', 'compare-before');
  var afterImage = new Image(), beforeImage = new Image();
  after.appendChild(afterImage); before.appendChild(beforeImage);
  var beforeLabel = element('span', 'photo-label label-before', 'Before concept');
  var afterLabel = element('span', 'photo-label label-after', 'After concept');
  var line = element('div', 'compare-line'); line.setAttribute('aria-hidden', 'true');
  line.appendChild(element('span', '', '↔'));
  compare.append(after, before, beforeLabel, afterLabel, line);
  dialog.appendChild(compare);
  var controls = element('div', 'compare-controls');
  var label = element('label', '', 'Slide to compare'); label.htmlFor = 'concept-range';
  var range = element('input'); range.id = 'concept-range'; range.type = 'range';
  range.min = '0'; range.max = '100'; range.value = '50';
  range.setAttribute('aria-label', 'Amount of before concept shown');
  var buttons = element('div', 'compare-buttons');
  [['Before', 100], ['Compare', 50], ['After', 0]].forEach(function (option) {
    var button = element('button', '', option[0]); button.type = 'button';
    button.addEventListener('click', function () { reveal(option[1]); });
    buttons.appendChild(button);
  });
  controls.append(label, range, buttons); dialog.appendChild(controls);
  dialog.appendChild(element('p', 'concept-modal-note', 'AI-generated design concept. These are simulated images, not photographs of a completed EGC job.'));
  document.body.appendChild(dialog);
  function reveal(value) {
    value = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (!Number.isFinite(value)) return;
    range.value = String(value); compare.style.setProperty('--reveal', value + '%');
    range.setAttribute('aria-valuetext', value + ' percent before concept');
    beforeLabel.hidden = value === 0; afterLabel.hidden = value === 100;
  }
  range.addEventListener('input', function () { reveal(range.value); });
  var pointer = null;
  function drag(event) {
    var box = compare.getBoundingClientRect();
    if (box.width) reveal((event.clientX - box.left) / box.width * 100);
  }
  compare.addEventListener('pointerdown', function (event) {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = event.pointerId; compare.setPointerCapture(pointer); drag(event);
  });
  compare.addEventListener('pointermove', function (event) { if (pointer === event.pointerId) drag(event); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (name) {
    compare.addEventListener(name, function () { pointer = null; });
  });
  var returnFocus;
  close.addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () { if (returnFocus) returnFocus.focus(); });
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    var box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  function addButtons() {
    grid.querySelectorAll('.gallery-card[data-category="concept"]').forEach(function (card) {
      if (card.querySelector('.concept-open')) return;
      var button = element('button', 'button concept-open', 'Compare full size ↗');
      button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog');
      card.querySelector('.card-copy').appendChild(button);
    });
  }
  grid.addEventListener('click', function (event) {
    var button = event.target.closest('.concept-open');
    if (!button || !grid.contains(button)) return;
    var card = button.closest('.gallery-card');
    var images = card.querySelectorAll('.concept-pair img');
    if (images.length !== 2 || !images[0].naturalWidth || !images[1].naturalWidth) return;
    title.textContent = card.querySelector('h3').textContent;
    beforeImage.src = images[0].currentSrc || images[0].src; beforeImage.alt = images[0].alt;
    afterImage.src = images[1].currentSrc || images[1].src; afterImage.alt = images[1].alt;
    returnFocus = button; reveal(50); dialog.showModal(); close.focus();
  });
  addButtons();
  new MutationObserver(addButtons).observe(grid, { childList: true });
}());
