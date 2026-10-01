"""Serves the real employee.html with Firebase, Maps and fonts stubbed and every Hub API routed to synthetic
fixtures. No production service is reached: every non-127.0.0.1 request is fulfilled with a stub or aborted."""
import copy, json, os, pathlib, threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
DAY = '2026-09-22'
NOW = DAY + 'T18:00:00Z'
MANAGER = {'ok': True, 'user': 'ZacB', 'displayName': 'Synthetic Owner', 'role': 'owner', 'businessAccess': True, 'payType': 'owner', 'hourlyRate': 0}
CREW = {'ok': True, 'user': 'Synthetic.Crew', 'displayName': 'Synthetic Crew', 'role': 'crew', 'businessAccess': False, 'payType': 'hourly', 'hourlyRate': 20}
DONE = {'onboardingCompletedAt': '2026-09-01T15:00:00Z', 'onboardingVersion': '2026-09-location-v2'}
JOBS = [
    {'id': 'job-today', 'type': 'job', 'customer': 'Synthetic Johnson Garage', 'phone': '9705550100', 'email': 'synthetic@example.invalid', 'address': '123 Synthetic Way, Fort Collins, CO',
     'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '11:00', 'status': 'scheduled', 'pipelineStatus': 'scheduled', 'assignedTo': 'Synthetic.Crew', 'assignedCrew': ['synthetic.crew'],
     'crewNeeded': 2, 'priceQuoted': 2250, 'total': 2250, 'notes': 'Keep the workbench.', 'serviceType': 'Garage cleanout', 'syncStatus': 'synced', 'shiftPickupEnabled': True, 'notify': False,
     'customerDecisions': [{'id': 'decision-1', 'title': 'Remove the synthetic cabinet?', 'status': 'pending'}]},
    {'id': 'walk-today', 'type': 'walkthrough', 'customer': 'Synthetic Walkthrough Lead', 'phone': '9705550101', 'address': '456 Synthetic Ave, Fort Collins, CO', 'date': DAY, 'time': '13:00',
     'endDate': DAY, 'endTime': '14:00', 'status': 'scheduled', 'syncStatus': 'synced', 'notify': False},
    {'id': 'job-done', 'type': 'job', 'customer': 'Synthetic Finished Garage', 'phone': '9705550102', 'address': '789 Synthetic Ct, Loveland, CO', 'date': '2026-09-15', 'time': '09:00', 'endDate': '2026-09-15',
     'endTime': '12:00', 'status': 'completed', 'completedAt': '2026-09-15T19:00:00Z', 'total': 1800, 'priceQuoted': 1800, 'assignedCrew': ['synthetic.crew'], 'assignedTo': 'Synthetic.Crew', 'notify': False,
     'syncStatus': 'synced', 'invoice': {'number': 'INV-1001', 'status': 'issued', 'dueDate': '2026-09-30', 'amount': 1800}, 'closeoutSyncStatus': 'error', 'closeoutSyncPayload': {'tool': 'post_job'},
     'closeoutSyncNextRetryAt': '2099-01-01T00:00:00Z', 'rebookingRequests': [{'id': 'rebook-1', 'status': 'pending', 'kind': 'repeat'}]},
]
# /api/staff-directory for the Team page section and the registered Staff directory screen (TEAM-UI).
STAFF = {'ok': True, 'authority': 'employee_hub', 'timeZone': 'America/Denver', 'today': DAY,
         'viewer': {'user': 'ZacB', 'capabilities': ['dispatch.write', 'time.approve', 'pay.manage', 'accounts.approve', 'customer.send', 'followups.own']},
         'catalog': {'version': 'synthetic-skills', 'skills': [{'id': 'cleanout', 'label': 'Garage cleanout'}, {'id': 'customer_phone', 'label': 'Customer phone follow-up'}], 'levels': ['trainee', 'proficient', 'lead'],
                     'roles': ['owner', 'manager', 'crew_lead', 'crew', 'sales', 'phone'], 'days': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']},
         'people': [{'username': 'Synthetic.Crew', 'displayName': 'Synthetic Crew', 'source': 'employee_account', 'accountStatus': 'approved', 'staffRoles': ['crew', 'phone'], 'staffRolesSource': 'account', 'primaryRole': 'phone',
                     'skills': [{'id': 'customer_phone', 'level': 'lead', 'verifiedBy': 'zacb', 'verifiedAt': '2026-09-10T16:00:00Z'}],
                     'weeklyAvailability': {'mon': [{'start': '08:00', 'end': '17:00'}], 'tue': [], 'wed': [{'start': '18:00', 'end': '24:00'}], 'thu': [], 'fri': [], 'sat': [], 'sun': []}, 'weeklyAvailabilityNeedsReview': False,
                     'pay': {'current': {'hourlyRate': 20, 'payType': 'hourly', 'overtimeMultiplier': 1.5, 'effectiveFrom': '2026-09-01', 'source': 'pay_rates', 'drift': False},
                             'upcoming': [{'effectiveFrom': '2026-10-01', 'hourlyRate': 22, 'payType': 'hourly', 'overtimeMultiplier': 1.5}],
                             'schedule': [{'effectiveFrom': '2026-09-01', 'hourlyRate': 20, 'payType': 'hourly', 'overtimeMultiplier': 1.5}, {'effectiveFrom': '2026-10-01', 'hourlyRate': 22, 'payType': 'hourly', 'overtimeMultiplier': 1.5}], 'needsReview': False},
                     'history': [], 'revision': 'rev-staff-1', 'profileNeedsReview': False}],
         'coverage': {'complete': True, 'asOf': NOW}}
FIREBASE = r'''(function(){
const snap=name=>({docs:(name==='jobs'?(window.__egcJobs||[]):[]).map(row=>({id:row.id,data:()=>({...row})}))});
const ref=name=>({onSnapshot(...args){const next=args.find(arg=>typeof arg==='function');setTimeout(()=>next(snap(name)),0);return()=>{};},add:async()=>({id:'synthetic'}),get:async()=>snap(name),where(){return this;},orderBy(){return this;},limit(){return this;},
  doc(){return{set:async()=>{},update:async()=>{},delete:async()=>{},get:async()=>({exists:false,data:()=>({})})};}});
const db={collection:ref,batch:()=>({set(){},update(){},delete(){},commit:async()=>{}}),runTransaction:async()=>{throw new Error('Synthetic transactions are unavailable');}};
// The audit log stamps serverAt with FieldValue.serverTimestamp(), so the compat namespace carries it.
window.firebase={initializeApp(){},firestore:Object.assign(()=>db,{FieldValue:{serverTimestamp:()=>({synthetic:'serverTimestamp'})}}),auth:()=>({signInWithCustomToken:async()=>({}),signOut:async()=>{}})};
})();'''
FIXTURE_SCREEN = r'''(function(){
'use strict';
let root=null,dirty=false,mounts=0;
function mount(host,ctx){
  mounts++;const {h,button,field}=window.EGCHubKit;
  const phone=field({label:'Synthetic callback phone',name:'phone',type:'tel',autocomplete:'tel',help:'Typing here marks the screen as having unsaved changes.'});
  phone.querySelector('input').addEventListener('input',event=>{dirty=Boolean(event.target.value);});
  const result=h('p',{role:'status','data-fixture-result':''});
  root=h('section',{class:'hub-screen fixture-screen'},
    h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'FIXTURE'),h('h1',{},'Fixture screen'),h('p',{},'Mounted through the Hub screen registry for '+ctx.identity+'.')),
      h('div',{class:'hub-actions'},button('Confirm with dialog',async()=>{const values=await ctx.askAction({title:'Synthetic confirmation',fields:[{name:'phone',label:'Confirm phone',type:'tel',autocomplete:'tel'}],confirmLabel:'Confirm'});result.textContent=values?'Confirmed '+values.phone:'Cancelled';},'primary'),button('Go to customers',()=>ctx.go('customers')))),
    h('div',{class:'hub-card'},phone,result,h('p',{'data-fixture-mounts':''},'Mounts: '+mounts)),
    h('div',{class:'hub-notice warning'},'Synthetic notice text that is long enough to wrap on a narrow phone screen without scrolling sideways.'),
    h('div',{class:'hub-table-scroll'},h('table',{},h('thead',{},h('tr',{},['Customer','Visit','Crew','Balance'].map(text=>h('th',{},text)))),h('tbody',{},h('tr',{},['Synthetic Johnson Garage','2026-09-22 08:00','Synthetic Crew','$2,250.00'].map(text=>h('td',{},text)))))));
  host.append(root);
}
function unmount(){root?.remove();root=null;dirty=false;}
window.EGCFixtureScreen={mount,unmount,canLeave:()=>!dirty,refresh(){}};
})();'''
REGISTER = "\nwindow.EGCHubScreens.register({id:'fixture_screen',group:'SYSTEM',label:'Fixture screen',iconPath:'M4 4h16v16H4z',crewVisible:true,load:{js:'fixture-screen.js',v:'test'},module:'EGCFixtureScreen'});\n"
# Mobile audit probe (ported from the MOBILE-STAFF audit): one page task that reports sideways overflow with the body's
# overflow clipping lifted, text clipped without an ellipsis, ellipsized text without a title, tap targets under 44x44,
# fields under 16px, controls whose font has no generic fallback, text under WCAG AA contrast, fixed and sticky bars,
# dialogs, wide tables, overlapping controls and text, visible aria-hidden content, 40px+ section padding and words
# broken across lines. opts: scope (selector list, default body), skip (selector), targets (false skips the tap check).
AUDIT = r'''(opts)=>{opts=opts||{};const W=innerWidth,H=innerHeight,out={w:W,h:H},cs=el=>getComputedStyle(el);
const label=el=>{if(!el||!el.tagName)return'?';const id=el.id?'#'+el.id:'',cls=typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).slice(0,3).join('.'):'';
  const text=(el.getAttribute&&el.getAttribute('aria-label')||el.innerText||el.value||el.placeholder||'').trim();return el.tagName.toLowerCase()+id+cls+(text?' "'+String(text).replace(/\s+/g,' ').slice(0,32)+'"':'')};
const shown=el=>{if(!el.isConnected)return false;const r=el.getBoundingClientRect(),s=cs(el);if(r.width<1||r.height<1||s.visibility==='hidden'||s.display==='none'||Number(s.opacity)===0)return false;return!el.closest('[inert],[hidden],[aria-hidden="true"]')};
const roots=opts.scope?[...document.querySelectorAll(opts.scope)]:[document.body],inScope=el=>roots.some(root=>root.contains(el)),all=selector=>roots.flatMap(root=>[...root.querySelectorAll(selector)]);
const skip=el=>el.closest('.skip-link,#toast,.sr-only,.hub-sr-only')||(opts.skip&&el.closest(opts.skip));
const html=document.documentElement,body=document.body,before=[html.style.overflowX,body.style.overflowX];html.style.overflowX='visible';body.style.overflowX='visible';
out.scrollWidth=Math.max(html.scrollWidth,body.scrollWidth);
const scroller=el=>{for(let p=el.parentElement;p&&p!==body&&p!==html;p=p.parentElement){const s=cs(p);if(/(auto|scroll)/.test(s.overflowX)||s.position==='fixed')return p}return null};
out.offscreen=[];
for(const el of all('*')){if(skip(el)||!shown(el))continue;const r=el.getBoundingClientRect(),s=cs(el);if(s.position==='fixed'&&(r.left>=W||r.right<=0))continue;if(!(r.right>W+1||r.left<-1))continue;
  const sc=scroller(el);if(sc){const sr=sc.getBoundingClientRect();if(sr.right<=W+1&&sr.left>=-1)continue}if(el.closest('svg')&&el.tagName.toLowerCase()!=='svg')continue;
  const parent=el.parentElement,pr=parent&&parent.getBoundingClientRect();if(parent&&parent!==body&&inScope(parent)&&(pr.right>W+1||pr.left<-1)&&!scroller(el)===!scroller(parent))continue;
  out.offscreen.push(label(el)+' L'+Math.round(r.left)+' R'+Math.round(r.right))}
[html.style.overflowX,body.style.overflowX]=before;
out.clipped=[];out.ellipsis=[];
for(const el of all('*')){if(skip(el)||!shown(el)||!(el.innerText||'').trim()||['INPUT','SELECT','TEXTAREA','IMG'].includes(el.tagName)||el.closest('svg'))continue;const s=cs(el);
  if(s.textOverflow==='ellipsis'&&el.scrollWidth>el.clientWidth+1)out.ellipsis.push(label(el)+(el.closest('[title]')||el.getAttribute('aria-label')?' (title)':' (no title)'));
  const hx=/(hidden|clip)/.test(s.overflowX),hy=/(hidden|clip)/.test(s.overflowY);if(!hx&&!hy)continue;
  const wide=hx&&el.scrollWidth>el.clientWidth+2&&s.textOverflow!=='ellipsis',tall=hy&&el.scrollHeight>el.clientHeight+2&&!/-webkit-box/.test(s.display);
  if(wide||tall)out.clipped.push(label(el)+(wide?' W'+el.scrollWidth+'>'+el.clientWidth:'')+(tall?' H'+el.scrollHeight+'>'+el.clientHeight:''))}
const inlineText=a=>{if(cs(a).display!=='inline')return false;const b=a.parentElement;return Boolean(b)&&b.textContent.trim().length>a.textContent.trim().length+2};
out.smallTargets=[];const seen=new Set();
if(opts.targets!==false)for(const el of all('button,a[href],select,input:not([type=hidden]),textarea,summary,[role=button],[role=tab],[role=link]')){if(skip(el))continue;
  let t=el;if(el.matches('input[type=checkbox],input[type=radio]'))t=el.closest('label')||(el.id&&document.querySelector('label[for="'+el.id+'"]'))||el;
  if(seen.has(t))continue;seen.add(t);if(!shown(t)||el.matches('a')&&inlineText(el)||el.matches('.ops-scrim,.ops-modal-scrim'))continue;
  const r=t.getBoundingClientRect();if(r.height<43.5||r.width<43.5)out.smallTargets.push(label(t)+' '+Math.round(r.width)+'x'+Math.round(r.height))}
const fields='input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]):not([type=button]):not([type=submit]):not([type=file]),select,textarea';
out.smallInputs=all(fields).filter(el=>!skip(el)&&shown(el)&&parseFloat(cs(el).fontSize)<16).map(el=>label(el)+' '+cs(el).fontSize);
out.fonts=all('button,'+fields).filter(el=>!skip(el)&&shown(el)&&!/sans-serif|system-ui|-apple-system|monospace/.test(cs(el).fontFamily)).map(el=>label(el)+' '+cs(el).fontFamily);
const parse=c=>{const m=/rgba?\(([^)]+)\)/.exec(c);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
const lum=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)};
const blend=(top,bottom)=>({r:top.r*top.a+bottom.r*(1-top.a),g:top.g*top.a+bottom.g*(1-top.a),b:top.b*top.a+bottom.b*(1-top.a),a:1});
const bgOf=el=>{const layers=[];for(let p=el;p;p=p.parentElement){const s=cs(p);if(s.backgroundImage&&s.backgroundImage!=='none'&&!/gradient/.test(s.backgroundImage))return null;
  if(/gradient/.test(s.backgroundImage)){const g=/rgba?\([^)]+\)/.exec(s.backgroundImage);if(g){const gc=parse(g[0]);layers.push(gc);if(gc.a>=1)break}}const c=parse(s.backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break}}
  let col={r:255,g:255,b:255,a:1};for(let i=layers.length-1;i>=0;i--)col=blend(layers[i],col);return col};
const ratio=el=>{const s=cs(el),fg=parse(s.color),bg=bgOf(el);if(!fg||!bg)return null;let opacity=1;for(let p=el;p;p=p.parentElement)opacity*=Number(cs(p).opacity);
  const L1=lum(blend({...fg,a:fg.a*opacity},bg)),L2=lum(bg),size=parseFloat(s.fontSize),large=size>=24||(Number(s.fontWeight)>=700&&size>=18.66);return{ratio:Math.round((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)*100)/100,need:large?3:4.5}};
out.contrast=[];const combos=new Map(),walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
for(let node=walker.nextNode(),n=0;node&&n<4000;node=walker.nextNode()){if(!node.nodeValue.trim())continue;const el=node.parentElement;if(!el||!inScope(el)||skip(el)||!shown(el)||el.closest('svg,script,style,noscript,button:disabled,[aria-disabled=true]'))continue;n++;
  const c=ratio(el);if(!c||c.ratio>=c.need)continue;const s=cs(el),key=s.color+'|'+s.fontSize+'|'+label(el).split(' ')[0];if(!combos.has(key))combos.set(key,c.ratio+'<'+c.need+' '+label(el)+' :: '+node.nodeValue.trim().slice(0,40))}
out.contrast=[...combos.values()].slice(0,20);
out.fixed=all('*').filter(el=>!skip(el)&&shown(el)&&['fixed','sticky'].includes(cs(el).position)).map(el=>{const r=el.getBoundingClientRect(),s=cs(el);return s.position+' '+label(el).slice(0,50)+' top='+Math.round(r.top)+' h='+Math.round(r.height)+' pad-t='+s.paddingTop+' pad-l='+s.paddingLeft}).slice(0,10);
out.dialogs=all('dialog[open],.ops-modal .ops-booking').filter(shown).map(el=>{const r=el.getBoundingClientRect();return{el:label(el).slice(0,60),left:Math.round(r.left),right:Math.round(W-r.right),top:Math.round(r.top),bottom:Math.round(H-r.bottom),tooTall:r.bottom>H+1||r.top<-1}});
out.tables=all('table').filter(t=>shown(t)&&!skip(t)).map(t=>{const r=t.getBoundingClientRect();return{t:label(t).slice(0,60),w:Math.round(r.width),wrapped:Boolean(scroller(t)),overflow:r.right>W+1}}).filter(x=>x.overflow&&!x.wrapped);
const controls=all('button,a[href],input:not([type=hidden]),select,textarea').filter(el=>shown(el)&&!skip(el));out.overlaps=[];
for(let i=0;i<controls.length&&out.overlaps.length<10;i++){const a=controls[i].getBoundingClientRect();for(let j=i+1;j<controls.length;j++){if(controls[i].contains(controls[j])||controls[j].contains(controls[i]))continue;const b=controls[j].getBoundingClientRect(),x=Math.min(a.right,b.right)-Math.max(a.left,b.left),y=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(x>4&&y>4){out.overlaps.push(label(controls[i])+' X '+label(controls[j]));break}}}
const leaves=all('p,span,strong,small,h1,h2,h3,h4,b,em,label,td,th,li,div').filter(el=>shown(el)&&!skip(el)&&cs(el).position!=='fixed'&&el.children.length===0&&(el.textContent||'').trim()).map(el=>({el,r:el.getBoundingClientRect()})).filter(x=>x.r.top<H*3);out.textOverlaps=[];
for(let i=0;i<leaves.length&&out.textOverlaps.length<8&&i<1500;i++)for(let j=i+1;j<leaves.length&&j<i+40;j++){const a=leaves[i].r,b=leaves[j].r;if(leaves[i].el.contains(leaves[j].el)||leaves[j].el.contains(leaves[i].el))continue;const x=Math.min(a.right,b.right)-Math.max(a.left,b.left),y=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(x>6&&y>6){out.textOverlaps.push(label(leaves[i].el)+' X '+label(leaves[j].el));break}}
out.ariaHiddenVisible=[...document.querySelectorAll('[aria-hidden=true]')].filter(el=>{const r=el.getBoundingClientRect(),s=cs(el);return r.width>20&&r.height>20&&s.visibility!=='hidden'&&s.display!=='none'&&(el.innerText||'').trim()}).map(el=>label(el)+' top='+Math.round(el.getBoundingClientRect().top+scrollY));
out.sectionPad=all('section').filter(el=>shown(el)&&(parseFloat(cs(el).paddingTop)>=40||parseFloat(cs(el).paddingBottom)>=40)).map(el=>label(el).slice(0,60)+' pt='+cs(el).paddingTop+' pb='+cs(el).paddingBottom);
const broken=new Set(),words=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
for(let node=words.nextNode(),count=0;node&&count<6000;node=words.nextNode()){const el=node.parentElement;if(!el||!inScope(el)||skip(el)||!shown(el)||el.closest('svg,script,style,textarea,input,select,option'))continue;
  for(const m of node.nodeValue.matchAll(/[A-Za-z][A-Za-z'’]{3,}/g)){count++;const range=document.createRange();range.setStart(node,m.index);range.setEnd(node,m.index+m[0].length);const rects=[...range.getClientRects()].filter(r=>r.width>0);
    if(rects.length>1&&Math.abs(rects[0].top-rects[rects.length-1].top)>3)broken.add(label(el).slice(0,50)+' word='+m[0])}}
out.brokenWords=[...broken].slice(0,25);
return out}'''
# Loading placeholders the Hub screens render while their data is on the way.
LOADING = '#ops-main :is(.hub-screen-loading,.hub-skeleton,.ac-loading,.dp-loading,.st-loading,.rv-loading,.fh-loading,[class*="-skeleton"])'
# A dialog's box against the viewport, and whether its primary action can be scrolled into view and takes the tap.
DIALOG_BOX = r'''([selector,submit])=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();
const buttons=[...el.querySelectorAll(submit||'button[type=submit],button.primary,.primary')].filter(b=>b.getBoundingClientRect().width>0);const button=buttons.at(-1)||null;let reachable=false;
if(button){button.scrollIntoView({block:'nearest'});const b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);reachable=b.top>=0&&b.bottom<=innerHeight+0.5&&(hit===button||button.contains(hit))}
return{left:r.left,right:innerWidth-r.right,top:r.top,bottom:innerHeight-r.bottom,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,submit:button?button.textContent.trim():null,reachable}}'''
# Contrast of the first visible text element per selector (its own text node), on its composited background.
CONTRAST = r'''selectors=>{const cs=el=>getComputedStyle(el),parse=c=>{const m=/rgba?\(([^)]+)\)/.exec(c);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
const lum=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)},blend=(t,b)=>({r:t.r*t.a+b.r*(1-t.a),g:t.g*t.a+b.g*(1-t.a),b:t.b*t.a+b.b*(1-t.a),a:1});
const bg=el=>{const layers=[];for(let p=el;p;p=p.parentElement){const c=parse(cs(p).backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break}}let col={r:255,g:255,b:255,a:1};for(let i=layers.length-1;i>=0;i--)col=blend(layers[i],col);return col};
const out={};for(const selector of selectors){const el=[...document.querySelectorAll(selector)].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&cs(e).visibility!=='hidden'&&[...e.childNodes].some(n=>n.nodeType===3&&n.nodeValue.trim())});
  if(!el){out[selector]=null;continue}const b=bg(el),f=blend(parse(cs(el).color),b),L1=lum(f),L2=lum(b);out[selector]=Math.round((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)*100)/100}return out}'''


def collections(profile):
    me = profile['user']
    return {
        'profiles': [{'id': 'zacb', 'username': 'ZacB', 'displayName': 'Synthetic Owner', 'role': 'owner', 'status': 'active', 'hourlyRate': 0, **DONE},
                     {'id': 'synthetic.crew', 'username': 'Synthetic.Crew', 'displayName': 'Synthetic Crew', 'role': 'crew', 'status': 'active', 'hourlyRate': 20, 'jobTitle': 'Field crew', **DONE}],
        'timeEntries': [{'id': 'time-1', 'employee': me, 'status': 'submitted', 'approvalStatus': 'pending', 'clockInAt': DAY + 'T14:00:00Z', 'clockOutAt': DAY + 'T17:00:00Z', 'hourlyRate': 20, 'jobLabel': 'Synthetic Johnson Garage'}],
        'announcements': [{'id': 'announcement-1', 'title': 'Synthetic crew update', 'body': 'Meet at the shop at 7 with gloves and water.', 'priority': 'normal', 'createdAt': '2026-09-21T15:00:00Z', 'createdBy': 'ZacB', 'readBy': [], 'status': 'active'}],
        'requests': [{'id': 'request-1', 'employee': 'Synthetic.Crew', 'type': 'time_off', 'status': 'pending', 'date': '2026-09-25', 'reason': 'Synthetic appointment', 'createdAt': '2026-09-20T15:00:00Z'}],
        'incidents': [], 'equipment': [], 'training': [],
        'teamMessages': [{'id': 'message-1', 'body': 'Synthetic hello team', 'sender': 'ZacB', 'senderName': 'Synthetic Owner', 'createdAt': DAY + 'T15:00:00Z', 'updatedAt': DAY + 'T15:00:00Z', 'status': 'active'}],
        'jobMessages': [], 'messageReads': [],
    }


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/employee-hub-screens.js': body = (ROOT / 'employee-hub-screens.js').read_text(encoding='utf-8') + REGISTER
        elif path == '/fixture-screen.js': body = FIXTURE_SCREEN
        else: return super().do_GET()
        self.send_response(200); self.send_header('Content-Type', 'application/javascript'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body.encode())


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address): pass  # a closed test page may drop a static request mid-response


class HubShell:
    """Mixin for unittest.TestCase classes; call start()/stop() from setUpClass/tearDownClass."""
    @classmethod
    def start(cls):
        cls.server = Server(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        RESULTS.mkdir(exist_ok=True)
    @classmethod
    def stop(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def open_page(self, width=390, height=844, profile=MANAGER, mobile=None, touch=None):
        # Phones (under 700px wide) are mobile touch devices by default; pass mobile/touch for landscape phones and iPads.
        mobile = width < 700 if mobile is None else mobile
        touch = mobile if touch is None else touch
        self.profile = profile; self.calls = []; self.api_failures = {}; self.extra_team_messages = []
        if not hasattr(self, 'errors'): self.errors = []
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=mobile, has_touch=touch, bypass_csp=True)
        # Loading employee.html runs every Hub script; on a busy shared machine that alone can pass the 7s DOM-wait budget,
        # so navigation gets its own, longer limit. Every other wait keeps 7s.
        self.page = self.context.new_page(); self.page.set_default_timeout(7000); self.page.set_default_navigation_timeout(30000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.clock.install(time=NOW)
        self.page.add_init_script('window.__egcJobs=' + json.dumps(self.job_rows()) + ';')
        self.page.route('**/*', self.route)
        return self.page

    def close_page(self):
        if getattr(self, 'context', None): self.context.close()
        self.context = None

    def open(self, view, width=390, height=844, profile=MANAGER, mobile=None, touch=None):
        page = self.open_page(width, height, profile, mobile, touch)
        page.goto(f'{self.url}/employee.html?view={view}')
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0 && window.EGCHubScreens && !document.querySelector(".hub-screen-loading")')
        return page

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1':
            if parsed.hostname == 'www.gstatic.com' and parsed.path.endswith('/firebase-app-compat.js'):
                route.fulfill(status=200, content_type='application/javascript', body=FIREBASE); return
            if parsed.hostname == 'www.gstatic.com':
                route.fulfill(status=200, content_type='application/javascript', body=''); return
            route.abort(); return
        if not parsed.path.startswith('/api/'): route.continue_(); return
        self.calls.append((request.method, parsed.path, parsed.query))
        def send(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        path, query = parsed.path, parse_qs(parsed.query)
        if path in self.api_failures: send({'ok': False, 'error': self.api_failures[path]}, 503); return
        if path == '/api/hub-auth':
            send(self.profile if request.method in ('GET', 'POST') else {'ok': True}); return
        if path == '/api/firebase-session': send({'ok': True, 'token': 'synthetic-token'}); return
        if path == '/api/integration-status': send({'ok': True, 'status': {'highlevel': True, 'firebase': True, 'employeeAccounts': True, 'customerPortal': True}}); return
        if path == '/api/highlevel':
            view = query.get('view', [''])[0]
            if view == 'command':
                send({'ok': True, 'pipelines': [{'id': 'pipeline-1', 'stages': [{'id': 'stage-1', 'name': 'New lead'}]}], 'leadResetAt': '2026-09-03T00:00:00Z',
                      'opportunities': [{'id': 'opportunity-1', 'name': 'Synthetic lead', 'pipelineStageId': 'stage-1', 'monetaryValue': 2250, 'status': 'open', 'source': 'Website', 'contact': {'name': 'Synthetic Lead', 'phone': '9705550111'}}]}); return
            if view == 'contacts': send({'ok': True, 'contacts': [{'id': 'contact-1', 'name': 'Synthetic Customer', 'phone': '9705550100'}]}); return
            if request.method == 'GET': send({'ok': True, 'events': []}); return
            send({'ok': False, 'error': 'Synthetic HighLevel is offline'}, 503); return
        if path == '/api/employee-hub':
            if request.method == 'GET':
                data = collections(self.profile); data['teamMessages'] += copy.deepcopy(self.extra_team_messages)
                send({'ok': True, 'collections': data, 'accounts': []}); return
            body = request.post_data_json or {}; send({'ok': True, 'record': body.get('data') or {}}); return
        if path == '/api/employee-accounts': send({'ok': True, 'accounts': []}); return
        if path == '/api/crew-jobs': send({'ok': True, 'jobs': copy.deepcopy(self.job_rows())}); return
        if path == '/api/field-jobs': send({'ok': True, 'jobs': [{**self.job_rows()[0], 'crewMembers': [{'id': 'synthetic.crew', 'name': 'Synthetic Crew'}], 'crewLead': 'synthetic.crew', 'vehicleName': 'Synthetic truck'}], 'generatedAt': DAY + 'T18:00:00Z'}); return
        if path == '/api/dispatch' and request.method == 'GET':
            start = query.get('startDate', [DAY])[0]; end = query.get('endDate', ['2026-09-29'])[0]
            send({'ok': True, 'viewer': {'id': 'zacb'}, 'timeZone': 'America/Denver', 'jobs': [{**self.job_rows()[0], 'revision': 'rev-1', 'startAt': DAY + 'T08:00:00-06:00', 'endAt': DAY + 'T11:00:00-06:00'}],
                  'roster': [{'id': 'synthetic.crew', 'name': 'Synthetic Crew', 'role': 'crew'}, {'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner'}], 'crews': [], 'vehicles': [], 'availability': [],
                  'warnings': [], 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'startDate': start, 'endDate': end}); return
        if path == '/api/crew-availability' and request.method == 'GET':
            send({'ok': True, 'timeZone': 'America/Denver', 'employee': {'id': 'synthetic.crew', 'name': 'Synthetic Crew'}, 'startDate': DAY, 'endDate': '2026-10-22', 'availability': [], 'exceptions': [], 'coverage': {'complete': True}}); return
        if path == '/api/dispatch-settings' and request.method == 'GET':
            values = {'defaultTravelBufferMinutes': 20, 'defaultArrivalWindowMinutes': None, 'workdayStart': '08:00', 'workdayEnd': '17:00', 'blockCrewShort': False, 'blockSkillMissing': True, 'blockTravelShort': False,
                      'blockOverCapacity': False, 'blockOutsideHours': False, 'maxJobsPerEmployeePerDay': 4, 'maxHoursPerEmployeePerDay': 9.5}
            send({'ok': True, 'authority': 'employee_hub', 'settings': {'revision': 'settings-rev-1', 'source': 'firestore', 'values': values, 'invalidFields': [], 'updatedAt': DAY + 'T15:00:00Z', 'updatedBy': 'zacb'},
                  'defaults': values, 'skills': [{'id': 'shelving', 'label': 'Shelving install'}], 'viewer': {'id': 'zacb'},
                  'environment': {'arrival': {'enabled': False, 'minutes': 60}, 'envArrivalMinutes': 60, 'travelEstimates': 'off', 'envBlockTravelShort': False, 'staffDirectory': False}}); return
        if path == '/api/staff-directory' and request.method == 'GET': send(copy.deepcopy(STAFF)); return
        # GHL-TRACK-1: the Command center's HighLevel tag widget asks whether anything is stuck; the outbox is off here.
        if path == '/api/ghl-tag-drain' and request.method == 'GET': send({'ok': True, 'enabled': False}); return
        if path == '/api/operations' and request.method == 'GET':
            send({'ok': True, 'enabled': False, 'actor': {'id': 'zacb', 'role': 'owner', 'kind': 'human'}, 'owners': [{'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner'}]}); return
        send({'ok': False, 'error': 'Synthetic service unavailable'}, 503)

    def job_rows(self):
        """The synthetic jobs every surface reads; a test class sets `jobs` to swap in its own (long-name) fixtures."""
        return getattr(self, 'jobs', None) or JOBS

    def nav_views(self):
        return self.page.evaluate("[...document.querySelectorAll('.ops-nav [data-ops-tab]')].map(button=>button.dataset.opsTab)")

    def go(self, view):
        self.page.evaluate('view=>opsGo(view)', view)
        self.page.wait_for_function('view=>new URLSearchParams(location.search).get("view")===view', arg=view)
        self.page.wait_for_function('!document.querySelector(".hub-screen-loading")')

    def settle(self):
        """Waits (on DOM markers, not time) until no screen in #ops-main shows a loading skeleton."""
        self.page.wait_for_function('!document.querySelector(' + json.dumps(LOADING) + ')')

    def no_horizontal_scroll(self):
        return self.page.evaluate('''()=>{const html=document.documentElement,body=document.body,before=[html.style.overflowX,body.style.overflowX];html.style.overflowX='visible';body.style.overflowX='visible';
          const width=html.scrollWidth,wide=[...document.querySelectorAll('.ops-shell *')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.right>innerWidth+1&&s.position!=='fixed'&&!el.closest('.ops-rail')&&!el.closest('[style*="overflow"],.hub-table-scroll,.ops-fly-row,.ops-week,.dp-scroll,.ac-scroll')}).slice(0,5).map(el=>el.tagName+'.'+String(el.className).slice(0,50)+' right='+Math.round(el.getBoundingClientRect().right));
          [html.style.overflowX,body.style.overflowX]=before;return{width,viewport:innerWidth,wide};}''')

    def small_inputs(self, scope='.ops-shell, #ops-hub-layer, .ops-modal'):
        return self.page.evaluate('''scope=>[...document.querySelectorAll(scope)].flatMap(root=>[...root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea')])
          .filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&!el.closest('[inert]')&&parseFloat(s.fontSize)<16})
          .map(el=>el.tagName.toLowerCase()+'[name='+(el.name||'')+'].'+String(el.className||'').slice(0,40)+' '+getComputedStyle(el).fontSize)''', scope)

    def small_targets(self, scope='.ops-shell, #ops-hub-layer, .ops-modal'):
        return self.page.evaluate('''scope=>{const out=[];const seen=new Set();
          const shown=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[inert]')};
          const inlineText=a=>{if(getComputedStyle(a).display!=='inline')return false;const block=a.parentElement;return Boolean(block)&&block.textContent.trim().length>a.textContent.trim().length};
          for(const root of document.querySelectorAll(scope))for(const el of root.querySelectorAll('button,a[href],select,input[type=checkbox],input[type=radio]')){
            const target=el.matches('input')?(el.closest('label')||el):el;if(seen.has(target))continue;seen.add(target);
            if(!shown(target)||el.matches('a')&&inlineText(el)||el.matches('.ops-scrim,.ops-modal-scrim'))continue;
            const r=target.getBoundingClientRect();if(r.height<44-0.5)out.push(target.tagName.toLowerCase()+'.'+String(target.className||'').trim().replace(/\\s+/g,'.').slice(0,60)+' "'+String(target.textContent||target.getAttribute('aria-label')||'').trim().slice(0,30)+'" '+Math.round(r.height)+'px');}
          return out;}''', scope)

    def audit(self, scope=None, skip=None, targets=True):
        """The ported mobile audit (AUDIT) for the page or a scope; one evaluate, no waits."""
        return self.page.evaluate(AUDIT, {'scope': scope, 'skip': skip, 'targets': targets})

    def dialog_box(self, selector, submit=None):
        return self.page.evaluate(DIALOG_BOX, [selector, submit])

    def contrast(self, selectors):
        return self.page.evaluate(CONTRAST, list(selectors))
