/* Server customer actions (FUN-36). When CUSTOMER_LIFECYCLE_API_ENABLED is on
 * (surfaced as window.EGC_FLAGS.lifecycleApi by /api/integration-status), the
 * Hub's Issue gift credit, Send decision / Ask customer and Review rebooking
 * buttons save through /api/customer-lifecycle with a request ID, revision
 * check, receipt, audit entry and funnel event: classed credits, gift-card
 * sales (cash plus a wallet credit), decision prompts on the server clock and
 * rebooking follow-ups. Otherwise the existing browser tools run unchanged. The
 * last flag value read is kept per viewer for this tab, so a failed check never
 * silently falls back to the browser tools once the server path was on.
 * Nothing here sends anything to a customer: after a decision is saved the
 * manager is offered the Hub's own "Decision needed" trigger, which asks for
 * its own confirmation and is keyed by the decision's id. */
(function () {
'use strict';
const TZ='America/Denver', PREFIX='egc.lifecycle.pending.v1.', FLAG_PREFIX='egc.lifecycle.flag.v1.';
const RETRY_STATUS=new Set([401,403,408,429]);
const legacy={credit:typeof window.opsIssueCustomerCredit==='function'?window.opsIssueCustomerCredit:null,decision:typeof window.opsSendCustomerDecision==='function'?window.opsSendCustomerDecision:null,rebook:typeof window.opsReviewRebooking==='function'?window.opsReviewRebooking:null};
const CLASSES=[['garage_guard','Garage Guard credit (unused visit)'],['referral','Referral reward'],['courtesy','Courtesy credit'],['gift_purchase','Gift card sold before the Hub']];
const CLASS_LABEL={gift_purchase:'Gift card',garage_guard:'Garage Guard',referral:'Referral',courtesy:'Courtesy',unknown:'Older credit'};
const METHODS=[['cash','Cash'],['check','Check'],['card_terminal','Card terminal'],['stripe_link','Stripe payment link'],['bank_transfer','Bank transfer / ACH'],['other','Other']];
const KIND_LABEL={repeat:'repeat service',touch_up:'touch-up',garage_guard:'Garage Guard visit'};
const S={dialog:null,opener:null,generation:0,flagRequest:null,busy:false,loading:false,id:'',view:'',data:null,viewer:'',draft:null,pending:null,error:'',errorKind:''};
const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value]of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else if(name in node&&!name.startsWith('aria-')&&!name.startsWith('data-'))node[name]=value;else node.setAttribute(name,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const money=cents=>Number.isSafeInteger(cents)?usd.format(cents/100):'Needs review';
/** Dollars typed by a person as whole cents, or null. */
function cents(text){const value=String(text??'').trim().replace(/^\$/,'').replace(/,/g,'');const m=/^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(value);return m?Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')):null;}
function minutes(text){const value=String(text??'').trim();return /^\d{1,4}$/.test(value)?Number(value):null;}
const when=value=>{const date=new Date(value);return value&&!Number.isNaN(date.getTime())?date.toLocaleString('en-US',{timeZone:TZ,dateStyle:'medium',timeStyle:'short'}):'';};
// Denver calendar days, never the device's (the hubLocalInstant algorithm).
const parts=at=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));
function today(){const p=parts(Date.now());return`${p.year}-${p.month}-${p.day}`;}
function validDay(date){if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const [y,m,d]=date.split('-').map(Number),stamp=Date.UTC(y,m-1,d,12);return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===date;}
const addDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
function localToIso(date,time){
  if(!validDay(date)||!/^\d{2}:\d{2}$/.test(String(time||'')))return null;
  const [y,m,d]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number),wall=Date.UTC(y,m-1,d,hour,minute);
  if(new Date(wall).toISOString().slice(0,16)!==`${date}T${time}`)return null;
  const offsets=new Set([-86400000,0,86400000].map(delta=>{const p=parts(wall+delta);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-(wall+delta);}));
  const matches=[...offsets].map(offset=>wall-offset).filter(ts=>{const p=parts(ts);return`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===`${date}T${time}`;});
  return matches.length===1?new Date(matches[0]).toISOString():null;
}
const storageKey=(viewer,id,view)=>PREFIX+viewer+':'+id+':'+view;
function readPending(viewer,id,view){try{const saved=JSON.parse(sessionStorage.getItem(storageKey(viewer,id,view))||'null');return saved&&saved.viewer===viewer&&saved.view===view&&saved.body?.jobId===id&&typeof saved.body.requestId==='string'?saved:null;}catch{return null;}}
function writePending(pending){try{sessionStorage.setItem(storageKey(pending.viewer,pending.body.jobId,pending.view),JSON.stringify(pending));}catch{/* Storage may be disabled; the request stays in memory for this dialog. */}}
function clearPending(pending){try{sessionStorage.removeItem(storageKey(pending.viewer,pending.body.jobId,pending.view));}catch{}}
function clearAllPending(){try{for(const key of Object.keys(sessionStorage))if(key.startsWith(PREFIX)||key.startsWith(FLAG_PREFIX))sessionStorage.removeItem(key);}catch{}}
function flagKey(){try{return FLAG_PREFIX+String(window.EGCHubAuth?.profile?.().user||sessionStorage.getItem('egc_u')||localStorage.getItem('egc_u')||'').trim().toLowerCase();}catch{return FLAG_PREFIX;}}
function lastFlag(){try{return sessionStorage.getItem(flagKey());}catch{return null;}}
function setFlag(value){window.EGC_FLAGS={...(window.EGC_FLAGS||{}),lifecycleApi:value};try{sessionStorage.setItem(flagKey(),String(value));}catch{}}
function toast(message){if(typeof window.showToast==='function')window.showToast(message);}

async function call(url,init={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  const run=typeof window.hubFetch==='function'?window.hubFetch:(input,options)=>fetch(input,{...options,credentials:'same-origin'});
  let response;
  try{response=await run(url,{...init,cache:'no-store',signal:controller.signal});}
  catch(error){if(error?.code==='HUB_AUTH_REQUIRED')throw Object.assign(new Error('Sign in again, then retry.'),{status:401,code:error.code});throw Object.assign(new Error(error?.name==='AbortError'?'The server did not answer in time.':'The connection was interrupted.'),{status:0,code:'lifecycle_network'});}
  finally{clearTimeout(timer);}
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data||data.ok!==true)throw Object.assign(new Error(data?.error||'The customer details could not be verified. Retry.'),{status:response.ok?503:response.status,code:data?.code||'lifecycle_unverified',details:data?.details});
  return data;
}

/** true when the server says these customer actions go through /api/customer-lifecycle; null when signed out; 'unknown' when it could not be read after it was last on. */
async function enabled(){
  const flags=window.EGC_FLAGS;
  if(flags&&typeof flags.lifecycleApi==='boolean')return flags.lifecycleApi;
  S.flagRequest ||= (async()=>{
    try{const data=await call('/api/integration-status');const value=data.flags?.lifecycleApi===true;setFlag(value);return value;}
    // An unreadable setting keeps today's tools only if the last one read here was off; the next click checks again.
    catch(error){return error.status===401?null:lastFlag()==='true'?'unknown':false;}
    finally{S.flagRequest=null;}
  })();
  return S.flagRequest;
}

function validData(data,id){const job=data?.job,account=data?.account;return Boolean(job&&job.id===id&&typeof job.revision==='string'&&job.revision&&Array.isArray(job.decisions)&&Array.isArray(job.rebooking)&&(account===null||account&&typeof account.id==='string'&&typeof account.revision==='string'&&account.revision&&Array.isArray(account.credits))&&typeof data.viewer?.id==='string'&&data.viewer.id&&data.limits&&Number.isSafeInteger(data.limits.courtesyOwnerLimitCents)&&Number.isSafeInteger(data.limits.prepaidOwnerLimitCents));}
async function load(){
  const generation=++S.generation;S.loading=true;S.error='';S.errorKind='';render();
  try{
    const data=await call('/api/customer-lifecycle?'+new URLSearchParams({jobId:S.id}));
    if(generation!==S.generation)return;
    if(!validData(data,S.id))throw Object.assign(new Error('The customer details were incomplete. Retry.'),{status:503});
    if(data.enabled===false){handOver(data.viewer.id,'Server customer actions are turned off. Opening the standard customer tools.');return;}
    S.data=data;S.viewer=data.viewer.id;S.pending=readPending(S.viewer,S.id,S.view);
    if(!S.draft)S.draft=freshDraft();
  }catch(error){if(generation!==S.generation)return;S.data=null;S.error=error.status===404?'This job is not available for customer credits or requests.':error.message;S.errorKind='load';}
  finally{if(generation===S.generation){S.loading=false;render();focusFirst();}}
}

const pendingRequests=()=>S.data.job.rebooking.filter(item=>item.status==='pending');
function freshDraft(){
  if(S.view==='decision')return{title:'',details:'',price:'0.00',minutes:'0',photoUrl:''};
  if(S.view==='rebook'){const waiting=pendingRequests();return{requestId:waiting.length?waiting[waiting.length-1].id:'',note:''};}
  // No default credit type: a manager chooses one, so a courtesy credit is never recorded as payment-class by accident.
  return{mode:'credit',creditClass:'',amount:'',label:'EGC service credit',reason:'',reference:'',method:'check',received:today()};
}
/** True when the open form holds entries a fresh form would not (switching to a sale alone is not an entry). */
function dirty(){const d=S.draft;if(!d||!S.data)return false;const base={...freshDraft(),...(d.mode==='sale'?{mode:'sale',label:'EGC gift card'}:{})};return Object.keys({...base,...d}).some(key=>String(d[key]??'')!==String(base[key]??''));}
function switchMode(mode){if(S.busy||S.draft.mode===mode)return;S.draft={...S.draft,mode,label:mode==='sale'?'EGC gift card':'EGC service credit',reference:''};S.error='';S.errorKind='';render();focusFirst();}

function body(){
  const d=S.draft,data=S.data,base={requestId:crypto.randomUUID(),jobId:data.job.id,actorId:S.viewer};
  const problem=message=>{throw Object.assign(new Error(message),{kind:'input'});};
  if(S.view==='credit'){
    const account=data.account;if(!account)problem(data.accountIssue?.error||'This customer account needs review before its credits can change.');
    // Only a type the form offered this viewer counts as chosen (the list depends on owner and Garage Guard membership).
    if(d.mode!=='sale'&&!classChoices().some(([value])=>value===d.creditClass))problem('Choose a credit type.');
    const amount=cents(d.amount);if(!(amount>0))problem('Enter the amount in dollars and cents.');
    if(d.label.trim().length<2)problem('Enter the label the customer sees.');
    const wallet={...base,accountId:account.id,expectedRevision:account.revision,amountCents:amount,label:d.label.trim()};
    if(d.mode==='sale'){
      if(!methodChoices().some(([value])=>value===d.method))problem('Choose how the gift card was paid for.');
      if(d.reference.trim().length<2)problem('Enter a receipt, check or transaction reference.');
      const day=today(),received=String(d.received||'').trim();
      if(!validDay(received)||received>day||received<addDays(day,-365))problem('Choose the date the money was received: today or a day in the last year.');
      const limit=ownerLimit('sale');if(overLimit(limit,amount))problem(limitText(limit,true));
      // Today is stamped by the server clock; an earlier day is noon in Denver on that day.
      const receivedAt=received===day?null:localToIso(received,'12:00');
      if(received!==day&&!receivedAt)problem('Choose the date the money was received.');
      return{action:'gift_card.sell',...wallet,method:d.method,reference:d.reference.trim(),...(receivedAt?{receivedAt}:{})};
    }
    if(d.reason.trim().length<3)problem('Enter why this credit is being issued.');
    if(d.creditClass==='gift_purchase'&&d.reference.trim().length<2)problem('Enter the original gift-card sale receipt or reference.');
    const limit=ownerLimit(d.creditClass);
    if(overLimit(limit,amount))problem(limitText(limit,true));
    return{action:'credit.issue',...wallet,creditClass:d.creditClass,reason:d.reason.trim(),...(d.reference.trim()?{reference:d.reference.trim()}:{})};
  }
  const job={...base,expectedRevision:data.job.revision};
  if(S.view==='decision'){
    if(d.title.trim().length<3)problem('Describe the decision the customer needs to make.');
    if(d.details.trim().length<3)problem('Explain what the crew found.');
    const price=cents(d.price),time=minutes(d.minutes);
    if(price===null)problem('Enter the additional price in dollars and cents (0 for none).');
    if(time===null||time>data.limits.maxTimeDeltaMinutes)problem(`Enter the additional minutes as a whole number up to ${data.limits.maxTimeDeltaMinutes}.`);
    const photo=d.photoUrl.trim();if(photo&&!/^https:\/\/(?:drive|docs)\.google\.com\//i.test(photo))problem('The photo link must be a Google Drive or Google Docs link.');
    return{action:'decision.prompt',...job,title:d.title.trim(),details:d.details.trim(),priceDeltaCents:price,timeDeltaMinutes:time,...(photo?{photoUrl:photo}:{})};
  }
  if(!d.requestId)problem('Choose the rebooking request.');
  if(d.note.trim().length<2)problem('Enter the confirmation or scheduling note.');
  return{action:'rebook.mark_contacted',...job,rebookingRequestId:d.requestId,note:d.note.trim()};
}

async function submit(){
  if(S.busy||!S.data)return;
  if(S.pending){S.error='Retry or discard the earlier unconfirmed save first.';S.errorKind='pending';render();return;}
  let request;
  try{request=body();}catch(error){S.error=error.message;S.errorKind='input';render();focusError();return;}
  S.pending={viewer:S.viewer,view:S.view,body:request,savedAt:new Date().toISOString()};writePending(S.pending);
  await send();
}
/** Credit types this viewer may issue: a pre-Hub gift card is owner-only, and a manager's Garage Guard credit needs an active Stripe membership with unused visits (the server's eligible flag). */
function classChoices(){const data=S.data,member=data.account?.garageGuard?.eligible===true;return data.viewer.owner?CLASSES:CLASSES.filter(([value])=>value!=='gift_purchase'&&(value!=='garage_guard'||member));}
/** 'Other' carries no payment evidence, so only the owner records a sale paid that way. */
function methodChoices(){return S.data.viewer.owner?METHODS:METHODS.filter(([value])=>value!=='other');}
/**
 * The owner limit for a credit class or a sale ('sale'), with what managers
 * already issued to this customer in the same group over the window (null
 * when unknown), or null when there is none (a pre-Hub gift card is owner-only anyway).
 */
function ownerLimit(kind){
  const limits=S.data.limits,issued=S.data.account?.managerIssued||null,used=value=>Number.isSafeInteger(value)?value:null;
  if(kind==='courtesy'||kind==='referral')return{what:'Courtesy and referral credits',counts:'courtesy or referral credit a manager gave',ask:'issue this credit',cents:limits.courtesyOwnerLimitCents,used:used(issued?.contraCents)};
  if(kind==='garage_guard'||kind==='sale')return{what:kind==='sale'?'Gift-card sales':'Garage Guard credits',counts:'Garage Guard credit or gift-card sale a manager recorded for',ask:kind==='sale'?'record this sale':'issue this credit',cents:limits.prepaidOwnerLimitCents,used:used(issued?.prepaidCents)};
  return null;
}
const windowDays=()=>Number.isSafeInteger(S.data.limits.managerLimitDays)?S.data.limits.managerLimitDays:30;
function overLimit(limit,amount){return Boolean(limit)&&!S.data.viewer.owner&&(amount>limit.cents||limit.used!==null&&limit.used+amount>limit.cents);}
function limitText(limit,refused){return`${limit.what} over ${money(limit.cents)} need the owner.`+(limit.used===null?'':` That limit counts every ${limit.counts} this customer in the last ${windowDays()} days: ${money(limit.used)} so far.`)+(refused?` Ask the owner to ${limit.ask}.`:'');}
function saved(result,request){
  const r=result.result||{};
  if(request.action==='gift_card.sell')return`Gift card recorded: ${money(r.amountCents)} received and added to the customer wallet · nothing was sent to the customer`;
  if(request.action==='credit.issue')return`${money(r.amountCents)} ${CLASS_LABEL[r.creditClass]||''} credit added to the customer wallet · nothing was sent to the customer`.replace('  ',' ');
  if(request.action==='decision.prompt')return'Decision saved in the customer portal';
  return'Rebooking request marked contacted · schedule the confirmed visit next';
}
async function send(){
  if(S.busy||!S.pending)return;
  const pending=S.pending,generation=S.generation;
  S.busy=true;S.error='';S.errorKind='';render();
  try{
    const result=await call('/api/customer-lifecycle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.body)});
    if(result.requestId!==pending.body.requestId||result.action!==pending.body.action)throw Object.assign(new Error('The saved change did not match this request. Review the customer before retrying.'),{status:503});
    clearPending(pending);
    if(generation===S.generation)S.pending=null;
    finish(saved(result,pending.body),result,pending.body);
  }catch(error){
    if(generation!==S.generation)return;
    const code=error.code||'',retry=!error.status||error.status>=500||RETRY_STATUS.has(error.status)&&code!=='lifecycle_owner_required';
    if(code==='lifecycle_api_disabled'){handOver(pending.viewer,'Server customer actions were turned off, so this was not saved here. Opening the standard customer tools; check the customer before entering it again.');return;}
    if(retry){S.error=error.message+' Your request is kept. Retry it unchanged; do not create another.';S.errorKind='retry';}
    else{
      clearPending(pending);S.pending=null;
      S.error=code==='lifecycle_revision_conflict'?'This customer changed after you opened it. Your entries are kept. Load the latest details, review them, then save again.':error.message;
      S.errorKind=code==='lifecycle_revision_conflict'?'conflict':'input';
    }
  }finally{if(generation===S.generation){S.busy=false;render();if(S.error)focusError();}}
}
function finish(message,result,request){
  const id=S.id;
  toast(message);
  window.dispatchEvent(new CustomEvent('egc:lifecycle-saved',{detail:{jobId:id,action:request.action,result:result.result||null}}));
  close(true);
  // The decision is in the portal now; telling the customer is a separate, confirmed Hub send, keyed by this decision.
  if(request.action==='decision.prompt'&&typeof window.opsTriggerCommunication==='function'){
    const decisionId=result.result?.decisionId,marker=typeof decisionId==='string'&&/^decision-[A-Za-z0-9_-]{1,120}$/.test(decisionId)?decisionId:'decision-'+request.requestId.toLowerCase();
    return window.opsTriggerCommunication(id,'decision-needed',marker);
  }
}
// The owner turned the flag off while this page was open: remember it, drop the
// unconfirmable request and open today's tool for the same action.
function handOver(viewer,message){
  const id=S.id,view=S.view;
  try{sessionStorage.removeItem(storageKey(viewer,id,view));}catch{}
  setFlag(false);close(true);toast(message);
  if(legacy[view])return legacy[view](id);
}
function discardPending(){if(S.busy||!S.pending)return;clearPending(S.pending);S.pending=null;S.error='';S.errorKind='';S.draft=freshDraft();render();}
async function reloadLatest(){if(S.busy)return;await load();}

const TITLES={credit:['CUSTOMER WALLET','Credits and gift cards'],decision:['REMOTE CUSTOMER DECISION','Ask the customer'],rebook:['REBOOKING REQUEST','Rebooking follow-up']};
function field(label,input,help){const id=input.id||'el-field-'+input.name;input.id=id;if(help)input.setAttribute('aria-describedby',id+'-help');return h('div',{class:'el-field'},h('label',{htmlFor:id},label),input,help?h('small',{id:id+'-help'},help):null);}
function bind(name,{tag='input',after,...props}={}){const d=S.draft;return h(tag,{name,...props,value:d[name]??'',oninput:e=>{d[name]=e.target.value;if(after)after();},onchange:e=>{d[name]=e.target.value;}});}
function select(name,options,after){const d=S.draft,node=h('select',{name,onchange:e=>{d[name]=e.target.value;if(after)after();}},options.map(([value,label])=>h('option',{value},label)));node.value=d[name];return node;}
const note=text=>h('p',{class:'el-note'},text);
function walletSummary(){
  const account=S.data.account;
  if(!account)return h('p',{class:'el-notice error',role:'alert'},S.data.accountIssue?.error||'This customer account needs review before its credits can change.');
  const rows=account.credits.map(card=>h('li',{},h('span',{},`${card.label} · ${CLASS_LABEL[card.creditClass]||CLASS_LABEL.unknown}`),h('b',{},`${money(card.remainingCents)} of ${money(card.issuedCents)}`)));
  return h('section',{class:'el-summary','aria-label':'Customer credits'},h('p',{class:'el-customer'},account.customer||S.data.job.customer||'Customer'),
    h('dl',{},h('div',{},h('dt',{},'Available credit'),h('dd',{},money(account.availableCents))),h('div',{},h('dt',{},'Credits'),h('dd',{},String(account.cardCount)))),
    rows.length?h('ul',{class:'el-list'},rows):h('p',{class:'el-muted'},'No credits yet.'),
    account.sameAsJob?null:h('p',{class:'el-muted'},'Credits are kept on this customer\'s account and can be used on any of their jobs.'));
}
function creditView(){
  const d=S.draft,data=S.data,account=data.account,sale=d.mode==='sale';
  const toggle=h('div',{class:'el-toggle',role:'group','aria-label':'What are you recording?'},
    h('button',{type:'button',class:'el-button'+(sale?'':' on'),'aria-pressed':sale?'false':'true',disabled:S.busy,onclick:()=>switchMode('credit')},'Issue a credit'),
    h('button',{type:'button',class:'el-button'+(sale?' on':''),'aria-pressed':sale?'true':'false',disabled:S.busy,onclick:()=>switchMode('sale')},'Sell a gift card'));
  if(!account)return[walletSummary()];
  const out=[walletSummary(),account.full?h('p',{class:'el-notice warn'},`This customer already has ${data.limits.maxCredits} credits, the most the portal can show. The Hub cannot archive used credits yet: ask the owner to have the developer archive this customer's fully used credits in the database, then try again.`):null,toggle];
  if(account.full)return out;
  if(sale){
    out.push(field('Amount received ($)',bind('amount',{inputMode:'decimal',autocomplete:'off',required:true})),
      field('How it was paid',select('method',methodChoices()),data.viewer.owner?null:'A sale paid some other way needs the owner.'),
      field('Date received',bind('received',{type:'date',max:today(),min:addDays(today(),-365),required:true}),'The day the money came in (Denver). Leave today unless it arrived earlier.'),
      field('Receipt, check or transaction reference',bind('reference',{maxLength:160,autocomplete:'off',required:true}),'Needed to reconcile the cash.'),
      field('Label the customer sees',bind('label',{maxLength:120,autocomplete:'off',required:true})),
      data.viewer.owner?null:h('p',{class:'el-notice warn'},limitText(ownerLimit('sale'),false)),
      note('Records money already received for a gift card and adds the same amount to this customer\'s wallet. It is not job revenue, it never charges a card, and nothing is sent to the customer.'));
    return out;
  }
  const refresh=()=>render();
  out.push(field('Credit type',select('creditClass',[['','Choose a credit type'],...classChoices()],refresh),data.viewer.owner||account.garageGuard?.eligible===true?null:'Garage Guard credits need an active Garage Guard membership recorded from Stripe, with unused visits, on this customer\'s account (one set with the Garage Guard status button does not count); otherwise ask the owner.'),
    field('Amount ($)',bind('amount',{inputMode:'decimal',autocomplete:'off',required:true})),
    field('Label the customer sees',bind('label',{maxLength:120,autocomplete:'off',required:true})),
    field('Reason',bind('reason',{tag:'textarea',rows:2,maxLength:300,required:true}),'Kept in the audit trail; the customer does not see it.'));
  if(d.creditClass==='gift_purchase')out.push(field('Original sale receipt or reference',bind('reference',{maxLength:160,autocomplete:'off',required:true}),'For a gift card sold before the Hub. Record new sales with “Sell a gift card”.'));
  const owned=ownerLimit(d.creditClass);
  if(owned&&!data.viewer.owner)out.push(h('p',{class:'el-notice warn'},limitText(owned,false)));
  out.push(note('The customer can apply the credit from their private portal. Nothing is sent to the customer.'));
  return out;
}
function decisionView(){
  const job=S.data.job,count=job.decisions.filter(item=>item.status==='pending').length;
  const summary=h('section',{class:'el-summary','aria-label':'Customer decisions'},h('p',{class:'el-customer'},job.customer||'Customer'),
    job.decisions.length?h('ul',{class:'el-list'},job.decisions.slice(-4).map(item=>h('li',{},h('span',{},`${item.title||'Decision'} · ${item.status}`),h('b',{},money(item.priceDeltaCents))))):h('p',{class:'el-muted'},'No decisions asked on this job yet.'),
    count?h('p',{class:'el-muted'},`${count} waiting for the customer`):null);
  if(!job.decisionsAllowed)return[summary,h('p',{class:'el-notice warn'},'Customer decisions are for open customer jobs, not walkthroughs or cancelled jobs.')];
  if(job.decisionCount>=S.data.limits.maxDecisions)return[summary,h('p',{class:'el-notice warn'},`This job already has ${S.data.limits.maxDecisions} customer decisions, the most the portal can show. The Hub cannot archive answered decisions yet: ask the owner to have the developer archive this job's answered decisions in the database, then try again.`)];
  return[summary,
    field('Decision needed',bind('title',{maxLength:180,autocomplete:'off',required:true,placeholder:'Remove the damaged cabinet?'})),
    field('What the crew found',bind('details',{tag:'textarea',rows:4,maxLength:1200,required:true})),
    h('div',{class:'el-pair'},field('Additional price ($)',bind('price',{inputMode:'decimal',autocomplete:'off'})),field('Additional minutes',bind('minutes',{inputMode:'numeric',autocomplete:'off'}))),
    field('Google Drive photo link (optional)',bind('photoUrl',{type:'url',inputMode:'url',maxLength:500,autocomplete:'off',placeholder:'https://drive.google.com/…'})),
    note('Saves the question in the customer\'s private portal with Approve and Decline buttons, timestamped by the server. Next you can choose to notify the customer through HighLevel.')];
}
function rebookView(){
  const waiting=pendingRequests(),d=S.draft;
  if(!waiting.length)return[h('p',{class:'el-notice'},'No rebooking request is waiting on this job.')];
  const describe=item=>`${KIND_LABEL[item.kind]||'visit'} · ${item.preferredDate||({asap:'next available',same_weekday:'same weekday'}[item.timing])||'next available'}${item.preferredCrew?' · same crew requested':''}`;
  const detail=item=>[item.notes?h('small',{},`“${item.notes}”`):null,item.requestedAt?h('small',{},`Requested ${when(item.requestedAt)}`):null];
  const only=waiting.length===1?waiting[0]:null;
  const choices=only?null:h('fieldset',{class:'el-choices'},h('legend',{},'Which request?'),waiting.map(item=>h('label',{class:'el-choice'},h('input',{type:'radio',name:'rebook-request',value:item.id,checked:d.requestId===item.id,onchange:()=>{d.requestId=item.id;}}),h('span',{},describe(item),detail(item)))));
  return[h('section',{class:'el-summary','aria-label':'Rebooking request'},h('p',{class:'el-customer'},S.data.job.customer||'Customer'),only?h('p',{class:'el-request'},describe(only),detail(only)):h('p',{class:'el-muted'},`${waiting.length} requests waiting`)),
    choices,
    field('Confirmation / scheduling note',bind('note',{tag:'textarea',rows:3,maxLength:400,required:true,placeholder:'Called customer; opening held for…'})),
    note('Marks the request contacted. Use Team schedule to place the confirmed visit. Nothing is sent to the customer.')];
}
const VIEWS={credit:creditView,decision:decisionView,rebook:rebookView};
function label(){if(S.view==='credit')return S.draft?.mode==='sale'?'Record gift card sale':'Issue credit';return S.view==='decision'?'Save decision':'Mark contacted';}
function canSubmit(){const data=S.data;if(!data)return false;if(S.view==='credit')return Boolean(data.account)&&!data.account.full;if(S.view==='decision')return data.job.decisionsAllowed&&data.job.decisionCount<data.limits.maxDecisions;return pendingRequests().length>0;}

function render(){
  const dialog=S.dialog;if(!dialog)return;
  const [kicker,title]=TITLES[S.view]||TITLES.credit,data=S.data,name=data?.job?.customer;
  const head=h('header',{class:'el-head'},h('div',{},h('p',{class:'el-kicker'},kicker),h('h2',{id:'el-title'},name?`${title} · ${name}`:title)),h('button',{type:'button',class:'el-close','aria-label':'Close',disabled:S.busy,onclick:()=>close()},'×'));
  const main=h('div',{class:'el-body'}),actions=h('div',{class:'el-actions'}),status=h('p',{class:'el-status','aria-live':'polite'}),fill=(node,...kids)=>node.append(...kids.flat(Infinity).filter(kid=>kid!=null&&kid!==false));
  if(S.loading&&!data){main.append(h('div',{class:'el-skeleton','aria-hidden':'true'},h('span',{}),h('span',{}),h('span',{})));status.textContent='Loading customer details…';}
  else if(!data){main.append(h('p',{class:'el-notice error',role:'alert'},S.error||'Customer details are unavailable.'));actions.append(h('button',{type:'button',class:'el-button',onclick:()=>close()},'Close'),h('button',{type:'button',class:'el-button primary',onclick:()=>void load()},'Retry'));}
  else if(S.pending){
    fill(main,h('p',{class:'el-notice warn',role:'alert'},`The save from ${when(S.pending.savedAt)} was not confirmed. Retry it unchanged so it is never saved twice.`),S.error&&S.errorKind!=='pending'?h('p',{class:'el-notice error',role:'alert'},S.error):null);
    actions.append(h('button',{type:'button',class:'el-button danger',disabled:S.busy,onclick:discardPending},'Discard it'),h('button',{type:'button',class:'el-button primary',disabled:S.busy,onclick:()=>void send()},S.busy?'Retrying…':'Retry original save'));
    if(S.busy)status.textContent='Retrying the original save…';
  } else {
    fill(main,S.error?h('p',{class:'el-notice error',role:'alert',tabIndex:-1},S.error):null,VIEWS[S.view]());
    if(S.errorKind==='conflict')actions.append(h('button',{type:'button',class:'el-button',disabled:S.busy,onclick:()=>void reloadLatest()},'Load latest details'));
    actions.append(h('button',{type:'button',class:'el-button',disabled:S.busy,onclick:()=>close()},'Cancel'));
    if(canSubmit())actions.append(h('button',{type:'submit',class:'el-button primary',disabled:S.busy||S.loading},S.busy?'Saving…':label()));
    if(S.busy)status.textContent='Saving…';else if(S.loading)status.textContent='Refreshing customer details…';
  }
  const form=h('form',{class:'el-sheet',noValidate:true,'aria-busy':S.busy||S.loading?'true':'false',onsubmit:e=>{e.preventDefault();void submit();}},head,main,h('footer',{class:'el-foot'},status,actions));
  if(S.busy)for(const el of form.querySelectorAll('input,select,textarea'))el.disabled=true;
  const focused=document.activeElement?.name;
  dialog.replaceChildren(form);
  if(focused&&dialog.contains(document.activeElement)===false){const again=form.querySelector(`[name="${CSS.escape(focused)}"]`);if(again)again.focus();}
}
function focusFirst(){S.dialog?.querySelector('.el-body input:not([disabled]),.el-body select:not([disabled]),.el-body textarea:not([disabled]),.el-foot .primary')?.focus();}
function focusError(){S.dialog?.querySelector('.el-notice.error')?.focus?.();}
function beforeUnload(event){if(S.busy||dirty()){event.preventDefault();event.returnValue='';}}

function open(id,view){
  if(S.dialog){if(S.busy)return;close(true);}
  S.opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  Object.assign(S,{id:String(id||''),view,data:null,viewer:'',draft:null,pending:null,error:'',errorKind:'',busy:false});
  const dialog=h('dialog',{class:'egc-lifecycle','aria-labelledby':'el-title',oncancel:e=>{e.preventDefault();close();},onclose:()=>{if(S.dialog===dialog)close(true);}});
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
  Object.assign(S,{data:null,draft:null,pending:null,busy:false,loading:false,error:'',errorKind:''});
  if(S.opener?.isConnected)S.opener.focus();S.opener=null;
}

async function route(id,view){
  const on=await enabled();
  if(on===null)return;
  if(on==='unknown'){toast('Customer action settings could not be checked. Retry.');return;}
  if(!on)return legacy[view]?legacy[view](id):undefined;
  return open(id,view);
}
window.opsIssueCustomerCredit=id=>route(id,'credit');
window.opsSendCustomerDecision=id=>route(id,'decision');
window.opsReviewRebooking=id=>route(id,'rebook');
window.addEventListener('egc:signout',()=>{close(true);clearAllPending();S.flagRequest=null;if(window.EGC_FLAGS)delete window.EGC_FLAGS.lifecycleApi;});
window.EGCCustomerLifecycle={open,close:()=>close(),enabled,canLeave:()=>!S.busy&&!dirty(),legacy:view=>legacy[view]||null};
})();
