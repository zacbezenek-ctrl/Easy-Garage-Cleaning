/* Personal field agenda. Uses the server's current assignment, never cached CRM records. */
(function(){
'use strict';
let host=null,controller=null,timer=null,generation=0;
const TZ='America/Denver',closed=new Set(['completed','paid','invoiced','review_requested','cancelled','canceled','closed','noshow','no_show','no-show']);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const addDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
const onDate=(job,date)=>{const end=job.endDate&&job.endDate>job.date&&job.endTime==='00:00'?addDays(job.endDate,-1):job.endDate||job.date;return job.date<=date&&end>=date;};
function h(tag,props,...children){const el=document.createElement(tag);for(const[k,v]of Object.entries(props||{})){if(v==null)continue;if(k==='class')el.className=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v);}for(const child of children.flat(Infinity))if(child!=null)el.append(child instanceof Node?child:document.createTextNode(String(child)));return el;}
const words=value=>String(value||'scheduled').replaceAll('_',' ');
const time=value=>{const m=/^(\d\d):(\d\d)$/.exec(value||'');if(!m)return'Time needed';const hour=+m[1];return(hour%12||12)+':'+m[2]+(hour<12?' AM':' PM');};
const jobLink=job=>'/crew/job.html?jobId='+encodeURIComponent(job.id);
function card(job,label){
 const crew=job.crewMembers||[],lead=crew.find(p=>String(p.id||'').toLowerCase()===String(job.crewLead||'').toLowerCase())?.name||job.crewLead||'Lead not assigned';
 const complete=closed.has(job.status),checks=job.checklist||[];
 const el=h('article',{class:'ft-job '+(label==='CURRENT JOB'?'ft-current':'')},
   h('header',{},h('span',{class:'ft-eyebrow'},label),h('span',{class:'ft-status'},words(job.fieldStatus||job.status))),
   h('h3',{},job.customer||'Customer job'),h('p',{class:'ft-time'},time(job.time)+' – '+time(job.endTime)+(job.date!==today()?' · '+job.date:'')),
   job.address?h('a',{class:'ft-address',href:'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(job.address),target:'_blank',rel:'noopener'},job.address):h('p',{class:'ft-warning'},'Address missing — contact operations before travel.'),
   h('dl',{},h('div',{},h('dt',{},'Working with'),h('dd',{},crew.map(p=>p.name).join(', ')||'Crew not assigned')),h('div',{},h('dt',{},'Crew lead'),h('dd',{},lead)),h('div',{},h('dt',{},'Vehicle'),h('dd',{},job.vehicleName||'Vehicle not assigned'))));
 if(job.scope||job.customerGoal)el.append(h('p',{class:'ft-scope'},job.scope||job.customerGoal));
 if(job.customerInstructions)el.append(h('p',{class:'ft-instruction'},h('strong',{},'Customer: '),job.customerInstructions));
 if(job.accessInstructions)el.append(h('p',{class:'ft-instruction'},h('strong',{},'Access: '),job.accessInstructions));
 if(job.requiredEquipment?.length)el.append(h('p',{class:'ft-instruction'},h('strong',{},'Equipment: '),job.requiredEquipment.join(', ')));
 if(checks.length&&!complete)el.append(h('p',{class:'ft-progress'},checks.filter(c=>c.completed).length+' / '+checks.length+' checklist items complete'));
 const phone=String(job.phone||'').replace(/[^+0-9]/g,'');
 el.append(h('div',{class:'ft-actions'},h('a',{class:'ft-button primary',href:jobLink(job)},complete?'View completed job':'Open job & checklist'),phone?h('a',{class:'ft-button',href:'tel:'+phone},'Call customer'):null,job.address?h('a',{class:'ft-button',href:'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(job.address),target:'_blank',rel:'noopener'},'Navigate'):null));
 return el;
}
function render(data){
 if(!host?.isConnected)return;
 const date=today(),jobs=data.jobs||[],dayJobs=jobs.filter(j=>onDate(j,date)),open=dayJobs.filter(j=>!closed.has(j.status)),current=open.find(j=>['dispatched','arrived','in_progress'].includes(j.status))||open[0],next=open.find(j=>j.id!==current?.id)||jobs.find(j=>j.date>date&&!closed.has(j.status));
 host.replaceChildren(h('header',{class:'ft-head'},h('div',{},h('span',{class:'ft-eyebrow'},'YOUR FIELD DAY'),h('h2',{},'Today’s jobs')),h('button',{class:'ft-button',type:'button',onclick:()=>load()},'Refresh')));
 if(dayJobs.some(j=>['cancelled','canceled'].includes(j.status)))host.append(h('p',{class:'ft-warning'},dayJobs.filter(j=>['cancelled','canceled'].includes(j.status)).map(j=>j.customer||'Job').join(', ')+': cancelled. Check your remaining assignments.'));
 if(current)host.append(card(current,'CURRENT JOB'));
 else host.append(h('div',{class:'ft-empty'},h('h3',{},dayJobs.length?'No remaining active jobs today':'No jobs assigned today'),h('p',{},'Your current assignments are checked with the Hub on every refresh.'),h('a',{class:'ft-button',href:'/crew/job.html'},'Open field schedule')));
 if(next)host.append(card(next,next.date>date?'NEXT JOB · TOMORROW':'NEXT JOB'));
 const later=open.filter(j=>j.id!==current?.id&&j.id!==next?.id);
 if(later.length)host.append(h('section',{class:'ft-later'},h('h3',{},'Later today'),later.map(j=>h('a',{class:'ft-later-job',href:jobLink(j)},h('strong',{},time(j.time)+' · '+(j.customer||'Job')),h('span',{},j.address||'Address needed')))));
 const completed=dayJobs.filter(j=>['completed','paid','invoiced','review_requested','closed'].includes(j.status));
 if(completed.length)host.append(h('details',{class:'ft-completed'},h('summary',{},'Completed today · '+completed.length),completed.map(j=>h('a',{class:'ft-later-job',href:jobLink(j)},j.customer||'Job'))));
 host.append(h('p',{class:'ft-updated'},'Mountain Time · '+(data.generatedAt?'Checked '+new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(new Date(data.generatedAt)):'Current Hub assignments')));
}
async function load(){
 if(!host?.isConnected)return;
 const mine=++generation;controller?.abort();controller=new AbortController();
 if(!host.childNodes.length)host.append(h('p',{role:'status'},'Loading your assigned jobs…'));
 try{const response=await fetch('/api/field-jobs?'+new URLSearchParams({date:today(),days:'2',status:'all'}),{credentials:'same-origin',cache:'no-store',signal:controller.signal}),data=await response.json().catch(()=>({}));if(mine!==generation||!host?.isConnected)return;if(!response.ok||data.ok!==true||!Array.isArray(data.jobs)||data.jobs.some(job=>!job||typeof job.id!=='string'))throw Object.assign(new Error(data.error||'Your current schedule could not be verified. Retry before dispatching.'),{status:response.ok?503:response.status});render(data);}
 catch(error){if(error.name==='AbortError'||mine!==generation||!host?.isConnected)return;host.replaceChildren(...[h('h2',{},'Today’s jobs'),h('p',{class:'ft-warning',role:'alert'},error.message),h('button',{class:'ft-button',type:'button',onclick:()=>load()},'Retry'),error.status===401?h('a',{class:'ft-button',href:'/crew/job.html'},'Sign in again'):null].filter(Boolean));}
}
function unmount(){host?.replaceChildren();controller?.abort();generation++;if(timer)clearInterval(timer);timer=null;host=null;}
function mount(target){if(host===target&&target?.isConnected)return;unmount();if(!target)return;host=target;host.classList.add('egc-field-today');void load();timer=setInterval(()=>{if(!document.hidden)void load();},60000);}
window.addEventListener('egc:signout',unmount);
window.EGCFieldToday={mount,unmount,refresh:load};
})();
