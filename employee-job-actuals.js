/* Job actuals (owner): every completed job in the last 90 days with billed versus actual man-hours, truck loads, goods
   at retail, commission by channel and an estimated gross margin and contribution, with totals for the last 30 and 90
   days and a CSV export. The server computes every figure (functions/_lib/job-actuals.js, GET /api/job-actuals) in
   integer cents; this screen only formats them. No margin shows until the owner enters the crew wage, and margins read
   "upper bound" until all seven cost settings are entered (wage, workers' comp, payroll tax, burden, dump fee, truck
   cost, goods tax) on the Cost settings card (POST /api/job-actuals, owner only; managers see them read-only). The owner
   also gets an Owner targets card (GET/POST /api/owner-economics, owner only, never shown to a manager): the labor
   baseline, lead wage, truck rental and sales targets the Playbook and Scorecard read. Registered in
   employee-hub-screens.js and runs standalone with the UI kit (window.EGCHubKit). */
(function(){
'use strict';
const SCREEN='job_actuals',PATH='/api/job-actuals',PREFIX='job_actuals';
const SETTINGS=[
  {key:'wageCentsPerManHour',label:'Crew wage per man-hour',unit:'$',help:'Average hourly wage paid to crew. No margin is shown until this is set.',kind:'money'},
  {key:'workersCompBp',label:"Workers' comp",unit:'%',help:'Workers\' comp as a percent of wages.',kind:'percent'},
  {key:'payrollTaxBp',label:'Payroll tax',unit:'%',help:'Employer payroll tax as a percent of wages, e.g. 7.65.',kind:'percent'},
  {key:'burdenCentsPerManHour',label:'Other burden per man-hour',unit:'$',help:'Insurance, PTO and other cost per hour worked.',kind:'money'},
  {key:'dumpFeeCentsPerLoad',label:'Dump fee per truck load',unit:'$',help:'Average landfill or transfer fee for one load.',kind:'money'},
  {key:'truckCentsPerJob',label:'Truck cost per job',unit:'$',help:'Fuel, wear and truck payment spread per job.',kind:'money'},
  {key:'goodsTaxBp',label:'Tax on goods purchases',unit:'%',help:'Sales tax EGC pays buying goods, e.g. 7.55.',kind:'percent'}];
// The owner's targets and baselines (functions/_lib/owner-economics.js). The crew wage is the Cost settings wage, shown
// beside these but never entered twice.
const OWNER_PATH='/api/owner-economics',OWNER_PREFIX='owner_economics',OWNER_SCREEN='job_actuals_owner';
const TARGETS=[
  {key:'laborCostCentsPerCrewHour',label:'Labor cost per crew-hour',unit:'$',help:'Estimates labor on Job finances until a job\'s actual cost is entered.',kind:'money'},
  {key:'leadWageCentsPerHour',label:'Lead wage per hour',unit:'$',help:'Shown with the crew wage on the Playbook.',kind:'money'},
  {key:'truckRentalLowCentsPerJob',label:'Truck rental per job, low',unit:'$',help:'What an owned truck saves per job, low end.',kind:'money'},
  {key:'truckRentalHighCentsPerJob',label:'Truck rental per job, high',unit:'$',help:'High end. Leave either blank if unknown.',kind:'money'},
  {key:'averageTicketTargetCents',label:'Average ticket target',unit:'$',help:'Scorecard and Playbook target.',kind:'money'},
  {key:'walkthroughSetRateTargetBp',label:'Walkthrough set rate target',unit:'%',help:'Leads that book a walkthrough.',kind:'percent'},
  {key:'qualifiedCloseRateTargetBp',label:'Qualified close rate target',unit:'%',help:'Quotes that become jobs.',kind:'percent'}];
const LIMITS={wageCentsPerManHour:20000,workersCompBp:5000,payrollTaxBp:5000,burdenCentsPerManHour:10000,dumpFeeCentsPerLoad:500000,truckCentsPerJob:500000,goodsTaxBp:2500,
  laborCostCentsPerCrewHour:20000,leadWageCentsPerHour:20000,truckRentalLowCentsPerJob:500000,truckRentalHighCentsPerJob:500000,averageTicketTargetCents:10000000,walkthroughSetRateTargetBp:10000,qualifiedCloseRateTargetBp:10000};
const CHANNEL={direct_estimator:'Estimator 7%',appointment_setter:'Setter 13% + estimator 7%',door_sale:'Door sale 25%',junk_only:'Junk-only 0%',none:'None'};
// Row reasons worth a word on the row. ≤ marks any upper bound; a blank setting (cost_settings_incomplete) is told by the
// warning above the totals and 'actual_hours_missing' by the Actual cell, so neither repeats here.
const REASON={loads_quoted:'Dump cost from quoted loads',loads_unknown:'Truck loads not recorded',revenue_unreconciled:'Revenue not final: refund or unbilled change',timecards_unavailable:'Timecards could not be read',timecards_incomplete:'Timecards incomplete (open shift or review)',crew_lead_exceeds_timecards:'Crew lead count used: above timecards',wage_unset:'No crew wage set',goods_unknown:'Goods unknown: no estimate lines',revenue_unknown:'Revenue unknown'};
const SOURCE={timecards:'Timecards',crew_lead:'Crew lead',not_recorded:'Not recorded'};
const S={host:null,ctx:null,data:null,error:null,loading:false,busy:false,pending:null,drafts:{},feedback:'',feedbackError:false,generation:0,showAll:false};
const O={data:null,error:null,busy:false,pending:null,drafts:{},feedback:'',feedbackError:false,generation:0};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const int=value=>Number.isSafeInteger(value);
const money=value=>int(value)?kit().money(value):'—';
const hours=value=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(2):'—';
const signed=(value,format)=>typeof value==='number'&&Number.isFinite(value)?(value>0?'+':'')+format(value):'—';
const pct=value=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(1)+'%':'—';
const day=value=>{try{return value?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(value+'T12:00:00Z')):'—';}catch{return'—';}};
function validTotals(t){return Boolean(t&&int(t.jobs)&&int(t.revenueCents)&&int(t.commissionCents)&&int(t.marginCommissionCents)&&int(t.grossMarginCents)&&typeof t.upperBound==='boolean');}
function validRow(r){return Boolean(r&&typeof r.jobId==='string'&&r.billed&&r.actual&&r.truckLoads&&int(r.truckLoads.count)&&r.commission&&Array.isArray(r.commission.lines)&&int(r.commission.totalCents)&&(r.revenueCents===null||int(r.revenueCents))&&(r.grossMarginCents===null||int(r.grossMarginCents))&&Array.isArray(r.reasons));}
function valid(data){
  return Boolean(data&&data.ok===true&&data.window&&data.totals&&validTotals(data.totals.last30)&&validTotals(data.totals.last90)&&Array.isArray(data.rows)&&data.rows.every(validRow)
    &&data.settings&&typeof data.canEdit==='boolean'&&SETTINGS.every(s=>data.settings[s.key]===null||int(data.settings[s.key])));
}
const validSave=data=>Boolean(data&&data.ok===true&&data.settings&&SETTINGS.every(s=>data.settings[s.key]===null||int(data.settings[s.key])));
// Settings text as the owner typed it, and what it means: {value: integer|null} or {bad:true}.
const shown=(setting,value)=>value===null||value===undefined?'':setting.kind==='percent'?String(value/100):(value/100).toFixed(2);
function parsed(setting,text){
  const trimmed=String(text??'').trim().replace(/%$/,'').trim();
  if(!trimmed)return{value:null};
  let value;
  if(setting.kind==='percent'){const m=/^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(trimmed);value=m?Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')):null;}
  else value=kit().cents(trimmed);
  return value===null||value<0||value>LIMITS[setting.key]?{bad:true}:{value};
}
function changes(fields=SETTINGS,state=S){
  const settings={},bad=[];let changed=false;
  for(const s of fields){
    const saved=state.data?.settings?.[s.key]??null,text=Object.hasOwn(state.drafts,s.key)?state.drafts[s.key]:shown(s,saved),result=parsed(s,text);
    if(result.bad){bad.push(s.key);settings[s.key]=saved;continue;}
    settings[s.key]=result.value;if(result.value!==saved)changed=true;
  }
  return{settings,bad,changed};
}
async function load(){
  const generation=++S.generation;S.loading=true;S.error=null;render();
  try{const data=await kit().requestJSON(PATH,{prefix:PREFIX,validate:valid,fetcher:fetcher()});if(generation===S.generation)S.data=data;}
  catch(error){if(generation===S.generation)S.error=error;}
  finally{if(generation===S.generation){S.loading=false;S.pending=kit().pending(SCREEN).get();if(S.pending)keepEdits(S.pending.body?.settings);render();if(S.data?.canEdit)loadOwner();}}
}
const queue=()=>kit().pending(SCREEN);
// The settings a save changed, kept beside the kit's pending request (sessionStorage, this viewer) so that after a reload
// the locked inputs show what the unconfirmed save would apply, and a revision conflict hands those edits back as drafts.
// Only the keys the owner changed: the request also repeats every untouched setting, which must not undo another save.
const EDITED='egc.jobactuals.edited.v1.';
const editedKey=()=>{try{return EDITED+String(sessionStorage.getItem('egc_u')||'').trim().toLowerCase();}catch{return EDITED;}};
function rememberEdited(keys){try{sessionStorage.setItem(editedKey(),JSON.stringify(keys));}catch{}}
function editedKeys(){try{const keys=JSON.parse(sessionStorage.getItem(editedKey())||'[]');return Array.isArray(keys)?keys:[];}catch{return[];}}
function forgetEdited(){try{sessionStorage.removeItem(editedKey());}catch{}}
function keepEdits(settings){
  if(!settings||typeof settings!=='object')return;
  const keys=new Set(editedKeys());
  for(const setting of SETTINGS)if(keys.has(setting.key)&&Object.hasOwn(settings,setting.key)&&!Object.hasOwn(S.drafts,setting.key))S.drafts[setting.key]=shown(setting,settings[setting.key]);
}
const SAVE_ERRORS={job_actuals_owner_required:'Only the owner can change cost settings.',job_actuals_no_change:'These settings are already saved.'};
// A save whose outcome is unknown stays pending (the kit keeps the exact request): the owner retries that same request
// or discards it before any new edit is saved, as on Stocked item costs, so a newer edit is never replaced by the old one.
async function settle(send,settings){
  S.busy=true;S.feedback='';render();
  try{
    const data=await send();
    S.drafts={};forgetEdited();refreshOwnerPricing();S.feedback=data.replayed?'These settings were already saved.':'Cost settings saved. Margins are recalculated.';S.feedbackError=false;S.busy=false;
    await load();return;
  }catch(error){
    if(error.code==='job_actuals_revision_conflict'){keepEdits(settings);forgetEdited();queue().discard();S.feedback='Cost settings changed elsewhere. The latest are loaded and your edits are kept; check them and save again.';S.feedbackError=true;S.busy=false;await load();return;}
    S.feedback=kit().errorText(error,SAVE_ERRORS);S.feedbackError=true;
  }
  S.busy=false;S.pending=queue().get();render();
}
function retryPending(){if(!S.busy&&S.pending){const settings=S.pending.body?.settings;settle(()=>queue().replay({prefix:PREFIX,validate:validSave,fetcher:fetcher()}),settings);}}
function discardPending(){queue().discard();forgetEdited();S.drafts={};S.pending=null;S.feedback='The unconfirmed save was discarded. Check the settings below before saving again.';S.feedbackError=false;load();}
async function save(){
  if(S.busy||S.pending||!S.data?.canEdit)return;
  const {settings,bad,changed}=changes();
  if(bad.length){S.feedback='Fix the highlighted settings: percents like 7.65, dollars like 42.50.';S.feedbackError=true;render();return;}
  if(!changed||S.pending)return;
  rememberEdited(SETTINGS.map(setting=>setting.key).filter(key=>settings[key]!==(S.data.settings[key]??null)));
  return settle(()=>queue().submit(PATH,{action:'job_actuals.settings.set',expectedRevision:S.data.settings.revision??null,settings},{prefix:PREFIX,validate:validSave,fetcher:fetcher()}),settings);
}
function exportCsv(){
  const rows=S.data?.rows||[];
  const num=value=>value===null||value===undefined?'':String(value),dollars=value=>int(value)?(value/100).toFixed(2):'';
  const head=['Job ID','Date','Customer','Revenue','Billed man-hours','Actual man-hours','Actual source','Variance man-hours','Variance %','Truck loads','Loads source','Goods retail','Goods cost','Labor cost','Dump','Truck','Commission channel','Commission','Gross margin','Gross margin %','Contribution','Upper bound','Notes'];
  const body=rows.map(r=>[r.jobId,r.date||'',r.customer,dollars(r.revenueCents),num(r.billed.manHours),num(r.actual.manHours),r.actual.source,num(r.varianceManHours),num(r.variancePercent),num(r.truckLoads.count),r.truckLoads.source,dollars(r.goodsRetailCents),dollars(r.goodsCostCents),dollars(r.laborCents),dollars(r.dumpCents),dollars(r.truckCents),r.commission.channel,dollars(r.commission.totalCents),dollars(r.grossMarginCents),num(r.grossMarginPercent),dollars(r.contributionCents),r.upperBound?'yes':'no',r.reasons.join(' ')]);
  // Numbers stay plain (a leading minus is a number, not a formula); text cells get the kit's formula guard.
  const cell=value=>/^-?\d+(?:\.\d+)?$/.test(value)?value:kit().csvCell(value);
  const text=[head,...body].map(row=>row.map(cell).join(',')).join('\r\n');
  const blob=new Blob([text],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`egc-job-actuals-${S.data.window.today}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function stat(label,value,detail){return h('div',{class:'ja-stat'},h('span',{class:'ja-stat-label'},label),h('strong',{},value),detail?h('small',{},detail):null);}
function totalsCard(title,t){
  const bound=t.upperBound?' (upper bound)':'';
  return h('section',{class:'hub-card ja-totals','aria-label':title},h('h2',{},title),
    h('div',{class:'ja-stats'},
      stat('Revenue',money(t.revenueCents),`${t.jobs} completed job${t.jobs===1?'':'s'}`),
      stat('Billed vs actual',`${hours(t.billedManHours)} → ${hours(t.actualManHours)} h`,t.comparedJobs?`${signed(t.varianceManHours,hours)} h (${signed(t.variancePercent,pct)}) on ${t.comparedJobs} job${t.comparedJobs===1?'':'s'}`:'No job has both yet'),
      stat('Gross margin'+bound,money(t.marginJobs?t.grossMarginCents:null),t.marginJobs?`${pct(t.grossMarginPercent)} on ${money(t.marginRevenueCents)} (${t.marginJobs} job${t.marginJobs===1?'':'s'} with hours)`:'Needs actual hours'),
      stat('Contribution'+bound,money(t.marginJobs?t.contributionCents:null),t.marginJobs?`after ${money(t.marginCommissionCents)} commission on those jobs (${money(t.commissionCents)} on all)`:`${money(t.commissionCents)} commission on all jobs`),
      stat('Truck loads',String(t.truckLoads),`Goods at retail ${money(t.goodsRetailCents)}`)));
}
function settingsCard(){
  const d=S.data,editable=d.canEdit,{bad,changed}=changes();
  const rows=SETTINGS.map(s=>{
    const saved=d.settings[s.key]??null,text=Object.hasOwn(S.drafts,s.key)?S.drafts[s.key]:shown(s,saved),isBad=bad.includes(s.key);
    if(!editable)return h('div',{class:'ja-setting'},h('span',{},s.label),h('strong',{},saved===null?'Not set':s.kind==='percent'?(saved/100)+'%':money(saved)));
    const input=h('input',{type:'text',inputmode:'decimal',autocomplete:'off',placeholder:'Not set',maxlength:12,value:text,disabled:S.busy||Boolean(S.pending),'aria-label':`${s.label} (${s.unit==='%'?'percent':'dollars'})`,'aria-invalid':isBad?'true':'false','data-setting':s.key,
      oninput:event=>{S.drafts[s.key]=event.target.value;refreshBar();}});
    return h('label',{class:'ja-setting ja-setting-edit'+(isBad?' bad':'')},h('span',{},s.label,h('small',{},s.help)),h('span',{class:'ja-input'},s.unit==='$'?h('span',{'aria-hidden':'true'},'$'):null,input,s.unit==='%'?h('span',{'aria-hidden':'true'},'%'):null));
  });
  return h('section',{class:'hub-card ja-settings','aria-label':'Cost settings'},
    h('h2',{},'Cost settings'),
    h('p',{class:'ja-muted'},'Labor costs use the crew wage below, never anyone\'s own pay rate. Without a wage no margin is shown; any other blank cost counts as $0, so margins stay an upper bound until all of them are set.'+(editable?'':' Only the owner can change them.')),
    h('div',{class:'ja-setting-list'},rows),
    editable&&S.pending?h('div',{class:'hub-notice warning ja-pending',role:'alert'},h('p',{},'A save was not confirmed. Retry it to check whether it was applied (it is never applied twice), or discard it before making new changes.'),
      h('div',{class:'hub-actions'},kit().button(S.busy?'Retrying…':'Retry original save',retryPending,'primary',{disabled:S.busy}),kit().button('Discard unconfirmed save',discardPending,'',{disabled:S.busy}))):null,
    editable?h('div',{class:'ja-save'},kit().button(S.busy?'Saving…':'Save cost settings',save,'primary',{disabled:S.busy||Boolean(S.pending)||!changed||bad.length>0,'data-save':''}),h('span',{class:'ja-muted','data-bar':''},barText(bad,changed))):null,
    S.feedback?h('p',{role:S.feedbackError?'alert':'status',class:'ja-feedback'+(S.feedbackError?' error':'')},S.feedback):null);
}
const barText=(bad,changed)=>bad.length?`${bad.length} to fix`:changed?'Unsaved changes':'';
// Typing updates only the save button and its note, so focus is never lost to a re-render.
function refreshBar(){
  const root=S.host?.querySelector('.ja-settings:not(.ja-owner)');if(!root)return;
  const {bad,changed}=changes(),save=root.querySelector('[data-save]'),note=root.querySelector('[data-bar]');
  if(save)save.disabled=S.busy||Boolean(S.pending)||!changed||bad.length>0;if(note)note.textContent=barText(bad,changed);
  for(const input of root.querySelectorAll('[data-setting]')){const isBad=bad.includes(input.getAttribute('data-setting'));input.setAttribute('aria-invalid',isBad?'true':'false');input.closest('.ja-setting')?.classList.toggle('bad',isBad);}
}
// Owner targets: the same save pattern as Cost settings (the kit's pending request, Retry or Discard, edits kept on a
// revision conflict), on its own pending slot and edited-keys record so the two cards never replace each other's save.
const ownerQueue=()=>kit().pending(OWNER_SCREEN);
// The Hub keeps the owner part of /api/pricing-config in memory (employee-pricing.js): fetch it again after a save here
// or on Cost settings (the crew wage), so the Playbook and Scorecard show the saved numbers.
function refreshOwnerPricing(){const pricing=window.EGCPricingConfig;if(pricing&&typeof pricing.forget==='function'){pricing.forget('owner');pricing.load('owner');}}
const OWNER_EDITED='egc.jobactuals.owneredited.v1.';
const ownerEditedKey=()=>{try{return OWNER_EDITED+String(sessionStorage.getItem('egc_u')||'').trim().toLowerCase();}catch{return OWNER_EDITED;}};
function rememberOwnerEdited(keys){try{sessionStorage.setItem(ownerEditedKey(),JSON.stringify(keys));}catch{}}
function ownerEditedKeys(){try{const keys=JSON.parse(sessionStorage.getItem(ownerEditedKey())||'[]');return Array.isArray(keys)?keys:[];}catch{return[];}}
function forgetOwnerEdited(){try{sessionStorage.removeItem(ownerEditedKey());}catch{}}
function keepOwnerEdits(settings){
  if(!settings||typeof settings!=='object')return;
  const keys=new Set(ownerEditedKeys());
  for(const setting of TARGETS)if(keys.has(setting.key)&&Object.hasOwn(settings,setting.key)&&!Object.hasOwn(O.drafts,setting.key))O.drafts[setting.key]=shown(setting,settings[setting.key]);
}
const validOwner=data=>Boolean(data&&data.ok===true&&data.settings&&TARGETS.every(s=>data.settings[s.key]===null||int(data.settings[s.key])));
const validOwnerRead=data=>validOwner(data)&&(data.crewWageCentsPerManHour===null||int(data.crewWageCentsPerManHour));
async function loadOwner(){
  const generation=++O.generation;O.error=null;
  try{const data=await kit().requestJSON(OWNER_PATH,{prefix:OWNER_PREFIX,validate:validOwnerRead,fetcher:fetcher()});if(generation===O.generation)O.data=data;}
  catch(error){if(generation===O.generation)O.error=error;}
  finally{if(generation===O.generation){O.pending=ownerQueue().get();if(O.pending)keepOwnerEdits(O.pending.body?.settings);render();}}
}
const OWNER_ERRORS={owner_economics_owner_required:'Only the owner can change these targets.',owner_economics_no_change:'These targets are already saved.',owner_economics_amount_invalid:'Check the highlighted targets: the low truck rental cannot be above the high one.'};
async function settleOwner(send,settings){
  O.busy=true;O.feedback='';render();
  try{
    const data=await send();
    O.drafts={};forgetOwnerEdited();refreshOwnerPricing();O.feedback=data.replayed?'These targets were already saved.':'Owner targets saved. The Playbook and Scorecard now use them.';O.feedbackError=false;O.busy=false;
    await loadOwner();return;
  }catch(error){
    if(error.code==='owner_economics_revision_conflict'){keepOwnerEdits(settings);forgetOwnerEdited();ownerQueue().discard();O.feedback='Owner targets changed elsewhere. The latest are loaded and your edits are kept; check them and save again.';O.feedbackError=true;O.busy=false;await loadOwner();return;}
    O.feedback=kit().errorText(error,OWNER_ERRORS);O.feedbackError=true;
  }
  O.busy=false;O.pending=ownerQueue().get();render();
}
function retryOwner(){if(!O.busy&&O.pending){const settings=O.pending.body?.settings;settleOwner(()=>ownerQueue().replay({prefix:OWNER_PREFIX,validate:validOwner,fetcher:fetcher()}),settings);}}
function discardOwner(){ownerQueue().discard();forgetOwnerEdited();O.drafts={};O.pending=null;O.feedback='The unconfirmed save was discarded. Check the targets below before saving again.';O.feedbackError=false;loadOwner();}
async function saveOwner(){
  if(O.busy||O.pending||!O.data)return;
  const {settings,bad,changed}=changes(TARGETS,O);
  if(bad.length){O.feedback='Fix the highlighted targets: percents like 50, dollars like 42.50.';O.feedbackError=true;render();return;}
  if(!changed)return;
  rememberOwnerEdited(TARGETS.map(setting=>setting.key).filter(key=>settings[key]!==(O.data.settings[key]??null)));
  return settleOwner(()=>ownerQueue().submit(OWNER_PATH,{action:'owner_economics.settings.set',expectedRevision:O.data.settings.revision??null,settings},{prefix:OWNER_PREFIX,validate:validOwner,fetcher:fetcher()}),settings);
}
function ownerCard(){
  if(!O.data)return h('section',{class:'hub-card ja-settings ja-owner','aria-label':'Owner targets'},h('h2',{},'Owner targets'),
    O.error?[h('div',{class:'hub-notice error',role:'alert'},'Owner targets are unavailable. '+kit().errorText(O.error)),kit().button('Retry',loadOwner,'primary')]:h('p',{class:'ja-muted'},'Loading owner targets…'));
  const {bad,changed}=changes(TARGETS,O),wage=O.data.crewWageCentsPerManHour;
  const rows=TARGETS.map(s=>{
    const saved=O.data.settings[s.key]??null,text=Object.hasOwn(O.drafts,s.key)?O.drafts[s.key]:shown(s,saved),isBad=bad.includes(s.key);
    const input=h('input',{type:'text',inputmode:'decimal',autocomplete:'off',placeholder:'Not set',maxlength:12,value:text,disabled:O.busy||Boolean(O.pending),'aria-label':`${s.label} (${s.unit==='%'?'percent':'dollars'})`,'aria-invalid':isBad?'true':'false','data-target':s.key,
      oninput:event=>{O.drafts[s.key]=event.target.value;refreshOwnerBar();}});
    return h('label',{class:'ja-setting ja-setting-edit'+(isBad?' bad':'')},h('span',{},s.label,h('small',{},s.help)),h('span',{class:'ja-input'},s.unit==='$'?h('span',{'aria-hidden':'true'},'$'):null,input,s.unit==='%'?h('span',{'aria-hidden':'true'},'%'):null));
  });
  return h('section',{class:'hub-card ja-settings ja-owner','aria-label':'Owner targets'},
    h('h2',{},'Owner targets'),
    h('p',{class:'ja-muted'},'Only you see these. The Playbook, Scorecard and Job finances use them; a blank one shows generic text, never a guessed number.'),
    h('div',{class:'ja-setting-list'},
      h('div',{class:'ja-setting'},h('span',{},'Crew wage per hour',h('small',{},'The crew wage from Cost settings above, so there is one number.')),h('strong',{},wage===null?'Not set':money(wage))),
      rows),
    O.pending?h('div',{class:'hub-notice warning ja-pending',role:'alert'},h('p',{},'A save was not confirmed. Retry it to check whether it was applied (it is never applied twice), or discard it before making new changes.'),
      h('div',{class:'hub-actions'},kit().button(O.busy?'Retrying…':'Retry original save',retryOwner,'primary',{disabled:O.busy}),kit().button('Discard unconfirmed save',discardOwner,'',{disabled:O.busy}))):null,
    h('div',{class:'ja-save'},kit().button(O.busy?'Saving…':'Save owner targets',saveOwner,'primary',{disabled:O.busy||Boolean(O.pending)||!changed||bad.length>0,'data-save':''}),h('span',{class:'ja-muted','data-bar':''},barText(bad,changed))),
    O.feedback?h('p',{role:O.feedbackError?'alert':'status',class:'ja-feedback'+(O.feedbackError?' error':'')},O.feedback):null);
}
function refreshOwnerBar(){
  const root=S.host?.querySelector('.ja-owner');if(!root)return;
  const {bad,changed}=changes(TARGETS,O),save=root.querySelector('[data-save]'),note=root.querySelector('[data-bar]');
  if(save)save.disabled=O.busy||Boolean(O.pending)||!changed||bad.length>0;if(note)note.textContent=barText(bad,changed);
  for(const input of root.querySelectorAll('[data-target]')){const isBad=bad.includes(input.getAttribute('data-target'));input.setAttribute('aria-invalid',isBad?'true':'false');input.closest('.ja-setting')?.classList.toggle('bad',isBad);}
}
function jobRow(r){
  const variance=r.varianceManHours===null?'—':`${signed(r.varianceManHours,hours)} (${signed(r.variancePercent,pct)})`;
  const commission=r.commission.lines.length?r.commission.lines.map(line=>`${line.role} ${money(line.cents)}`).join(' + '):'—';
  const margin=r.grossMarginCents===null?'—':`${money(r.grossMarginCents)} · ${pct(r.grossMarginPercent)}${r.upperBound?' ≤':''}`;
  // Each cell's content sits in one span, so on a phone the cell is one "label: value" row.
  const cell=(label,cls,...children)=>h('td',{'data-label':label,class:cls},h('span',{class:'ja-cell'},...children));
  return h('tr',{'data-job':r.jobId,class:r.varianceManHours>0?'over':''},
    cell('Date','',day(r.date)),
    h('th',{scope:'row','data-label':'Customer'},h('span',{class:'ja-cell'},h('a',{href:`/crew/job.html?jobId=${encodeURIComponent(r.jobId)}`},r.customer||r.jobId),h('small',{},CHANNEL[r.commission.channel]||''))),
    cell('Revenue','num',money(r.revenueCents)),
    cell('Billed h','num',r.billed.manHours===null?(r.billed.source==='junk_only'?'Junk only':'No labor line'):hours(r.billed.manHours)),
    cell('Actual h','num',hours(r.actual.manHours),h('small',{},SOURCE[r.actual.source]||'')),
    cell('Variance','num ja-variance',variance),
    cell('Loads','num',String(r.truckLoads.count),h('small',{},r.truckLoads.source==='crew_lead'?'Crew lead':r.truckLoads.source==='quote'?'Quoted':'Not recorded')),
    cell('Goods (retail)','num',money(r.goodsRetailCents)),
    cell('Commission','num',money(r.commission.totalCents),r.commission.lines.length>1?h('small',{},commission):null),
    cell('Gross margin','num',margin,...r.reasons.filter(code=>REASON[code]).map(code=>h('small',{class:'ja-reason','data-reason':code},REASON[code]))),
    cell('Contribution','num',money(r.contributionCents)));
}
function table(){
  const rows=S.data.rows,visible=S.showAll?rows:rows.slice(0,50);
  if(!rows.length)return h('div',{class:'hub-card'},h('p',{},'No completed jobs in the last 90 days.'));
  return h('section',{class:'hub-card ja-jobs','aria-label':'Completed jobs'},
    h('h2',{},'Completed jobs'),
    h('div',{class:'hub-table-scroll ja-table-scroll'},h('table',{class:'ja-table'},
      h('thead',{},h('tr',{},['Date','Customer','Revenue','Billed h','Actual h','Variance','Loads','Goods (retail)','Commission','Gross margin','Contribution'].map(text=>h('th',{scope:'col'},text)))),
      h('tbody',{},visible.map(jobRow)))),
    rows.length>visible.length?kit().button(`Show all ${rows.length} jobs`,()=>{S.showAll=true;render();}):null,
    h('p',{class:'ja-muted'},'Actual hours come from timecards clocked onto the job; without them, the crew lead\'s people × hours at Complete. ≤ marks a margin that is an upper bound.'));
}
function render(){
  if(!S.host)return;
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'OWNER'),h('h1',{},'Job actuals'),h('p',{},'Completed jobs in the last 90 days: billed versus actual man-hours and an estimated margin.')),
    h('div',{class:'hub-actions'},kit().button('Export CSV',exportCsv,'',{disabled:!S.data?.rows?.length}),kit().button(S.loading?'Loading…':'Refresh',load,'',{disabled:S.loading})));
  let body;
  if(S.error&&!S.data)body=[h('div',{class:'hub-notice error',role:'alert'},'Job actuals are unavailable. '+kit().errorText(S.error)),kit().button('Retry',load,'primary')];
  else if(!S.data)body=[h('p',{class:'hub-screen-loading'},'Loading job actuals…')];
  else{
    const d=S.data,notices=[];
    if(!d.settingsComplete)notices.push(h('div',{class:'hub-notice warning'},d.missingSettings.includes('wageCentsPerManHour')?'No margins yet: enter the crew wage in Cost settings below.':`Margins are an upper bound: ${d.missingSettings.length} of ${SETTINGS.length} cost settings ${d.missingSettings.length===1?'is':'are'} blank.`));
    if(d.sources?.timecards==='unavailable')notices.push(h('div',{class:'hub-notice warning'},'Timecards could not be read, so actual hours show only where the crew lead confirmed them. Refresh to try again.'));
    if(S.error)notices.push(h('div',{class:'hub-notice error',role:'alert'},kit().errorText(S.error)));
    body=[...notices,h('div',{class:'ja-totals-grid'},totalsCard('Last 30 days',d.totals.last30),totalsCard('Last 90 days',d.totals.last90)),table(),settingsCard(),...(d.canEdit?[ownerCard()]:[])];
  }
  const root=h('section',{class:'hub-screen egc-job-actuals'},head,...body);
  S.host.querySelector('.egc-job-actuals')?.remove();
  S.host.append(root);
}
function mount(host,ctx){S.host=host;S.ctx=ctx||{};S.data=null;S.error=null;S.drafts={};S.feedback='';S.showAll=false;Object.assign(O,{data:null,error:null,busy:false,pending:null,drafts:{},feedback:'',feedbackError:false});return load();}
function unmount(){S.generation++;O.generation++;S.host?.querySelector('.egc-job-actuals')?.remove();S.host=null;S.ctx=null;}
window.addEventListener('egc:signout',()=>{try{for(let i=sessionStorage.length-1;i>=0;i--){const name=sessionStorage.key(i);if(String(name||'').startsWith(EDITED)||String(name||'').startsWith(OWNER_EDITED))sessionStorage.removeItem(name);}}catch{}});
window.EGCJobActuals={mount,unmount,canLeave:()=>!changes().changed&&!(O.data&&changes(TARGETS,O).changed)||window.confirm('Discard unsaved cost settings?'),refresh:load};
})();
