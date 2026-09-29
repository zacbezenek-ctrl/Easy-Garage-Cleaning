// Mobile-first invariants shared by every device spec. Overflow and camera
// capture are hard errors; tap targets and keyboards ratchet against
// tests/e2e/mobile-allowlist.json so existing debt is visible but cannot grow.
import {expect} from '@playwright/test';
import {ratchet} from './allowlist.mjs';

export const MIN_TARGET=44;
// Tap targets: every link and button (including ARIA links, buttons, tabs and
// toggles), form fields and <summary> rows. The only exemption is an inline
// link inside running text; see inlineCopyLink in tapTargetViolations.
export const PRIMARY_CONTROLS=['a[href]','button','[role="button"]','[role="link"]','[role="tab"]','[role="menuitem"]','[role="checkbox"]','[role="radio"]','[role="switch"]','input:not([type="hidden"])','select','textarea','summary'].join(',');

function report(kind,key,{unexpected,fixed},details=new Map()){
 const describe=list=>list.map(item=>details.get(item)?`${item} (${details.get(item)})`:item).join('\n  ');
 expect(unexpected,`New ${kind} violations on ${key} (fix them; do not extend the allowlist):\n  ${describe(unexpected)}`).toEqual([]);
 expect(fixed,`${kind} on ${key} now pass; remove them from tests/e2e/mobile-allowlist.json so the ratchet tightens:\n  ${fixed.join('\n  ')}`).toEqual([]);
}

export async function assertNoHorizontalScroll(page,{tolerance=1}={}){
 const width=page.viewportSize().width;
 const measured=await page.evaluate(limit=>{
  const describe=element=>element.tagName.toLowerCase()+(element.id?'#'+element.id:'')+(typeof element.className==='string'&&element.className.trim()?'.'+element.className.trim().split(/\s+/).slice(0,2).join('.'):'');
  const offenders=[...document.body.querySelectorAll('*')].filter(element=>{const box=element.getBoundingClientRect();return box.width&&box.height&&box.right+window.scrollX>limit&&element.checkVisibility();}).slice(0,6).map(element=>`${describe(element)} right=${Math.round(element.getBoundingClientRect().right+window.scrollX)}`);
  return {document:document.documentElement.scrollWidth,body:document.body.scrollWidth,inner:window.innerWidth,offenders};
 },width+tolerance);
 expect(Math.max(measured.document,measured.body,measured.inner),`Horizontal scroll at ${width}px (document ${measured.document}, body ${measured.body}, innerWidth ${measured.inner}). Widest elements: ${measured.offenders.join('; ')}`).toBeLessThanOrEqual(width+tolerance);
 return measured;
}

// Visible, on-screen controls only. A control passes when it, or one of its
// <label> boxes, is at least 44x44 CSS px. A link is exempt only when all of
// these hold: it is not tel:/sms:/mailto: (tap-to-call and tap-to-text are
// primary actions wherever they sit); its computed display is inline; the
// nearest ancestor that is not inline is a <p> or <li>; and that <p>/<li> has
// words of its own outside every link and button, so the link flows inside a
// sentence. A link alone in a list item (footer and nav lists), a link styled as
// a block or inline-block, and a link in a <div> are all measured.
// An inline control is measured line by line: every line fragment, padding
// included, must be 44px tall and 44px wide (or a whole line), so a link that
// wraps into two short lines cannot pass on its combined box. Its padding
// overlaps the lines above and below, so it must also take taps: the top and
// bottom edge of every fragment must hit the control, not later text painted
// over the padding. Every control, exempt inline links included, must keep its
// own words: points along the midline and lower third of each line of its text
// must hit the control, never a different control painted over them (a padded,
// position:relative link on the next line does exactly that). Fixed and sticky
// bars overlap the content they scroll over by design, so they never count as
// that other control.
export async function tapTargetViolations(page,selector=PRIMARY_CONTROLS,{min=MIN_TARGET}={}){
 return page.evaluate(({selector,min})=>{
  const text=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,60);
  const name=element=>text(element.getAttribute('aria-label')||[...(element.labels||[])].map(label=>label.textContent).join(' ')||(['submit','button','reset'].includes(element.type)&&element.tagName==='INPUT'?element.value:'')||element.textContent||element.querySelector('img[alt]')?.getAttribute('alt')||element.getAttribute('title')||element.getAttribute('placeholder')||element.getAttribute('name')||element.getAttribute('href'));
  const id=element=>element.tagName.toLowerCase()+(element.id?'#'+element.id:'')+(element.tagName==='INPUT'?`[type=${element.type}]`:'');
  const onScreen=box=>box.width>1&&box.height>1&&box.right+window.scrollX>0&&box.bottom+window.scrollY>0&&box.left+window.scrollX<document.documentElement.scrollWidth;
  const display=element=>getComputedStyle(element).display;
  const blockOf=element=>{let block=element.parentElement;while(block&&['inline','contents'].includes(display(block)))block=block.parentElement;return block;};
  const inlineCopyLink=element=>{
   if(!element.matches('a[href],[role="link"]')||/^\s*(?:tel|sms|mailto):/i.test(element.getAttribute('href')||'')||display(element)!=='inline')return false;
   const block=blockOf(element);
   if(!block||!['P','LI'].includes(block.tagName))return false;
   const copy=block.cloneNode(true);
   for(const control of copy.querySelectorAll('a,button,[role="link"],[role="button"]'))control.remove();
   return /[\p{L}\p{N}]{2,}/u.test(copy.textContent);
  };
  const big=candidate=>candidate.width>=min-0.5&&candidate.height>=min-0.5;
  const pinned=element=>{for(let node=element;node;node=node.parentElement)if(['fixed','sticky'].includes(getComputedStyle(node).position))return true;return false;};
  // Hit-test a page point after scrolling it into the middle of the viewport, clear of fixed bars.
  const at=(x,y)=>{
   const top=y-window.scrollY;
   if(top<window.innerHeight*0.3||top>window.innerHeight*0.65)window.scrollTo({left:window.scrollX,top:Math.max(0,y-window.innerHeight*0.4),behavior:'instant'});
   return document.elementFromPoint(x-window.scrollX,y-window.scrollY);
  };
  const takesTaps=element=>[...element.getClientRects()].filter(rect=>rect.width>=1).map(rect=>({x:rect.left+rect.width/2+window.scrollX,top:rect.top+window.scrollY,bottom:rect.bottom+window.scrollY})).every(({x,top,bottom})=>[top+2,bottom-2].every(y=>{const hit=at(x,y);return !!hit&&element.contains(hit);}));
  const start={x:window.scrollX,y:window.scrollY};
  const controls=[...document.querySelectorAll(selector)].filter(element=>!element.closest('[aria-hidden="true"],[inert]')&&element.checkVisibility({checkOpacity:false,checkVisibilityCSS:true})&&!(element.tagName==='INPUT'&&(element.name==='botcheck'||element.tabIndex<0))&&onScreen(element.getBoundingClientRect()));
  // Sample each control's own words (text outside nested controls) before anything scrolls.
  const range=document.createRange(),samples=[];
  for(const element of controls){
   const fixed=pinned(element),walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
   for(let node=walker.nextNode();node;node=walker.nextNode()){
    if(!/\S/.test(node.data)||node.parentElement.closest(selector)!==element)continue;
    range.selectNodeContents(node);
    for(const rect of range.getClientRects())if(rect.width>=2&&rect.height>=2)for(const x of [.15,.5,.85])for(const y of [.5,.75])samples.push({element,fixed,x:rect.left+rect.width*x+(fixed?0:start.x),y:rect.top+rect.height*y+(fixed?0:start.y)});
   }
  }
  const covered=new Map();
  const cover=(element,hit)=>{
   const other=hit?.closest(selector);
   if(other&&other!==element&&!element.contains(other)&&!other.contains(element)&&!pinned(other))covered.set(element,other);
  };
  for(const {element,x,y} of samples.filter(sample=>sample.fixed))if(!covered.has(element))cover(element,document.elementFromPoint(x,y));
  for(const {element,x,y} of samples.filter(sample=>!sample.fixed).sort((a,b)=>a.y-b.y))if(!covered.has(element))cover(element,at(x,y));
  const out=[];
  for(const element of controls){
   const box=element.getBoundingClientRect(),labels=[...(element.labels||[])].map(label=>label.getBoundingClientRect()),notes=[];
   const measured=!inlineCopyLink(element)&&!labels.some(big);let size=null;
   if(measured&&display(element)!=='inline'){if(!big(box))size=[box,...labels].reduce((best,candidate)=>candidate.width*candidate.height>best.width*best.height?candidate:best);}
   else if(measured){
    const block=blockOf(element),style=block&&getComputedStyle(block),line=block?block.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight):Infinity;
    const fragments=[...element.getClientRects()].filter(rect=>rect.width>=1),short=fragments.find(rect=>rect.height<min-0.5||(rect.width<min-0.5&&rect.width<line-1));
    if(!fragments.length||short){size=short||box;if(big(box))notes.push('a line of it is under 44px');}
    else if(!takesTaps(element)){size=box;notes.push('padding does not take taps');}
   }
   if(covered.has(element))notes.push(`covered by ${id(covered.get(element))} "${name(covered.get(element))}"`);
   if(size||notes.length)out.push({id:`${id(element)} "${name(element)}"`,width:Math.round((size||box).width),height:Math.round((size||box).height),...(notes.length?{note:notes.join('; ')}:{})});
  }
  window.scrollTo({left:start.x,top:start.y,behavior:'instant'});
  return out;
 },{selector,min});
}

export async function assertTapTargets(page,selector=PRIMARY_CONTROLS,{key,min=MIN_TARGET}={}){
 const violations=await tapTargetViolations(page,selector,{min});
 report('tap targets',key,ratchet('tapTargets',key,violations.map(item=>item.id)),new Map(violations.map(item=>[item.id,`${item.width}x${item.height}${item.note?', '+item.note:''}`])));
 return violations;
}

// Phone, email and number fields must raise the matching keyboard (type or
// inputmode). Phone and email fields also need an explicit autocomplete token
// (the matching token, or "off" where staff enter someone else's details).
// Search/filter boxes are exempt because they take names as well as numbers.
export async function keyboardViolations(page){
 return page.evaluate(()=>{
  const skip=new Set(['hidden','checkbox','radio','file','submit','button','reset','image','range','color','password','date','time','datetime-local','month','week','search']);
  const out=[];
  for(const element of document.querySelectorAll('input')){
   const type=(element.getAttribute('type')||'text').toLowerCase();
   if(skip.has(type)||element.name==='botcheck'||element.tabIndex<0||element.closest('[aria-hidden="true"]'))continue;
   const hint=[element.name,element.id,element.getAttribute('autocomplete'),element.getAttribute('aria-label'),element.placeholder,...[...(element.labels||[])].map(label=>label.textContent)].join(' ').toLowerCase().replace(/\s+/g,' ');
   const mode=(element.getAttribute('inputmode')||'').toLowerCase(),auto=(element.getAttribute('autocomplete')||'').toLowerCase();
   let need='',ok=true;
   if(/\bsearch\b|\bfind\b|\bfilter\b/.test(hint))continue;
   if(/\b(phone|tel|mobile|cell)\b/.test(hint)){need='tel';ok=(type==='tel'||mode==='tel')&&(/\btel\b|tel-/.test(auto)||auto==='off');}
   else if(/e-?mail/.test(hint)){need='email';ok=(type==='email'||mode==='email')&&(/email/.test(auto)||auto==='off');}
   else if(/\b(zip|postal)\b/.test(hint)){need='postal-code';ok=type==='number'||['numeric','tel'].includes(mode);}
   else if(/\b(amount|price|cost|deposit|budget|payment|dollars?)\b|\$/.test(hint)){need='decimal';ok=type==='number'||['decimal','numeric'].includes(mode);}
   else if(/\b(qty|quantity|how many|number of|crew size|minutes|hours|miles)\b/.test(hint)){need='numeric';ok=type==='number'||['numeric','decimal'].includes(mode);}
   else continue;
   if(!ok)out.push({id:`input${element.id?'#'+element.id:''}${element.name?`[name=${element.name}]`:''} needs ${need}`,actual:`type=${type} inputmode=${mode||'-'} autocomplete=${auto||'-'}`});
  }
  return out;
 });
}

export async function assertInputKeyboards(page,{key}={}){
 const violations=await keyboardViolations(page);
 report('keyboards',key,ratchet('keyboards',key,violations.map(item=>item.id)),new Map(violations.map(item=>[item.id,item.actual])));
 return violations;
}

// Image file inputs in scope with their capture attribute and label.
export async function cameraInputs(page,scope='body'){
 return page.locator(scope).first().evaluate(root=>[...root.querySelectorAll('input[type="file"]')].filter(input=>/image|\.(?:jpe?g|png|heic|webp)/i.test(input.accept||'')).map(input=>({capture:input.getAttribute('capture'),label:[...(input.labels||[])].map(label=>label.textContent.trim()).join(' ')||input.getAttribute('aria-label')||input.name||input.id})));
}

// Field photos: a rear-camera capture option must sit alongside a library picker.
export async function assertCameraCapture(page,scope='body'){
 const inputs=await cameraInputs(page,scope);
 expect(inputs.length,'an image upload control').toBeGreaterThan(0);
 expect(inputs.filter(input=>input.capture==='environment'),`a capture="environment" camera option among ${JSON.stringify(inputs)}`).not.toEqual([]);
 expect(inputs.filter(input=>input.capture===null),`a photo-library picker (no capture attribute) among ${JSON.stringify(inputs)}`).not.toEqual([]);
 return inputs;
}

// A known camera gap, asserted exactly: the page has its image upload and its
// library picker, and only the capture="environment" option is missing. Any
// other breakage fails normally; adding the camera option fails too, so the
// known-gap entry gets deleted and the page moves to assertCameraCapture.
export async function assertKnownMissingCamera(page,reason,scope='body'){
 const inputs=await cameraInputs(page,scope);
 expect(inputs.length,'an image upload control').toBeGreaterThan(0);
 expect(inputs.filter(input=>input.capture===null),`a photo-library picker (no capture attribute) among ${JSON.stringify(inputs)}`).not.toEqual([]);
 expect(inputs.filter(input=>input.capture==='environment'),`Known camera gap is fixed; delete its entry in the spec and docs/testing.md: ${reason}`).toEqual([]);
 return inputs;
}
