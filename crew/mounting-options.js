/* Walkthrough comparison uses the catalog API's existing server-priced lines.
   Comparisons are alternatives, never additions to the signed cleanout price. */
(function(root){
'use strict';
const GROUPS=[['wall-studs','Wall-mounted'],['ceiling-joists','Ceiling-mounted'],['none-freestanding','Freestanding'],['assembly-only','Assembly'],['concrete-anchors','Concrete anchors'],['masonry','Masonry'],['drywall-only-light-duty','Light-duty wall']];
const money=n=>Number.isSafeInteger(n)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100):'Needs pricing';
const h=(tag,attrs,...children)=>{const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(key in node&&!key.startsWith('aria-'))node[key]=value;else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;};
function groupIds(item){return GROUPS.filter(([id])=>item?.installRequirements?.includes(id)).map(([id])=>id);}
function comparePrice(overview,item,quantity){
 const p=overview?.prices?.[item?.id],split=p?.split,min=overview?.settings?.values?.minimumJobCents;
 if(overview?.enabled!==true||overview.settings?.readyForCustomers!==true||item?.availability!=='active'||item?.priceVerified!==true||p?.quotable!==true||p.stale!==false||p.quantity!==1||p.customerSupplied!==false||!Number.isSafeInteger(quantity)||quantity<1||quantity>10000||!Number.isSafeInteger(min)||min<0)return null;
 if(!split||['productCents','markupCents','laborCents','disposalCents'].some(k=>!Number.isSafeInteger(split[k])||split[k]<0))return null;
 const materials=(split.productCents+split.markupCents)*quantity,installation=split.laborCents*quantity,other=split.disposalCents*quantity,subtotal=materials+installation+other;
 if(!Number.isSafeInteger(subtotal)||subtotal>100000000||subtotal!==p.unitCents*quantity)return null;
 const minimum=Math.max(0,min-subtotal),total=subtotal+minimum;
 return Number.isSafeInteger(total)&&total<=100000000?{materials,installation,other,minimum,total}:null;
}
function mount(host,options){
 let overview=null,error='',loading=true,disposed=false,search='',group='',limit=12,busy=false,requestPending=false;
 // Site-fit is a new field check each time the screen opens, never a carried approval.
 let selected=(Array.isArray(options.selections)?options.selections:[]).filter((x,i,a)=>x&&typeof x.itemId==='string'&&a.findIndex(y=>y?.itemId===x.itemId)===i).slice(0,4).map(x=>({itemId:x.itemId,quantity:Number.isSafeInteger(x.quantity)&&x.quantity>0&&x.quantity<=10000?x.quantity:1,fit:false}));
 let controller=new AbortController();
 const persist=()=>options.onChange?.(selected.map(({itemId,quantity})=>({itemId,quantity})));
 const button=(label,fn,disabled=false)=>h('button',{type:'button',disabled,onclick:fn},label);
 const all=()=>overview?.catalog?.items?.filter(x=>x?.kind==='product'&&x.availability==='active'&&groupIds(x).length)||[];
 const byId=id=>all().find(x=>x.id===id);
 const focusSelection=(id,selector)=>host.querySelectorAll('article').forEach(node=>{if(node.dataset.item===id)node.querySelector(selector)?.focus();});
 async function load(){
  if(requestPending||disposed)return;requestPending=true;
  controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);loading=true;error='';render();
  try{const response=await options.fetch('/api/catalog',{cache:'no-store',signal:controller.signal});const data=await response.json();if(disposed)return;if(!response.ok||data?.ok!==true)throw new Error(response.status===403?'Mounting prices are available to an owner or manager. Ask them to review these options.':'Mounting options could not load. Retry when connected.');if(data.enabled!==true)throw new Error('Catalog mounting options are not enabled. An owner must release the catalog and pricing before these can be quoted.');if(!Array.isArray(data.catalog?.items))throw new Error('The mounting catalog response was incomplete. Retry.');overview=data;}
  catch(e){if(disposed)return;overview=null;error=controller.signal.aborted?'Mounting options timed out. Your comparisons are kept; retry when connected.':e.message||'Mounting options could not load. Retry.';}
  finally{clearTimeout(timer);requestPending=false;if(!disposed){loading=false;render();}}
 }
 function rows(price){return h('dl',{class:'mount-prices'},[['Materials',price?.materials],['Installation',price?.installation],['Packaging / disposal',price?.other],['Minimum charge adjustment',price?.minimum],['Option total',price?.total]].flatMap(([label,value])=>[h('dt',{},label),h('dd',{},money(value))]));}
 async function quote(selection,item){
  if(busy||!selection.fit||!comparePrice(overview,item,selection.quantity))return;
  busy=true;error='';render();
  try{const context=options.quoteContext();if(!root.EGCCatalogQuote?.open)throw new Error('The quote builder has not loaded. Reload this page and retry.');const initialItems=[{id:'catalog-1',itemId:item.id,quantity:selection.quantity,customerSupplied:false}],digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({client:context.client,items:initialItems}))),fingerprint=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');if(disposed)return;await root.EGCCatalogQuote.open({overview,identity:options.identity,hubFetch:options.fetch,draftScope:context.draftScope+'-'+fingerprint,initialClient:context.client,initialItems,fixedSelection:true,restoreFocus:()=>focusSelection(item.id,'.mount-actions button'),reloadOverview:async()=>{const response=await options.fetch('/api/catalog',{cache:'no-store'}),data=await response.json();if(!response.ok||!data?.ok)throw new Error('Current catalog prices could not be loaded. Retry.');return data;}});}
  catch(e){if(!disposed)error=e.message||'The quote could not open.';}
  finally{if(!disposed){busy=false;render();}}
 }
 function card(selection){const item=byId(selection.itemId),price=comparePrice(overview,item,selection.quantity);
  return h('article',{class:'mount-option','data-item':selection.itemId},h('h3',{},item?.name||'Product no longer available'),item?h('p',{class:'mount-meta'},groupIds(item).map(id=>GROUPS.find(x=>x[0]===id)[1]).join(' · ')+' · '+item.priceUnit):null,
   h('label',{},'Quantity',h('input',{type:'number',min:1,max:10000,step:1,value:selection.quantity,'aria-label':'Quantity for '+(item?.name||'unavailable product'),onchange:e=>{const n=Number(e.target.value);if(!Number.isSafeInteger(n)||n<1||n>10000){e.target.value=selection.quantity;return;}selection.quantity=n;selection.fit=false;persist();render();focusSelection(selection.itemId,'input[type="number"]');}})),rows(price),!price?h('p',{class:'mount-warning'},'Needs pricing — an owner must release current verified product and installation rates.'):null,
   item?h('details',{open:selection.detailsOpen,ontoggle:e=>{selection.detailsOpen=e.target.open;}},h('summary',{},'Site fit and installation requirements'),h('p',{},item.requires||'Check the manufacturer’s installation requirements.'),h('p',{},item.safetyNotes||'Confirm mounting surfaces, clearances and load limits.'),item.installNotes?h('p',{},item.installNotes):null):null,
   h('label',{class:'mount-fit'},h('input',{type:'checkbox',checked:selection.fit,disabled:!item,onchange:e=>{selection.fit=e.target.checked;render();focusSelection(selection.itemId,'input[type="checkbox"]');}}),'I reviewed this product’s mounting surface, load limits, clearances and installation requirements on site'),
   h('div',{class:'mount-actions'},button('Review installation quote',()=>quote(selection,item),busy||!price||!selection.fit),button('Remove option',()=>{selected=selected.filter(x=>x!==selection);persist();render();host.querySelector('input[type="search"]')?.focus();},busy)));
 }
 function renderResults(container){
  const words=search.trim().toLowerCase().split(/\s+/).filter(Boolean),matches=all().filter(item=>(!group||groupIds(item).includes(group))&&words.every(word=>[item.name,item.brand,item.model,item.category].join(' ').toLowerCase().includes(word)));
  container.replaceChildren(...[h('p',{class:'mount-meta',role:'status'},`${matches.length} catalog options · compare up to 4 alternatives`),h('ul',{class:'mount-results'},matches.slice(0,limit).map(item=>h('li',{},h('div',{},h('strong',{},item.name),h('span',{},groupIds(item).map(id=>GROUPS.find(x=>x[0]===id)[1]).join(' · '))),button(selected.some(x=>x.itemId===item.id)?'Added':'Compare',()=>{if(busy||selected.length>=4||selected.some(x=>x.itemId===item.id))return;selected.push({itemId:item.id,quantity:1,fit:false});persist();render();focusSelection(item.id,'input[type="number"]');},busy||selected.length>=4||selected.some(x=>x.itemId===item.id))))),!matches.length?h('p',{},'No matching mounting products. Try another search or mounting method.'):null,matches.length>limit?button('Show more options',()=>{const previous=limit;limit+=12;renderResults(container);container.querySelectorAll('.mount-results button')[previous]?.focus();}):null].filter(Boolean));
 }
 function render(){if(disposed)return;const children=[h('h2',{},'Mounting & storage options'),h('p',{},'Compare materials and installation for catalog products. Each option is a separate alternative; it is not included in the cleanout price. Site suitability must be checked before quoting.')];
  if(loading)children.push(h('p',{role:'status'},'Loading mounting options…'));
  if(error)children.push(h('p',{role:'alert',class:'mount-warning'},error),button('Retry catalog',load,busy||loading));
  if(overview&&!loading){
   if(overview.settings?.readyForCustomers!==true)children.push(h('p',{class:'mount-warning',role:'status'},'Needs pricing: catalog rates have not been approved for customer use. No placeholder amounts are shown.'));
   const results=h('div',{}),input=h('input',{type:'search',value:search,placeholder:'Search racks, hooks, shelves or bikes','aria-label':'Search mounting products',oninput:e=>{search=e.target.value;limit=12;renderResults(results);}}),select=h('select',{'aria-label':'Mounting method',onchange:e=>{group=e.target.value;limit=12;renderResults(results);}},h('option',{value:''},'All mounting methods'),GROUPS.filter(([id])=>all().some(item=>groupIds(item).includes(id))).map(([id,label])=>h('option',{value:id,selected:group===id},label)));
   renderResults(results);children.push(h('div',{class:'mount-search'},input,select),results,h('div',{class:'mount-comparison'},selected.map(card)));
  }
  host.replaceChildren(...children);
 }
 const signout=()=>{disposed=true;controller.abort();host.replaceChildren();};root.addEventListener('egc:signout',signout);void load();
 return{dispose(){disposed=true;controller.abort();root.removeEventListener('egc:signout',signout);}};
}
root.EGCMountingOptions=Object.freeze({mount,comparePrice,groupIds});
})(window);
