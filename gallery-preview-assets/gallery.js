/* Gallery presentation only. No backend, customer records, generation, or conversion events. */
(function () {
 'use strict';
 var grid=document.getElementById('gallery');
 if(!grid)return;
 var publicPage=Boolean(document.querySelector('.public-hero'));
 var search=document.getElementById('search');
 var dialog=document.getElementById('viewer');
 var returnFocus=null;
 function position(component,value) {
  value=Math.max(0,Math.min(100,Math.round(Number(value))));
  if(!Number.isFinite(value))return;
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
 function filter() {
  var query=search?search.value.trim().toLowerCase():'',count=0;
  grid.querySelectorAll('.card').forEach(function(card){
   card.hidden=Boolean(card.dataset.imageFailed)||!(card.dataset.search||'').includes(query);
   if(!card.hidden)count++;
  });
  var label=publicPage?' design':' transformation';
  document.getElementById('count').textContent=count+label+(count===1?'':'s');
  document.getElementById('empty').hidden=count!==0;
 }
 grid.querySelectorAll('.comparison').forEach(wire);
 if(search){document.getElementById('search-label').hidden=false;search.addEventListener('input',filter);}
 function openViewer(button) {
  if(!dialog||typeof dialog.showModal!=='function')return false;
  var card=button.closest('.card');
  var source=card.querySelector('.comparison')||card.querySelector('.showcase-photo');
  if(!source)return false;
  var copy=source.cloneNode(true);
  if(copy.tagName==='IMG'){
   copy.loading='eager';copy.removeAttribute('srcset');copy.removeAttribute('sizes');
  }else copy.querySelectorAll('img').forEach(function(image){image.loading='eager';});
  document.getElementById('viewer-title').textContent=card.querySelector('h2').textContent;
  document.getElementById('viewer-body').replaceChildren(copy);
  if(copy.classList.contains('comparison')){wire(copy);position(copy,50);}
  returnFocus=button;dialog.showModal();document.getElementById('close-viewer').focus();
  return true;
 }
 grid.addEventListener('click',function(event){
  var button=event.target.closest('[data-expand],[data-showcase-open]');
  if(!button||!grid.contains(button)||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  if(openViewer(button))event.preventDefault();
 });
 if(dialog&&typeof dialog.showModal==='function'){
  document.getElementById('close-viewer').addEventListener('click',function(){dialog.close();});
  dialog.addEventListener('close',function(){document.getElementById('viewer-body').replaceChildren();if(returnFocus)returnFocus.focus();});
  dialog.addEventListener('click',function(e){if(e.target!==dialog)return;var r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
 }else grid.querySelectorAll('[data-expand]').forEach(function(button){button.hidden=true;});

 if(publicPage){
  // Keep one clear inspiration framing instead of repeated production-method badges.
  document.querySelector('.public-hero .eyebrow').textContent='Garage design inspiration';
  var introNote=document.querySelector('.hero-copy .concept-note');
  if(introNote)introNote.textContent='Concept layouts for planning your space.';
  var viewerNote=dialog&&dialog.querySelector('.concept-note');
  if(viewerNote)viewerNote.textContent='Garage design inspiration';
  grid.querySelectorAll('img[alt]').forEach(function(image){image.alt=image.alt.replace(/^AI-generated /,'');});
  document.title='Garage Design Inspiration | Easy Garage Cleaning';
  var assetPath=/^\/images\/gallery-showcase\/[a-z0-9-]+\.webp$/;
  function valid(item){
   return item&&item.kind==='design-concept'&&typeof item.id==='string'&&/^[a-z0-9-]{1,70}$/.test(item.id)&&
    typeof item.title==='string'&&item.title.length>0&&item.title.length<150&&
    typeof item.caption==='string'&&item.caption.length<400&&typeof item.tags==='string'&&
    assetPath.test(item.src||'')&&assetPath.test(item.thumbnail||'')&&item.width===1448&&item.height===1086;
  }
  function element(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;}
  function cardFor(item,index){
   var card=element('article','card showcase-card');
   card.dataset.scene='showcase-'+item.id;card.dataset.showcaseId=item.id;
   card.dataset.search=(item.title+' '+item.tags+' '+item.caption).toLowerCase();
   var heading=element('div','card-heading');heading.appendChild(element('span','','Featured'));
   heading.appendChild(element('h2','',item.title));
   var expand=element('button','','Expand ↗');expand.type='button';expand.dataset.expand='';expand.setAttribute('aria-label','Enlarge '+item.title);
   expand.hidden=!dialog||typeof dialog.showModal!=='function';heading.appendChild(expand);card.appendChild(heading);
   var link=element('a','showcase-image-link');link.href=item.src;link.dataset.showcaseOpen='';link.setAttribute('aria-label','View '+item.title+' design');
   var image=element('img','showcase-photo');image.src=item.src;image.srcset=item.thumbnail+' 768w, '+item.src+' 1448w';
   image.sizes='(max-width: 760px) calc(100vw - 28px), (max-width: 1308px) calc((100vw - 74px) / 2), 617px';
   image.width=item.width;image.height=item.height;image.alt='Before-and-after design concept: '+item.title;
   image.loading=index<2?'eager':'lazy';image.decoding='async';if(index===0)image.fetchPriority='high';
   image.addEventListener('error',function(){card.dataset.imageFailed='true';filter();});
   link.appendChild(image);card.appendChild(link);card.appendChild(element('p','showcase-caption',item.caption));return card;
  }
  async function loadShowcase(){
   try{
    var response=await fetch('/gallery-showcase.json',{cache:'no-cache',credentials:'omit'});
    if(!response.ok)return;
    var data=await response.json();if(data.schemaVersion!==1||!Array.isArray(data.images))return;
    var seen=new Set();var items=data.images.filter(function(item){if(!valid(item)||seen.has(item.id))return false;seen.add(item.id);return true;}).slice(0,24);
    if(!items.length)return;
    grid.querySelectorAll('img[fetchpriority]').forEach(function(image){image.removeAttribute('fetchpriority');image.loading='lazy';});
    var fragment=document.createDocumentFragment();items.forEach(function(item,index){fragment.appendChild(cardFor(item,index));});grid.prepend(fragment);
    grid.dataset.showcaseRelease=String(data.release||'');filter();
    var description=document.querySelector('meta[name="description"]');
    if(description)description.content='Explore garage design inspiration, before-and-after concepts, and practical storage ideas. Request a free garage walkthrough in Northern Colorado.';
   }catch(error){console.warn('The optional showcase images could not be loaded. Existing gallery remains available.');}
  }
  loadShowcase();
 }
 filter();
}());
