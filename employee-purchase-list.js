/* Purchase list (WP14c, EGC_JOB_MATERIALS): what the office buys for upcoming jobs, grouped by store and product with
   quantities summed across jobs. Each job line links to its job; a manager marks lines ordered or purchased (POST
   /api/purchase-list, one request per job, recorded in that job's history) and the list updates in place; Refresh (or
   a refused mark) reads the date range again. The crew's Loaded tick on the job shows here as Loaded. Registered in employee-hub-screens.js and runs standalone with the UI kit (window.EGCHubKit). No
   prices or costs are shown. */
(function(){
'use strict';
const PATH='/api/purchase-list',DAYS=[7,14,21,31];
const S={host:null,ctx:null,data:null,error:null,loading:false,busy:false,start:'',days:14,showDone:false,feedback:'',feedbackError:false,generation:0,open:new Set()};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const STATES={to_buy:'To buy',ordered:'Ordered',purchased:'Purchased',loaded:'Loaded'};
const ERRORS={purchase_list_disabled:'The purchase list is not switched on for this Hub yet. Ask the owner to turn on structured job materials.',purchase_forbidden:'Only an operations manager or owner can open the purchase list.',purchase_range_too_large:'More than 500 jobs fall in this range. Choose fewer days.',purchase_material_missing:'A material changed on its job. The list was refreshed; check it and try again.',purchase_revision_conflict:'A job changed while the purchase was saved. The list was refreshed; check it and try again.',purchase_job_closed:'That job was cancelled or finished, so nothing more is bought for it. The list was refreshed.'};
const count=value=>Number.isFinite(value)?String(Math.round(value*100)/100):'0';
function valid(data){
  const k=kit();
  return Boolean(data&&data.ok===true&&k.validDate(data.start)&&k.validDate(data.end)&&Array.isArray(data.stores)&&data.stores.every(store=>store&&typeof store.store==='string'&&Array.isArray(store.products)
    &&store.products.every(product=>product&&typeof product.key==='string'&&typeof product.name==='string'&&product.byState&&typeof product.byState==='object'&&Array.isArray(product.jobs)
      &&product.jobs.every(job=>job&&typeof job.jobId==='string'&&typeof job.materialId==='string'&&Object.hasOwn(STATES,job.purchaseState)))));
}
const endDate=()=>kit().addDays(S.start,S.days-1);
const dayLabel=(date,time)=>{try{const day=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));const m=/^(\d{2}):(\d{2})$/.exec(time||'');return m?`${day} · ${Number(m[1])%12||12}:${m[2]} ${Number(m[1])<12?'AM':'PM'}`:day;}catch{return date;}};
const open=product=>(product.byState.to_buy||0)+(product.byState.ordered||0)>0;
async function load(){
  const generation=++S.generation;
  S.loading=true;S.error=null;render();
  try{
    const query=new URLSearchParams({start:S.start,end:endDate()});
    const data=await kit().requestJSON(`${PATH}?${query}`,{prefix:'purchase',validate:valid,fetcher:fetcher()});
    if(generation!==S.generation)return;
    S.data=data;
  }catch(error){if(generation===S.generation)S.error=error;}
  finally{if(generation===S.generation){S.loading=false;render();}}
}
// A saved mark is applied to the list in place from the server's answer ({changed:[{id,to}]}), so a tap costs no re-read
// of the whole date range; quantities per state are summed again from the product's job lines, as the server does.
function applyChanged(jobId,changed){
  const to=new Map(changed.filter(row=>row&&typeof row.id==='string'&&Object.hasOwn(STATES,row.to)).map(row=>[row.id,row.to]));
  for(const store of S.data?.stores||[])for(const product of store.products){
    const lines=product.jobs.filter(job=>job.jobId===jobId&&to.has(job.materialId)&&job.purchaseState!=='loaded');
    if(!lines.length)continue;
    for(const job of lines)job.purchaseState=to.get(job.materialId);
    const byState=Object.fromEntries(Object.keys(STATES).map(state=>[state,0]));
    for(const job of product.jobs)byState[job.purchaseState]+=Number(job.quantity)||0;
    product.byState=Object.fromEntries(Object.entries(byState).map(([state,value])=>[state,Math.round(value*100)/100]));
    product.toBuy=product.byState.to_buy;product.packsToBuy=product.unitsPerPack&&product.toBuy>0?Math.ceil(product.toBuy/product.unitsPerPack):null;
  }
}
// One request per job, each with its own request id; the server re-reads the job and keeps the change in its history.
// Only a refusal re-reads the list (the job changed under it); otherwise Refresh does.
async function mark(lines,state,what){
  if(S.busy||!lines.length)return;
  S.busy=true;S.feedback='';render();
  const byJob=new Map();for(const line of lines){if(!byJob.has(line.jobId))byJob.set(line.jobId,[]);byJob.get(line.jobId).push(line.materialId);}
  let saved=0,failed=null;
  for(const [jobId,materialIds] of byJob){
    try{const data=await kit().requestJSON(PATH,{method:'POST',prefix:'purchase',body:{requestId:kit().requestId(),jobId,materialIds:[...new Set(materialIds)],state},fetcher:fetcher(),validate:data=>data.ok===true&&data.jobId===jobId&&Array.isArray(data.changed)});applyChanged(jobId,data.changed);saved++;}
    catch(error){failed=error;break;}
  }
  S.busy=false;
  S.feedback=failed?`${saved?`Saved ${saved} job${saved===1?'':'s'}. `:''}${kit().errorText(failed,ERRORS)}`:`${what} marked ${STATES[state].toLowerCase()} on ${saved} job${saved===1?'':'s'}.`;S.feedbackError=Boolean(failed);
  if(failed)await load();else render();
}
function exportCsv(){
  if(!S.data)return;
  const rows=[['Store','Product','SKU','Unit','To buy','Packs to buy','Ordered','Purchased','Loaded','Total','Product link','Jobs']];
  for(const store of S.data.stores)for(const product of store.products)rows.push([store.store,product.name,product.sku,product.unit,count(product.byState.to_buy),product.packsToBuy??'',count(product.byState.ordered),count(product.byState.purchased),count(product.byState.loaded),count(product.quantity),product.productUrl,product.jobs.map(job=>`${job.date} ${job.customer||job.jobId} (${count(job.quantity)})`).join('; ')]);
  kit().downloadCsv(`egc-purchase-list-${S.data.start}-to-${S.data.end}`,rows);
}
function jobLine(product,job){
  const busy=S.busy||S.loading;
  return h('li',{class:'pl-job'},
    h('div',{class:'pl-job-text'},h('a',{href:job.href||`/crew/job.html?jobId=${encodeURIComponent(job.jobId)}`},dayLabel(job.date,job.time),' · ',job.customer||job.title||'Job'),h('small',{},`Qty ${count(job.quantity)}${job.packs?` · ${job.packs} pack${job.packs===1?'':'s'}`:''}`)),
    h('span',{class:`pl-state ${job.purchaseState}`},STATES[job.purchaseState]),
    job.purchaseState==='loaded'?null:h('div',{class:'pl-job-actions'},
      job.purchaseState==='to_buy'?kit().button('Ordered',()=>mark([job],'ordered',product.name),'',{disabled:busy}):null,
      job.purchaseState!=='purchased'?kit().button('Purchased',()=>mark([job],'purchased',product.name),'',{disabled:busy}):kit().button('Undo',()=>mark([job],'to_buy',product.name),'',{disabled:busy})));
}
function productRow(product){
  const busy=S.busy||S.loading,pending=product.jobs.filter(job=>['to_buy','ordered'].includes(job.purchaseState)),toBuy=product.jobs.filter(job=>job.purchaseState==='to_buy');
  const meta=[product.sku?`SKU ${product.sku}`:'',product.unit,product.unitsPerPack?`packs of ${product.unitsPerPack}`:''].filter(Boolean).join(' · ');
  const expanded=S.open.has(product.key);
  return h('li',{class:'pl-product','data-product':product.key},
    h('div',{class:'pl-product-head'},
      h('div',{class:'pl-product-text'},h('strong',{},product.name),meta?h('small',{},meta):null,product.productUrl?h('a',{href:product.productUrl,target:'_blank',rel:'noopener noreferrer'},'Product page ↗'):null),
      h('div',{class:'pl-qty'},h('span',{class:'pl-big'},count(product.byState.to_buy)),h('small',{},product.packsToBuy?`to buy · ${product.packsToBuy} pack${product.packsToBuy===1?'':'s'}`:'to buy'))),
    h('p',{class:'pl-states'},Object.entries(STATES).map(([state,name])=>`${name} ${count(product.byState[state])}`).join(' · ')),
    pending.length?h('div',{class:'hub-actions'},toBuy.length?kit().button(`Mark all ordered (${toBuy.length})`,()=>mark(toBuy,'ordered',product.name),'',{disabled:busy}):null,kit().button(`Mark all purchased (${pending.length})`,()=>mark(pending,'purchased',product.name),'primary',{disabled:busy})):null,
    h('details',{open:expanded,ontoggle:event=>{if(event.target.open)S.open.add(product.key);else S.open.delete(product.key);}},h('summary',{},`${product.jobs.length} job${product.jobs.length===1?'':'s'}`),h('ul',{class:'pl-jobs'},product.jobs.map(job=>jobLine(product,job)))));
}
function render(){
  const host=S.host;if(!host)return;
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'Job materials'),h('h2',{},'Purchase list'),h('p',{},'Everything to buy for upcoming jobs, by store. Quantities add up across jobs; open a product to see each job. Stock items the crew takes from the yard are on each job’s Grab before you go list.')));
  const controls=h('div',{class:'pl-filters'},
    h('label',{class:'hub-field'},h('span',{},'From'),h('input',{id:'pl-start',type:'date',value:S.start,disabled:S.busy,onchange:event=>{if(kit().validDate(event.target.value)){S.start=event.target.value;load();}}})),
    h('label',{class:'hub-field'},h('span',{},'Days'),h('select',{id:'pl-days',disabled:S.busy,onchange:event=>{S.days=Number(event.target.value);load();}},DAYS.map(days=>h('option',{value:String(days),selected:days===S.days},`${days} days`)))),
    kit().button('Refresh',()=>load(),'',{disabled:S.busy||S.loading}),
    kit().button(S.showDone?'✓ Show bought items':'Show bought items',()=>{S.showDone=!S.showDone;render();},'pl-done',{'aria-pressed':S.showDone?'true':'false'}),
    kit().button('Export CSV',exportCsv,'',{disabled:!S.data}));
  if(!S.data){
    host.replaceChildren(h('div',{class:'hub-screen egc-purchase'},head,controls,S.error?h('div',{class:'hub-notice error',role:'alert'},h('strong',{},'The purchase list is unavailable'),h('p',{},kit().errorText(S.error,ERRORS)),h('div',{class:'hub-actions'},kit().button('Retry',()=>load(),'primary'))):h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading the purchase list…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}))));
    return;
  }
  const stores=S.data.stores.map(store=>({...store,products:store.products.filter(product=>S.showDone||open(product))})).filter(store=>store.products.length);
  host.replaceChildren(h('div',{class:'hub-screen egc-purchase'},head,controls,
    h('p',{class:'pl-coverage'},`${S.data.lines} buy line${S.data.lines===1?'':'s'} on ${S.data.jobs} job${S.data.jobs===1?'':'s'}, ${dayLabel(S.data.start)} to ${dayLabel(S.data.end)}.`),
    S.feedback?h('p',{class:`hub-notice ${S.feedbackError?'error':'success'}`,role:S.feedbackError?'alert':'status'},S.feedback):null,
    S.error?h('p',{class:'hub-notice error',role:'alert'},kit().errorText(S.error,ERRORS)):null,
    stores.length?stores.map(store=>h('section',{class:'pl-store'},h('h3',{},store.store),h('ul',{class:'pl-products'},store.products.map(productRow))))
      :h('p',{class:'hub-notice'},S.data.lines?'Everything in this range is bought. Turn on Show bought items to review it.':'No job in this range has anything to buy.'),
    S.loading?h('p',{class:'pl-refresh',role:'status'},'Refreshing the purchase list…'):null));
}
function mount(host,ctx={}){S.host=host;S.ctx=ctx;if(!S.start)S.start=kit().today();render();return load();}
function unmount(){S.generation++;S.host?.replaceChildren();S.host=null;S.ctx=null;S.data=null;S.error=null;S.feedback='';S.busy=false;S.loading=false;S.open=new Set();}
window.addEventListener('egc:signout',()=>{unmount();S.start='';});
window.EGCPurchaseList=Object.freeze({mount,unmount,refresh:()=>S.host?load():Promise.resolve(),canLeave:()=>!S.busy});
})();
