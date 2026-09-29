/* Server-authoritative job money (M3). When MONEY_API_ENABLED is on (surfaced as
 * window.EGC_FLAGS.moneyApi by /api/integration-status), the Hub finance buttons
 * for estimates, approvals, deposits, payments and invoices save through
 * /api/money with a request ID, revision check, receipt and audit entry.
 * Otherwise the existing browser tools run unchanged. The last flag value read
 * is kept per viewer for this tab, so a failed check never silently falls back
 * to the browser tools once server money actions were on. Nothing here sends a
 * message itself: after a confirmed estimate, approval, deposit, payment or
 * invoice save it starts the same HighLevel lifecycle trigger (the egc-<event>
 * tag, suppressed when the job's notify is off) as the standard finance save,
 * through the suite's own helper (window.EGCCustomerCommunication). */
(function () {
'use strict';
const TZ='America/Denver', PREFIX='egc.money.pending.v1.', FLAG_PREFIX='egc.money.flag.v1.', MAX_LINES=12;
const HANDLED=new Set(['estimate','accept','deposit','payment','invoice']);
const METHODS=[['cash','Cash'],['check','Check'],['card_terminal','Card terminal'],['bank_transfer','Bank transfer / ACH'],['other','Other']];
const CHANNELS=[['email','Email'],['text','Text message'],['in_person','In person'],['phone','Phone call'],['other','Other']];
const KINDS=[['service','Service'],['labor','Labor'],['product','Product'],['disposal','Disposal'],['fee','Fee']];
const ACTIVE_INVOICE=new Set(['issued','partial','overdue','paid','pending_verification']);
const RETRY_STATUS=new Set([401,403,408,429]);
// The standard finance save's lifecycle trigger for each server action (employee-suite.js opsFinanceAction):
// [its action name, the event]. Marking an estimate sent, voiding an invoice and saving costs trigger nothing there or here.
const LIFECYCLE={'estimate.save':['estimate','estimate-ready'],'estimate.record_approval':['accept','estimate-approved'],'deposit.record_offline':['deposit','deposit-received'],'invoice.issue':['invoice','invoice-issued'],'payment.record_offline':['payment','payment-received']};
const UNTRIGGERED='customer message not triggered · use Trigger in HighLevel if it is still needed';
const FLAGGED='customer message not triggered · flagged in Customer messages, so use Trigger in HighLevel there if it is still needed';
// Read-back waits (ms) before a save counts as unconfirmed; how long a missed-trigger flag and the next form for the job wait.
const READBACK=[400,1200,3000],FLAG_WAIT=8000,TRIGGER_WAIT=20000;
// jobId -> the customer message a confirmed save is still starting; it patches the job, so the next form waits for it.
const TRIGGERS=new Map();
const legacy=typeof window.opsFinanceAction==='function'?window.opsFinanceAction:null;
const S={dialog:null,opener:null,generation:0,flagRequest:null,busy:false,loading:false,id:'',action:'',view:'',job:null,viewer:'',draft:null,pending:null,error:'',errorKind:'',notice:''};
const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value]of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else if(name in node&&!name.startsWith('aria-')&&!name.startsWith('data-'))node[name]=value;else node.setAttribute(name,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const money=cents=>Number.isSafeInteger(cents)?usd.format(cents/100):'Needs review';
const dollars=cents=>Number.isSafeInteger(cents)?(cents/100).toFixed(2):'';
function today(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;}
const addDays=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T12:00:00Z'))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;
/** Dollars typed by a person as whole cents, or null. */
function cents(text){const value=String(text??'').trim().replace(/^\$/,'').replace(/,/g,'');const m=/^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(value);return m?Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')):null;}
function quantity(text){const value=String(text??'').trim();if(!/^\d{1,5}(?:\.\d{1,2})?$/.test(value))return null;const q=Number(value);return q>0?q:null;}
function lineTotal(line){const unit=cents(line.unit),q=quantity(line.quantity);if(unit===null||q===null)return null;const qh=Math.round(q*100);return unit*qh%100===0?unit*qh/100:null;}
const storageKey=(viewer,id)=>PREFIX+viewer+':'+id;
function readPending(viewer,id){try{const saved=JSON.parse(sessionStorage.getItem(storageKey(viewer,id))||'null');return saved&&saved.viewer===viewer&&saved.body?.jobId===id&&typeof saved.body.requestId==='string'?saved:null;}catch{return null;}}
function writePending(pending){try{sessionStorage.setItem(storageKey(pending.viewer,pending.body.jobId),JSON.stringify(pending));}catch{/* Storage may be disabled; the request stays in memory for this dialog. */}}
function clearPending(viewer,id){try{sessionStorage.removeItem(storageKey(viewer,id));}catch{}}
function clearAllPending(){try{for(const key of Object.keys(sessionStorage))if(key.startsWith(PREFIX)||key.startsWith(FLAG_PREFIX))sessionStorage.removeItem(key);}catch{}}
function flagKey(){try{return FLAG_PREFIX+String(window.EGCHubAuth?.profile?.().user||sessionStorage.getItem('egc_u')||localStorage.getItem('egc_u')||'').trim().toLowerCase();}catch{return FLAG_PREFIX;}}
function lastFlag(){try{return sessionStorage.getItem(flagKey());}catch{return null;}}
function setFlag(value){window.EGC_FLAGS={...(window.EGC_FLAGS||{}),moneyApi:value};try{sessionStorage.setItem(flagKey(),String(value));}catch{}}
function toast(message){if(typeof window.showToast==='function')window.showToast(message);}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Resolves with the promise's value, or with `fallback` after ms. */
function within(promise,ms,fallback){let timer;return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),ms);})]).finally(()=>clearTimeout(timer));}

async function call(url,init={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  const run=typeof window.hubFetch==='function'?window.hubFetch:(input,options)=>fetch(input,{...options,credentials:'same-origin'});
  let response;
  try{response=await run(url,{...init,cache:'no-store',signal:controller.signal});}
  catch(error){if(error?.code==='HUB_AUTH_REQUIRED')throw Object.assign(new Error('Sign in again, then retry.'),{status:401,code:error.code});throw Object.assign(new Error(error?.name==='AbortError'?'The server did not answer in time.':'The connection was interrupted.'),{status:0,code:'money_network'});}
  finally{clearTimeout(timer);}
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data||data.ok!==true)throw Object.assign(new Error(data?.error||'Job money could not be verified. Retry.'),{status:response.ok?503:response.status,code:data?.code||'money_unverified',details:data?.details});
  return data;
}

/** true when the server says money writes go through /api/money; null when signed out; 'unknown' when it could not be read after it was last on. */
async function enabled(){
  const flags=window.EGC_FLAGS;
  if(flags&&typeof flags.moneyApi==='boolean')return flags.moneyApi;
  S.flagRequest ||= (async()=>{
    try{const data=await call('/api/integration-status');const value=data.flags?.moneyApi===true;setFlag(value);return value;}
    // An unreadable setting keeps today's finance tools only if the last one read here was off; the next click checks again.
    catch(error){return error.status===401?null:lastFlag()==='true'?'unknown':false;}
    finally{S.flagRequest=null;}
  })();
  return S.flagRequest;
}

function validJob(data,id){const job=data?.job;return job&&job.id===id&&typeof job.revision==='string'&&job.revision&&job.totals&&typeof job.totals==='object'&&Array.isArray(job.lineItems)&&job.invoice&&typeof job.invoice.status==='string'&&typeof data.viewer?.id==='string'&&data.viewer.id;}
async function load(){
  const generation=++S.generation;S.loading=true;S.error='';S.errorKind='';render();
  try{
    // The last save's customer message patches this job (its money revision): load after it, so saving here does not conflict.
    const trigger=TRIGGERS.get(S.id);
    if(trigger){await within(trigger,TRIGGER_WAIT);if(generation!==S.generation)return;render();}
    const data=await call('/api/money?'+new URLSearchParams({jobId:S.id}));
    if(generation!==S.generation)return;
    if(!validJob(data,S.id))throw Object.assign(new Error('The job money details were incomplete. Retry.'),{status:503});
    if(data.enabled===false){handOver(data.viewer.id,'Server money actions are turned off. Opening the standard finance tools.');return;}
    S.job=data.job;S.viewer=data.viewer.id;S.pending=readPending(S.viewer,S.id);
    if(!S.draft)S.draft=freshDraft();
  }catch(error){if(generation!==S.generation)return;S.job=null;S.error=error.status===404?'This job is not available for money changes.':error.message;S.errorKind='load';}
  finally{if(generation===S.generation){S.loading=false;render();focusFirst();}}
}

function includedLines(job){return job.lineItems.filter(line=>line.selected===true&&line.kind!=='tip');}
// Options, packages, discounts and tips come from the walkthrough; this editor never reprices them.
function lockedEstimate(job){return job.lineItems.some(line=>line.optional||line.grouped||!['service','labor','product','disposal','fee'].includes(line.kind))||!job.linesComplete;}
function freshDraft(){
  const job=S.job,t=job.totals;
  if(S.view==='estimate'){
    const lines=job.estimate?includedLines(job):[{id:'',kind:'service',name:job.serviceType||'Garage transformation',description:'',quantity:1,unitCents:t.quoteCents}];
    return{lines:lines.map(line=>({id:line.id||newId(),kind:KINDS.some(([k])=>k===line.kind)?line.kind:'service',name:line.name||'',description:line.description||'',quantity:String(line.quantity??1),unit:dollars(line.unitCents)})),scope:job.estimate?.scope||'',deposit:dollars(t.depositRequiredCents),depositTouched:Boolean(job.estimate),validUntil:job.estimate?.validUntil&&job.estimate.validUntil>=today()?job.estimate.validUntil:addDays(today(),14)};
  }
  if(S.view==='accept')return{approvedBy:job.customer||''};
  if(S.view==='deposit')return{amount:dollars(t.depositDueCents),method:'check',reference:''};
  if(S.view==='payment')return{amount:dollars(t.balanceCents),method:'check',reference:''};
  if(S.view==='invoice')return{dueDate:job.invoice.dueDate&&job.invoice.dueDate>=today()?job.invoice.dueDate:addDays(today(),7),customerReference:job.invoice.customerReference||''};
  if(S.view==='sent')return{channel:'email',note:''};
  if(S.view==='void')return{reason:''};
  if(S.view==='change')return{changeOrderId:S.draft?.changeOrderId||'',reason:''};
  return{};
}
const newId=()=>'l'+crypto.randomUUID().replace(/-/g,'').slice(0,10);

function body(){
  const d=S.draft,job=S.job,base={requestId:crypto.randomUUID(),jobId:job.id,expectedRevision:job.revision,actorId:S.viewer};
  const problem=message=>{throw Object.assign(new Error(message),{kind:'input'});};
  if(S.view==='estimate'){
    if(!d.lines.length)problem('Add at least one priced line.');
    const lineItems=d.lines.map((line,index)=>{const unitCents=cents(line.unit),q=quantity(line.quantity);if(!line.name.trim())problem(`Line ${index+1} needs a name.`);if(q===null)problem(`Line ${index+1} needs a quantity above 0 with at most two decimals.`);if(unitCents===null)problem(`Line ${index+1} needs a price in dollars and cents.`);if(lineTotal(line)===null)problem(`Line ${index+1}: price times quantity must come to whole cents.`);return{id:line.id,kind:line.kind,name:line.name.trim(),description:line.description.trim(),quantity:q,unitCents};});
    const total=estimateTotal(),deposit=cents(d.deposit);
    if(!(total>0))problem('The estimate total must be more than $0.00.');
    if(deposit===null||deposit>total)problem('Enter a deposit between $0.00 and the estimate total.');
    if(!d.scope.trim())problem('Describe the customer-facing scope.');
    if(!validDate(d.validUntil)||d.validUntil<today())problem('Choose an expiry date of today or later.');
    return{action:'estimate.save',...base,lineItems,scope:d.scope.trim(),depositCents:deposit,validUntil:d.validUntil};
  }
  if(S.view==='accept'){if(d.approvedBy.trim().length<2)problem('Enter the name of the person who approved.');return{action:'estimate.record_approval',...base,approvedBy:d.approvedBy.trim()};}
  if(S.view==='deposit'||S.view==='payment'){const amount=cents(d.amount);if(!(amount>0))problem('Enter the amount received in dollars and cents.');if(d.reference.trim().length<2)problem('Enter a receipt, check or transaction reference.');return{action:S.view==='deposit'?'deposit.record_offline':'payment.record_offline',...base,amountCents:amount,method:d.method,reference:d.reference.trim()};}
  if(S.view==='invoice'){if(!validDate(d.dueDate)||d.dueDate<today())problem('Choose a payment due date of today or later.');return{action:'invoice.issue',...base,dueDate:d.dueDate,...(d.customerReference.trim()?{customerReference:d.customerReference.trim()}:{})};}
  if(S.view==='sent')return{action:'estimate.mark_sent',...base,channel:d.channel,...(d.note.trim()?{note:d.note.trim()}:{})};
  if(S.view==='void'){if(d.reason.trim().length<3)problem('Enter why the invoice is being voided.');return{action:'invoice.void',...base,reason:d.reason.trim()};}
  if(S.view==='change'){if(d.reason.trim().length<3)problem('Enter why the change is being voided.');return{action:'change_order.void',...base,changeOrderId:d.changeOrderId,reason:d.reason.trim()};}
  problem('Choose a money action.');
}
function estimateTotal(){let total=0;for(const line of S.draft.lines){const value=lineTotal(line);if(value===null)return null;total+=value;}return total;}

const SAVED={'estimate.save':'Estimate saved','estimate.record_approval':'Approval recorded','estimate.mark_sent':'Estimate marked as sent','deposit.record_offline':'Deposit recorded','payment.record_offline':'Payment recorded','invoice.issue':'Invoice issued','invoice.void':'Invoice voided','change_order.void':'Approved change voided'};
async function submit(){
  if(S.busy||!S.job)return;
  if(S.pending){S.error='Retry or discard the earlier unconfirmed save first.';S.errorKind='pending';render();return;}
  let request;
  try{request=body();}catch(error){S.error=error.message;S.errorKind='input';render();focusError();return;}
  S.pending={viewer:S.viewer,body:request,savedAt:new Date().toISOString()};writePending(S.pending);
  await send();
}
async function send(){
  if(S.busy||!S.pending)return;
  const pending=S.pending,generation=S.generation;
  S.busy=true;S.error='';S.errorKind='';render();
  try{
    const result=await call('/api/money',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.body)});
    if(result.requestId!==pending.body.requestId||result.job?.id!==pending.body.jobId)throw Object.assign(new Error('The saved job did not match this request. Review the job before retrying.'),{status:503});
    clearPending(pending.viewer,pending.body.jobId);
    if(generation===S.generation)S.pending=null;
    const warnings=(result.warnings||[]).map(item=>item?.message).filter(Boolean);
    if(!LIFECYCLE[pending.body.action]){finish([SAVED[pending.body.action]||'Saved','nothing was sent to the customer',...warnings].join(' · '),result);return;}
    // As in the standard finance tools, the saved money closes the form and the toast then reports HighLevel.
    const id=pending.body.jobId,run=customerMessage(pending.body).catch(()=>'Saved · customer message needs retry').then(message=>toast([message,...warnings].join(' · '))).finally(()=>{if(TRIGGERS.get(id)===run)TRIGGERS.delete(id);});
    TRIGGERS.set(id,run);
    finish('',result);
    await run;
  }catch(error){
    if(generation!==S.generation)return;
    const code=error.code||'',retry=!error.status||error.status>=500||RETRY_STATUS.has(error.status);
    // This tab never saw that save confirmed, so it never started its trigger, and the saved job it describes is gone.
    if(code==='money_changed_since_operation'){clearPending(pending.viewer,pending.body.jobId);S.pending=null;finish('Saved earlier · the job has changed since, so review it'+(LIFECYCLE[pending.body.action]?' · '+UNTRIGGERED:''),null);return;}
    if(code==='money_api_disabled'){handOver(pending.viewer,'Server money actions were turned off, so this was not saved here. Opening the standard finance tools; check the job before entering it again.');return;}
    if(retry){S.error=error.message+' Your request is kept. Retry it unchanged; do not create another.';S.errorKind='retry';}
    else{
      clearPending(pending.viewer,pending.body.jobId);S.pending=null;
      S.error=code==='money_revision_conflict'?'This job changed after you opened it. Your entries are kept. Load the latest job details, review them, then save again.':error.message;
      S.errorKind=code==='money_revision_conflict'?'conflict':'input';
    }
  }finally{if(generation===S.generation){S.busy=false;render();if(S.error)focusError();}}
}
/**
 * Starts the standard finance save's HighLevel lifecycle trigger for a confirmed save, at most once, and returns its
 * toast. It uses the saved job (moneyRequestId proves it is this save): the marker is the save's own time, so a replay
 * of a request whose answer was lost builds the same trigger, and one already in the job's log (or claimed there by
 * another tab replaying the same request) is not started again. A save it cannot confirm is flagged in the job's log.
 */
async function customerMessage(body){
  const [action,event]=LIFECYCLE[body.action],hooks=window.EGCCustomerCommunication;
  if(typeof hooks?.sync!=='function'||typeof hooks.read!=='function')return 'Saved · '+UNTRIGGERED;
  const job=await savedJob(hooks,body);
  if(!job){let flagged=false;try{flagged=typeof hooks.missed==='function'&&await within(hooks.missed(body.jobId,event,body.requestId),FLAG_WAIT,false)===true;}catch{}try{if(flagged)hooks.render?.();}catch{}return 'Saved · '+(flagged?FLAGGED:UNTRIGGERED);}
  const marker=`${action}:${job.moneyUpdatedAt}`,key=`communication:${job.id}:${event}:${marker}`;
  let logged=(Array.isArray(job.communicationLog)?job.communicationLog:[]).find(entry=>entry?.id===key)||null;
  // The suite claims it in one transaction, so a duplicated tab replaying this request cannot start it a second time.
  if((!logged||logged.status==='pending')&&typeof hooks.claim==='function'){try{logged=await hooks.claim(job.id,event,marker);}catch{}}
  if(logged?.status==='pending')return 'Saved · customer message already started in another tab';
  let sent=logged?.status==='triggered';
  if(!logged){try{sent=await hooks.sync(job,event,marker);}catch{sent=false;}try{hooks.render?.();}catch{}}
  return job.notify===false?'Saved · customer automation suppressed':sent?(action==='accept'?'Approval saved · '+(hooks.portalLabel?.(job.id,job)||'Portal delivery pending'):'Saved · HighLevel automation triggered'):'Saved · customer message needs retry';
}
/** The saved job once a read shows this save (its moneyRequestId), retried with a short backoff; null if none does. */
async function savedJob(hooks,body){
  for(let attempt=0;;attempt++){
    let job=null;try{job=await hooks.read(body.jobId);}catch{}
    if(job?.id===body.jobId&&job.moneyRequestId===body.requestId&&typeof job.moneyUpdatedAt==='string'&&job.moneyUpdatedAt)return job;
    if(attempt>=READBACK.length)return null;
    await wait(READBACK[attempt]);
  }
}
function finish(message,result){
  if(message)toast(message);
  window.dispatchEvent(new CustomEvent('egc:money-saved',{detail:{jobId:S.id,action:result?.action||null,revision:result?.job?.revision||null}}));
  close(true);
}
// The owner turned MONEY_API_ENABLED off while this page was open: remember it,
// drop this job's unconfirmable request and open today's tool for the same action.
function handOver(viewer,message){
  const id=S.id,action=S.action;
  clearPending(viewer,id);setFlag(false);close(true);toast(message);
  if(legacy)return legacy(id,action);
}
function discardPending(){if(S.busy||!S.pending)return;clearPending(S.pending.viewer,S.pending.body.jobId);S.pending=null;S.error='';S.errorKind='';S.draft=freshDraft();render();}
async function reloadLatest(){if(S.busy)return;await load();}
function switchView(view){if(S.busy)return;S.view=view;S.error='';S.errorKind='';S.draft=freshDraft();render();focusFirst();}
function voidChange(id){if(S.busy)return;S.view='change';S.error='';S.errorKind='';S.draft={changeOrderId:id,reason:''};render();focusFirst();}

const TITLES={estimate:['CUSTOMER ESTIMATE','Estimate'],accept:['CUSTOMER APPROVAL','Record approval'],deposit:['OFFLINE DEPOSIT','Record a deposit'],payment:['OFFLINE PAYMENT','Record a payment'],invoice:['CUSTOMER INVOICE','Invoice'],sent:['CUSTOMER ESTIMATE','Record that the estimate was sent'],void:['VOID INVOICE','Void invoice'],change:['APPROVED CHANGE','Void approved change']};
function field(label,input,help){const id=input.id||'em-'+input.name;input.id=id;if(help)input.setAttribute('aria-describedby',id+'-help');return h('div',{class:'em-field'},h('label',{htmlFor:id},label),input,help?h('small',{id:id+'-help'},help):null);}
function bind(name,{tag='input',after,...props}={}){const d=S.draft;return h(tag,{name,...props,value:d[name]??'',oninput:e=>{d[name]=e.target.value;if(after)after();},onchange:e=>{d[name]=e.target.value;}});}
function select(name,options){const d=S.draft,node=h('select',{name,onchange:e=>{d[name]=e.target.value;}},options.map(([value,label])=>h('option',{value},label)));node.value=d[name];return node;}
function summary(){
  const job=S.job,t=job.totals,rows=[['Total',money(t.totalCents)],['Paid',money(t.appliedCents)],['Balance',money(t.balanceCents)]];
  if(t.depositDueCents>0&&t.purpose==='deposit')rows.push(['Deposit due',money(t.depositDueCents)]);
  const status=[job.estimate?`${job.estimate.number||'Estimate'} · ${job.estimate.status}${job.estimate.revision?' · rev '+job.estimate.revision:''}`:'No estimate yet',job.approval?.status?'Approval: '+job.approval.status:'',job.invoice.status!=='not_issued'?`Invoice ${job.invoice.number||''} · ${job.invoice.status.replace('_',' ')}`:''].filter(Boolean);
  return h('section',{class:'em-summary','aria-label':'Job money'},h('p',{class:'em-customer'},job.customer||'Customer'),h('dl',{},rows.map(([label,value])=>h('div',{},h('dt',{},label),h('dd',{},value)))),h('p',{class:'em-muted'},status.join(' · ')),t.complete===false?h('p',{class:'em-notice warn'},'Some saved money on this job needs review. Figures that could not be read show “Needs review”.'):null);
}
const note=text=>h('p',{class:'em-note'},text);
const automation=event=>S.job.notify===false?'Customer notifications are off for this job, so saving starts no HighLevel automation.':`Saving starts the HighLevel ${event} automation, as the standard finance tools do.`;
function estimateView(){
  const d=S.draft,job=S.job,closed=['approved'].includes(job.approval?.status)||['accepted','approved'].includes(job.estimate?.status);
  if(job.estimate&&lockedEstimate(job))return[h('p',{class:'em-notice warn'},'This estimate has customer options, discounts or lines that need review. This editor changes fixed lines only, so it will not reprice it. Edit it from the walkthrough game plan.'),job.estimate&&!closed?h('button',{type:'button',class:'em-button',onclick:()=>switchView('sent')},'Record that it was sent'):null];
  const totalNode=h('output',{class:'em-total','aria-live':'polite'}),depositInput=bind('deposit',{inputMode:'decimal',autocomplete:'off',after:()=>{d.depositTouched=true;refreshTotals();}});
  function refreshTotals(){const total=estimateTotal();if(!d.depositTouched&&total!==null){d.deposit=dollars(Math.round(total/2));depositInput.value=d.deposit;}totalNode.textContent=total===null?'Check each line price and quantity':`Estimate total ${money(total)} · deposit ${money(cents(d.deposit))}`;for(const [index,line] of d.lines.entries()){const out=list.querySelector(`[data-line-total="${index}"]`);if(out){const value=lineTotal(line);out.textContent=value!==null?money(value):cents(line.unit)!==null&&quantity(line.quantity)!==null?'Price × quantity must come to whole cents':'Enter a price and a quantity';}}}
  const list=h('div',{class:'em-lines'});
  function lineCard(line,index){
    const input=(name,label,{tag='input',...props}={})=>field(label,h(tag,{name:`${name}-${index}`,...props,value:line[name],oninput:e=>{line[name]=e.target.value;refreshTotals();}}));
    const kind=h('select',{name:`kind-${index}`,id:`em-kind-${index}`,onchange:e=>{line.kind=e.target.value;}},KINDS.map(([value,label])=>h('option',{value},label)));kind.value=line.kind;
    return h('fieldset',{class:'em-line'},h('legend',{},`Line ${index+1}`),
      input('name','Name',{maxLength:160,autocomplete:'off',required:true}),
      h('div',{class:'em-line-grid'},field('Type',kind),input('quantity','Qty',{inputMode:'decimal',autocomplete:'off'}),input('unit','Unit price ($)',{inputMode:'decimal',autocomplete:'off'})),
      input('description','Description (optional)',{tag:'textarea',rows:2,maxLength:600}),
      h('div',{class:'em-line-foot'},h('output',{'data-line-total':String(index)}),h('button',{type:'button',class:'em-button danger',disabled:d.lines.length<2,onclick:()=>{d.lines.splice(index,1);render();}},'Remove line')));
  }
  list.append(...d.lines.map(lineCard));
  queueMicrotask(refreshTotals);
  return[
    closed?h('p',{class:'em-notice warn'},'The customer approved this estimate. Changing the price, deposit or scope cancels that approval, and the customer must approve again.'):null,
    list,
    h('button',{type:'button',class:'em-button',disabled:d.lines.length>=MAX_LINES,onclick:()=>{d.lines.push({id:newId(),kind:'service',name:'',description:'',quantity:'1',unit:''});render();S.dialog?.querySelector(`[name="name-${d.lines.length-1}"]`)?.focus();}},d.lines.length>=MAX_LINES?`Up to ${MAX_LINES} lines`:'Add line'),
    field('Customer-facing scope',bind('scope',{tag:'textarea',rows:4,maxLength:1600,required:true}),'What is included in this price. The customer sees this text.'),
    h('div',{class:'em-pair'},field('Deposit required ($)',depositInput,'50% of the total unless you change it.'),field('Estimate valid through',bind('validUntil',{type:'date',min:today(),required:true}))),
    totalNode,
    note(automation('estimate-ready')),
    job.estimate&&!closed?h('button',{type:'button',class:'em-button',onclick:()=>switchView('sent')},'Record that it was sent'):null,
  ];
}
function acceptView(){
  const job=S.job;
  if(!job.estimate||!(job.totals.quoteCents>0))return[h('p',{class:'em-notice warn'},'Save a priced estimate before recording an approval.')];
  if(job.approval?.status==='approved'||['accepted','approved'].includes(job.estimate.status))return[h('p',{class:'em-notice'},`Approved by ${job.approval?.approvedBy||job.estimate.acceptedBy||'the customer'}. Save an estimate revision first if the customer is approving a change.`)];
  return[h('p',{},`${job.estimate.number||'Estimate'}${job.estimate.revision?' · revision '+job.estimate.revision:''} · ${money(job.totals.quoteCents)}`),field('Approved by',bind('approvedBy',{maxLength:120,autocomplete:'name',required:true}),'The person who approved this estimate.'),note('Records an approval the customer already gave you in person, by phone or in writing. '+automation('estimate-approved'))];
}
function paymentView(){
  const job=S.job,t=job.totals,deposit=S.view==='deposit';
  if(!(t.totalCents>0))return[h('p',{class:'em-notice warn'},'Save a priced estimate before recording money.')];
  if(t.balanceCents===0)return[h('p',{class:'em-notice'},'This job has no balance due.')];
  return[h('p',{},deposit?`Deposit due ${money(t.depositDueCents)} of ${money(t.depositRequiredCents)} · balance ${money(t.balanceCents)}`:`Balance due ${money(t.balanceCents)}`),
    field('Amount received ($)',bind('amount',{inputMode:'decimal',autocomplete:'off',required:true})),
    field('How it was received',select('method',METHODS)),
    field('Receipt, check or transaction reference',bind('reference',{maxLength:160,autocomplete:'off',required:true}),'Needed to verify and reconcile this payment.'),
    job.ledger?.complete===false?h('p',{class:'em-notice warn'},'Older payment records on this job need review. New money is still recorded exactly.'):null,
    note('Records money already received. It never charges a card. '+automation(deposit?'deposit-received':'payment-received'))];
}
function invoiceView(){
  const job=S.job,t=job.totals,invoice=job.invoice,active=ACTIVE_INVOICE.has(invoice.status),preview=job.invoicePreview;
  if(!(t.totalCents>0))return[h('p',{class:'em-notice warn'},'Save a priced estimate before issuing an invoice.')];
  // The server's own invoice lines: included estimate lines, approved change orders, or one line for the quote.
  return[
    active?h('p',{class:'em-notice'},`Invoice ${invoice.number||''} is ${invoice.status.replace('_',' ')}${invoice.dueDate?' · due '+invoice.dueDate:''}. Saving updates it.`):null,
    preview&&Array.isArray(preview.lineItems)?[
      h('ul',{class:'em-preview','aria-label':'Invoice lines'},preview.lineItems.map(line=>h('li',{},h('span',{},`${line.name}${line.quantity!==1?' × '+line.quantity:''}`),h('b',{},money(line.totalCents))))),
      h('p',{class:'em-preview-total'},h('span',{},'Invoice total'),h('b',{},money(preview.totalCents))),
      h('p',{class:'em-muted'},`Paid ${money(t.appliedCents)} · balance ${money(t.balanceCents)}`),
      (preview.notices||[]).map(text=>h('p',{class:'em-notice warn'},text)),
    ]:h('p',{class:'em-notice warn'},'The invoice lines could not be previewed. Review the job money before issuing.'),
    h('div',{class:'em-pair'},field('Payment due date',bind('dueDate',{type:'date',min:today(),required:true})),field('PO / customer reference',bind('customerReference',{maxLength:120,autocomplete:'off'}),'Optional')),
    note(automation('invoice-issued')+' The invoice shows in the customer portal with its balance.'),
    active&&invoice.status!=='paid'?h('button',{type:'button',class:'em-button danger',onclick:()=>switchView('void')},'Void this invoice…'):null,
    changeList(),
  ];
}
// Changes the customer approved in the portal that are billed on top of the quote.
function changeList(){
  const changes=Array.isArray(S.job.changeOrders)?S.job.changeOrders:[];
  if(!changes.length)return null;
  return[h('p',{class:'em-muted'},'Approved changes billed to the customer on top of the quote'),changes.map(line=>h('div',{class:'em-line'},h('p',{},h('b',{},money(line.totalCents)),' · ',line.name),h('p',{class:'em-muted'},`Approved by ${line.approvedBy||'the customer'} in the portal${line.backfilled?' (billed later)':''}`),h('div',{class:'em-line-foot'},h('button',{type:'button',class:'em-button danger',onclick:()=>voidChange(line.id)},'Void this change…'))))];
}
function changeView(){
  const line=(Array.isArray(S.job.changeOrders)?S.job.changeOrders:[]).find(item=>item.id===S.draft.changeOrderId);
  if(!line)return[h('p',{class:'em-notice warn'},'This change is no longer billed on the job.')];
  return[h('p',{},`Void “${line.name}” (${money(line.totalCents)})${line.approvedBy?', approved by '+line.approvedBy:''}. The customer is no longer charged for it, and an issued invoice drops to the new total.`),field('Reason',bind('reason',{tag:'textarea',rows:3,maxLength:500,required:true}),'Kept in the audit trail.'),note('Nothing is sent to the customer. Money already paid for this change stays recorded; refund it separately.')];
}
function sentView(){return[field('How it was sent',select('channel',CHANNELS)),field('Note (optional)',bind('note',{tag:'textarea',rows:3,maxLength:500})),note('Records that you already sent the estimate yourself. Nothing is sent from here.')];}
function voidView(){const invoice=S.job.invoice;return[h('p',{},`Void invoice ${invoice.number||''} (${invoice.status.replace('_',' ')}). Recorded payments stay on the job.`),field('Reason',bind('reason',{tag:'textarea',rows:3,maxLength:500,required:true}),'Kept in the audit trail.'),note('Nothing is sent to the customer.')];}
const VIEWS={estimate:estimateView,accept:acceptView,deposit:paymentView,payment:paymentView,invoice:invoiceView,sent:sentView,void:voidView,change:changeView};
const LABELS={estimate:'Save estimate',accept:'Record approval',deposit:'Save deposit',payment:'Save payment',invoice:'Issue invoice',sent:'Record sent',void:'Void invoice',change:'Void change'};
function canSubmit(){const job=S.job;if(!job)return false;if(S.view==='estimate')return!(job.estimate&&lockedEstimate(job));if(S.view==='accept')return Boolean(job.estimate)&&job.totals.quoteCents>0&&job.approval?.status!=='approved'&&!['accepted','approved'].includes(job.estimate.status);if(S.view==='deposit'||S.view==='payment')return job.totals.totalCents>0&&job.totals.balanceCents>0;if(S.view==='invoice')return job.totals.totalCents>0;if(S.view==='change')return(Array.isArray(job.changeOrders)?job.changeOrders:[]).some(line=>line.id===S.draft?.changeOrderId);return true;}

function render(){
  const dialog=S.dialog;if(!dialog)return;
  const [kicker,title]=TITLES[S.view]||TITLES.estimate,job=S.job;
  const head=h('header',{class:'em-head'},h('div',{},h('p',{class:'em-kicker'},kicker),h('h2',{id:'em-title'},job?.customer?`${title} · ${job.customer}`:title)),h('button',{type:'button',class:'em-close','aria-label':'Close',disabled:S.busy,onclick:()=>close()},'×'));
  const main=h('div',{class:'em-body'}),actions=h('div',{class:'em-actions'}),status=h('p',{class:'em-status','aria-live':'polite'}),fill=(node,...kids)=>node.append(...kids.flat(Infinity).filter(kid=>kid!=null&&kid!==false));
  if(S.loading&&!job){main.append(h('div',{class:'em-skeleton','aria-hidden':'true'},h('span',{}),h('span',{}),h('span',{})));status.textContent='Loading job money…';}
  else if(!job){main.append(h('p',{class:'em-notice error',role:'alert'},S.error||'Job money is unavailable.'));actions.append(h('button',{type:'button',class:'em-button',onclick:()=>close()},'Close'),h('button',{type:'button',class:'em-button primary',onclick:()=>void load()},'Retry'));}
  else if(S.pending){
    const action=SAVED[S.pending.body.action]||'A money change';
    fill(main,summary(),h('p',{class:'em-notice warn',role:'alert'},`${action.replace(/ (saved|recorded|issued|voided|marked as sent)$/,'')} save from ${new Date(S.pending.savedAt).toLocaleString('en-US',{timeZone:TZ,dateStyle:'medium',timeStyle:'short'})} was not confirmed. Retry it unchanged so it is never saved twice.`),S.error&&S.errorKind!=='pending'?h('p',{class:'em-notice error',role:'alert'},S.error):null);
    actions.append(h('button',{type:'button',class:'em-button danger',disabled:S.busy,onclick:discardPending},'Discard it'),h('button',{type:'button',class:'em-button primary',disabled:S.busy,onclick:()=>void send()},S.busy?'Retrying…':'Retry original save'));
    if(S.busy)status.textContent='Retrying the original save…';
  } else {
    fill(main,summary(),S.error?h('p',{class:'em-notice error',role:'alert',tabIndex:-1},S.error):null,VIEWS[S.view]());
    if(S.errorKind==='conflict')actions.append(h('button',{type:'button',class:'em-button',disabled:S.busy,onclick:()=>void reloadLatest()},'Load latest details'));
    if(['sent','void','change'].includes(S.view))actions.append(h('button',{type:'button',class:'em-button',disabled:S.busy,onclick:()=>switchView(S.view==='sent'?'estimate':'invoice')},'Back'));
    else actions.append(h('button',{type:'button',class:'em-button',disabled:S.busy,onclick:()=>close()},'Cancel'));
    if(canSubmit())actions.append(h('button',{type:'submit',class:'em-button primary'+(['void','change'].includes(S.view)?' danger':''),disabled:S.busy||S.loading},S.busy?'Saving…':LABELS[S.view]));
    if(S.busy)status.textContent='Saving…';else if(S.loading)status.textContent='Refreshing job money…';
  }
  const form=h('form',{class:'em-sheet',noValidate:true,'aria-busy':S.busy||S.loading?'true':'false',onsubmit:e=>{e.preventDefault();void submit();}},head,main,h('footer',{class:'em-foot'},status,actions));
  if(S.busy)for(const el of form.querySelectorAll('input,select,textarea'))el.disabled=true;
  dialog.replaceChildren(form);
}
function focusFirst(){S.dialog?.querySelector('.em-body input:not([disabled]),.em-body select:not([disabled]),.em-body textarea:not([disabled]),.em-foot .primary')?.focus();}
function focusError(){S.dialog?.querySelector('.em-notice.error')?.focus?.();}
function beforeUnload(event){if(S.busy){event.preventDefault();event.returnValue='';}}

function open(id,action){
  if(S.dialog){if(S.busy)return;close(true);}
  S.opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  Object.assign(S,{id:String(id||''),action,view:action,job:null,viewer:'',draft:null,pending:null,error:'',errorKind:'',busy:false});
  const dialog=h('dialog',{class:'egc-money','aria-labelledby':'em-title',oncancel:e=>{e.preventDefault();close();},onclose:()=>{if(S.dialog===dialog)close(true);}});
  S.dialog=dialog;document.body.append(dialog);
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  window.addEventListener('beforeunload',beforeUnload);
  return load();
}
function close(force=false){
  if(!S.dialog||(!force&&S.busy))return;
  const dialog=S.dialog;S.dialog=null;S.generation++;
  window.removeEventListener('beforeunload',beforeUnload);
  if(dialog.open)dialog.close();dialog.remove();
  Object.assign(S,{job:null,draft:null,pending:null,busy:false,loading:false,error:'',errorKind:''});
  if(S.opener?.isConnected)S.opener.focus();S.opener=null;
}

window.opsFinanceAction=async(id,action)=>{
  if(!HANDLED.has(action))return legacy?legacy(id,action):undefined;
  const on=await enabled();
  if(on===null)return;
  if(on==='unknown'){toast('Finance settings could not be checked. Retry.');return;}
  if(!on)return legacy?legacy(id,action):undefined;
  return open(id,action);
};
window.addEventListener('egc:signout',()=>{close(true);clearAllPending();S.flagRequest=null;if(window.EGC_FLAGS)delete window.EGC_FLAGS.moneyApi;});
window.EGCMoneyActions={open,close:()=>close(),enabled,canLeave:()=>!S.busy,legacy:()=>legacy};
})();
