/* CREW-PUSH (functions/_lib/crew-push.js, EGC_CREW_CHAT_PUSH with HUB_OFFLINE_ENABLED): crew-chat alerts on a phone
   whose Hub is closed or locked. "Enable browser alerts" on My day subscribes this browser through the installed Hub's
   worker (hub-sw.js) and saves the subscription for the signed-in person (/api/hub-push); a Hub that already had
   alerts on subscribes once its records load (sync). Turning alerts off or signing out removes it from the server and
   unsubscribes the browser, so a shared phone stops alerting for the person who left.
   An iPhone gets Web Push only from the Hub added to its home screen (iOS 16.4 or later), so in Safari it is told how
   to add it instead. With the switch off, nothing here subscribes, and My day shows nothing new. */
(()=>{
'use strict';
const CONFIG='/api/hub-push',MARK='egc_crew_push',REFRESH_MS=7*86400000,WORKER_WAIT=10000;
let config=null,known=null,synced=false;
const identity=()=>{try{return String(sessionStorage.getItem('egc_u')||localStorage.getItem('egc_u')||'').trim()}catch{return''}};
const standalone=()=>{try{return navigator.standalone===true||Boolean(window.matchMedia?.('(display-mode: standalone)').matches)}catch{return false}};
const appleMobile=()=>{const agent=String(navigator.userAgent||'');return /iPhone|iPad|iPod/.test(agent)||navigator.platform==='MacIntel'&&Number(navigator.maxTouchPoints)>1};
const supported=()=>'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
const bytes=text=>{const padded=String(text).replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((String(text).length+3)%4);return Uint8Array.from(atob(padded),char=>char.charCodeAt(0))};
const text=buffer=>{if(!buffer)return'';let binary='';for(const byte of new Uint8Array(buffer))binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
const readMark=()=>{try{return JSON.parse(localStorage.getItem(MARK)||'null')}catch{return null}};
const writeMark=value=>{try{if(value)localStorage.setItem(MARK,JSON.stringify(value));else localStorage.removeItem(MARK)}catch{}};
function load(){
  if(config)return config;
  const answer=config=fetch(CONFIG,{credentials:'same-origin',cache:'no-store'}).then(response=>response.json()).then(data=>data?.ok===true&&data.enabled===true&&typeof data.publicKey==='string'?{enabled:true,publicKey:data.publicKey}:{enabled:false}).catch(()=>{if(config===answer)config=null;return null}).then(value=>{if(value)known=value;fill();return value||{enabled:false}});
  return answer;
}
// The Hub's worker, once it is registered (employee-hub-screens.js installs it when HUB_OFFLINE_ENABLED is on).
function worker(wait=true){
  if(!('serviceWorker'in navigator))return Promise.resolve(null);
  if(!wait)return navigator.serviceWorker.getRegistration('/').catch(()=>null);
  return Promise.race([navigator.serviceWorker.ready,new Promise(resolve=>setTimeout(()=>resolve(null),WORKER_WAIT))]).catch(()=>null);
}
const needsInstall=()=>known?.enabled===true&&appleMobile()&&!standalone();
/** Subscribes this browser. Resolves to 'on', 'off' (switch off), 'install' (iPhone outside the home-screen Hub),
 *  'unsupported' or 'failed'. quiet: the once-per-page check, which writes only when the subscription is new or old. */
async function enable({quiet=false}={}){
  const current=await load();
  if(!current.enabled)return'off';
  if(needsInstall())return'install';
  if(!supported()||Notification.permission!=='granted')return'unsupported';
  const user=identity();
  if(!user)return'failed';
  try{
    const registration=await worker();
    if(!registration?.pushManager)return'unsupported';
    let subscription=await registration.pushManager.getSubscription();
    // A new VAPID key pair (the owner replaced them) needs a new subscription.
    if(subscription&&text(subscription.options?.applicationServerKey)!==current.publicKey){await subscription.unsubscribe().catch(()=>{});subscription=null}
    if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(current.publicKey)});
    const json=subscription.toJSON(),mark=readMark();
    if(quiet&&mark?.user===user&&mark.endpoint===json.endpoint&&Date.now()-Number(mark.at||0)<REFRESH_MS)return'on';
    const response=await fetch(CONFIG,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:json})});
    if(!response.ok)return'failed';
    writeMark({user,endpoint:json.endpoint,at:Date.now()});
    return'on';
  }catch{return'failed'}
}
/** Stops alerts on this device: removed on the server (best effort) and unsubscribed in the browser. */
async function disable(){
  writeMark(null);
  try{
    const registration=await worker(false),subscription=await registration?.pushManager?.getSubscription();
    if(!subscription)return;
    await fetch(CONFIG,{method:'DELETE',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:subscription.endpoint})}).catch(()=>{});
    await subscription.unsubscribe().catch(()=>{});
  }catch{}
}
// Once per page, after the Hub's records load: a person who already turned alerts on gets the phone alerts too.
function sync(){
  if(synced)return;
  synced=true;
  let on=false;
  try{on='Notification'in window&&Notification.permission==='granted'&&localStorage.getItem('egc_browser_alerts')==='on'}catch{}
  if(on)void enable({quiet:true}).then(state=>{if(state!=='on')synced=false;fill()});
  else void load();
}
const INSTALL='On iPhone, crew-chat alerts need the Hub on your home screen: in Safari tap Share, then Add to Home Screen. Open EGC Hub from the home screen, sign in and tap Enable browser alerts.';
// My day's note beside the alerts button: filled in place (no re-render) once the switch has answered.
function note(){setTimeout(fill,0);return'<p class="ops-crew-push-note" id="ops-crew-push-note" role="status" hidden></p>'}
function fill(){
  const slot=typeof document!=='undefined'?document.getElementById('ops-crew-push-note'):null;
  if(!slot)return;
  let copy='';
  if(needsInstall())copy=INSTALL;
  else if(known?.enabled&&readMark()?.user===identity()&&identity())copy='Phone alerts are on: crew-chat messages reach this device even when the Hub is closed.';
  slot.textContent=copy;slot.hidden=!copy;
}
window.addEventListener('egc:signout',()=>{synced=false;void disable()});
window.EGCCrewPush=Object.freeze({load,enable,disable,sync,note,needsInstall,installCopy:INSTALL});
})();
