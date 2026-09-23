/* Internal preview interaction. No analytics, network writes or customer-conversion events. */
(function () {
 'use strict';
 function position(component,value) {
  value=Math.max(0,Math.min(100,Math.round(Number(value))));
  if (!Number.isFinite(value)) return;
  component.style.setProperty('--position',value+'%');
  var input=component.querySelector('input[type="range"]');
  input.value=String(value);input.setAttribute('aria-valuetext',value+' percent before');
  component.querySelector('.label-before').hidden=value===0;
  component.querySelector('.label-after').hidden=value===100;
 }
 function wire(component) {
  component.querySelector('.controls').hidden=false;
  component.querySelector('input').addEventListener('input',function(e){position(component,e.target.value);});
  component.querySelectorAll('[data-position]').forEach(function(button){button.addEventListener('click',function(){position(component,button.dataset.position);});});
  var stage=component.querySelector('.image-stage'),pointer=null;
  function move(e){var box=stage.getBoundingClientRect();if(box.width)position(component,100*(e.clientX-box.left)/box.width);}
  stage.addEventListener('pointerdown',function(e){if(!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0))return;pointer=e.pointerId;stage.setPointerCapture(pointer);move(e);});
  stage.addEventListener('pointermove',function(e){if(pointer===e.pointerId)move(e);});
  ['pointerup','pointercancel','lostpointercapture'].forEach(function(name){stage.addEventListener(name,function(){pointer=null;});});
 }
 document.querySelectorAll('.comparison').forEach(wire);
 var search=document.getElementById('search');
 document.getElementById('search-label').hidden=false;
 search.addEventListener('input',function(){var query=search.value.trim().toLowerCase(),count=0;document.querySelectorAll('.card').forEach(function(card){card.hidden=!card.dataset.search.includes(query);if(!card.hidden)count++;});document.getElementById('count').textContent=count+(count===1?' transformation':' transformations');document.getElementById('empty').hidden=count!==0;});
 var dialog=document.getElementById('viewer'),returnFocus=null;
 if(typeof dialog.showModal==='function'){
  document.querySelectorAll('[data-expand]').forEach(function(button){button.addEventListener('click',function(){var card=button.closest('.card'),copy=card.querySelector('.comparison').cloneNode(true);copy.querySelectorAll('img').forEach(function(image){image.loading='eager';});document.getElementById('viewer-title').textContent=card.querySelector('h2').textContent;document.getElementById('viewer-body').replaceChildren(copy);wire(copy);position(copy,50);returnFocus=button;dialog.showModal();document.getElementById('close-viewer').focus();});});
  document.getElementById('close-viewer').addEventListener('click',function(){dialog.close();});
  dialog.addEventListener('close',function(){document.getElementById('viewer-body').replaceChildren();if(returnFocus)returnFocus.focus();});
  dialog.addEventListener('click',function(e){if(e.target!==dialog)return;var r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
 }else{document.querySelectorAll('[data-expand]').forEach(function(button){button.hidden=true;});}
}());
