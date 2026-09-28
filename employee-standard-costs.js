/* Stocked item costs (FUN-19): the owner's standard cost per unit for catalog items EGC keeps in stock
   (shelving, totes, racks). Job costing uses these only as provisional costs until a real expense replaces
   them; retail prices are never shown or used as a cost. Registered in employee-hub-screens.js and runs
   standalone with the UI kit (window.EGCHubKit). Managers see the costs read-only; the owner edits them. */
(function(){
'use strict';
const SCREEN='stocked_costs',PATH='/api/standard-costs',PAGE=40;
const S={host:null,ctx:null,data:null,error:null,loading:false,busy:false,drafts:{},query:'',category:'',onlySet:false,shown:PAGE,note:'',feedback:'',feedbackError:false,conflict:false,pending:null,generation:0};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const ERRORS={standard_cost_owner_required:'Only the owner can change stocked item costs.',standard_cost_revision_conflict:'Stocked item costs changed while you were editing. Your edits are kept; load the latest costs, check them, and save again.',standard_cost_no_change:'These costs are already saved.'};
function valid(data){
  return Boolean(data&&data.ok===true&&Array.isArray(data.items)&&Array.isArray(data.categories)&&Array.isArray(data.retired)&&data.coverage&&Number.isSafeInteger(data.coverage.set)&&Number.isSafeInteger(data.coverage.total)&&(data.revision===null||typeof data.revision==='string')&&typeof data.canEdit==='boolean'
    &&data.items.every(item=>item&&typeof item.id==='string'&&typeof item.name==='string'&&(item.standardUnitCostCents===null||Number.isSafeInteger(item.standardUnitCostCents))));
}
const queue=()=>kit().pending(SCREEN);
const categoryLabel=id=>(S.data?.categories||[]).find(category=>category.id===id)?.label||id;
const stamp=value=>{try{return value?new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',month:'short',day:'numeric',year:'numeric'}).format(new Date(value)):'';}catch{return'';}};
const find=id=>(S.data?.items||[]).find(item=>item.id===id)||(S.data?.retired||[]).find(item=>item.id===id)||null;
// Edited rows as {itemId, standardUnitCostCents} (null clears a saved cost), plus rows whose text is not a cost.
function changes(){
  const out=[],invalid=[];
  for(const [id,text] of Object.entries(S.drafts)){
    const item=find(id);if(!item)continue;
    const trimmed=String(text).trim(),cents=trimmed?kit().cents(trimmed):null;
    if(trimmed&&(cents===null||cents<1||cents>10000000)){invalid.push(id);continue;}
    const value=trimmed?cents:null;
    if(value!==item.standardUnitCostCents)out.push({itemId:id,standardUnitCostCents:value});
  }
  return{changes:out,invalid};
}
const dirty=()=>changes().changes.length>0||changes().invalid.length>0;
async function load({keepDrafts=true}={}){
  const generation=++S.generation;
  S.loading=true;S.error=null;render();
  try{
    const data=await kit().requestJSON(PATH,{prefix:'standard_cost',validate:valid,fetcher:fetcher()});
    if(generation!==S.generation)return;
    S.data=data;S.conflict=false;if(!keepDrafts)S.drafts={};
  }catch(error){if(generation===S.generation)S.error=error;}
  finally{if(generation===S.generation){S.loading=false;S.pending=queue().get();render();}}
}
async function save(replay=false){
  if(S.busy||!S.data?.canEdit)return;
  const {changes:list,invalid}=changes();
  if(!replay&&invalid.length){S.feedback='Fix the highlighted costs: use dollars and cents, for example 42.50.';S.feedbackError=true;render();S.host?.querySelector('[aria-invalid="true"]')?.focus();return;}
  if(!replay&&!list.length)return;
  const generation=S.generation;S.busy=true;S.feedback='';render();
  try{
    const body={action:'standard_costs.set',expectedRevision:S.data.revision,changes:list,...(S.note.trim()?{reason:S.note.trim()}:{})};
    const data=replay?await queue().replay({prefix:'standard_cost',validate:valid,fetcher:fetcher()}):await queue().submit(PATH,body,{prefix:'standard_cost',validate:valid,fetcher:fetcher()});
    if(generation!==S.generation)return;
    const count=replay?'':` ${list.length} cost${list.length===1?'':'s'}`;
    S.data=data;S.drafts={};S.note='';S.conflict=false;S.feedback=data.replayed?'This save was already applied. The saved costs are shown.':`Saved${count}.`;S.feedbackError=false;
  }catch(error){
    if(generation!==S.generation)return;
    S.conflict=error.code==='standard_cost_revision_conflict';
    S.feedback=kit().errorText(error,ERRORS);S.feedbackError=true;
  }finally{if(generation===S.generation){S.busy=false;S.pending=queue().get();render();}}
}
function discardPending(){queue().discard();S.pending=null;S.feedback='The unconfirmed save was discarded. Check the costs below before saving again.';S.feedbackError=false;load();}
function costState(item,text){
  const trimmed=String(text).trim(),cents=trimmed?kit().cents(trimmed):null;
  return{bad:Boolean(trimmed)&&(cents===null||cents<1||cents>10000000),changed:Object.hasOwn(S.drafts,item.id)&&(trimmed?cents:null)!==item.standardUnitCostCents};
}
// Typing updates only this row and the save bar, so a tap on Save is never lost to a re-render.
function costInput(item){
  const text=Object.hasOwn(S.drafts,item.id)?S.drafts[item.id]:item.standardUnitCostCents===null?'':(item.standardUnitCostCents/100).toFixed(2),state=costState(item,text);
  return h('div',{class:`sc-cost${state.changed?' changed':''}`},h('span',{'aria-hidden':'true'},'$'),h('input',{type:'text',inputmode:'decimal',autocomplete:'off',enterkeyhint:'done',placeholder:'Not set',maxlength:12,value:text,disabled:S.busy||Boolean(S.pending),'aria-label':`Cost per ${item.priceUnit||'unit'} for ${item.name||item.id}`,'aria-invalid':state.bad?'true':null,
    oninput:event=>{S.drafts[item.id]=event.target.value;const next=costState(item,event.target.value);event.target.closest('.sc-cost')?.classList.toggle('changed',next.changed);if(next.bad)event.target.setAttribute('aria-invalid','true');else event.target.removeAttribute('aria-invalid');updateBar();}}));
}
function itemRow(item,retired=false){
  const canEdit=S.data.canEdit,meta=retired?'No longer an active catalog item':[categoryLabel(item.category),item.priceUnit?`per ${item.priceUnit}`:''].filter(Boolean).join(' · ');
  return h('li',{class:'sc-item','data-item':item.id},
    h('div',{class:'sc-item-text'},h('strong',{},item.name||item.id),h('small',{},meta),item.updatedAt?h('small',{},`Set ${stamp(item.updatedAt)}${item.updatedBy?` by ${item.updatedBy}`:''}`):null),
    canEdit?(retired?h('div',{class:'sc-retired'},h('span',{},kit().money(item.standardUnitCostCents)),kit().button(S.drafts[item.id]===''?'Will clear':'Clear',()=>{S.drafts[item.id]='';render();},'',{disabled:S.busy||Boolean(S.pending)||S.drafts[item.id]===''})):costInput(item))
      :h('span',{class:`sc-value${item.standardUnitCostCents===null?' unset':''}`},item.standardUnitCostCents===null?'Not set':kit().money(item.standardUnitCostCents)));
}
function filtered(){
  const words=S.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return S.data.items.filter(item=>(!S.category||item.category===S.category)&&(!S.onlySet||item.standardUnitCostCents!==null||Object.hasOwn(S.drafts,item.id))&&words.every(word=>`${item.name} ${item.id}`.toLowerCase().includes(word)));
}
function saveBar(){
  if(!S.data?.canEdit)return null;
  const {changes:list,invalid}=changes();
  if(!list.length&&!invalid.length)return h('div',{class:'sc-bar',hidden:true});
  return h('div',{class:'sc-bar',role:'region','aria-label':'Unsaved stocked item costs'},
    h('p',{class:'sc-bar-count','aria-live':'polite'},`${list.length} unsaved change${list.length===1?'':'s'}${invalid.length?` · ${invalid.length} to fix`:''}`),
    h('label',{class:'sc-note'},h('span',{},'Note for the audit log (optional)'),h('input',{type:'text',maxlength:500,autocomplete:'off',value:S.note,disabled:S.busy,placeholder:'For example: supplier invoice, September',oninput:event=>{S.note=event.target.value;}})),
    h('div',{class:'hub-actions'},kit().button(S.busy?'Saving…':'Save costs',()=>save(),'primary',{disabled:S.busy||Boolean(S.pending)||Boolean(invalid.length),'aria-busy':S.busy?'true':null}),kit().button('Discard changes',()=>{S.drafts={};S.note='';S.feedback='';render();},'',{disabled:S.busy})));
}
function updateBar(){const bar=S.host?.querySelector('.sc-bar');const next=saveBar();if(bar&&next)bar.replaceWith(next);}
function render(){
  const host=S.host;if(!host)return;
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'Catalog settings'),h('h2',{},'Stocked item costs'),h('p',{},'What EGC pays per unit for items it keeps in stock, such as shelving, totes and racks. Job costing counts these only as provisional costs until a real expense is recorded. Retail prices are never used as a cost.')));
  if(!S.data){
    host.replaceChildren(h('div',{class:'hub-screen egc-stdcost'},head,S.error?h('div',{class:'hub-notice error',role:'alert'},h('strong',{},'Stocked item costs are unavailable'),h('p',{},kit().errorText(S.error,ERRORS)),h('div',{class:'hub-actions'},kit().button('Retry',()=>load(),'primary'))):h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading stocked item costs…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}))));
    return;
  }
  const items=filtered(),visible=items.slice(0,S.shown),focus=document.activeElement&&host.contains(document.activeElement)?document.activeElement.getAttribute('aria-label')||document.activeElement.id:'';
  host.replaceChildren(h('div',{class:'hub-screen egc-stdcost'},head,
    h('p',{class:'sc-coverage'},`${S.data.coverage.set} of ${S.data.coverage.total} catalog items have a standard cost.`,S.data.canEdit?'':' Only the owner can change them.'),
    S.feedback?h('p',{class:`hub-notice ${S.feedbackError?'error':'success'}`,role:S.feedbackError?'alert':'status'},S.feedback,S.conflict?h('span',{class:'hub-actions'},kit().button('Load latest costs (keeps your edits)',()=>{S.feedback='';load();},'primary')):null):null,
    S.pending?h('div',{class:'hub-notice warning',role:'alert'},h('strong',{},'A save was not confirmed'),h('p',{},'Retry sends the same save, so it cannot be applied twice.'),h('div',{class:'hub-actions'},kit().button(S.busy?'Checking…':'Retry original save',()=>save(true),'primary',{disabled:S.busy}),kit().button('Discard saved request',discardPending,'',{disabled:S.busy}))):null,
    S.error?h('p',{class:'hub-notice error',role:'alert'},kit().errorText(S.error,ERRORS)):null,
    h('div',{class:'sc-filters'},
      h('label',{class:'hub-field'},h('span',{},'Search items'),h('input',{id:'sc-search',type:'search',inputmode:'search',autocomplete:'off',value:S.query,placeholder:'Shelving, tote, rack…',oninput:event=>{S.query=event.target.value;S.shown=PAGE;render();}})),
      h('label',{class:'hub-field'},h('span',{},'Category'),h('select',{id:'sc-category',onchange:event=>{S.category=event.target.value;S.shown=PAGE;render();}},h('option',{value:'',selected:!S.category},'All categories'),S.data.categories.map(category=>h('option',{value:category.id,selected:category.id===S.category},category.label)))),
      kit().button(S.onlySet?'✓ Only items with a cost':'Only items with a cost',()=>{S.onlySet=!S.onlySet;S.shown=PAGE;render();},'sc-only',{'aria-pressed':S.onlySet?'true':'false'})),
    items.length?h('ul',{class:'sc-list'},visible.map(item=>itemRow(item))):h('p',{class:'hub-notice'},'No catalog items match. Clear the search or choose another category.'),
    items.length>visible.length?kit().button(`Show ${Math.min(PAGE,items.length-visible.length)} more of ${items.length-visible.length}`,()=>{S.shown+=PAGE;render();},'sc-more'):null,
    S.data.retired.length?h('section',{class:'sc-retired-list'},h('h3',{},'Costs for retired items'),h('ul',{class:'sc-list'},S.data.retired.map(item=>itemRow(item,true)))):null,
    S.loading?h('p',{class:'sc-refresh',role:'status'},'Refreshing costs…'):null,
    saveBar()));
  if(focus){const again=[...host.querySelectorAll('input,select,button')].find(node=>(node.getAttribute('aria-label')||node.id)===focus);again?.focus();}
}
function mount(host,ctx={}){S.host=host;S.ctx=ctx;S.pending=queue().get();render();return load();}
function unmount(){S.generation++;S.host?.replaceChildren();S.host=null;S.ctx=null;S.data=null;S.error=null;S.drafts={};S.note='';S.feedback='';S.busy=false;S.loading=false;S.conflict=false;}
window.addEventListener('egc:signout',unmount);
window.EGCStandardCosts=Object.freeze({mount,unmount,refresh:()=>S.host?load():Promise.resolve(),canLeave:()=>!S.busy&&!dirty()});
})();
