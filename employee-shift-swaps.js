/* Shift swaps (SHIFT-SWAP, functions/_lib/shift-swaps.js) on the Hub homes, from GET/POST /api/shift-swaps.
   EGCShiftSwapsHome (the Shift swaps screen under MY EGC, every employee): ask a coworker to take one of your upcoming
   jobs, answer the requests sent to you, and follow or cancel your own. It is a screen, not a My day card, so the clock
   card stays on the phone's first screen. EGCShiftSwapsReview (Command center, managers and the owner): the accepted swaps
   waiting for approval; Approve runs the Dispatch change (its rules and crew notices apply), Deny closes the request.
   Nobody approves a swap they are part of, except the owner, and a request expires once the job starts. The review card
   shows nothing while no swap is waiting. Names, dates and times only. Registered in employee-hub-screens.js (MANIFEST and
   HOME_WIDGETS). */
(function(){
'use strict';
const PATH='/api/shift-swaps',TIMEOUT=20000;
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const button=(label,onClick,kind='',extra={})=>h('button',{type:'button',class:('hub-btn '+kind).trim(),onclick:onClick,...extra},label);
function when(date,time){
  const m=/^(\d{2}):(\d{2})/.exec(time||''),clock=m?`${Number(m[1])%12||12}:${m[2]} ${Number(m[1])<12?'AM':'PM'}`:'';
  let day=date;try{day=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));}catch{}
  return [day,clock].filter(Boolean).join(' ');
}
const STATUS={requested:'Waiting for {to}',accepted:'Accepted by {to}: waiting for a manager',approved:'Approved: {to} has the job',declined:'{to} declined',denied:'A manager denied it',cancelled:'Cancelled',expired:'Expired: the job started'};
const statusText=swap=>(STATUS[swap.status]||swap.status).replace('{to}',swap.toName);
const validSwap=row=>record(row)&&typeof row.id==='string'&&typeof row.status==='string'&&typeof row.toName==='string'&&typeof row.fromName==='string';
const valid=data=>record(data)&&data.ok===true&&Array.isArray(data.mine)&&Array.isArray(data.incoming)&&Array.isArray(data.jobs)&&Array.isArray(data.coworkers)&&data.mine.every(validSwap)&&data.incoming.every(validSwap)&&(data.approvals===undefined||Array.isArray(data.approvals)&&data.approvals.every(validSwap));

function widget(kind){
  const S={host:null,root:null,ctx:{},generation:0,controller:null,data:null,busy:'',error:''};
  const fetcher=()=>typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:typeof hubFetch==='function'?hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});
  async function request(init){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
    try{const response=await fetcher()(PATH,{cache:'no-store',credentials:'same-origin',...init,signal:controller.signal});return{status:response.status,body:await response.json().catch(()=>null)};}
    finally{clearTimeout(timer);}
  }
  function show(node){if(!S.host)return;S.root?.remove();S.root=node;if(node)S.host.replaceChildren(node);else S.host.replaceChildren();}
  function frame(eyebrow,title,...body){const id=`ss-${kind}-${S.generation}`;return h('section',{class:'egc-shift-swaps ss-'+kind,'aria-labelledby':id},h('header',{class:'ss-head'},h('span',{class:'ss-eyebrow'},eyebrow),h('h2',{id},title)),S.error?h('div',{class:'hub-notice error',role:'alert'},S.error):null,...body);}
  async function act(body,done){
    if(S.busy)return;
    S.busy=body.swapId||'new';S.error='';render();
    try{
      const {status,body:answer}=await request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      S.busy='';
      if(status>=400||!record(answer)||answer.ok!==true){S.error=record(answer)&&typeof answer.error==='string'?answer.error:'This could not be saved. Retry in a moment.';render();if(status===409)await load();return;}
      if(typeof S.ctx.toast==='function'&&done)S.ctx.toast(done);
      await load();
    }catch{S.busy='';S.error='This could not be saved. Retry in a moment.';render();}
  }
  const disabled=id=>S.busy&&(S.busy===id||S.busy==='new')?'true':null;
  // people: show who hands the job to whom (requests to you, approvals); otherwise the request's state.
  function swapLine(swap,actions,people=false){
    return h('li',{class:'ss-swap ss-'+swap.status,'data-ss-swap':swap.id},h('strong',{},`${when(swap.jobDate,swap.jobTime)} · ${swap.service}`),h('p',{class:'ss-meta'},people?`${swap.fromName} → ${swap.toName}`:statusText(swap)),swap.reason?h('p',{class:'ss-reason'},swap.reason):null,actions);
  }
  function home(d){
    const incoming=d.incoming.filter(swap=>swap.status==='requested');
    const asked=incoming.length?h('div',{class:'ss-block'},h('h3',{},'Asked of you'),h('ol',{class:'ss-list'},incoming.map(swap=>swapLine(swap,h('div',{class:'ss-actions'},
      button(S.busy===swap.id?'Saving…':'Accept',()=>void act({action:'accept',swapId:swap.id},'Accepted: a manager approves it next.'),'primary',{disabled:disabled(swap.id)}),
      button('Decline',()=>void act({action:'decline',swapId:swap.id},'Declined.'),'',{disabled:disabled(swap.id)})),true)))):null;
    const mine=d.mine.length?h('div',{class:'ss-block'},h('h3',{},'Your requests'),h('ol',{class:'ss-list'},d.mine.map(swap=>swapLine(swap,['requested','accepted'].includes(swap.status)?h('div',{class:'ss-actions'},button('Cancel request',()=>void act({action:'cancel',swapId:swap.id},'Request cancelled.'),'',{disabled:disabled(swap.id)})):null)))):null;
    let form=null;
    if(d.jobs.length&&d.coworkers.length){
      const job=h('select',{name:'jobId','aria-label':'Job to hand over'},d.jobs.map(row=>h('option',{value:row.id},`${when(row.date,row.time)} · ${row.service}`)));
      const to=h('select',{name:'to','aria-label':'Coworker'},d.coworkers.map(person=>h('option',{value:person.id},person.name)));
      const reason=h('textarea',{name:'reason',rows:'2',maxlength:'500','aria-label':'Reason (optional)',placeholder:'Reason (optional)'});
      const submit=event=>{event.preventDefault();void act({action:'request',requestId:crypto.randomUUID(),jobId:job.value,to:to.value,reason:reason.value.trim()},'Request sent. Your coworker accepts, then a manager approves.');};
      form=h('form',{class:'ss-form',onsubmit:submit},h('h3',{},'Ask a coworker to take a job'),h('label',{},h('span',{},'Job'),job),h('label',{},h('span',{},'Coworker'),to),reason,
        h('p',{class:'ss-meta'},'You stay on the job until your coworker accepts and a manager approves.'),h('div',{class:'ss-actions'},h('button',{type:'submit',class:'hub-btn primary',disabled:disabled('new')},S.busy==='new'?'Sending…':'Send request')));
    }
    const empty=!asked&&!mine&&!form?h('p',{class:'ss-empty'},'No upcoming jobs to hand over in the next two weeks.'):null;
    return frame('SHIFT SWAPS','Swap a shift',asked,mine,form,empty);
  }
  function review(d){
    const waiting=(d.approvals||[]).filter(swap=>swap.status==='accepted'),pending=(d.approvals||[]).filter(swap=>swap.status==='requested');
    if(!waiting.length&&!pending.length)return null;
    const list=waiting.length?h('ol',{class:'ss-list'},waiting.map(swap=>swapLine(swap,swap.canDecide===false?h('p',{class:'ss-meta'},'You are part of this swap, so another manager or the owner approves it.'):h('div',{class:'ss-actions'},
      button(S.busy===swap.id?'Saving…':'Approve',()=>void act({action:'approve',swapId:swap.id},'Approved: Dispatch updated and the crew notified.'),'primary',{disabled:disabled(swap.id)}),
      button('Deny',()=>void act({action:'deny',swapId:swap.id},'Denied.'),'',{disabled:disabled(swap.id)})),true))):h('p',{class:'ss-empty'},'Nothing to approve yet.');
    return frame('NEEDS ATTENTION',waiting.length?`Shift swaps to approve (${waiting.length})`:'Shift swaps',list,pending.length?h('p',{class:'ss-meta'},`${pending.length} more waiting for the coworker to accept.`):null);
  }
  function render(){if(!S.host||!S.data)return;show(kind==='review'?review(S.data):home(S.data));}
  async function load(){
    if(!S.host)return;
    const generation=++S.generation;
    try{
      const {status,body}=await request({});
      if(generation!==S.generation)return;
      if(status===401||status===403){S.data=null;show(null);return;}
      if(status!==200||!valid(body))throw new Error('shift_swaps_unavailable');
      S.data=body;render();
    }catch{if(generation===S.generation){S.data=null;show(kind==='review'?null:frame('SHIFT SWAPS','Swap a shift',h('div',{class:'hub-notice error',role:'alert'},'Shift swaps could not be loaded right now.'),button('Retry',()=>void load())));}}
  }
  function mount(host,ctx={}){if(!host)return;if(S.host===host&&(S.root?.isConnected||!S.root&&S.data))return;unmount();S.host=host;S.ctx=record(ctx)?ctx:{};return load();}
  function unmount(){S.generation++;S.root?.remove();S.root=null;S.host=null;S.ctx={};S.data=null;S.busy='';S.error='';}
  return {mount,unmount,refresh:()=>S.host?load():undefined};
}
window.EGCShiftSwapsHome=widget('home');
window.EGCShiftSwapsReview=widget('review');
window.addEventListener('egc:signout',()=>{window.EGCShiftSwapsHome.unmount();window.EGCShiftSwapsReview.unmount();});
})();
