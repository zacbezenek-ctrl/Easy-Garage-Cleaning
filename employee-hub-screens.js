/* Employee Hub screen registry. A new Hub screen is its own files plus one
   MANIFEST line below; employee-suite.js adds it to the nav and mounts it. */
(function(){
'use strict';
const KIT={js:'employee-ui-kit.js',css:'employee-ui-kit.css',v:'20260929mobilehub'};
// One line per screen: {id, group, label, iconPath, capability:'business'|'owner' or crewVisible:true, load:{js, css, v}, module:'EGCName'}.
// Capabilities come from the signed-in server profile (businessAccess and the owner flag), never a client staff list.
// Group and label are plain text (the shell escapes them, so 'Estimates & payments' is fine); angle brackets,
// backticks and control characters are refused. An invalid line is skipped with a console warning.
// The screen file defines window.EGCName={mount(host,ctx), unmount(), canLeave(), refresh()}; ctx is
// {identity, role, capabilities, hubFetch, toast, askAction, go, screen}. The kit (window.EGCHubKit) loads first.
// A screen keeps unsent drafts in sessionStorage under DRAFTS+'<screen>.<viewer>'; sign-out clears them here, because
// this file is always loaded and a lazily loaded screen may never have run on the page.
const MANIFEST=[
{id:'crew_alerts',group:'MY EGC',label:'Schedule alerts',iconPath:'M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0',crewVisible:true,load:{js:'employee-crew-notifications.js',css:'employee-crew-notifications.css',v:'20260929editwipe'},module:'EGCCrewNotifications'},
{id:'password',group:'MY EGC',label:'Password',iconPath:'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2',capability:'password',load:{js:'employee-staff-access.js',css:'employee-staff-access.css',v:'20260929accessr2'},module:'EGCStaffAccess'},
{id:'followup_settings',group:'SYSTEM',label:'Follow-up owner',iconPath:'M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0',capability:'owner',load:{js:'employee-followup-settings.js',css:'employee-followup-settings.css',v:'20260928followup'},module:'EGCFollowupSettings'},
{id:'ad_spend',group:'GROW THE ENGINE',label:'Ad spend',iconPath:'M3 10v4h4l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12',capability:'owner',load:{js:'employee-ad-spend.js',css:'employee-ad-spend.css',v:'20260928adspend'},module:'EGCAdSpend'},
{id:'catalog',group:'SYSTEM',label:'Catalog & pricing',iconPath:'M4 4h7l9 9-7 7-9-9zM8 8h.01',capability:'owner',load:{js:'employee-catalog.js',css:'employee-catalog.css',v:'20260928catalog'},module:'EGCCatalog'},
{id:'dispatch_rules',group:'RUN THE BUSINESS',label:'Dispatch rules',iconPath:'M4 6h11M4 12h7M4 18h5M14 15l2.5 2.5L21 13',capability:'owner',load:{js:'employee-dispatch-settings.js',css:'employee-dispatch-settings.css',v:'20260929rules4'},module:'EGCDispatchSettings'},
{id:'reviews',group:'RUN THE BUSINESS',label:'Review queues',iconPath:'M9 3h6v3H9zM6 5h3v1h6V5h3v16H6zM9 13l2 2 4-4',capability:'business',load:{js:'employee-reviews.js',css:'employee-reviews.css',v:'20260929reviewstips7'},module:'EGCReviews'},
{id:'message_templates',group:'SYSTEM',label:'Message templates',iconPath:'M4 5h16v11H9l-5 4z',capability:'business',load:{js:'message-templates.js',css:'message-templates.css',v:'20260928crew'},module:'EGCMessageTemplates'},
{id:'stocked_costs',group:'SYSTEM',label:'Stocked item costs',capability:'business',iconPath:'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',load:{js:'employee-standard-costs.js',css:'employee-standard-costs.css',v:'20260928fun19'},module:'EGCStandardCosts'},
{id:'staff',group:'RUN THE BUSINESS',label:'Staff directory',iconPath:'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.5 3-6 7-6s7 2.5 7 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14c2.5.6 4 2.8 4 6',capability:'business',load:{js:'employee-staff.js',css:'employee-staff.css',v:'20260929access'},module:'EGCStaff'},
{id:'invoicing',group:'CLIENT WORK',label:'Invoicing',iconPath:'M6 3h9l3 3v15H6z M9 9h6 M9 13h6 M9 17h4',capability:'business',load:{js:'employee-money.js',css:'employee-money.css',v:'20260929invoicingr3'},module:'EGCMoney'},
{id:'walkthroughs',group:'RUN THE BUSINESS',label:'Walkthroughs',iconPath:'M9 4h6l1 2h3v14H5V6h3zM9 13l2 2 4-4',capability:'business',load:{js:'employee-walkthroughs.js',css:'employee-walkthroughs.css',v:'20260929hubready1'},module:'EGCWalkthroughs'},
];
// Home widgets, one line each: {id, label, homes:['today'|'my_day',...], capability:'business'|'owner' or crewVisible:true, module:'EGCName', load?:{js, css, v}}.
// employee-suite.js renders one #ops-home-widgets node on the Command center (today) and on My day. mountHome() gives each
// allowed widget its own slot there in this order, keeps the slot across background renders and unmounts it when the viewer
// leaves that home. Without load the module is already on the page (a script tag in employee.html). The widget file defines
// window.EGCName={mount(host,ctx), unmount(), refresh()}; ctx is the screen ctx plus {home, widget}.
const HOME_WIDGETS=[
  {id:'overdue_followups',label:'Overdue follow-ups',homes:['today','my_day'],capability:'business',module:'EGCFollowupsHome'},
];
const HOMES=new Set(['today','my_day']);
const ID=/^[a-z][a-z0-9_]{1,47}$/,CAPABILITY=/^[a-z][a-z0-9_]{1,40}$/,MODULE=/^EGC[A-Za-z0-9]{1,40}$/,VERSION=/^[A-Za-z0-9._-]{1,40}$/,ICON=/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,800}$/;
const ASSET=/^\/?(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css)$/,ASSET_TIMEOUT=30000,DRAFTS='egc.hub.draft.v1.';
const screens=new Map(),assets=new Map(),homeDefs=new Map();
let active=null,home=null;
const fail=message=>{throw new Error('Hub screen registry: '+message);};
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[<>`\u0000-\u001f\u007f]/.test(value)?value.trim():'';
function register(spec){
  if(!spec||typeof spec!=='object')fail('a screen definition is required');
  const id=String(spec.id||'');
  if(!ID.test(id))fail('invalid screen id');
  if(screens.has(id))fail(id+' is already registered');
  const group=text(spec.group,40),label=text(spec.label,60);
  if(!group||!label)fail(id+' needs a nav group and label');
  const crewVisible=spec.crewVisible===true,capability=spec.capability==null?'':String(spec.capability);
  if(crewVisible===Boolean(capability)||capability&&!CAPABILITY.test(capability))fail(id+' must declare exactly one of capability or crewVisible');
  if(spec.iconPath!=null&&!ICON.test(String(spec.iconPath)))fail(id+' has an invalid icon path');
  const load=loadSpec(id,spec.load);
  if(spec.module!=null&&!MODULE.test(String(spec.module)))fail(id+' has an invalid module name');
  for(const key of ['mount','unmount','canLeave','refresh','homeWidget'])if(spec[key]!=null&&typeof spec[key]!=='function')fail(id+'.'+key+' must be a function');
  if(typeof spec.mount!=='function'&&!spec.module)fail(id+' needs mount() or a module that provides it');
  if(spec.module&&!load?.js)fail(id+' loads its module from load.js');
  const entry=Object.freeze({id,group,label,iconPath:spec.iconPath==null?'':String(spec.iconPath),capability,crewVisible,load,module:spec.module?String(spec.module):'',
    mount:spec.mount||null,unmount:spec.unmount||null,canLeave:spec.canLeave||null,refresh:spec.refresh||null,homeWidget:spec.homeWidget||null});
  screens.set(id,entry);
  return entry;
}
function loadSpec(id,load){
  if(load==null)return null;
  const {js,css,v}=load;
  if(js!=null&&!ASSET.test(String(js))||css!=null&&!ASSET.test(String(css))||!VERSION.test(String(v||''))||js==null&&css==null)fail(id+' has an invalid load manifest');
  return Object.freeze({js:js==null?null:String(js),css:css==null?null:String(css),v:String(v)});
}
function registerWidget(spec){
  if(!spec||typeof spec!=='object')fail('a widget definition is required');
  const id=String(spec.id||'');
  if(!ID.test(id))fail('invalid widget id');
  if(homeDefs.has(id))fail('widget '+id+' is already registered');
  const label=text(spec.label,60),homes=Array.isArray(spec.homes)?[...new Set(spec.homes.map(String))]:[];
  if(!label)fail(id+' needs a label');
  if(!homes.length||homes.some(view=>!HOMES.has(view)))fail(id+' needs homes from '+[...HOMES].join(', '));
  const crewVisible=spec.crewVisible===true,capability=spec.capability==null?'':String(spec.capability);
  if(crewVisible===Boolean(capability)||capability&&!CAPABILITY.test(capability))fail(id+' must declare exactly one of capability or crewVisible');
  if(!MODULE.test(String(spec.module||'')))fail(id+' needs a module name');
  const entry=Object.freeze({id,label,homes:Object.freeze(homes),capability,crewVisible,module:String(spec.module),load:loadSpec(id,spec.load)});
  homeDefs.set(id,entry);
  return entry;
}
const list=()=>[...screens.values()];
const get=id=>screens.get(String(id||''))||null;
const allowed=(entry,capabilities=[])=>Boolean(entry&&(entry.crewVisible||entry.capability&&[...capabilities].includes(entry.capability)));
const visible=capabilities=>list().filter(entry=>allowed(entry,capabilities));
// Deprecated HUB-REG stub (a screen's homeWidget function and widgets()): nothing renders it. Add home widgets to HOME_WIDGETS or registerWidget().
const widgets=capabilities=>visible(capabilities).filter(entry=>entry.homeWidget);
function impl(entry){
  if(entry.mount)return entry;
  const module=window[entry.module];
  return module&&typeof module.mount==='function'?module:null;
}
function asset(path,version){
  const url=path+'?v='+encodeURIComponent(version);
  if(assets.has(url))return assets.get(url);
  const css=/\.css$/.test(path);
  const promise=new Promise((resolve,reject)=>{
    const node=document.createElement(css?'link':'script');
    let timer=0;
    const done=error=>{clearTimeout(timer);node.onload=node.onerror=null;if(!error)return resolve(url);assets.delete(url);node.remove();reject(error);};
    timer=setTimeout(()=>done(new Error('asset_timeout')),ASSET_TIMEOUT);
    node.onload=()=>done();node.onerror=()=>done(new Error('asset_unavailable'));
    if(css){node.rel='stylesheet';node.href=url;}else{node.async=false;node.src=url;}
    node.setAttribute('data-egc-hub-asset',path);
    document.head.append(node);
  });
  assets.set(url,promise);
  return promise;
}
async function ensure(entry){
  await Promise.all([asset(KIT.css,KIT.v),window.EGCHubKit?null:asset(KIT.js,KIT.v)]);
  if(!window.EGCHubKit)throw new Error('kit_unavailable');
  if(entry.load)await Promise.all([entry.load.css?asset(entry.load.css,entry.load.v):null,entry.load.js?asset(entry.load.js,entry.load.v):null]);
}
function notice(host,entry,retry,what='screen'){
  const box=document.createElement('div'),title=document.createElement('strong'),copy=document.createElement('p'),again=document.createElement('button');
  box.className='hub-notice error';box.setAttribute('role','alert');
  title.textContent=entry.label+' is unavailable';
  copy.textContent='This '+what+' could not load, so nothing here is shown as current. Check the connection and retry.';
  again.type='button';again.className='hub-btn';again.textContent='Retry';again.addEventListener('click',retry);
  box.append(title,copy,again);host.replaceChildren(box);
}
function skeleton(host,entry){
  const box=document.createElement('div'),status=document.createElement('p');
  box.className='hub-screen-loading';box.setAttribute('aria-busy','true');
  status.className='hub-sr-only';status.setAttribute('role','status');status.textContent='Loading '+entry.label+'…';
  box.append(status,...['','','wide'].map(size=>{const bar=document.createElement('span');bar.className=('hub-skeleton '+size).trim();return bar;}));
  host.replaceChildren(box);
}
async function mount(id,host,ctx={}){
  const entry=get(id);
  if(!entry||!host)return false;
  if(active&&active.id===id&&active.host===host)return active.ready;
  unmountAll();
  const token={id,host,entry,mounted:false,module:null,ready:null};
  active=token;
  token.ready=(async()=>{
    skeleton(host,entry);
    try{await ensure(entry);}catch{if(active===token)notice(host,entry,()=>{if(active===token)active=null;void mount(id,host,ctx);});return false;}
    if(active!==token)return false;
    const module=impl(entry);
    if(!module){notice(host,entry,()=>{if(active===token)active=null;void mount(id,host,ctx);});return false;}
    host.replaceChildren();
    token.module=module;token.mounted=true;
    try{await module.mount(host,Object.freeze({...ctx,screen:entry.id}));}
    catch(error){console.error('Hub screen failed to mount',entry.id,error);if(active===token){token.mounted=false;try{module.unmount?.();}catch{}notice(host,entry,()=>{if(active===token)active=null;void mount(id,host,ctx);});}return false;}
    return active===token;
  })();
  return token.ready;
}
function unmountAll(){
  const token=active;
  active=null;
  if(!token?.mounted)return;
  token.mounted=false;
  try{token.module.unmount?.();}catch(error){console.error('Hub screen failed to unmount',token.id,error);}
}
function canLeave(id){
  if(!active||active.id!==id||!active.mounted)return true;
  try{return active.module.canLeave?.()!==false;}catch{return false;}
}
async function refresh(id){
  if(active&&active.id===id&&active.mounted)await active.module.refresh?.();
  if(home&&home.view===id)await Promise.allSettled([...home.items.values()].filter(item=>item.mounted).map(item=>item.module.refresh?.()));
}
const homeWidgets=(view,capabilities=[])=>[...homeDefs.values()].filter(entry=>entry.homes.includes(view)&&allowed(entry,capabilities));
function widgetItem(entry,view,ctx){
  const slot=document.createElement('section'),item={entry,slot,module:null,mounted:false};
  slot.className='hub-home-widget';slot.setAttribute('data-hub-widget',entry.id);
  const live=()=>home?.items.get(entry.id)===item,retry=()=>{if(live())void item.run();};
  item.run=async()=>{
    skeleton(slot,entry);
    try{await (entry.load?ensure(entry):asset(KIT.css,KIT.v));}catch{if(live())notice(slot,entry,retry,'section');return;}
    if(!live())return;
    const module=window[entry.module];
    if(!module||typeof module.mount!=='function'){notice(slot,entry,retry,'section');return;}
    slot.replaceChildren();item.module=module;item.mounted=true;
    try{await module.mount(slot,Object.freeze({...ctx,home:view,widget:entry.id}));}
    catch(error){console.error('Hub home widget failed to mount',entry.id,error);if(live()){item.mounted=false;try{module.unmount?.();}catch{}notice(slot,entry,retry,'section');}}
  };
  return item;
}
// Renders replace the #ops-home-widgets node; the mounted slots move into the new one instead of mounting again.
function mountHome(view,host,ctx={}){
  const widgets=host&&HOMES.has(view)?homeWidgets(view,ctx.capabilities):[],key=[view,ctx.identity,ctx.role,...(ctx.capabilities||[])].map(String).join('|');
  if(home&&(home.key!==key||!widgets.length))unmountHome();
  if(!widgets.length)return [];
  home||={view,key,items:new Map()};
  for(const entry of widgets){
    let item=home.items.get(entry.id);const fresh=!item;
    if(fresh){item=widgetItem(entry,view,ctx);home.items.set(entry.id,item);}
    if(item.slot.parentNode!==host)host.append(item.slot);
    if(fresh)void item.run();
  }
  return widgets.map(entry=>entry.id);
}
function unmountHome(){
  const current=home;
  home=null;
  if(!current)return;
  for(const item of current.items.values()){
    if(item.mounted){item.mounted=false;try{item.module.unmount?.();}catch(error){console.error('Hub home widget failed to unmount',item.entry.id,error);}}
    item.slot.remove();
  }
}
const current=()=>active?{id:active.id,mounted:active.mounted}:null;
function clearDrafts(){try{for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(String(key||'').startsWith(DRAFTS))sessionStorage.removeItem(key);}}catch{}}
// HUB_OFFLINE_ENABLED (/api/hub-offline): an installable Hub (employee.webmanifest) whose worker (hub-sw.js) keeps the
// versioned employee-* files and whose time-clock and chat posts queue on the device (employee-offline-queue.js).
// A definite off removes an earlier install's worker and file cache. An unreachable or unclear answer changes nothing
// (the queue neither holds new saves nor removes any, though the Hub still shows what an earlier page left queued) and
// is asked again when the connection returns, the Hub is shown again or the Hub next polls its records (pollPeople in
// employee-suite.js), until a definite answer arrives.
const OFFLINE=Object.freeze({config:'/api/hub-offline',worker:'/hub-sw.js',scope:'/',manifest:'/employee.webmanifest',cache:'egc-hub-assets-'});
let offlineSetting=null;
const hubWorker=registration=>[registration?.active,registration?.waiting,registration?.installing].some(worker=>{try{return new URL(worker?.scriptURL||'',location.href).pathname===OFFLINE.worker;}catch{return false;}});
async function installOffline(){
  if(!document.querySelector('link[rel="manifest"]')){const link=document.createElement('link');link.rel='manifest';link.href=OFFLINE.manifest;document.head.append(link);}
  try{await navigator.serviceWorker?.register(OFFLINE.worker,{scope:OFFLINE.scope});}catch(error){console.warn('Hub offline worker was not registered:',error?.message||error);}
}
// The worker keeps serving the pages it controls until they close, so it is told to keep nothing more (and answers)
// before it is unregistered and its files are deleted; a worker that does not answer within 2 s is removed anyway.
const tell=(worker,type)=>new Promise(resolve=>{
  if(typeof worker?.postMessage!=='function'||typeof MessageChannel!=='function')return resolve();
  const channel=new MessageChannel(),done=()=>{clearTimeout(timer);channel.port1.close();resolve();},timer=setTimeout(done,2000);
  channel.port1.onmessage=done;
  try{worker.postMessage({type},[channel.port2]);}catch{done();}
});
const retire=worker=>tell(worker,'egc-hub-offline-retire');
async function removeOffline(){
  try{for(const registration of await navigator.serviceWorker?.getRegistrations?.()||[])if(hubWorker(registration)){await retire(registration.active);await registration.unregister();}}catch{}
  try{for(const name of await caches.keys())if(name.startsWith(OFFLINE.cache))await caches.delete(name);}catch{}
}
async function readOffline(){
  if(typeof fetch!=='function')return null;
  let enabled=null;
  try{const response=await fetch(OFFLINE.config,{credentials:'same-origin',cache:'no-store'}),data=await response.json();if(response.ok&&data?.ok===true&&typeof data.enabled==='boolean')enabled=data.enabled;}catch{enabled=null;}
  if(enabled)await installOffline();else if(enabled===false)await removeOffline();
  // Only a definite answer switches the queue: an unknown one never turns it on, nor removes what waits on the device.
  if(enabled!==null)window.EGCHubOffline?.configure?.({enabled});
  return enabled;
}
// A definite answer holds for the life of the page; an unknown one (a signal blip as the Hub loads) is not kept.
function offline(){
  if(offlineSetting)return offlineSetting;
  const answer=offlineSetting=readOffline().then(enabled=>{if(enabled===null&&offlineSetting===answer)offlineSetting=null;return enabled;});
  return answer;
}
const recheckOffline=()=>{if(!offlineSetting)void offline();};
window.addEventListener('online',recheckOffline);
document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState!=='hidden')recheckOffline();});
// Signing out clears the device copies of the Hub's files, so on a shared phone a signed-out load (EGC_STAFF_PAGE_GATE)
// never gets staff scripts from them offline. The worker is told first, so a file still loading is not kept either; it
// keeps copies again from the next signed-in load. (A Hub left signed in keeps its copies until it signs out.)
async function forgetOfflineFiles(){
  try{for(const registration of await navigator.serviceWorker?.getRegistrations?.()||[])if(hubWorker(registration))await tell(registration.active,'egc-hub-offline-signout');}catch{}
  try{for(const name of await caches.keys())if(name.startsWith(OFFLINE.cache)){const cache=await caches.open(name);for(const request of await cache.keys())await cache.delete(request);}}catch{}
}
window.addEventListener('egc:signout',()=>{unmountAll();unmountHome();clearDrafts();});
window.addEventListener('egc:signout',()=>{void forgetOfflineFiles();});
window.addEventListener('beforeunload',event=>{if(active?.mounted&&!canLeave(active.id)){event.preventDefault();event.returnValue='';}});
window.EGCHubScreens=Object.freeze({register,list,get,allowed,visible,widgets,mount,unmountAll,canLeave,refresh,current,registerWidget,homeWidgets,mountHome,unmountHome,offline,kit:KIT});
for(const spec of MANIFEST){try{register(spec);}catch(error){console.warn('Hub screen registry skipped a MANIFEST entry:',error?.message||error);}}
for(const spec of HOME_WIDGETS){try{registerWidget(spec);}catch(error){console.warn('Hub screen registry skipped a HOME_WIDGETS entry:',error?.message||error);}}
void offline();
})();
