/* A catalog quote uses the published product catalog and owner-approved settings.
   The server prices every selection before the existing reviewed quote flow saves it.
   Unsent drafts and frozen requests share the Hub's sign-out-cleared draft prefix. */
(function (root) {
  'use strict';
  const PREFIX='egc.hub.draft.v1.catalogquote.', MAX=11;
  const money=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100):'Unavailable';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const h=(tag,attrs,...children)=>{const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(key in node&&!key.startsWith('aria-'))node[key]=value;else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;};
  function eligible(item,overview){return item?.kind==='product'&&item.availability==='active'&&item.priceVerified===true&&overview.prices?.[item.id]?.quotable===true&&overview.prices[item.id].stale===false;}
  function descriptor(overview,items){return{catalogVersion:overview.publication.version,settingsVersion:overview.settings.settingsVersion,items:items.map(({id,itemId,quantity,customerSupplied})=>({id,itemId,quantity,customerSupplied}))};}
  function validPreview(data,input){return data?.ok===true&&Array.isArray(data.lineItems)&&data.lineItems.length>0&&data.lineItems.length<=MAX+1&&Number.isSafeInteger(data.totalCents)&&data.totalCents>0&&Number.isSafeInteger(data.depositCents)&&data.depositCents>=0&&data.depositCents<=data.totalCents&&data.catalogVersion===input.catalogVersion&&data.settingsVersion===input.settingsVersion&&canonical(data.catalogPricing)===canonical(input)&&data.lineItems.every(line=>Number.isSafeInteger(line.totalCents)&&line.totalCents>=0)&&data.lineItems.reduce((sum,line)=>sum+line.totalCents,0)===data.totalCents;}
  const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
  let active=null,sessionGeneration=0;
  root.addEventListener('egc:signout',()=>{sessionGeneration++;try{for(let index=sessionStorage.length-1;index>=0;index--){const key=sessionStorage.key(index);if(key?.startsWith(PREFIX))sessionStorage.removeItem(key);}}catch{}});
  async function open(options){
    if(active)return active.dialog;
    const overview=options.overview,identity=String(options.identity||'').trim().toLowerCase();
    if(!identity||!overview?.enabled||overview.settings?.readyForCustomers!==true||!root.EGCQuoteDraft)throw new Error('Review and approve catalog pricing before building a customer quote.');
    const authGeneration=sessionGeneration,prefix=PREFIX+encodeURIComponent(identity)+'.',key=prefix+'composer';
    let saved=null;try{saved=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
    const S={id:saved?.id||crypto.randomUUID(),client:{name:'',phone:'',email:'',address:'',highlevel_contact_id:'',...(saved?.client||{})},items:Array.isArray(saved?.items)?saved.items:[],next:saved?.next||1,savedJobId:saved?.savedJobId||'',search:'',category:'',preview:null,busy:false,error:'',closed:false,generation:0,frozen:null};
    S.items=S.items.filter(item=>item&&typeof item.id==='string'&&typeof item.itemId==='string'&&Number.isSafeInteger(item.quantity)&&item.quantity>0&&typeof item.customerSupplied==='boolean').slice(0,MAX);
    S.next=Math.max(1,...S.items.map(item=>/^catalog-[1-9][0-9]{0,5}$/.test(item.id)?Number(item.id.slice(8))+1:1));
    let signedOut=false;
    const persist=()=>{if(authGeneration!==sessionGeneration)throw new Error('Sign in again to recover this quote.');sessionStorage.setItem(key,JSON.stringify({id:S.id,client:S.client,items:S.items,next:S.next,savedJobId:S.savedJobId}));};
    const remember=()=>{try{persist();}catch{S.error='This browser could not keep the quote draft. Allow session storage before saving.';}};
    const fetcher=options.hubFetch||root.hubFetch||((url,init)=>fetch(url,{...init,credentials:'same-origin'}));
    const storage={getItem:name=>sessionStorage.getItem(prefix+name),setItem:(name,value)=>{if(authGeneration!==sessionGeneration)throw new Error('Sign in again to recover this quote.');sessionStorage.setItem(prefix+name,value);},removeItem:name=>sessionStorage.removeItem(prefix+name)};
    const client=root.EGCQuoteDraft.createClient({fetch:fetcher,storage,actor:()=>signedOut||authGeneration!==sessionGeneration?'':identity,source:()=>'',draftId:()=>S.id,savedJobId:()=>S.savedJobId,uuid:()=>crypto.randomUUID(),accept:result=>{S.savedJobId=result.job.id;persist();}});
    async function reprice(){const latest=await options.reloadOverview();if(authGeneration!==sessionGeneration)throw new Error('Sign in again before reviewing this quote.');return()=>open({...options,overview:latest});}
    const opener=document.activeElement,body=h('div',{class:'cq-body'}),foot=h('div',{class:'cq-foot'});
    const closeButton=h('button',{class:'cq-close',type:'button','aria-label':'Close catalog quote',onclick:()=>close()},'×');
    const dialog=h('dialog',{class:'cq-dialog','aria-labelledby':'cq-title'},h('header',{class:'cq-head'},h('div',{},h('p',{},'Products & installation'),h('h2',{id:'cq-title'},'Build a catalog quote')),closeButton),body,foot);
    function close(handoff=false){if(S.busy)return;S.closed=true;S.generation++;dialog.close();dialog.remove();active=null;root.removeEventListener('egc:signout',signout);if(!handoff)opener?.focus?.();}
    function signout(){signedOut=true;S.busy=false;for(let index=sessionStorage.length-1;index>=0;index--){const name=sessionStorage.key(index);if(name?.startsWith(prefix))sessionStorage.removeItem(name);}close();}
    root.addEventListener('egc:signout',signout);
    const button=(label,fn,primary=false,disabled=false)=>h('button',{type:'button',class:'cq-button'+(primary?' primary':''),disabled:S.busy||disabled,onclick:fn},label);
    function changed(){S.preview=null;S.error='';remember();}
    function supplyChanged(selection,checked){const other=S.items.find(item=>item!==selection&&item.itemId===selection.itemId&&item.customerSupplied===checked);if(other){if(other.quantity+selection.quantity>10000){S.error='The combined quantity must be no more than 10,000.';render();return;}other.quantity+=selection.quantity;S.items=S.items.filter(item=>item!==selection);}else selection.customerSupplied=checked;changed();render();}
    function field(label,name,type='text',wide=false){return h('label',{class:'cq-field'+(wide?' wide':'')},label,h('input',{class:'cq-input',type,name,value:S.client[name]||'',maxlength:name==='address'?300:120,autocomplete:name==='name'?'name':name==='phone'?'tel':name==='email'?'email':'street-address',disabled:S.busy||Boolean(S.frozen)||Boolean(S.preview),oninput:event=>{S.client[name]=event.target.value;changed();}}));}
    const products=overview.catalog.items.filter(item=>eligible(item,overview));
    const byId=new Map(overview.catalog.items.map(item=>[item.id,item]));
    function itemName(selection){return byId.get(selection.itemId)?.name||'Product no longer available';}
    function add(item){if(S.items.length>=MAX)return;const existing=S.items.find(entry=>entry.itemId===item.id&&!entry.customerSupplied);if(existing){existing.quantity=Math.min(10000,existing.quantity+1);}else{let id;do{id='catalog-'+S.next++;}while(S.items.some(entry=>entry.id===id));S.items.push({id,itemId:item.id,quantity:1,customerSupplied:false});}changed();render();}
    function selectionCard(selection){const item=byId.get(selection.itemId),current=item&&eligible(item,overview);return h('li',{class:'cq-selection'},h('div',{},h('strong',{},itemName(selection)),h('small',{},current?item.priceUnit:'Unavailable for quoting — remove this item.'),item?.requires?h('p',{class:'cq-requires'},item.requires):null),h('div',{class:'cq-selection-controls'},h('label',{class:'cq-field'},'Quantity',h('input',{class:'cq-input cq-quantity',type:'number',inputMode:'numeric',min:1,max:10000,step:1,value:selection.quantity,'aria-label':'Quantity for '+itemName(selection),disabled:S.busy,onchange:event=>{const next=Number(event.target.value);if(!Number.isSafeInteger(next)||next<1||next>10000){event.target.value=selection.quantity;S.error='Use a whole quantity from 1 to 10,000.';render();return;}selection.quantity=next;changed();render();}})),h('label',{class:'cq-check'},h('input',{type:'checkbox',checked:selection.customerSupplied,disabled:S.busy,onchange:event=>{supplyChanged(selection,event.target.checked);}}),'Customer supplies product'),button('Remove',()=>{S.items=S.items.filter(entry=>entry.id!==selection.id);changed();render();})));}
    function productList(){const words=S.search.trim().toLowerCase().split(/\s+/).filter(Boolean),matches=products.filter(item=>(!S.category||item.category===S.category)&&words.every(word=>[item.name,item.brand,item.model].join(' ').toLowerCase().includes(word)));return h('div',{},h('p',{class:'cq-subtle'},`${matches.length} verified products · showing up to 8 matches. Search to narrow the list.`),matches.length?h('ul',{class:'cq-results'},matches.slice(0,8).map(item=>h('li',{class:'cq-product'},h('div',{},h('strong',{},item.name),h('small',{},item.priceUnit+' · '+money(overview.prices[item.id].unitCents)+' installed')),button('Add',()=>add(item),false,S.items.length>=MAX)))):h('p',{class:'cq-empty'},'No verified products match. Try another search or review the catalog price checks.'));}
    function lineSummary(lines,total,deposit){return h('section',{class:'cq-card'},h('h3',{},'Price review'),h('ul',{class:'cq-lines'},lines.map(line=>h('li',{},h('span',{},line.name,line.customerSupplied?' (customer supplied)':'',line.quantity!==1?' × '+line.quantity:''),h('b',{},money(line.totalCents))))),h('div',{class:'cq-total'},h('span',{},'Quote total'),h('b',{},money(total))),deposit!=null?h('p',{class:'cq-subtle'},'Deposit due: '+money(deposit)):null);}
    function render(){
      closeButton.disabled=S.busy;
      const children=[h('p',{class:'cq-step'},S.frozen?'Recover the original saved request':S.preview?'Review the server-verified price, then save a draft':'Choose verified products, add customer details, then check the exact price.')];
      if(S.frozen){const draft=S.frozen;children.push(h('p',{class:'cq-message',role:'status'},'The last save was not confirmed. Its customer, selections and prices are kept unchanged. Retry that request before starting another quote.'),h('section',{class:'cq-card'},h('h3',{},draft.client.name),h('p',{class:'cq-subtle'},draft.client.address)),lineSummary(draft.line_items,draft.line_items.reduce((sum,line)=>sum+line.totalCents,0),null));}
      else{
        children.push(S.preview?h('section',{class:'cq-card cq-customer-summary'},h('h3',{},S.client.name),h('p',{},S.client.address),h('p',{class:'cq-subtle'},[S.client.phone,S.client.email].filter(Boolean).join(' · '))):h('section',{class:'cq-card'},h('h3',{},'Customer'),h('div',{class:'cq-fields'},field('Customer name','name'),field('Phone','phone','tel'),field('Email','email','email'),field('Service address','address','text',true))));
        if(!S.preview){
          const categories=[...new Set(products.map(item=>item.category))].sort(),search=h('input',{class:'cq-input',type:'search',placeholder:'Find a shelf, rack or model…','aria-label':'Search verified products',value:S.search,disabled:S.busy}),select=h('select',{class:'cq-input','aria-label':'Product category',disabled:S.busy},h('option',{value:''},'All categories'),categories.map(id=>h('option',{value:id,selected:S.category===id},overview.catalog.categories.find(row=>row.id===id)?.label||id.replaceAll('-',' '))));
          const results=h('div',{},productList());search.addEventListener('input',event=>{S.search=event.target.value;results.replaceChildren(productList());});select.addEventListener('change',event=>{S.category=event.target.value;results.replaceChildren(productList());});
          children.push(h('section',{class:'cq-card'},h('h3',{},'Products'),h('div',{class:'cq-search'},search,select),results),h('section',{class:'cq-card'},h('h3',{},`Selected products (${S.items.length}/${MAX})`),S.items.length?h('ul',{class:'cq-selected'},S.items.map(selectionCard)):h('p',{class:'cq-empty'},'Add a product above to start.'),h('p',{class:'cq-subtle'},'The installed price includes the approved labor and any packaging charge. Customer-supplied items exclude product cost and markup. The minimum is applied once to this quote.')));
        }else children.push(lineSummary(S.preview.lineItems,S.preview.totalCents,S.preview.depositCents),h('p',{class:'cq-subtle'},'This is a catalog installation quote. Existing walkthrough service prices are unchanged. Saving a draft does not contact the customer.'));
      }
      if(S.error)children.push(h('p',{class:'cq-message error',role:'alert'},S.error));
      if(S.busy)children.push(h('p',{class:'cq-message',role:'status'},'Checking the published prices…'));
      body.replaceChildren(...children);
      foot.replaceChildren(button(S.preview?'Edit selections':'Close',()=>{if(S.preview){S.preview=null;render();}else close();}),button(S.frozen?'Review original save':S.preview?'Continue to save draft':S.stalePricing?'Review updated prices':'Review exact price',S.frozen||S.preview?handoff:S.stalePricing?refreshPrices:preview,true,!S.frozen&&!S.preview&&!S.items.length));
    }
    async function refreshPrices(){if(S.busy)return;S.busy=true;S.error='';render();try{const reopen=await reprice();if(S.closed)return;S.busy=false;close(true);await reopen();}catch(error){if(!S.closed){S.busy=false;S.error=error.message||'The latest prices could not be loaded. Retry.';render();}}}
    async function preview(){
      if(S.busy)return;
      if(!S.client.name.trim()||!S.client.address.trim()||!S.client.phone.trim()&&!S.client.email.trim()){S.error='Add the customer name, service address, and a phone number or email.';render();return;}
      if(S.items.some(selection=>!eligible(byId.get(selection.itemId),overview))){S.error='Remove unavailable products before reviewing the price.';render();return;}
      const input=descriptor(overview,S.items),generation=++S.generation,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      S.busy=true;S.error='';render();
      try{const response=await fetcher('/api/quote-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'catalog_preview',catalogPricing:input}),signal:controller.signal});const data=await response.json();if(generation!==S.generation||S.closed)return;if(!response.ok||data?.ok!==true){S.stalePricing=typeof options.reloadOverview==='function'&&/^quote_draft_catalog_(version_changed|price_unverified|item_unavailable)$/.test(data?.code||'');throw new Error(data?.error||'The exact price could not be checked. Retry shortly.');}if(!validPreview(data,input))throw new Error('The price response did not match these selections. Nothing was saved.');S.preview=data;persist();}
      catch(error){if(generation===S.generation&&!S.closed)S.error=controller.signal.aborted?'The price check timed out. Your selections are kept; retry.':error.message||'The price check failed. Retry.';}
      finally{clearTimeout(timer);if(generation===S.generation&&!S.closed){S.busy=false;render();}}
    }
    function handoff(){
      if(S.busy)return;
      const priced=S.preview,frozen=S.frozen,customer=clone(S.client);
      if(!frozen&&!priced)return;
      const build=validUntil=>frozen||{client:customer,title:'EGC Products & Installation',scope:'Products and installation: '+priced.lineItems.filter(line=>line.kind==='product').map(line=>`${line.quantity} × ${line.name}${line.customerSupplied?' (customer supplied)':''}`).join('; ').slice(0,1450)+'.',line_items:clone(priced.lineItems),valid_until:validUntil,catalog_version:priced.catalogVersion,catalog_pricing:clone(priced.catalogPricing),crew_size:null,estimated_duration_min:null};
      try{persist();}catch{S.error='This browser could not keep the quote request. Allow session storage before saving.';render();return;}
      close(true);
      root.EGCQuoteDraft.open({client,draft:build,variant:'catalog',title:'Review catalog quote',kicker:'Products & installation',...(typeof options.reloadOverview==='function'?{reprice}:{}),onSent:()=>{try{sessionStorage.removeItem(key);}catch{}}});
    }
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});document.body.append(dialog);active={dialog};render();dialog.showModal();remember();
    try{const pending=await client.pendingSave();if(!S.closed&&pending?.draft){S.frozen=pending.draft;render();}}catch(error){if(!S.closed){S.error=error.message;render();}}
    return dialog;
  }
  root.EGCCatalogQuote=Object.freeze({open,eligible,descriptor,validPreview});
})(window);
