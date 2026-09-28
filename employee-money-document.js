/* Hands Hub "Print estimate/invoice" to the server-rendered document (M4) while
 * MONEY_DOCUMENT_ENABLED is on. The flag is read once per sign-in from the
 * route's probe; while it is off (or unknown) opsPrintDocument keeps writing
 * its own print view into the window it already opened. The probe is a plain
 * same-origin fetch, not hubFetch: printing never signs anyone out, and a
 * probe that fails or takes longer than PROBE_MS prints the legacy view. A
 * 401/403 answer is remembered as "off" until sign-out, like an explicit off.
 * print() is for receipts, which have no legacy view: server document only. */
(function () {
'use strict';
const KINDS=['estimate','invoice','receipt'],JOB_ID=/^[A-Za-z0-9_-]{1,180}$/,PROBE_MS=3000;
const S={enabled:null,probe:null,generation:0};
function documentUrl(id,kind){return new URL('/api/money-document?'+new URLSearchParams({job_id:String(id),kind}),location.origin).href;}
function valid(id,kind){return KINDS.includes(kind)&&JOB_ID.test(String(id||''))&&!/^(secure_|_egc_)/.test(id);}
function toast(message){if(typeof showToast==='function')showToast(message);}
function enabled(){
  if(S.enabled!==null)return Promise.resolve(S.enabled);
  if(S.probe)return S.probe;
  if(typeof fetch!=='function')return Promise.resolve(false);
  const generation=S.generation,controller=typeof AbortController==='function'?new AbortController():null,timer=controller?setTimeout(()=>controller.abort(),PROBE_MS):null;
  S.probe=fetch('/api/money-document?probe=1',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},...(controller?{signal:controller.signal}:{})}).then(async response=>{
    const data=await response.json().catch(()=>null),answered=response.ok&&data?.ok===true&&typeof data.enabled==='boolean',denied=response.status===401||response.status===403;
    if((answered||denied)&&generation===S.generation)S.enabled=answered&&data.enabled;
    return answered&&data.enabled;
  }).catch(()=>false).finally(()=>{if(timer)clearTimeout(timer);if(generation===S.generation)S.probe=null;});
  return S.probe;
}
async function open(win,id,kind){
  if(!win||!valid(id,kind)||!await enabled())return false;
  try{win.location.replace(documentUrl(id,kind));return true;}catch{return false;}
}
async function print(id,kind){
  if(!valid(id,kind))return false;
  const win=window.open('','_blank','width=900,height=960');
  if(!win){toast('Allow pop-ups to open the printable document');return false;}
  win.opener=null;
  if(await open(win,id,kind))return true;
  try{win.close();}catch{}
  toast(S.enabled===false?`Printable ${kind}s are not available yet.`:`The ${kind} could not be opened. Please try again.`);
  return false;
}
function reset(){S.generation++;S.enabled=null;S.probe=null;}
window.addEventListener('egc:signout',reset);
window.EGCMoneyDocument={open,print,enabled,documentUrl,reset};
})();
