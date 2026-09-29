/* STAFF-ACCESS (EGC_STAFF_PASSWORD_RESET): staff sign-in resets, the signed-in Change password screen (My EGC →
   Password), the account approval dialog (starting role, and from the owner the starting rate) and the owner's Apply rate
   to open weeks. The Team card and the approval board call in through window.EGCStaffAccess; the Hub screen registry
   mounts the Password screen. A reset link is shown here for the manager to copy: the Hub never sends it.
   The server decides every permission; the buttons shown follow the capabilities /api/hub-auth reported. */
(function(){
'use strict';
if(window.EGCStaffAccess)return;
const API='/api/employee-accounts',DIRECTORY='/api/staff-directory',PENDING='egc.hub.pending.v1.staffaccess.',TIMEOUT=30000,TZ='America/Denver';
const ROLE_LABEL={manager:'Manager',crew_lead:'Crew lead',crew:'Crew',sales:'Sales · walkthroughs',phone:'Phone · calls and follow-ups'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,CODE=/^[A-Za-z][A-Za-z0-9_]{1,80}$/,DATE=/^\d{4}-\d{2}-\d{2}$/;
const S={host:null,root:null,slot:null,ctx:null,generation:0,busy:false,dirty:false,dialog:null};

function h(tag,props,...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props||{})){
    if(value==null||value===false)continue;
    if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value;
    else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);
    else if(key==='value'&&/^(INPUT|TEXTAREA)$/.test(node.tagName)){node.defaultValue=String(value);node.value=String(value);}
    else if(key==='checked'){node.defaultChecked=true;node.checked=true;}
    else if(key==='selected'){node.setAttribute('selected','');node.selected=true;}
    else if(key in node&&!key.startsWith('aria-')&&key!=='role'&&typeof value!=='object')node[key]=value;
    else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(typeof child==='object'?child:document.createTextNode(String(child)));
  return node;
}
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const failure=(code,message,status,extra={})=>Object.assign(new Error(message),{code,status,...extra});
function uuid(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const x=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return x.slice(0,8)+'-'+x.slice(8,12)+'-'+x.slice(12,16)+'-'+x.slice(16,20)+'-'+x.slice(20);}
function stored(key){for(const store of [sessionStorage,localStorage]){try{const value=store.getItem(key);if(value!=null)return value;}catch{}}return null;}
function capabilities(){try{const list=JSON.parse(stored('egc_capabilities')||'[]');return Array.isArray(list)?list.filter(item=>typeof item==='string'):[];}catch{return[];}}
const can=name=>capabilities().includes(name);
const viewer=()=>String(stored('egc_u')||'').trim();
const owner=()=>stored('egc_owner')==='true';
// The server reports these capabilities only with EGC_STAFF_PASSWORD_RESET on (a manager holds accounts.approve only by the owner's grant).
const enabled=()=>can('accounts.reset')||can('password.change')||can('accounts.approve')&&!owner();
const approves=()=>enabled()&&can('accounts.approve');
const resets=()=>can('accounts.reset');
// Denver wall time for an instant; the device time zone is never used.
const when=value=>{const time=Date.parse(String(value||''));return Number.isFinite(time)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(time))+' (Denver)':'';};
const dayLabel=date=>DATE.test(String(date))?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z')):'';
const dollars=value=>typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value):'—';
const signOutNote=result=>{const status=String(result?.firebaseRevocation?.status||'');return status==='revocation_pending'?'Ending their Firebase data sessions is pending; it retries on the next Hub load. See Integrations if it stays pending.':status==='revocation_failed'?'Their Firebase data sign-out could not be confirmed; check Integrations.':status==='not_configured'?'Firebase data sessions need the server service account to end.':'';};

function fetcher(ctx){return typeof ctx?.hubFetch==='function'?ctx.hubFetch:typeof window.hubFetch==='function'?window.hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});}
async function request(url,body,ctx,{method=body?'POST':'GET'}={}){
  const controller=new AbortController();let timedOut=false,response,data=null;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},TIMEOUT);
  try{
    response=await fetcher(ctx)(url,{method,cache:'no-store',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});
    data=await response.json().catch(()=>null);
  }catch(error){
    if(timedOut)throw failure('staff_access_timeout','The Hub did not answer in time. Retry before doing anything else.',503,{retryable:true});
    if(error?.code==='HUB_AUTH_REQUIRED')throw failure('staff_access_sign_in_required','Sign in again, then retry.',401,{retryable:true});
    throw failure('staff_access_network','The Hub could not be reached. Retry when the connection returns.',503,{retryable:true});
  }finally{clearTimeout(timer);}
  const status=Number(response?.status)||503;
  if(!record(data))throw failure('staff_access_unverified','The answer could not be verified. Retry.',response?.ok?503:status,{retryable:true});
  if(!response.ok||data.ok!==true){
    const code=typeof data.code==='string'&&CODE.test(data.code)?data.code:'staff_access_unavailable';
    throw failure(code,typeof data.error==='string'&&data.error.trim()?data.error.slice(0,300):'The request could not be completed.',response.ok?503:status,{retryable:status>=500||[401,408,429].includes(status)});
  }
  return data;
}

// A reset or review kept exactly as sent (no passwords ever), per viewer, so a lost answer is retried with the same requestId.
const pendingKey=kind=>PENDING+kind+'.'+encodeURIComponent(viewer().toLowerCase()||'anonymous');
function readPending(kind,username){try{const row=JSON.parse(sessionStorage.getItem(pendingKey(kind))||'null');return record(row)&&record(row.body)&&UUID.test(String(row.body.requestId||''))&&String(row.body.username||'').toLowerCase()===String(username).toLowerCase()?row:null;}catch{return null;}}
function writePending(kind,row){try{sessionStorage.setItem(pendingKey(kind),JSON.stringify(row));}catch{}}
function clearPending(kind){try{sessionStorage.removeItem(pendingKey(kind));}catch{}}
function clearAllPending(){try{for(let i=sessionStorage.length-1;i>=0;i--){const name=sessionStorage.key(i);if(String(name||'').startsWith(PENDING))sessionStorage.removeItem(name);}}catch{}}

// ── dialog shell: one at a time, focus returns to the opener on close ──
function closeDialog(){const d=S.dialog;if(!d)return;S.dialog=null;try{d.node.close();}catch{}d.node.remove();if(d.opener?.isConnected)d.opener.focus?.();}
function openDialog({label,opener,render}){
  closeDialog();
  const node=h('dialog',{class:'sa-dialog','aria-label':label});
  node.addEventListener('cancel',event=>{if(S.dialog?.busy)event.preventDefault();else{event.preventDefault();closeDialog();}});
  const state={node,opener,busy:false,render:()=>{if(S.dialog===state)node.replaceChildren(render(state));}};
  S.dialog=state;document.body.append(node);state.render();
  if(typeof node.showModal==='function')node.showModal();else node.setAttribute('open','');
  node.querySelector('input,select,button.primary')?.focus?.();
  return state;
}
const btn=(label,onclick,kind='',props={})=>h('button',{type:'button',class:('sa-btn '+kind).trim(),onclick,...props},label);
const head=(eyebrow,title)=>h('header',{class:'sa-dialog-head'},h('span',{class:'sa-eyebrow'},eyebrow),h('h2',{},title));
const foot=(...buttons)=>h('footer',{class:'sa-dialog-foot'},buttons);
const alertBox=(text,kind='error')=>text?h('p',{class:'sa-notice '+kind,role:kind==='error'?'alert':'status','aria-live':kind==='error'?null:'polite'},text):null;
const field=(label,control,help)=>h('label',{class:'sa-field'},h('span',{},label),control,help?h('small',{},help):null);

// ── Reset sign-in (Team card) ──
function openReset({username,displayName,opener}={}){
  if(!resets()||!username)return;
  const name=displayName||username,kept=readPending('reset',username);
  const state=openDialog({label:'Reset sign-in for '+name,opener,render:s=>{
    if(s.result){
      const r=s.result,note=signOutNote(r);
      if(!r.link)return h('div',{class:'sa-body'},head('SIGN-IN RESET','Reset already saved'),h('p',{},r.message||'This reset was already saved. Its link was shown when it was issued; issue a new reset if it was lost.'),foot(btn('Close',closeDialog,'primary')));
      const input=h('input',{type:'text',readOnly:true,value:r.link,'aria-label':'Sign-in link for '+name,class:'sa-link',onfocus:event=>event.target.select()});
      return h('div',{class:'sa-body'},head('SIGN-IN RESET',name+' is signed out'),
        h('p',{},'Give this link to '+name+' yourself, in person or by your own message. The Hub has not sent it. It works once, until '+when(r.expiresAt)+'.'),
        input,alertBox(s.copied?'Link copied.':'', 'success'),
        h('p',{class:'sa-muted'},'Their Hub sessions have ended and their old password no longer works. They choose a new password from the link.'),alertBox(note,'warning'),
        foot(btn(s.copied?'Copied':'Copy link',async()=>{try{await navigator.clipboard.writeText(r.link);s.copied=true;}catch{input.focus();input.select();}s.render();},'primary'),btn('Done',closeDialog,'quiet')));
    }
    return h('form',{class:'sa-body',novalidate:true,onsubmit:event=>{event.preventDefault();void send(s);}},head('SIGN-IN RESET','Reset sign-in for '+name+'?'),
      h('p',{},'This signs '+name+' out of the Hub and Firebase data everywhere and stops their current password. You get a one-time link, valid 24 hours, to give them yourself. The Hub sends nothing.'),
      s.pending?h('p',{class:'sa-notice warning',role:'status'},'An unconfirmed reset for '+name+' was kept exactly as sent. Retry it to confirm whether it saved; do not start another.'):
        field('Reason (optional, kept in the audit trail)',h('textarea',{name:'reason',rows:2,maxLength:500,value:s.reason||'',oninput:event=>{s.reason=event.target.value;}})),
      alertBox(s.error),
      foot(btn('Cancel',closeDialog,'quiet',{disabled:s.busy}),h('button',{type:'submit',class:'sa-btn primary',disabled:s.busy,'aria-busy':s.busy?'true':null},s.busy?'Resetting…':s.pending?'Retry original reset':'Reset sign-in'),
        s.pending&&!s.busy?btn('Discard kept reset',()=>{clearPending('reset');s.pending=null;s.error='';s.render();},'quiet'):null));
  }});
  state.pending=kept;
  async function send(s){
    if(s.busy)return;
    const row=s.pending||{body:{action:'reset_signin',requestId:uuid(),username,expectedUser:viewer()||undefined,...(String(s.reason||'').trim()?{reason:String(s.reason).trim().slice(0,500)}:{})}};
    if(!row.body.expectedUser)delete row.body.expectedUser;
    s.pending=row;writePending('reset',row);s.busy=true;s.error='';s.render();
    try{
      const result=await request(API,row.body);
      if(String(result.username||'').toLowerCase()!==String(username).toLowerCase()||result.link!==undefined&&!/^https:\/\/easygaragecleaning\.com\/staff-setup#invite=/.test(String(result.link)))throw failure('staff_access_unverified','The reset could not be verified. Retry the original reset.',503,{retryable:true});
      clearPending('reset');s.pending=null;s.result=result;
    }catch(error){
      if(!error.retryable){clearPending('reset');s.pending=null;}
      s.error=error.message;
    }finally{s.busy=false;s.render();}
  }
  state.render();
}

// ── Account approval (the approval board) ──
function review({username,displayName,decision,opener,onDone}={}){
  if(!username||!['approved','rejected'].includes(decision))return;
  const name=displayName||username,approve=decision==='approved';
  const state=openDialog({label:(approve?'Approve ':'Reject ')+name,opener,render:s=>{
    if(s.loading)return h('div',{class:'sa-body','aria-busy':'true'},head('EMPLOYEE ACCOUNT',(approve?'Approve ':'Reject ')+name+'?'),h('p',{role:'status'},'Checking what you can set…'),h('span',{class:'sa-skeleton'}),h('span',{class:'sa-skeleton wide'}));
    if(!s.options)return h('div',{class:'sa-body'},head('EMPLOYEE ACCOUNT','Account review unavailable'),alertBox(s.error||'The review options could not be loaded.'),foot(btn('Close',closeDialog,'quiet'),btn('Retry',()=>void load(s),'primary')));
    const o=s.options,roles=o.roles.filter(role=>Object.hasOwn(ROLE_LABEL,role));
    const body=approve?[
      field('Starting role',h('select',{name:'role',required:true,onchange:event=>{s.role=event.target.value;}},roles.map(role=>h('option',{value:role,selected:s.role===role},ROLE_LABEL[role]))),'They can sign in with the password they chose once you approve.'),
      o.setsPay?field('Starting hourly rate ($)',h('input',{type:'number',name:'hourlyRate',required:true,min:'0.01',max:'500',step:'0.01',inputmode:'decimal',autocomplete:'off',placeholder:'0.00',value:s.rate||'',oninput:event=>{s.rate=event.target.value;}}),'Effective today in Denver. Their first shift is paid at this rate.')
        :h('p',{class:'sa-notice warning',role:'note'},'Pay stays pending: only the owner sets the starting rate, and should before their first shift.'),
    ]:[h('p',{},'This keeps '+name+'’s account locked and records the rejection.')];
    return h('form',{class:'sa-body',novalidate:true,onsubmit:event=>{event.preventDefault();void send(s);}},head('EMPLOYEE ACCOUNT',(approve?'Approve ':'Reject ')+name+'?'),body,alertBox(s.error),
      foot(btn('Cancel',closeDialog,'quiet',{disabled:s.busy}),h('button',{type:'submit',class:'sa-btn '+(approve?'primary':'danger'),disabled:s.busy,'aria-busy':s.busy?'true':null},s.busy?'Saving…':s.pending?'Retry original review':approve?'Approve account':'Reject request')));
  }});
  Object.assign(state,{loading:true,role:'crew',rate:'',pending:readPending('review',username)});
  if(state.pending&&state.pending.body.decision!==decision)state.pending=null;
  async function load(s){
    s.loading=true;s.error='';s.render();
    try{
      const data=await request(API,null);
      const o=data.staffAccess;
      if(!record(o)||typeof o.setsPay!=='boolean'||!Array.isArray(o.roles)||!o.roles.length)throw failure('staff_access_unverified','The review options were incomplete. Retry.',503);
      s.options=o;if(!o.roles.includes(s.role))s.role=o.roles.includes('crew')?'crew':o.roles[0];
    }catch(error){s.options=null;s.error=error.message;}
    finally{s.loading=false;s.render();}
  }
  async function send(s){
    if(s.busy||!s.options)return;
    let row=s.pending;
    if(!row){
      const body={action:'review',requestId:uuid(),username,decision};
      if(approve){
        body.staffRoles=[s.role];
        if(s.options.setsPay){
          const text=String(s.rate||'').trim().replace(/^\$/,'');
          if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)||!(Number(text)>0)||Number(text)>500){s.error='Enter the starting hourly rate: more than $0 and at most $500, to the cent.';s.render();return;}
          body.hourlyRate=Math.round(Number(text)*100)/100;
        }
      }
      row={body};
    }
    s.pending=row;writePending('review',row);s.busy=true;s.error='';s.render();
    try{
      const result=await request(API,row.body);
      if(!record(result.account)||String(result.account.username||'').toLowerCase()!==String(username).toLowerCase())throw failure('staff_access_unverified','The review could not be verified. Retry the original review.',503,{retryable:true});
      clearPending('review');s.pending=null;closeDialog();
      const note=signOutNote(result),text=(result.account.status==='approved'?name+' is on the team and can now sign in.'+(result.payPending?' Pay is pending: the owner sets the starting rate before their first shift.':''):'Account request rejected.')+(note?' '+note:'');
      if(typeof onDone==='function')await onDone(result,text);
    }catch(error){
      if(!error.retryable){clearPending('review');s.pending=null;}
      s.error=error.message;
    }finally{s.busy=false;s.render();}
  }
  void load(state);
}

// ── Apply rate to open weeks (owner, staff directory pay) ──
function applyRate(person,{opener,ctx,onDone}={}){
  if(!record(person)||!person.username)return;
  const name=person.displayName||person.username;
  const state=openDialog({label:'Apply rate to open weeks for '+name,opener,render:s=>{
    const title='Apply rate to open weeks';
    if(s.loading)return h('div',{class:'sa-body','aria-busy':'true'},head('PAY · '+name.toUpperCase(),title),h('p',{role:'status'},'Finding $0 timecards…'),h('span',{class:'sa-skeleton'}),h('span',{class:'sa-skeleton wide'}));
    if(s.done)return h('div',{class:'sa-body'},head('PAY · '+name.toUpperCase(),title),alertBox((s.done.replayed?'Confirmed: ':'Saved: ')+s.done.applied.timecards+' timecard'+(s.done.applied.timecards===1?'':'s')+' now use the scheduled rate ('+s.done.applied.weeks.map(dayLabel).map(day=>'week of '+day).join(', ')+').','success'),foot(btn('Done',closeDialog,'primary')));
    if(!s.plan)return h('div',{class:'sa-body'},head('PAY · '+name.toUpperCase(),title),alertBox(s.error||'The timecards could not be checked.'),foot(btn('Close',closeDialog,'quiet'),btn('Retry',()=>void load(s),'primary')));
    const weeks=s.plan.weeks,open=weeks.filter(week=>!week.exported);
    const rows=weeks.map(week=>h('li',{class:'sa-week'+(week.exported?' exported':'')},h('label',{class:'sa-check'},
      h('input',{type:'checkbox',name:'week',value:week.weekStart,disabled:week.exported||s.busy,checked:!week.exported&&s.chosen.has(week.weekStart),onchange:event=>{if(event.target.checked)s.chosen.add(week.weekStart);else s.chosen.delete(week.weekStart);}}),
      h('span',{},h('strong',{},'Week of '+dayLabel(week.weekStart)+' – '+dayLabel(week.weekEnd)),h('small',{},week.timecards+' timecard'+(week.timecards===1?'':'s')+' at $0 · '+week.hours+' h · '+week.rates.map(rate=>dollars(rate)+'/hr').join(', ')+' · '+dollars(week.pay)),
        week.exported?h('small',{class:'sa-tag'},'Exported '+when(week.exportedAt)+': keeps its saved rate'):null))));
    return h('form',{class:'sa-body',novalidate:true,onsubmit:event=>{event.preventDefault();void send(s);}},head('PAY · '+name.toUpperCase(),title),
      h('p',{},'Timecards '+name+' clocked at $0 take the rate their work day has on the dated pay schedule. Hours and approvals stay as they are, and each timecard records the change.'),
      weeks.length?h('ul',{class:'sa-weeks','aria-label':'Weeks with $0 timecards'},rows):h('p',{class:'sa-muted'},'No $0 timecards on or after the first scheduled rate.'),
      open.length?h('p',{class:'sa-muted'},'Payroll downloads made before this was turned on are not recorded: untick any week you already paid.'):null,
      alertBox(s.error),
      foot(btn('Cancel',closeDialog,'quiet',{disabled:s.busy}),s.stale?btn('Preview again',()=>void load(s),'primary'):h('button',{type:'submit',class:'sa-btn primary',disabled:s.busy||!open.length,'aria-busy':s.busy?'true':null},s.busy?'Applying…':'Apply rate to chosen weeks')));
  }});
  Object.assign(state,{loading:true,chosen:new Set(),requestId:''});
  async function load(s){
    s.loading=true;s.error='';s.stale=false;s.requestId='';s.render();
    try{
      const plan=await request(DIRECTORY,{action:'preview_apply_rate',username:person.username},ctx);
      if(!Array.isArray(plan.weeks)||typeof plan.planDigest!=='string'||typeof plan.expectedRevision!=='string')throw failure('staff_access_unverified','The preview was incomplete. Retry.',503);
      s.plan=plan;s.chosen=new Set(plan.weeks.filter(week=>!week.exported).map(week=>week.weekStart));
    }catch(error){s.plan=null;s.error=error.message;}
    finally{s.loading=false;s.render();}
  }
  async function send(s){
    if(s.busy||!s.plan)return;
    const weeks=s.plan.weeks.filter(week=>!week.exported&&s.chosen.has(week.weekStart)).map(week=>week.weekStart);
    if(!weeks.length){s.error='Choose at least one week.';s.render();return;}
    s.requestId||=uuid();s.busy=true;s.error='';s.render();
    try{
      const result=await request(DIRECTORY,{action:'apply_rate',requestId:s.requestId,username:person.username,expectedRevision:s.plan.expectedRevision,planDigest:s.plan.planDigest,weeks,...(viewer()?{expectedUser:viewer()}:{})},ctx);
      if(!record(result.applied)||!Array.isArray(result.applied.weeks))throw failure('staff_access_unverified','The change could not be verified. Retry to confirm it.',503,{retryable:true});
      s.done=result;if(typeof onDone==='function')Promise.resolve().then(()=>onDone(result)).catch(()=>{});
    }catch(error){
      s.error=error.message;s.stale=/_(revision_conflict|week_exported|idempotency_conflict)$/.test(String(error.code||''));
      if(!error.retryable)s.requestId='';
    }finally{s.busy=false;s.render();}
  }
  void load(state);
}

// ── My EGC → Password (the registered 'password' Hub screen) ──
// The form is built once per mount so typing is never interrupted; the notice and the button change in place.
function setNotice(kind,text){if(!S.slot)return;S.slot.replaceChildren(text?h('p',{class:'sa-notice '+kind,role:kind==='error'?'alert':'status','aria-live':kind==='error'?null:'polite'},text):'');}
function setBusy(on){S.busy=on;const submit=S.root?.querySelector('.sa-password button[type=submit]');if(!submit)return;submit.disabled=on;submit.setAttribute('aria-busy',on?'true':'false');submit.textContent=on?'Saving…':'Change password';}
function passwordScreen(){
  const input=(name,label,autocomplete,help)=>field(label,h('input',{type:'password',name,required:true,autocomplete,maxLength:128,spellcheck:false,autocapitalize:'off',oninput:()=>{S.dirty=true;}}),help);
  const form=h('form',{class:'sa-password',novalidate:true,'aria-label':'Change password',onsubmit:event=>{event.preventDefault();void changePassword(event.target);}},
    input('currentPassword','Current password','current-password'),
    input('newPassword','New password','new-password','At least 10 characters with an uppercase letter, a lowercase letter and a number.'),
    input('confirmPassword','Confirm new password','new-password'),
    h('button',{type:'submit',class:'sa-btn primary sa-wide','aria-busy':'false'},'Change password'));
  S.slot=h('div',{class:'sa-slot'});
  return [h('header',{class:'sa-screen-head'},h('span',{class:'sa-eyebrow'},'MY EGC'),h('h1',{},'Password'),
    h('p',{},'Change the password you sign in with. This device stays signed in; every other phone or browser signed in as you is signed out.')),
    S.slot,can('password.change')?form:h('p',{class:'sa-notice warning',role:'note'},'Your password is set in the Hub configuration. Ask the owner to change it.'),
    h('p',{class:'sa-muted'},'Forgot your password? A manager can give you a one-time sign-in reset link.')];
}
// A password change ends every Firebase data session of the account, this browser's too: Firebase revokes per user, from
// the first whole second after the save. Once that second has passed, this browser signs its data session in again from
// the re-issued Hub cookie (employee.html ensureFirebaseSession); false means a reload is needed to reconnect.
const RECONNECT_AFTER=2000;
function reconnectData(result){
  if(['not_configured','not_needed'].includes(String(result?.firebaseRevocation?.status||'')))return Promise.resolve(true);
  if(typeof window.ensureFirebaseSession!=='function')return Promise.resolve(false);
  return new Promise(resolve=>setTimeout(resolve,RECONNECT_AFTER)).then(()=>window.ensureFirebaseSession()).then(()=>true,()=>false);
}
async function changePassword(form){
  if(S.busy||!S.root)return;
  const values=Object.fromEntries(['currentPassword','newPassword','confirmPassword'].map(name=>[name,form.elements[name].value]));
  const problem=!values.currentPassword?'Enter your current password.':values.newPassword!==values.confirmPassword?'The two new passwords do not match.':values.newPassword.length<10||!/[a-z]/.test(values.newPassword)||!/[A-Z]/.test(values.newPassword)||!/\d/.test(values.newPassword)?'Use at least 10 characters with an uppercase letter, a lowercase letter and a number.':values.newPassword===values.currentPassword?'Choose a new password that is different from your current one.':'';
  if(problem){setNotice('error',problem);return;}
  const generation=S.generation;setBusy(true);setNotice('','');
  try{
    const result=await request(API,{action:'change_password',requestId:uuid(),...values},S.ctx);
    if(generation!==S.generation)return;
    if(result.passwordChanged!==true)throw failure('staff_access_unverified','The change could not be confirmed. Sign in again with your new password if you are asked.',503);
    S.dirty=false;form.reset();
    const note=signOutNote(result)?' '+signOutNote(result).replace('their','your'):'';
    setNotice('success','Password changed. Your other devices are signed out. Reconnecting this device’s data…');
    const reconnected=await reconnectData(result);
    if(generation!==S.generation)return;
    setNotice(note||!reconnected?'warning':'success',(reconnected?'Password changed. You stay signed in here; your other devices are signed out.':'Password changed and your other devices are signed out. Reload the Hub to reconnect this device’s data.')+note);
    if(typeof S.ctx?.toast==='function')S.ctx.toast('Password changed');
  }catch(error){
    if(generation!==S.generation)return;
    // Passwords are never kept: a failed change is typed again.
    form.elements.currentPassword.value='';
    setNotice('error',error.status>=500||/_(network|timeout)$/.test(String(error.code||''))?error.message+' If the change saved, sign in with your new password when asked.':error.message);
  }finally{if(generation===S.generation)setBusy(false);}
}
function mount(host,ctx={}){
  if(!host)return;
  S.generation++;S.ctx=ctx;S.host=host;S.busy=false;S.dirty=false;
  S.root=h('section',{class:'egc-access','aria-label':'Password'},passwordScreen());
  host.replaceChildren(S.root);
}
function unmount(){S.generation++;S.root?.remove();S.root=null;S.host=null;S.slot=null;S.busy=false;S.dirty=false;}

// Team card buttons (employee-suite.js teamBoard) carry data-staff-reset; the click is handled here.
document.addEventListener('click',event=>{
  const button=event.target?.closest?.('[data-staff-reset]');
  if(!button)return;
  event.preventDefault();
  openReset({username:button.getAttribute('data-staff-reset')||'',displayName:button.getAttribute('data-staff-name')||'',opener:button});
});
window.addEventListener('egc:signout',()=>{closeDialog();unmount();clearAllPending();});
window.addEventListener('beforeunload',event=>{if(S.busy||S.dialog?.busy){event.preventDefault();event.returnValue='';}});
window.EGCStaffAccess={mount,unmount,refresh:()=>{},canLeave:()=>!S.busy&&!S.dirty,enabled,approves,resets,openReset,review,applyRate,approvalCopy:()=>enabled()?'The owner, and managers the owner allows, approve accounts with a starting role. Only the owner sets pay.':''};
})();
