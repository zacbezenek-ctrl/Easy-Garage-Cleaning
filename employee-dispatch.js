/* Native EGC dispatch. Canonical records and authorization live in /api/dispatch. */
(function () {
'use strict';
const TZ = 'America/Denver';
const terminal = new Set(['completed', 'cancelled', 'canceled', 'paid', 'invoiced', 'review_requested', 'closed','noshow','no_show','no-show']);
const active = job => !terminal.has(job.status || job.pipelineStatus);
const S = { host:null, root:null, date:today(), view:'day', query:'', status:'active', employee:'', type:'', data:null, loading:false, generation:0, modal:null, refreshTimer:null, pending:false, error:'', notice:'', controller:null, viewer:null, recovery:null };
const recoveryPrefix='egc.dispatch.pending.v1.';
// Extra views (employee-dispatch-calendar.js) register {label, range(date), step(date,count), render(target,jobs), help}; they save through save().
const views=new Map();
const CUSTOMER_SEARCH_DELAY_MS=300;
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
const minutesOf = value => /^\d{2}:\d{2}$/.test(value || '') ? Number(value.slice(0,2))*60+Number(value.slice(3)) : NaN;
const hhmm = minute => String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
// The server says whether blank arrival windows get a derived default (no secrets).
function arrivalBlankText(defaults) {
  if (defaults?.enabled===false) return 'leave both blank for none.';
  if (defaults?.enabled!==true) return 'leave both blank for the dispatch default window, if one is turned on.';
  const minutes=Number(defaults.minutes);
  return 'leave both blank to use the default '+(Number.isInteger(minutes)&&minutes>0?minutes+'-minute ':'')+'window from the start time.';
}
function range() { const view=views.get(S.view); return view?view.range(S.date):{startDate:S.date, endDate:addDays(S.date,S.view==='week'||S.view==='crew'?7:1)}; }
const person = id => S.data?.roster?.find(p => p.id === id)?.name || id || 'Unassigned';
const vehicle = id => S.data?.vehicles?.find(v => v.id === id)?.name || (id ? 'Vehicle unavailable' : 'No vehicle');
const crewName = job => S.data?.crews?.find(c => c.id === job.crewId)?.name || (job.assignedCrew?.length ? job.assignedCrew.map(person).join(', ') : 'Unassigned');
// Assignment segments: parallel crews or per-day windows (server flag EGC_DISPATCH_SEGMENTS).
const segmentsOf = job => Array.isArray(job?.assignmentSegments) ? job.assignmentSegments : [];
const segmentsOn = () => S.data?.segments?.enabled === true;
const segmentMax = () => Number.isInteger(S.data?.segments?.max) ? S.data.segments.max : 31;
const segmentId = () => 's'+crypto.randomUUID().replaceAll('-','').slice(0,12);
const segmentRows = job => segmentsOf(job).length ? segmentsOf(job).map(s => ({...job,date:s.date,time:s.time,endDate:s.endDate||s.date,endTime:s.endTime,startAt:s.startAt,endAt:s.endAt,assignedCrew:s.assignedCrew||[],crewId:s.crewId||null,crewLead:s.crewLead||null,vehicleId:s.vehicleId||null,focusSegment:s.id,sourceJob:job})) : [job];
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
async function requestJSON(path,options={},signal) {
  const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},30000);
  try{const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal}),data=await response.json().catch(()=>({}));return{response,data};}
  catch(error){if(timedOut)throw Object.assign(new Error('The server did not confirm this request within 30 seconds. Retry the original request to verify the outcome.'),{status:503,code:'dispatch_timeout'});throw error;}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}
async function api(query='', body=null, signal) {
  const {response,data}=await requestJSON('/api/dispatch'+query,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined},signal);
  if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.error||'The dispatch response could not be verified. Retry the original request.'),{status:response.ok?503:response.status,code:data.code,details:data.details});
  const invalid=()=>Object.assign(new Error('The dispatch response was incomplete. Retry the original request to verify the outcome.'),{status:503,code:'dispatch_response_unverified'});
  if(body) {
    const record=body.action.startsWith('schedule.')?data.job:data.resource;
    if(data.requestId!==body.requestId||!record||typeof record.id!=='string'||!record.id||typeof record.revision!=='string'||!record.revision||(body.jobId&&record.id!==body.jobId)||(body.id&&record.id!==body.id))throw invalid();
  } else if(new URLSearchParams(query.replace(/^\?/, '')).get('view')==='customers') {
    if(!Array.isArray(data.customers))throw invalid();
  } else if(!data.viewer?.id||!['jobs','roster','crews','vehicles','availability','warnings'].every(name=>Array.isArray(data[name]))||typeof data.coverage?.complete!=='boolean')throw invalid();
  return data;
}
function restoreRecovery(viewer) {
  S.viewer=viewer;S.recovery=null;
  try {
    const raw=sessionStorage.getItem(recoveryPrefix+viewer);if(!raw)return;
    const saved=JSON.parse(raw);
    if(saved?.viewerId!==viewer||typeof saved.success!=='string'||!saved.request||!['schedule.create','schedule.update','schedule.cancel','schedule.restore','schedule.no_show','crew.save','vehicle.save','availability.save'].includes(saved.request.action)||!/^[a-f\d-]{36}$/i.test(saved.request.requestId||''))throw new Error('invalid');
    S.recovery=saved;
  } catch {S.recovery={invalid:true};}
}
function preserveRequest(request,success) {
  if(!S.viewer)throw new Error('Your manager identity has not been verified. Refresh before saving.');
  const saved={viewerId:S.viewer,request,success,savedAt:new Date().toISOString()};
  try {sessionStorage.setItem(recoveryPrefix+S.viewer,JSON.stringify(saved));}catch{throw new Error('This browser cannot retain a save receipt. No change was sent. Allow browser storage or reopen the Hub before saving.');}
  S.recovery=saved;
}
function clearRecovery() {if(S.viewer)try{sessionStorage.removeItem(recoveryPrefix+S.viewer);}catch{}S.recovery=null;}
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
    S.data=data; S.error='';restoreRecovery(data.viewer.id);
  } catch (error) { if (generation!==S.generation || error.name==='AbortError') return; if([401,403].includes(error.status))S.data=null; S.error=errorText(error); S.errorStatus=error.status; }
  finally { if (generation===S.generation && S.root) { S.loading=false; render(); } }
}
function setFilter(field,value) { S[field]=value; renderBody(); }
function move(count) { const view=views.get(S.view); S.date=view?.step?view.step(S.date,count):addDays(S.date,count*(S.view==='week'||S.view==='crew'?7:1)); void load(); }
function show(view,date) { if(/^\d{4}-\d{2}-\d{2}$/.test(date||''))S.date=date; if(view)S.view=view; void load(); }
function setDate(date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return; S.date=date; void load(); }
function filtered() {
  const q=S.query.toLowerCase().trim(), phone=q.replace(/\D/g,'');
  return (S.data?.jobs||[]).filter(j => (!S.employee || j.assignedCrew?.includes(S.employee)) &&
    (!S.type || j.type===S.type) && (S.status==='all' || (S.status==='active'?active(j):S.status==='attention'?warningsFor(j).length:S.status==='unassigned'?active(j)&&j.type!=='blocked'&&!j.assignedCrew?.length:S.status==='unscheduled'?!j.date:j.status===S.status)) &&
    (!q || [j.customer,j.address,j.phone,j.id,j.date,j.serviceType,crewName(j)].some(v=>String(v||'').toLowerCase().includes(q)) || phone.length>2&&String(j.phone||'').replace(/\D/g,'').includes(phone)))
    .sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999'))||String(a.time||'').localeCompare(String(b.time||''))||String(a.customer||'').localeCompare(String(b.customer||'')));
}
function spanOnDate(item,date) { const last=item.endDate&&item.endDate>item.date&&item.endTime==='00:00'?addDays(item.endDate,-1):item.endDate||item.date;return Boolean(item.date && item.date<=date && last>=date); }
// A split job appears only on the days one of its segments works.
function onDate(job,date) { const segments=job.focusSegment?[]:segmentsOf(job);return segments.length?segments.some(s=>spanOnDate(s,date)):spanOnDate(job,date); }
function segmentList(job,date) {
  const shown=segmentsOf(job).filter(s=>job.focusSegment?s.id===job.focusSegment:!date||spanOnDate(s,date));
  if(!shown.length)return null;
  return h('ul',{class:'dp-segment-list','aria-label':'Crew segments'},shown.map(s=>h('li',{},h('strong',{},(date&&s.date===date&&(s.endDate||s.date)===date?'':dateText(s.date,true)+' ')+clock(s.time)+' – '+clock(s.endTime)),' · '+(s.assignedCrew?.length?s.assignedCrew.map(person).join(', '):'Unassigned')+(s.crewLead?' · Lead '+person(s.crewLead):'')+' · '+vehicle(s.vehicleId)+(s.notes?' · '+s.notes:''))));
}
function warningsFor(job) {
  const warnings=(S.data?.warnings||[]).filter(w=>w.jobId===job.id),codes=new Set(warnings.map(w=>w.code));
  const add=(code,message)=>{if(!codes.has(code)){warnings.push({code,message,jobId:job.id});codes.add(code);}};
  if(job.attention?.status==='open')add('needs_follow_up',job.attention.reason||'The crew requested management follow-up.');
  if(['pending','error','blocked'].includes(job.completionSync?.status))add('completion_sync_'+job.completionSync.status,job.completionSync.message||'Completion is saved; the CRM handoff needs verification.');
  if(active(job)&&job.type!=='blocked'){
    if(['paused','waiting','delayed'].includes(job.activity))add('job_'+job.activity,job.activityReason||'The crew reported this job as '+job.activity+'.');
    if(job.endAt&&Number.isFinite(Date.parse(job.endAt))&&Date.parse(job.endAt)<Date.now())add('scheduled_finish_passed','Scheduled finish has passed; verify the current job status.');
  }
  return warnings;
}
function jobCard(job, {compact=false,date=null}={}) {
  const original=job.sourceJob||job,warnings=warningsFor(job),blocked=job.type==='blocked';
  const card=h('article',{class:'dp-job '+(active(job)?'':'dp-terminal'),draggable:active(job),
    ondragstart:e=>{e.dataTransfer.setData('text/plain',job.id);e.dataTransfer.effectAllowed='move';card.classList.add('dp-dragging');},
    ondragend:()=>card.classList.remove('dp-dragging')});
  const title=blocked?(job.title||'Company time block'):(job.customer||job.title||'Customer needs attention');
  card.append(h('div',{class:'dp-job-top'},h('span',{class:'dp-time'},job.date?clock(job.time)+' – '+clock(job.endTime):'Unscheduled'),pill(words(job.activity||job.status||'scheduled'),active(job)?'':'muted')));
  if (job.endDate&&job.endDate!==job.date) card.append(h('small',{class:'dp-muted'},dateText(job.date,true)+' → '+dateText(job.endDate,true)));
  if (!blocked&&job.date&&job.arrivalWindow) card.append(h('p',{class:'dp-service dp-arrival'},'Arrival window: '+job.arrivalWindow));
  card.append(h('h3',{},title),h('p',{class:'dp-service'},blocked?'Company-wide blocked time':job.serviceType||words(job.type||'job')));
  if(!blocked){
  if (job.address) card.append(h('a',{class:'dp-address',href:directions(job.address),target:'_blank',rel:'noopener'},job.address));
  else card.append(h('p',{class:'dp-missing'},'Address needed'));
  card.append(h('dl',{class:'dp-job-facts'},
    h('div',{},h('dt',{},'Crew'),h('dd',{},crewName(job))),
    h('div',{},h('dt',{},'Lead'),h('dd',{},person(job.crewLead))),
    h('div',{},h('dt',{},'Vehicle'),h('dd',{},segmentsOf(job).length&&!job.vehicleId?'By segment':vehicle(job.vehicleId)))));
  const split=segmentList(job,date);if(split)card.append(split);
  if (!compact&&scope(job)) card.append(h('p',{class:'dp-scope'},scope(job)));
  if (!compact&&job.requiredEquipment?.length) card.append(h('p',{class:'dp-equipment'},'Equipment: '+job.requiredEquipment.join(', ')));
  if(!compact&&job.jobTime?.recorded)card.append(h('p',{class:'dp-equipment'},'Recorded job work: '+(job.jobTime.workMs/3600000).toFixed(1)+' hr'+(job.jobTime.estimatedMs?' · scheduled '+(job.jobTime.estimatedMs/3600000).toFixed(1)+' hr':'')+(job.jobTime.partialHistory?' · partial history':'')));
  }else if(job.opsNotes||job.notes)card.append(h('p',{class:'dp-scope'},job.opsNotes||job.notes));
  for (const warning of warnings.slice(0,3)) card.append(h('p',{class:'dp-warning'},warning.message||words(warning.code)));
  if(warnings.length>3)card.append(h('p',{class:'dp-muted'},(warnings.length-3)+' more items to review'));
  const actions=h('div',{class:'dp-card-actions'});
  if(!blocked)actions.append(h('a',{class:'dp-btn primary',href:job.type==='walkthrough'?'/crew/gameplan.html?walkthroughId='+encodeURIComponent(job.id):'/crew/job.html?jobId='+encodeURIComponent(job.id)},job.type==='walkthrough'?'Open walkthrough':job.attention?.status==='open'?'Review job issue':'Open job'));
  if (active(job)) actions.append(btn('Edit / assign',()=>openJob(original)),btn('Cancel',()=>openStatus(original,'schedule.cancel'),'subtle'));
  if (active(job)&&!blocked&&job.type!=='walkthrough'&&S.data?.funnel?.reasonCodes?.noShow&&Date.parse(original.startAt)-3600000<=Date.now()) actions.append(btn('No-show',()=>openStatus(original,'schedule.no_show'),'subtle'));
  if (active(job)&&!blocked&&!original.date) actions.append(btn('Find a time',()=>openOpenings(original),'subtle',{'aria-label':'Find a time for '+(job.customer||'this job')}));
  if (active(job)&&job.type==='job'&&window.EGCRecurring&&!segmentsOf(original).length&&!original.segmentsInvalid) actions.append(btn('Repeat',()=>window.EGCRecurring.open({templateJob:original,onChange:()=>load({quiet:true})}),'subtle dp-repeat',{'aria-label':'Repeat '+(job.customer||'this job')+' on a schedule'}));
  if (['cancelled','canceled'].includes(job.status)) actions.append(btn('Restore',()=>openStatus(original,'schedule.restore')));
  card.append(actions);
  return card;
}
function empty(text='No jobs match these filters.') { return h('div',{class:'dp-empty'},h('h3',{},text),h('p',{},'Change the date or filters, or schedule work for a customer.'),btn('Create job',()=>openJob(),'primary')); }
function dayColumn(date,jobs) {
  const column=h('section',{class:'dp-day '+(date===today()?'dp-today':''),
    ondragover:e=>{if(e.dataTransfer.types.includes('text/plain')){e.preventDefault();e.dataTransfer.dropEffect='move';column.classList.add('dp-drop');}},
    ondragleave:()=>column.classList.remove('dp-drop'),
    ondrop:e=>{e.preventDefault();column.classList.remove('dp-drop');const job=S.data?.jobs.find(j=>j.id===e.dataTransfer.getData('text/plain'));if(!job||job.date===date)return;if(segmentsOf(job).length&&!segmentsOn()){S.notice='Remove all segments to move this job while segments are off.';renderBody();return;}openJob({...job},{moveTo:date});}
  },h('header',{class:'dp-day-head'},h('h2',{},dateText(date,true)),btn('+',()=>openJob(null,{date}),'',{'aria-label':'Schedule on '+dateText(date)})));
  const rows=jobs.filter(j=>onDate(j,date)&&(!S.employee||!segmentsOf(j).length||segmentsOf(j).some(s=>spanOnDate(s,date)&&s.assignedCrew?.includes(S.employee))));
  column.append(...(rows.length?rows.map(j=>jobCard(j,{compact:S.view==='week',date})):[h('p',{class:'dp-empty-day'},'No work scheduled')]));
  return column;
}
function renderBody() {
  const target=S.root?.querySelector('[data-dp-body]'); if(!target)return;
  target.replaceChildren();
  if(S.loading&&!S.data){target.append(h('p',{class:'dp-loading',role:'status'},'Loading the Hub schedule…'));return;}
  if(S.error) {target.append(notice(S.error,'error'),S.errorStatus===401?signInLink():btn('Retry',()=>load())); if(!S.data)return;}
  if(!S.data)return;
  if(S.recovery){target.append(notice(S.recovery.invalid?'A saved request could not be read. Reopen this browser session before making another dispatch change.':'A previous dispatch save has not been verified. Review and retry its original request before making another change.','error'));if(!S.recovery.invalid)target.append(btn('Review unverified save',openRecovery,'primary'));}
  if(S.data.coverage?.complete===false)target.append(notice('Some records could not be loaded. This schedule is incomplete; verify missing work before dispatching.','error'));
  if(S.notice)target.append(notice(S.notice));
  const all=S.data.jobs||[], dateJobs=all.filter(j=>onDate(j,S.date)&&j.type!=='blocked'), running=dateJobs.filter(j=>active(j)&&['dispatched','arrived','in_progress','paused','waiting','delayed'].includes(j.activity||j.status)), due=dateJobs.filter(active),attention=dateJobs.filter(j=>warningsFor(j).length);
  const stats=h('div',{class:'dp-stats'});
  for(const [label,count]of [['Scheduled',dateJobs.filter(j=>!['cancelled','canceled','noshow','no_show','no-show'].includes(j.status)).length],['In progress',running.length],['Remaining',due.length],['Unassigned',due.filter(j=>!j.assignedCrew?.length).length],['Needs attention',attention.length]])stats.append(h('article',{},h('span',{},label),h('strong',{},count),label==='Needs attention'&&count?btn('Review',()=>{S.status='attention';render();},'subtle',{'aria-label':'Review jobs needing attention'}):null));
  target.append(stats);
  const jobs=filtered();
  if(!jobs.length&&!views.has(S.view)){target.append(empty());return;}
  const unscheduled=jobs.filter(j=>!j.date);
  if(S.view==='jobs') {
    target.append(h('div',{class:'dp-job-grid'},jobs.map(j=>jobCard(j))));
  } else if(views.has(S.view)) {
    views.get(S.view).render(target,jobs);
  } else if(S.view==='crew') {
    const groups=new Map();
    // Each crew segment is grouped under the crew that works it.
    for(const job of jobs.filter(j=>j.date).flatMap(segmentRows)){if(S.employee&&job.focusSegment&&!job.assignedCrew.includes(S.employee))continue;const id=job.crewId||job.assignedCrew?.slice().sort().join('|')||'unassigned';if(!groups.has(id))groups.set(id,[]);groups.get(id).push(job);}
    for(const rows of groups.values()) {
      const minutes=rows.reduce((n,j)=>n+Math.max(0,(Date.parse(j.endAt)-Date.parse(j.startAt))/60000||0),0);
      target.append(h('section',{class:'dp-crew-group'},h('header',{},h('h2',{},crewName(rows[0])),h('p',{class:'dp-muted'},rows.length+' jobs · '+(minutes/60).toFixed(1)+' reserved hours'),h('small',{class:'dp-muted'},'Reserved time includes overnight spans; it is not employee labor time.')),h('div',{class:'dp-job-grid'},rows.map(j=>h('div',{},h('p',{class:'dp-date-label'},dateText(j.date,true)),jobCard(j))))));
    }
  } else {
    target.append(h('div',{class:S.view==='week'?'dp-week':'dp-day-board'},Array.from({length:S.view==='week'?7:1},(_,i)=>dayColumn(addDays(S.date,i),jobs))));
  }
  if(unscheduled.length&&S.view!=='jobs')target.append(h('section',{class:'dp-unscheduled'},h('h2',{},'Unscheduled work · '+unscheduled.length),h('div',{class:'dp-job-grid'},unscheduled.map(j=>jobCard(j)))));
  target.append(h('p',{class:'dp-footnote'},'All scheduling times use Mountain Time. '+(S.data.coverage?.asOf?'Updated '+new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(new Date(S.data.coverage.asOf))+'.':'')+' '+(views.get(S.view)?.help||'Drag a job onto a day to review its new time.')));
}
function labeled(label,control,help) {const id=control.id||'dp-'+key();control.id=id;return h('label',{class:'dp-field',htmlFor:id},h('span',{},label),control,help?h('small',{},help):null);}
function select(options,value,onChange,props={}) {return h('select',{onchange:e=>onChange(e.target.value),...props},options.map(([id,label])=>h('option',{value:id,selected:id===value},label)));}
// FUN-02: reason, channel and visit-purpose codes come from the server's shared funnel definitions (GET funnel).
const codeLabels={hub_phone:'By phone',hub_in_person:'In person',customer:'Customer',company:'EGC',diy:'Doing it themselves',service:'Service visit',install:'Install visit',return:'Return visit',rework:'Rework visit',crm_sync_pending:'CRM sync pending',no_crm_contact:'No CRM contact',b2b_account:'Business account',internal_or_test:'Internal or test',
  garage_transformation:'Garage transformation / organization',junk_removal:'Junk removal',garage_guard_visit:'Garage Guard member visit',commercial_b2b:'Commercial / B2B',unknown:'Not sure yet',walkthrough:'On-site walkthrough',remote_photo_video_quote:'Photo or video quote',direct_phone_booking:'Booked directly by phone',b2b_request:'Business (B2B) request',rebook:'Repeat customer rebook',member_visit:'Garage Guard member visit',recurring:'Recurring service'};
function codeSelect(codes,value='',props={}) {return select([['','Choose…'],...codes.map(code=>[code,codeLabels[code]||words(code)])],value,()=>{},props);}
// FUN-29: the project's service line and funnel path. The server pre-fills both from the booking (GET /api/funnel-dimensions);
// one tap is required only when nothing on file decides a value. An untouched pre-fill is not sent: the server derives it again.
// An untouched lead-form suggestion is sent as serviceLineSuggested (a lower rule, not a staff pick); a changed select is the staff pick.
const dimensionSources={explicit:'an earlier staff choice',visitPurpose:'the visit purpose',businessAccount:'the business account',catalogCategory:'the sold catalog items',relatedProject:'the earlier project',salesExitService:'the service name',legacyJobType:'the job type',bookingChannel:'how it was booked',recurringSeries:'the recurring plan',walkthrough:'the walkthrough',repeat:'the earlier project'};
function dimensionControls(model,lists,read) {
  if(!Array.isArray(lists?.serviceLines)||!Array.isArray(lists?.funnelPaths))return null;
  const controls={serviceLine:codeSelect(lists.serviceLines,'',{name:'serviceLine',required:true}),funnelPath:codeSelect(lists.funnelPaths,'',{name:'funnelPath',required:true})},hints={},derived={serviceLine:null,funnelPath:null},suggested={serviceLine:null,funnelPath:null};
  // The lead-form answer per customer: GHL is read once per form, not on every keystroke.
  const answers=new Map();
  for(const [name,label]of [['serviceLine','Service line'],['funnelPath','How this project reached us']]) {
    // The hint describes the select without becoming part of its name.
    hints[name]=h('small',{class:'dp-muted',id:'dp-hint-'+key(),'aria-hidden':'true'});controls[name].setAttribute('aria-describedby',hints[name].id);
    controls[name].addEventListener('change',()=>{controls[name].dataset.touched='1';});
    const wrap=labeled(label,controls[name]);wrap.append(hints[name]);model.fields.append(wrap);
  }
  const settle=(name,dim)=>{
    const select=controls[name],has=value=>typeof value==='string'&&[...select.options].some(option=>option.value===value);
    // A project that holds "Not sure yet" is asked again: the select starts empty, so the answer needs a new tap.
    const current=has(dim?.value)?dim.value:'',unsure=dim?.required===true&&current==='unknown',value=unsure?'':current,suggestion=!value&&has(dim?.suggestion)?dim.suggestion:'';
    derived[name]=current||null;suggested[name]=suggestion||null;
    if(!select.dataset.touched)select.value=value||suggestion;
    select.required=!dim||dim.required===true;
    hints[name].textContent=!dim?'The suggestion could not be loaded. Choose one.':suggestion?'Suggested by the Facebook lead form. Confirm or change it.':unsure?'Earlier marked Not sure yet. Choose the service line, or Not sure yet again.':!select.required?'Set from '+(dimensionSources[dim.source]||'the booking')+'. Change it only if it is wrong.':'Required: nothing on file decides this. Choose one.';
  };
  let generation=0,timer=null;
  const refresh=()=>{clearTimeout(timer);timer=setTimeout(async()=>{
    const g=++generation,query=read();
    if(!query){for(const name of Object.keys(controls)){derived[name]=null;suggested[name]=null;controls[name].required=true;hints[name].textContent='Select the customer to see what is on file.';}return;}
    for(const name of Object.keys(controls))hints[name].textContent='Checking what is on file…';
    try{
      const known=answers.has(query.customerId),{response,data}=await requestJSON('/api/funnel-dimensions?'+new URLSearchParams({...query,...(known?{suggest:'false'}:{})}));
      if(g!==generation||S.modal!==model)return;
      if(!response.ok||data.ok!==true||data.customerId!==query.customerId||typeof data.serviceLine?.required!=='boolean'||typeof data.funnelPath?.required!=='boolean')throw new Error('unverified');
      if(!known&&['ok','unavailable','disabled'].includes(data.ghl))answers.set(query.customerId,data.serviceLine.suggestion??null);
      settle('serviceLine',known&&data.serviceLine.required?{...data.serviceLine,suggestion:answers.get(query.customerId)}:data.serviceLine);settle('funnelPath',data.funnelPath);
    }catch{if(g===generation&&S.modal===model){settle('serviceLine',null);settle('funnelPath',null);}}
  },250);};
  return {refresh,facts:()=>Object.assign({},...Object.entries(controls).map(([name,select])=>!select.value||select.value===derived[name]?{}:select.dataset.touched?{[name]:select.value}:select.value===suggested[name]?{[name]:select.value,serviceLineSuggested:true}:{}))};
}
function reasonControls(parent,list,{who=false,required=true}={}) {
  const lists=S.data?.funnel;if(!Array.isArray(lists?.reasonCodes?.[list]))return null;
  const code=codeSelect(lists.reasonCodes[list],'',{name:'reasonCode',required}),by=who&&Array.isArray(lists.initiatedBy)?codeSelect(lists.initiatedBy,'',{name:'initiatedBy',required}):null;
  parent.append(labeled('Reason',code),...(by?[labeled('Who asked for it?',by)]:[]));
  return Object.assign(()=>({...(code.value?{reasonCode:code.value}:{}),...(by?.value?{initiatedBy:by.value}:{})}),{controls:[code,by].filter(Boolean)});
}
function render() {
  if(!S.root||S.modal)return;
  const search=h('input',{type:'search',value:S.query,placeholder:'Filter this date range',oninput:e=>setFilter('query',e.target.value),'aria-label':'Search jobs'});
  S.root.replaceChildren(h('header',{class:'dp-header'},h('div',{},h('span',{class:'dp-eyebrow'},'EGC OPERATIONS'),h('h1',{},'Dispatch'),h('p',{},'Schedule, assign and run the day.')),h('div',{class:'dp-header-actions'},btn('Search all jobs',openSearch,'',{disabled:!S.data}),btn('Find opening',openOpenings,'',{disabled:!S.data}),btn('Block time',()=>openBlock(),'',{disabled:!S.data}),btn('Crews & vehicles',()=>openResources()),window.EGCRecurring?btn('Recurring plans',()=>window.EGCRecurring.open({onChange:()=>load({quiet:true})})):null,btn('Refresh',()=>load(),'',{disabled:S.loading}),btn('Create job',()=>openJob(),'primary',{disabled:!S.data}))));
  S.root.querySelector('.dp-header-actions').insertBefore(btn('Drive times',openTravel,'',{disabled:!S.data}),S.root.querySelector('.dp-header-actions .primary'));
  const modes=h('div',{class:'dp-modes',role:'group','aria-label':'Calendar view'});
  for(const [id,label]of [['day','Day'],['week','Week'],['crew','Crew'],['jobs','Jobs'],...[...views].map(([id,view])=>[id,view.label])])modes.append(btn(label,()=>{S.view=id;void load();},S.view===id?'selected':'',{'aria-pressed':S.view===id?'true':'false'}));
  S.root.append(h('div',{class:'dp-controls'},h('div',{class:'dp-date-controls'},btn('←',()=>move(-1),'',{'aria-label':'Previous period'}),labeled('Schedule date',h('input',{type:'date',value:S.date,onchange:e=>setDate(e.target.value)})),btn('→',()=>move(1),'',{'aria-label':'Next period'}),h('div',{class:'dp-date-shortcuts'},btn('Today',()=>setDate(today())),btn('Tomorrow',()=>setDate(addDays(today(),1))))),modes));
  S.root.append(h('div',{class:'dp-filters'},search,
    select([['active','Active work'],['all','All statuses'],['attention','Needs attention'],['unassigned','Unassigned'],['unscheduled','Unscheduled'],['completed','Completed'],['cancelled','Cancelled']],S.status,v=>setFilter('status',v),{'aria-label':'Filter by status'}),
    select([['','All employees'],...(S.data?.roster||[]).map(p=>[p.id,p.name])],S.employee,v=>setFilter('employee',v),{'aria-label':'Filter by employee'}),
    select([['','All work types'],['job','Jobs'],['walkthrough','Walkthroughs'],['blocked','Blocked time']],S.type,v=>setFilter('type',v),{'aria-label':'Filter by work type'})));
  S.root.append(h('div',{'data-dp-body':''}));renderBody();
}
function modal(title,description,{recovery=false}={}) {
  if(S.modal)return null;
  if(S.recovery&&!recovery){if(!S.recovery.invalid)openRecovery();return null;}
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
  const model={dialog,form,fields,footer,status,close,previousFocus,request:null,viewer:S.viewer,recovery};
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
  const retry=Boolean(model.request);
  try {preserveRequest(model.request||body,success);}catch(error){model.status.replaceChildren(notice(error.message,'error'));return;}
  model.request ||= body;formBusy(model,true);model.status.replaceChildren(notice('Saving and verifying…'));
  try {
    if(retry){const current=await api('?'+new URLSearchParams({...range(),includeUnscheduled:'true'}));if(current.viewer.id!==model.viewer)throw Object.assign(new Error('Sign in again with the manager account that started this save before retrying it.'),{status:503,code:'dispatch_account_changed'});}
    const result=await api('',model.request);
    if(S.modal!==model)return;
    S.notice=success+(result.warnings?.length?' '+result.warnings.map(w=>w.message||words(w.code)).join(' '):'')+(result.providerSync==='pending'?' Customer calendar sync is pending.':'');
    formBusy(model,false);model.request=null;clearRecovery();model.close();await load();
  } catch(error) {
    if(S.modal!==model)return;
    formBusy(model,false);
    if(error.status>=400&&error.status<500&&![401,403,408,429].includes(error.status)){model.request=null;model.disabledState=null;clearRecovery();}
    model.status.replaceChildren(notice(errorText(error),'error'));
    model.onError?.(error);
    if(error.status===401)model.status.append(signInLink());
    if(/revision/.test(error.code||''))model.status.append(btn('Discard draft and load latest',()=>{model.close();void load();}));
    if(model.recovery&&!model.request)model.status.append(btn('Return to schedule',model.close));
    if(model.request) {
      for(const input of model.form.querySelectorAll('input,textarea,select'))input.disabled=true;
      model.status.append(h('p',{},'This request is saved in this browser tab, including after refresh. Retry the original save to avoid duplicates.'),btn('Retry original save',()=>save(model,model.request,success),'primary'));
    }
  }
}
function openRecovery() {
  const saved=S.recovery;if(!saved||saved.invalid)return;
  const model=modal('Verify previous dispatch save','The same request ID will be used to recover the result without creating a duplicate.',{recovery:true});if(!model)return;
  model.request=saved.request;
  const changes=saved.request.changes||{},split=segmentsOf(changes),facts=[['Action',words(saved.request.action.replace('.', ' '))],['Job / record',saved.request.jobId||saved.request.id||changes.serviceType||changes.name||'New record'],['Schedule',split.length?split.length+' crew segments from '+split[0].date+' '+clock(split[0].time):changes.date?[changes.date,clock(changes.time),changes.endDate,clock(changes.endTime)].filter(Boolean).join(' · '):'Unchanged or unscheduled'],['Crew',(split.length?[...new Set(split.flatMap(s=>s.assignedCrew||[]))]:changes.assignedCrew||[]).map(person).join(', ')||'Unchanged or unassigned'],['Scope',changes.jobInstructions||'Unchanged']];
  model.fields.append(h('dl',{class:'dp-recovery-facts dp-wide'},facts.map(([label,value])=>h('div',{},h('dt',{},label),h('dd',{},value)))));
  model.footer.append(btn('Retry original save',()=>save(model,saved.request,saved.success),'primary'));
  model.form.addEventListener('submit',event=>{event.preventDefault();void save(model,saved.request,saved.success);});
}
function openSearch() {
  if(!S.data)return;
  const model=modal('Search all Hub jobs','Find work across all dates by customer, address, phone, email, employee, job ID or date (MM/DD/YYYY).');if(!model)return;
  const query=field(model,'query','Search all dates','','search',{required:true,minLength:2,maxLength:200,placeholder:'Customer, phone, address or employee'});
  const status=select([['all','All statuses'],['active','Active work'],['completed','Completed'],['cancelled','Cancelled / no-show'],['unscheduled','Unscheduled']],'all',()=>{});
  model.fields.append(labeled('Job status',status));
  const results=h('div',{class:'dp-search-results dp-wide','aria-live':'polite'});model.fields.append(results);
  model.footer.append(btn('Back',model.close),h('button',{type:'submit',class:'dp-btn primary'},'Search history'));
  query.addEventListener('input',()=>results.replaceChildren());status.addEventListener('change',()=>results.replaceChildren());
  model.form.addEventListener('submit',async event=>{
    event.preventDefault();if(S.pending)return;
    formBusy(model,true);results.replaceChildren();model.status.replaceChildren(notice('Searching canonical Hub history…'));
    try{
      const {response,data}=await requestJSON('/api/dispatch-search?'+new URLSearchParams({q:query.value.trim(),status:status.value}));
      if(!response.ok||data.ok!==true)throw Object.assign(new Error(data.error||'Job history could not be verified. Retry the search.'),{status:response.ok?503:response.status,code:data.code});
      if(data.coverage?.complete!==true||!Array.isArray(data.results)||!Number.isInteger(data.total)||data.results.some(row=>!row?.job?.id||!row.job.revision))throw new Error('The job search response was incomplete. Retry the search.');
      if(S.modal!==model)return;
      model.status.replaceChildren(notice(data.total+' matching '+(data.total===1?'job':'jobs')+(data.truncated?' · showing the first 50. Refine the search to see other matches.':'.')));
      if(!data.results.length)results.append(h('p',{},'No Hub jobs match. Try another customer name, phone, address, employee or date.'));
      for(const row of data.results){const job=row.job,blocked=job.type==='blocked';
        const actions=h('div',{class:'dp-card-actions'});
        if(!blocked)actions.append(h('a',{class:'dp-btn primary',href:job.type==='walkthrough'?'/crew/gameplan.html?walkthroughId='+encodeURIComponent(job.id):'/crew/job.html?jobId='+encodeURIComponent(job.id)},job.type==='walkthrough'?'Open walkthrough':'Open job'));
        actions.append(btn('Show in dispatch',()=>{model.close();S.date=/^\d{4}-\d{2}-\d{2}$/.test(job.date||'')?job.date:today();S.view=job.date?'day':'jobs';S.status='all';S.employee='';S.type='';S.query=job.date?'':job.id;S.notice='Showing '+(job.customer||job.title||job.id)+(job.date?' on '+dateText(job.date)+'.':' in unscheduled work.');void load();}));
        results.append(h('article',{class:'dp-search-result'},h('div',{class:'dp-job-top'},h('strong',{},job.customer||job.title||row.canonicalCustomerName||job.id),pill(words(job.activity||job.status))),row.canonicalCustomerName&&row.canonicalCustomerName!==job.customer?h('small',{class:'dp-muted'},'Customer record: '+row.canonicalCustomerName):null,h('p',{},job.date?job.date+' · '+clock(job.time)+' – '+clock(job.endTime):'Unscheduled'),job.address?h('p',{},job.address):null,h('p',{class:'dp-muted'},[job.serviceType||words(job.type),job.id].filter(Boolean).join(' · ')),actions));
      }
    }catch(error){if(S.modal===model){results.replaceChildren();model.status.replaceChildren(notice(errorText(error),'error'));if(error.status===401)model.status.append(signInLink());}}
    finally{if(S.modal===model)formBusy(model,false);}
  });
  query.focus();
}
// Suggested job length from the server (functions/_lib/dispatch-duration.js). A
// schedule span or the default is not new information, so it is never offered.
// The job editor applies a suggestion only when it fits one workday.
const durationFrom={line_items:'the sold quote',duration_override:'the walkthrough override',estimated_duration:'the saved estimate'},WORKDAY_MINUTES=600;
function durationSuggestion(job) {const minutes=job?.suggestedDurationMin;return Object.hasOwn(durationFrom,job?.durationSource??'')&&Number.isInteger(minutes)&&minutes>=15&&minutes<=10080&&minutes%15===0?{minutes,source:job.durationSource,partial:job.durationSource==='line_items'&&job.durationCoverage==='partial',capped:job.durationCapped===true}:null;}
function durationText(minutes) {const hours=Math.floor(minutes/60),rest=minutes%60;return [hours?hours+' hr':'',rest?rest+' min':''].filter(Boolean).join(' ');}
function durationNote(job,suggested) {return 'Suggested from '+durationFrom[suggested.source]+': '+durationText(suggested.minutes)+(suggested.source==='line_items'?' for a crew of '+(job.crewNeeded||1):'')+'.'+(suggested.partial?' Some sold lines have no time estimate, so allow extra time.':'')+(suggested.capped?' The lines add up to more than 24 hr, so plan the work across days.':'');}
function durationHint(job,suggested,control,extra='') {const id='dp-duration-'+key();control.setAttribute('aria-describedby',id);return h('small',{class:'dp-muted dp-wide dp-duration-hint',id,'aria-live':'polite'},durationNote(job,suggested)+extra);}
function durationOptions(suggested) {
  const rows=[['','Set duration…'],['30','30 minutes'],['60','1 hour'],['90','90 minutes'],['120','2 hours'],['180','3 hours'],['240','4 hours'],['360','6 hours'],['480','8 hours']];
  if(!suggested)return rows;
  const value=String(suggested.minutes),found=rows.find(([id])=>id===value),at=rows.findIndex(([id])=>Number(id)>suggested.minutes);
  if(found)found[1]+=' · suggested';else rows.splice(at<0?rows.length:at,0,[value,durationText(suggested.minutes)+' · suggested']);
  return rows;
}
function openOpenings(source) {
  // The toolbar passes its click event; a job card passes the job to book.
  if(!S.data)return;const job=source&&!(source instanceof Event)?source:null;
  const suggested=durationSuggestion(job),model=modal(job?'Find a time for '+(job.customer||job.title||'this job'):'Find a scheduling opening','Checks recorded jobs, time off and vehicle reservations. Confirm employees are working before booking.');if(!model)return;
  const start=field(model,'startDate','Search from',S.date,'date',{required:true});
  const last=field(model,'lastDate','Search through',addDays(S.date,6),'date',{required:true});
  const duration=field(model,'durationMinutes','Job duration (minutes)',suggested&&suggested.minutes<=1440?suggested.minutes:120,'number',{min:15,max:1440,step:15,required:true});
  if(suggested)duration.parentElement.after(durationHint(job,suggested,duration,suggested.minutes>1440?' Openings cover one day at a time, so split longer work into daily segments.':''));
  const buffer=field(model,'travelBufferMinutes','Travel buffer (minutes)',Number.isInteger(job?.travelBufferMinutes)?job.travelBufferMinutes:20,'number',{min:0,max:180,step:5,required:true});
  const destination=field(model,'destination','New job ZIP or address (optional)','','text',{maxLength:500,autocomplete:'off',placeholder:'80525 or street address'});
  const begins=field(model,'workdayStart','Workday starts','08:00','time',{required:true});
  const ends=field(model,'workdayEnd','Workday ends','17:00','time',{required:true});
  const checks=new Map(),members=h('fieldset',{class:'dp-wide'},h('legend',{},'Employees needed together'));
  for(const person of S.data.roster){const input=h('input',{type:'checkbox',value:person.id,checked:job?(job.assignedCrew||[]).includes(person.id):S.employee===person.id});checks.set(person.id,input);members.append(h('label',{class:'dp-check'},input,person.name));}
  const crew=select([['','Choose employees individually'],...S.data.crews.filter(row=>row.status==='active').map(row=>[row.id,row.name])],'',id=>{const selected=S.data.crews.find(row=>row.id===id);if(selected)for(const[id,input]of checks)input.checked=selected.memberIds.includes(id);});
  const truck=select([['','No vehicle required'],...S.data.vehicles.filter(row=>row.status==='available').map(row=>[row.id,row.name])],S.data.vehicles.some(row=>row.id===job?.vehicleId&&row.status==='available')?job.vehicleId:'',()=>{});
  model.fields.append(labeled('Saved crew to check',crew),labeled('Vehicle to check',truck),members);
  const results=h('div',{class:'dp-openings-results dp-wide','aria-live':'polite'});model.fields.append(results);
  model.footer.append(btn('Back',model.close),h('button',{type:'submit',class:'dp-btn primary'},'Check openings'));
  const clearResults=()=>results.replaceChildren();for(const input of model.fields.querySelectorAll('input,select'))input.addEventListener('input',clearResults);
  model.form.addEventListener('submit',async event=>{
    event.preventDefault();if(S.pending)return;
    const employeeIds=[...checks].filter(([,input])=>input.checked).map(([id])=>id);
    if(!employeeIds.length){model.status.replaceChildren(notice('Choose the employees who need an opening together.','error'));return;}
    const query={startDate:start.value,endDate:addDays(last.value,1),durationMinutes:duration.value,workdayStart:begins.value,workdayEnd:ends.value,employeeIds:employeeIds.join(','),travelBufferMinutes:buffer.value,...(truck.value?{vehicleId:truck.value}:{})};
    const place=destination.value.trim();if(place)query[/^\d{5}$/.test(place)?'zip':'address']=place;
    formBusy(model,true);results.replaceChildren();model.status.replaceChildren(notice('Checking recorded capacity…'));
    try{
      const {response,data}=await requestJSON('/api/dispatch-openings?'+new URLSearchParams(query));
      if(!response.ok||data.ok!==true)throw Object.assign(new Error(data.error||'Openings could not be verified. Retry the search.'),{status:response.ok?503:response.status,code:data.code,details:data.details});
      if(data.coverage?.complete!==true||data.coverage?.consistent!==true||!Array.isArray(data.candidates)||!Array.isArray(data.warnings))throw new Error('The openings response was incomplete. Retry before booking.');
      if(S.modal!==model)return;
      model.status.replaceChildren(...data.warnings.map(warning=>notice(warning.message||words(warning.code))));
      results.append(h('h3',{},data.candidates.length?'Recorded openings':'No matching openings'),h('p',{},data.candidates.length?'Each suggestion is rechecked when you save the job.': 'Try different dates, employees, duration or vehicle.'));
      for(const candidate of data.candidates){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(candidate.date||'')||!/^\d{2}:\d{2}$/.test(candidate.time||'')||!/^\d{4}-\d{2}-\d{2}$/.test(candidate.endDate||'')||!/^\d{2}:\d{2}$/.test(candidate.endTime||''))throw new Error('An opening had invalid dates. Retry before booking.');
        results.append(h('article',{},h('div',{},h('strong',{},dateText(candidate.date,true)),h('p',{},clock(candidate.time)+' – '+clock(candidate.endTime)+(candidate.endDate!==candidate.date?' · ends '+dateText(candidate.endDate,true):'')),h('small',{},employeeIds.map(person).join(', ')+(truck.value?' · '+vehicle(truck.value):''))),btn('Use this opening',()=>{
          const selectedCrew=S.data.crews.find(row=>row.id===crew.value&&row.memberIds.length===employeeIds.length&&row.memberIds.every(id=>employeeIds.includes(id)));
          model.close();openJob(job,{...candidate,assignedCrew:employeeIds,vehicleId:query.vehicleId||'',crewId:selectedCrew?.id,crewLead:selectedCrew?.leadId,travelBufferMinutes:Number(query.travelBufferMinutes)});
        },'primary')));
      }
      if(data.truncated)results.append(h('p',{},'Showing the first 20 openings. Narrow the search for later dates.'));
    }catch(error){if(S.modal===model){results.replaceChildren();model.status.replaceChildren(notice(errorText(error),'error'));if(error.status===401)model.status.append(signInLink());}}
    finally{if(S.modal===model)formBusy(model,false);}
  });
}
const legSources={offline_zip:'ZIP estimate',google:'Google estimate',same_property:'same property'};
function legText(leg) {
  if(leg.status==='overlap')return 'Overlaps the next stop by '+leg.shortByMinutes+' min. Review this schedule.';
  if(leg.status==='same_property')return leg.gapMinutes+' min gap · same property, no drive';
  return [leg.gapMinutes+' min gap',Number.isInteger(leg.estimatedMinutes)?'about '+leg.estimatedMinutes+' min drive ('+(legSources[leg.estimateSource]||'estimate')+')':'no drive estimate','buffer '+leg.bufferMinutes+' min',leg.status==='short'?'short by '+leg.shortByMinutes+' min':'enough time'].join(' · ');
}
function travelRoutes(data) {
  if(!data.employees.length)return [h('p',{},'No assigned work with valid times on this date.')];
  return data.employees.map(route=>{
    const stops=h('div',{class:'dp-resource-list'});
    route.jobs.forEach((stop,index)=>{
      stops.append(h('article',{},h('div',{},h('strong',{},clock(stop.time)+' – '+clock(stop.endTime)+' · '+(stop.customer||stop.title||'Job')),stop.address?h('small',{},stop.address):h('small',{class:'dp-missing'},'Address needed'))));
      const leg=route.legs[index];
      if(leg&&leg.fromJobId===stop.id)stops.append(h('p',{class:['short','overlap'].includes(leg.status)?'dp-warning':'dp-muted'},legText(leg)));
    });
    const totals=route.totals||{};
    return h('section',{class:'dp-search-result'},h('h3',{},route.name||person(route.employeeId)),h('p',{class:'dp-muted'},route.jobs.length+' '+(route.jobs.length===1?'stop':'stops')+(totals.estimatedDriveMinutes?' · about '+totals.estimatedDriveMinutes+' min estimated driving':'')+(totals.shortLegs?' · '+totals.shortLegs+' tight '+(totals.shortLegs===1?'gap':'gaps'):'')),route.complete===false?notice('An assignment for this employee has invalid times, so this route is incomplete.','error'):null,stops);
  });
}
function openTravel() {
  if(!S.data)return;
  const model=modal('Drive times','Each employee\'s stops in order, with the gap and estimated drive between jobs. Estimates never shorten a job\'s travel buffer.');if(!model)return;
  const day=field(model,'travelDate','Route date',S.date,'date',{required:true});
  const results=h('div',{class:'dp-search-results dp-wide','aria-live':'polite'});model.fields.append(results);
  model.footer.append(btn('Back',model.close),h('button',{type:'submit',class:'dp-btn primary'},'Show drive times'));
  day.addEventListener('input',()=>results.replaceChildren());
  const show=async()=>{
    if(S.pending||!/^\d{4}-\d{2}-\d{2}$/.test(day.value))return;
    formBusy(model,true);model.status.replaceChildren();results.replaceChildren(h('p',{class:'dp-loading',role:'status'},'Loading drive times…'));
    try{
      const {response,data}=await requestJSON('/api/dispatch-travel?'+new URLSearchParams({date:day.value}));
      if(!response.ok||data.ok!==true)throw Object.assign(new Error(data.error||'Drive times could not be verified. Retry.'),{status:response.ok?503:response.status,code:data.code});
      if(data.coverage?.complete!==true||data.date!==day.value||!Array.isArray(data.employees)||!Array.isArray(data.warnings)||data.employees.some(row=>!Array.isArray(row?.jobs)||!Array.isArray(row?.legs)))throw new Error('The drive-time response was incomplete. Retry.');
      if(S.modal!==model)return;
      model.status.replaceChildren(...data.warnings.map(warning=>notice(warning.message||words(warning.code))));
      results.replaceChildren(h('h3',{},dateText(data.date)),...travelRoutes(data));
    }catch(error){if(S.modal===model){results.replaceChildren();model.status.replaceChildren(notice(errorText(error),'error'));if(error.status===401)model.status.append(signInLink());}}
    finally{if(S.modal===model)formBusy(model,false);}
  };
  model.form.addEventListener('submit',event=>{event.preventDefault();void show();});
  void show();
}
function openBlock(job=null,options={}) {
  if(!S.data)return;
  const model=modal(job?'Edit company time block':'Block company time','Blocks all crews from receiving overlapping work. Existing assignments are checked before saving.');if(!model)return;
  const date=options.moveTo||job?.date||S.date,offset=job?.endDate&&job?.date?Math.round((Date.parse(job.endDate+'T12:00Z')-Date.parse(job.date+'T12:00Z'))/86400000):0;
  const title=field(model,'title','Reason / title',job?.title||'','text',{required:true,maxLength:200,placeholder:'Training, holiday, company meeting…'});
  const startDate=field(model,'date','Start date',date,'date',{required:true}),startTime=field(model,'time','Start time',job?.time||'08:00','time',{required:true});
  const endDate=field(model,'endDate','End date',options.moveTo?addDays(date,offset):job?.endDate||date,'date',{required:true}),endTime=field(model,'endTime','End time',job?.endTime||'17:00','time',{required:true});
  const notes=field(model,'opsNotes','Internal notes',job?.opsNotes||job?.notes||'','textarea',{maxLength:5000});
  model.footer.append(btn('Back',model.close),h('button',{type:'submit',class:'dp-btn primary'},'Save time block'));
  model.form.addEventListener('submit',event=>{event.preventDefault();const changes={title:title.value.trim(),date:startDate.value,time:startTime.value,endDate:endDate.value,endTime:endTime.value,opsNotes:notes.value.trim()};void save(model,job?{action:'schedule.update',requestId:key(),jobId:job.id,expectedRevision:job.revision,changes}:{action:'schedule.create',requestId:key(),kind:'blocked',changes},'Company time block saved.');});
}
function openJob(job=null,options={}) {
  if(!S.data)return;
  if(job?.type==='blocked')return openBlock(job,options);
  const model=modal(job?'Edit / assign job':'Create job','Times are Mountain Time. Conflicting employee and vehicle assignments are blocked.');if(!model)return;
  let selectedCustomer=job?.customerId?{id:job.customerId,name:job.customer,address:job.address,phone:job.phone}:null,sourceJobId=null;
  const search=field(model,'customerSearch','Customer',job?.customer||'','search',{required:!job,readOnly:!!job,autocomplete:'off',placeholder:'Search existing customers'});
  const customerResults=h('div',{class:'dp-customer-results',role:'status'});search.parentElement.append(customerResults);
  const lineage=h('div',{class:'dp-wide'});model.fields.append(lineage);
  model.onError=error=>{
    if(job||error.code!=='dispatch_lineage_selection_required'||!Array.isArray(error.details?.candidates))return;
    const candidates=error.details.candidates.filter(row=>row.customerId===selectedCustomer?.id&&typeof row.jobId==='string');
    const choose=select([['','Choose a previous visit'],...candidates.map(row=>[row.jobId,[row.date||'Unscheduled',row.customer||'Customer job',row.address||'Address missing',row.jobId].join(' · ')])],sourceJobId||'',id=>{sourceJobId=id||null;},{required:true});
    lineage.replaceChildren(notice('This customer has more than one saved account or property history. Select the prior visit whose customer account this booking should use, and review its address.'),labeled('Previous customer visit',choose));
    if(error.details.truncated){const custom=h('input',{type:'text',maxLength:180,placeholder:'Exact job ID from Search all jobs',oninput:event=>{sourceJobId=event.target.value.trim()||choose.value||null;choose.required=!event.target.value.trim();}});lineage.append(labeled('Different prior job ID',custom,'Only the first 50 prior visits are listed. The selected job must belong to this exact customer.'));}
    choose.focus();
  };
  let customerGeneration=0,customerTimer=0;
  // One search once typing pauses; a newer keystroke or a closed form drops it.
  search.addEventListener('input',()=>{
    if(job)return;selectedCustomer=null;sourceJobId=null;lineage.replaceChildren();clearTimeout(customerTimer);const g=++customerGeneration,q=search.value.trim();if(q.length<2){customerResults.replaceChildren(h('small',{},'Type at least 2 characters.'));return;}
    customerResults.replaceChildren(h('small',{},'Searching…'));
    customerTimer=setTimeout(async()=>{
    if(g!==customerGeneration||S.modal!==model)return;
    try{const r=await api('?'+new URLSearchParams({view:'customers',q}));if(g!==customerGeneration||S.modal!==model)return;customerResults.replaceChildren(...r.customers.map(c=>btn(c.name+' · '+(c.phone||c.address||'No contact details'),()=>{selectedCustomer=c;search.value=c.name;address.value=c.address||'';customerResults.replaceChildren(h('small',{},'Customer selected'));})));if(!r.customers.length)customerResults.append(h('p',{},'No matching Hub customer. Create or link the customer in Customers first.'));}
    catch(error){if(g===customerGeneration&&S.modal===model)customerResults.replaceChildren(notice(errorText(error),'error'));}
    },CUSTOMER_SEARCH_DELAY_MS);
  });
  const type=select([['job','Service job'],['walkthrough','Walkthrough']],job?.type||'job',()=>{},{name:'type',disabled:!!job});
  model.fields.append(labeled('Work type',type));
  const lists=!job&&S.data.funnel,booking={};
  if(lists&&Array.isArray(lists.bookingChannels)) {
    booking.channel=codeSelect(lists.bookingChannels,'',{name:'bookingChannel',required:true});
    booking.purpose=codeSelect((lists.visitPurposes||[]).filter(value=>['service','install','return','rework'].includes(value)),'service',{name:'visitPurpose'});
    booking.original=h('input',{type:'text',name:'reworkOfJobId',maxLength:180,autocomplete:'off',autocapitalize:'off',spellcheck:false,placeholder:'Job ID from Search all jobs'});
    booking.heard=codeSelect(lists.selfReportedChannels||[],'',{name:'channelSelfReported'});
    booking.crm=Array.isArray(lists.crmLinkReasons)?codeSelect(lists.crmLinkReasons,'',{name:'crmLinkReason'}):null;
    const purpose=labeled('Visit purpose',booking.purpose),original=labeled('Original job being reworked',booking.original,'The rework joins that job’s project. It must be this customer’s job.'),crm=booking.crm?labeled('Why is there no CRM contact?',booking.crm):null;
    model.fields.append(labeled('How was this booked?',booking.channel),purpose,original,labeled('How did they hear about us?',booking.heard),...(crm?[crm]:[]));
    // A rework names its original job; a customer with no CRM contact needs the reason (FUN-02).
    const syncBooking=()=>{const isJob=type.value==='job',rework=isJob&&booking.purpose.value==='rework',unlinked=Boolean(crm)&&selectedCustomer?.crmLinked===false;purpose.hidden=!isJob;original.hidden=!rework;booking.original.required=rework;if(crm){crm.hidden=!unlinked;booking.crm.required=unlinked;}};
    for(const control of [type,booking.purpose])control.addEventListener('change',syncBooking);
    search.addEventListener('input',syncBooking);customerResults.addEventListener('click',syncBooking);syncBooking();
    booking.dimensions=dimensionControls(model,lists,()=>selectedCustomer?.id?{customerId:selectedCustomer.id,kind:type.value,...(type.value==='job'&&booking.purpose.value?{visitPurpose:booking.purpose.value}:{}),...(booking.channel.value?{channel:booking.channel.value}:{}),...(booking.original.required&&booking.original.value.trim()?{reworkOfJobId:booking.original.value.trim()}:{}),...(model.form.querySelector('[name="serviceType"]')?.value.trim()?{serviceType:model.form.querySelector('[name="serviceType"]').value.trim().slice(0,200)}:{})}:null);
    if(booking.dimensions){for(const control of [type,booking.purpose,booking.channel])control.addEventListener('change',booking.dimensions.refresh);for(const control of [search,booking.original])control.addEventListener('input',booking.dimensions.refresh);customerResults.addEventListener('click',booking.dimensions.refresh);booking.dimensions.refresh();}
  }
  const service=field(model,'serviceType','Service',job?.serviceType||'','text',{required:true,maxLength:200,placeholder:'Garage cleanout, organization, shelving…'});
  if(booking.dimensions)service.addEventListener('input',booking.dimensions.refresh);
  let date=options.moveTo||options.date||job?.date||S.date;
  const dayOffset=job?.date&&job?.endDate?Math.round((Date.parse(job.endDate+'T12:00Z')-Date.parse(job.date+'T12:00Z'))/86400000):0;
  const unscheduled=h('input',{type:'checkbox',checked:job?!job.date&&!options.date:false,name:'unscheduled'});
  model.fields.append(h('label',{class:'dp-check dp-wide'},unscheduled,h('span',{},'Keep unscheduled')));
  const startDate=field(model,'date','Start date',date,'date',{required:true});
  const startTime=field(model,'time','Start time',options.time||job?.time||'08:00','time',{required:true});
  const endDate=field(model,'endDate','End date',options.moveTo?addDays(date,dayOffset):(options.endDate||job?.endDate||date),'date',{required:true});
  const endTime=field(model,'endTime','End time',options.endTime||job?.endTime||'10:00','time',{required:true});
  const timing=[startDate,startTime,endDate,endTime];
  // Moving a placed visit asks why and who asked (FUN-02 reschedule reason).
  const moveBox=h('fieldset',{class:'dp-wide',hidden:true},h('legend',{},'Why is this visit moving?')),moveReason=job?.date?reasonControls(moveBox,'reschedule',{who:true,required:false}):null;
  if(moveReason)model.fields.append(moveBox);
  const toggle=()=>{for(const input of timing){input.disabled=unscheduled.checked;input.required=!unscheduled.checked;}};unscheduled.addEventListener('change',toggle);toggle();
  const blankArrival=arrivalBlankText(S.data?.arrivalDefaults);
  const arrivalHelp=h('small',{class:'dp-muted dp-wide',id:'dp-arrival-'+key()},'Optional customer arrival window in Mountain Time. It must include the start time; '+blankArrival);
  const arrivalStart=h('input',{type:'time',name:'arrivalWindowStart',value:job?.arrivalWindowStart||'','aria-describedby':arrivalHelp.id}),arrivalEnd=h('input',{type:'time',name:'arrivalWindowEnd',value:job?.arrivalWindowEnd||'','aria-describedby':arrivalHelp.id}),arrival=[arrivalStart,arrivalEnd];
  const arrivalNote=h('div',{class:'dp-wide dp-arrival-note','aria-live':'polite'});
  model.fields.append(labeled('Arrival from',arrivalStart),labeled('Arrival to',arrivalEnd),arrivalHelp,arrivalNote);
  for(const input of arrival)input.addEventListener('input',()=>arrivalNote.replaceChildren());
  const arrivalToggle=()=>{for(const input of arrival)input.disabled=unscheduled.checked;};unscheduled.addEventListener('change',arrivalToggle);arrivalToggle();
  let previousStart=startTime.value;
  // Moving the start time moves a custom arrival window with it. A window that
  // would cross midnight is cleared, and the manager is told why.
  startTime.addEventListener('change',()=>{const shift=minutesOf(startTime.value)-minutesOf(previousStart);previousStart=startTime.value;if(!shift||!arrival.every(input=>input.value))return;const [from,to]=arrival.map(input=>minutesOf(input.value)+shift);if(!(from>=0&&to<1440)){for(const input of arrival)input.value='';arrivalNote.replaceChildren(notice('The custom arrival window was cleared because moving it with the new start time would cross midnight. Set a new window, or '+blankArrival));return;}arrivalNote.replaceChildren();arrivalStart.value=hhmm(from);arrivalEnd.value=hhmm(to);});
  // Unscheduled work starts from a suggested length that fits one workday; a
  // longer one is listed but never applied as one overnight block. A chosen
  // length keeps the end in step with the start until the end is edited by hand.
  const suggested=durationSuggestion(job),oneDay=Boolean(suggested)&&suggested.minutes<=WORKDAY_MINUTES,setEnd=value=>{
    if(!value||!startDate.value||!startTime.value)return;const minute=Number(startTime.value.slice(0,2))*60+Number(startTime.value.slice(3))+Number(value);endDate.value=addDays(startDate.value,Math.floor(minute/1440));endTime.value=String(Math.floor(minute/60)%24).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
  };
  let applied=oneDay&&!job.date&&!options.date;
  const duration=select(durationOptions(suggested),applied?String(suggested.minutes):'',value=>{applied=false;setEnd(value);});model.fields.append(labeled('Expected duration',duration));
  const longer=oneDay||suggested?.capped?'':' That is longer than one workday, so split it across days rather than one overnight block.',hint=suggested?durationHint(job,suggested,duration,longer):null;if(hint)model.fields.append(hint);
  setEnd(duration.value);for(const input of [startDate,startTime])input.addEventListener('change',()=>setEnd(duration.value));for(const input of [endDate,endTime])input.addEventListener('input',()=>{duration.value='';applied=false;});
  const address=field(model,'address','Job address',job?.address||'','textarea',{maxLength:1000,rows:2});
  const assignments=h('fieldset',{class:'dp-assignment dp-wide'},h('legend',{},'Assigned employees'));
  // A found opening wins over the job's saved crew, lead, vehicle and buffer,
  // so the job is saved with what the opening was checked for.
  const opening=Array.isArray(options.assignedCrew),selected=new Set(options.assignedCrew||job?.assignedCrew||[]);
  const checks=new Map();
  for(const member of S.data.roster||[]){const input=h('input',{type:'checkbox',value:member.id,checked:selected.has(member.id)});checks.set(member.id,input);assignments.append(h('label',{class:'dp-check'},input,h('span',{},member.name),h('small',{},words(member.role))));}
  for(const member of selected)if(!checks.has(member)){const input=h('input',{type:'checkbox',value:member,checked:true});checks.set(member,input);assignments.append(h('label',{class:'dp-check'},input,h('span',{},member),h('small',{},'Unavailable employee — reassign before saving')));}
  if(!checks.size)assignments.append(h('p',{},'No active employees available. Review approved employee accounts.'));
  const crewSelect=select([['','Temporary / individual assignment'],...(S.data.crews||[]).filter(c=>c.status==='active'||c.id===job?.crewId).map(c=>[c.id,c.name])],(opening?options.crewId:job?.crewId)||'',id=>{
    const crew=S.data.crews.find(c=>c.id===id);if(!crew)return;
    for(const [member,input]of checks)input.checked=crew.memberIds.includes(member);lead.value=crew.leadId||'';
  },{name:'crewId'});
  model.fields.append(labeled('Saved crew',crewSelect),assignments);
  const lead=select([['','No lead assigned'],...(S.data.roster||[]).map(p=>[p.id,p.name])],options.crewLead||(!opening||selected.has(job?.crewLead)?job?.crewLead:'')||'',()=>{}, {name:'crewLead'});
  const truck=select([['','No vehicle assigned'],...(S.data.vehicles||[]).filter(v=>v.status==='available'||v.id===job?.vehicleId).map(v=>[v.id,v.name+(v.status==='available'?'':' · '+words(v.status))])],(opening?options.vehicleId:job?.vehicleId)||'',()=>{},{name:'vehicleId'});
  model.fields.append(labeled('Crew lead',lead),labeled('Vehicle / truck',truck));
  let segments=segmentsOf(job).map(s=>({...s,endDate:s.endDate||s.date,assignedCrew:[...(s.assignedCrew||[])],notes:s.notes||''}));
  if(options.moveTo&&segments.length&&job?.date&&segmentsOn()){const shift=Math.round((Date.parse(options.moveTo+'T12:00Z')-Date.parse(job.date+'T12:00Z'))/86400000);segments=segments.map(s=>({...s,date:addDays(s.date,shift),endDate:addDays(s.endDate,shift)}));}
  // Unreadable saved segments are cleared together with the job-level time and crew.
  const hadSegments=segments.length>0||job?.segmentsInvalid===true,segmentBox=h('div',{class:'dp-segments dp-wide','aria-live':'polite'}),legacyControls=[...timing,unscheduled,duration,crewSelect,lead,truck];
  const legacyBlocks=[...timing,duration,crewSelect,lead,truck].map(control=>control.parentElement).concat([unscheduled.parentElement,assignments]);
  const segmentNotice=text=>{model.status.replaceChildren(notice(text,'error'));};
  const formCrew=()=>[...checks].filter(([,input])=>input.checked).map(([id])=>id);
  function segmentCard(segment,index) {
    const editable=segmentsOn(),label='Segment '+(index+1),card=h('section',{class:'dp-segment-card','aria-label':label});
    const endDay=h('input',{type:'date',value:segment.endDate||'',required:true,disabled:!editable,oninput:e=>{segment.endDate=e.target.value;}});
    const day=h('input',{type:'date',value:segment.date||'',required:true,disabled:!editable,oninput:e=>{if(!segment.endDate||segment.endDate===segment.date){segment.endDate=e.target.value;endDay.value=e.target.value;}segment.date=e.target.value;}});
    const from=h('input',{type:'time',value:segment.time||'',required:true,disabled:!editable,oninput:e=>{segment.time=e.target.value;}});
    const to=h('input',{type:'time',value:segment.endTime||'',required:true,disabled:!editable,oninput:e=>{segment.endTime=e.target.value;}});
    const crew=h('fieldset',{class:'dp-segment-crew dp-wide'},h('legend',{},label+' employees'));
    const roster=(S.data.roster||[]).map(p=>[p.id,p.name]).concat(segment.assignedCrew.filter(id=>!(S.data.roster||[]).some(p=>p.id===id)).map(id=>[id,id+' · unavailable, reassign before saving']));
    for(const [id,name]of roster)crew.append(h('label',{class:'dp-check'},h('input',{type:'checkbox',value:id,checked:segment.assignedCrew.includes(id),disabled:!editable,onchange:e=>{segment.assignedCrew=e.target.checked?[...new Set([...segment.assignedCrew,id])]:segment.assignedCrew.filter(value=>value!==id);}}),h('span',{},name)));
    const leadChoice=select([['','No lead'],...(S.data.roster||[]).map(p=>[p.id,p.name])],segment.crewLead||'',value=>{segment.crewLead=value||null;},{disabled:!editable});
    const truckChoice=select([['','No vehicle'],...(S.data.vehicles||[]).filter(v=>v.status==='available'||v.id===segment.vehicleId).map(v=>[v.id,v.name+(v.status==='available'?'':' · '+words(v.status))])],segment.vehicleId||'',value=>{segment.vehicleId=value||null;},{disabled:!editable});
    const note=h('textarea',{rows:2,maxLength:2000,value:segment.notes||'',disabled:!editable,oninput:e=>{segment.notes=e.target.value;}});
    const noteField=labeled('Segment notes',note);noteField.classList.add('dp-wide');
    card.append(h('header',{},h('h4',{},label),editable?btn('Remove',()=>{segments.splice(index,1);syncSegments();segmentBox.querySelector('.dp-segment-actions button')?.focus();},'subtle',{'aria-label':'Remove '+label.toLowerCase()}):null),
      labeled('Segment date',day),labeled('Segment start',from),labeled('Segment end date',endDay),labeled('Segment end',to),crew,labeled('Segment lead',leadChoice),labeled('Segment vehicle',truckChoice),noteField);
    return card;
  }
  function addSegment() {
    if(segments.length>=segmentMax())return;
    if(!segments.length) {
      if(unscheduled.checked||!startDate.value||!startTime.value||!endDate.value||!endTime.value)return segmentNotice('Set the job date and times before adding a crew segment.');
      segments.push({id:segmentId(),date:startDate.value,time:startTime.value,endDate:endDate.value,endTime:endTime.value,assignedCrew:formCrew(),crewLead:lead.value||null,crewId:crewSelect.value||null,vehicleId:truck.value||null,notes:''});
    }
    const last=segments[segments.length-1];
    segments.push({id:segmentId(),date:last.date,time:last.time,endDate:last.endDate,endTime:last.endTime,assignedCrew:[],crewLead:null,crewId:null,vehicleId:null,notes:''});
    model.status.replaceChildren();syncSegments();segmentBox.querySelector('.dp-segment-card:last-of-type input')?.focus();
  }
  function splitDays() {
    if(unscheduled.checked||!startDate.value||!endDate.value||endDate.value<=startDate.value)return segmentNotice('Set a start date and a later end date, then split the job into daily work windows.');
    if(!(startTime.value<endTime.value))return segmentNotice('Each day needs an end time after its start time, such as 8:00 AM to 5:00 PM.');
    const days=[];for(let day=startDate.value;day<=endDate.value&&days.length<=segmentMax();day=addDays(day,1))days.push(day);
    if(days.length>segmentMax())return segmentNotice('A job can be split into at most '+segmentMax()+' segments.');
    const crew=formCrew();
    segments=days.map(day=>({id:segmentId(),date:day,time:startTime.value,endDate:day,endTime:endTime.value,assignedCrew:[...crew],crewLead:lead.value||null,crewId:crewSelect.value||null,vehicleId:truck.value||null,notes:''}));
    model.status.replaceChildren();syncSegments();
  }
  function syncSegments() {
    const on=segments.length>0;
    for(const block of legacyBlocks)block.hidden=on;
    for(const control of legacyControls)control.disabled=on||timing.includes(control)&&unscheduled.checked;
    for(const input of checks.values())input.disabled=on;
    for(const input of arrival)input.disabled=!on&&unscheduled.checked;
    segmentBox.replaceChildren();
    if(job?.segmentsInvalid&&!on)segmentBox.append(notice('The saved crew segments for this job could not be read. Saving replaces them with the job time and crew set here.','error'));
    if(!segmentsOn()&&!on)return;
    segmentBox.append(h('h3',{},'Crew segments'),h('p',{class:'dp-muted'},on?'Each segment has its own time, crew and vehicle. The job time and crew come from these segments.':'Split this job between crews working at the same time, or across days with a daily work window.'));
    if(!segmentsOn())segmentBox.append(notice('Crew segments are turned off for this Hub. Keep them, or remove them all to set one job-level time and crew.'));
    segments.forEach((segment,index)=>segmentBox.append(segmentCard(segment,index)));
    const actions=h('div',{class:'dp-segment-actions'});
    if(segmentsOn())actions.append(btn('Add crew segment',addSegment,'',{disabled:segments.length>=segmentMax()}),on?null:btn('Split across days',splitDays));
    else if(on)actions.append(btn('Remove all segments',()=>{segments=[];syncSegments();}));
    segmentBox.append(actions);
  }
  model.fields.append(segmentBox);syncSegments();
  const segmentProblem=()=>segments.map((s,i)=>!s.date||!s.time||!s.endDate||!s.endTime||!(s.endDate+'T'+s.endTime>s.date+'T'+s.time)?'Segment '+(i+1)+' needs a date, start and a later end.':s.crewLead&&!s.assignedCrew.includes(s.crewLead)?'Segment '+(i+1)+': the lead must be one of its employees.':'').find(Boolean);
  const crewNeeded=field(model,'crewNeeded','Required crew size',job?.crewNeeded||options.assignedCrew?.length||1,'number',{min:1,max:20,step:1,required:true});
  // The suggestion was computed for the saved crew. Another size drops a length
  // the form applied and says the suggestion is recalculated on save.
  if(hint)crewNeeded.addEventListener('input',()=>{const changed=Number(crewNeeded.value)!==(job.crewNeeded||1);if(changed&&applied){duration.value='';applied=false;}hint.textContent=durationNote(job,suggested)+longer+(changed?' The crew size changed, so check the end time; the suggestion is recalculated after you save.':'');});
  field(model,'travelBufferMinutes','Travel buffer (minutes)',options.travelBufferMinutes??job?.travelBufferMinutes??20,'number',{min:0,max:180,step:5});
  const instructions=field(model,'scope','Scope of work',scope(job||{}),'textarea',{rows:4,maxLength:20000,placeholder:'What the customer bought and what the crew must complete.'});instructions.parentElement.classList.add('dp-wide');
  field(model,'accessInstructions','Access instructions',job?.accessInstructions||'','textarea',{rows:2,maxLength:5000});
  field(model,'customerInstructions','Customer instructions',job?.customerInstructions||'','textarea',{rows:2,maxLength:5000});
  field(model,'requiredEquipment','Required equipment — one per line',(job?.requiredEquipment||[]).join('\n'),'textarea',{rows:3,maxLength:5000});
  field(model,'materials','Materials — one per line',(job?.materials||[]).map(m=>m.name).join('\n'),'textarea',{rows:3,maxLength:5000});
  field(model,'opsNotes','Internal dispatch notes',job?.opsNotes||'','textarea',{rows:3,maxLength:5000});
  model.footer.append(btn('Back',model.close),h('button',{class:'dp-btn primary',type:'submit'},job?'Save changes':'Create job'));
  const firstStart=()=>{const first=segments.slice().sort((a,b)=>(a.date+'T'+a.time).localeCompare(b.date+'T'+b.time))[0];return first?first.date+'T'+first.time:unscheduled.checked?'':startDate.value+'T'+startTime.value;};
  const moved=()=>Boolean(moveReason)&&firstStart()!==job.date+'T'+job.time;
  const syncMove=()=>{if(!moveReason)return;const on=moved();moveBox.hidden=!on;for(const control of moveReason.controls)control.required=on;};
  model.form.addEventListener('input',syncMove);model.form.addEventListener('change',syncMove);syncMove();
  model.form.addEventListener('submit',event=>{
    event.preventDefault();if(!job&&!selectedCustomer){model.status.replaceChildren(notice('Select an existing Hub customer before scheduling.','error'));search.focus();return;}
    const data=new FormData(model.form),members=[...checks].filter(([,input])=>input.checked).map(([id])=>id);
    if(!segments.length&&lead.value&&!members.includes(lead.value)){model.status.replaceChildren(notice('The crew lead must be selected in Assigned employees.','error'));return;}
    const problem=segments.length&&segmentsOn()?segmentProblem():'';if(problem){model.status.replaceChildren(notice(problem,'error'));return;}
    const first=segments.slice().sort((a,b)=>(a.date+'T'+a.time).localeCompare(b.date+'T'+b.time))[0],begins=first?first.time:startTime.value;
    const [from,to]=unscheduled.checked&&!first?['','']:arrival.map(input=>input.value);
    if(Boolean(from)!==Boolean(to)||from&&!(from<to&&from<=begins&&begins<=to)){model.status.replaceChildren(notice('Set both arrival times so the window starts at or before the start time and ends at or after it, or clear both.','error'));(from?arrivalEnd:arrivalStart).focus();return;}
    const list=name=>String(data.get(name)||'').split('\n').map(v=>v.trim()).filter(Boolean);
    const changes={date:unscheduled.checked?'':startDate.value,time:unscheduled.checked?'':startTime.value,endDate:unscheduled.checked?'':endDate.value,endTime:unscheduled.checked?'':endTime.value,
      serviceType:service.value.trim(),address:address.value.trim(),assignedCrew:members,crewId:crewSelect.value||null,crewLead:lead.value||null,vehicleId:truck.value||null,
      crewNeeded:Number(data.get('crewNeeded')),travelBufferMinutes:Number(data.get('travelBufferMinutes')),jobInstructions:instructions.value.trim(),
      accessInstructions:String(data.get('accessInstructions')||'').trim(),customerInstructions:String(data.get('customerInstructions')||'').trim(),opsNotes:String(data.get('opsNotes')||'').trim(),
      requiredEquipment:list('requiredEquipment'),materials:list('materials').map((name,i)=>{const existing=job?.materials?.find(m=>m.name===name);return existing||{id:'material-'+i+'-'+name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,30),name,quantity:1};})};
    Object.assign(changes,{arrivalWindowStart:from||null,arrivalWindowEnd:to||null});
    // The server derives the job time and crew from segments; it never takes both.
    if(segments.length){for(const name of ['date','time','endDate','endTime','assignedCrew','crewId','crewLead','vehicleId'])delete changes[name];
      if(segmentsOn())changes.assignmentSegments=segments.map(s=>({id:s.id,date:s.date,time:s.time,endDate:s.endDate||s.date,endTime:s.endTime,assignedCrew:[...s.assignedCrew],crewLead:s.crewLead||null,...(s.crewId&&(S.data.crews||[]).some(c=>c.id===s.crewId&&c.status==='active')?{crewId:s.crewId}:{}),vehicleId:s.vehicleId||null,notes:(s.notes||'').trim()}));}
    else if(hadSegments)changes.assignmentSegments=[];
    const facts=booking.channel?Object.fromEntries([['channel',booking.channel.value],['visitPurpose',type.value==='job'?booking.purpose.value:''],['reworkOfJobId',booking.original.required?booking.original.value.trim():''],['channelSelfReported',booking.heard.value],['crmLinkReason',booking.crm?.required?booking.crm.value:''],...Object.entries(booking.dimensions?.facts()||{})].filter(([,value])=>value)):null;
    const body=job?{action:'schedule.update',requestId:key(),jobId:job.id,expectedRevision:job.revision,changes,...(moved()?moveReason():{})}:{action:'schedule.create',requestId:key(),customerId:selectedCustomer.id,kind:type.value,...(sourceJobId?{sourceJobId}:{}),...(facts?{booking:facts}:{}),changes};
    void save(model,body,job?'Job updated.':'Job created.');
  });
  setTimeout(()=>search.focus(),0);
}
function openStatus(job,action) {
  const cancel=action==='schedule.cancel',noShow=action==='schedule.no_show';
  const model=modal(cancel?'Cancel job':noShow?'Record no-show':'Restore job',cancel?'The job remains in history. The assigned crew will see the cancellation on refresh.':noShow?'The visit did not happen. Its crew and time are freed. This does not message the customer or change the CRM appointment.':'The original schedule and assignment will be checked for conflicts before restoration.');if(!model)return;
  model.fields.append(h('p',{class:'dp-wide'},(job.customer||job.title)+' · '+(job.date?dateText(job.date)+' '+clock(job.time):'Unscheduled')));
  const reason=cancel||noShow?reasonControls(model.fields,noShow?'noShow':'cancel',{who:cancel}):null;
  const note=cancel?field(model,'cancellationReason','Cancellation note (optional)','','textarea',{rows:2,maxLength:240}):null;
  if(note)note.parentElement.classList.add('dp-wide');
  if(noShow&&!reason)model.status.append(notice('No-show reasons could not be loaded. Refresh dispatch and try again.','error'));
  model.footer.append(btn('Back',model.close),h('button',{type:'submit',class:'dp-btn '+(cancel||noShow?'danger':'primary'),disabled:noShow&&!reason},cancel?'Cancel job':noShow?'Record no-show':'Restore job'));
  model.form.addEventListener('submit',e=>{e.preventDefault();const text=note?.value.trim();void save(model,{action,requestId:key(),jobId:job.id,expectedRevision:job.revision,changes:{},...(reason?reason():{}),...(text?{cancellationReason:text}:{})},cancel?'Job cancelled.':noShow?'No-show recorded.':'Job restored.');});
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
function unmount() {S.controller?.abort();S.generation++;if(S.refreshTimer)clearInterval(S.refreshTimer);S.refreshTimer=null;if(S.modal){S.modal.dialog.close();S.modal.dialog.remove();S.modal=null;}S.pending=false;S.root?.remove();S.root=null;S.host=null;S.data=null;S.viewer=null;S.recovery=null;}
window.addEventListener('egc:signout',()=>{try{for(let i=sessionStorage.length-1;i>=0;i--){const name=sessionStorage.key(i);if(name?.startsWith(recoveryPrefix))sessionStorage.removeItem(name);}}catch{}unmount();});
window.addEventListener('beforeunload',event=>{if(S.modal){event.preventDefault();event.returnValue='';}});
function registerView(name,view) {
  if(!/^[a-z][a-z0-9_]{1,23}$/.test(name)||['day','week','crew','jobs'].includes(name)||views.has(name)||typeof view?.label!=='string'||typeof view.range!=='function'||typeof view.render!=='function')throw new Error('Dispatch view '+name+' is invalid or already registered.');
  views.set(name,Object.freeze({label:view.label,range:view.range,step:typeof view.step==='function'?view.step:null,render:view.render,help:typeof view.help==='string'?view.help:''}));
  if(S.root&&!S.modal)render();
}
// Registered views share this client, its dialogs and the save-recovery protocol (same requestId on retry).
const internals=Object.freeze({state:()=>S,api,save,modal,openJob,show,redraw:renderBody,person,crewName,vehicle,h,btn,pill,notice,errorText,clock,dateText,addDays,today,words,key,segmentsOf,segmentsOn,active,warningsFor,reasonControls});
window.EGCDispatch={mount,unmount,refresh:load,canLeave:()=>!S.modal&&!S.pending,registerView,internals};
})();
