/* Native EGC dispatch. Canonical records and authorization live in /api/dispatch. */
(function () {
'use strict';
const TZ = 'America/Denver';
const terminal = new Set(['completed', 'cancelled', 'canceled', 'paid', 'invoiced', 'review_requested', 'closed']);
const active = job => !terminal.has(job.status || job.pipelineStatus);
const S = { host:null, root:null, date:today(), view:'day', query:'', status:'active', employee:'', type:'', data:null, loading:false, generation:0, modal:null, refreshTimer:null, pending:false, error:'', notice:'', controller:null };
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && !key.startsWith('aria-')) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const btn = (label, onClick, kind='', props={}) => h('button', {type:'button', class:'dp-btn '+kind, onclick:onClick, ...props}, label);
const pill = (text, kind='') => h('span', {class:'dp-pill '+kind}, text);
const words = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const key = () => crypto.randomUUID();
function today() { return new Intl.DateTimeFormat('en-CA', {timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date()); }
function addDays(date, count) { return new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10); }
function dateText(date, short=false) { return new Intl.DateTimeFormat('en-US', {timeZone:'UTC', weekday:short?'short':'long', month:short?'short':'long', day:'numeric'}).format(new Date(date+'T12:00:00Z')); }
function clock(value) { const match=/^(\d{2}):(\d{2})$/.exec(value || ''); if (!match) return 'Time needed'; const hour=Number(match[1]); return (hour%12||12)+':'+match[2]+' '+(hour<12?'AM':'PM'); }
function range() { return {startDate:S.date, endDate:addDays(S.date,S.view==='week'||S.view==='crew'?7:1)}; }
const person = id => S.data?.roster?.find(p => p.id === id)?.name || id || 'Unassigned';
const vehicle = id => S.data?.vehicles?.find(v => v.id === id)?.name || (id ? 'Vehicle unavailable' : 'No vehicle');
const crewName = job => S.data?.crews?.find(c => c.id === job.crewId)?.name || (job.assignedCrew?.length ? job.assignedCrew.map(person).join(', ') : 'Unassigned');
const scope = job => typeof job.jobInstructions === 'string' ? job.jobInstructions : job.jobInstructions?.customerGoal || job.jobInstructions?.scope || job.operationalScope?.text || job.scope || '';
const directions = address => 'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(address);
function errorText(error) {
  if (error.status===401) return 'Your sign-in expired. Sign in again, then retry this saved draft.';
  if (error.status===403) return 'Scheduling requires an authorized operations manager account.';
  if (error.code==='dispatch_revision_conflict' || /revision/.test(error.code||'')) return 'This record changed while you were editing. Your draft is preserved. Load the latest record before applying it again.';
  const conflicts = error.details?.conflicts;
  if (conflicts?.length) return 'Scheduling conflict: '+conflicts.map(c=>c.message||[words(c.code||c.type),c.employeeId?person(c.employeeId):'',c.jobId||''].filter(Boolean).join(' · ')).join('; ');
  return error.message || 'The request could not be verified. Retry the same request.';
}
async function api(query='', body=null, signal) {
  const response = await fetch('/api/dispatch'+query, {method:body?'POST':'GET', credentials:'same-origin', cache:'no-store', headers:body?{'Content-Type':'application/json'}:undefined, body:body?JSON.stringify(body):undefined, signal});
  const data = await response.json().catch(()=>({}));
  if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.error||'Dispatch is temporarily unavailable.'),{status:response.status,code:data.code,details:data.details});
  return data;
}
function notice(text, kind='') { return h('div', {class:'dp-notice '+kind, role:kind==='error'?'alert':'status'}, text); }
function signInLink() { return h('a',{class:'dp-btn',href:'/employee.html?view=schedule'},'Sign in to Employee Hub'); }
async function load({quiet=false}={}) {
  if (!S.root || S.modal || S.pending) return;
  const generation=++S.generation;
  S.controller?.abort(); S.controller=new AbortController();
  if (!quiet) {S.loading=true; S.error=''; render();}
  try {
    const r=range(), params=new URLSearchParams({...r,includeUnscheduled:'true'});
    const data=await api('?'+params, null, S.controller.signal);
    if (generation!==S.generation || !S.root) return;
    S.data=data; S.error='';
  } catch (error) { if (generation!==S.generation || error.name==='AbortError') return; if([401,403].includes(error.status))S.data=null; S.error=errorText(error); S.errorStatus=error.status; }
  finally { if (generation===S.generation && S.root) { S.loading=false; render(); } }
}
function setFilter(field,value) { S[field]=value; renderBody(); }
function move(count) { S.date=addDays(S.date,count*(S.view==='week'||S.view==='crew'?7:1)); void load(); }
function setDate(date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return; S.date=date; void load(); }
function filtered() {
  const q=S.query.toLowerCase().trim(), phone=q.replace(/\D/g,'');
  return (S.data?.jobs||[]).filter(j => (!S.employee || j.assignedCrew?.includes(S.employee)) &&
    (!S.type || j.type===S.type) && (S.status==='all' || (S.status==='active'?active(j):S.status==='unassigned'?active(j)&&!j.assignedCrew?.length:S.status==='unscheduled'?!j.date:j.status===S.status)) &&
    (!q || [j.customer,j.address,j.phone,j.id,j.date,j.serviceType,crewName(j)].some(v=>String(v||'').toLowerCase().includes(q)) || phone.length>2&&String(j.phone||'').replace(/\D/g,'').includes(phone)))
    .sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999'))||String(a.time||'').localeCompare(String(b.time||''))||String(a.customer||'').localeCompare(String(b.customer||'')));
}
function onDate(job,date) { return Boolean(job.date && job.date<=date && (job.endDate||job.date)>=date); }
function jobCard(job, {compact=false}={}) {
  const warnings=(S.data?.warnings||[]).filter(w=>w.jobId===job.id);
  const card=h('article',{class:'dp-job '+(active(job)?'':'dp-terminal'),draggable:active(job),
    ondragstart:e=>{e.dataTransfer.setData('text/plain',job.id);e.dataTransfer.effectAllowed='move';card.classList.add('dp-dragging');},
    ondragend:()=>card.classList.remove('dp-dragging')});
  const title=job.customer||job.title||'Customer needs attention';
  card.append(h('div',{class:'dp-job-top'},h('span',{class:'dp-time'},job.date?clock(job.time)+' – '+clock(job.endTime):'Unscheduled'),pill(words(job.status||'scheduled'),active(job)?'':'muted')));
  if (job.endDate&&job.endDate!==job.date) card.append(h('small',{class:'dp-muted'},dateText(job.date,true)+' → '+dateText(job.endDate,true)));
  card.append(h('h3',{},title),h('p',{class:'dp-service'},job.serviceType||words(job.type||'job')));
  if (job.address) card.append(h('a',{class:'dp-address',href:directions(job.address),target:'_blank',rel:'noopener'},job.address));
  else card.append(h('p',{class:'dp-missing'},'Address needed'));
  card.append(h('dl',{class:'dp-job-facts'},
    h('div',{},h('dt',{},'Crew'),h('dd',{},crewName(job))),
    h('div',{},h('dt',{},'Lead'),h('dd',{},person(job.crewLead))),
    h('div',{},h('dt',{},'Vehicle'),h('dd',{},vehicle(job.vehicleId)))));
  if (!compact&&scope(job)) card.append(h('p',{class:'dp-scope'},scope(job)));
  if (!compact&&job.requiredEquipment?.length) card.append(h('p',{class:'dp-equipment'},'Equipment: '+job.requiredEquipment.join(', ')));
  for (const warning of warnings.slice(0,3)) card.append(h('p',{class:'dp-warning'},warning.message||words(warning.code)));
  if (job.syncStatus==='pending'||job.syncStatus==='error') card.append(h('p',{class:'dp-warning'},'Customer calendar sync '+(job.syncStatus==='error'?'needs retry':'pending')));
  const actions=h('div',{class:'dp-card-actions'},h('a',{class:'dp-btn primary',href:job.type==='walkthrough'?'/crew/gameplan.html?walkthroughId='+encodeURIComponent(job.id):'/crew/job.html?jobId='+encodeURIComponent(job.id)},job.type==='walkthrough'?'Open walkthrough':'Open job'));
  if (active(job)) actions.append(btn('Edit / assign',()=>openJob(job)),btn('Cancel',()=>openStatus(job,'schedule.cancel'),'subtle'));
  if (['cancelled','canceled'].includes(job.status)) actions.append(btn('Restore',()=>openStatus(job,'schedule.restore')));
  card.append(actions);
  return card;
}
function empty(text='No jobs match these filters.') { return h('div',{class:'dp-empty'},h('h3',{},text),h('p',{},'Change the date or filters, or schedule work for a customer.'),btn('Create job',()=>openJob(),'primary')); }
function dayColumn(date,jobs) {
  const column=h('section',{class:'dp-day '+(date===today()?'dp-today':''),
    ondragover:e=>{if(e.dataTransfer.types.includes('text/plain')){e.preventDefault();e.dataTransfer.dropEffect='move';column.classList.add('dp-drop');}},
    ondragleave:()=>column.classList.remove('dp-drop'),
    ondrop:e=>{e.preventDefault();column.classList.remove('dp-drop');const job=S.data?.jobs.find(j=>j.id===e.dataTransfer.getData('text/plain'));if(job&&job.date!==date)openJob({...job},{moveTo:date});}
  },h('header',{class:'dp-day-head'},h('h2',{},dateText(date,true)),btn('+',()=>openJob(null,{date}),'',{'aria-label':'Schedule on '+dateText(date)})));
  const rows=jobs.filter(j=>onDate(j,date));
  column.append(...(rows.length?rows.map(j=>jobCard(j,{compact:S.view==='week'})):[h('p',{class:'dp-empty-day'},'No work scheduled')]));
  return column;
}
function renderBody() {
  const target=S.root?.querySelector('[data-dp-body]'); if(!target)return;
  target.replaceChildren();
  if(S.loading&&!S.data){target.append(h('p',{class:'dp-loading',role:'status'},'Loading the Hub schedule…'));return;}
  if(S.error) {target.append(notice(S.error,'error'),S.errorStatus===401?signInLink():btn('Retry',()=>load())); if(!S.data)return;}
  if(!S.data)return;
  if(S.data.coverage?.complete===false)target.append(notice('Some records could not be loaded. This schedule is incomplete; verify missing work before dispatching.','error'));
  if(S.notice)target.append(notice(S.notice));
  const all=S.data.jobs||[], dateJobs=all.filter(j=>onDate(j,S.date)), running=dateJobs.filter(j=>['dispatched','arrived','in_progress'].includes(j.status)), due=dateJobs.filter(active);
  const stats=h('div',{class:'dp-stats'});
  for(const [label,count]of [['Scheduled',dateJobs.length],['In progress',running.length],['Remaining',due.length],['Unassigned',due.filter(j=>!j.assignedCrew?.length).length],['Needs attention',(S.data.warnings||[]).filter(w=>all.some(j=>j.id===w.jobId&&onDate(j,S.date))).length]])stats.append(h('article',{},h('span',{},label),h('strong',{},count)));
  target.append(stats);
  const jobs=filtered();
  if(!jobs.length){target.append(empty());return;}
  const unscheduled=jobs.filter(j=>!j.date);
  if(S.view==='jobs') {
    target.append(h('div',{class:'dp-job-grid'},jobs.map(j=>jobCard(j))));
  } else if(S.view==='crew') {
    const groups=new Map();
    for(const job of jobs.filter(j=>j.date)){const id=job.crewId||job.assignedCrew?.slice().sort().join('|')||'unassigned';if(!groups.has(id))groups.set(id,[]);groups.get(id).push(job);}
    for(const rows of groups.values()) {
      const minutes=rows.reduce((n,j)=>n+Math.max(0,(Date.parse(j.endAt)-Date.parse(j.startAt))/60000||0),0);
      target.append(h('section',{class:'dp-crew-group'},h('header',{},h('h2',{},crewName(rows[0])),h('p',{class:'dp-muted'},rows.length+' jobs · '+(minutes/60).toFixed(1)+' scheduled hours')),h('div',{class:'dp-job-grid'},rows.map(j=>h('div',{},h('p',{class:'dp-date-label'},dateText(j.date,true)),jobCard(j))))));
    }
  } else {
    target.append(h('div',{class:S.view==='week'?'dp-week':'dp-day-board'},Array.from({length:S.view==='week'?7:1},(_,i)=>dayColumn(addDays(S.date,i),jobs))));
  }
  if(unscheduled.length&&S.view!=='jobs')target.append(h('section',{class:'dp-unscheduled'},h('h2',{},'Unscheduled work · '+unscheduled.length),h('div',{class:'dp-job-grid'},unscheduled.map(j=>jobCard(j)))));
  target.append(h('p',{class:'dp-footnote'},'All scheduling times use Mountain Time. '+(S.data.coverage?.asOf?'Updated '+new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(new Date(S.data.coverage.asOf))+'.':'')+' Drag a job onto a day to review its new time.'));
}
function labeled(label,control,help) {const id=control.id||'dp-'+key();control.id=id;return h('label',{class:'dp-field',htmlFor:id},h('span',{},label),control,help?h('small',{},help):null);}
function select(options,value,onChange,props={}) {return h('select',{onchange:e=>onChange(e.target.value),...props},options.map(([id,label])=>h('option',{value:id,selected:id===value},label)));}
function render() {
  if(!S.root||S.modal)return;
  const search=h('input',{type:'search',value:S.query,placeholder:'Customer, address, phone, job or date',oninput:e=>setFilter('query',e.target.value),'aria-label':'Search jobs'});
  S.root.replaceChildren(h('header',{class:'dp-header'},h('div',{},h('span',{class:'dp-eyebrow'},'EGC OPERATIONS'),h('h1',{},'Dispatch'),h('p',{},'Schedule, assign and run the day.')),h('div',{class:'dp-header-actions'},btn('Crews & vehicles',()=>openResources()),btn('Refresh',()=>load(),'',{disabled:S.loading}),btn('Create job',()=>openJob(),'primary',{disabled:!S.data}))));
  const modes=h('div',{class:'dp-modes',role:'group','aria-label':'Calendar view'});
  for(const [id,label]of [['day','Day'],['week','Week'],['crew','Crew'],['jobs','Jobs']])modes.append(btn(label,()=>{S.view=id;void load();},S.view===id?'selected':'',{'aria-pressed':S.view===id?'true':'false'}));
  S.root.append(h('div',{class:'dp-controls'},h('div',{class:'dp-date-controls'},btn('←',()=>move(-1),'',{'aria-label':'Previous period'}),labeled('Schedule date',h('input',{type:'date',value:S.date,onchange:e=>setDate(e.target.value)})),btn('→',()=>move(1),'',{'aria-label':'Next period'}),h('div',{class:'dp-date-shortcuts'},btn('Today',()=>setDate(today())),btn('Tomorrow',()=>setDate(addDays(today(),1))))),modes));
  S.root.append(h('div',{class:'dp-filters'},search,
    select([['active','Active work'],['all','All statuses'],['unassigned','Unassigned'],['unscheduled','Unscheduled'],['completed','Completed'],['cancelled','Cancelled']],S.status,v=>setFilter('status',v),{'aria-label':'Filter by status'}),
    select([['','All employees'],...(S.data?.roster||[]).map(p=>[p.id,p.name])],S.employee,v=>setFilter('employee',v),{'aria-label':'Filter by employee'}),
    select([['','All work types'],['job','Jobs'],['walkthrough','Walkthroughs']],S.type,v=>setFilter('type',v),{'aria-label':'Filter by work type'})));
  S.root.append(h('div',{'data-dp-body':''}));renderBody();
}
function modal(title,description) {
  if(S.modal)return null;
  const previousFocus=document.activeElement;
  const dialog=h('dialog',{class:'dp-dialog','aria-label':title});
  const form=h('form',{class:'dp-form'});
  const status=h('div',{class:'dp-form-status','aria-live':'polite'});
  const close=()=>{if(S.pending||model.request)return;dialog.close();dialog.remove();S.modal=null;previousFocus?.focus();render();void load({quiet:true});};
  dialog.addEventListener('cancel',e=>{e.preventDefault();if(!S.pending)close();});
  dialog.addEventListener('click',e=>{if(e.target===dialog&&!S.pending){const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)close();}});
  form.append(h('header',{class:'dp-dialog-head'},h('div',{},h('h2',{},title),h('p',{},description)),btn('×',close,'',{'aria-label':'Close dialog'})));
  const fields=h('div',{class:'dp-form-grid'}),footer=h('footer',{class:'dp-dialog-foot'});
  form.append(fields,status,footer);dialog.append(form);document.body.append(dialog);
  const model={dialog,form,fields,footer,status,close,previousFocus,request:null};
  S.modal=model;dialog.showModal();return model;
}
function field(model,name,label,value='',type='text',extra={}) {const input=h(type==='textarea'?'textarea':'input',{name,type:type==='textarea'?undefined:type,value,...extra});model.fields.append(labeled(label,input));return input;}
function formBusy(model,busy) {
  S.pending=busy;
  if(busy){model.disabledState ||= new Map([...model.form.elements].map(control=>[control,control.disabled]));for(const control of model.form.elements)control.disabled=true;}
  else for(const control of model.form.elements)control.disabled=model.disabledState?.get(control)||false;
}
async function save(model,body,success) {
  if(S.pending)return;
  if(model.request&&JSON.stringify({...body,requestId:model.request.requestId})!==JSON.stringify(model.request)) {
    model.status.replaceChildren(notice('The previous save has an unknown outcome. Retry its unchanged request before changing this draft.','error'));return;
  }
  model.request ||= body;formBusy(model,true);model.status.replaceChildren(notice('Saving and verifying…'));
  try {
    const result=await api('',model.request);
    if(S.modal!==model)return;
    S.notice=success+(result.warnings?.length?' '+result.warnings.map(w=>w.message||words(w.code)).join(' '):'')+(result.providerSync==='pending'?' Customer calendar sync is pending.':'');
    formBusy(model,false);model.request=null;model.close();await load();
  } catch(error) {
    if(S.modal!==model)return;
    formBusy(model,false);
    if(error.status&&error.status<500){model.request=null;model.disabledState=null;}
    model.status.replaceChildren(notice(errorText(error),'error'));
    if(error.status===401)model.status.append(signInLink());
    if(/revision/.test(error.code||''))model.status.append(btn('Discard draft and load latest',()=>{model.close();void load();}));
    if(model.request) {
      for(const input of model.form.querySelectorAll('input,textarea,select'))input.disabled=true;
      model.status.append(h('p',{},'Your draft is kept here. Retry the original save to avoid duplicates.'),btn('Retry original save',()=>save(model,model.request,success),'primary'));
    }
  }
}
function openJob(job=null,options={}) {
  if(!S.data)return;
  const model=modal(job?'Edit / assign job':'Create job','Times are Mountain Time. Conflicting employee and vehicle assignments are blocked.');if(!model)return;
  let selectedCustomer=job?.customerId?{id:job.customerId,name:job.customer,address:job.address,phone:job.phone}:null;
  const search=field(model,'customerSearch','Customer',job?.customer||'','search',{required:!job,readOnly:!!job,autocomplete:'off',placeholder:'Search existing customers'});
  const customerResults=h('div',{class:'dp-customer-results',role:'status'});search.parentElement.append(customerResults);
  let customerGeneration=0;
  search.addEventListener('input',async()=>{
    if(job)return;selectedCustomer=null;const g=++customerGeneration,q=search.value.trim();if(q.length<2){customerResults.replaceChildren(h('small',{},'Type at least 2 characters.'));return;}
    customerResults.replaceChildren(h('small',{},'Searching…'));
    try{const r=await api('?'+new URLSearchParams({view:'customers',q}));if(g!==customerGeneration||S.modal!==model)return;customerResults.replaceChildren(...r.customers.map(c=>btn(c.name+' · '+(c.phone||c.address||'No contact details'),()=>{selectedCustomer=c;search.value=c.name;address.value=c.address||'';customerResults.replaceChildren(h('small',{},'Customer selected'));})));if(!r.customers.length)customerResults.append(h('p',{},'No matching Hub customer. Create or link the customer in Customers first.'));}
    catch(error){if(g===customerGeneration)customerResults.replaceChildren(notice(errorText(error),'error'));}
  });
  const type=select([['job','Service job'],['walkthrough','Walkthrough']],job?.type||'job',()=>{},{name:'type',disabled:!!job});
  model.fields.append(labeled('Work type',type));
  const service=field(model,'serviceType','Service',job?.serviceType||'','text',{required:true,maxLength:200,placeholder:'Garage cleanout, organization, shelving…'});
  let date=options.moveTo||options.date||job?.date||S.date;
  const dayOffset=job?.date&&job?.endDate?Math.round((Date.parse(job.endDate+'T12:00Z')-Date.parse(job.date+'T12:00Z'))/86400000):0;
  const unscheduled=h('input',{type:'checkbox',checked:job?!job.date:false,name:'unscheduled'});
  model.fields.append(h('label',{class:'dp-check dp-wide'},unscheduled,h('span',{},'Keep unscheduled')));
  const startDate=field(model,'date','Start date',date,'date',{required:true});
  const startTime=field(model,'time','Start time',job?.time||'08:00','time',{required:true});
  const endDate=field(model,'endDate','End date',options.moveTo?addDays(date,dayOffset):(job?.endDate||date),'date',{required:true});
  const endTime=field(model,'endTime','End time',job?.endTime||'10:00','time',{required:true});
  const timing=[startDate,startTime,endDate,endTime];
  const toggle=()=>{for(const input of timing){input.disabled=unscheduled.checked;input.required=!unscheduled.checked;}};unscheduled.addEventListener('change',toggle);toggle();
  const duration=select([['','Set duration…'],['30','30 minutes'],['60','1 hour'],['90','90 minutes'],['120','2 hours'],['180','3 hours'],['240','4 hours'],['360','6 hours'],['480','8 hours']], '',value=>{
    if(!value||!startDate.value||!startTime.value)return;const minute=Number(startTime.value.slice(0,2))*60+Number(startTime.value.slice(3))+Number(value);endDate.value=addDays(startDate.value,Math.floor(minute/1440));endTime.value=String(Math.floor(minute/60)%24).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
  });model.fields.append(labeled('Expected duration',duration));
  const address=field(model,'address','Job address',job?.address||'','textarea',{maxLength:1000,rows:2});
  const assignments=h('fieldset',{class:'dp-assignment dp-wide'},h('legend',{},'Assigned employees'));
  const selected=new Set(job?.assignedCrew||[]);
  const checks=new Map();
  for(const member of S.data.roster||[]){const input=h('input',{type:'checkbox',value:member.id,checked:selected.has(member.id)});checks.set(member.id,input);assignments.append(h('label',{class:'dp-check'},input,h('span',{},member.name),h('small',{},words(member.role))));}
  for(const member of selected)if(!checks.has(member)){const input=h('input',{type:'checkbox',value:member,checked:true});checks.set(member,input);assignments.append(h('label',{class:'dp-check'},input,h('span',{},member),h('small',{},'Unavailable employee — reassign before saving')));}
  if(!checks.size)assignments.append(h('p',{},'No active employees available. Review approved employee accounts.'));
  const crewSelect=select([['','Temporary / individual assignment'],...(S.data.crews||[]).filter(c=>c.status==='active'||c.id===job?.crewId).map(c=>[c.id,c.name])],job?.crewId||'',id=>{
    const crew=S.data.crews.find(c=>c.id===id);if(!crew)return;
    for(const [member,input]of checks)input.checked=crew.memberIds.includes(member);lead.value=crew.leadId||'';
  },{name:'crewId'});
  model.fields.append(labeled('Saved crew',crewSelect),assignments);
  const lead=select([['','No lead assigned'],...(S.data.roster||[]).map(p=>[p.id,p.name])],job?.crewLead||'',()=>{}, {name:'crewLead'});
  const truck=select([['','No vehicle assigned'],...(S.data.vehicles||[]).filter(v=>v.status==='available'||v.id===job?.vehicleId).map(v=>[v.id,v.name+(v.status==='available'?'':' · '+words(v.status))])],job?.vehicleId||'',()=>{},{name:'vehicleId'});
  model.fields.append(labeled('Crew lead',lead),labeled('Vehicle / truck',truck));
  field(model,'crewNeeded','Required crew size',job?.crewNeeded||1,'number',{min:1,max:20,step:1,required:true});
  field(model,'travelBufferMinutes','Travel buffer (minutes)',job?.travelBufferMinutes??20,'number',{min:0,max:180,step:5});
  const instructions=field(model,'scope','Scope of work',scope(job||{}),'textarea',{rows:4,maxLength:20000,placeholder:'What the customer bought and what the crew must complete.'});instructions.parentElement.classList.add('dp-wide');
  field(model,'accessInstructions','Access instructions',job?.accessInstructions||'','textarea',{rows:2,maxLength:5000});
  field(model,'customerInstructions','Customer instructions',job?.customerInstructions||'','textarea',{rows:2,maxLength:5000});
  field(model,'requiredEquipment','Required equipment — one per line',(job?.requiredEquipment||[]).join('\n'),'textarea',{rows:3,maxLength:5000});
  field(model,'materials','Materials — one per line',(job?.materials||[]).map(m=>m.name).join('\n'),'textarea',{rows:3,maxLength:5000});
  field(model,'opsNotes','Internal dispatch notes',job?.opsNotes||'','textarea',{rows:3,maxLength:5000});
  model.footer.append(btn('Back',model.close),h('button',{class:'dp-btn primary',type:'submit'},job?'Save changes':'Create job'));
  model.form.addEventListener('submit',event=>{
    event.preventDefault();if(!job&&!selectedCustomer){model.status.replaceChildren(notice('Select an existing Hub customer before scheduling.','error'));search.focus();return;}
    const data=new FormData(model.form),members=[...checks].filter(([,input])=>input.checked).map(([id])=>id);
    if(lead.value&&!members.includes(lead.value)){model.status.replaceChildren(notice('The crew lead must be selected in Assigned employees.','error'));return;}
    const list=name=>String(data.get(name)||'').split('\n').map(v=>v.trim()).filter(Boolean);
    const changes={date:unscheduled.checked?'':startDate.value,time:unscheduled.checked?'':startTime.value,endDate:unscheduled.checked?'':endDate.value,endTime:unscheduled.checked?'':endTime.value,
      serviceType:service.value.trim(),address:address.value.trim(),assignedCrew:members,crewId:crewSelect.value||null,crewLead:lead.value||null,vehicleId:truck.value||null,
      crewNeeded:Number(data.get('crewNeeded')),travelBufferMinutes:Number(data.get('travelBufferMinutes')),jobInstructions:{...(typeof job?.jobInstructions==='object'?job.jobInstructions:{}),customerGoal:instructions.value.trim()},
      accessInstructions:String(data.get('accessInstructions')||'').trim(),customerInstructions:String(data.get('customerInstructions')||'').trim(),opsNotes:String(data.get('opsNotes')||'').trim(),
      requiredEquipment:list('requiredEquipment'),materials:list('materials').map((name,i)=>{const existing=job?.materials?.find(m=>m.name===name);return existing||{id:'material-'+i+'-'+name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,30),name,quantity:1};})};
    const body=job?{action:'schedule.update',requestId:key(),jobId:job.id,expectedRevision:job.revision,changes}:{action:'schedule.create',requestId:key(),customerId:selectedCustomer.id,kind:type.value,changes};
    void save(model,body,job?'Job updated.':'Job created.');
  });
  setTimeout(()=>search.focus(),0);
}
function openStatus(job,action) {
  const cancel=action==='schedule.cancel',model=modal(cancel?'Cancel job':'Restore job',cancel?'The job remains in history. The assigned crew will see the cancellation on refresh.':'The original schedule and assignment will be checked for conflicts before restoration.');if(!model)return;
  model.fields.append(h('p',{class:'dp-wide'},(job.customer||job.title)+' · '+(job.date?dateText(job.date)+' '+clock(job.time):'Unscheduled')));
  model.footer.append(btn('Back',model.close),h('button',{type:'submit',class:'dp-btn '+(cancel?'danger':'primary')},cancel?'Cancel job':'Restore job'));
  model.form.addEventListener('submit',e=>{e.preventDefault();void save(model,{action,requestId:key(),jobId:job.id,expectedRevision:job.revision,changes:{}},cancel?'Job cancelled.':'Job restored.');});
}
function openResources() {
  if(!S.data)return;const model=modal('Crews, vehicles & availability','Crew membership is copied onto each assignment. Editing a crew does not silently change scheduled jobs.');if(!model)return;
  const list=h('div',{class:'dp-resource-list dp-wide'});
  for(const [kind,label,rows]of [['crew','Crews',S.data.crews||[]],['vehicle','Vehicles',S.data.vehicles||[]],['availability','Availability',S.data.availability||[]]]) {
    list.append(h('div',{class:'dp-resource-head'},h('h3',{},label),btn('Add '+(kind==='availability'?'time off':kind),()=>{model.close();openResource(kind);})));
    if(!rows.length)list.append(h('p',{class:'dp-muted'},'None recorded.'));
    for(const row of rows)list.append(h('article',{},h('div',{},h('strong',{},kind==='availability'?person(row.employeeId)+' · '+row.date:row.name),h('small',{},kind==='crew'?row.memberIds.map(person).join(', '):kind==='vehicle'?row.notes||words(row.status):(row.allDay?'All day':clock(row.time)+' – '+clock(row.endTime))+' · '+(row.reason||words(row.status)))),btn('Edit',()=>{model.close();openResource(kind,row);})));
  }
  model.fields.append(list);model.footer.append(btn('Done',model.close));
}
function openResource(kind,resource=null) {
  const model=modal((resource?'Edit ':'Add ')+(kind==='availability'?'availability':kind),kind==='vehicle'?'Out-of-service vehicles cannot receive new assignments.':kind==='availability'?'Time off is checked against assignments before saving.':'Choose active employees and a lead.');if(!model)return;
  if(kind==='crew'){
    field(model,'name','Crew name',resource?.name||'','text',{required:true,maxLength:100});
    const members=h('fieldset',{class:'dp-wide'},h('legend',{},'Crew members'));
    for(const p of S.data.roster||[])members.append(h('label',{class:'dp-check'},h('input',{type:'checkbox',name:'memberIds',value:p.id,checked:resource?.memberIds?.includes(p.id)}),p.name));
    model.fields.append(members,labeled('Crew lead',select([['','No lead'],...(S.data.roster||[]).map(p=>[p.id,p.name])],resource?.leadId||'',()=>{},{name:'leadId'})),
      labeled('Status',select([['active','Active'],['inactive','Inactive']],resource?.status||'active',()=>{},{name:'status'})));
  } else if(kind==='vehicle'){
    field(model,'name','Vehicle name',resource?.name||'','text',{required:true,maxLength:100});
    model.fields.append(labeled('Availability',select([['available','Available'],['out_of_service','Out of service'],['inactive','Inactive']],resource?.status||'available',()=>{},{name:'status'})));
    field(model,'notes','Notes / issues',resource?.notes||'','textarea',{maxLength:5000});
  } else {
    model.fields.append(labeled('Employee',select((S.data.roster||[]).map(p=>[p.id,p.name]),resource?.employeeId||S.data.roster?.[0]?.id||'',()=>{},{name:'employeeId',required:true})));
    field(model,'date','First day',resource?.date||S.date,'date',{required:true});
    field(model,'endDate','Last day',resource?.endDate||resource?.date||S.date,'date',{required:true});
    model.fields.append(h('label',{class:'dp-check'},h('input',{type:'checkbox',name:'allDay',checked:resource?.allDay??true}),'All day'));
    field(model,'time','Unavailable from',resource?.time||'08:00','time');
    field(model,'endTime','Unavailable until',resource?.endTime||'17:00','time');
    field(model,'reason','Reason / note',resource?.reason||'','textarea',{maxLength:2000});
    model.fields.append(labeled('Status',select([['active','Active'],['cancelled','Cancelled']],resource?.status||'active',()=>{},{name:'status'})));
  }
  model.footer.append(btn('Back',model.close),h('button',{type:'submit',class:'dp-btn primary'},'Save '+(kind==='availability'?'availability':kind)));
  model.form.addEventListener('submit',e=>{
    e.preventDefault();const data=new FormData(model.form);let changes=Object.fromEntries(data.entries());
    if(kind==='crew')changes={...changes,memberIds:data.getAll('memberIds'),leadId:data.get('leadId')||null};
    if(kind==='availability')changes={...changes,allDay:data.has('allDay')};
    const body={action:kind+'.save',requestId:key(),...(resource?{id:resource.id,expectedRevision:resource.revision}:{}),changes};
    void save(model,body,words(kind)+' saved.');
  });
}
function mount(host) {
  if(!host)return;if(S.host===host&&S.root?.isConnected)return;
  unmount();S.host=host;S.root=h('section',{class:'egc-dispatch'});host.replaceChildren(S.root);render();void load();
  S.refreshTimer=setInterval(()=>{if(!document.hidden&&!S.modal&&!S.pending)void load({quiet:true});},60000);
}
function unmount() {S.controller?.abort();S.generation++;if(S.refreshTimer)clearInterval(S.refreshTimer);S.refreshTimer=null;if(S.modal){S.modal.dialog.close();S.modal.dialog.remove();S.modal=null;}S.pending=false;S.root?.remove();S.root=null;S.host=null;S.data=null;}
window.addEventListener('egc:signout',unmount);
window.addEventListener('beforeunload',event=>{if(S.modal){event.preventDefault();event.returnValue='';}});
window.EGCDispatch={mount,unmount,refresh:load,canLeave:()=>!S.modal&&!S.pending};
})();
