/* Public gallery controls. No customer data, generation, or external requests. */
(function () {
 'use strict';
 var grid = document.getElementById('gallery');
 if (!grid) return;
 var search = document.getElementById('search');
 var dialog = document.getElementById('viewer');
 var returnFocus = null;
 function position(component, value) {
  value = Math.max(0, Math.min(100, Math.round(Number(value))));
  if (!Number.isFinite(value)) return;
  component.style.setProperty('--position', value + '%');
  var input = component.querySelector('input[type="range"]');
  input.value = String(value);
  input.setAttribute('aria-valuetext', value + ' percent before');
  component.querySelector('.label-before').hidden = value === 0;
  component.querySelector('.label-after').hidden = value === 100;
  component.querySelectorAll('[data-position]').forEach(function (button) {
   button.setAttribute('aria-pressed', String(Number(button.dataset.position) === value));
  });
 }
 function wire(component) {
  component.querySelector('.controls').hidden = false;
  component.querySelector('input[type="range"]').addEventListener('input', function (event) { position(component, event.target.value); });
  component.querySelectorAll('[data-position]').forEach(function (button) {
   button.addEventListener('click', function () { position(component, button.dataset.position); });
  });
  var stage = component.querySelector('.image-stage');
  var pointer = null;
  function move(event) {
   var bounds = stage.getBoundingClientRect();
   if (bounds.width) position(component, 100 * (event.clientX - bounds.left) / bounds.width);
  }
  stage.addEventListener('pointerdown', function (event) {
   if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
   pointer = event.pointerId;
   stage.setPointerCapture(pointer);
   move(event);
  });
  stage.addEventListener('pointermove', function (event) { if (pointer === event.pointerId) move(event); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (name) { stage.addEventListener(name, function () { pointer = null; }); });
  position(component, 50);
 }
 function filter() {
  var query = search ? search.value.trim().toLowerCase() : '';
  var count = 0;
  grid.querySelectorAll('.ba-card').forEach(function (card) {
   card.hidden = !(card.dataset.search || '').includes(query);
   if (!card.hidden) count++;
  });
  var countEl=document.getElementById('count'),empty=document.getElementById('empty');
  if(countEl)countEl.textContent=count+' before & after example'+(count===1?'':'s');
  if(empty)empty.hidden=count!==0;
 }
 grid.querySelectorAll('.comparison').forEach(wire);
 if (search) {
  document.getElementById('search-label').hidden = false;
  search.addEventListener('input', filter);
 }
 if (dialog && typeof dialog.showModal === 'function') {
  grid.querySelectorAll('[data-expand]').forEach(function (button) { button.hidden = false; });
  grid.addEventListener('click', function (event) {
   var button = event.target.closest('[data-expand]');
   if (!button || !grid.contains(button)) return;
   var card = button.closest('.ba-card');
   var copy = card.querySelector('.comparison').cloneNode(true);
   copy.querySelectorAll('img').forEach(function (image) {
    image.loading = 'eager';
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
   });
   document.getElementById('viewer-title').textContent = card.querySelector('h2').textContent;
   document.getElementById('viewer-body').replaceChildren(copy);
   wire(copy);
   returnFocus = button;
   dialog.showModal();
   document.getElementById('close-viewer').focus();
  });
  document.getElementById('close-viewer').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () {
   document.getElementById('viewer-body').replaceChildren();
   if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  });
  dialog.addEventListener('click', function (event) {
   if (event.target !== dialog) return;
   var bounds = dialog.getBoundingClientRect();
   if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
 }
 filter();
}());

(function(){
  var toggle=document.querySelector('.nav-toggle'),drawer=document.getElementById('nav-drawer'),overlay=document.getElementById('nav-overlay'),close=document.querySelector('.nav-drawer-close');
  if(!toggle||!drawer)return;
  var returnFocus=null;
  var background=Array.prototype.filter.call(document.body.children,function(el){return el!==drawer&&el!==overlay&&el.tagName!=='SCRIPT';});
  function focusable(){return Array.prototype.filter.call(drawer.querySelectorAll('a[href],button:not([disabled])'),function(el){return !el.hidden&&el.offsetParent!==null;});}
  function setOpen(open){
    if(open)returnFocus=document.activeElement;
    toggle.setAttribute('aria-expanded',String(open));drawer.classList.toggle('open',open);drawer.setAttribute('aria-hidden',String(!open));drawer.inert=!open;
    if(overlay){overlay.classList.toggle('open',open);overlay.setAttribute('aria-hidden',String(!open));}
    document.body.classList.toggle('nav-open',open);
    background.forEach(function(el){el.inert=open;});
    if(open)setTimeout(function(){var first=close||focusable()[0];if(first)first.focus();},0);
    else if(returnFocus&&typeof returnFocus.focus==='function')returnFocus.focus();
  }
  drawer.inert=!drawer.classList.contains('open');
  toggle.addEventListener('click',function(){setOpen(toggle.getAttribute('aria-expanded')!=='true');});
  if(close)close.addEventListener('click',function(){setOpen(false);});
  if(overlay)overlay.addEventListener('click',function(){setOpen(false);});
  drawer.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){setOpen(false);});});
  document.addEventListener('keydown',function(e){
    if(!drawer.classList.contains('open'))return;
    if(e.key==='Escape'){e.preventDefault();setOpen(false);return;}
    if(e.key!=='Tab')return;
    var items=focusable();if(!items.length)return;
    var first=items[0],last=items[items.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });
}());
