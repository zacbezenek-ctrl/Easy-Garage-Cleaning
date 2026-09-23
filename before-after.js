/* Gallery enhancement only. No customer records, form submissions, or conversion events. */
(function () {
  'use strict';
  var grid = document.getElementById('gallery-grid');
  if (!grid) return;
  var filters = document.getElementById('filter-bar');
  var count = document.getElementById('gallery-count');
  var selected = 'all';
  function applyFilter(value) {
    selected = value;
    var visible = 0;
    grid.querySelectorAll('.gallery-card').forEach(function (card) {
      var categories = (card.dataset.category || '').split(' ');
      card.hidden = value !== 'all' && categories.indexOf(value) === -1;
      if (!card.hidden) visible++;
    });
    filters.querySelectorAll('[data-filter]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === value));
    });
    count.textContent = visible + (visible === 1 ? ' photo set' : ' photo sets');
  }
  filters.hidden = false;
  filters.addEventListener('click', function (event) {
    var button = event.target.closest('[data-filter]');
    if (button && filters.contains(button)) applyFilter(button.dataset.filter);
  });

  var compare = document.getElementById('featured-compare');
  var range = document.getElementById('compare-range');
  var controls = document.getElementById('compare-controls');
  function reveal(value) {
    value = Math.round(Math.max(0, Math.min(100, Number(value))));
    if (!Number.isFinite(value)) return;
    compare.style.setProperty('--reveal', value + '%');
    range.value = String(value);
    range.setAttribute('aria-valuetext', value + ' percent before image');
    compare.querySelector('.label-before').hidden = value === 0;
    compare.querySelector('.label-after').hidden = value === 100;
  }
  if (compare && range && controls) {
    controls.hidden = false;
    range.addEventListener('input', function () { reveal(range.value); });
    controls.querySelectorAll('[data-reveal]').forEach(function (button) {
      button.addEventListener('click', function () { reveal(button.dataset.reveal); });
    });
    var pointer = null;
    function updatePointer(event) {
      var bounds = compare.getBoundingClientRect();
      if (bounds.width) reveal((event.clientX - bounds.left) / bounds.width * 100);
    }
    compare.addEventListener('pointerdown', function (event) {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      pointer = event.pointerId;
      compare.setPointerCapture(pointer);
      updatePointer(event);
    });
    compare.addEventListener('pointermove', function (event) {
      if (pointer === event.pointerId) updatePointer(event);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (name) {
      compare.addEventListener(name, function () { pointer = null; });
    });
  }

  var dialog = document.getElementById('photo-dialog');
  var dialogImage = document.getElementById('dialog-image');
  var returnFocus = null;
  if (dialog && typeof dialog.showModal === 'function') {
    document.querySelectorAll('[data-lightbox]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        returnFocus = link;
        dialogImage.src = link.href;
        dialogImage.alt = link.querySelector('img').alt;
        document.getElementById('dialog-title').textContent = link.dataset.title;
        dialog.showModal();
        document.getElementById('close-dialog').focus();
      });
    });
    document.getElementById('close-dialog').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) {
      if (event.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', function () { if (returnFocus) returnFocus.focus(); });
  }

  // Empty, pending, unreviewed, or malformed concept entries never become public cards.
  // Only first-party, raster image paths are accepted. Never render manifest HTML.
  var imagePath = /^\/images\/before-after\/concepts\/[a-z0-9][a-z0-9-]*\.(webp|jpg|jpeg|png)$/;
  function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
  function validConcept(item) {
    return item && item.type === 'concept' && item.status === 'published' && item.visualReviewPassed === true &&
      text(item.id, 80) && /^[a-z0-9-]+$/.test(item.id) && text(item.title, 120) &&
      text(item.caption, 360) && imagePath.test(item.before || '') && imagePath.test(item.after || '');
  }
  function loadedImage(src, alt) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.alt = alt;
      image.decoding = 'async';
      image.onload = function () {
        if (image.naturalWidth < 300 || image.naturalHeight < 250) reject(new Error('Concept image too small'));
        else resolve(image);
      };
      image.onerror = function () { reject(new Error('Concept image unavailable')); };
      image.src = src;
    });
  }
  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value) element.textContent = value;
    return element;
  }
  async function buildConcept(item) {
    var images = await Promise.all([
      loadedImage(item.before, 'AI-generated before concept: ' + item.title),
      loadedImage(item.after, 'AI-generated after concept: ' + item.title)
    ]);
    var card = node('article', 'gallery-card');
    card.dataset.category = 'concept';
    card.appendChild(node('span', 'concept-badge', 'AI-generated concept · Not a customer job'));
    var pair = node('div', 'concept-pair');
    ['Before concept', 'After concept'].forEach(function (label, index) {
      var figure = node('figure');
      images[index].width = images[index].naturalWidth;
      images[index].height = images[index].naturalHeight;
      figure.appendChild(images[index]);
      figure.appendChild(node('figcaption', '', label));
      pair.appendChild(figure);
    });
    card.appendChild(pair);
    var copy = node('div', 'card-copy');
    copy.appendChild(node('h3', '', item.title));
    copy.appendChild(node('p', '', item.caption));
    copy.appendChild(node('p', 'photo-note', 'Simulated organization idea. Not a completed EGC project.'));
    card.appendChild(copy);
    return card;
  }
  async function loadConcepts() {
    try {
      var response = await fetch('/before-after-concepts.json', { cache: 'no-cache', credentials: 'omit' });
      if (!response.ok) return;
      var data = await response.json();
      if (data.schemaVersion !== 1 || !Array.isArray(data.concepts)) return;
      var seen = new Set();
      var items = data.concepts.filter(function (item) {
        if (!validConcept(item) || seen.has(item.id)) return false;
        seen.add(item.id); return true;
      }).slice(0, 48);
      // Load small groups rather than flooding mobile connections with 96 simultaneous images.
      var shown = 0;
      for (var start = 0; start < items.length; start += 3) {
        var results = await Promise.allSettled(items.slice(start, start + 3).map(buildConcept));
        results.forEach(function (result) {
          if (result.status === 'fulfilled') { grid.appendChild(result.value); shown++; }
        });
        if (shown) {
          filters.querySelector('[data-filter="concept"]').hidden = false;
          document.getElementById('concept-disclosure').hidden = false;
          applyFilter(selected);
        }
      }
    } catch (_) { /* Existing photos and booking remain usable if the optional concept feed is unavailable. */ }
  }
  loadConcepts();
}());
