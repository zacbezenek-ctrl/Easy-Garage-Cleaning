/* Action Center: same Employee Hub session, canonical backend tasks, no local customer-data cache. */
(function(){
'use strict';
const TZ='America/Denver';
const state={host:null,root:null,actor:null,owners:[],view:'due',owner:'',offset:0,items:[],generation:0,controller:null,dialog:null,dirty:false,busy:false,enabled:false,briefId:null,intelligenceDays:1};
const labels={manual:'Internal task',callback:'Callback',prepare_quote:'Prepare quote',followup_message:'Follow-up message',review_notes:'Review notes',verify_deposit:'Verify deposit',job_readiness:'Job readiness',send_before_afters:'Send before/after photos',send_insurance_certificate:'Send insurance certificate',send_quote:'Send quote',send_product_options:'Send product options',schedule_job:'Schedule job',answer_question:'Answer question',deposit_reminder:'Deposit reminder'};
// Message kinds carry an exact reviewed draft and never complete by staff attestation. These
// mirror MESSAGE_TASK_KINDS and MESSAGE_ATTACHMENT_KINDS in
// egc-platform/services/operations/src/action-kinds.ts; tests/action-center-drafts.test.mjs pins them.
const MESSAGE_KINDS=Object.freeze(['followup_message','send_before_afters','send_insurance_certificate','send_quote','send_product_options','answer_question','deposit_reminder']);
const ATTACHMENT_KINDS=Object.freeze({portal_quote:'Portal quote',before_after_gallery:'Before and after photos',insurance_certificate:'Insurance certificate',product_options:'Product options',payment_link:'Payment link',url:'Link'});
const DRAFT_FIELDS=['channel','recipient','subject','body','sendWindowStart','sendWindowEnd','attachments'],ATTACHMENT_FIELDS=['kind','url','label','refId'];
function has(object,key){return Object.prototype.hasOwnProperty.call(object,key);}
function isMessageKind(kind){return MESSAGE_KINDS.includes(kind);}
function canComplete(kind){return !isMessageKind(kind)&&kind!=='verify_deposit';}
// The approval fingerprint hashes the whole draft, so everything in it must be visible first.
// A draft this screen cannot show in full (unknown fields, unreadable or non-canonical links)
// is never approvable here.
function draftReview(draft){
  const problems=[],attachments=[];
  if(!draft||typeof draft!=='object'||Array.isArray(draft))return{ok:false,problems:['The draft is missing or unreadable.'],attachments};
  for(const key of Object.keys(draft))if(!DRAFT_FIELDS.includes(key))problems.push('The draft has a field this screen cannot show: '+key+'.');
  if(!['sms','email'].includes(draft.channel))problems.push('The draft channel is not SMS or email.');
  if(typeof draft.recipient!=='string'||!draft.recipient)problems.push('The draft recipient is missing.');
  if(typeof draft.body!=='string'||!draft.body)problems.push('The draft message is missing.');
  if(draft.subject!=null&&typeof draft.subject!=='string')problems.push('The draft subject is unreadable.');
  const list=has(draft,'attachments')?draft.attachments:[];
  if(!Array.isArray(list))problems.push('The attachment list is unreadable.');
  else list.forEach((item,index)=>{
    const name='Attachment '+(index+1);
    if(!item||typeof item!=='object'||Array.isArray(item)){problems.push(name+' is unreadable.');return;}
    for(const key of Object.keys(item))if(!ATTACHMENT_FIELDS.includes(key))problems.push(name+' has a field this screen cannot show: '+key+'.');
    const known=has(ATTACHMENT_KINDS,item.kind);if(!known)problems.push(name+' has an unknown kind.');
    const label=typeof item.label==='string'?item.label.trim():'';if(!label)problems.push(name+' has no label.');
    let url=null;try{url=typeof item.url==='string'?new URL(item.url):null;}catch{url=null;}
    const verifiable=Boolean(url&&url.protocol==='https:'&&!url.username&&!url.password&&url.href===item.url&&!/[\s\u0000-\u001f\u007f]|\p{Cf}/u.test(item.url));
    if(!verifiable)problems.push(name+' does not have a canonical https link.');
    if(item.refId!=null&&typeof item.refId!=='string')problems.push(name+' has an unreadable reference.');
    attachments.push({kind:String(item.kind),kindLabel:known?ATTACHMENT_KINDS[item.kind]:'Unknown kind',label,url:typeof item.url==='string'?item.url:'',host:verifiable?url.hostname:'',refId:typeof item.refId==='string'?item.refId:null,verifiable});
  });
  return{ok:!problems.length,problems,attachments};
}
// Every message kind saves with its exact draft, on create and on edit. This screen cannot
// change links yet, so an edit keeps the reviewed attachments exactly as they are.
function buildDraft(kind,data,existing){if(!isMessageKind(kind))return null;const kept=existing&&Array.isArray(existing.attachments)?existing.attachments.map(item=>({...item})):[];return{channel:data.channel,recipient:data.recipient,subject:data.subject,body:data.body,sendWindowStart:localToIso(data.sendWindowStart),sendWindowEnd:localToIso(data.sendWindowEnd),attachments:kept};}
const errorLabels={
  operations_not_enabled:'The Action Center backend is not enabled. This is not an empty work queue.',
  operations_bridge_not_configured:'The Hub-to-backend connection needs configuration. No task data was loaded.',
  operations_unavailable:'The backend is unavailable. A submitted change may already be saved. Retry the original request instead of creating a second action.',
  canonical_customer_state_unavailable:'Customer evidence could not be reconciled. Metrics are unavailable until the source connection is restored.',
  task_revision_conflict:'This action changed while you were editing. Nothing was overwritten. Your draft is still here; close and reopen the latest action before applying it.',
  approval_preview_changed:'The conversation or action changed after you opened it. Review the latest details before approving.',
  message_completion_requires_provider_evidence:'A message cannot be marked complete without provider evidence. Draft approval is not delivery.',
  deposit_completion_requires_verified_payment:'A payment must be verified against processor evidence. An expected deposit is not collected cash.',
  business_session_required:'Sign in to the Employee Hub with an authorized business account.',
  portal_identity_adapter_unavailable:'The portal identity connection is unavailable. A portal job link cannot be guessed.',
  portal_authority_unavailable:'The actual EGC portal schedule could not be read. No other calendar was substituted.',
  idempotency_key_payload_conflict:'The original request already has a different saved result. Refresh the queue before making another change.',
  dependencies_unresolved:'Complete the required dependencies first.',
  human_manager_approval_required:'A signed-in owner or manager must review this draft.',
  draft_window_expired:'The proposed message window has expired. Edit and review a new window.',
  message_draft_required:'Message actions must keep their exact draft. Nothing was changed.',
  task_has_no_message_draft:'Only a message action with an exact draft can be approved.',
  action_send_disabled:'One-tap sending is not enabled on the backend. Nothing was sent.',
  human_send_confirmation_required:'A signed-in person must confirm every customer send. Nothing was sent.',
  task_not_owned:'Only the action’s owner or a manager can do this. Nothing was changed or sent.',
  task_is_closed:'This action is already closed. Nothing was changed or sent.',
  blocked_task_requires_review:'The customer replied or the action is blocked. Review it first. Nothing was approved or sent.',
  draft_window_not_open:'The message window has not opened yet. Nothing was sent.',
  send_approval_not_current:'The approval for this send is no longer current. Review the latest draft. Nothing was sent.',
  contact_do_not_contact:'This customer is marked do-not-contact. Nothing was sent.',
  contact_not_found:'The customer record is missing. Nothing was sent.',
  contact_preflight_unavailable:'The customer could not be verified with the messaging provider, so nothing was sent. Retry the original request.',
  verified_contact_phone_required:'The draft recipient does not match the customer’s verified phone. Nothing was sent.',
  verified_contact_email_required:'The draft recipient does not match the customer’s verified email. Nothing was sent.',
  message_contact_identity_mismatch:'The provider contact does not match this customer. Nothing was sent.',
  message_outcome_unknown:'The provider did not confirm the send, so it may have gone out. Retry the original request: it only checks the provider and never sends a second copy.',
  message_execution_unavailable:'The send could not be confirmed. Retry the original request: it only checks the provider and never sends a second copy.',
  message_delivery_failed:'The provider reported that this message failed. It will not be resent automatically.',
  message_send_already_started:'This action’s approved message was already sent. Use Check send status; to send something different, edit the action first. Nothing was sent.',
  draft_rejected_requires_review:'An owner or manager rejected this draft. It needs their review before it can be sent. Nothing was sent.'
};
// One-tap send: an unconfirmed send request is kept per signed-in viewer so a retry reuses
// the exact request ID and body. The server never sends one approved revision twice.
const PENDING_SEND='egc.actions.send.v1.';
function pendingKey(){return PENDING_SEND+(state.actor?.id||'unknown');}
function pendingSends(){try{const value=JSON.parse(sessionStorage.getItem(pendingKey())||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return{};}}
function pendingSend(taskId){const item=pendingSends()[taskId];return item&&typeof item.requestId==='string'&&item.command?.command==='task.send'&&item.command.taskId===taskId?item:null;}
function savePendingSend(taskId,attempt){try{const all=pendingSends();if(attempt)all[taskId]={requestId:attempt.requestId,command:attempt.command};else delete all[taskId];if(Object.keys(all).length)sessionStorage.setItem(pendingKey(),JSON.stringify(all));else sessionStorage.removeItem(pendingKey());}catch{}}
function clearPendingSends(){try{for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith(PENDING_SEND))sessionStorage.removeItem(key);}}catch{}}
// The current revision's send already started (its approval may since be invalidated by the
// sent message itself): the server only reads that send back, it never sends it again.
function sendStarted(result){const revision=result?.task?.revision;return Array.isArray(result?.history)&&result.history.some(e=>e?.type==='message.execution_started'&&e.revision===revision);}
// Send now is offered only for an approved, fully visible draft inside its window, to the
// task owner or a manager, and only when the backend reports one-tap sending is available.
// Once the send started, Check send status is offered instead.
function sendEligibility(result,actor,now){
  const t=result?.task,d=t?.draftPayload;
  if(result?.actionSend?.available!==true)return{ok:false,reason:'disabled'};
  if(!t||!isMessageKind(t.kind)||!['open','in_progress'].includes(t.status))return{ok:false,reason:'not_sendable'};
  if(!(['owner','manager'].includes(actor?.role)||(actor?.id&&t.assignedUserId===actor.id)))return{ok:false,reason:'not_owner'};
  if(sendStarted(result))return{ok:true,reason:'check_status'};
  if(result.effectiveApproval!=='approved')return{ok:false,reason:'not_approved'};
  if(!draftReview(d).ok)return{ok:false,reason:'not_reviewable'};
  const start=Date.parse(d.sendWindowStart),end=Date.parse(d.sendWindowEnd);
  if(!(end>now))return{ok:false,reason:'window_expired'};
  if(!(start<=now))return{ok:false,reason:'window_not_open'};
  return{ok:true,reason:'ready'};
}
function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null)continue;if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else if(key in node&&typeof value!=='object')node[key]=value;else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity)){if(child==null)continue;node.append(child instanceof Node?child:document.createTextNode(String(child)));}return node;}
function button(text,onClick,kind=''){return h('button',{type:'button',class:'ac-btn '+kind,onclick:onClick},text);}
function attachmentList(review){
  const count=review.attachments.length,section=h('section',{class:'ac-attachments','aria-label':'Attachment links'},h('h4',{},count?'Attachment links · '+count:'Attachment links'));
  if(!count){section.append(h('p',{class:'ac-muted'},'No attachment links. Only the message text is part of this draft.'));return section;}
  const list=h('ol',{class:'ac-attachment-list'});
  for(const item of review.attachments)list.append(h('li',{},h('b',{},item.kindLabel+' · '+(item.label||'No label')),h('small',{},item.verifiable?'Opens '+item.host:'This link cannot be verified here.'),h('code',{class:'ac-url'},item.url||'Missing link'),item.refId?h('small',{},'Reference: '+item.refId):null,item.verifiable?h('a',{class:'ac-btn ac-link',href:item.url,target:'_blank',rel:'noopener noreferrer'},'Open link to verify'):null));
  section.append(list);return section;
}
function reviewBlocked(review){const box=h('div',{class:'ac-statusbar error',role:'alert'},h('div',{},h('p',{},'This draft cannot be approved in the Action Center until every part of it can be shown:'),h('ul',{},...review.problems.map(problem=>h('li',{},problem)))));return box;}
function parts(at){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));}
function localValue(at){const p=parts(at);return`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
function localToIso(value){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value||''))throw new Error('Choose a date and time.');const wall=Date.parse(value+'Z');if(!Number.isFinite(wall)||new Date(wall).toISOString().slice(0,16)!==value)throw new Error('That date or time is invalid.');const offsets=new Set([-86400000,0,86400000].map(delta=>{const p=parts(wall+delta);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-(wall+delta);}));const matches=[...offsets].map(o=>wall-o).filter(t=>localValue(t)===value);if(matches.length!==1)throw new Error('That time is ambiguous or does not exist because of daylight saving. Choose another time.');return new Date(matches[0]).toISOString();}
function today(){return localValue(Date.now()).slice(0,10);}
function plusDays(date,n){return new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
function cutoff(){return localToIso(plusDays(today(),1)+'T00:00');}
function displayTime(value){if(!value)return'No time set';const d=new Date(value);return Number.isFinite(d.valueOf())?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d):'Time needs review';}
function ownerName(id){return state.owners.find(o=>o.id===id)?.name||id||'Unassigned';}
function attention(task){return['customer','provider'].includes(task.waitingOn)?task.reviewAt:task.dueAt;}
function message(error){return errorLabels[error.code]||error.message||'The action could not be completed.';}
async function rpc(body,requestId=crypto.randomUUID(),signal=state.controller?.signal){const response=await fetch('/api/operations',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,body}),signal});let result;try{result=await response.json();}catch{result={error:'operations_unavailable'};}if(!response.ok||result.error){const error=new Error(result.message||result.error||'operations_unavailable');error.code=result.error;error.status=response.status;throw error;}return result;}
function banner(text,kind='warning'){return h('div',{class:'ac-statusbar '+kind,role:kind==='error'?'alert':'status'},h('p',{},text));}
function content(){return state.root?.querySelector('[data-ac-content]');}
function dirtyCheck(){return !state.dirty&&!state.busy||window.confirm(state.busy?'A request may still finish. Leave this view and check the queue before retrying?':'Discard this unsaved draft?');}
function closeDialog(force=false){if(state.dialog&&!force&&!dirtyCheck())return false;if(state.dialog){state.dialog.close();state.dialog.remove();}state.dialog=null;state.dirty=false;return true;}
function openDialog(title){closeDialog(true);const dialog=h('dialog',{class:'ac-dialog','aria-label':title});const body=h('div',{class:'ac-dialog-body'}),foot=h('div',{class:'ac-dialog-footer'});const close=button('Close',()=>closeDialog());dialog.append(h('header',{class:'ac-dialog-header'},h('h2',{},title),close),body,foot);dialog.addEventListener('cancel',event=>{if(!dirtyCheck())event.preventDefault();});dialog.addEventListener('close',()=>{if(state.dialog===dialog){state.dialog=null;state.dirty=false;dialog.remove();}});document.body.append(dialog);state.dialog=dialog;dialog.showModal();return{dialog,body,foot};}
function field(form,name,label,type,value='',options={}){
  const id='ac-field-'+name,labelId=id+'-label';
  const {wide,help,...inputOptions}=options;
  const attrs={name,id,'aria-labelledby':labelId,...inputOptions};
  const input=type==='textarea'?h('textarea',{...attrs,rows:4},value):
    type==='select'?h('select',attrs,...value.map(o=>h('option',{value:o.value,selected:o.selected},o.label))):
    h('input',{...attrs,type,value});
  const wrap=h('label',{class:wide?'wide':'',htmlFor:id},h('span',{id:labelId},label),input);
  if(help){const helpId=id+'-help';wrap.append(h('small',{id:helpId},help));input.setAttribute('aria-describedby',helpId);}
  input.addEventListener('input',()=>state.dirty=true);form.append(wrap);return input;
}
function makeForm(title){const modal=openDialog(title),form=h('form',{}),grid=h('div',{class:'ac-form-grid'}),error=h('div',{class:'ac-error',role:'alert','aria-live':'assertive'});form.append(grid,error);modal.body.append(form);const submit=button('Save',()=>form.requestSubmit(),'primary');modal.foot.append(button('Cancel',()=>closeDialog()),submit);return{...modal,form,grid,error,submit};}
async function submitMutation(ui,command,onDone){if(state.busy)return;const session=state.controller;ui.onDone=ui.onDone||onDone;const controls=[...ui.form.querySelectorAll('input,select,textarea')];if(!ui.originalDisabled)ui.originalDisabled=new Map(controls.map(n=>[n,n.disabled]));if(!ui.attempt)ui.attempt={requestId:crypto.randomUUID(),command};ui.persist?.(ui.attempt);state.busy=true;ui.submit.disabled=true;ui.submit.textContent=ui.busyLabel||'Saving…';ui.error.textContent='';controls.forEach(n=>n.disabled=true);try{const result=await rpc(ui.attempt.command,ui.attempt.requestId);if(session!==state.controller)return;state.busy=false;ui.attempt=null;ui.persist?.(null);if(state.dialog===ui.dialog){state.dirty=false;closeDialog(true);}await ui.onDone(result);}catch(error){if(session!==state.controller)return;state.busy=false;if(error.name==='AbortError')return;ui.error.textContent=message(error);const uncertain=error.status>=500||!error.status;if(!uncertain){ui.attempt=null;ui.persist?.(null);controls.forEach(n=>n.disabled=ui.originalDisabled.get(n)||false);}ui.submit.disabled=false;ui.submit.textContent=uncertain?'Retry original request':(ui.idleLabel||'Save');}}
function newTask(existing=null,portalJob=null){const editing=Boolean(existing);const ui=makeForm(editing?'Edit action':'New action');const t=existing||{};const ownerOptions=state.owners.map(o=>({value:o.id,label:o.name,selected:o.id===(t.assignedUserId||state.actor?.id)}));if(t.assignedUserId&&!ownerOptions.some(o=>o.value===t.assignedUserId))ownerOptions.push({value:t.assignedUserId,label:t.assignedUserId,selected:true});
field(ui.grid,'title','Action','text',t.title||(portalJob?'Follow up: '+(portalJob.customer||portalJob.id):''),{required:true,maxLength:500,wide:true});
const kind=field(ui.grid,'kind','Type','select',Object.entries(labels).map(([value,label])=>({value,label,selected:value===(t.kind||'manual')})),{disabled:editing});
field(ui.grid,'assignedUserId','Owner','select',ownerOptions,{required:true});
field(ui.grid,'dueAt','Due time · '+TZ,'datetime-local',localValue(t.dueAt||Date.now()+3600000),{required:true});
field(ui.grid,'priority','Priority','select',['low','medium','high','urgent'].map(value=>({value,label:value,selected:value===(t.priority||'medium')})));
field(ui.grid,'waitingOn','Waiting on','select',['none','EGC','customer','provider'].map(value=>({value,label:value==='none'?'No one':value,selected:value===(t.waitingOn||'none')})));
field(ui.grid,'reviewAt','Review time when waiting','datetime-local',t.reviewAt?localValue(t.reviewAt):'',{help:'Required when waiting on the customer or a provider.'});
if(!editing)field(ui.grid,'portalJobId','EGC portal record ID (optional)','text',portalJob?.id||'',{wide:true,maxLength:180,help:'Links only to this exact Hub record. No latest-job matching.'});
field(ui.grid,'description','Context / commitment','textarea',t.description||'',{wide:true,maxLength:5000});
field(ui.grid,'completionCondition','What proves completion?','textarea',t.completionCondition||'',{wide:true,required:true,maxLength:1000});
const draftGroup=h('div',{class:'ac-form-grid wide'});ui.grid.append(draftGroup);const d=t.draftPayload||{};
field(draftGroup,'channel','Channel','select',['sms','email'].map(value=>({value,label:value.toUpperCase(),selected:value===(d.channel||'sms')})));
field(draftGroup,'recipient','Exact recipient','text',d.recipient||'',{maxLength:320,help:'SMS uses +countrycode; email uses the full address.'});
field(draftGroup,'subject','Email subject','text',d.subject||'',{wide:true,maxLength:250});
field(draftGroup,'body','Exact draft · approval does not send','textarea',d.body||'',{wide:true,maxLength:10000});
field(draftGroup,'sendWindowStart','Earliest send time · '+TZ,'datetime-local',localValue(d.sendWindowStart||t.dueAt||Date.now()+3600000));
field(draftGroup,'sendWindowEnd','Window expires · '+TZ,'datetime-local',localValue(d.sendWindowEnd||Date.now()+25*3600000));
if(editing&&isMessageKind(t.kind))draftGroup.append(h('div',{class:'wide'},attachmentList(draftReview(d)),h('small',{},'Links stay exactly as proposed. This screen cannot add or change attachment links, and any draft change needs a new review.')));
function toggleDraft(){draftGroup.hidden=!isMessageKind(kind.value);}kind.addEventListener('change',toggleDraft);toggleDraft();
ui.form.addEventListener('submit',event=>{event.preventDefault();if(ui.attempt){void submitMutation(ui,ui.attempt.command,()=>load());return;}try{const data=Object.fromEntries(new FormData(ui.form));const actionKind=editing?t.kind:data.kind;const draft=buildDraft(actionKind,data,editing?t.draftPayload:null);const values={title:data.title,description:data.description,priority:data.priority,assignedUserId:data.assignedUserId,dueAt:localToIso(data.dueAt),waitingOn:data.waitingOn,reviewAt:data.reviewAt?localToIso(data.reviewAt):null,completionCondition:data.completionCondition,draft};const command=editing?{command:'task.edit',taskId:t.id,revision:t.revision,changes:values}:{command:'task.create',task:{...values,kind:actionKind,timeZone:TZ,portalJobId:data.portalJobId||null,sourceEvidence:[{source:'staff',id:state.actor.id,excerpt:'Manually recorded commitment in the Employee Hub'}]}};void submitMutation(ui,command,()=>load());}catch(error){ui.error.textContent=message(error);}});
ui.form.querySelector('input')?.focus();}
function explainAction(task,commandName){const words={complete:['Complete action','Completion outcome','Record what actually happened. A staff attestation is not payment or message-delivery evidence.'],cancel:['Cancel action','Reason','History stays in the timeline.'],snooze:['Snooze action','Reason','Waiting work changes its review time; other work changes its due time.'],reject:['Reject draft','Reason','This does not send a customer message.']};const [title,label,help]=words[commandName];const ui=makeForm(title);ui.body.prepend(h('p',{class:'ac-muted'},task.title));if(commandName==='snooze')field(ui.grid,'until','Review again · '+TZ,'datetime-local',localValue(Date.now()+86400000),{required:true,wide:true});field(ui.grid,'text',label,'textarea','',{required:true,minLength:3,maxLength:2000,wide:true,help});ui.form.addEventListener('submit',event=>{event.preventDefault();if(ui.attempt){void submitMutation(ui,ui.attempt.command,()=>load());return;}try{const data=Object.fromEntries(new FormData(ui.form));const body={command:'task.'+commandName,taskId:task.id,revision:task.revision,...(commandName==='complete'?{outcome:data.text}:{reason:data.text}),...(commandName==='snooze'?{until:localToIso(data.until)}:{})};void submitMutation(ui,body,()=>load());}catch(error){ui.error.textContent=message(error);}});}
// SALES-BOOKING (BOOK-15): a schedule_job or callback action calls its customer and books them in dispatch. The number and
// customer come from the Hub record the action links (/api/dispatch view=job); texts and follow-ups stay in HighLevel.
// Book hands {kind, customerId, name, phone, address} to the Hub shell (the egc:book event), which opens dispatch.
const BOOK_KINDS=Object.freeze({schedule_job:'job',callback:'walkthrough'});
// Walkthrough commitments stay in the Hub queue. Staff can carry the reviewed
// instructions into their existing HighLevel conversation without enabling sends.
function officeHandoff(task,ui,generation){
  if(!task.sourceEvidence?.some(e=>e.source==='recording'))return;
  const base=[task.title,task.description,'Completion: '+(task.completionCondition||'Confirm the outcome'),task.portalJobId?'Hub visit: '+task.portalJobId:''].filter(Boolean);
  let content=base.join('\n\n');
  const current=()=>generation===state.generation&&state.dialog===ui.dialog;
  // An external contact URL is useful only when it is the exact canonical HighLevel contact page.
  const contactUrl=value=>{if(typeof value!=='string')return'';try{const url=new URL(value);return value===url.href&&url.origin==='https://app.gohighlevel.com'&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/v2\/location\/[A-Za-z0-9_-]+\/contacts\/detail\/[A-Za-z0-9_-]+$/.test(url.pathname)?url.href:'';}catch{return'';}};
  const source=h('div',{class:'ac-muted ac-handoff-customer',role:'status'},'Checking the current Hub customer link…');
  const highlevel=h('a',{class:'ac-btn ac-link',href:'https://app.gohighlevel.com/',target:'_blank',rel:'noopener noreferrer'},'Open HighLevel');
  const note=h('p',{role:'status',class:'ac-muted'}),copy=button('Copy office instructions',async()=>{
    const exact=content;
    try{await navigator.clipboard.writeText(exact);if(current())note.textContent='Copied. Review the customer and message in HighLevel before sending.';}
    catch{if(!current())return;if(!ui.body.querySelector('[data-handoff-copy]')){const text=h('textarea',{'data-handoff-copy':'',readOnly:true,'aria-label':'Office instructions to copy',rows:8,value:exact,style:'width:100%;font-size:16px'});box.append(text);text.focus();text.select();}note.textContent='Select and copy these instructions.';}
  });
  copy.disabled=Boolean(task.portalJobId);
  const box=h('section',{class:'ac-office-handoff'},h('h4',{},'Office follow-up'),h('p',{class:'ac-muted'},'Review the details, copy the instructions, and finish the customer follow-up in HighLevel. Record the outcome here when you are done.'),source,h('div',{class:'ac-buttons ac-handoff-actions'},copy,highlevel),note);
  ui.body.append(box);
  const fallback=message=>{if(!current())return;source.replaceChildren(h('p',{},message));content=base.join('\n\n');highlevel.href='https://app.gohighlevel.com/';highlevel.textContent='Open HighLevel';copy.disabled=false;};
  if(!task.portalJobId){fallback('No exact Hub visit is linked to this action. Find and verify the customer in HighLevel before contacting them.');return;}
  void(async()=>{
    const controller=new AbortController(),parent=state.controller?.signal,onAbort=()=>controller.abort();
    parent?.addEventListener('abort',onAbort,{once:true});ui.dialog.addEventListener('close',onAbort,{once:true});
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},12000);
    try{
      const response=await fetch('/api/dispatch?'+new URLSearchParams({view:'job',jobId:task.portalJobId}),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const data=await response.json().catch(()=>({}));
      if(!current())return;
      if(!response.ok||data.ok!==true||data.job?.id!==task.portalJobId||!data.customerHandoff||typeof data.customerHandoff!=='object')throw new Error('customer_handoff_unavailable');
      const handoff=data.customerHandoff,name=typeof handoff.name==='string'?handoff.name.trim().slice(0,300):'',phone=typeof handoff.phone==='string'?handoff.phone.trim().slice(0,80):'',tel=telHref(phone),url=handoff.reasonCode===null?contactUrl(handoff.highlevelContactUrl):'';
      if(!name&&!phone){fallback('The Hub visit has no verified customer contact details. Find and verify the customer in HighLevel before contacting them.');return;}
      source.replaceChildren(h('p',{},'Customer: '+(name||'Name unavailable in the Hub')),h('p',{},'Phone: ',tel?h('a',{href:tel},phone):phone||'Unavailable in the Hub'),url?h('p',{},'This is the HighLevel contact linked to this visit.'):h('p',{},'No linked HighLevel contact page is available. Search HighLevel using the Hub customer details before sending.'));
      content=[name?'Customer: '+name:'Customer name: unavailable in the Hub',phone?'Phone: '+phone:'Phone: unavailable in the Hub',...base].join('\n\n');
      highlevel.href=url||'https://app.gohighlevel.com/';highlevel.textContent=url?'Open customer in HighLevel':'Open HighLevel';copy.disabled=false;
    }catch(error){if(!current()||error.name==='AbortError'&&!timedOut)return;fallback(timedOut?'The Hub customer lookup timed out. Find and verify the customer in HighLevel before contacting them.':'The current Hub customer record could not be verified. Find and verify the customer in HighLevel before contacting them.');}
    finally{clearTimeout(timer);parent?.removeEventListener('abort',onAbort);ui.dialog.removeEventListener('close',onAbort);}
  })();
}
function telHref(value){const digits=String(value||'').replace(/\D/g,''),e164=digits.length===10?'+1'+digits:digits.length===11&&digits[0]==='1'?'+'+digits:'';return e164?'tel:'+e164:'';}
async function bookingActions(task,ui,generation){
  if(!has(BOOK_KINDS,task.kind)||!['open','in_progress','blocked'].includes(task.status))return;
  const kind=BOOK_KINDS[task.kind],row=h('div',{class:'ac-book-actions'});ui.body.append(row);
  const book=detail=>button('Book',()=>{closeDialog(true);window.dispatchEvent(new CustomEvent('egc:book',{detail}));},'primary');
  if(!task.portalJobId){row.append(h('p',{class:'ac-muted'},'No Hub record is linked to this action, so there is no number to call from here.'),book({kind}));return;}
  row.append(h('p',{class:'ac-loading'},'Loading the customer’s number…'));
  try{
    const response=await fetch('/api/dispatch?'+new URLSearchParams({view:'job',jobId:task.portalJobId}),{credentials:'same-origin',cache:'no-store',signal:state.controller?.signal});
    const data=await response.json().catch(()=>({}));
    if(generation!==state.generation||state.dialog!==ui.dialog)return;
    // Without scheduling access there is nothing to call or book from here.
    if(response.status===401||response.status===403){row.remove();return;}
    const job=data.job;
    if(!response.ok||data.ok!==true||job?.id!==task.portalJobId)throw new Error('unavailable');
    const tel=telHref(job.phone),who=job.customer||'the customer';
    row.replaceChildren(tel?h('a',{class:'ac-btn ac-link',href:tel},'Call '+who):h('p',{class:'ac-muted'},'The Hub record has no phone number for '+who+'.'),
      book({kind,...(typeof job.customerId==='string'&&job.customerId?{customerId:job.customerId}:{}),name:job.customer||'',phone:job.phone||'',address:job.address||''}));
  }catch(error){
    if(error.name==='AbortError'||generation!==state.generation||state.dialog!==ui.dialog)return;
    row.replaceChildren(banner('The Hub record for this action could not be read, so there is no number to call yet. Reopen the action to retry.','warning'),book({kind}));
  }
}
async function detail(id){const generation=state.generation;const ui=openDialog('Action details');ui.body.append(h('p',{class:'ac-loading'},'Loading action…'));try{const result=await rpc({command:'task.get',taskId:id});if(generation!==state.generation||state.dialog!==ui.dialog)return;const task=result.task;ui.body.replaceChildren();ui.body.append(h('span',{class:'ac-kicker'},labels[task.kind]||task.kind),h('h3',{},task.title));const list=h('dl',{class:'ac-detail-grid'}),words=value=>String(value||'Unknown').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()),facts=[['Owner',ownerName(task.assignedUserId)],['Status',words(task.status)],['Due / review',displayTime(attention(task))]];if(result.effectiveApproval&&result.effectiveApproval!=='not_required')facts.push(['Approval',({pending:'Needs review',invalidated:'Needs a fresh review',approved:'Approved'})[result.effectiveApproval]||words(result.effectiveApproval)]);for(const [label,value] of facts)list.append(h('div',{},h('dt',{},label),h('dd',{},String(value))));ui.body.append(list);void bookingActions(task,ui,generation);if(task.description)ui.body.append(h('p',{style:'white-space:pre-wrap'},task.description));officeHandoff(task,ui,generation);ui.body.append(h('h4',{},'Completion condition'),h('p',{},task.completionCondition||'Missing: add the evidence required to close this action.'));
if(task.draftPayload){const d=task.draftPayload,review=draftReview(d);ui.body.append(banner('Draft review only. Approving here does not send a message or mark this task complete.',''),h('h4',{},String(d.channel||'').toUpperCase()+' to '+d.recipient));if(d.subject)ui.body.append(h('p',{},'Subject: '+d.subject));ui.body.append(h('div',{class:'ac-message-preview'},d.body),h('p',{class:'ac-muted'},'Proposed window: '+displayTime(d.sendWindowStart)+' – '+displayTime(d.sendWindowEnd)+' · '+TZ),attachmentList(review));if(!review.ok)ui.body.append(reviewBlocked(review));}
if(task.sourceEvidence?.length){ui.body.append(h('h4',{},'Source evidence'));for(const item of task.sourceEvidence)ui.body.append(h('p',{},h('b',{},item.source==='recording'?'Walkthrough transcript':item.source+' · '+item.id),h('br'),item.excerpt||''));}
if(task.completionEvidence?.length){ui.body.append(h('h4',{},'Completion evidence'));for(const item of task.completionEvidence)ui.body.append(h('p',{},String(item.outcome||item.kind||'Recorded evidence')));}
ui.body.append(h('h4',{},'Timeline'));const history=h('ol',{class:'ac-history'});for(const event of result.history||[])history.append(h('li',{},h('b',{},event.type),h('small',{},displayTime(event.occurredAt)+' · '+event.actorId+' · revision '+(event.revision??'—')),event.evidence?.reason?h('p',{},event.evidence.reason):null));ui.body.append(history);if(result.historyMayHaveMore)ui.body.append(h('p',{class:'ac-muted'},'Showing the newest 100 history entries. Older entries remain stored.'));
ui.body.append(h('p',{},h('code',{},'Task '+task.id+' · review '+result.previewHash.slice(0,16))));
if(['open','in_progress','blocked'].includes(task.status)){ui.foot.append(button('Edit',()=>newTask(task)),button('Snooze',()=>explainAction(task,'snooze')),button('Cancel action',()=>explainAction(task,'cancel'),'danger'));if(canComplete(task.kind))ui.foot.append(button('Complete',()=>explainAction(task,'complete'),'primary'));if(task.draftPayload&&task.status!=='blocked'&&['owner','manager'].includes(state.actor?.role)){ui.foot.append(button('Reject',()=>explainAction(task,'reject')));if(draftReview(task.draftPayload).ok)ui.foot.append(button('Review approval',()=>approvalDialog(result),'primary'));}const send=sendEligibility(result,state.actor,Date.now()),pending=pendingSend(task.id);if(send.ok||pending)ui.foot.append(button(pending?'Check pending send':send.reason==='check_status'?'Check send status':'Send now',()=>sendDialog(result),'primary ac-send-now'));else if(send.reason==='window_not_open')ui.body.append(h('p',{class:'ac-muted'},'Send now opens at '+displayTime(task.draftPayload.sendWindowStart)+'.'));}
}catch(error){if(error.name!=='AbortError'&&state.dialog===ui.dialog)ui.body.replaceChildren(banner(message(error),'error'));}}
function approvalDialog(result){const t=result.task,d=t.draftPayload,review=draftReview(d);const ui=makeForm('Approve this exact draft');if(!review.ok){ui.body.prepend(reviewBlocked(review));ui.submit.disabled=true;ui.submit.textContent='Approval unavailable';return;}const links=review.attachments.length;ui.body.prepend(...[banner('This approval is for the displayed draft only. External sending is not enabled.',''),h('h3',{},t.title),h('p',{},d.channel.toUpperCase()+' · '+d.recipient),d.subject?h('p',{},'Subject: '+d.subject):null,h('div',{class:'ac-message-preview'},d.body),attachmentList(review),h('p',{class:'ac-muted'},'Revision '+t.revision+' · '+displayTime(d.sendWindowStart)+' – '+displayTime(d.sendWindowEnd)),h('p',{class:'ac-fingerprint'},h('code',{},'Review fingerprint '+result.previewHash.slice(0,16)),' covers the recipient, message, send window, '+(links===1?'1 attachment link':links+' attachment links')+' and revision '+t.revision+'. Any change needs a new review.')].filter(Boolean));ui.submit.textContent='Approve draft — does not send';const checkbox=field(ui.grid,'reviewed',links?'I reviewed the exact recipient, message, every attachment link, and revision':'I reviewed the exact recipient, message, and revision','checkbox','yes',{required:true,wide:true});ui.form.addEventListener('submit',event=>{event.preventDefault();if(!checkbox.checked)return;void submitMutation(ui,{command:'tasks.approve',items:[{taskId:t.id,revision:t.revision,previewHash:result.previewHash}],expiresAt:new Date(Date.now()+23*3600000).toISOString()},()=>load());});}
function sendDialog(result){const t=result.task,d=t.draftPayload,review=draftReview(d),pending=pendingSend(t.id),mode=pending?'pending':sendStarted(result)?'check':'send';const ui=makeForm({pending:'Check the pending send',check:'Check send status',send:'Send this exact message'}[mode]);ui.busyLabel=mode==='check'?'Checking…':'Sending…';ui.idleLabel=mode==='send'?'Send now':'Reload action';ui.persist=attempt=>savePendingSend(t.id,attempt);if(pending){ui.attempt={requestId:pending.requestId,command:pending.command};ui.tried=true;}else if(mode==='send'&&!review.ok){ui.body.prepend(reviewBlocked(review));ui.submit.disabled=true;ui.submit.textContent='Sending unavailable';return;}const links=review.attachments.length,summary=h('dl',{class:'ac-detail-grid ac-send-summary'});for(const [label,value] of [['To',d.recipient],['Channel',String(d.channel||'').toUpperCase()],...(d.subject?[['Subject',d.subject]]:[])])summary.append(h('div',{},h('dt',{},label),h('dd',{},String(value))));
const intro={pending:banner('A send of this action was started and its outcome is not confirmed. Retrying reuses the original request: it checks the provider and never sends a second copy.','warning'),check:banner('This message was already sent for revision '+t.revision+'. Checking only reads the provider’s result and completes the action once delivery is verified. Nothing is sent again.',''),send:banner('This sends the message below to the customer now, exactly as shown. Nothing else is sent.','')}[mode];
ui.body.prepend(...[intro,pending&&pending.command.revision!==t.revision?h('p',{class:'ac-muted'},'The pending request was for revision '+pending.command.revision+'.'):null,h('h3',{},t.title),summary,h('div',{class:'ac-message-preview'},d.body),attachmentList(review),h('p',{class:'ac-muted'},'Revision '+t.revision+' · Window '+displayTime(d.sendWindowStart)+' – '+displayTime(d.sendWindowEnd)+' · '+TZ),h('p',{class:'ac-fingerprint'},h('code',{},'Review fingerprint '+result.previewHash.slice(0,16)),mode==='check'?' Checking does not record a new approval.':' Sending records your approval of exactly this recipient, message, '+(links===1?'1 attachment link':links+' attachment links')+' and revision '+t.revision+'.')].filter(Boolean));
ui.submit.classList.add('ac-send-now');ui.submit.textContent={pending:'Retry original request',check:'Check send status',send:'Send now'}[mode];const checkbox=mode==='send'?field(ui.grid,'confirmSend',links?'I confirm sending exactly this message and every attachment link to this recipient':'I confirm sending exactly this message to this recipient','checkbox','yes',{required:true,wide:true,class:'ac-send-confirm'}):null;
// After a definite refusal of a retry or a status check, the button reloads the action so it
// is never a dead control; the reloaded details offer only what the server would accept.
ui.form.addEventListener('submit',event=>{event.preventDefault();if(ui.attempt){void submitMutation(ui,ui.attempt.command,sendOutcome);return;}const command={command:'task.send',taskId:t.id,revision:t.revision,previewHash:result.previewHash,confirm:true};if(mode!=='send'){if(ui.tried){closeDialog(true);void detail(t.id);return;}ui.tried=true;void submitMutation(ui,command,sendOutcome);return;}if(!checkbox?.checked)return;void submitMutation(ui,command,sendOutcome);});}
function sendOutcome(result){const delivered=result.delivered===true,pending=result.verification==='pending';const ui=openDialog('Send result');ui.body.append(banner(delivered?'Delivered. The provider confirmed delivery.':pending?'Sent. The provider accepted it; delivery is not verified yet.':'Sent. The provider accepted it'+(result.status?' (status: '+result.status+')':'')+'; delivery is not confirmed yet.',delivered?'':'warning'),h('p',{},result.completion?.ok?'The action was completed from verified delivery.':delivered&&result.completion?'Delivery is verified, but the action could not be completed from it. Review the action; nothing is sent again.':'The action stays open until delivery is verified. Open it and use Check send status; that never sends a second copy.'),result.duplicatePrevented?h('p',{class:'ac-muted'},'This approved revision was already sent. No second copy went out.'):null);ui.foot.append(button('Close',()=>closeDialog(),'primary'));void load();}
function taskRow(task,snapshot=false){const when=snapshot?task.attentionAt:attention(task),overdue=when&&new Date(when)<new Date();return h('button',{type:'button',class:'ac-row',onclick:()=>detail(task.id)},h('div',{},h('strong',{},task.title),h('small',{},(labels[task.kind]||task.reason||'Action')+' · '+(task.portalJobId?'Hub '+task.portalJobId:'Task '+task.id.slice(0,8)))),h('div',{},h('span',{class:'ac-pill '+(overdue?'urgent':'')},overdue?'Overdue':when?'Scheduled':'Missing time'),h('small',{},displayTime(when))),h('div',{},ownerName(task.assignedUserId||task.owner),h('small',{},task.waitingOn&&task.waitingOn!=='none'?'Waiting on '+task.waitingOn:'Owned next action')),h('div',{},h('span',{class:'ac-pill '+(task.status==='blocked'?'warn':'')},task.approvalStatus==='pending'?'Needs review':task.status),h('small',{},'Revision '+(task.revision??'unknown'))));}
function pager(total,next,loadPage){return h('div',{class:'ac-pager'},h('span',{},total?'Showing '+(state.offset+1)+'–'+Math.min(state.offset+50,total)+' of '+total:'No matching records'),h('div',{class:'ac-buttons'},button('Previous',()=>{state.offset=Math.max(0,state.offset-50);void loadPage();}),next!==null?button('Next',()=>{state.offset=next;void loadPage();}):null));}
async function loadQueue(generation){const command={command:'queue',view:state.view,dueBefore:cutoff(),offset:state.offset,limit:50,...(state.owner?{owner:state.owner}:{})};const result=await rpc(command);if(generation!==state.generation||!state.root?.isConnected)return;state.items=result.items;const target=content();target.replaceChildren();target.append(banner('Showing registered actions. Historical commitments and provider coverage are not yet certified complete. A booked customer or old lead can still have due work.',''));const list=h('section',{class:'ac-list','aria-label':'Action queue'});if(result.items.length)for(const task of result.items)list.append(taskRow(task));else list.append(h('div',{class:'ac-empty'},h('h2',{},'No registered actions in this view'),h('p',{},'This is not a claim that every customer is caught up. Record any outstanding commitment as an action.'),button('Create an action',()=>newTask(), 'primary')));target.append(list,pager(result.total,result.nextOffset,()=>load()),h('p',{class:'ac-footnote'},'Updated '+displayTime(result.asOf)+' · '+TZ+' · '+result.total+' registered actions in this filter.'));
const statViews=['due','approvals','blocked','waiting'];void Promise.all(statViews.map(async view=>{try{const r=await rpc({...command,view,offset:0,limit:1});if(generation===state.generation){const node=state.root?.querySelector('[data-ac-count="'+view+'"]');if(node)node.textContent=r.total;}}catch{}}));}
async function loadBrief(generation){const command={command:state.briefId?'brief.get':'brief.latest',...(state.briefId?{briefId:state.briefId}:{}),offset:state.offset,limit:50};const r=await rpc(command);if(generation!==state.generation||!state.root?.isConnected)return;const target=content();target.replaceChildren();if(!r.brief){target.append(h('div',{class:'ac-empty'},h('h2',{},'No stored brief yet'),h('p',{},'Create a snapshot of registered due work. It keeps its IDs, revisions, and coverage warnings after the live queue changes.'),button('Create brief',()=>createBrief(),'primary')));return;}const b=r.brief;state.briefId=b.snapshotId;target.append(h('div',{class:'ac-snapshot'},h('b',{},'Stored snapshot · '+displayTime(b.generatedAt)),h('p',{},b.counts.observedDue+' observed due actions · '+(b.counts.totalDue==null?'complete total unknown':b.counts.totalDue+' total')),h('p',{},(r.changes.length?'This page has '+r.changes.length+' changes since the snapshot. ':'')+'Open an action to see its current revision.')));for(const source of b.coverage||[])if(source.status!=='fresh'||!source.complete)target.append(banner('Coverage not verified: '+source.source.replaceAll('_',' ')+'.','warning'));const list=h('section',{class:'ac-list'});for(const item of b.items)list.append(taskRow(item,true));if(!b.items.length)list.append(h('div',{class:'ac-empty'},'No due actions observed in this snapshot.'));target.append(list,pager(b.counts.observedDue,b.nextOffset,()=>load()));if(b.issues?.length)target.append(h('p',{class:'ac-footnote'},b.issues.length+' recorded exceptions, including missing owners, times, or source coverage. Review the live queue’s Unassigned and All views.'));}
async function createBrief(){const ui=makeForm('Create daily brief snapshot');ui.body.prepend(h('p',{},'This saves a versioned snapshot of registered due work. It does not send a briefing or customer messages.'));field(ui.grid,'cutoff','Include work due before · '+TZ,'datetime-local',localValue(cutoff()),{required:true,wide:true});ui.form.addEventListener('submit',event=>{event.preventDefault();if(ui.attempt){void submitMutation(ui,ui.attempt.command,()=>load());return;}try{const dueBefore=localToIso(new FormData(ui.form).get('cutoff'));void submitMutation(ui,{command:'brief.create',dueBefore,timeZone:TZ},result=>{state.briefId=result.briefId;setView('brief');});}catch(error){ui.error.textContent=message(error);}});}
async function portalTimeline(portalJobId){
  const ui=openDialog('Customer and visit timeline');let offset=0;
  async function page(){ui.body.replaceChildren(h('p',{class:'ac-loading'},'Loading recorded evidence…'));try{const r=await rpc({command:'history',portalJobId,offset,limit:50});if(state.dialog!==ui.dialog)return;ui.body.replaceChildren(h('p',{class:'ac-muted'},'Customer communications stay at customer level unless an exact visit link is recorded. Provider appointments are shown as provider evidence.'));
    const list=h('ol',{class:'ac-history'});for(const item of r.items||[]){const d=item.data||{},entry=h('li',{},h('b',{},String(item.kind||'Event').replaceAll('_',' ')),h('small',{},displayTime(item.at)),d.title?h('p',{},d.title):null);if(d.direction||d.actorType)entry.append(h('p',{},[d.direction,d.actorType].filter(Boolean).join(' · ')));if(d.status)entry.append(h('p',{},'Status: '+d.status));if(d.body)entry.append(h('p',{},d.body));if(d.amountCents!==undefined)entry.append(h('p',{},d.amountCents===null?'Amount unknown':new Intl.NumberFormat('en-US',{style:'currency',currency:d.currency||'USD'}).format(d.amountCents/100)));if(d.authority)entry.append(h('small',{},d.authority==='employee_hub'?'Employee Hub record':'Provider record'));if(d.transcript)entry.append(h('details',{},h('summary',{},'Transcript'),h('p',{style:'white-space:pre-wrap'},d.transcript)));if(item.kind==='call')entry.append(h('p',{},'Two-way contact: '+(d.twoWay?'confirmed':'not confirmed')),d.outcome?h('p',{},d.outcome):null);if(d.owner||d.dueAt)entry.append(h('p',{},[d.owner?'Owner: '+d.owner:'',d.dueAt?'Due: '+displayTime(d.dueAt):''].filter(Boolean).join(' · ')));if(d.portalVisitId)entry.append(h('p',{},'Exact visit: '+d.portalVisitId));list.append(entry);}ui.body.append(list);if(!(r.items||[]).length)ui.body.append(h('p',{},'No imported timeline evidence is available for this page.'));ui.body.append(h('p',{class:'ac-muted'},'Recorded events: '+r.total+'. Coverage reflects imported records and verified associations; missing source data is not proof that no activity occurred.'));
    ui.foot.replaceChildren(button('Close',()=>closeDialog()));if(offset>0)ui.foot.append(button('Previous',()=>{offset=Math.max(0,offset-50);void page();}));if(r.nextOffset!==null)ui.foot.append(button('Next',()=>{offset=r.nextOffset;void page();}));
  }catch(error){if(state.dialog===ui.dialog)ui.body.replaceChildren(banner(message(error),'error'));}}await page();
}
async function portalInstructions(portalJobId){
  const ui=openDialog('Visit and job instructions');ui.body.append(h('p',{class:'ac-loading'},'Loading the authoritative Hub record…'));
  try{const r=await rpc({command:'portal.job',jobId:portalJobId});if(state.dialog!==ui.dialog)return;const job=r.job||{};ui.body.replaceChildren(h('p',{class:'ac-muted'},'Hub record '+job.id+(job.projectId?' · Project '+job.projectId:'')),h('h3',{},'Staff operational instructions'),h('p',{style:'white-space:pre-wrap'},job.operationalScope?.text||'No staff operational instructions recorded.'));
    if(job.operationalScope?.updatedAt)ui.body.append(h('small',{},displayTime(job.operationalScope.updatedAt)+(job.operationalScope.updatedBy?' · '+job.operationalScope.updatedBy:'')));
    ui.body.append(h('h3',{},'Operational notes'));const notes=Array.isArray(job.operationNotes)?job.operationNotes:[],superseded=new Set(notes.map(n=>n.supersedes).filter(Boolean));for(const n of notes.filter(n=>!superseded.has(n.id)))ui.body.append(h('article',{},h('p',{style:'white-space:pre-wrap'},String(n.body||'')),h('small',{},displayTime(n.createdAt)+(n.actorId?' · '+n.actorId:''))));if(!notes.length)ui.body.append(h('p',{},'No operational notes recorded.'));ui.body.append(h('p',{class:'ac-muted'},'Staff instructions do not change the customer-approved price or scope. Replaced notes remain in the timeline.'));ui.foot.append(button('Timeline',()=>portalTimeline(portalJobId)));
  }catch(error){if(state.dialog===ui.dialog)ui.body.replaceChildren(banner(message(error),'error'));}
}
async function loadCalendar(generation){const r=await rpc({command:'calendar',startDate:today(),endDate:plusDays(today(),14),timeZone:TZ,offset:state.offset,limit:50});if(generation!==state.generation||!state.root?.isConnected)return;const target=content();target.replaceChildren(banner('Source: the actual EGC Employee Hub schedule. HighLevel appointments are not substituted.',''));const list=h('section',{class:'ac-list'});for(const issue of r.exceptions||[])target.append(banner('Portal record '+issue.recordId+': '+issue.code.replaceAll('_',' ')+'.','warning'));for(const item of r.items)list.append(h('article',{class:'ac-row'},h('div',{},h('strong',{},item.customer||'Unnamed customer'),h('small',{},item.kind+' · '+item.id)),h('div',{},item.localDate+' '+(item.localStart||'Time unknown'),item.timeNeedsReview?h('small',{},'Timing needs review'):null),h('div',{},item.status),h('div',{},button('Add action',()=>newTask(null,item)),['owner','manager'].includes(state.actor?.role)?button('Recordings',()=>window.EGCRecordings?.open(item.id)):null,button('Instructions',()=>portalInstructions(item.id)),button('Timeline',()=>portalTimeline(item.id)))));if(!r.items.length)list.append(h('div',{class:'ac-empty'},'No portal visits found in the next 14 days.'));target.append(list,pager(r.total,r.nextOffset,()=>load()),h('p',{class:'ac-footnote'},'Portal-authoritative records · '+TZ+' · '+r.total+' visits observed.'));}
const metricNames={leads:'Leads created',leadsCreated:'Leads created',humanContacts:'Human contacts',twoWayContacts:'Two-way conversations',qualified:'Qualified',priceExpectationsAccepted:'Price expectations accepted',videoQuoteOpportunities:'Video quote opportunities',videoQuotesReceived:'Video quotes received',quotesDelivered:'Quotes delivered',walkthroughsVerballyBooked:'Walkthroughs verbally booked',walkthroughsFormallyBooked:'Walkthroughs formally booked',walkthroughsBooked:'Walkthroughs formally booked',walkthroughsCompleted:'Walkthroughs completed',jobsSold:'Jobs sold',jobsCompleted:'Jobs completed',cashCollected:'Customers with cash collected'};
const words=s=>metricNames[s]||String(s).replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2');
const money=cents=>cents==null?'Amount unverified':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
function revenueCard(label,revenue,customers=[]){
  const events=Array.isArray(revenue.unknownOccurrenceEvents)?revenue.unknownOccurrenceEvents:[],count=(v,fallback)=>Number.isSafeInteger(v)&&v>=0?v:fallback;
  const unknownDates=count(revenue.unknownOccurrenceCount,events.length),unknownValues=count(revenue.unknownValueCount,revenue.missingValue?.length||0);
  const complete=Number.isSafeInteger(revenue.valueCents)&&!revenue.coverageIncomplete&&!unknownDates&&!unknownValues;
  const subtotal=Number.isSafeInteger(revenue.knownSubtotalCents)?revenue.knownSubtotalCents:complete?revenue.valueCents:null;
  const card=h('article',{'data-revenue-kind':label},h('span',{},label),h('strong',{},complete?money(revenue.valueCents):'Total unavailable'));
  if(!complete)card.append(h('small',{},'Verified dated subtotal: '+(subtotal===null?'Not available':money(subtotal))));
  card.append(h('small',{},`Date unknown: ${unknownDates} · Amount unverified: ${unknownValues}`),h('small',{},revenue.qualification||(complete?'Verified dated outcomes in this period.':'The verified dated subtotal is not a complete period total.')));
  if(events.length){const list=h('ul');for(const event of events){const customer=customers.find(c=>c.contactId===event.contactId);list.append(h('li',{},button(customer?.customerName||'Customer evidence',()=>intelligenceCustomer(event.contactId)),h('small',{},(Number.isSafeInteger(event.valueCents)&&event.currency==='USD'?money(event.valueCents):'Amount unverified')+' · Not assigned to this period')));}card.append(h('details',{},h('summary',{},'Review outcomes without dates'),list));}
  return card;
}
async function intelligenceCustomer(contactId){
  const ui=openDialog('Customer evidence');ui.body.append(h('p',{class:'ac-loading'},'Loading the customer event ledger…'));
  try{const result=await rpc({command:'intelligence.customer',contactId});if(state.dialog!==ui.dialog)return;const r=result.timeline||result;
    ui.body.replaceChildren(h('p',{class:'ac-muted'},'Each event retains its source evidence. User-confirmed outcomes stay visible while provider records catch up.'));
    for(const event of r.events||r.items||[]){const card=h('article',{class:'ac-evidence-event'},h('h3',{},words(event.eventType||event.type||event.kind)),h('small',{},displayTime(event.occurredAt||event.at)+' · '+(event.source||'customer evidence')));
      for(const evidence of event.evidence||[])card.append(h('p',{style:'white-space:pre-wrap'},evidence.excerpt||''),h('small',{},evidence.sourceType+' · '+evidence.sourceRecordId));
      if(event.humanReviewNeeded)card.append(banner('This event needs review and is not a verified conversion.'));
      if(event.valueVerified&&Number.isInteger(event.valueCents))card.append(h('p',{},'Verified amount: '+money(event.valueCents)));ui.body.append(card);
    }
  }catch(error){if(state.dialog===ui.dialog)ui.body.replaceChildren(banner(message(error),'error'));}
}
async function loadIntelligence(generation){
  const since=localToIso(plusDays(today(),1-state.intelligenceDays)+'T00:00'),until=new Date().toISOString();
  const [reportResponse,diagnosticsResponse]=await Promise.all([rpc({command:'intelligence.report',since,until,cohortSince:since,cohortUntil:until}),rpc({command:'intelligence.diagnostics'})]);
  if(generation!==state.generation||!state.root?.isConnected)return;
  const r=reportResponse.report||reportResponse,d=diagnosticsResponse.diagnostics||diagnosticsResponse,target=content();target.replaceChildren();
  const select=h('select',{'aria-label':'Sales evidence reporting window',onchange:event=>{state.intelligenceDays=Number(event.target.value);void load();}},...[1,7,30].map(days=>h('option',{value:String(days),selected:days===state.intelligenceDays},days===1?'Today':`Last ${days} calendar days`)));
  target.append(h('div',{class:'ac-toolbar'},h('div',{},h('h2',{},'Sales evidence and operational state'),h('p',{class:'ac-muted'},displayTime(since)+' – '+displayTime(until)+' · '+TZ)),select));
  if(r.coverage?.complete===false||r.sourceCoverage?.complete===false)target.append(banner('Some customer sources remain incomplete. Review diagnostics before treating these totals as complete.'));
  target.append(h('h3',{},'Activity in this period'));const stats=h('div',{class:'ac-intelligence-metrics'});
  for(const [key,value] of Object.entries(r.periodActivity||{}))stats.append(h('article',{},h('span',{},words(key)),h('strong',{},value.count??'Unavailable')));
  for(const [key,label] of [['soldRevenue','Sold revenue'],['collectedRevenue','Collected revenue']])if(r[key])stats.append(revenueCard(label,r[key],r.customers||[]));
  target.append(stats,h('h3',{},'Lead cohort conversion'));const table=h('table',{class:'ac-cohort-table'},h('thead',{},h('tr',{},h('th',{},'Outcome'),h('th',{},'Converted / leads'),h('th',{},'Observed rate')))),body=h('tbody');
  for(const [key,value] of Object.entries(r.cohort?.metrics||{}))body.append(h('tr',{},h('td',{},words(key)),h('td',{},`${value.numerator} / ${value.denominator}`),h('td',{},value.rate==null?'—':(value.rate*100).toFixed(1)+'%')));
  table.append(body);target.append(h('p',{class:'ac-muted'},'Only leads created in the selected window are in these denominators. Their outcomes are observed through '+displayTime(r.cohort?.observedThrough||until)+'. This is an immature cohort, not a final close rate.'),h('div',{class:'ac-table-scroll'},table));
  for(const [key,label] of [['walkthrough','Walkthrough pipeline'],['videoQuote','Video quote pipeline'],['directJob','Direct-job pipeline']]){
    const rows=r.pipelines?.[key]||[],section=h('section',{class:'ac-pipeline-section'},h('h3',{},label+' · '+rows.length));
    for(const customer of rows){const card=h('article',{class:'ac-evidence-event'},h('h4',{},customer.customerName||'Customer'),h('span',{class:'ac-pill'},words(customer.state)),h('p',{},'Next: '+customer.nextRequiredAction),h('small',{},words(customer.reconciliationStatus)+' · Intent: '+words(customer.intentStage)));
      if(customer.videoQuoteStage)card.append(h('p',{},'Video quote: '+words(customer.videoQuoteStage)));
      for(const evidence of (customer.supportingEvidence||[]).slice(0,4))card.append(h('blockquote',{},evidence.excerpt),h('small',{},evidence.sourceType+' · '+displayTime(evidence.occurredAt)));
      card.append(button('Customer evidence',()=>intelligenceCustomer(customer.contactId)));section.append(card);
    }
    if(!rows.length)section.append(h('p',{class:'ac-muted'},'No active opportunities recorded in this pipeline.'));target.append(section);
  }
  const diagnostics=h('section',{class:'ac-pipeline-section'},h('h3',{},'Reconciliation and sync diagnostics'));
  for(const [key,value] of Object.entries(d))if(Array.isArray(value)){diagnostics.append(h('details',{},h('summary',{},words(key)+' · '+value.length),...value.slice(0,30).map(item=>h('p',{},typeof item==='string'?item:[item.customerName||item.contactId||item.portalVisitId||item.eventId||'',item.code||item.status||item.errorCode||'',item.detail||item.nextRequiredAction||''].filter(Boolean).join(' · ')))));}
  const meta=d.meta||d.metaSync;if(meta){diagnostics.append(h('h4',{},'Meta conversion delivery'));const counts=Array.isArray(meta.counts)?meta.counts:Object.entries(meta.counts||meta).filter(([,count])=>typeof count==='number').map(([status,count])=>({status,count}));for(const row of counts)diagnostics.append(h('p',{},words(row.status)+': '+row.count));if(meta.lastSuccessfulSync||meta.lastSuccessfulMetaSync)diagnostics.append(h('p',{},'Last successful sync: '+displayTime(meta.lastSuccessfulSync||meta.lastSuccessfulMetaSync)));}
  target.append(diagnostics,h('p',{class:'ac-footnote'},'Generated '+displayTime(r.generatedAt)+' · Activity and lead cohorts use separate event windows. Open customer evidence to inspect any counted opportunity.'));
}
async function load(){if(!state.enabled||!state.root)return;const generation=++state.generation;const target=content();target.replaceChildren(h('p',{class:'ac-loading',role:'status'},'Loading authoritative records…'));try{if(state.view==='brief')await loadBrief(generation);else if(state.view==='calendar')await loadCalendar(generation);else if(state.view==='intelligence')await loadIntelligence(generation);else await loadQueue(generation);}catch(error){if(error.name==='AbortError'||generation!==state.generation)return;target.replaceChildren(banner(message(error),'error'),button('Retry',()=>load()));}}
function setView(view){state.view=view;state.offset=0;for(const b of state.root.querySelectorAll('[data-ac-view]'))b.setAttribute('aria-selected',String(b.dataset.acView===view));void load();}
// Hub home widgets open the Action Center on one queue view (for example overdue) before navigating to it.
function show(view){if(!['all','due','overdue','approvals','blocked','waiting','ownerless'].includes(view))return false;if(state.root&&state.enabled)setView(view);else{state.view=view;state.offset=0;}return true;}
function shell(){const root=h('section',{class:'egc-actions',id:'egc-action-center'});root.append(h('header',{class:'ac-head'},h('div',{},h('span',{class:'ac-kicker'},'Unified operations'),h('h1',{},'Action Center'),h('p',{class:'ac-muted'},'What happened, what we promised, and what needs to happen next.')),h('div',{class:'ac-buttons'},button('Refresh',()=>load()),button('Save brief',()=>createBrief()),button('New action',()=>newTask(),'primary'))));const stats=h('div',{class:'ac-stats'});for(const [view,label] of [['due','Due / needs review'],['approvals','Drafts awaiting approval'],['blocked','Blocked actions'],['waiting','Waiting on others']])stats.append(h('button',{class:'ac-stat',onclick:()=>setView(view)},h('span',{},label),h('b',{'data-ac-count':view},'—'),h('span',{},'Registered tasks')));root.append(stats);const tabs=h('div',{class:'ac-tabs',role:'tablist','aria-label':'Action views'});for(const [view,label] of [['due','Due'],['all','All open'],['overdue','Overdue'],['approvals','Approvals'],['ownerless','Unassigned'],['calendar','Portal schedule'],['intelligence','Sales evidence'],['brief','Stored brief']])tabs.append(h('button',{type:'button',class:'ac-tab',role:'tab','data-ac-view':view,'aria-selected':String(view===state.view),onclick:()=>setView(view)},label));const select=h('select',{'aria-label':'Filter action owner',onchange:event=>{state.owner=event.target.value;state.offset=0;void load();}},h('option',{value:''},'All owners'));select.dataset.acOwner='true';root.append(h('div',{class:'ac-toolbar'},tabs,h('label',{class:'ac-filter'},'Owner',select)),h('div',{'data-ac-content':'true','aria-live':'polite'},h('p',{class:'ac-loading'},'Checking your signed-in account…')));return root;}
// With EGC_OPERATIONS_STAFF_MEMBERS on, a staff roster the Hub could not read leaves only business users assignable; say so.
function staffNotice(staff){if(!staff||staff.available!==false)return;state.root.querySelector('.ac-toolbar')?.after(banner(staff.code==='portal_members_ambiguous'?'Two staff identities differ only by letter case, so sales and phone staff are not listed as owners. Business users can still be assigned; review Staff accounts.':'Sales and phone staff could not be loaded, so only business users can be assigned right now. Reopen the Action Center to try again.','warning'));}
async function mount(host){if(!host)return;if(state.host===host&&state.root?.isConnected)return;unmount();state.host=host;state.controller=new AbortController();state.root=shell();host.replaceChildren(state.root);for(const b of state.root.querySelectorAll('button'))b.disabled=true;const generation=state.generation;try{const response=await fetch('/api/operations',{credentials:'same-origin',signal:state.controller.signal});const r=await response.json();if(!response.ok||r.error){const e=new Error(r.error);e.code=r.error;throw e;}if(generation!==state.generation)return;state.actor=r.actor;state.owners=r.owners||[];state.enabled=r.enabled;staffNotice(r.staffOwners);const select=state.root.querySelector('[data-ac-owner]');for(const owner of state.owners)select.append(h('option',{value:owner.id},owner.name));if(!state.enabled){content().replaceChildren(banner(errorLabels.operations_not_enabled,'warning'));for(const b of state.root.querySelectorAll('button'))b.disabled=true;return;}for(const b of state.root.querySelectorAll('button'))b.disabled=false;await load();}catch(error){if(error.name!=='AbortError'&&generation===state.generation)content()?.replaceChildren(banner(message(error),'error'));}}
function unmount(){state.generation++;state.controller?.abort();state.controller=null;closeDialog(true);state.root?.remove();state.root=null;state.host=null;state.actor=null;state.owners=[];state.enabled=false;state.busy=false;state.briefId=null;state.offset=0;}
window.addEventListener('beforeunload',event=>{if(state.dirty||state.busy){event.preventDefault();event.returnValue='';}});
window.addEventListener('egc:signout',()=>{clearPendingSends();unmount();});
window.EGCActionCenter={mount,unmount,canLeave:dirtyCheck,show,localToIso,drafts:Object.freeze({MESSAGE_KINDS,ATTACHMENT_KINDS,labels,isMessageKind,canComplete,draftReview,buildDraft}),send:Object.freeze({sendEligibility,sendStarted})};
})();
