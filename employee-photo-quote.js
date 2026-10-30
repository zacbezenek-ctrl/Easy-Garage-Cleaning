/* Photo quote (OFFICE, owner request 2026-10-30: "an office role to book photo-only removal"). The office user, a
   manager or the owner quotes junk removal from the photos a customer sent, with no walkthrough, in six steps:
   customer (HighLevel contact search or typed, POST /api/customer-resolve), photos (where they are: the customer's
   HighLevel contact, read only; plus what the photos show for the crew), removal items (the owner's pricing menu, GET
   /api/quote-draft?view=builder, truck loads, special-handling items and access charges only), review and save (POST
   /api/quote-draft composite_preview, then save: the server prices every line, the Labor line, the $250 Minimum pickup
   and the sent-quote terms, 25% when the customer approves and 75% on the job day), book (the Dispatch job dialog,
   EGCDispatch.openFor) and send (send_preview, then send). The quote is sent once its job day is booked, because the
   75% balance is due that day. Nothing here prices anything: every amount is the server's, in integer cents, and
   /api/quote-draft refuses anything but removal for the office role (functions/_lib/office-quotes.js).
   The flow is kept per viewer in sessionStorage (egc.hub.draft.v1.photo_quote.<viewer>, cleared at sign-out) with its
   request ids, so a reload or a lost answer retries the same request instead of creating a second customer or quote.
   Registered in employee-hub-screens.js (capability photo_quote); runs with the UI kit (window.EGCHubKit). */
(function(){
'use strict';
const PREFIX='photo_quote',DRAFT='egc.hub.draft.v1.photo_quote.',QUOTE='/api/quote-draft';
const STEPS=[['customer','Customer'],['photos','Photos'],['items','Removal items'],['review','Review & save'],['book','Book'],['send','Send']];
const HAULING=['junk','special','access'],MAX_FULL=20,MAX_SPECIAL=99;
const S={host:null,ctx:null,root:null,busy:'',error:null,notice:'',q:'',menu:null,menuError:null,menuLoading:false,contacts:null,lead:null,leadError:null,leadLoading:'',priced:null,preview:null,generation:0,d:null};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const int=value=>Number.isSafeInteger(value);
const money=value=>int(value)?kit().money(value):'—';
const viewer=()=>{try{return String(sessionStorage.getItem('egc_u')||'').trim().toLowerCase();}catch{return'';}};
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const request=(path,opts={})=>kit().requestJSON(path,{prefix:PREFIX,fetcher:fetcher(),...opts});
const post=(path,body,validate)=>request(path,{method:'POST',body,validate});
const fresh=()=>({customer:{name:'',phone:'',email:'',address:'',contactId:''},customerId:'',resolve:null,notes:{removeItems:'',accessNotes:''},
  picks:{full:0,partial:'',special:{},access:{}},validUntil:'',save:null,job:null,booked:null,send:null,sent:null,step:'customer'});
function load(){try{const saved=JSON.parse(sessionStorage.getItem(DRAFT+viewer())||'null');if(plain(saved)&&plain(saved.customer)&&plain(saved.picks)&&STEPS.some(([id])=>id===saved.step))return{...fresh(),...saved};}catch{}return fresh();}
function keep(){try{sessionStorage.setItem(DRAFT+viewer(),JSON.stringify(S.d));}catch{}}
const step=()=>S.d.step;
function go(id){S.d.step=id;S.error=null;S.notice='';keep();render();S.root?.querySelector('h2')?.focus?.({preventScroll:false});}
async function run(label,work){
  if(S.busy)return;
  S.busy=label;S.error=null;S.notice='';render();
  try{await work();}catch(error){S.error=error;}
  finally{S.busy='';keep();render();}
}
const errorText=error=>kit().errorText(error,{
  hub_pending_exists:'Finish or discard the earlier request first.',
});

// --- data the server owns -------------------------------------------------------------------------------------------
const validMenu=data=>Boolean(data&&typeof data.menuVersion==='string'&&typeof data.settingsVersion==='string'&&Array.isArray(data.services)&&plain(data.labor));
const hauling=menu=>(menu?.services||[]).filter(item=>plain(item)&&item.section==='removal'&&(Array.isArray(menu.labor?.haulingGroups)?menu.labor.haulingGroups:HAULING).includes(item.group)&&typeof item.id==='string');
const byGroup=(menu,group)=>hauling(menu).filter(item=>item.group===group);
async function loadMenu(){
  if(S.menu||S.menuLoading)return;
  const generation=S.generation;S.menuLoading=true;S.menuError=null;
  try{const menu=await request(QUOTE+'?view=builder',{validate:validMenu});if(generation===S.generation)S.menu=menu;}
  catch(error){if(generation===S.generation)S.menuError=error;}
  finally{S.menuLoading=false;}
  render();
}
// What the photos are: the customer's HighLevel contact (texted photos and the website request live there).
async function loadLead(){
  const contact=S.d.customer.contactId;
  if(!contact||S.lead?.contactId===contact||S.leadLoading===contact)return;
  const generation=S.generation;S.leadLoading=contact;
  try{const data=await request('/api/highlevel?view=lead&contactId='+encodeURIComponent(contact),{validate:data=>plain(data.lead)});if(generation===S.generation){S.lead={contactId:contact,locationId:typeof data.locationId==='string'?data.locationId:'',lead:data.lead};S.leadError=null;}}
  catch(error){if(generation===S.generation){S.lead={contactId:contact,locationId:'',lead:null};S.leadError=error;}}
  finally{if(S.leadLoading===contact)S.leadLoading='';}
  render();
}
// The builder selection: removal only, then the empty shelving and storage steps; labor asks for the server's estimate
// (a junk-only quote has none: the server drops it).
function selection(){
  const p=S.d.picks,removal=[];
  if(S.menu){
    const full=byGroup(S.menu,'junk').find(item=>item.junkFraction===1);
    if(full&&p.full>0)removal.push({id:full.id,quantity:p.full});
    if(p.partial&&byGroup(S.menu,'junk').some(item=>item.id===p.partial&&item.junkFraction<1))removal.push({id:p.partial,quantity:1});
    for(const item of byGroup(S.menu,'special')){const quantity=Number(p.special[item.id]||0);if(int(quantity)&&quantity>0)removal.push({id:item.id,quantity});}
    for(const item of byGroup(S.menu,'access'))if(p.access[item.id]===true)removal.push({id:item.id,quantity:1});
  }
  return{menuVersion:S.menu?.menuVersion,settingsVersion:S.menu?.settingsVersion,steps:['removal','shelving','storage'],removal,shelving:[],storage:[],labor:{manHours:null}};
}
const validPriced=data=>Boolean(data&&Array.isArray(data.lineItems)&&int(data.totalCents)&&plain(data.compositePricing)&&plain(data.approval));
// The customer-facing scope, as the estimator's builder writes it (crew/quote-draft.js builderScope): the priced lines'
// names, and a junk-only quote says it is junk removal only.
function scope(priced){
  const lines=(priced?.breakdown?.lines||[]).filter(plain),names=lines.map(line=>line.qty!==1?`${line.name} × ${line.qty}`:line.name);
  if(priced?.junkOnly===true)return`Junk removal only: ${names.join('; ')}. Loading, hauling and disposal; no sorting, organizing or reset.`.slice(0,1600);
  return`Removal: ${names.join('; ')}.${typeof priced?.labor?.manHours==='number'?' Labor.':''}`.slice(0,1600);
}
function draft(){
  const c=S.d.customer,n=S.d.notes,capture={};
  if(n.removeItems.trim())capture.removeItems=n.removeItems.trim();
  if(n.accessNotes.trim())capture.accessNotes=n.accessNotes.trim();
  return{client:{name:c.name.trim(),phone:c.phone.trim(),email:c.email.trim(),address:c.address.trim(),highlevel_contact_id:c.contactId},title:'Junk removal',scope:scope(S.priced),
    line_items:S.priced.lineItems.map(line=>({...line})),valid_until:S.d.validUntil,catalog_version:S.priced.menuVersion,composite_pricing:S.priced.compositePricing,...(Object.keys(capture).length?{walkthrough_capture:capture}:{})};
}
const validJob=data=>Boolean(data&&plain(data.job)&&typeof data.job.id==='string'&&typeof data.job.revision==='string'&&plain(data.job.estimate));
const jobState=job=>({id:job.id,revision:job.revision,number:job.estimate.number||'',amountCents:job.estimate.amountCents,depositCents:job.estimate.depositRequiredCents,status:job.estimate.status||'draft',sentAt:job.estimate.sentAt||null});

// --- actions ------------------------------------------------------------------------------------------------------------
async function searchContacts(q){
  if(String(q||'').trim().length<2){S.error=Object.assign(new Error('Type at least 2 letters or digits to search.'),{status:400});render();return;}
  await run('search',async()=>{const data=await request('/api/highlevel?view=contacts&q='+encodeURIComponent(q.trim()),{validate:data=>Array.isArray(data.contacts)});S.contacts=data.contacts.filter(plain).slice(0,20);});
}
function pickContact(contact){
  S.d.customer={name:String(contact.name||''),phone:String(contact.phone||''),email:String(contact.email||''),address:String(contact.address||''),contactId:String(contact.id||'')};
  S.d.customerId='';S.contacts=null;S.lead=null;keep();render();
}
const identity=()=>JSON.stringify([S.d.customer.name.trim(),S.d.customer.phone.trim(),S.d.customer.email.trim(),S.d.customer.address.trim(),S.d.customer.contactId]);
function customerProblem(){
  const c=S.d.customer;
  if(!c.name.trim())return'Enter the customer’s name.';
  if(!c.address.trim())return'Enter the service address.';
  if(!c.phone.trim()&&!c.email.trim()&&!c.contactId)return'Add a phone number or email so the customer can be matched safely.';
  return'';
}
async function resolveCustomer(){
  const problem=customerProblem();
  if(problem){S.error=Object.assign(new Error(problem),{status:400});render();return;}
  await run('customer',async()=>{
    // One request id per set of customer details: a retry of the same details replays; changed details are a new lookup.
    if(!S.d.resolve||S.d.resolve.identity!==identity()){S.d.resolve={identity:identity(),requestId:kit().requestId()};keep();}
    const c=S.d.customer,data=await post('/api/customer-resolve',{requestId:S.d.resolve.requestId,customer:{name:c.name.trim(),phone:c.phone.trim(),email:c.email.trim(),address:c.address.trim(),highlevelContactId:c.contactId}},data=>plain(data.customer)&&typeof data.customer.id==='string');
    if(S.d.customerId&&S.d.customerId!==data.customer.id&&S.d.job){S.d.job=null;S.d.booked=null;S.d.send=null;S.d.sent=null;S.d.save=null;}
    S.d.customerId=data.customer.id;S.d.step='photos';
  });
  if(!S.error)void loadLead();
}
async function price(){
  if(!S.menu)return;
  if(!selection().removal.length){S.error=Object.assign(new Error('Add at least one truck load, special-handling item or access charge.'),{status:400});render();return;}
  await run('price',async()=>{
    const data=await post(QUOTE,{action:'composite_preview',compositePricing:selection()},validPriced);
    S.priced=data;if(!S.d.validUntil)S.d.validUntil=kit().addDays(kit().today(),14);S.d.step='review';
  });
}
async function save(){
  if(!S.priced)return;
  await run('save',async()=>{
    // A save whose answer was lost is retried exactly as it was sent; anything else is a new save (a revision once saved).
    if(!S.d.save){
      const body={action:'save',actorId:viewer(),requestId:kit().requestId(),customerId:S.d.customerId,...(S.d.job?{jobId:S.d.job.id,expectedRevision:S.d.job.revision}:{}),draft:draft()};
      S.d.save={body};keep();
    }
    let data;
    try{data=await post(QUOTE,S.d.save.body,validJob);}
    catch(error){if(!kit().retryable(error)){S.d.save=null;keep();}throw error;}
    S.d.save=null;S.d.job=jobState(data.job);S.d.send=null;S.d.sent=null;S.preview=null;
    S.notice=(data.warnings||[]).filter(plain).map(row=>String(row.message||'')).filter(Boolean).join(' ');
    S.d.step='book';
  });
}
// The job's day and time as Dispatch shows it (a booker reads one job of the board).
async function dispatchJob(){
  const data=await request('/api/dispatch?view=job&jobId='+encodeURIComponent(S.d.job.id),{validate:data=>plain(data.job)&&data.job.id===S.d.job.id});
  return data.job;
}
async function refreshQuote(){
  const data=await request(QUOTE+'?jobId='+encodeURIComponent(S.d.job.id),{validate:validJob});
  S.d.job=jobState(data.job);
}
async function book(){
  if(!S.d.job)return;
  await run('book',async()=>{
    const job=await dispatchJob();
    const dispatch=window.EGCDispatch;
    if(!dispatch||typeof dispatch.openFor!=='function')throw Object.assign(new Error('Dispatch is not available on this page. Open Team schedule to book the job.'),{status:503});
    const opened=await dispatch.openFor(job,'edit',{onClose:()=>{void afterBooking();}});
    if(!opened?.opened)throw Object.assign(new Error(opened?.reason==='busy'?'Dispatch has another change open. Finish it in Team schedule, then try again.':'The Dispatch booking dialog could not open. Open Team schedule to book the job.'),{status:409});
  });
}
async function afterBooking(){
  await run('booked',async()=>{
    const job=await dispatchJob();
    S.d.booked=job.date?{date:job.date,time:job.time||'',endTime:job.endTime||'',crew:typeof job.crewName==='string'?job.crewName:''}:null;
    await refreshQuote();
    if(S.d.booked)S.d.step='send';
  });
}
async function preview(){
  if(!S.d.job)return;
  await run('preview',async()=>{
    S.preview=await post(QUOTE,{action:'send_preview',jobId:S.d.job.id,expectedRevision:S.d.job.revision},data=>typeof data.confirmToken==='string'&&typeof data.summary==='string');
  });
}
async function send(){
  if(!S.d.job||!S.preview&&!S.d.send)return;
  await run('send',async()=>{
    if(!S.d.send){S.d.send={action:'send',requestId:kit().requestId(),jobId:S.d.job.id,expectedRevision:S.d.job.revision,confirmToken:S.preview.confirmToken};keep();}
    let data;
    try{data=await post(QUOTE,S.d.send,validJob);}
    catch(error){if(!kit().retryable(error)){S.d.send=null;keep();}throw error;}
    S.d.job=jobState(data.job);S.d.sent={at:data.job.estimate.sentAt||'',delivery:plain(data.delivery)?String(data.delivery.status||''):''};S.d.send=null;S.preview=null;
    S.notice=(data.warnings||[]).filter(plain).map(row=>String(row.message||'')).filter(Boolean).join(' ');
  });
}
function restart(){S.d=fresh();S.priced=null;S.preview=null;S.contacts=null;S.lead=null;S.leadError=null;S.error=null;S.notice='';keep();render();}

// --- view ---------------------------------------------------------------------------------------------------------------
const busy=label=>S.busy===label;
const btn=(label,onClick,kind='',props={})=>kit().button(label,onClick,kind,{disabled:Boolean(S.busy),...props});
const select=(label,value,options,onChange)=>{const node=kit().field({label,type:'select',value,options});node.querySelector('select').addEventListener('change',event=>{onChange(event.target.value);keep();});return node;};
const input=(label,value,onInput,props={})=>{const node=kit().field({label,value,...props});node.querySelector('input,textarea,select')?.addEventListener('input',event=>{onInput(event.target.value);keep();});return node;};
function steps(){
  const at=STEPS.findIndex(([id])=>id===step());
  return h('ol',{class:'pq-steps','aria-label':'Photo quote steps'},STEPS.map(([id,label],index)=>h('li',{class:index<at?'done':index===at?'current':'', ...(index===at?{'aria-current':'step'}:{})},h('span',{},String(index+1)),label)));
}
function notices(){
  return[S.error?h('p',{class:'hub-notice error',role:'alert'},errorText(S.error)):null,S.notice?h('p',{class:'hub-notice warning',role:'status'},S.notice):null];
}
function customerStep(){
  const c=S.d.customer;
  const search=h('form',{class:'pq-search',onsubmit:event=>{event.preventDefault();void searchContacts(S.q);}},
    input('Find the customer in HighLevel',S.q,value=>{S.q=value;},{type:'search',placeholder:'Name, phone or email',autocomplete:'off'}),
    h('button',{type:'submit',class:'hub-btn',disabled:Boolean(S.busy)},busy('search')?'Searching…':'Search'));
  const results=Array.isArray(S.contacts)?S.contacts.length?h('ul',{class:'pq-results'},S.contacts.map(contact=>h('li',{},h('button',{type:'button',class:'hub-btn pq-contact',onclick:()=>pickContact(contact)},
    h('strong',{},String(contact.name||'Unnamed contact')),h('small',{},[contact.phone,contact.email,contact.address].filter(Boolean).join(' · ')||'No contact details'))))):h('p',{class:'pq-muted'},'No HighLevel contact matches. Type the customer below.'):null;
  return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Who is the customer?'),
    h('p',{class:'pq-muted'},'Pick the HighLevel contact who sent the photos, or type a new customer. The Hub finds the existing customer record by phone, email or contact, or adds one.'),
    search,results,
    c.contactId?h('p',{class:'hub-notice'},'Linked to HighLevel contact ',h('strong',{},c.name||c.contactId),'. ',h('button',{type:'button',class:'hub-btn quiet',onclick:()=>{S.d.customer.contactId='';S.d.customerId='';S.lead=null;keep();render();}},'Unlink')):null,
    h('div',{class:'hub-grid'},
      input('Customer name',c.name,value=>{S.d.customer.name=value;},{required:true,autocomplete:'off'}),
      input('Phone',c.phone,value=>{S.d.customer.phone=value;},{type:'tel',autocomplete:'off'}),
      input('Email',c.email,value=>{S.d.customer.email=value;},{type:'email',autocomplete:'off'}),
      input('Service address',c.address,value=>{S.d.customer.address=value;},{required:true,autocomplete:'off'})),
    h('div',{class:'hub-actions'},btn(busy('customer')?'Checking…':'Continue to photos',()=>void resolveCustomer(),'primary')));
}
function contactUrl(){
  const lead=S.lead;
  return lead?.locationId&&/^[A-Za-z0-9_-]{1,180}$/.test(lead.locationId)&&/^[A-Za-z0-9_-]{1,180}$/.test(S.d.customer.contactId)?`https://app.gohighlevel.com/v2/location/${encodeURIComponent(lead.locationId)}/contacts/detail/${encodeURIComponent(S.d.customer.contactId)}`:'';
}
function photosStep(){
  const n=S.d.notes,url=contactUrl(),lead=S.lead?.lead,asked=[lead?.service,lead?.requestedSlotText].filter(value=>typeof value==='string'&&value.trim());
  const where=S.d.customer.contactId?(url?h('div',{class:'hub-notice'},h('p',{},'Texted photos and the website request are on the customer’s HighLevel contact.'),h('div',{class:'hub-actions'},h('a',{class:'hub-btn dark',href:url,target:'_blank',rel:'noopener'},'Open their photos in HighLevel')),
      asked.length?h('p',{class:'pq-muted'},'Their request: '+asked.join(' · ')):null):S.leadError?h('p',{class:'hub-notice warning'},'The HighLevel contact could not be opened here: '+errorText(S.leadError)+' Look the customer up in HighLevel.'):h('p',{class:'pq-muted'},'Finding the HighLevel contact…'))
    :h('p',{class:'hub-notice warning'},'This customer is not linked to a HighLevel contact, so the Hub cannot point to their photos. Photos sent with the website form arrive in the office email; texted photos are in HighLevel conversations.');
  return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Look at the photos'),where,
    h('p',{class:'pq-muted'},'Write what the photos show for the crew. They see this on the job, never any price.'),
    input('What to remove (from the photos)',n.removeItems,value=>{S.d.notes.removeItems=value;},{type:'textarea',rows:4,maxlength:4000,placeholder:'Old couch, 2 mattresses, about half a truck of boxes by the side door'}),
    input('Access notes',n.accessNotes,value=>{S.d.notes.accessNotes=value;},{type:'textarea',rows:2,maxlength:4000,placeholder:'Stairs to the basement, long carry from the back yard, gate code'}),
    h('div',{class:'hub-actions'},btn('Back',()=>go('customer')),btn('Continue to removal items',()=>{go('items');void loadMenu();},'primary')));
}
const priceTag=item=>[money(item.unitCents),item.approved===false?' · draft price':''].join('');
function itemsStep(){
  if(!S.menu){
    if(!S.menuError&&!S.menuLoading)void loadMenu();
    return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'What are we hauling?'),S.menuError?h('div',{class:'hub-notice error',role:'alert'},errorText(S.menuError),h('div',{class:'hub-actions'},kit().button('Retry',()=>{S.menuError=null;void loadMenu();}))):h('div',{class:'hub-screen-loading'},h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'})));
  }
  const p=S.d.picks,junk=byGroup(S.menu,'junk'),full=junk.find(item=>item.junkFraction===1),partials=junk.filter(item=>item.junkFraction<1);
  const qty=(label,value,max,onInput,help)=>input(label,value,raw=>{const number=Math.max(0,Math.min(max,Math.trunc(Number(raw)||0)));onInput(number);},{type:'number',min:0,max,step:1,inputmode:'numeric',help});
  const changed=()=>{S.priced=null;};
  return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'What are we hauling?'),
    h('p',{class:'pq-muted'},'Removal only. Prices are the owner’s menu; the server adds Labor when the menu needs it and the Minimum pickup below $250.'),
    h('fieldset',{class:'pq-group'},h('legend',{},'Truck loads'),
      full?qty('Full truck loads ('+priceTag(full)+' each)',p.full||0,MAX_FULL,value=>{S.d.picks.full=value;changed();},''):null,
      partials.length?select('Partial load',p.partial,[{value:'',label:'None'},...partials.map(item=>({value:item.id,label:item.name+' · '+priceTag(item)}))],value=>{S.d.picks.partial=value;changed();}):null),
    byGroup(S.menu,'special').length?h('fieldset',{class:'pq-group'},h('legend',{},'Special-handling items'),h('div',{class:'pq-items'},byGroup(S.menu,'special').map(item=>qty(item.name+' ('+priceTag(item)+')',p.special[item.id]||0,MAX_SPECIAL,value=>{S.d.picks.special[item.id]=value;changed();},'')))):null,
    byGroup(S.menu,'access').length?h('fieldset',{class:'pq-group'},h('legend',{},'Access charges'),byGroup(S.menu,'access').map(item=>{const node=kit().field({label:item.name+' ('+priceTag(item)+')',type:'checkbox',value:p.access[item.id]===true});node.querySelector('input').addEventListener('change',event=>{S.d.picks.access[item.id]=event.target.checked;changed();keep();});return node;})):null,
    h('div',{class:'hub-actions'},btn('Back',()=>go('photos')),btn(busy('price')?'Pricing…':'Price the quote',()=>void price(),'primary')));
}
function linesTable(priced){
  return h('div',{class:'hub-table-scroll pq-lines'},h('table',{},h('caption',{class:'hub-sr-only'},'Quote lines'),h('thead',{},h('tr',{},h('th',{scope:'col'},'Line'),h('th',{scope:'col',class:'pq-amount'},'Amount'))),
    h('tbody',{},priced.lineItems.filter(plain).map(line=>h('tr',{},h('td',{},h('strong',{},String(line.name||'')),line.description?h('small',{},String(line.description)):null),h('td',{class:'pq-amount'},money(line.totalCents))))),
    h('tfoot',{},h('tr',{},h('th',{scope:'row'},'Total'),h('td',{class:'pq-amount'},h('strong',{},money(priced.totalCents)))))));
}
function reviewStep(){
  const priced=S.priced;
  if(!priced)return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Review the quote'),h('p',{},'Price the removal items first.'),h('div',{class:'hub-actions'},btn('Back to removal items',()=>go('items'),'primary')));
  const blocked=priced.approval?.ready===false,noLabor=plain(priced.labor)&&priced.labor.manHours==null,max=kit().addDays(kit().today(),90);
  const valid=input('Quote good until',S.d.validUntil,value=>{S.d.validUntil=value;},{type:'date',min:kit().today(),max});
  return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Review the quote'),linesTable(priced),
    h('p',{class:'pq-terms'},'Payment terms: the customer pays 25% when they approve the quote and the other 75% on the job day.'),
    blocked?h('p',{class:'hub-notice warning'},'Some prices are drafts the owner has not approved. You can save this quote, but it cannot be sent until the owner approves them on Menu prices.'):null,
    noLabor?h('p',{class:'hub-notice error'},'This quote needs a Labor line and the menu has no time estimate for it. Ask a manager to quote it.'):null,
    S.d.job?h('p',{class:'hub-notice'},'Saving again revises estimate '+(S.d.job.number||'')+'.'):null,
    valid,
    h('div',{class:'hub-actions'},btn('Back',()=>go('items')),btn(busy('save')?'Saving…':S.d.save?'Retry the save':'Save quote',()=>void save(),'primary',{disabled:Boolean(S.busy)||noLabor})));
}
function bookStep(){
  const job=S.d.job;
  if(!job)return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Book the job'),h('p',{},'Save the quote first.'),h('div',{class:'hub-actions'},btn('Back to review',()=>go('review'),'primary')));
  return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Book the job day'),
    h('p',{},'Estimate ',h('strong',{},job.number||'saved'),' · ',money(job.amountCents),int(job.depositCents)?' · 25% on approval '+money(job.depositCents):''),
    h('p',{class:'pq-muted'},'Agree the day with the customer and book it in Dispatch. The quote is sent once the job has a day, because the 75% is due on the job day. Dispatch picks the crew.'),
    S.d.booked?h('p',{class:'hub-notice success'},'Booked for '+S.d.booked.date+(S.d.booked.time?' at '+S.d.booked.time:'')+'.'):null,
    h('div',{class:'hub-actions'},btn('Back',()=>go('review')),btn(busy('book')||busy('booked')?'Opening Dispatch…':S.d.booked?'Change the booking':'Book in Dispatch',()=>void book(),S.d.booked?'':'primary'),
      S.d.booked?btn('Continue to send',()=>go('send'),'primary'):btn('I booked it in Team schedule',()=>void afterBooking())));
}
function sendStep(){
  const job=S.d.job;
  if(!job)return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Send the quote'),h('p',{},'Save the quote first.'));
  if(S.d.sent)return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Quote sent'),
    h('p',{class:'hub-notice success',role:'status'},'Estimate '+(job.number||'')+' was sent'+(S.d.booked?' for the job on '+S.d.booked.date:'')+'. HighLevel tells the customer; they approve it and pay 25% in their portal.'),
    S.d.sent.delivery?h('p',{class:'pq-muted'},'Delivery: '+S.d.sent.delivery.replace(/_/g,' ')+'.'):null,
    h('div',{class:'hub-actions'},btn('Start another photo quote',restart,'primary')));
  return h('section',{class:'hub-card pq-card'},h('h2',{tabindex:'-1'},'Send the quote'),
    S.d.booked?h('p',{},'Job day: '+S.d.booked.date+(S.d.booked.time?' at '+S.d.booked.time:'')):h('p',{class:'hub-notice warning'},'Book the job day first: the 75% balance is due on the job day.'),
    S.preview?h('div',{class:'hub-notice'},h('p',{},String(S.preview.summary)),plain(S.preview.delivery)&&S.preview.delivery.recipient?.masked?h('p',{class:'pq-muted'},'To '+String(S.preview.delivery.recipient.masked)):null):null,
    h('div',{class:'hub-actions'},btn('Back',()=>go('book')),
      S.preview||S.d.send?btn(busy('send')?'Sending…':S.d.send?'Retry the send':'Send to the customer',()=>void send(),'primary'):btn(busy('preview')?'Checking…':'Preview the send',()=>void preview(),'primary',{disabled:Boolean(S.busy)||!S.d.booked})));
}
const VIEWS={customer:customerStep,photos:photosStep,items:itemsStep,review:reviewStep,book:bookStep,send:sendStep};
function render(){
  if(!S.host||!S.d)return;
  const focus=document.activeElement,keepFocus=focus&&S.root?.contains(focus)&&focus.matches?.('input,textarea,select')?{label:focus.closest('label')?.textContent||'',start:focus.selectionStart,end:focus.selectionEnd}:null;
  const root=h('section',{class:'hub-screen pq'},
    h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'Client work'),h('h1',{},'Photo quote'),h('p',{},'Quote junk removal from the customer’s photos, book the day and send it. Removal only: truck loads, special-handling items and access charges.')),
      h('div',{class:'hub-actions'},S.d.customerId||S.d.job?btn('Start over',restart,'quiet'):null)),
    steps(),...notices(),(VIEWS[step()]||customerStep)());
  if(S.root)S.root.replaceWith(root);else S.host.replaceChildren(root);
  S.root=root;
  if(keepFocus){const field=[...root.querySelectorAll('label')].find(label=>label.textContent===keepFocus.label)?.querySelector('input,textarea,select');field?.focus?.();try{field?.setSelectionRange?.(keepFocus.start,keepFocus.end);}catch{}}
}
function mount(host,ctx){
  S.host=host;S.ctx=ctx||null;S.generation++;S.d=load();S.error=null;S.notice='';S.root=null;S.busy='';
  render();
  if(step()==='photos')void loadLead();
}
function unmount(){S.generation++;S.root?.remove();S.root=null;S.host=null;S.ctx=null;S.busy='';}
window.EGCPhotoQuote={mount,unmount,refresh:()=>render(),canLeave:()=>!S.busy};
})();
