/* Invoicing (M5/M6): issue invoices for finished jobs, one or a batch, through
   /api/invoice-batch (the money service, one request ID per job). The Hub
   sends nothing itself: HighLevel owns every customer message. Each issued
   invoice starts the same HighLevel lifecycle trigger as the standard finance
   save (tag egc-invoice-issued, suppressed when the job's notify is off),
   through the suite's own helper window.EGCCustomerCommunication
   (employee-suite.js syncCustomerCommunication, as the server money dialog
   uses it), so HighLevel's workflow on that tag sends the invoice. Without that
   helper (a standalone page) nothing is triggered and the row says to use
   Trigger in HighLevel. Registered Hub screen (employee-hub-screens.js) that
   also mounts standalone: EGCMoney.mount(host, ctx). */
(function(){
'use strict';
const SCREEN='invoicing',API='/api/invoice-batch';
// The standard finance save's action name and event for an issued invoice (employee-suite.js opsFinanceAction).
const ACTION='invoice',EVENT='invoice-issued';
// Read-back waits (ms) before an issue counts as unconfirmed, and how long a missed-trigger flag may take.
const READBACK=[400,1200,3000],FLAG_WAIT=8000;
// The suite's claim (EGCCustomerCommunication.claim) takes over a pending claim older than this (ms): that trigger never started.
const CLAIM_WINDOW=300000;
const TAGS={
  starting:['','Starting the HighLevel invoice automation…'],triggered:['','HighLevel invoice automation started'],
  suppressed:['','Notifications are off for this job, so no HighLevel automation'],elsewhere:['','HighLevel automation already started in another tab'],
  retry:['warn','HighLevel needs a retry · see Customer messages'],flagged:['warn','Not confirmed · flagged in Customer messages; use Trigger in HighLevel there if still needed'],
  untriggered:['warn','HighLevel not triggered · use Trigger in HighLevel in Customer messages if still needed'],
};
let S=fresh();
// tags: each issue's trigger state, keyed by the issue's own request ID (tagKey), so an invoice voided and issued again gets its own trigger.
function fresh(){return{host:null,root:null,ctx:null,gen:0,loads:0,loading:false,data:null,error:null,selected:new Set(),dueDate:'',busy:false,result:null,issueError:null,tags:{},dialog:null,opener:null};}
/** The trigger state's key for one issued row: its derived request ID (stable across replays of the same batch, new for every batch). */
const tagKey=item=>text(item?.requestId)&&item.requestId?'issue:'+item.requestId.toLowerCase():'job:'+String(item?.jobId||'');
const K=()=>window.EGCHubKit;
const viewer=()=>String(S.ctx?.identity||'').trim().toLowerCase();
const fetcher=()=>typeof S.ctx?.hubFetch==='function'?S.ctx.hubFetch:undefined;
const toast=message=>{try{(S.ctx?.toast||window.showToast||(()=>{}))(message);}catch{}};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const cents=value=>Number.isSafeInteger(value);
const text=value=>typeof value==='string';
// Without the job's automatic reminders (the suite's Enable auto), the Hub never adds egc-invoice-overdue for it.
const REMINDER_OFF='Automatic overdue reminder off (Enable auto on the job)';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Resolves with the promise's value, or with `fallback` after ms. */
function within(promise,ms,fallback){let timer;return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),ms);})]).finally(()=>clearTimeout(timer));}
const dateText=date=>K().validDate(date)?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z')):'No date';
const row=value=>plain(value)&&text(value.jobId)&&/^[A-Za-z0-9_-]{1,180}$/.test(value.jobId)&&text(value.revision)&&text(value.customer);
const validList=data=>Array.isArray(data.candidates)&&Array.isArray(data.review)&&Array.isArray(data.open)&&plain(data.coverage)&&data.coverage.complete===true&&typeof data.enabled==='boolean'&&K().validDate(data.today)
  &&data.candidates.every(item=>row(item)&&cents(item.balanceCents))&&data.review.every(row)&&data.open.every(item=>row(item)&&cents(item.balanceCents)&&plain(item.invoice));
const validIssue=data=>Array.isArray(data.results)&&plain(data.summary)&&data.results.every(item=>plain(item)&&text(item.jobId)&&typeof item.ok==='boolean');
const request=(path,opts={})=>K().requestJSON(path,{prefix:'money',fetcher:fetcher(),...opts});
const issuer=()=>K().pending(SCREEN,viewer());
const issueOpts=()=>({fetcher:fetcher(),prefix:'money',validate:validIssue});
const maxItems=()=>Number.isSafeInteger(S.data?.limits?.maxItems)&&S.data.limits.maxItems>0?S.data.limits.maxItems:25;

// S.gen ends with the mount; S.loads orders list loads, so a reload never
// orphans an issue that is still running.
async function load(){
  const gen=S.gen,seq=++S.loads,current=()=>gen===S.gen&&seq===S.loads;S.loading=true;S.error=null;render();
  try{
    const data=await request(API,{validate:validList});
    if(!current())return;
    S.data=data;S.dueDate=K().validDate(S.dueDate)&&S.dueDate>=data.today?S.dueDate:data.defaultDueDate;
    const ids=new Set(data.candidates.map(item=>item.jobId));
    S.selected=new Set([...S.selected].filter(id=>ids.has(id)));
  }catch(error){if(current())S.error=error;}
  finally{if(current()){S.loading=false;render();}}
}

function h(...args){return K().h(...args);}
function notice(kind,title,copy,actions=[]){
  return h('div',{class:'hub-notice '+kind,role:kind==='error'?'alert':'status'},title?h('strong',{},title):null,copy?h('p',{},copy):null,actions.length?h('div',{class:'hub-actions'},actions):null);
}

function candidateRow(item){
  const id='mn-pick-'+item.jobId,checked=S.selected.has(item.jobId),disabled=!S.data.enabled||S.busy||!checked&&S.selected.size>=maxItems();
  const notes=[item.estimateApproved?null:'No customer approval recorded',item.businessAccount?'Company account':null,item.notify?null:'Notifications off',item.notify&&item.automaticReminders!==true?REMINDER_OFF:null].filter(Boolean);
  return h('li',{class:'mn-row'+(checked?' picked':'')},
    h('input',{type:'checkbox',id,checked,disabled,'aria-describedby':id+'-meta',onchange:event=>{if(event.target.checked)S.selected.add(item.jobId);else S.selected.delete(item.jobId);render();}}),
    h('label',{htmlFor:id,class:'mn-main'},h('span',{class:'mn-name'},item.customer||'Customer'),
      h('span',{class:'mn-meta',id:id+'-meta'},[dateText(item.serviceDate),'Balance '+K().money(item.balanceCents),...notes].join(' · '))),
    h('span',{class:'mn-amount'},K().money(item.balanceCents)));
}

function resultRow(item){
  const customer=S.data?.candidates.find(row=>row.jobId===item.jobId)?.customer||item.customer||item.jobId;
  if(item.ok){
    const invoice=item.invoice||{},tag=TAGS[S.tags[tagKey(item)]];
    return h('li',{class:'mn-result ok'},h('span',{class:'mn-name'},customer),
      h('span',{class:'mn-meta'},item.changedSince?`Invoice issued${item.replayed===false?'':' earlier'}; the job has changed since. Refresh to review it.`:`${invoice.number||'Invoice'} · ${K().money(item.balanceCents)} due ${dateText(invoice.dueDate)}${item.replayed?' · already issued':''}`),
      tag?h('span',{class:('mn-meta mn-tag '+tag[0]).trim()},tag[1]):null);
  }
  return h('li',{class:'mn-result '+(item.code==='money_batch_not_attempted'?'skip':'fail')},h('span',{class:'mn-name'},customer),h('span',{class:'mn-meta'},item.error||'This invoice was not issued.'));
}

function issueSection(){
  const data=S.data,items=data.candidates,count=S.selected.size,total=items.filter(item=>S.selected.has(item.jobId)).reduce((sum,item)=>sum+item.balanceCents,0);
  const max=maxItems(),first=items.slice(0,max),all=first.length>0&&first.every(item=>S.selected.has(item.jobId));
  const saved=issuer().get();
  const body=[];
  if(!data.enabled)body.push(notice('warning','Batch invoicing is off','Server money actions are turned off, so invoices are issued from each job’s finance tools for now.'));
  if(saved)body.push(notice('warning','An invoice batch was not confirmed','Retry the original request to see what was issued. It never issues an invoice twice, and it starts the HighLevel invoice automation for each invoice it issued. Discarding it does not: any invoice it already issued gets no HighLevel automation from here, so check those jobs and use Trigger in HighLevel in Customer messages.',[K().button('Retry original batch',retryIssue,'primary',{disabled:S.busy}),K().button('Discard',()=>{issuer().discard();S.issueError=null;render();},'',{disabled:S.busy})]));
  if(S.issueError)body.push(notice('error','Invoices were not issued',K().errorText(S.issueError)));
  if(S.result){
    const {summary}=S.result,rest=S.result.results.filter(item=>item.code==='money_batch_not_attempted').map(item=>item.jobId).filter(id=>items.some(row=>row.jobId===id));
    body.push(h('div',{class:'mn-results',role:'status','aria-live':'polite'},
      h('p',{class:'mn-summary'},S.busy?`${summary.issued} of ${summary.total} issued so far. Issuing the rest…`:`${summary.issued} issued${summary.failed?`, ${summary.failed} not issued`:''}${summary.notAttempted?`, ${summary.notAttempted} not attempted`:''}.`),
      h('ul',{class:'mn-list'},S.result.results.map(resultRow)),
      rest.length&&!S.busy&&!saved?K().button(`Issue the remaining ${rest.length}`,()=>{S.selected=new Set(rest.slice(0,max));submitIssue();},'primary',{disabled:!data.enabled}):null));
  }
  if(!items.length)body.push(h('p',{class:'mn-empty'},'No finished jobs are waiting for an invoice.'));
  else body.push(
    h('div',{class:'mn-tools'},
      h('label',{class:'hub-field hub-check mn-all'},h('input',{type:'checkbox',name:'selectAll',checked:all,disabled:!data.enabled||S.busy,onchange:event=>{S.selected=event.target.checked?new Set(first.map(item=>item.jobId)):new Set();render();}}),h('span',{},items.length>max?`Select the first ${max}`:`Select all (${items.length})`)),
      K().field({label:'Payment due',name:'dueDate',type:'date',value:S.dueDate,min:data.today,required:true,help:'Denver date. Every invoice in this batch uses it.'})),
    h('ul',{class:'mn-list'},items.map(candidateRow)),
    h('div',{class:'mn-bar'},
      h('p',{class:'mn-bar-text','aria-live':'polite'},count?`${count} selected${count>=max&&items.length>max?' (the most in one batch)':''} · ${K().money(total)}`:'Choose the jobs to invoice'),
      K().button(S.busy?'Issuing…':count>1?`Issue ${count} invoices`:'Issue invoice',confirmIssue,'primary',{disabled:!count||S.busy||!data.enabled||Boolean(saved),'aria-busy':S.busy?'true':null})));
  return h('section',{class:'hub-card mn-section','aria-labelledby':'mn-issue-title'},h('h2',{id:'mn-issue-title'},`Ready to invoice (${items.length})`),
    h('p',{class:'mn-help'},'Finished jobs with a balance and no active invoice. Issuing starts the HighLevel invoice automation for each job, as the standard finance tools do (not for jobs with notifications off).'),body);
}

function reviewSection(){
  const items=S.data.review;
  if(!items.length)return null;
  return h('details',{class:'hub-card mn-section mn-review'},h('summary',{},`Needs review before invoicing (${items.length})`),
    h('ul',{class:'mn-list'},items.map(item=>h('li',{class:'mn-result fail'},h('span',{class:'mn-name'},item.customer||'Customer'),h('span',{class:'mn-meta'},`${dateText(item.serviceDate)} · ${item.message||'Review this job’s money.'}`)))));
}

// Issued invoices still owed, read-only: HighLevel's invoice and overdue workflows message the customer.
function openSection(){
  const items=S.data.open;
  return h('section',{class:'hub-card mn-section','aria-labelledby':'mn-open-title'},h('h2',{id:'mn-open-title'},`Open invoices (${items.length})`),
    h('p',{class:'mn-help'},'Issued invoices that still have a balance. HighLevel’s invoice and overdue workflows message the customer; the Hub sends nothing. The Hub starts the overdue workflow (tag egc-invoice-overdue) only for jobs with automatic reminders on (Enable auto on the job).'),
    items.length?h('ul',{class:'mn-list'},items.map(item=>h('li',{class:'mn-row mn-open'},
      h('div',{class:'mn-main'},h('span',{class:'mn-name'},item.customer||'Customer'),
        h('span',{class:'mn-meta'},[item.invoice.number||'Invoice','due '+dateText(item.invoice.dueDate),item.invoiceStatus==='overdue'?'Overdue':'',item.notify?'':'Notifications off',item.notify&&item.automaticReminders!==true?REMINDER_OFF:''].filter(Boolean).join(' · '))),
      h('span',{class:'mn-amount'},K().money(item.balanceCents))))):h('p',{class:'mn-empty'},'No issued invoices have a balance.'));
}

function render(){
  if(!S.root)return;
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'CLIENT WORK'),h('h1',{},'Invoicing'),
    h('p',{},'Issue invoices for finished jobs. HighLevel’s invoice automation messages the customer; the Hub sends nothing.')),
    h('div',{class:'hub-actions'},K().button(S.loading?'Refreshing…':'Refresh',()=>load(),'',{disabled:S.loading||S.busy})));
  let body;
  if(!S.data&&S.error)body=[notice('error','Invoicing is unavailable',K().errorText(S.error)+' Nothing here is shown as current.',[K().button('Retry',()=>load(),'primary')])];
  else if(!S.data)body=[h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading invoicing…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}),h('span',{class:'hub-skeleton wide'}))];
  else body=[S.error?notice('error','The list could not be refreshed',K().errorText(S.error)+' The rows below are from the last successful load.',[K().button('Retry',()=>load(),'primary')]):null,issueSection(),reviewSection(),openSection()];
  // Re-rendering keeps keyboard focus on the same control (by name, id or label).
  // The open dialog is never detached: removing a modal dialog closes it.
  const keep=S.dialog?.dialog,active=document.activeElement,inView=active&&S.root.contains(active)&&!keep?.contains(active);
  const name=inView?active.getAttribute('name'):'',id=inView?active.id:'',label=inView?active.getAttribute('aria-label'):'';
  for(const node of [...S.root.childNodes])if(node!==keep)node.remove();
  S.root.prepend(head,...body.filter(Boolean));
  const due=S.root.querySelector('input[name="dueDate"]');
  if(due)for(const type of ['input','change'])due.addEventListener(type,event=>{S.dueDate=event.target.value;});
  const next=name?S.root.querySelector(`[name="${CSS.escape(name)}"]`):id?S.root.querySelector('#'+CSS.escape(id)):label?labelled(label):null;
  next?.focus?.({preventScroll:true});
}

// A small modal shell: the opener gets focus back when it closes.
function openDialog(title,opener){
  closeDialog();
  const titleId='mn-dialog-title',body=h('div',{class:'hub-dialog-body'}),footer=h('footer',{});
  const dialog=h('dialog',{class:'hub-dialog mn-dialog','aria-labelledby':titleId},
    h('header',{},h('h2',{id:titleId},title),K().button('Close',()=>closeDialog(),'quiet',{'aria-label':'Close'})),body,footer);
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  S.root.append(dialog);S.dialog={dialog,body,footer};S.opener=opener||null;
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  return S.dialog;
}
function closeDialog(){
  if(!S.dialog)return;
  const {dialog}=S.dialog;S.dialog=null;
  try{dialog.close?.();}catch{}dialog.remove();
  // A reload may have replaced the opener; the button with its label takes focus.
  const opener=S.opener,label=opener?.getAttribute?.('aria-label');S.opener=null;
  const target=opener?.isConnected?opener:label?labelled(label):null;
  target?.focus?.({preventScroll:true});
}
const labelled=label=>S.root?[...S.root.querySelectorAll('button[aria-label]')].find(button=>button.getAttribute('aria-label')===label&&!S.dialog?.dialog.contains(button))||null:null;

function confirmIssue(event){
  const due=S.root.querySelector('input[name="dueDate"]')?.value||S.dueDate;
  if(!K().validDate(due)||due<S.data.today){S.issueError=Object.assign(new Error('Choose a payment due date of today or later.'),{code:'money_invalid_due_date',status:400});render();return;}
  S.dueDate=due;
  const count=S.selected.size,dialog=openDialog(count>1?`Issue ${count} invoices?`:'Issue this invoice?',event?.currentTarget);
  const names=S.data.candidates.filter(item=>S.selected.has(item.jobId)),quiet=names.filter(item=>!item.notify).length;
  dialog.body.append(h('p',{},`Each invoice is due ${dateText(due)} and uses the job’s saved estimate and payments.`),
    h('p',{},`Issuing starts the HighLevel invoice automation (tag egc-invoice-issued) for each job, as the standard finance tools do, and HighLevel sends the invoice.${quiet?` ${quiet===1?'One job has':quiet+' jobs have'} notifications off and ${quiet===1?'gets':'get'} no automation.`:''} The Hub itself sends nothing.`),
    h('ul',{class:'mn-list compact'},names.map(item=>h('li',{},`${item.customer} · ${K().money(item.balanceCents)}`))));
  dialog.footer.append(K().button('Cancel',()=>closeDialog()),K().button(count>1?`Issue ${count} invoices`:'Issue invoice',()=>{closeDialog();submitIssue();},'primary'));
  dialog.footer.lastChild.focus();
}

async function submitIssue(){
  const data=S.data;
  if(!data||S.busy)return;
  const items=data.candidates.filter(item=>S.selected.has(item.jobId)).slice(0,maxItems()).map(item=>({jobId:item.jobId,expectedRevision:item.revision}));
  if(!items.length)return;
  await runIssue(items,()=>issuer().submit(API,{action:'issue',dueDate:S.dueDate,items},issueOpts()));
}
// A retried step belongs to the batch on screen, so its results join those.
function retryIssue(){return runIssue(issuer().get()?.body?.items,()=>issuer().replay(issueOpts()),true);}
// Results of a continued batch replace the rows it re-attempted; the summary is recounted.
function merged(prior,next){
  if(!prior)return next;
  const byId=new Map(next.results.map(item=>[item.jobId,item])),known=new Set(prior.results.map(item=>item.jobId));
  const results=[...prior.results.map(item=>byId.get(item.jobId)||item),...next.results.filter(item=>!known.has(item.jobId))],count=test=>results.filter(test).length;
  return {...next,results,summary:{total:results.length,issued:count(item=>item.ok),replayed:count(item=>item.ok&&item.replayed),failed:count(item=>!item.ok&&item.code!=='money_batch_not_attempted'),notAttempted:count(item=>item.code==='money_batch_not_attempted')}};
}
// One confirmed batch may take several requests: the server issues what fits
// in one call and reports the rest as not attempted, and the next request (a
// new ID, saved before it is sent) carries them on. The chain stops at the
// first request that fails or issues nothing, and the rest stay on offer.
// Every invoice it issued then starts its HighLevel trigger, even when a later
// step failed or the screen was left meanwhile.
async function runIssue(items,work,resume=false){
  const gen=S.gen,live=()=>gen===S.gen,tags=S.tags,issued=[],sink=S.ctx?.toast,say=message=>{try{(sink||window.showToast||(()=>{}))(message);}catch{}};
  const names=new Map(S.data.candidates.map(item=>[item.jobId,item.customer])),revisions=new Map((Array.isArray(items)?items:[]).map(item=>[item?.jobId,item?.expectedRevision]));
  S.busy=true;S.issueError=null;if(!resume)S.result=null;render();
  try{
    while(work){
      const result=await work();
      issued.push(...result.results.filter(item=>item.ok));
      if(!live())break;
      S.result=merged(S.result,{...result,results:result.results.map(item=>({...item,customer:item.customer||names.get(item.jobId)||''}))});S.selected=new Set();
      const rest=result.results.filter(item=>item.code==='money_batch_not_attempted'&&typeof revisions.get(item.jobId)==='string').map(item=>({jobId:item.jobId,expectedRevision:revisions.get(item.jobId)}));
      work=rest.length&&rest.length<result.results.length&&K().validDate(result.dueDate)?()=>issuer().submit(API,{action:'issue',dueDate:result.dueDate,items:rest},issueOpts()):null;
      if(work)render();
    }
  }catch(error){if(live())S.issueError=error;}
  finally{if(live()){S.busy=false;render();if(S.result)void load();}}
  // A resumed batch also carries on the triggers of rows issued before it.
  const ok=live()&&S.result?S.result.results.filter(item=>item.ok):issued;
  if(!await startMessages(ok,{tags,gen}))return;
  const counts={triggered:0,suppressed:0,elsewhere:0,retry:0,flagged:0,untriggered:0};
  for(const item of ok)if(Object.hasOwn(counts,tags[tagKey(item)]))counts[tags[tagKey(item)]]++;
  say(issuedToast(ok.length,counts));
}

function issuedToast(issued,counts){
  const parts=[`${issued} invoice${issued===1?'':'s'} issued`];
  const started=counts.triggered+counts.elsewhere,attention=counts.retry+counts.flagged+counts.untriggered;
  if(started)parts.push(`HighLevel invoice automation started${started<issued?` for ${started}`:''}`);
  if(counts.suppressed)parts.push(`${counts.suppressed} with notifications off`);
  if(attention)parts.push(`${attention} need${attention===1?'s':''} Trigger in HighLevel`);
  return parts.join(' · ');
}

/**
 * Starts the HighLevel lifecycle trigger of every issued invoice this screen
 * has not started yet, one at a time. Each issue is keyed by its own request
 * ID, so a job whose invoice was voided and issued again in a later batch gets
 * a new trigger. It keeps going after the screen unmounts (the suite helper
 * still runs), and leaving the page is guarded until it is done.
 */
let running=0;
async function startMessages(items,{tags,gen}){
  const todo=items.filter(item=>!tags[tagKey(item)]);
  if(!todo.length)return false;
  const show=()=>{if(gen===S.gen)render();};
  running++;for(const item of todo)tags[tagKey(item)]='starting';show();
  try{
    for(const item of todo){
      let state;try{state=await customerMessage(item);}catch{state='retry';}
      tags[tagKey(item)]=state;show();
    }
  }finally{running--;show();if(!running&&!S.root)window.removeEventListener('beforeunload',beforeUnload);}
  return true;
}
/**
 * The standard finance save's trigger for one issued invoice, at most once. It
 * uses the saved job (moneyRequestId proves it is this issue): the marker is
 * the issue's own save time, so a replayed batch builds the same trigger, and
 * one already in the job's log (or claimed there by another tab) is not
 * started again. An issue it cannot confirm is flagged in the job's log.
 */
async function customerMessage(item){
  const hooks=window.EGCCustomerCommunication;
  if(typeof hooks?.sync!=='function'||typeof hooks.read!=='function')return 'untriggered';
  if(item.changedSince)return changedSince(hooks,item);
  const job=text(item.requestId)?await savedJob(hooks,item):null;
  if(!job)return flag(hooks,item);
  const marker=`${ACTION}:${job.moneyUpdatedAt}`,key=`communication:${job.id}:${EVENT}:${marker}`;
  let logged=(Array.isArray(job.communicationLog)?job.communicationLog:[]).find(entry=>entry?.id===key)||null;
  // The suite claims it in one transaction, so a duplicated tab replaying this batch cannot start it a second time.
  if((!logged||logged.status==='pending')&&typeof hooks.claim==='function'){try{logged=await hooks.claim(job.id,EVENT,marker);}catch{}}
  if(logged?.status==='pending')return 'elsewhere';
  let sent=logged?.status==='triggered';
  if(!logged){try{sent=await hooks.sync(job,EVENT,marker)===true;}catch{sent=false;}try{hooks.render?.();}catch{}}
  return job.notify===false?'suppressed':sent?'triggered':'retry';
}
/** Flags an issue whose trigger this screen could not start in the job's log (needs attention in Customer messages). */
async function flag(hooks,item){
  let flagged=false;
  try{flagged=typeof hooks.missed==='function'&&text(item.requestId)&&await within(hooks.missed(item.jobId,EVENT,item.requestId),FLAG_WAIT,false)===true;}catch{}
  try{if(flagged)hooks.render?.();}catch{}
  return flagged?'flagged':'untriggered';
}
// The job's log entry states an issue's trigger can already be in.
const LOGGED={triggered:'triggered',suppressed:'suppressed',pending:'elsewhere',needs_attention:'retry'};
/**
 * A row the server reports as changed since (a later money save on the job):
 * its read-back can never show this issue's moneyRequestId, so the job's log
 * reports the trigger. First the issue's own key, rebuilt from the invoice's
 * issuedAt (an issue saves issuedAt and moneyUpdatedAt at the same server
 * instant); a claim another tab left pending past the claim window never
 * started. Otherwise a later invoice-issued trigger (seen). With nothing
 * found, this request's own new issue (replayed false) is flagged in the log:
 * no trigger can have run for it, so the flag never duplicates one. A replay
 * is only reported ('untriggered', as the money dialog does): an earlier
 * attempt may have added the tag and closed before logging it, so a lasting
 * flag could ask for a second one.
 */
async function changedSince(hooks,item){
  let job=null;try{job=await hooks.read(item.jobId);}catch{}
  const issuedAt=job?.id===item.jobId&&text(job.invoice?.issuedAt)?job.invoice.issuedAt:'',entry=issuedAt?seen(job,issuedAt):null;
  if(entry&&LOGGED[entry.status])return LOGGED[entry.status];
  return item.replayed===false?flag(hooks,item):'untriggered';
}
/**
 * The log entry of the invoice issued at `issuedAt`: its own (a pending claim
 * only while the claim window is open), else a triggered or suppressed
 * invoice-issued entry saved at or after the issue. An automatic entry is timed
 * by the server save time in its key (…:invoice:<moneyUpdatedAt>), never by its
 * attemptedAt (the browser's clock); only a manual Trigger in HighLevel
 * (…:manual) is timed by attemptedAt.
 */
function seen(job,issuedAt){
  const log=Array.isArray(job.communicationLog)?job.communicationLog:[],prefix=`communication:${job.id}:${EVENT}:`,issued=Date.parse(issuedAt);
  const own=log.find(row=>row?.id===`${prefix}${ACTION}:${issuedAt}`);
  if(own&&(own.status!=='pending'||Date.now()-Date.parse(own.attemptedAt)<=CLAIM_WINDOW))return own;
  const at=row=>{const marker=row.id.slice(prefix.length);return marker==='manual'?(text(row.attemptedAt)?Date.parse(row.attemptedAt):NaN):marker.startsWith(ACTION+':')?Date.parse(marker.slice(ACTION.length+1)):NaN;};
  return log.find(row=>row?.event===EVENT&&['triggered','suppressed'].includes(row.status)&&text(row.id)&&row.id.startsWith(prefix)&&at(row)>=issued)||null;
}
/** The saved job once a read shows this issue (its moneyRequestId), retried with a short backoff; null if none does. */
async function savedJob(hooks,item){
  for(let attempt=0;;attempt++){
    let job=null;try{job=await hooks.read(item.jobId);}catch{}
    if(job?.id===item.jobId&&job.moneyRequestId===item.requestId&&text(job.moneyUpdatedAt)&&job.moneyUpdatedAt)return job;
    if(attempt>=READBACK.length)return null;
    await wait(READBACK[attempt]);
  }
}

function mount(host,ctx={}){
  if(!host||!window.EGCHubKit)throw new Error('EGCMoney needs a host and the Hub UI kit.');
  unmount();
  S.host=host;S.ctx=ctx;
  S.root=h('section',{class:'hub-screen egc-invoicing'});
  host.append(S.root);
  window.addEventListener('beforeunload',beforeUnload);
  render();
  return load();
}
function unmount(){
  S.gen++;
  if(S.dialog){const {dialog}=S.dialog;try{dialog.close?.();}catch{}dialog.remove();}
  S.root?.remove();
  const gen=S.gen;S=fresh();S.gen=gen;
  // A trigger run still in progress keeps the unload guard until it finishes.
  if(!running)window.removeEventListener('beforeunload',beforeUnload);
}
const canLeave=()=>!S.busy&&!running;
// Standalone pages get the same guard the Hub shell applies through canLeave().
function beforeUnload(event){if(!canLeave()){event.preventDefault();event.returnValue='';}}
const refresh=()=>S.root?load():Promise.resolve();
window.addEventListener('egc:signout',unmount);
window.EGCMoney=Object.freeze({mount,unmount,canLeave,refresh});
})();
