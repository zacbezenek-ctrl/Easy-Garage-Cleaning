/* Owner/manager control for customer portal documents (certificate of insurance). */
(function () {
'use strict';
const TZ='America/Denver', API='/api/portal-documents-admin', STATES=['current','expiring_soon','expired','missing','invalid','unavailable'];
const S={host:null,root:null,data:null,loading:false,error:'',errorStatus:0,denied:false,notice:'',busy:false,request:null,uncertain:false,file:null,expiresOn:'',generation:0,controller:null,submitController:null,dialog:null};
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value]of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else if(name in node&&!name.startsWith('aria-')&&name!=='role')node[name]=value;else node.setAttribute(name,String(value));}for(const child of children.flat())if(child!=null&&child!==false)node.append(child instanceof Node?child:String(child));return node;}
function today(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;}
function validDate(date){return typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;}
function addDays(date,n){return new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
function dateLabel(date){return validDate(date)?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z')):'';}
function when(value){const time=Date.parse(value||'');return Number.isFinite(time)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(time)):'';}
function size(bytes){return bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';}
function uuid(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const x=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return x.slice(0,8)+'-'+x.slice(8,12)+'-'+x.slice(12,16)+'-'+x.slice(16,20)+'-'+x.slice(20);}
// Anything but the documented shape is "unverified", never an empty state.
function valid(data){const i=data&&data.insurance;return Boolean(data&&data.ok===true&&typeof data.revision==='string'&&i&&STATES.includes(i.state)&&typeof i.available==='boolean'&&typeof i.expiresOn==='string'&&Array.isArray(data.history)&&(data.pendingUpload==null||typeof data.pendingUpload==='object'));}
async function api(body,signal){const response=await fetch(API,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal});const data=await response.json().catch(()=>({}));if(!response.ok||data.ok!==true)throw Object.assign(new Error(data.error||'Portal documents are unavailable. Retry shortly.'),{status:response.status,code:data.code||''});if(!valid(data))throw Object.assign(new Error('Portal documents returned an unverified response. Retry before changing the certificate.'),{status:503});return data;}
function issue(error){if(error.status===401)return'Your sign-in expired. Sign in again, then retry.';if(error.status===403)return error.message||'Only the owner or a manager can manage portal documents.';return error.message||'Portal documents are unavailable. Retry shortly.';}
async function load(){
  if(!S.root||S.busy)return;
  const generation=++S.generation;S.controller?.abort();const controller=S.controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);S.loading=true;S.error='';render();
  try{const data=await api(null,controller.signal);if(generation!==S.generation)return;S.data=data;S.errorStatus=0;S.denied=false;}
  catch(error){if(generation!==S.generation)return;S.denied=error.status===403;S.error=S.denied?'':error.name==='AbortError'?'Portal documents did not respond. Retry shortly.':issue(error);S.errorStatus=error.status||0;S.data=null;S.notice='';}
  finally{clearTimeout(timer);if(generation===S.generation){S.loading=false;render();}}
}
async function submit(body){
  if(S.busy)return;
  const generation=S.generation;
  S.request=body;S.busy=true;S.error='';S.notice='';render();
  const controller=S.submitController=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
  let conflict=false;
  try{
    const data=await api(body,controller.signal);
    if(generation!==S.generation)return;
    S.data={...S.data,...data};S.errorStatus=0;S.denied=false;S.request=null;S.uncertain=false;
    if(body.action==='upload'){S.file=null;S.expiresOn='';S.notice='Certificate saved. Customers can download it from their private portal.';}
    else S.notice='Certificate withdrawn. Customers are asked to call or text for a copy.';
  }catch(error){
    if(generation!==S.generation)return;
    const keep=error.name==='AbortError'||!error.status||error.status>=500||[401,403,408,429].includes(error.status);
    S.error=error.name==='AbortError'?'The save did not finish. Retry the original request to safely check it.':issue(error);
    if(keep){S.uncertain=true;S.data=null;S.errorStatus=error.status||0;}else{S.request=null;S.uncertain=false;}
    conflict=/REVISION_CONFLICT/.test(error.code||'');
  }finally{clearTimeout(timer);if(generation===S.generation){S.busy=false;render();}}
  if(conflict){const message=S.error;await load();if(generation===S.generation&&!S.error){S.error=message;render();}}
}
function readFile(file){
  S.error='';S.notice='';
  const max=Number(S.data?.maxBytes)||5242880;
  if(!file)return;
  if(!(file.type==='application/pdf'||/\.pdf$/i.test(file.name||''))){S.file=null;S.error='Choose the certificate as a PDF file.';render();return;}
  if(file.size>max){S.file=null;S.error='The certificate PDF must be '+size(max)+' or smaller.';render();return;}
  const reader=new FileReader();
  reader.onload=()=>{const url=String(reader.result||'');S.file={name:String(file.name||'Certificate of insurance.pdf').slice(0,120),size:file.size,dataUrl:url.replace(/^data:[^,]*;base64,/,'data:application/pdf;base64,')};render();};
  reader.onerror=()=>{S.file=null;S.error='This file could not be read. Choose it again.';render();};
  reader.readAsDataURL(file);
}
function upload(){
  if(S.loading||S.busy||S.request||!S.data)return;
  if(!S.file){S.error='Choose the certificate PDF first.';render();return;}
  if(!validDate(S.expiresOn)||S.expiresOn<=today()){S.error='Enter the policy expiration date printed on the certificate. It must be in the future.';render();return;}
  void submit({action:'upload',requestId:uuid(),expectedRevision:S.data.revision,expiresOn:S.expiresOn,filename:S.file.name,dataUrl:S.file.dataUrl});
}
function closeDialog(){S.dialog?.close();S.dialog?.remove();S.dialog=null;}
function confirmWithdraw(){
  if(S.loading||S.busy||S.request||!S.data||S.dialog)return;
  const dialog=h('dialog',{class:'pd-dialog','aria-labelledby':'pd-withdraw-title',onclose:()=>{if(S.dialog===dialog)S.dialog=null;dialog.remove();}},
    h('h2',{id:'pd-withdraw-title'},'Withdraw the certificate?'),
    h('p',{},'Customers will no longer be able to download it and will be asked to call or text for a copy. The file stays in Google Drive.'),
    h('div',{class:'pd-actions'},h('button',{type:'button',class:'pd-button',onclick:closeDialog},'Keep it'),h('button',{type:'button',class:'pd-button danger',onclick:()=>{closeDialog();void submit({action:'withdraw',requestId:uuid(),expectedRevision:S.data.revision});}},'Withdraw')));
  S.dialog=dialog;document.body.append(dialog);if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
}
function statusBlock(){
  const d=S.data,i=d.insurance,until=dateLabel(i.expiresOn);
  const copy={current:['good','Current','Customers can download it. Expires '+until+'.'],expiring_soon:['warn','Expires soon',(i.daysRemaining===1?'Expires tomorrow':'Expires in '+i.daysRemaining+' days')+' ('+until+'). Upload the renewed certificate before then.'],expired:['bad','Expired','Expired '+(until||'')+'. Customers cannot download it until the renewed certificate is uploaded.'],missing:['bad','Missing','No certificate is uploaded. Customers are asked to call or text for a copy.'],invalid:['bad','Needs review','The saved certificate record is incomplete. Upload the certificate again.'],unavailable:['bad','Unavailable','Customers cannot download it because Google Drive is not connected. Finish the Drive setup'+(until?'; the saved certificate expires '+until+'.':'.')]}[i.state];
  const alert=copy[0]!=='good';
  return h('div',{class:'pd-status '+copy[0],role:alert?'alert':null},
    h('div',{class:'pd-status-head'},h('b',{},'Certificate of insurance'),h('span',{class:'pd-badge '+copy[0]},copy[1])),
    h('p',{},copy[2]),
    i.uploadedAt?h('p',{class:'pd-muted'},'Uploaded '+when(i.uploadedAt)+(i.uploadedBy?' by '+i.uploadedBy:'')+(i.filename?' · '+i.filename:'')+(i.size?' · '+size(i.size):'')):null,
    d.pendingUpload&&!S.request?h('p',{class:'pd-muted'},'An upload'+(d.pendingUpload.by?' by '+d.pendingUpload.by:'')+(when(d.pendingUpload.startedAt)?' started '+when(d.pendingUpload.startedAt):'')+' has not finished. Uploading or withdrawing a certificate cancels it.'):null,
    d.driveConfigured===false&&i.state!=='unavailable'?h('p',{class:'pd-muted'},'Google Drive is not connected, so uploads and downloads are unavailable until Drive setup is finished.'):null,
    i.state!=='missing'&&d.driveConfigured!==false?h('a',{class:'pd-link',href:API+'?file=insurance',target:'_blank',rel:'noopener'},'Open the saved PDF'):null);
}
function formBlock(){
  const locked=S.loading||S.busy||Boolean(S.request)||!S.data;
  const fileInput=h('input',{type:'file',id:'pd-file',class:'pd-file',accept:'application/pdf,.pdf','aria-label':'Certificate PDF (5 MB max)',disabled:locked,onchange:e=>readFile(e.target.files&&e.target.files[0])});
  const dateInput=h('input',{type:'date',id:'pd-expires',value:S.expiresOn,min:addDays(today(),1),disabled:locked,oninput:e=>{S.expiresOn=e.target.value;}});
  return h('form',{class:'pd-form',onsubmit:e=>{e.preventDefault();upload();}},
    h('h3',{},S.data?.insurance?.state==='missing'?'Upload the certificate':'Upload a renewed certificate'),
    h('div',{class:'pd-field'},h('span',{},'Certificate PDF (5 MB max)'),fileInput,h('label',{class:'pd-button pd-choose',htmlFor:'pd-file','aria-hidden':'true','aria-disabled':locked?'true':null},S.file?'Choose a different PDF':'Choose the certificate PDF'),h('small',{},S.file?'Selected: '+S.file.name+' · '+size(S.file.size):'No file chosen yet.')),
    h('label',{class:'pd-field',htmlFor:'pd-expires'},h('span',{},'Policy expiration date'),dateInput,h('small',{},'Customers stop seeing the certificate on this date.')),
    h('div',{class:'pd-actions'},h('button',{type:'submit',class:'pd-button primary',disabled:locked||!S.file},S.busy&&S.request?.action==='upload'?'Uploading…':'Upload certificate'),
      S.data&&S.data.insurance.state!=='missing'?h('button',{type:'button',class:'pd-button danger',disabled:locked,onclick:confirmWithdraw},'Withdraw'):null));
}
function feedback(){
  const items=[];
  if(S.error)items.push(h('div',{class:'pd-notice error',role:'alert'},S.error));
  if(S.notice)items.push(h('div',{class:'pd-notice',role:'status'},S.notice));
  if(S.request&&S.uncertain&&!S.busy)items.push(h('div',{class:'pd-actions'},h('button',{type:'button',class:'pd-button primary',onclick:()=>void submit(S.request)},S.request.action==='upload'?'Retry original upload':'Retry original withdrawal'),h('button',{type:'button',class:'pd-button',onclick:()=>{S.request=null;S.uncertain=false;S.error='';void load();}},'Discard and refresh')));
  return h('div',{class:'pd-feedback','aria-live':'polite'},items);
}
function history(){
  const rows=S.data?.history||[];
  if(!rows.length)return null;
  return h('details',{class:'pd-history'},h('summary',{},'Previous certificates'),h('ul',{},rows.map(row=>h('li',{},(row.expiresOn?'Policy expiration '+dateLabel(row.expiresOn):'Unknown expiration')+(row.withdrawnAt?' · withdrawn '+when(row.withdrawnAt):row.replacedAt?' · replaced '+when(row.replacedAt):'')+(row.uploadedBy?' · uploaded by '+row.uploadedBy:'')))));
}
function render(){
  if(!S.root)return;
  const head=h('div',{class:'pd-head'},h('div',{},h('span',{class:'pd-eyebrow'},'CUSTOMER PORTAL'),h('h2',{},'Portal documents')),h('button',{type:'button',class:'pd-button',disabled:S.loading||S.busy,onclick:()=>void load()},S.loading?'Checking…':'Refresh'));
  const body=[];
  if(S.loading)body.push(h('div',{class:'pd-skeleton','aria-hidden':'true'}),h('div',{class:'pd-skeleton short','aria-hidden':'true'}),h('p',{class:'pd-muted',role:'status'},'Loading portal documents…'));
  else if(S.data)body.push(statusBlock(),formBlock(),history());
  else if(S.denied)body.push(h('p',{class:'pd-muted'},'Only the owner or a manager can manage the certificate of insurance customers download.'));
  else if(S.error&&S.errorStatus!==401){body.push(h('p',{class:'pd-muted'},S.request&&S.uncertain?'Certificate status and the save outcome are unverified. Retry the original request to check what was saved.':'Certificate status is unavailable. Nothing was changed.'));if(S.request&&S.uncertain&&S.request.action==='upload'&&S.errorStatus!==403)body.push(formBlock());}
  S.root.replaceChildren(head,feedback(),...body.filter(Boolean),h('p',{class:'pd-muted'},'The guarantee and service terms customers see come from the published website copy and are versioned in the Hub code.'));
}
// An upload in flight guards the whole tab; a request waiting for Retry only while its button is on screen.
function onUnload(event){if(S.busy||S.request&&S.root&&S.root.isConnected){event.preventDefault();event.returnValue='';}}
// The suite rebuilds the settings screen on background refreshes; the same
// section moves into the new slot so a chosen file and typed date survive.
function mount(host){
  if(!host)return;
  if(S.host===host&&S.root&&S.root.isConnected)return;
  const fresh=!S.root;
  S.host=host;S.root=S.root||h('section',{class:'egc-portal-docs ops-card','aria-label':'Portal documents'});host.replaceChildren(S.root);
  if(!fresh)return;
  render();
  if(!S.loading&&!S.busy)void load();
}
function unmount(){closeDialog();S.root?.remove();S.root=null;S.host=null;}
function reset(){S.generation++;S.controller?.abort();S.submitController?.abort();unmount();Object.assign(S,{data:null,loading:false,error:'',errorStatus:0,denied:false,notice:'',busy:false,request:null,uncertain:false,file:null,expiresOn:''});}
window.addEventListener('beforeunload',onUnload);
window.addEventListener('egc:signout',reset);
window.EGCPortalDocuments={mount,unmount,refresh:()=>load(),canLeave:()=>!S.busy&&!S.request};
})();
