/* Employee Hub screen registry. A new Hub screen is its own files plus one
   MANIFEST line below; employee-suite.js adds it to the nav and mounts it. */
(function(){
'use strict';
const KIT={js:'employee-ui-kit.js',css:'employee-ui-kit.css',v:'20260927hubreg'};
// One line per screen: {id, group, label, iconPath, capability:'business'|'owner' or crewVisible:true, load:{js, css, v}, module:'EGCName'}.
// Capabilities come from the signed-in server profile (businessAccess and the owner flag), never a client staff list.
// Group and label are plain text (the shell escapes them, so 'Estimates & payments' is fine); angle brackets,
// backticks and control characters are refused. An invalid line is skipped with a console warning.
// The screen file defines window.EGCName={mount(host,ctx), unmount(), canLeave(), refresh()}; ctx is
// {identity, role, capabilities, hubFetch, toast, askAction, go, screen}. The kit (window.EGCHubKit) loads first.
const MANIFEST=[
];
const ID=/^[a-z][a-z0-9_]{1,47}$/,CAPABILITY=/^[a-z][a-z0-9_]{1,40}$/,MODULE=/^EGC[A-Za-z0-9]{1,40}$/,VERSION=/^[A-Za-z0-9._-]{1,40}$/,ICON=/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,800}$/;
const ASSET=/^\/?(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css)$/,ASSET_TIMEOUT=30000;
const screens=new Map(),assets=new Map();
let active=null;
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
  let load=null;
  if(spec.load!=null){
    const {js,css,v}=spec.load;
    if(js!=null&&!ASSET.test(String(js))||css!=null&&!ASSET.test(String(css))||!VERSION.test(String(v||''))||js==null&&css==null)fail(id+' has an invalid load manifest');
    load=Object.freeze({js:js==null?null:String(js),css:css==null?null:String(css),v:String(v)});
  }
  if(spec.module!=null&&!MODULE.test(String(spec.module)))fail(id+' has an invalid module name');
  for(const key of ['mount','unmount','canLeave','refresh','homeWidget'])if(spec[key]!=null&&typeof spec[key]!=='function')fail(id+'.'+key+' must be a function');
  if(typeof spec.mount!=='function'&&!spec.module)fail(id+' needs mount() or a module that provides it');
  if(spec.module&&!load?.js)fail(id+' loads its module from load.js');
  const entry=Object.freeze({id,group,label,iconPath:spec.iconPath==null?'':String(spec.iconPath),capability,crewVisible,load,module:spec.module?String(spec.module):'',
    mount:spec.mount||null,unmount:spec.unmount||null,canLeave:spec.canLeave||null,refresh:spec.refresh||null,homeWidget:spec.homeWidget||null});
  screens.set(id,entry);
  return entry;
}
const list=()=>[...screens.values()];
const get=id=>screens.get(String(id||''))||null;
const allowed=(entry,capabilities=[])=>Boolean(entry&&(entry.crewVisible||entry.capability&&[...capabilities].includes(entry.capability)));
const visible=capabilities=>list().filter(entry=>allowed(entry,capabilities));
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
function notice(host,entry,retry){
  const box=document.createElement('div'),title=document.createElement('strong'),copy=document.createElement('p'),again=document.createElement('button');
  box.className='hub-notice error';box.setAttribute('role','alert');
  title.textContent=entry.label+' is unavailable';
  copy.textContent='This screen could not load, so nothing here is shown as current. Check the connection and retry.';
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
async function refresh(id){if(active&&active.id===id&&active.mounted)await active.module.refresh?.();}
const current=()=>active?{id:active.id,mounted:active.mounted}:null;
window.addEventListener('egc:signout',unmountAll);
window.addEventListener('beforeunload',event=>{if(active?.mounted&&!canLeave(active.id)){event.preventDefault();event.returnValue='';}});
window.EGCHubScreens=Object.freeze({register,list,get,allowed,visible,widgets,mount,unmountAll,canLeave,refresh,current,kit:KIT});
for(const spec of MANIFEST){try{register(spec);}catch(error){console.warn('Hub screen registry skipped a MANIFEST entry:',error?.message||error);}}
})();
