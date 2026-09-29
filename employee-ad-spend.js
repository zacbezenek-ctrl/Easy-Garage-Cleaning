/* Owner-only Ad spend screen (FUN-15). Per-day spend by channel on Denver days, source health,
   Meta lead-form counts, and the owner-entered ledger for channels without an API. Every read and
   write goes through /api/operations (the signed operations bridge). A day nobody recorded stays
   blank: unknown is never shown as $0. */
(function(){
'use strict';
const SCREEN='ad_spend',TZ='America/Denver',CHANNEL=/^[a-z][a-z0-9_]{1,39}$/,API_CHANNELS=['meta_ads','google_ads'];
// Meta and Google spend under another name; the same pattern as API_CHANNEL_ALIAS in egc-platform/services/ad-spend.
const API_ALIAS=/(^|_)(facebook|fb|instagram|insta|ig|meta|google|googleads|adwords|gads|youtube|yt)(ads?)?(_|$)|^(facebook|instagram|google|adwords|youtube)/;
const NAMES={meta_ads:'Meta Ads',google_ads:'Google Ads',meta_leadgen:'Meta lead forms'};
const STATUS={complete:'Complete',partial:'Partial',unknown:'Unknown'};
const REASONS={platform_not_connected:'Not connected yet',worker_configuration_missing:'The ad spend worker has not reported yet',day_not_pulled:'Some days were not pulled',
  restatement_window:'The last 3 days can still change at the platform',account_time_zone_not_denver:'The ad account is not on Denver time',currency_not_usd:'The ad account is not billed in USD',
  manual_entry_gap:'A gap between your entries',owner_attested:'Owner-entered',manual_entries_truncated:'Too many entries to read at once',
  meta_lead_retention_exceeded:'Meta only keeps lead-form leads for 90 days'};
const DISCLOSURES={non_api_channels_count_only_owner_entries:'Channels without an API count only what you enter here.',manual_spend_allocated_evenly_per_day:'An entry is spread evenly across its days.',
  ad_platform_restatements_after_settlement_not_reflected:'Platform changes made more than 3 days later are not reflected.'};
const HEALTH={not_connected:'Not connected',never_synced:'Waiting for the first sync',healthy:'Up to date',stale:'Stale',failing:'Failing'};
const ERRORS={spend_owner_required:'Only the owner can see or change ad spend.',spend_channel_api_ingested:'Meta (Facebook, Instagram) and Google (including YouTube) spend comes from their APIs and cannot be typed in.',
  spend_entry_closed:'That entry was already voided or corrected. Load the latest list and try again.',spend_period_in_future:'The period can end at most about two months from today.',
  spend_range_invalid:'Choose a range of at most 400 days.',spend_range_in_future:'That range has not started yet.',operations_not_enabled:'The operations service is not enabled yet.',
  spend_amount_invalid:'Enter an amount from $0.00 up to $20,000,000.00.',spend_period_invalid:'Choose a period of at most 366 days, starting in 2020 or later.',spend_channel_invalid:'Use lowercase letters, numbers and _ for the channel (for example yard_signs).',
  spend_description_invalid:'Say what the spend was for, on one line.',spend_receipt_required:'Add the receipt or invoice reference.',spend_entry_not_found:'That entry no longer exists. Load the latest list.',
  spend_entry_request_conflict:'This request was already used for another entry. Load the latest list before saving again.',idempotency_key_payload_conflict:'The original request already has a different saved result. Load the latest list before saving again.',
  invalid_command:'The Hub refused this entry. Check the channel, amount, period and receipt, then save again.'};
// A read the operations service does not know yet (the Hub deployed before the platform) is not a refused entry.
const READ_ERRORS={...ERRORS,invalid_command:'The operations service does not support ad spend yet.'};
const RELOAD=/_revision_conflict$|^spend_entry_closed$|^spend_entry_not_found$/;
const conflictKind=(error,body)=>RELOAD.test(String(error?.code||''))&&(body?.supersedes?'correction':'entry');
let S=null;
const K=()=>window.EGCHubKit;
const money=cents=>Number.isSafeInteger(cents)?K().money(cents):'Unknown';
const channelName=id=>NAMES[id]||String(id).replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
const reasonText=code=>REASONS[code]||String(code).replace(/_/g,' ');
const dayLabel=date=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));
const instantLabel=at=>at?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(at)):'never';
const blank=()=>({channel:'',amount:'',firstDate:'',lastDate:'',description:'',receiptReference:''});
function presets(today){
  const month=today.slice(0,8)+'01',next=K().addDays(month,32).slice(0,8)+'01',previous=K().addDays(month,-1).slice(0,8)+'01';
  return [{id:'month',label:'This month',from:month,to:next},{id:'last_month',label:'Last month',from:previous,to:month},{id:'days30',label:'Last 30 days',from:K().addDays(today,-29),to:K().addDays(today,1)}];
}
const validCoverage=data=>Boolean(data&&data.metric&&typeof data.metric.status==='string'&&data.metric.coverage&&Array.isArray(data.channels)&&Array.isArray(data.days)&&data.period&&typeof data.period.from==='string'&&Array.isArray(data.sources)&&data.leadgen);
const validEntries=data=>Boolean(data&&Array.isArray(data.items)&&Number.isSafeInteger(data.total)&&(data.nextOffset===null||Number.isSafeInteger(data.nextOffset)));
function call(body,validate){
  return K().requestJSON('/api/operations',{method:'POST',body:{requestId:K().requestId(),body},prefix:'spend',timeout:30000,fetcher:S.ctx.hubFetch,validate});
}
async function load(){
  if(!S)return;
  const gen=++S.gen,range=S.range;
  S.loading=true;S.error='';S.moreBusy=false;S.moreError='';renderBody();
  try{
    const [report,entries]=await Promise.all([call({command:'spend.coverage',from:range.from,to:range.to},validCoverage),call({command:'spend.entries',from:range.from,to:range.to,status:'active',limit:200},validEntries)]);
    if(!S||gen!==S.gen)return;
    S.report=report;S.entries=entries;
  }catch(error){
    if(!S||gen!==S.gen)return;
    S.report=null;S.entries=null;S.error=K().errorText(error,READ_ERRORS);
  }
  S.loading=false;renderBody();
}
// The next page of overlapping entries; an entry that moved between pages is shown once.
async function more(){
  if(!S||!S.entries||S.entries.nextOffset===null||S.moreBusy)return;
  const gen=S.gen,range=S.range,offset=S.entries.nextOffset;
  S.moreBusy=true;S.moreError='';renderBody();
  try{
    const page=await call({command:'spend.entries',from:range.from,to:range.to,status:'active',offset,limit:200},validEntries);
    if(!S||gen!==S.gen)return;
    const seen=new Set(S.entries.items.map(e=>e.id));
    S.entries={...page,items:[...S.entries.items,...page.items.filter(e=>!seen.has(e.id))]};
  }catch(error){
    if(!S||gen!==S.gen)return;
    S.moreError=K().errorText(error,READ_ERRORS);
  }
  S.moreBusy=false;renderBody();
}

function badge(status){return K().h('span',{class:'as-badge as-'+(STATUS[status]?status:'unknown')},STATUS[status]||'Unknown');}
function row(attrs,main,value){return K().h('li',{class:'as-row',...attrs},K().h('div',{class:'as-row-main'},main),K().h('div',{class:'as-row-value'},value));}
function summary(){
  const {h}=K(),r=S.report,m=r.metric;
  return h('article',{class:'hub-card as-summary'},
    h('span',{class:'hub-eyebrow'},'Total ad spend · '+dayLabel(r.period.from)+' – '+dayLabel(K().addDays(r.period.to,-1))+(r.period.inProgress?' (in progress)':'')),
    h('div',{class:'as-total'},h('strong',{'data-as-total':''},money(m.value)),badge(m.status)),
    m.coverage.reasons.length?h('ul',{class:'as-reasons'},m.coverage.reasons.map(code=>h('li',{},reasonText(code)))):null,
    h('p',{class:'as-note'},'As of '+instantLabel(m.asOf)+' Denver time. '+(m.coverage.disclosures||[]).map(code=>DISCLOSURES[code]||'').join(' ')));
}
function channels(){
  const {h}=K();
  return h('section',{class:'hub-card','aria-labelledby':'as-channels-title'},h('h2',{id:'as-channels-title'},'By channel'),
    h('ul',{class:'as-list'},S.report.channels.map(c=>row({'data-as-channel':c.channel},
      [h('strong',{},channelName(c.channel)),h('small',{},c.kind==='api'?'From the platform API':'Owner-entered'),c.reasons.length?h('small',{class:'as-why'},c.reasons.map(reasonText).join(' · ')):null],
      [h('strong',{},money(c.value)),badge(c.status)]))));
}
// The note follows why days are unknown, so an unpulled day is never read as "not connected" or as no leads.
function leadNote(l){
  const why=Array.isArray(l.reasons)?l.reasons:[],missing=why.filter(code=>code!=='restatement_window');
  if(l.status==='unknown'){
    if(why.includes('platform_not_connected'))return 'Lead-form counts are not connected yet.';
    if(why.includes('worker_configuration_missing'))return 'The ad spend worker has not reported yet.';
    if(why.length&&why.every(code=>code==='meta_lead_retention_exceeded'))return 'Meta only keeps lead-form leads for 90 days, so these days cannot be counted.';
    return 'Lead-form counts for this range have not been pulled yet.';
  }
  if(l.forms.length)return l.status==='complete'||!why.length?'':why.map(reasonText).join(' · ')+'.';
  if(missing.length)return 'No lead-form leads on the days that were pulled. '+missing.map(reasonText).join(' · ')+'.';
  return why.includes('restatement_window')?'No lead-form leads in this range so far. The last 3 days can still change at the platform.':'No lead-form leads in this range.';
}
function leadgen(){
  const {h}=K(),l=S.report.leadgen,note=leadNote(l);
  return h('section',{class:'hub-card','aria-labelledby':'as-leads-title'},h('h2',{id:'as-leads-title'},'Meta lead-form leads'),
    h('div',{class:'as-total'},h('strong',{'data-as-leads':''},Number.isSafeInteger(l.value)?String(l.value):'Unknown'),badge(l.status)),
    l.forms.length?h('ul',{class:'as-list'},l.forms.map(f=>row({},[h('strong',{},f.formName||'Form '+f.formId)],[h('strong',{},String(f.count))]))):null,
    note?h('p',{class:'as-note','data-as-leads-note':''},note):null);
}
function sources(){
  const {h}=K();
  return h('section',{class:'hub-card','aria-labelledby':'as-sources-title'},h('h2',{id:'as-sources-title'},'Connections'),
    h('ul',{class:'as-list'},S.report.sources.map(s=>row({'data-as-source':s.source},
      [h('strong',{},channelName(s.source)),h('small',{},'Last good sync: '+instantLabel(s.lastSuccessAt)),s.lastFailure?h('small',{class:'as-why'},'Last problem: '+String(s.lastFailure.code).replace(/_/g,' ')+' ('+instantLabel(s.lastFailure.at)+')'):null],
      [h('span',{class:'as-badge as-health-'+s.status},HEALTH[s.status]||'Unknown')]))));
}
function gaps(){
  const {h}=K(),list=S.report.metric.gaps||[];
  if(!list.length)return null;
  return h('details',{class:'hub-card as-gaps'},h('summary',{},'Missing days ('+list.length+(S.report.metric.gapsTruncated?'+':'')+')'),
    h('ul',{class:'as-reasons'},list.slice(0,60).map(g=>h('li',{},dayLabel(g.date)+' · '+channelName(g.channel)+' · '+reasonText(g.reason)))));
}
function entries(){
  const {h,button}=K(),list=S.entries,items=list?.items||[],partial=Boolean(list&&list.total>items.length);
  return h('section',{class:'hub-card','aria-labelledby':'as-entries-title'},h('h2',{id:'as-entries-title'},'Owner-entered spend'),
    items.length?h('ul',{class:'as-list'},items.map(e=>h('li',{class:'as-entry','data-as-entry':e.id},
      h('div',{class:'as-row-main'},h('strong',{},channelName(e.channel)+' · '+money(e.amountCents)),h('small',{},dayLabel(e.firstDate)+' – '+dayLabel(e.lastDate)+' · '+e.description),h('small',{class:'as-why'},'Receipt: '+e.receiptReference)),
      h('div',{class:'hub-actions'},button('Correct',()=>correct(e),'',{disabled:S.busy}),button('Void',()=>voidEntry(e),'danger',{disabled:S.busy}))))):
      h('p',{class:'as-note'},'No owner-entered spend overlaps this range.'),
    partial?h('p',{class:'as-note','data-as-entries-count':''},'Showing '+items.length+' of '+list.total+' entries.'):null,
    S.moreError?h('p',{class:'hub-notice error',role:'alert'},S.moreError):null,
    partial&&list.nextOffset!==null?h('div',{class:'hub-actions'},button(S.moreBusy?'Loading…':'Show more',more,'',{disabled:S.moreBusy||S.busy,'aria-busy':S.moreBusy?'true':null})):null);
}
function renderHead(){
  const {h,button,field}=K(),today=K().today(new Date()),range=S.range;
  S.nodes.head.replaceChildren(
    h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'GROW THE ENGINE'),h('h1',{},'Ad spend'),h('p',{},'Daily spend by channel on Denver days. A day nobody recorded stays blank; it is never shown as $0.')),
      h('div',{class:'hub-actions',role:'group','aria-label':'Date range'},presets(today).map(p=>button(p.label,()=>choose(p),'',{'aria-pressed':String(range.preset===p.id)})))),
    h('form',{class:'as-range',onsubmit:custom},field({label:'From',name:'from',type:'date',value:range.from}),field({label:'Through',name:'through',type:'date',value:K().addDays(range.to,-1)}),button('Show range',null,'',{type:'submit'})));
}
function renderBody(){
  if(!S)return;
  const {h,button}=K(),saved=S.pending.get();
  S.nodes.status.textContent=S.loading?'Loading ad spend…':S.report?'Showing '+dayLabel(S.report.period.from)+' – '+dayLabel(K().addDays(S.report.period.to,-1)):'';
  // replaceChildren would print a null child as the text "null", so absent parts are filtered out.
  S.nodes.body.replaceChildren(...[
    saved?h('div',{class:'hub-notice warning',role:'alert'},h('strong',{},'A spend change is waiting to be confirmed.'),h('p',{},'The Hub could not confirm the last save. Retry the original request; it cannot create a second entry.'),
      h('div',{class:'hub-actions'},button('Retry original save',retry,'primary',{disabled:S.busy}),button('Discard',()=>{S.pending.discard();renderBody();},'quiet',{disabled:S.busy}))):null,
    S.error?h('div',{class:'hub-notice error',role:'alert'},h('strong',{},'Ad spend is unavailable.'),h('p',{},S.error+' Nothing here is shown as current.'),h('div',{class:'hub-actions'},button('Retry',load,'primary'))):null,
    S.loading&&!S.report?h('div',{class:'hub-screen-loading','aria-busy':'true'},h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'})):null,
    S.report?h('div',{class:'as-body'},summary(),channels(),leadgen(),sources(),gaps(),entries()):null].filter(Boolean));
}
function renderForm(){
  if(!S)return;
  const {h,field,button}=K(),c=S.correcting,v=S.draft;
  const node=h('form',{class:'hub-card as-form','aria-labelledby':'as-form-title',novalidate:true,onsubmit:save,oninput:()=>{S.dirty=true;S.draft=readForm();}},
    h('h2',{id:'as-form-title'},c?'Correct an entry':'Record spend'),
    h('p',{class:'as-note'},c?'The correction replaces the original in one step; the original is kept as superseded.':'For channels without an API, such as yard signs, mailers, Nextdoor or sponsorships. You attest the amount and period; keep the receipt.'),
    h('div',{class:'hub-grid'},
      field({label:'Channel',name:'channel',value:v.channel,maxlength:40,autocomplete:'off',help:'Lowercase with _ (for example yard_signs). Meta, Facebook, Instagram, Google and YouTube spend comes from their APIs.'}),
      field({label:'Amount (USD)',name:'amount',value:v.amount,inputmode:'decimal',autocomplete:'off',help:'For example 1250.00'}),
      field({label:'First day',name:'firstDate',type:'date',value:v.firstDate}),
      field({label:'Last day',name:'lastDate',type:'date',value:v.lastDate}),
      field({label:'What was it',name:'description',value:v.description,maxlength:500,autocomplete:'off'}),
      field({label:'Receipt reference',name:'receiptReference',value:v.receiptReference,maxlength:500,autocomplete:'off',help:'Invoice number, receipt id, or where the receipt is filed.'})),
    S.formError?h('p',{class:'hub-notice error',role:'alert'},S.formError):null,
    S.conflict?h('div',{class:'hub-actions'},button(S.conflict==='correction'&&c?'Discard draft and load latest':'Load latest',latest,'',{disabled:S.busy})):null,
    h('div',{class:'hub-actions as-form-actions'},button(S.busy?'Saving…':c?'Save correction':'Save entry',null,'primary',{type:'submit',disabled:S.busy,'aria-busy':S.busy?'true':null}),
      c?button('Cancel correction',()=>{S.correcting=null;S.draft=blank();S.dirty=false;S.formError='';S.conflict=false;renderForm();},'quiet',{disabled:S.busy}):null));
  S.nodes.form.replaceChildren(node);
}
// After a conflict: a correction's draft names a revision that is gone, so it is discarded; a refused
// void has no draft, so any unrelated draft in the form is kept.
function latest(){
  if(!S||S.busy)return;
  if(S.conflict==='correction'&&S.correcting){S.correcting=null;S.draft=blank();S.dirty=false;}
  S.formError='';S.conflict=false;renderForm();void load();
}
function choose(preset){S.range={preset:preset.id,from:preset.from,to:preset.to};renderHead();void load();}
function custom(event){
  event.preventDefault();
  const data=new FormData(event.currentTarget),from=String(data.get('from')||''),through=String(data.get('through')||'');
  if(!K().validDate(from)||!K().validDate(through)||through<from){S.error='Choose a first and last day, with the last day on or after the first.';renderBody();return;}
  S.range={preset:'custom',from,to:K().addDays(through,1)};renderHead();void load();
}
function readForm(){
  const data=new FormData(S.nodes.form.querySelector('.as-form')),value=name=>String(data.get(name)||'').trim();
  return {channel:value('channel'),amount:value('amount'),firstDate:value('firstDate'),lastDate:value('lastDate'),description:value('description'),receiptReference:value('receiptReference')};
}
function problem(v){
  if(API_CHANNELS.includes(v.channel)||API_ALIAS.test(v.channel))return ['channel',ERRORS.spend_channel_api_ingested];
  if(!CHANNEL.test(v.channel))return ['channel','Use lowercase letters, numbers and _ for the channel (for example yard_signs).'];
  const cents=K().cents(v.amount);
  if(cents===null||cents<0)return ['amount','Enter the amount in dollars and cents, for example 1250.00.'];
  if(!K().validDate(v.firstDate)||!K().validDate(v.lastDate)||v.lastDate<v.firstDate)return ['firstDate','Choose the first and last day the spend covers.'];
  if(!v.description)return ['description','Say what the spend was for.'];
  if(!v.receiptReference)return ['receiptReference','Add the receipt or invoice reference.'];
  return null;
}
async function send(body,success){
  S.busy=true;S.formError='';S.conflict=false;renderForm();renderBody();
  try{
    const data=await S.pending.submit('/api/operations',{body},{prefix:'spend',timeout:30000,fetcher:S.ctx.hubFetch,validate:d=>Boolean(d&&d.entry&&typeof d.entry.id==='string')});
    if(!S)return;
    S.busy=false;S.dirty=false;S.correcting=null;S.draft=blank();renderForm();
    S.ctx.toast?.(data.replayed?'Already saved; showing the saved result.':success);
    await load();
  }catch(error){
    if(!S)return;
    S.busy=false;S.formError=K().errorText(error,ERRORS);S.conflict=conflictKind(error,body);renderForm();renderBody();
  }
}
function save(event){
  event.preventDefault();
  if(S.busy)return;
  S.draft=readForm();
  const issue=problem(S.draft);
  if(issue){S.formError=issue[1];renderForm();S.nodes.form.querySelector(`[name="${issue[0]}"]`)?.focus();return;}
  const v=S.draft,c=S.correcting,entry={channel:v.channel,description:v.description,amountCents:K().cents(v.amount),firstDate:v.firstDate,lastDate:v.lastDate,receiptReference:v.receiptReference};
  void send({command:'spend.entry.record',entry,...(c?{supersedes:{entryId:c.id,revision:c.revision}}:{})},c?'Correction saved':'Spend entry saved');
}
function correct(entry){
  S.correcting={id:entry.id,revision:entry.revision};S.dirty=true;S.formError='';S.conflict=false;
  S.draft={channel:entry.channel,amount:(entry.amountCents/100).toFixed(2),firstDate:entry.firstDate,lastDate:entry.lastDate,description:entry.description,receiptReference:entry.receiptReference};
  renderForm();
  S.nodes.form.querySelector('[name="amount"]')?.focus();
}
async function voidEntry(entry){
  const values=await S.ctx.askAction({kicker:'OWNER SPEND LEDGER',title:'Void this spend entry?',copy:channelName(entry.channel)+' · '+money(entry.amountCents)+' · '+dayLabel(entry.firstDate)+' – '+dayLabel(entry.lastDate),
    fields:[{name:'reason',label:'Why is it void?',type:'text',maxlength:500,autocomplete:'off'}],confirmLabel:'Void entry',danger:true,note:'The entry is kept as voided and no longer counts.'});
  if(!S||!values)return;
  const reason=String(values.reason||'').trim();
  if(reason.length<3){S.ctx.toast?.('Give a short reason to void the entry.');return;}
  void send({command:'spend.entry.void',entryId:entry.id,revision:entry.revision,reason},'Entry voided');
}
async function retry(){
  const saved=S.pending.get();
  S.busy=true;S.formError='';S.conflict=false;renderForm();renderBody();
  try{await S.pending.replay({prefix:'spend',timeout:30000,fetcher:S.ctx.hubFetch,validate:d=>Boolean(d&&d.entry)});if(!S)return;S.busy=false;S.dirty=false;S.correcting=null;S.draft=blank();renderForm();S.ctx.toast?.('Saved');await load();}
  catch(error){if(!S)return;S.busy=false;S.formError=K().errorText(error,ERRORS);S.conflict=conflictKind(error,saved?.body?.body);renderForm();renderBody();}
}
function mount(host,ctx){
  unmount();
  const {h}=K(),month=presets(K().today(new Date()))[0];
  const nodes={head:h('div',{}),status:h('p',{class:'as-status',role:'status','aria-live':'polite'}),body:h('div',{class:'as-stack'}),form:h('div',{})};
  S={root:h('section',{class:'hub-screen egc-ad-spend'},nodes.head,nodes.status,nodes.body,nodes.form),nodes,ctx,gen:0,range:{preset:month.id,from:month.from,to:month.to},
    report:null,entries:null,error:'',loading:false,busy:false,dirty:false,correcting:null,draft:blank(),formError:'',conflict:false,moreBusy:false,moreError:'',pending:K().pending(SCREEN,ctx.identity)};
  host.append(S.root);
  renderHead();renderBody();renderForm();
  return load();
}
function unmount(){if(!S)return;S.gen++;S.root.remove();S=null;}
window.addEventListener('egc:signout',unmount);
window.EGCAdSpend=Object.freeze({mount,unmount,canLeave:()=>!S||(!S.dirty&&!S.busy),refresh:()=>S?load():undefined});
})();
