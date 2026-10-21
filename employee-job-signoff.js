/* Completed: needs sign-off (SIGNOFF, functions/_lib/job-signoff.js) on the Command center: the jobs crews completed in
   the last two weeks that a manager has not signed off yet, oldest first. Open job goes to the live job page (photos,
   checklist, notes); Sign off records the review; Flag asks what needs fixing and opens a crew follow-up for the lead.
   Jobs unsigned 48 hours after completion are flagged amber. Sign-off never holds up invoicing or payments. Nobody signs
   off a job they worked on, except the owner. Mounted by the home-widget registry (employee-hub-screens.js HOME_WIDGETS)
   or standalone with EGCJobSignoff.mount(host, ctx). A login that cannot sign off sees nothing. No money is shown. */
(function(){
'use strict';
const PATH='/api/job-signoff',TIMEOUT=20000,SHOWN=8;
const S={host:null,root:null,ctx:{},generation:0,controller:null,data:null,busy:'',flagging:'',error:'',draft:''};
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const button=(label,onClick,kind='',extra={})=>h('button',{type:'button',class:('hub-btn '+kind).trim(),onclick:onClick,...extra},label);
function fetcher(){return typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:typeof hubFetch==='function'?hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});}
const uuid=()=>crypto.randomUUID();
function dayLabel(date){try{return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));}catch{return date;}}
function since(hours){if(typeof hours!=='number')return 'Completion time needs review';if(hours<1)return 'Completed under an hour ago';if(hours<48)return `Completed ${Math.floor(hours)} h ago`;return `Completed ${Math.floor(hours/24)} days ago`;}
const validRow=row=>record(row)&&typeof row.jobId==='string'&&typeof row.customer==='string'&&typeof row.service==='string'&&typeof row.overdue==='boolean'&&typeof row.ownJob==='boolean'&&(row.signoff===null||record(row.signoff));
const valid=data=>record(data)&&data.ok===true&&Array.isArray(data.rows)&&data.rows.every(validRow)&&[data.needed,data.overdue,data.flagged].every(Number.isFinite);
async function request(init){
  const controller=S.controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
  try{const response=await fetcher()(PATH,{cache:'no-store',credentials:'same-origin',...init,signal:controller.signal});const body=await response.json().catch(()=>null);return{status:response.status,body};}
  finally{clearTimeout(timer);}
}
function frame(...body){
  const id='so-title-'+S.generation;
  return h('section',{class:'egc-job-signoff','aria-labelledby':id},h('header',{class:'so-head'},h('span',{class:'so-eyebrow'},'COMPLETED'),h('h2',{id},'Needs sign-off')),...body);
}
function show(node){if(!S.host)return;S.root?.remove();S.root=node;S.host.replaceChildren(node);}
function flagForm(row){
  // The reason typed so far survives a re-render (an error, a refresh).
  const area=h('textarea',{name:'reason',rows:'3',maxlength:'1000',required:'true','aria-label':'What needs fixing',oninput:event=>{S.draft=event.target.value;}},S.draft);
  const submit=event=>{event.preventDefault();const reason=area.value.trim();if(reason.length<3){S.error='Say what needs fixing.';render();return;}void act(row,'flag',reason);};
  return h('form',{class:'so-flag',onsubmit:submit},h('label',{},h('span',{},'What needs fixing? The crew lead gets a follow-up.'),area),h('div',{class:'so-actions'},h('button',{type:'submit',class:'hub-btn warn'},'Send flag'),button('Cancel',()=>{S.flagging='';S.error='';S.draft='';render();})));
}
function jobRow(row){
  const state=row.signoff?.status==='flagged'?'flagged':row.overdue?'overdue':'waiting',busy=S.busy===row.jobId;
  const badge=state==='flagged'?'Flagged':state==='overdue'?'Over 48 h':'Waiting';
  const meta=[dayLabel(row.date),row.service,row.lead?'Lead: '+row.lead:'',since(row.hoursSinceCompleted)].filter(Boolean).join(' · ');
  const notes=[row.hasIssues?'Crew reported issues':'',row.openFollowUp?'Open crew follow-up':'',row.signoff?.status==='flagged'?`Flagged by ${row.signoff.byName}: ${row.signoff.reason}`:''].filter(Boolean);
  const open=h('a',{class:'hub-btn',href:'/crew/job.html?jobId='+encodeURIComponent(row.jobId)},'Open job');
  const actions=row.ownJob?h('p',{class:'so-own'},'You worked this job, so another manager or the owner signs it off.',' ',open)
    :S.flagging===row.jobId?flagForm(row)
    :h('div',{class:'so-actions'},open,button(busy?'Saving…':'Sign off',()=>void act(row,'sign_off',''),'primary',{disabled:busy?'true':null}),row.signoff?.status==='flagged'?null:button('Flag',()=>{S.flagging=row.jobId;S.error='';S.draft='';render();},'',{disabled:busy?'true':null}));
  return h('li',{class:'so-job so-'+state,'data-so-job':row.jobId},h('div',{class:'so-job-head'},h('strong',{},row.customer),h('span',{class:'so-badge'},badge)),h('p',{class:'so-meta'},meta),notes.length?h('ul',{class:'so-notes'},notes.map(text=>h('li',{},text))):null,actions);
}
function render(){
  if(!S.host)return;
  const d=S.data;
  if(!d)return;
  if(!d.rows.length){show(frame(h('p',{class:'so-empty'},'Every job completed in the last two weeks is signed off.')));return;}
  const summary=[`${d.needed} waiting`,d.overdue?`${d.overdue} over 48 h`:'',d.flagged?`${d.flagged} flagged`:''].filter(Boolean).join(' · ');
  const rows=d.rows.slice(0,SHOWN);
  show(frame(h('p',{class:'so-count'+(d.overdue?' so-warn':'')},summary),S.error?h('div',{class:'hub-notice error',role:'alert'},S.error):null,h('ol',{class:'so-list'},rows.map(jobRow)),
    d.rows.length>SHOWN?h('p',{class:'so-more'},`${d.rows.length-SHOWN} more, oldest first above.`):null,h('div',{class:'so-actions'},button('Refresh',()=>void load()))));
}
async function act(row,action,reason){
  if(S.busy)return;
  S.busy=row.jobId;S.error='';render();
  try{
    const {status,body}=await request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,jobId:row.jobId,requestId:uuid(),reason})});
    if(status>=400||!record(body)||body.ok!==true){S.error=(record(body)&&typeof body.error==='string'?body.error:'This could not be saved. Retry in a moment.');S.busy='';render();return;}
    S.busy='';S.flagging='';S.draft='';if(typeof S.ctx.toast==='function')S.ctx.toast(action==='flag'?'Flagged: the crew lead has a follow-up.':'Signed off.');
    await load();
  }catch{S.error='This could not be saved. Retry in a moment.';S.busy='';render();}
}
async function load(){
  if(!S.host)return;
  const generation=++S.generation;S.controller?.abort();
  if(!S.data)show(frame(h('p',{class:'so-loading',role:'status'},'Checking completed jobs…')));
  try{
    const {status,body}=await request({});
    if(generation!==S.generation)return;
    // A login that cannot sign off jobs (a sales or call-desk account) sees no card at all.
    if(status===403||status===401){S.data=null;S.root?.remove();S.root=null;S.host.replaceChildren();return;}
    if(status!==200||!valid(body))throw new Error('job_signoff_unavailable');
    S.data=body;render();
  }catch{if(generation===S.generation){S.data=null;show(frame(h('div',{class:'hub-notice error so-state',role:'alert'},h('strong',{},'Sign-off list is unavailable'),h('p',{},'Completed jobs could not be checked right now. This does not mean they are all signed off.'),button('Retry',()=>void load()))));}}
}
function mount(host,ctx={}){if(!host)return;if(S.host===host&&S.root?.isConnected)return;unmount();S.host=host;S.ctx=record(ctx)?ctx:{};return load();}
function unmount(){S.generation++;S.controller?.abort();S.controller=null;S.root?.remove();S.root=null;S.host=null;S.ctx={};S.data=null;S.busy='';S.flagging='';S.error='';S.draft='';}
function refresh(){return S.host?load():undefined;}
window.addEventListener('egc:signout',()=>unmount());
window.EGCJobSignoff={mount,unmount,refresh};
})();
