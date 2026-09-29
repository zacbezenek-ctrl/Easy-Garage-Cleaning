function initNavDrawer(){
  const toggle=document.querySelector('.nav-toggle');
  const drawer=document.getElementById('nav-drawer');
  const overlay=document.getElementById('nav-overlay');
  const closeBtn=document.querySelector('.nav-drawer-close');
  if(!toggle||!drawer)return;
  if(toggle.dataset.navBound)return;
  toggle.dataset.navBound='1';
  let returnFocus=null;
  drawer.inert=!drawer.classList.contains('open');
  const background=[...document.body.children].filter(el=>el!==drawer&&el!==overlay&&el.tagName!=='SCRIPT');
  const focusable=()=>[...drawer.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>!el.hidden&&el.offsetParent!==null);
  function setOpen(open){
    if(open)returnFocus=document.activeElement;
    toggle.setAttribute('aria-expanded',open);
    drawer.classList.toggle('open',open);
    drawer.setAttribute('aria-hidden',String(!open));
    drawer.inert=!open;
    if(overlay){overlay.classList.toggle('open',open);overlay.setAttribute('aria-hidden',String(!open));}
    document.body.classList.toggle('nav-open',open);
    background.forEach(el=>{el.inert=open;});
    if(open)setTimeout(()=>{(closeBtn||focusable()[0])?.focus();},0);
    else if(returnFocus&&typeof returnFocus.focus==='function')returnFocus.focus();
  }
  toggle.addEventListener('click',()=>setOpen(toggle.getAttribute('aria-expanded')!=='true'));
  if(closeBtn)closeBtn.addEventListener('click',()=>setOpen(false));
  if(overlay)overlay.addEventListener('click',()=>setOpen(false));
  drawer.querySelectorAll('a[href]').forEach(a=>a.addEventListener('click',()=>setOpen(false)));
  document.querySelectorAll('.drawer-toggle').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const open=btn.getAttribute('aria-expanded')==='true';
      btn.setAttribute('aria-expanded',String(!open));
      const links=btn.nextElementSibling;
      if(links)links.classList.toggle('open',!open);
    });
  });
  document.addEventListener('keydown',e=>{
    if(!drawer.classList.contains('open'))return;
    if(e.key==='Escape'){e.preventDefault();setOpen(false);return;}
    if(e.key==='Tab'){
      const items=focusable();if(!items.length)return;
      const first=items[0],last=items[items.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
  });
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',initNavDrawer);}else{initNavDrawer();}

  document.querySelectorAll('.nav-dropdown-trigger').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const open=btn.getAttribute('aria-expanded')==='true';
      document.querySelectorAll('.nav-dropdown-trigger').forEach(b=>b.setAttribute('aria-expanded','false'));
      btn.setAttribute('aria-expanded',open?'false':'true');
    });
  });
const navEl=document.querySelector('.nav');
if(navEl){const onNav=()=>navEl.classList.toggle('nav-scrolled',window.scrollY>24);window.addEventListener('scroll',onNav,{passive:true});onNav();}
const io=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');io.unobserve(e.target);}});},{threshold:0.08});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
const btt=document.getElementById('back-to-top');
if(btt){const onScroll=()=>{btt.hidden=window.scrollY<420};btt.addEventListener('click',e=>{e.preventDefault();window.scrollTo({top:0,behavior:'smooth'})});window.addEventListener('scroll',onScroll,{passive:true});onScroll();}
document.querySelectorAll('.multi-step-form').forEach(initMultiStepForm);
function initMultiStepForm(form){
  let step=1;const shell=form.closest('.quote-form')||document;const panels=form.querySelectorAll('.form-panel');const dots=shell.querySelectorAll('.form-step-dot');const total=panels.length;
  const pctEl=shell.querySelector('[data-progress-pct]');
  const names=['What do you need?','Job size','Walkthrough timing','Where are you located?','Optional photos','Contact details'];
  const sizeSel=form.querySelector('[data-size-tier]');
  const flowInput=form.querySelector('[name="flow_type"]');
  const rangeInput=form.querySelector('[name="estimated_range"]');
  const slotInput=form.querySelector('[name="booking_slot"]');
  const submitBtn=form.querySelector('[data-submit-label]');
  function focusStep(n){const panel=panels[n-1];if(!panel)return;const f=panel.querySelector('input:not([type=hidden]):not([type=radio]):not([type=file]),select,textarea');if(f)setTimeout(()=>f.focus(),80);}
  function syncBookingSlot(){const picked=form.querySelector('[name="booking_slot_choice"]:checked');if(slotInput&&picked)slotInput.value=picked.value;}
  function showQuoteResult(){const opt=sizeSel?.options[sizeSel.selectedIndex];if(!opt||!opt.value)return false;if(flowInput)flowInput.value='walkthrough';if(rangeInput)rangeInput.value='';const callPanel=form.querySelector('[data-result-call]');const bookPanel=form.querySelector('[data-result-booking]');if(callPanel)callPanel.hidden=true;if(bookPanel)bookPanel.hidden=false;if(submitBtn)submitBtn.textContent='Request walkthrough →';return true;}
  const show=(n)=>{if(n===3)showQuoteResult();panels.forEach((p,i)=>p.classList.toggle('active',i+1===n));dots.forEach((d,i)=>{d.classList.toggle('active',i+1===n);d.classList.toggle('done',i+1<n);});step=n;const lbl=shell.querySelector('.form-step-label');if(lbl)lbl.textContent='Step '+n+' of '+total+(names[n-1]?': '+names[n-1]:'');if(pctEl)pctEl.textContent=Math.round((n/total)*100)+'%';focusStep(n);};
  function showErr(panel,msg){let el=panel.querySelector('.form-error');if(!el){el=document.createElement('p');el.className='form-error';el.setAttribute('role','alert');panel.appendChild(el);}el.textContent=msg;el.classList.add('visible');}
  function clearErr(panel){const el=panel.querySelector('.form-error');if(el)el.classList.remove('visible');}
  function validateStep(n){
    const panel=panels[n-1];clearErr(panel);
    if(n===1){const svc=form.querySelector('[name="Service type"]:checked');if(!svc){showErr(panel,'Please choose a service type to continue.');panel.querySelector('.service-picker')?.scrollIntoView({behavior:'smooth',block:'center'});return false;}}
    if(n===2){if(sizeSel&&!sizeSel.value){showErr(panel,'Please choose an approximate job size.');sizeSel.focus();return false;}}
    if(n===3){if(!showQuoteResult())return false;syncBookingSlot();if(!form.querySelector('[name="booking_slot_choice"]:checked')){showErr(panel,'Please choose a preferred walkthrough window.');return false;}}
    if(n===4){const city=form.querySelector('[name="City"]');if(city&&!city.value){showErr(panel,'Please select your city so we can confirm service area.');city.focus();return false;}}
    if(n===6){const name=form.querySelector('[name="Name"]');const phone=form.querySelector('[name="Phone"]');if(name&&!name.value.trim()){showErr(panel,'Please enter your name.');name.focus();return false;}if(phone&&!phone.value.trim()){showErr(panel,'Please enter a phone number so we can call with your quote.');phone.focus();return false;}}
    return true;
  }
  form.querySelectorAll('[name="booking_slot_choice"]').forEach(r=>r.addEventListener('change',syncBookingSlot));
  if(sizeSel)sizeSel.addEventListener('change',()=>{if(step===3)showQuoteResult();});
  form.querySelectorAll('[data-next]').forEach(b=>b.addEventListener('click',()=>{if(!validateStep(step))return;if(step<total)show(step+1);}));
  form.querySelectorAll('[data-prev]').forEach(b=>b.addEventListener('click',()=>{if(step>1)show(step-1);}));
  const fileInput=form.querySelector('input[type="file"][name="Photos"]');
  const previewBox=form.querySelector('[data-photo-previews]');
  if(fileInput&&previewBox){
    fileInput.addEventListener('change',()=>{
      previewBox.innerHTML='';
      [...(fileInput.files||[])].slice(0,8).forEach((f,i)=>{
        if(!f.type.startsWith('image/'))return;
        const url=URL.createObjectURL(f);
        const wrap=document.createElement('div');
        wrap.className='photo-preview-item';
        const img=document.createElement('img');
        img.src=url;img.alt='Photo preview '+(i+1);
        wrap.appendChild(img);
        previewBox.appendChild(wrap);
      });
    });
  }
  let submitting=false;
  function syncZapierLeadFields(form){
    const normPhone=(raw)=>{const d=String(raw||'').replace(/\D/g,'');if(d.length===10)return'+1'+d;if(d.length===11&&d[0]==='1')return'+'+d;return String(raw||'').trim();};
    const phone=form.querySelector('[name="Phone"]');const zapPhone=form.querySelector('[name="phone"]');
    const name=form.querySelector('[name="Name"]');const zapName=form.querySelector('[name="name"]');
    const email=form.querySelector('[name="Email"]');const zapEmail=form.querySelector('[name="email"]');
    const zip=form.querySelector('[name="Zip code"]');const zapZip=form.querySelector('[name="serviceZip"]');
    const svc=form.querySelector('[name="Service type"]:checked')||form.querySelector('[name="Service type"]');
    const sizeSel=form.querySelector('[data-size-tier]');const zapItems=form.querySelector('[name="items"]');
    if(zapPhone&&phone)zapPhone.value=normPhone(phone.value);
    if(zapName&&name)zapName.value=(name.value||'').trim();
    if(zapEmail&&email)zapEmail.value=(email.value||'').trim();
    if(zapZip&&zip)zapZip.value=(zip.value||'').trim();
    if(zapItems&&svc){const size=sizeSel?.options[sizeSel.selectedIndex]?.text||'';zapItems.value=[svc.value||'',size].filter(Boolean).join(' — ');}
  }
  form.addEventListener('submit',(e)=>{
    syncBookingSlot();
    syncZapierLeadFields(form);
    const svc=form.querySelector('[name="Service type"]:checked')||form.querySelector('[name="Service type"]');
    const desc=form.querySelector('[name="Photo description"]');const city=form.querySelector('[name="City"]');
    const size=sizeSel?.options[sizeSel.selectedIndex]?.text||'';
    const combined=form.querySelector('[name="What to remove"]');
    if(combined&&svc){const parts=[svc.value||'',size,city&&city.value?city.value:'',rangeInput?.value?'Est. '+rangeInput.value:'',slotInput?.value?'Slot: '+slotInput.value:'',flowInput?.value?'Flow: '+flowInput.value:'',desc&&desc.value?desc.value:''].filter(Boolean);combined.value=parts.join(' — ');}
    if(submitting){e.preventDefault();return;}
    submitting=true;
    const btn=form.querySelector('[type="submit"]');
    if(btn){btn.disabled=true;btn.classList.add('is-loading');btn.textContent='Sending…';}
      if(typeof gtag==='function'){gtag('event','walkthrough_request',{event_category:'lead',event_label:svc?.value||'walkthrough',flow_type:flowInput?.value||''});}
  });
  show(1);
}
(function(){
  const sheet=document.getElementById('mobile-quote-sheet');
  if(!sheet||window.matchMedia('(min-width:1024px)').matches)return;
  let shown=false,dismissed=sessionStorage.getItem('egc-quote-sheet')==='1';
  const close=sheet.querySelector('.mobile-quote-sheet-close');
  if(close)close.addEventListener('click',()=>{sheet.classList.remove('visible');sheet.setAttribute('aria-hidden','true');sessionStorage.setItem('egc-quote-sheet','1');dismissed=true;});
  const onScroll=()=>{if(dismissed||shown)return;const max=document.documentElement.scrollHeight-window.innerHeight;if(max<=0)return;if(window.scrollY/max>=0.5){shown=true;sheet.classList.add('visible');sheet.setAttribute('aria-hidden','false');}};
  window.addEventListener('scroll',onScroll,{passive:true});
})();
