/* Owner catalog & pricing (CATALOG-ADMIN), the owner-only 'catalog' Hub screen. Pricing settings are edited with
   a before/after review; the published garage catalog lists every item with its price-verified date, and the Stale
   badge is the server's 90-day flag (GET /api/catalog prices[id].stale). Edits, price checks and new products build a
   per-owner draft that publishes as a new catalog version after a diff review. Everything goes through /api/catalog
   (P2-03): only the owner writes, a settings save carries expectedRevision, a publish carries basedOnVersion, and each
   keeps its requestId until the server answers, so Retry resends the identical request. Nothing here messages a
   customer. The model helpers (EGCCatalog.model) are pure and take the Denver date as an argument. */
(function(){
'use strict';
// Drafts live under the Hub's draft prefix, which the always-loaded screen registry clears on sign-out.
const API='/api/catalog',SCREEN='catalog',DRAFT_KEY='egc.hub.draft.v1.catalog.',TZ='America/Denver',PAGE=40,MAX_ITEM_CENTS=10000000,QUOTE_ASSET_VERSION='20260930catalogquote1';
const PRODUCT_CATEGORIES=['bikes','cabinets-workbenches','floors-lighting-extras','lawn-garden','overhead','shelving','small-items','sports-outdoor','wall-systems'];
const TIERS=['good','better','best'],VERIFIED_EVIDENCE=['product_page','search_snippet'];
const AVAILABILITY={active:'Active',referral_only:'Referral only',hidden:'Hidden'};
const EVIDENCE={product_page:'product page',search_snippet:'search result',unconfirmed_snippet:'unconfirmed snippet',estimate:'estimate',egc_price_list:'EGC price list'};
const REQUIREMENTS={'wall-studs':'Wall studs','ceiling-joists':'Ceiling joists','none-freestanding':'Freestanding','assembly-only':'Assembly only','two-person-lift':'Two-person lift','electrical-outlet':'Electrical outlet','level-floor':'Level floor','drywall-only-light-duty':'Drywall only (light duty)','electrician-required':'Electrician required','concrete-anchors':'Concrete anchors','masonry':'Masonry'};
const ROUNDING={half_up_cent:'Half a cent rounds up',ceil_cent:'Any fraction of a cent rounds up'};
const VERSION=/^(\d{4}-\d{2}-\d{2})\.(\d{1,3})$/,LABEL=/^[A-Za-z0-9._:-]{1,80}$/,SLUG=/^[a-z0-9][a-z0-9-]{1,79}$/;
const IMAGE=/\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?|ico)(?:[?#]|$)/i;
const SAFETY_WORDS=/joist|truss|stud|anchor|lag|two people|two-person|2-person/i,PRICE_UNIT_WORDS=/not verified|typical range|estimate/i;

// ---- Pure model: no DOM, no clock ----
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const trimmed=value=>String(value??'').trim();
function validDate(date){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const stamp=Date.parse(date+'T12:00:00Z');
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===date;
}
const dayCount=(from,to)=>validDate(from)&&validDate(to)?Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000):null;
function denverParts(at){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));}
function denverDay(at){const p=denverParts(at);return`${p.year}-${p.month}-${p.day}`;}
const money=cents=>Number.isSafeInteger(cents)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100):'—';
const dollars=cents=>Number.isSafeInteger(cents)?(cents/100).toFixed(2):'';
// '75', '75.5', '$1,250.00' => integer cents; anything else (negative, 3 decimals, words) => null.
function centsOf(value){
  const text=trimmed(value).replace(/^\$\s*/,'').replace(/,(?=\d{3}(?:\D|$))/g,'');
  const match=/^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  return match?Number(match[1])*100+Number((match[2]||'').padEnd(2,'0')):null;
}
function percentOf(value){const text=trimmed(value).replace(/\s*%$/,'');return /^\d{1,3}(?:\.\d{1,2})?$/.test(text)?Number(text):null;}
const dateLabel=date=>validDate(date)?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z')):'—';
const ageText=days=>days==null?'':days<=0?'today':days===1?'1 day ago':`${days} days ago`;
const unitText=unit=>/^(per|each)\b/i.test(unit||'')?unit:'per '+unit;
const priceRange=item=>item.kind==='service'?[item.fixedPriceCents,item.fixedPriceCents]:[item.retailPriceLowCents,item.retailPriceHighCents];
const pricedSource=source=>/\$\s?\d/.test(source?.observedPrice||'')&&!/^(?:price\s+)?not\s/i.test(source.observedPrice);
// The most recent check; on the same day the source added last wins.
const latestSource=item=>(item.sources||[]).reduce((best,source)=>!best||String(source.checkedOn)>=String(best.checkedOn)?source:best,null);

// Versions are YYYY-MM-DD.N: the next is today's first release, or the next release of the current day (never earlier).
function nextVersion(current,today){
  const match=VERSION.exec(String(current||''));
  if(!match||!validDate(today))return null;
  const day=today>match[1]?today:match[1],release=day===match[1]?Number(match[2])+1:1;
  return release>999?null:`${day}.${release}`;
}

// The server's stale flag decides for a published price. A draft that re-verified or re-priced the item is judged by
// its own dates until it is published. => {state:'unverified'|'stale'|'verified', age, draft}
function priceStatus(item,base,price,today){
  const changed=!base||base.priceVerified!==item.priceVerified||base.priceVerifiedAt!==item.priceVerifiedAt;
  const age=item.priceVerified&&item.priceVerifiedAt?dayCount(item.priceVerifiedAt,today):null;
  if(!item.priceVerified)return{state:'unverified',age:null,draft:changed};
  if(!changed&&price?.stale===true)return{state:'stale',age,draft:false};
  return{state:'verified',age,draft:changed};
}

// filters: {q, category, tier, status: ''|'attention'|'stale'|'unverified'|'verified'|'draft', availability, min, max (cents|null)}
function matchesFilters(row,filters){
  const {item,status}=row,f=filters||{};
  if(f.category&&item.category!==f.category)return false;
  if(f.tier&&item.tier!==f.tier)return false;
  if(f.availability&&item.availability!==f.availability)return false;
  if(f.status==='attention'&&status.state==='verified')return false;
  if(['stale','unverified','verified'].includes(f.status)&&status.state!==f.status)return false;
  if(f.status==='draft'&&!row.draft)return false;
  const [low,high]=priceRange(item);
  if(Number.isSafeInteger(f.min)&&high<f.min)return false;
  if(Number.isSafeInteger(f.max)&&low>f.max)return false;
  const words=trimmed(f.q).toLowerCase().split(/\s+/).filter(Boolean);
  if(words.length){const text=[item.name,item.brand,item.model,item.dimensions,item.genericSpec,item.subcategory,item.id].filter(value=>typeof value==='string').join(' ').toLowerCase();if(!words.every(word=>text.includes(word)))return false;}
  return true;
}

// ---- Pricing settings ----
const MONEY_SETTINGS=[['laborRateCents','Labor rate per technician-hour',1,100000,'Billed per technician-minute of install time.'],['minimumJobCents','Minimum job',0,MAX_ITEM_CENTS,'Catalog quotes only, once per quote (never per line). The $450 walkthrough game plan minimum does not change here.'],['disposalCentsPerItem','Packaging haul-away per unit',0,100000,'Added per unit of items marked for haul-away while haul-away is on.']];
function settingsForm(values,label){
  const form={settingsVersion:label??values.settingsVersion,depositPct:String(values.depositPct),'markup.default':String(values.markupPct.default),includeDisposal:values.includeDisposal===true,roundingRule:values.roundingRule,ready:values.mustSetBeforeCustomerUse===false};
  for(const [key] of MONEY_SETTINGS)form[key]=dollars(values[key]);
  for(const category of PRODUCT_CATEGORIES)form['markup.'+category]=values.markupPct.byCategory?.[category]==null?'':String(values.markupPct.byCategory[category]);
  return form;
}
// Form fields compared by what they mean: '500' and '500.00' are the same minimum. Unparseable text compares as typed.
function formValue(key,value){
  const number=MONEY_SETTINGS.some(([name])=>name===key)?centsOf(value):key==='depositPct'||key.startsWith('markup.')?(trimmed(value)?percentOf(value):''):value;
  return number??value;
}
const sameField=(key,a,b)=>same(formValue(key,a),formValue(key,b));
// The complete settings document the server validates, built from the saved values plus the form. A blank category
// markup falls back to the default. Comments that described a value the owner changed are dropped with it.
function parseSettings(form,current){
  const errors={},next=clone(current);
  for(const [key,label,min,max] of MONEY_SETTINGS){
    const value=centsOf(form[key]);
    if(value==null)errors[key]=`Enter ${label.toLowerCase()} as dollars, like 75.00.`;
    else if(value<min||value>max)errors[key]=`Enter ${money(min)} to ${money(max)}.`;
    else next[key]=value;
  }
  const percent=(key,max,optional)=>{if(optional&&!trimmed(form[key]))return undefined;const value=percentOf(form[key]);if(value==null||value>max){errors[key]=`Enter a percentage from 0 to ${max} with at most 2 decimals.`;return null;}return value;};
  const deposit=percent('depositPct',100);if(deposit!=null)next.depositPct=deposit;
  const markup=percent('markup.default',500);if(markup!=null)next.markupPct.default=markup;
  const byCategory={};
  for(const category of PRODUCT_CATEGORIES){const value=percent('markup.'+category,500,true);if(value!=null)byCategory[category]=value;}
  next.markupPct.byCategory=byCategory;
  next.includeDisposal=form.includeDisposal===true;
  if(!Object.hasOwn(ROUNDING,form.roundingRule))errors.roundingRule='Choose a rounding rule.';else next.roundingRule=form.roundingRule;
  const label=trimmed(form.settingsVersion);
  if(!LABEL.test(label)||!/[A-Za-z0-9]/.test(label))errors.settingsVersion='Use up to 80 letters, digits, dots, dashes, underscores or colons.';
  else if(label===current.settingsVersion)errors.settingsVersion='Give these settings a new version label so every quote records which settings priced it.';
  next.settingsVersion=label;
  next.mustSetBeforeCustomerUse=form.ready!==true;
  if(plain(next.comments)){
    for(const key of Object.keys(next.comments))if(key!=='settingsVersion'&&!same(next[key],current[key]))delete next.comments[key];
    if(!Object.keys(next.comments).length)delete next.comments;
  }
  return{settings:next,errors};
}
function settingsChanges(before,after,labels={}){
  const rows=[],pct=value=>value==null?'—':`${value}%`,add=(label,a,b,format=String)=>{if(!same(a,b))rows.push({label,before:format(a),after:format(b)});};
  for(const [key,label] of MONEY_SETTINGS)add(label,before[key],after[key],money);
  add('Charge packaging haul-away',before.includeDisposal,after.includeDisposal,value=>value?'Yes':'No');
  add('Deposit',before.depositPct,after.depositPct,pct);
  add('Rounding',before.roundingRule,after.roundingRule,value=>ROUNDING[value]||String(value));
  add('Default markup',before.markupPct?.default,after.markupPct?.default,pct);
  for(const category of PRODUCT_CATEGORIES){
    const a=before.markupPct?.byCategory?.[category],b=after.markupPct?.byCategory?.[category];
    add(`Markup: ${labels[category]||category.replaceAll('-',' ')}`,a,b,value=>value==null?'default':pct(value));
  }
  add('Ready for customer quotes',before.mustSetBeforeCustomerUse===false,after.mustSetBeforeCustomerUse===false,value=>value?'Yes':'No (internal estimates only)');
  add('Version label',before.settingsVersion,after.settingsVersion);
  return rows;
}
// Three-way: a field the owner left as it was in `before` takes the value from `latest`; an edited field keeps the
// owner's value. A label that `latest` already used is replaced by `label`.
function rebaseSettingsForm(form,before,latest,label){
  const old=settingsForm(before),fresh=settingsForm(latest,label),next={};
  for(const key of Object.keys(fresh))next[key]=key==='settingsVersion'?(trimmed(form.settingsVersion)&&form.settingsVersion!==latest.settingsVersion?form.settingsVersion:label):sameField(key,form[key],old[key])?fresh[key]:form[key];
  return next;
}
// After a save of `sent` (built from `before`): null when the form still produces what was sent, so it resets to the
// saved values; otherwise the form holds later edits (fields that differ from what was sent), which move onto `saved`.
function settingsAfterSave(form,before,sent,saved,label){
  if(!plain(form)||!plain(before)||same(parseSettings(form,before).settings,sent))return null;
  return rebaseSettingsForm(form,sent,saved||sent,label);
}

// ---- Items ----
function textError(value,{min=1,max,nullable=false}={}){
  if(value===null&&nullable)return'';
  const text=String(value??'');
  return text.trim().length<min||text.length>max?`Enter ${min>1?`at least ${min} and `:''}up to ${max} characters.`:'';
}
function urlError(value){
  let url;try{url=new URL(value);}catch{return'Enter the full https:// link to the product page.';}
  if(url.protocol!=='https:'||url.username||url.password||!url.hostname.includes('.')||/\s/.test(value)||value.length>600)return'Enter a public https:// link (no spaces, up to 600 characters).';
  if(IMAGE.test(url.pathname))return'Link to the product page, not an image.';
  return'';
}
// Record one price check on a copy of the item. Products take a store source; an EGC service re-confirms its price list.
// input: {retailer, url, evidence, low, high, checkedOn, note}. => {item} or {errors}
function verifyItem(item,input,today){
  const errors={},next=clone(item),checkedOn=trimmed(input.checkedOn),note=trimmed(input.note);
  // The verified date is the newest priced check, so an older check would date a price it did not see.
  const latest=item.sources.filter(source=>item.kind==='service'||pricedSource(source)).map(source=>String(source.checkedOn)).sort().at(-1);
  if(!validDate(checkedOn))errors.checkedOn='Enter the date you checked the price.';
  else if(checkedOn>today)errors.checkedOn=`The check date cannot be after today (${dateLabel(today)}).`;
  else if(latest&&checkedOn<latest)errors.checkedOn=`Your check must be on or after ${dateLabel(latest)}, the latest recorded price check.`;
  if(note.length>2000)errors.note='Keep the note under 2,000 characters.';
  if(item.kind==='service'){
    if(Object.keys(errors).length)return{errors};
    next.sources=next.sources.map(source=>({...source,checkedOn}));
    next.priceVerified=true;next.priceVerifiedAt=checkedOn;next.verificationNote=note||null;
    return{item:next};
  }
  const retailer=trimmed(input.retailer),url=trimmed(input.url),low=centsOf(input.low),high=trimmed(input.high)?centsOf(input.high):low,evidence=input.evidence;
  if(!retailer||retailer.length>200)errors.retailer='Enter the store, like The Home Depot.';
  const badUrl=urlError(url);if(badUrl)errors.url=badUrl;
  if(!VERIFIED_EVIDENCE.includes(evidence))errors.evidence='Choose where you saw the price.';
  if(low==null||low<1||low>MAX_ITEM_CENTS)errors.low=`Enter the price you saw, from $0.01 to ${money(MAX_ITEM_CENTS)}.`;
  else if(high==null||high<low||high>MAX_ITEM_CENTS)errors.high='Enter a high price at or above the low price, or leave it blank.';
  if(Object.keys(errors).length)return{errors};
  const observedPrice=`${low===high?money(low):`${money(low)} to ${money(high)}`} on the ${EVIDENCE[evidence]} (checked in the Hub)`;
  let others=next.sources.filter(source=>source.url!==url);
  if(others.length>=12)others=others.slice().sort((a,b)=>String(a.checkedOn).localeCompare(String(b.checkedOn))).slice(1);
  next.sources=[...others,{url,retailer,observedPrice,checkedOn}];
  next.retailPriceLowCents=low;next.retailPriceHighCents=high;
  next.priceVerified=true;next.priceEvidence=evidence;next.verificationNote=note||null;
  next.priceVerifiedAt=next.sources.filter(pricedSource).map(source=>source.checkedOn).sort().at(-1);
  if(next.auditActions.length<40)next.auditActions=[...next.auditActions,`price verified in the Hub on ${checkedOn} from ${retailer}`.slice(0,600)];
  return{item:next};
}
const TEXT_FIELDS={name:160,brand:600,genericSpec:600,bestFor:600,model:1000,dimensions:1000,weightCapacity:1000,requires:1000,installNotes:1000,subcategory:120,priceUnit:120};
const NULLABLE=['model','dimensions','weightCapacity','requires','installNotes'];
// Detail fields shared by the edit and add forms, checked the way the server checks a published item.
function applyDetails(next,input,errors,today){
  for(const [key,max] of Object.entries(TEXT_FIELDS)){
    if(!Object.hasOwn(input,key))continue;
    const value=trimmed(input[key]),nullable=NULLABLE.includes(key);
    const error=textError(nullable&&!value?null:value,{max,nullable});
    if(error)errors[key]=error;else next[key]=nullable&&!value?null:value;
  }
  if(Object.hasOwn(input,'priceUnit')&&PRICE_UNIT_WORDS.test(next.priceUnit||''))errors.priceUnit='Describe the unit only (each, per 4-pack); put estimate notes in the verification note.';
  if(Object.hasOwn(input,'tier')){if(!TIERS.includes(input.tier))errors.tier='Choose good, better or best.';else next.tier=input.tier;}
  if(Object.hasOwn(input,'availability')){if(!Object.hasOwn(AVAILABILITY,input.availability))errors.availability='Choose how the item is offered.';else next.availability=input.availability;}
  if(Object.hasOwn(input,'installMinutes')){const minutes=Number(trimmed(input.installMinutes));if(!/^\d{1,4}$/.test(trimmed(input.installMinutes))||minutes>1440)errors.installMinutes='Enter whole technician-minutes from 0 to 1440.';else next.installMinutes=minutes;}
  if(Object.hasOwn(input,'crewSize')){const size=Number(input.crewSize);if(![1,2,3,4].includes(size))errors.crewSize='Choose 1 to 4 people.';else next.crewSize=size;}
  if(Object.hasOwn(input,'haulAwayApplicable'))next.haulAwayApplicable=input.haulAwayApplicable===true;
  // Referral-only items carry no EGC install time or haul-away.
  if(next.availability==='referral_only'){next.installMinutes=0;next.haulAwayApplicable=false;}
  if(Array.isArray(next.installRequirements)&&next.installRequirements.includes('two-person-lift')&&next.crewSize<2)errors.crewSize='A two-person lift needs a crew of at least 2.';
  if(Object.hasOwn(input,'safetyNotes')){
    const notes=trimmed(input.safetyNotes),overhead=(next.installRequirements||[]).some(entry=>entry==='ceiling-joists'||entry==='two-person-lift');
    if(notes.length<40||notes.length>2000)errors.safetyNotes='Write safety notes of 40 to 2,000 characters.';
    else if(overhead&&(notes.length<80||!SAFETY_WORDS.test(notes)))errors.safetyNotes='Overhead and heavy items need at least 80 characters naming the joists, studs, anchors or two-person lift.';
    else next.safetyNotes=notes;
  }
  let repriced=false;
  if(Object.hasOwn(input,'low')){
    const low=centsOf(input.low),high=trimmed(input.high)?centsOf(input.high):low;
    if(low==null||low<1||low>MAX_ITEM_CENTS)errors.low=`Enter a price from $0.01 to ${money(MAX_ITEM_CENTS)}.`;
    else if(high==null||high<low||high>MAX_ITEM_CENTS)errors.high='Enter a high price at or above the low price, or leave it blank.';
    else if(low!==next.retailPriceLowCents||high!==next.retailPriceHighCents){
      // A price typed here was not checked against a store: it is an owner estimate until someone verifies it.
      repriced=true;next.retailPriceLowCents=low;next.retailPriceHighCents=high;next.priceVerified=false;next.priceVerifiedAt=null;next.priceEvidence='estimate';
    }
  }
  const note=trimmed(input.verificationNote),estimateNote=`Owner estimate entered in the Hub on ${today}; not yet checked against a store price.`;
  if(Object.hasOwn(input,'verificationNote')){
    if(note.length>2000)errors.verificationNote='Keep the note under 2,000 characters.';
    else if(repriced)next.verificationNote=note&&note!==trimmed(input.verificationNoteBefore)?note:estimateNote;
    else if(!next.priceVerified&&!note)errors.verificationNote='Say where this estimate came from.';
    else next.verificationNote=note||null;
  }else if(repriced)next.verificationNote=estimateNote;
  return next;
}
function editItem(item,input,today){
  const errors={},next=applyDetails(clone(item),input,errors,today);
  return Object.keys(errors).length?{errors}:{item:next};
}
const slugOf=text=>trimmed(text).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,72).replace(/-+$/,'');
function uniqueId(name,catalog,taken=[]){
  const used=new Set([...(catalog.items||[]).map(item=>item.id),...(catalog.auditLog?.removedItems||[]).map(item=>item.id),...taken]);
  const base=slugOf(name).length>=2?slugOf(name):'item';
  for(let index=1;index<1000;index++){const id=index===1?base:`${base}-${index}`;if(!used.has(id)&&SLUG.test(id))return id;}
  return null;
}
// A new product for the draft. With a store source it is verified; without one it is an estimate with a note.
function newProduct(input,catalog,today,taken=[]){
  const errors={},category=input.category,needs=Array.isArray(input.needs)?input.needs:[],zones=Array.isArray(input.zones)?input.zones:[],requirements=Array.isArray(input.installRequirements)?input.installRequirements:[];
  if(!PRODUCT_CATEGORIES.includes(category))errors.category='Choose a product category.';
  const knownNeeds=new Set(catalog.needs.map(need=>need.id)),knownZones=new Set(catalog.zones.map(zone=>zone.id));
  if(!needs.length||needs.length>8||needs.some(need=>!knownNeeds.has(need)))errors.needs='Choose 1 to 8 needs this item answers.';
  if(!zones.length||zones.some(zone=>!knownZones.has(zone)))errors.zones='Choose at least one garage zone.';
  if(requirements.some(entry=>!Object.hasOwn(REQUIREMENTS,entry)))errors.installRequirements='Choose install requirements from the list.';
  const id=uniqueId(input.name,catalog,taken);
  if(!id)errors.name='Choose a different name; no free item id is left for it.';
  const item={id:id||'item',kind:'product',category,subcategory:'',needs:[...new Set(needs)],zones:[...new Set(zones)],tier:'good',availability:'active',name:'',brand:'',model:null,genericSpec:'',dimensions:null,weightCapacity:null,requires:null,
    installRequirements:[...new Set(requirements)],installMinutes:0,crewSize:1,haulAwayApplicable:false,retailPriceLowCents:0,retailPriceHighCents:0,priceUnit:'each',priceVerified:false,priceVerifiedAt:null,priceEvidence:'estimate',verificationNote:null,sources:[],
    pros:[],cons:[],bestFor:'',safetyNotes:'',installNotes:null,auditStatus:'self_reviewed_no_findings',auditActions:[`added in the Hub catalog editor on ${today}`]};
  const next=applyDetails(item,input,errors,today);
  const sourced=[input.retailer,input.url].some(value=>trimmed(value));
  if(sourced&&!errors.low&&!errors.high){
    const checked=verifyItem(next,{retailer:input.retailer,url:input.url,evidence:input.evidence,low:input.low,high:input.high,checkedOn:input.checkedOn,note:input.verificationNote},today);
    if(checked.errors)Object.assign(errors,checked.errors);else return Object.keys(errors).length?{errors}:{item:{...checked.item,auditActions:item.auditActions}};
  }else if(!trimmed(input.verificationNote))errors.verificationNote='Without a store source, say where this estimate came from.';
  return Object.keys(errors).length?{errors}:{item:next};
}

// Need coverage is derived from the items (the server refuses a claim the items do not give), so a draft recomputes it.
function coverageOf(items,need){
  const members=items.filter(item=>item.needs.includes(need)),active=members.filter(item=>item.availability==='active'),tiers=new Set(active.map(item=>item.tier).filter(Boolean));
  if(members.length&&members.every(item=>item.kind==='service'))return'service';
  if(!active.length&&members.some(item=>item.availability==='referral_only'))return'referral_only';
  return active.length>=3&&tiers.size>=2?'full':'limited';
}
function applyCoverage(catalog){
  const changes=[];
  for(const need of catalog.needs){
    const found=coverageOf(catalog.items,need.id);
    if(found===need.coverage)continue;
    changes.push({id:need.id,label:need.label,before:need.coverage,after:found});
    need.coverage=found;
    need.coverageNote=found==='full'||found==='service'?null:found==='referral_only'?'Only referral partners cover this need after a Hub catalog edit.':'Fewer than three active options across two tiers after a Hub catalog edit.';
  }
  return changes;
}
// The complete catalog document to publish: the published base with the draft's items, the next version and coverage.
function draftCatalog(base,draft,today){
  const version=nextVersion(base.catalogVersion,today);
  if(!version)return{error:'No later catalog version is available today. Publish again tomorrow.'};
  const catalog=clone(base),index=new Map(catalog.items.map((item,at)=>[item.id,at]));
  for(const [id,item] of Object.entries(draft.items||{}))if(index.has(id))catalog.items[index.get(id)]=clone(item);
  for(const id of draft.added||[])if(draft.items?.[id]&&!index.has(id))catalog.items.push(clone(draft.items[id]));
  catalog.catalogVersion=version;catalog.generatedOn=version.slice(0,10);
  if(plain(catalog.auditLog))catalog.auditLog.publishedItems=catalog.items.length;
  return{catalog,version,coverage:applyCoverage(catalog)};
}
// Arrays show what left and what arrived; everything else shows before and after.
function catalogDiff(base,next){
  const before=new Map(base.items.map(item=>[item.id,item])),added=[],changed=[];
  for(const item of next.items){
    const old=before.get(item.id);
    if(!old){added.push({id:item.id,name:item.name});continue;}
    const fields=[...new Set([...Object.keys(old),...Object.keys(item)])].filter(key=>!same(old[key],item[key])).map(key=>{
      if(Array.isArray(old[key])&&Array.isArray(item[key])){const a=old[key].map(entry=>JSON.stringify(entry)),b=item[key].map(entry=>JSON.stringify(entry));return{field:key,before:old[key].filter((_,at)=>!b.includes(a[at])),after:item[key].filter((_,at)=>!a.includes(b[at]))};}
      return{field:key,before:old[key],after:item[key]};
    });
    if(fields.length)changed.push({id:item.id,name:item.name,fields});
  }
  return{from:base.catalogVersion,to:next.catalogVersion,added,changed};
}

// ---- Draft ----
// {baseVersion, items:{id:item}, bases:{id:published item it was built from, or null for a new product}, added:[id], rebasedFrom}
const emptyDraft=()=>({baseVersion:null,items:{},bases:{},added:[],rebasedFrom:null});
// Fields the server checks together move together: a price with its sources, dates, evidence and note; the offering
// with its install time, crew, requirements and safety notes.
const PRICE_FIELDS=['retailPriceLowCents','retailPriceHighCents','fixedPriceCents','priceVerified','priceVerifiedAt','priceEvidence','verificationNote','sources'];
const OFFER_FIELDS=['availability','installMinutes','haulAwayApplicable','crewSize','installRequirements','safetyNotes'];
// Three-way: the owner's changes (draft against the item it was built from) applied to the latest published item, so a
// field another publish changed and the owner did not keeps the published value. Audit notes are a log: the latest
// notes stay and the draft's new ones follow.
function rebaseItem(draft,base,latest){
  const next=clone(latest),changed=key=>!same(draft[key],base[key]),take=key=>{if(draft[key]===undefined)delete next[key];else next[key]=clone(draft[key]);};
  for(const group of [PRICE_FIELDS,OFFER_FIELDS])if(group.some(changed))group.forEach(take);
  const grouped=new Set([...PRICE_FIELDS,...OFFER_FIELDS,'auditActions']);
  for(const key of new Set([...Object.keys(base),...Object.keys(draft)]))if(!grouped.has(key)&&changed(key))take(key);
  const kept=latest.auditActions||[],notes=(draft.auditActions||[]).filter(entry=>!(base.auditActions||[]).includes(entry)&&!kept.includes(entry));
  if(notes.length)next.auditActions=[...kept,...notes].slice(0,40);
  return next;
}
// The draft moved onto the published catalog `catalog` (version `version`). An item whose changes the latest copy
// already has leaves the draft; `rebasedFrom` names the version the draft was built on when that changed.
function rebaseDraft(draft,catalog,version){
  const next=clone(draft),latest=new Map(catalog.items.map(item=>[item.id,item]));
  for(const [id,item] of Object.entries(next.items)){
    const base=next.bases[id],current=latest.get(id);
    if(!current||!plain(base)||same(base,current))continue;
    const moved=rebaseItem(item,base,current);
    if(same(moved,current)){delete next.items[id];delete next.bases[id];}else{next.items[id]=moved;next.bases[id]=clone(current);}
  }
  next.added=next.added.filter(id=>Object.hasOwn(next.items,id));
  if(!Object.keys(next.items).length)return emptyDraft();
  if(next.baseVersion&&next.baseVersion!==version)next.rebasedFrom=next.rebasedFrom||next.baseVersion;
  next.baseVersion=version;
  return next;
}
// After a publish the draft keeps only what the request did not carry: an entry that differs from the copy sent stays,
// now based on that copy (the published one).
function publishedDraft(draft,sent,version){
  const carried=new Map(sent.items.map(item=>[item.id,item])),next=emptyDraft();
  for(const [id,item] of Object.entries(draft.items)){
    const was=carried.get(id);
    if(was&&same(item,was))continue;
    next.items[id]=item;next.bases[id]=was?clone(was):draft.bases[id]??null;
  }
  next.added=draft.added.filter(id=>Object.hasOwn(next.items,id)&&!carried.has(id));
  if(Object.keys(next.items).length)next.baseVersion=version;
  return next;
}
const FIELD_LABEL={name:'Name',brand:'Brand',model:'Model',dimensions:'Dimensions',weightCapacity:'Weight capacity',tier:'Tier',availability:'Availability',priceUnit:'Price unit',retailPriceLowCents:'Low price',retailPriceHighCents:'High price',priceVerified:'Price verified',priceVerifiedAt:'Verified on',priceEvidence:'Evidence',verificationNote:'Verification note',sources:'Price sources',installMinutes:'Install minutes',crewSize:'Crew size',haulAwayApplicable:'Packaging haul-away',safetyNotes:'Safety notes',auditActions:'Audit notes',installRequirements:'Install requirements',needs:'Needs',zones:'Zones'};
function formatValue(field,value){
  if(value==null||Array.isArray(value)&&!value.length)return'—';
  if(field==='sources')return value.map(source=>[source.retailer,source.observedPrice,source.checkedOn&&`checked ${source.checkedOn}`].filter(Boolean).join(' · ')).join('; ');
  if(/Cents$/.test(field))return money(value);
  if(typeof value==='boolean')return value?'Yes':'No';
  if(field==='priceEvidence')return EVIDENCE[value]||String(value);
  if(field==='availability')return AVAILABILITY[value]||String(value);
  if(field==='priceVerifiedAt')return dateLabel(value);
  const text=Array.isArray(value)?value.map(entry=>typeof entry==='string'?entry:JSON.stringify(entry)).join(', '):typeof value==='object'?JSON.stringify(value):String(value);
  return text.length>240?text.slice(0,239)+'…':text;
}

// ---- Screen ----
const S={host:null,root:null,ctx:null,kit:null,mountId:0,generation:0,controller:null,data:null,base:null,loading:false,loadError:null,loadedAt:0,
  tab:'settings',filters:{q:'',category:'',tier:'',status:'',availability:'',min:'',max:''},filtersOpen:null,shown:PAGE,list:null,
  draft:emptyDraft(),draftLoaded:false,settingsForm:null,settingsValues:null,settingsRevision:null,settingsErrors:{},settingsRebased:false,
  busy:false,quoteLoading:false,notice:null,conflict:null,retry:null,dialog:null};
const now=()=>{const value=typeof S.ctx?.now==='function'?Number(S.ctx.now()):Date.now();return Number.isFinite(value)?value:Date.now();};
// The server's clock carried forward from the last load, so versions and check dates follow Denver's calendar, not the device's.
function serverNow(){const asOf=Date.parse(S.data?.asOf||'');return Number.isFinite(asOf)?asOf+Math.max(0,now()-S.loadedAt):now();}
const today=()=>denverDay(serverNow());
// A label for the next save, never the one saved now or a just-saved `avoid` (a second save in the same minute gets a suffix).
function suggestedLabel(...avoid){
  const p=denverParts(serverNow()),base=`owner-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}`,used=new Set([S.data?.settings?.settingsVersion,...avoid]);
  let label=base;for(let n=2;used.has(label);n++)label=`${base}-${n}`;
  return label;
}
function viewerId(){let id=S.ctx?.identity;if(!id)try{id=sessionStorage.getItem('egc_u');}catch{}return trimmed(id).toLowerCase()||'anonymous';}
const draftKey=()=>DRAFT_KEY+encodeURIComponent(viewerId());
const canEdit=()=>S.data?.viewer?.canPublish===true;
const canSettings=()=>S.data?.viewer?.canEditSettings===true;
const draftCount=()=>Object.keys(S.draft.items).length;
const fetcher=()=>typeof S.ctx?.hubFetch==='function'?S.ctx.hubFetch:undefined;
const pendingStore=()=>S.kit.pending(SCREEN);
function pendingBody(){try{return S.kit?pendingStore().get()?.body||null:null;}catch{return null;}}
// Edits wait while a save is in flight or an unconfirmed one waits for Retry, so its answer settles exactly what was sent.
const locked=()=>S.busy||S.quoteLoading||Boolean(S.retry||pendingBody());
let quoteAssetsPromise=null;
function quoteAsset(tag,url){
  const existing=[...document.querySelectorAll('[data-egc-catalog-quote-asset]')].find(node=>node.getAttribute('data-egc-catalog-quote-asset')===url);
  if(existing?.dataset.ready==='true')return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const node=existing||document.createElement(tag);
    if(!existing){node.setAttribute('data-egc-catalog-quote-asset',url);if(tag==='link'){node.rel='stylesheet';node.href=url;}else node.src=url;}
    node.addEventListener('load',()=>{node.dataset.ready='true';resolve();},{once:true});
    node.addEventListener('error',()=>{node.remove();reject(new Error('catalog_quote_asset_unavailable'));},{once:true});
    if(!existing)document.head.append(node);
  });
}
function loadQuoteAssets(){
  if(typeof window.EGCCatalogQuote?.open==='function')return Promise.resolve();
  if(!quoteAssetsPromise)quoteAssetsPromise=(async()=>{
    await quoteAsset('link',`/employee-catalog-quote.css?v=${QUOTE_ASSET_VERSION}`);
    await quoteAsset('link',`/crew/quote-draft.css?v=${QUOTE_ASSET_VERSION}`);
    await quoteAsset('script',`/crew/quote-draft.js?v=${QUOTE_ASSET_VERSION}`);
    await quoteAsset('script',`/employee-catalog-quote.js?v=${QUOTE_ASSET_VERSION}`);
    if(typeof window.EGCCatalogQuote?.open!=='function')throw new Error('catalog_quote_asset_unavailable');
  })().catch(error=>{quoteAssetsPromise=null;throw error;});
  return quoteAssetsPromise;
}
async function buildCatalogQuote(){
  if(!S.data?.enabled||!S.data.settings?.readyForCustomers||locked()||!canEdit())return;
  const mount=S.mountId;S.quoteLoading=true;S.notice=null;render();
  try{
    await loadQuoteAssets();
    if(mount!==S.mountId)return;
    await window.EGCCatalogQuote.open({overview:S.data,hubFetch:fetcher(),identity:viewerId(),reloadOverview:async()=>{
      if(mount!==S.mountId)throw new Error('The catalog screen is no longer open.');
      await load();
      if(mount!==S.mountId||!S.data?.enabled||!S.data.settings?.readyForCustomers)throw new Error('Catalog prices are not ready. Review the pricing screen.');
      return S.data;
    }});
  }catch{
    if(mount===S.mountId)S.notice={kind:'error',text:'The catalog quote could not open. Try again from this screen. No customer message was sent.'};
  }finally{if(mount===S.mountId){S.quoteLoading=false;render();}}
}

function persist(){
  try{
    const settings=settingsDirty()?{form:S.settingsForm,revision:S.settingsRevision,values:S.settingsValues}:null;
    if(!draftCount()&&!settings)sessionStorage.removeItem(draftKey());
    else sessionStorage.setItem(draftKey(),JSON.stringify({v:1,baseVersion:S.draft.baseVersion,items:S.draft.items,bases:S.draft.bases,added:S.draft.added,rebasedFrom:S.draft.rebasedFrom,settings}));
  }catch{}
}
function readDraft(){
  try{
    const row=JSON.parse(sessionStorage.getItem(draftKey())||'null');
    if(!plain(row)||row.v!==1||!plain(row.items)||!Array.isArray(row.added))return null;
    const items=Object.fromEntries(Object.entries(row.items).filter(([id,item])=>plain(item)&&item.id===id&&typeof item.name==='string'&&Array.isArray(item.sources)));
    const bases=plain(row.bases)?Object.fromEntries(Object.entries(row.bases).filter(([id,base])=>Object.hasOwn(items,id)&&(base===null||plain(base)&&base.id===id))):{};
    const settings=plain(row.settings)&&plain(row.settings.form)&&plain(row.settings.values)?row.settings:null;
    return{draft:{baseVersion:typeof row.baseVersion==='string'?row.baseVersion:null,items,bases,added:row.added.filter(id=>Object.hasOwn(items,id)),rebasedFrom:VERSION.test(String(row.rebasedFrom))?row.rebasedFrom:null},settings};
  }catch{return null;}
}
function validOverview(data){
  if(data?.ok!==true||typeof data.enabled!=='boolean')return false;
  if(!data.enabled)return true;
  const c=data.catalog,p=data.publication,s=data.settings;
  return data.view==='full'&&plain(c)&&typeof c.catalogVersion==='string'&&VERSION.test(c.catalogVersion)&&['items','needs','zones','categories'].every(key=>Array.isArray(c[key]))
    &&c.items.every(item=>plain(item)&&typeof item.id==='string'&&typeof item.name==='string'&&Array.isArray(item.sources)&&Array.isArray(item.needs))
    &&plain(p)&&p.version===c.catalogVersion&&plain(s)&&(s.revision===null||typeof s.revision==='string')&&typeof s.settingsVersion==='string'&&plain(s.values)&&plain(s.values.markupPct)
    &&plain(data.prices)&&plain(data.stale)&&Number.isInteger(data.stale.afterDays)&&Array.isArray(data.stale.items)&&Number.isFinite(Date.parse(data.asOf||''))&&plain(data.viewer);
}
// Edited when any value means something else than in the form of the values it was built from; the label is always new.
function settingsDirty(){
  if(!S.settingsForm||!S.settingsValues)return false;
  const saved=settingsForm(S.settingsValues);
  return Object.keys(saved).some(key=>key!=='settingsVersion'&&!sameField(key,S.settingsForm[key],saved[key]));
}
// The settings form follows the saved values unless the owner has unsaved edits, which survive a reload and move onto
// a newer save field by field (rebaseSettingsForm).
function syncSettings(){
  const values=S.data.settings.values,revision=S.data.settings.revision,rebased=settingsDirty()&&S.settingsRevision!==revision;
  if(rebased)S.settingsForm=rebaseSettingsForm(S.settingsForm,S.settingsValues,values,suggestedLabel());
  S.settingsValues=clone(values);S.settingsRevision=revision;
  // Edits the latest save already holds (the owner's own save, answered or not) leave nothing to review.
  if(settingsDirty()){S.settingsRebased=rebased;return;}
  S.settingsForm=settingsForm(values,suggestedLabel());S.settingsRebased=false;
}
async function load(){
  if(!S.root)return;
  const generation=++S.generation;S.controller?.abort();
  const controller=S.controller=new AbortController();
  S.loading=true;S.loadError=null;render();
  try{
    const data=await S.kit.requestJSON(API+'?view=full',{prefix:'catalog',signal:controller.signal,fetcher:fetcher(),validate:validOverview});
    if(generation!==S.generation)return;
    S.data=data;S.loadedAt=now();S.base=data.enabled?data.catalog:null;
    if(data.enabled){
      if(!S.draftLoaded){
        S.draftLoaded=true;const saved=readDraft();
        if(saved){S.draft=saved.draft;if(saved.settings){S.settingsForm=saved.settings.form;S.settingsValues=saved.settings.values;S.settingsRevision=saved.settings.revision;}}
      }
      if(draftCount())S.draft=rebaseDraft(S.draft,data.catalog,data.publication.version);
      syncSettings();persist();
    }
  }catch(error){
    if(generation!==S.generation||error?.aborted)return;
    S.data=null;S.base=null;S.loadError=error;
  }finally{if(generation===S.generation){S.loading=false;S.controller=null;render();}}
}

function resultCheck(body){
  if(body.action==='settings.update')return data=>data.action==='settings.update'&&data.requestId===body.requestId&&plain(data.settings)&&data.settings.settingsVersion===body.settings.settingsVersion&&plain(data.settings.values)&&plain(data.settings.values.markupPct);
  return data=>data.action==='catalog.publish'&&data.requestId===body.requestId&&plain(data.publication)&&data.publication.version===body.catalog.catalogVersion;
}
const describe=body=>body?.action==='settings.update'?`Save pricing settings ${body.settings?.settingsVersion||''}`.trim():`Publish catalog version ${body?.catalog?.catalogVersion||''}`.trim();
// Server paths name catalog.items[N]; the owner knows the item by name.
function invalidText(error,body){
  const path=String(error?.details?.path||''),match=/^catalog\.items\[(\d+)\]\.?(\w+)?/.exec(path),item=match&&body?.catalog?.items?.[Number(match[1])];
  if(!item)return error.message;
  return`${item.name}: ${(FIELD_LABEL[match[2]]||match[2]||'item').toLowerCase()} ${error.details.reason||'is invalid'}. Fix it in your draft, then publish again.`;
}
async function send(body){
  if(S.busy||!S.kit)return;
  const mount=S.mountId,store=pendingStore(),options={prefix:'catalog',timeout:body.action==='catalog.publish'?90000:30000,fetcher:fetcher(),validate:resultCheck(body)};
  let reload=false;
  S.busy=true;S.notice=null;S.conflict=null;render();
  try{
    const saved=store.get(),data=saved&&saved.requestId===body.requestId?await store.replay(options):await store.submit(API,body,options);
    if(mount!==S.mountId)return;
    S.retry=null;
    if(body.action==='settings.update'){
      // Show the saved values at once; the reload that follows refreshes the prices they produce.
      const result=data.settings,fresh=result.current!==false&&S.data?.settings;
      if(fresh)S.data.settings={...S.data.settings,revision:result.revision,source:'firestore',settingsVersion:result.settingsVersion,readyForCustomers:result.readyForCustomers,updatedAt:result.updatedAt,updatedBy:result.updatedBy,values:result.values};
      // Edits made after the request was built stay, based on what this save wrote; everything else shows the saved
      // values. When a newer save replaced this one, the reload moves the later edits onto it.
      const later=settingsAfterSave(S.settingsForm,S.settingsValues,body.settings,result.values,suggestedLabel(result.settingsVersion));
      S.settingsForm=later;S.settingsValues=later?clone(result.values):null;S.settingsRevision=later?result.revision:null;
      S.settingsErrors={};if(S.data?.enabled&&(fresh||!later))syncSettings();
      S.notice={kind:'success',text:`Pricing settings saved as ${result.settingsVersion}${result.readyForCustomers?', approved for catalog quotes':', for internal estimates only'}.${result.current===false?' A newer save replaced them since; the latest values are shown.':''}${later&&settingsDirty()?' Your later edits are still in the form.':''}`};
    }else{
      S.draft=publishedDraft(S.draft,body.catalog,data.publication.version);S.tab='items';
      const left=draftCount();
      S.notice={kind:'success',text:`Published catalog version ${data.publication.version} with ${data.publication.itemCount} items.${data.publication.current===false?' A newer version was published since; the latest is shown.':''}${left?` ${left} unpublished change${left===1?' stays':'s stay'} in your draft.`:''}`};
    }
    persist();reload=true;
  }catch(error){
    if(mount!==S.mountId)return;
    const code=String(error?.code||'');
    if(S.kit.retryable(error)){S.retry=body;S.notice={kind:'error',text:S.kit.errorText(error)};return;}
    S.retry=null;
    if(body.action==='settings.update'&&code==='catalog_revision_conflict'){S.conflict='settings';S.notice={kind:'error',text:'Pricing settings changed since you opened them. Your edits are kept: load the latest settings, review the changes again and save.'};}
    else if(body.action==='catalog.publish'&&/^catalog_(version_conflict|revision_conflict|version_exists|version_not_newer)$/.test(code)){S.conflict='catalog';S.notice={kind:'error',text:'Another catalog version was published while you were editing. Your draft is kept: load the latest catalog, review the changes again and publish.'};}
    else if(/^catalog_settings_version_(used|unchanged)$/.test(code)){S.tab='settings';S.settingsErrors={settingsVersion:error.message};S.notice={kind:'error',text:error.message};}
    else if(code==='catalog_invalid'){S.tab='draft';S.notice={kind:'error',text:invalidText(error,body)};}
    else if(code==='catalog_changed_since_operation'){S.notice={kind:'error',text:error.message};reload=true;}
    else S.notice={kind:'error',text:S.kit.errorText(error)};
  }finally{
    if(mount===S.mountId){S.busy=false;render();if(reload)void load();}
  }
}
function discardRetry(){try{pendingStore().discard();}catch{}S.retry=null;S.notice=null;render();}

// ---- Rendering ----
const h=(...args)=>S.kit.h(...args);
const btn=(label,onClick,kind='',props={})=>S.kit.button(label,onClick,kind,props);
function rows(){
  if(S.list)return S.list;
  const base=new Set(S.base.items.map(item=>item.id)),day=today(),list=[];
  for(const item of S.base.items){const draft=S.draft.items[item.id],price=S.data.prices[item.id]||null;list.push({item:draft||item,base:item,draft:Boolean(draft),price,status:priceStatus(draft||item,item,price,day)});}
  for(const id of S.draft.added){const item=S.draft.items[id];if(item&&!base.has(id))list.push({item,base:null,draft:true,added:true,price:null,status:priceStatus(item,null,null,day)});}
  return S.list=list;
}
function summary(){
  if(!S.data?.enabled)return'Set the labor rate, markups and minimum, keep catalog prices verified and publish new catalog versions.';
  const p=S.data.publication,list=rows(),unverified=list.filter(row=>row.status.state==='unverified').length,stale=list.filter(row=>row.status.state==='stale').length;
  return`Version ${p.version} · ${S.base.items.length} items · ${unverified} unverified · ${stale} stale (older than ${S.data.stale.afterDays} days)`;
}
function head(){
  return h('header',{class:'hub-head'},
    h('div',{},h('span',{class:'hub-eyebrow'},'Owner · pricing'),h('h1',{},'Catalog & pricing'),h('p',{},summary())),
    h('div',{class:'hub-actions'},btn(S.loading?'Loading…':'Refresh',()=>void load(),'',{disabled:S.loading||S.busy})));
}
function feedback(){
  const items=[];
  if(S.busy)items.push(h('div',{class:'hub-notice',role:'status'},'Saving… keep this screen open until the Hub answers.'));
  if(S.notice)items.push(h('div',{class:`hub-notice ${S.notice.kind}`,role:S.notice.kind==='error'?'alert':'status'},S.notice.text));
  const retry=S.busy?null:S.retry||pendingBody();
  if(retry)items.push(h('div',{class:'hub-notice warning cat-retry'},h('strong',{},'Not confirmed: '+describe(retry)),h('p',{},'The Hub did not confirm this change. Retry sends the identical request, so it cannot be saved twice. Editing waits until you retry or discard it.'),
    h('div',{class:'hub-actions'},btn('Retry original request',()=>void send(retry),'primary'),btn('Discard saved request',discardRetry))));
  if(S.conflict==='settings'&&!S.busy)items.push(h('div',{class:'hub-actions cat-conflict'},btn('Load latest settings',()=>{S.conflict=null;void load();},'primary'),btn('Discard my edits',()=>{S.conflict=null;S.settingsForm=null;S.settingsValues=null;S.settingsErrors={};persist();void load();})));
  if(S.conflict==='catalog'&&!S.busy)items.push(h('div',{class:'hub-actions cat-conflict'},btn('Load latest catalog',()=>{S.conflict=null;S.tab='draft';void load();},'primary')));
  return h('div',{class:'cat-feedback','aria-live':'polite'},items);
}
function tabs(){
  const entries=[['settings','Pricing'],['items','Items'],['draft',draftCount()?`Draft (${draftCount()})`:'Draft']];
  return h('div',{class:'cat-tabs',role:'tablist','aria-label':'Catalog sections'},entries.map(([id,label])=>h('button',{type:'button',role:'tab',id:'cat-tab-'+id,'aria-selected':String(S.tab===id),'aria-controls':'cat-panel',class:S.tab===id?'active':'',onclick:()=>{S.tab=id;render();S.root?.querySelector('#cat-tab-'+id)?.focus?.();}},label)));
}
function withError(node,error){
  if(!error)return node;
  const control=node.querySelector('input,select,textarea');
  control?.setAttribute('aria-invalid','true');
  node.append(h('small',{class:'cat-error'},error));
  return node;
}
// A kit field bound to values[name]; checkbox groups store arrays.
function bound(spec,values,errors={},onChange){
  if(spec.type==='checkboxes'){
    const chosen=new Set(values[spec.name]||[]);
    return h('fieldset',{class:'cat-checks'+(errors[spec.name]?' invalid':'')},h('legend',{},spec.label),spec.help?h('small',{},spec.help):null,
      spec.options.map(option=>{const box=h('input',{type:'checkbox',name:spec.name,value:option.value,checked:chosen.has(option.value),onchange:event=>{if(event.target.checked)chosen.add(option.value);else chosen.delete(option.value);values[spec.name]=[...chosen];onChange?.();}});return h('label',{class:'hub-check'},box,h('span',{},option.label));}),
      errors[spec.name]?h('small',{class:'cat-error'},errors[spec.name]):null);
  }
  const node=S.kit.field({...spec,value:values[spec.name]}),control=node.querySelector('input,select,textarea');
  const read=()=>{values[spec.name]=spec.type==='checkbox'?control.checked:control.value;onChange?.();};
  control.addEventListener(spec.type==='checkbox'||spec.type==='select'?'change':'input',read);
  if(spec.type!=='checkbox'&&spec.type!=='select')control.addEventListener('change',read);
  return withError(node,errors[spec.name]);
}
function settingsPanel(){
  if(!S.settingsForm||!S.settingsValues)syncSettings();
  const values=S.data.settings.values,form=S.settingsForm,errors=S.settingsErrors,frozen=locked()||!canSettings();
  const review=btn('Review changes',openSettingsReview,'primary',{disabled:true});
  let sticky;
  const update=()=>{const dirty=settingsDirty();review.disabled=frozen||!dirty;sticky?.classList.toggle('cat-idle',!dirty);persist();};
  const money=MONEY_SETTINGS.map(([key,label,,,help])=>bound({name:key,label:label+' ($)',type:'text',inputmode:'decimal',autocomplete:'off',help},form,errors,update));
  const fields=[...money,bound({name:'depositPct',label:'Deposit (% of the quote)',type:'text',inputmode:'decimal',autocomplete:'off',help:'Catalog quotes only. The walkthrough deposit in use today (50%, set by the deposit terms) does not change here.'},form,errors,update),
    bound({name:'includeDisposal',label:'Charge packaging haul-away',type:'checkbox'},form,errors,update),
    bound({name:'roundingRule',label:'Cent rounding',type:'select',options:Object.entries(ROUNDING).map(([value,label])=>({value,label}))},form,errors,update)];
  const markups=[bound({name:'markup.default',label:'Default markup (%)',type:'text',inputmode:'decimal',autocomplete:'off',help:'Used by any category left blank.'},form,errors,update),
    ...PRODUCT_CATEGORIES.map(category=>bound({name:'markup.'+category,label:(S.base.categories.find(entry=>entry.id===category)?.label||category)+' (%)',type:'text',inputmode:'decimal',autocomplete:'off',placeholder:'Default'},form,errors,update))];
  const saved=S.data.settings;
  sticky=h('div',{class:'cat-sticky'},review,btn('Undo my edits',()=>{S.settingsForm=null;S.settingsErrors={};syncSettings();persist();render();},'',{disabled:frozen}));
  const panel=h('form',{class:'cat-settings',novalidate:true,onsubmit:event=>{event.preventDefault();openSettingsReview();}},
    saved.readyForCustomers?h('div',{class:'hub-notice success'},'These prices are approved for catalog quotes. Existing walkthrough prices are managed separately.'):h('div',{class:'hub-notice warning'},'Placeholder values: these settings price internal estimates only until you review every value and approve them for catalog quotes. Existing walkthrough prices are managed separately.'),
    S.settingsRebased?h('div',{class:'hub-notice warning'},'The saved settings changed after you started editing. Fields you did not change now show the latest saved values; the review compares your edits with them.'):null,
    !canSettings()?h('div',{class:'hub-notice'},'Only the owner can change pricing settings.'):null,
    h('section',{class:'hub-card cat-card'},h('h2',{},'Rates and charges'),h('div',{class:'cat-fields'},fields)),
    h('section',{class:'hub-card cat-card'},h('h2',{},'Markup on product cost'),h('p',{class:'cat-muted'},'Added to the product cost of every catalog item in the category.'),h('div',{class:'cat-fields cat-markups'},markups)),
    h('section',{class:'hub-card cat-card'},h('h2',{},'Version and release'),h('div',{class:'cat-fields'},
      bound({name:'settingsVersion',label:'Version label for this save',type:'text',autocomplete:'off',maxlength:80,help:`Every catalog quote records the label that priced it. Saved now: ${saved.settingsVersion}.`},form,errors,update),
      bound({name:'ready',label:'Reviewed: these values may price catalog quotes',type:'checkbox',help:'Leave off to keep them for internal estimates only.'},form,errors,update)),
      h('p',{class:'cat-muted'},saved.source==='defaults'?'No settings have been saved yet; the shipped placeholders are in use.':`Last saved ${when(saved.updatedAt)}${saved.updatedBy?' by '+saved.updatedBy:''}.`)),
    sticky,
    opsDefaults());
  if(frozen)for(const control of panel.querySelectorAll('input,select,textarea'))control.disabled=true;
  update();
  return panel;
}
function opsDefaults(){
  const go=S.ctx?.go,link=(label,view)=>typeof go==='function'?btn(label,()=>go(view)):h('a',{class:'hub-btn',href:'/employee.html?view='+view},label);
  return h('section',{class:'hub-card cat-card'},h('h2',{},'Operations defaults'),
    h('p',{class:'cat-muted'},'Travel buffer and arrival window defaults belong to dispatch, the follow-up owner to the Action Center follow-up policy, and reminder wording to the owner-approved message templates. None is stored with prices, so each default has one home.'),
    h('div',{class:'hub-actions'},link('Open Team schedule','schedule'),link('Open Action Center','action_center'),h('a',{class:'hub-btn',href:'/message-templates.html'},'Open message templates')));
}
function when(value){const at=Date.parse(value||'');return Number.isFinite(at)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(at)):'—';}
function badge(status){
  const label={stale:'Stale',unverified:'Unverified',verified:'Verified'}[status.state];
  return h('span',{class:'cat-badges'},h('span',{class:'cat-badge '+status.state},label),status.draft?h('span',{class:'cat-badge draft'},'Draft'):null);
}
function verifiedText(row){
  const {item,status}=row;
  if(status.state==='unverified')return item.priceEvidence==='estimate'?'Estimate, never checked':'Unconfirmed, never checked';
  return`Checked ${dateLabel(item.priceVerifiedAt)} · ${ageText(status.age)}`;
}
function itemRow(row,frozen=locked()){
  const {item}=row,[low,high]=priceRange(item),source=latestSource(item),editable=canEdit();
  const sell=row.draft?'Sell price updates when published':row.price?.quotable?`Sells for ${money(row.price.unitCents)}`:row.price?`Not quotable (${AVAILABILITY[row.price.reason]||row.price.reason})`:'';
  const chips=[item.tier?h('span',{class:'cat-chip'},item.tier):null,item.availability!=='active'?h('span',{class:'cat-chip'},AVAILABILITY[item.availability]):null,row.added?h('span',{class:'cat-chip new'},'New'):row.draft?h('span',{class:'cat-chip new'},'In draft'):null];
  return h('tr',{'data-item':item.id},
    h('td',{class:'cat-item-cell'},h('strong',{},item.name),h('span',{class:'cat-meta'},[item.brand,item.model].filter(Boolean).join(' · ')||(item.kind==='service'?'EGC service':'')),item.dimensions?h('span',{class:'cat-meta'},item.dimensions):null,h('span',{class:'cat-chips'},chips)),
    h('td',{'data-label':'Price'},h('span',{},low===high?money(low):`${money(low)} – ${money(high)}`),h('span',{class:'cat-meta'},unitText(item.priceUnit)),sell?h('span',{class:'cat-meta'},sell):null),
    h('td',{'data-label':'Source'},source?[h('span',{},source.retailer),h('span',{class:'cat-meta'},`${EVIDENCE[item.priceEvidence]||item.priceEvidence} · checked ${dateLabel(source.checkedOn)}`)]:h('span',{class:'cat-meta'},'No source yet')),
    h('td',{'data-label':'Verified','data-state':row.status.state},badge(row.status),h('span',{class:'cat-meta'},verifiedText(row))),
    h('td',{class:'cat-row-actions','data-label':'Actions'},editable?[btn(item.kind==='service'?'Confirm price':'Verify price',()=>openVerify(item.id),'',{'aria-label':`${item.kind==='service'?'Confirm price':'Verify price'}: ${item.name}`,disabled:frozen}),item.kind==='product'?btn('Edit',()=>openEdit(item.id),'',{'aria-label':`Edit ${item.name}`,disabled:frozen}):null]:h('span',{class:'cat-meta'},'Read only')));
}
function filteredRows(){
  const f=S.filters,filters={...f,min:trimmed(f.min)?centsOf(f.min):null,max:trimmed(f.max)?centsOf(f.max):null};
  return rows().filter(row=>matchesFilters(row,filters));
}
function itemList(){
  const all=rows(),found=filteredRows(),shown=found.slice(0,S.shown),frozen=locked();
  const attention=all.filter(row=>row.status.state!=='verified').length;
  return h('div',{class:'cat-list'},
    h('p',{class:'cat-count',role:'status'},`Showing ${shown.length} of ${found.length}${found.length!==all.length?` (${all.length} in the catalog)`:''} · ${attention} prices need a check`),
    found.length?h('div',{class:'cat-table-wrap'},h('table',{class:'cat-table'},h('thead',{},h('tr',{},['Item','Price','Source','Price verified',''].map(text=>h('th',{scope:'col'},text)))),h('tbody',{},shown.map(row=>itemRow(row,frozen))))):h('p',{class:'hub-notice'},'No items match these filters.'),
    found.length>shown.length?btn(`Show ${Math.min(PAGE,found.length-shown.length)} more`,()=>{S.shown+=PAGE;refreshList();},'cat-more'):null);
}
function refreshList(){const box=S.root?.querySelector('.cat-list');if(box)box.replaceWith(itemList());}
function itemsPanel(){
  const f=S.filters,change=()=>{S.shown=PAGE;refreshList();};
  const list=rows(),attention=list.filter(row=>row.status.state!=='verified').length;
  const on=['status','category','tier','min','max'].filter(key=>trimmed(f[key])).length;
  if(S.filtersOpen==null)S.filtersOpen=typeof matchMedia==='function'&&matchMedia('(min-width: 681px)').matches;
  const filters=h('div',{class:'cat-filters'},
    bound({name:'q',label:'Search',type:'search',placeholder:'Name, brand, model or size',autocomplete:'off'},f,{},change),
    h('details',{class:'cat-filter-more',open:S.filtersOpen||null,ontoggle:event=>{S.filtersOpen=event.target.open;}},h('summary',{},on?`Filters (${on} on)`:'Filters'),h('div',{class:'cat-filter-grid'},
    bound({name:'status',label:'Price status',type:'select',options:[{value:'',label:'All prices'},{value:'attention',label:'Needs a check (stale or unverified)'},{value:'stale',label:'Stale'},{value:'unverified',label:'Unverified'},{value:'verified',label:'Verified'},{value:'draft',label:'In my draft'}]},f,{},change),
    bound({name:'category',label:'Category',type:'select',options:[{value:'',label:'All categories'},...S.base.categories.map(entry=>({value:entry.id,label:entry.label}))]},f,{},change),
    bound({name:'tier',label:'Tier',type:'select',options:[{value:'',label:'Good, better and best'},...TIERS.map(tier=>({value:tier,label:tier[0].toUpperCase()+tier.slice(1)}))]},f,{},change),
    bound({name:'min',label:'Price from ($)',type:'text',inputmode:'decimal',autocomplete:'off',placeholder:'0'},f,{},change),
    bound({name:'max',label:'Price up to ($)',type:'text',inputmode:'decimal',autocomplete:'off',placeholder:'Any'},f,{},change))));
  const checking=f.status==='attention';
  const canQuote=canEdit()&&S.data.settings?.readyForCustomers===true;
  return h('div',{class:'cat-items'},
    h('div',{class:'hub-actions cat-toolbar'},canEdit()?btn('Add product',openAdd,'primary',{disabled:locked()}):null,attention||checking?btn(checking?'Show all prices':`Needs a check (${attention})`,()=>{S.filters.status=checking?'':'attention';S.shown=PAGE;render();}):null,
      canEdit()?btn(S.quoteLoading?'Opening catalog quote…':'Build catalog quote',()=>void buildCatalogQuote(),'cat-quote-btn',{disabled:locked()||!canQuote}):null),
    canEdit()?h('div',{class:'hub-notice'+(canQuote?'':' warning')},canQuote?
      'Build an unsigned catalog quote from approved prices. You review it before anything is sent. Existing walkthrough prices are managed separately.':
      'Review and approve Pricing before building a catalog quote. Existing walkthrough prices are managed separately.',
      canQuote?null:btn('Review pricing',()=>{S.tab='settings';render();S.root?.querySelector('#cat-tab-settings')?.focus?.();},'',{disabled:locked()})):null,
    filters,itemList());
}
function changeKind(id){
  const item=S.draft.items[id],base=S.base.items.find(entry=>entry.id===id);
  if(!base)return'New product';
  if(item.priceVerifiedAt!==base.priceVerifiedAt&&item.priceVerified)return'Price checked';
  if(item.priceVerified!==base.priceVerified)return'Price changed to an estimate';
  return'Details edited';
}
function draftPanel(){
  const ids=Object.keys(S.draft.items),base=S.data.publication.version,frozen=locked();
  if(!ids.length)return h('div',{class:'cat-draft'},h('p',{class:'hub-notice'},'No unpublished changes. Verify, edit or add items to start a draft; it stays on this device until you publish or discard it.'));
  return h('div',{class:'cat-draft'},
    S.draft.rebasedFrom?h('div',{class:'hub-notice warning'},`This draft started from version ${S.draft.rebasedFrom}; version ${base} is published now. Your changes were moved onto ${base}: fields you did not change show its values, and the review compares your draft with it.`):null,
    h('ul',{class:'cat-changes'},ids.map(id=>{const item=S.draft.items[id];return h('li',{},h('div',{},h('strong',{},item.name),h('span',{class:'cat-meta'},changeKind(id))),
      h('div',{class:'hub-actions'},item.kind==='product'?btn('Edit',()=>openEdit(id),'',{'aria-label':`Edit ${item.name}`,disabled:frozen||!canEdit()}):null,btn('Undo',()=>undoItem(id),'',{'aria-label':`Undo changes to ${item.name}`,disabled:frozen})));})),
    h('div',{class:'cat-sticky'},btn('Review & publish',openPublishReview,'primary',{disabled:frozen||!canEdit()}),btn('Discard draft',confirmDiscard,'danger',{disabled:frozen})));
}
function panel(){
  const body=S.tab==='items'?itemsPanel():S.tab==='draft'?draftPanel():settingsPanel();
  return h('div',{id:'cat-panel',role:'tabpanel','aria-labelledby':'cat-tab-'+S.tab,class:'cat-panel'},body);
}
function skeleton(){return h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading the catalog…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}));}
function unavailable(){
  const error=S.loadError,status=Number(error?.status||0);
  const text=status===403?'Only the owner can manage the pricing catalog.':status===401?'Your sign-in expired. Sign in again, then retry.':S.kit.errorText(error);
  return h('div',{class:'hub-notice error',role:'alert'},h('strong',{},'The catalog is unavailable'),h('p',{},`${text} Nothing here is shown as current until it loads.`),status===403?null:h('div',{class:'hub-actions'},btn('Retry',()=>void load(),'primary')));
}
function render(){
  if(!S.root)return;
  S.list=null;
  const parts=[head(),feedback()];
  if(S.data?.enabled&&S.base)parts.push(tabs(),panel());
  else if(S.data&&!S.data.enabled)parts.push(h('div',{class:'hub-notice warning'},h('strong',{},'Catalog pricing is turned off'),h('p',{},'Ask the owner to enable catalog pricing for the Hub. Items and settings will appear here when it is ready.')));
  else if(S.loading)parts.push(skeleton());
  else if(S.loadError)parts.push(unavailable());
  const focused=document.activeElement&&S.root.contains(document.activeElement)?document.activeElement.id:'';
  S.root.replaceChildren(...parts);
  if(focused&&/^cat-tab-/.test(focused))S.root.querySelector('#'+focused)?.focus?.();
}

// ---- Dialogs ----
function closeDialog(){const open=S.dialog;S.dialog=null;if(!open)return;try{open.node.close?.();}catch{}open.node.remove();try{open.opener?.focus?.();}catch{}}
function openDialog({eyebrow,title,body,actions,onSubmit}){
  closeDialog();
  const opener=document.activeElement,content=h('form',{class:'hub-dialog-body',novalidate:true,onsubmit:event=>{event.preventDefault();onSubmit?.();}});
  const node=h('dialog',{class:'hub-dialog cat-dialog','aria-labelledby':'cat-dialog-title',oncancel:event=>{event.preventDefault();if(!S.busy)closeDialog();}},
    h('header',{},h('div',{},h('span',{class:'hub-eyebrow'},eyebrow),h('h2',{id:'cat-dialog-title'},title)),btn('Close',()=>{if(!S.busy)closeDialog();},'quiet')),
    content,h('footer',{},actions));
  const set=children=>{content.replaceChildren(...[children].flat(Infinity).filter(Boolean));};
  set(body);
  S.dialog={node,opener,set};
  (S.root?.ownerDocument||document).body.append(node);
  if(typeof node.showModal==='function')try{node.showModal();}catch{node.setAttribute('open','');}else node.setAttribute('open','');
  return S.dialog;
}
function focusInvalid(){const node=S.dialog?.node.querySelector('[aria-invalid="true"]')||S.dialog?.node.querySelector('.cat-checks.invalid input');node?.focus?.();}
function currentItem(id){return S.draft.items[id]||S.base.items.find(item=>item.id===id)||null;}
// A draft entry remembers the published item it was built from, so a newer publish can be merged field by field.
function putDraft(item,added=false){
  const base=S.base.items.find(entry=>entry.id===item.id);
  if(base&&same(base,item)){delete S.draft.items[item.id];delete S.draft.bases[item.id];}
  else{if(!Object.hasOwn(S.draft.items,item.id))S.draft.bases[item.id]=base?clone(base):null;S.draft.items[item.id]=item;if(added&&!S.draft.added.includes(item.id))S.draft.added.push(item.id);}
  S.draft.added=S.draft.added.filter(id=>Object.hasOwn(S.draft.items,id));
  if(!draftCount())S.draft=emptyDraft();else if(!S.draft.baseVersion)S.draft.baseVersion=S.data.publication.version;
  persist();
}
function undoItem(id){
  if(locked())return;
  delete S.draft.items[id];delete S.draft.bases[id];S.draft.added=S.draft.added.filter(entry=>entry!==id);
  if(!draftCount())S.draft=emptyDraft();
  persist();render();
}
function sourceFields(values,errors,{sourceOptional=false}={}){
  const day=today();
  return[bound({name:'retailer',label:'Store'+(sourceOptional?' (optional)':''),type:'text',autocomplete:'off',maxlength:200,placeholder:'The Home Depot'},values,errors),
    bound({name:'url',label:'Product page link'+(sourceOptional?' (optional)':''),type:'url',autocomplete:'off',placeholder:'https://'},values,errors),
    bound({name:'evidence',label:'Where you saw the price',type:'select',options:[{value:'product_page',label:'On the live product page'},{value:'search_snippet',label:'In a search result for this product'}]},values,errors),
    bound({name:'checkedOn',label:'Checked on',type:'date',max:day},values,errors)];
}
function priceFields(values,errors){
  return[bound({name:'low',label:'Price seen ($)',type:'text',inputmode:'decimal',autocomplete:'off',help:'The lowest current price for one unit.'},values,errors),
    bound({name:'high',label:'Highest price seen ($)',type:'text',inputmode:'decimal',autocomplete:'off',help:'Leave blank for a single price. The engine prices from this one.'},values,errors)];
}
function openVerify(id){
  const item=currentItem(id);
  if(!item||!canEdit()||locked())return;
  const service=item.kind==='service',day=today(),source=latestSource(item);
  // Prices start blank: the owner types what the store shows now (the current range is shown above the fields).
  const values=service?{checkedOn:day,note:''}:{retailer:source?.retailer||'',url:source?.url||'',evidence:VERIFIED_EVIDENCE.includes(item.priceEvidence)?item.priceEvidence:'product_page',low:'',high:'',checkedOn:day,note:''};
  let errors={};
  const body=()=>[h('p',{class:'cat-muted'},service?`${item.name} is priced ${money(item.fixedPriceCents)} ${unitText(item.priceUnit)} by the walkthrough price list. Confirm the price list still applies.`:`Now ${priceRange(item)[0]===priceRange(item)[1]?money(priceRange(item)[0]):`${money(priceRange(item)[0])} – ${money(priceRange(item)[1])}`} ${unitText(item.priceUnit)} · ${item.priceVerified?`checked ${dateLabel(item.priceVerifiedAt)}`:'never checked'}.`),
    service?bound({name:'checkedOn',label:'Confirmed on',type:'date',max:day},values,errors):[...sourceFields(values,errors),...priceFields(values,errors)],
    bound({name:'note',label:'Note (optional)',type:'textarea',rows:3,maxlength:2000},values,errors)];
  const save=()=>{
    const result=verifyItem(item,values,today());
    if(result.errors){errors=result.errors;dialog.set(body());focusInvalid();return;}
    putDraft(result.item);closeDialog();
    S.notice={kind:'success',text:`${item.name}: price check saved to your draft. Publish the draft to make it current.`};render();
  };
  const dialog=openDialog({eyebrow:service?'Confirm price':'Verify price',title:item.name,body:body(),onSubmit:save,actions:[btn('Cancel',closeDialog),btn('Save to draft',save,'primary')]});
}
function detailSpecs(item){
  return[{name:'name',label:'Name',type:'text',maxlength:160},{name:'brand',label:'Brand',type:'text',maxlength:600},{name:'model',label:'Model (optional)',type:'text',maxlength:1000},
    {name:'dimensions',label:'Dimensions (optional)',type:'text',maxlength:1000},{name:'weightCapacity',label:'Weight capacity (optional)',type:'text',maxlength:1000},
    {name:'tier',label:'Tier',type:'select',options:TIERS.map(tier=>({value:tier,label:tier[0].toUpperCase()+tier.slice(1)}))},
    {name:'availability',label:'Offered as',type:'select',options:Object.entries(AVAILABILITY).map(([value,label])=>({value,label})),help:'Referral-only items carry no install time or haul-away; hidden items are never quoted.'},
    {name:'priceUnit',label:'Price unit',type:'text',maxlength:120,help:'each, per 4-pack, per 48 sq ft kit'},
    {name:'installMinutes',label:'Install technician-minutes per unit',type:'number',min:0,max:1440,step:1},
    {name:'crewSize',label:'Crew size',type:'select',options:[1,2,3,4].map(size=>({value:String(size),label:size===1?'1 person':`${size} people`}))},
    {name:'haulAwayApplicable',label:'Packaging haul-away applies',type:'checkbox'},
    {name:'safetyNotes',label:'Safety notes',type:'textarea',rows:3,maxlength:2000,help:item?.installRequirements?.some(entry=>entry==='ceiling-joists'||entry==='two-person-lift')?'Overhead or heavy: name the joists, studs, anchors or two-person lift (80+ characters).':'At least 40 characters.'}];
}
function openEdit(id){
  const item=currentItem(id);
  if(!item||item.kind!=='product'||!canEdit()||locked())return;
  const values={name:item.name,brand:item.brand,model:item.model||'',dimensions:item.dimensions||'',weightCapacity:item.weightCapacity||'',tier:item.tier,availability:item.availability,priceUnit:item.priceUnit,installMinutes:String(item.installMinutes),crewSize:String(item.crewSize),haulAwayApplicable:item.haulAwayApplicable,safetyNotes:item.safetyNotes,
    low:dollars(item.retailPriceLowCents),high:item.retailPriceHighCents===item.retailPriceLowCents?'':dollars(item.retailPriceHighCents),verificationNote:item.verificationNote||'',verificationNoteBefore:item.verificationNote||''};
  let errors={};
  const body=()=>[...detailSpecs(item).map(spec=>bound(spec,values,errors)),h('div',{class:'cat-fields'},priceFields(values,errors)),
    h('p',{class:'cat-muted'},'A price changed here becomes an owner estimate until it is verified against a store. Use Verify price to record where you saw it.'),
    bound({name:'verificationNote',label:'Verification note',type:'textarea',rows:3,maxlength:2000,help:'Required while the price is unverified: where the estimate came from.'},values,errors)];
  const save=()=>{
    const result=editItem(item,values,today());
    if(result.errors){errors=result.errors;dialog.set(body());focusInvalid();return;}
    putDraft(result.item,Boolean(S.draft.added.includes(id)));closeDialog();
    S.notice={kind:'success',text:`${result.item.name}: changes saved to your draft.`};render();
  };
  const dialog=openDialog({eyebrow:'Edit item',title:item.name,body:body(),onSubmit:save,actions:[btn('Cancel',closeDialog),btn('Save to draft',save,'primary')]});
}
function openAdd(){
  if(!canEdit()||locked())return;
  const values={name:'',category:'',subcategory:'',needs:[],zones:[],brand:'',model:'',genericSpec:'',dimensions:'',weightCapacity:'',requires:'',installRequirements:[],tier:'good',availability:'active',priceUnit:'each',installMinutes:'0',crewSize:'1',haulAwayApplicable:false,
    low:'',high:'',bestFor:'',safetyNotes:'',installNotes:'',retailer:'',url:'',evidence:'product_page',checkedOn:today(),verificationNote:''};
  let errors={};
  const body=()=>{
    const needs=S.base.needs.filter(need=>!values.category||need.category===values.category);
    return[bound({name:'name',label:'Name',type:'text',maxlength:160},values,errors),
      bound({name:'category',label:'Category',type:'select',options:[{value:'',label:'Choose a category'},...S.base.categories.filter(entry=>entry.kind==='product').map(entry=>({value:entry.id,label:entry.label}))]},values,errors,()=>{values.needs=[];dialog.set(body());}),
      bound({name:'subcategory',label:'Subcategory',type:'text',maxlength:120,placeholder:'wall shelving kits'},values,errors),
      values.category?bound({name:'needs',label:'Needs it answers',type:'checkboxes',options:needs.map(need=>({value:need.id,label:need.label}))},values,errors):h('p',{class:'cat-muted'},'Choose a category to pick the needs it answers.'),
      bound({name:'zones',label:'Garage zones',type:'checkboxes',options:S.base.zones.map(zone=>({value:zone.id,label:zone.label}))},values,errors),
      bound({name:'genericSpec',label:'What it is (generic description)',type:'textarea',rows:2,maxlength:600},values,errors),
      bound({name:'bestFor',label:'Best for',type:'text',maxlength:600},values,errors),
      bound({name:'installRequirements',label:'Install requirements',type:'checkboxes',options:Object.entries(REQUIREMENTS).map(([value,label])=>({value,label}))},values,errors),
      ...detailSpecs({installRequirements:values.installRequirements}).filter(spec=>spec.name!=='name').map(spec=>bound(spec,values,errors)),
      bound({name:'requires',label:'Also requires (optional)',type:'text',maxlength:1000},values,errors),
      bound({name:'installNotes',label:'Install notes (optional)',type:'textarea',rows:2,maxlength:1000},values,errors),
      h('div',{class:'cat-fields'},priceFields(values,errors)),
      h('h3',{class:'cat-subhead'},'Where the price came from'),
      h('p',{class:'cat-muted'},'Add the store and link to record a verified price, or leave them blank and explain the estimate.'),
      ...sourceFields(values,errors,{sourceOptional:true}),
      bound({name:'verificationNote',label:'Verification note',type:'textarea',rows:3,maxlength:2000,help:'Required without a store source.'},values,errors)];
  };
  const save=()=>{
    const result=newProduct(values,S.base,today(),Object.keys(S.draft.items));
    if(result.errors){errors=result.errors;dialog.set(body());focusInvalid();return;}
    putDraft(result.item,true);closeDialog();S.tab='draft';
    S.notice={kind:'success',text:`${result.item.name} added to your draft as ${result.item.id}.`};render();
  };
  const dialog=openDialog({eyebrow:'Add a product',title:'New catalog product',body:body(),onSubmit:save,actions:[btn('Cancel',closeDialog),btn('Add to draft',save,'primary')]});
}
function diffList(diff,coverage){
  const field=entry=>h('div',{class:'cat-diff-row'},h('dt',{},FIELD_LABEL[entry.field]||entry.field),h('dd',{},h('del',{},formatValue(entry.field,entry.before)),h('span',{'aria-hidden':'true'},' → '),h('ins',{},formatValue(entry.field,entry.after))));
  return[
    diff.added.length?h('section',{},h('h3',{class:'cat-subhead'},`New items (${diff.added.length})`),h('ul',{class:'cat-diff-list'},diff.added.map(entry=>h('li',{},h('strong',{},entry.name),h('span',{class:'cat-meta'},entry.id))))):null,
    diff.changed.length?h('section',{},h('h3',{class:'cat-subhead'},`Changed items (${diff.changed.length})`),diff.changed.map(entry=>h('article',{class:'cat-diff-item'},h('h4',{},entry.name),h('dl',{},entry.fields.map(field))))):null,
    coverage.length?h('section',{},h('h3',{class:'cat-subhead'},'Need coverage'),h('ul',{class:'cat-diff-list'},coverage.map(entry=>h('li',{},`${entry.label}: ${entry.before} → ${entry.after}`)))):null];
}
function openPublishReview(){
  if(!draftCount()||locked()||!canEdit())return;
  const built=draftCatalog(S.base,S.draft,today());
  if(built.error){S.notice={kind:'error',text:built.error};render();return;}
  const diff=catalogDiff(S.base,built.catalog);
  if(!diff.added.length&&!diff.changed.length){S.notice={kind:'error',text:'Your draft matches the published catalog; there is nothing to publish.'};render();return;}
  const publish=()=>{closeDialog();void send({action:'catalog.publish',requestId:S.kit.requestId(),basedOnVersion:S.data.publication.version,catalog:built.catalog});};
  openDialog({eyebrow:'Review & publish',title:`Publish version ${built.version}`,onSubmit:publish,
    body:[h('p',{},`Replaces version ${diff.from} for every new catalog price. ${diff.added.length} new and ${diff.changed.length} changed items. Publishing does not message any customer.`),...diffList(diff,built.coverage)],
    actions:[btn('Keep editing',closeDialog),btn(`Publish version ${built.version}`,publish,'primary')]});
}
function openSettingsReview(){
  if(locked()||!canSettings())return;
  const current=S.data.settings.values,parsed=parseSettings(S.settingsForm,current);
  S.settingsErrors=parsed.errors;
  if(Object.keys(parsed.errors).length){S.tab='settings';render();S.root?.querySelector('.cat-settings [aria-invalid="true"]')?.focus?.();return;}
  const changes=settingsChanges(current,parsed.settings,Object.fromEntries(S.base.categories.map(entry=>[entry.id,entry.label])));
  if(!changes.some(row=>row.label!=='Version label')){S.notice={kind:'warning',text:'Nothing to save: every value matches the saved settings.'};render();return;}
  const releasing=parsed.settings.mustSetBeforeCustomerUse===false&&current.mustSetBeforeCustomerUse!==false,confirm={release:false};
  const save=()=>{
    if(releasing&&!confirm.release){dialog.set(body(true));focusInvalid();return;}
    closeDialog();
    void send({action:'settings.update',requestId:S.kit.requestId(),expectedRevision:S.data.settings.revision,settings:parsed.settings,...(releasing?{confirmCustomerUse:true}:{})});
  };
  const body=(missing=false)=>[h('div',{class:'cat-diff-table'},h('table',{},h('thead',{},h('tr',{},['Setting','Now','After saving'].map(text=>h('th',{scope:'col'},text)))),h('tbody',{},changes.map(row=>h('tr',{},h('th',{scope:'row'},row.label),h('td',{},row.before),h('td',{},h('strong',{},row.after))))))),
    releasing?h('div',{class:'hub-notice warning'},'Saving approves these prices for catalog quotes. Existing walkthrough prices are managed separately. Nothing is sent to any customer by saving.'):null,
    releasing?bound({name:'release',label:'I reviewed every value and these prices may be used for catalog quotes',type:'checkbox'},confirm,missing?{release:'Confirm the review to approve these prices.'}:{}):null];
  const dialog=openDialog({eyebrow:'Review settings',title:`Save pricing settings ${parsed.settings.settingsVersion}`,body:body(),onSubmit:save,actions:[btn('Keep editing',closeDialog),btn('Save settings',save,'primary')]});
}
function confirmDiscard(){
  if(locked())return;
  const discard=()=>{S.draft=emptyDraft();persist();closeDialog();S.notice={kind:'success',text:'Draft discarded. The published catalog is unchanged.'};render();};
  openDialog({eyebrow:'Discard draft',title:`Discard ${draftCount()} unpublished change${draftCount()===1?'':'s'}?`,onSubmit:discard,body:h('p',{},'The published catalog stays as it is. This cannot be undone.'),actions:[btn('Keep the draft',closeDialog),btn('Discard draft',discard,'danger')]});
}

// ---- Lifecycle ----
function mount(host,ctx={}){
  if(!host)return;
  if(!window.EGCHubKit)throw new Error('The Hub UI kit is required.');
  if(S.host===host&&S.root?.isConnected)return;
  unmount();
  S.kit=window.EGCHubKit;S.ctx=ctx||{};S.host=host;S.mountId++;
  S.root=S.kit.h('section',{class:'hub-screen egc-catalog','aria-label':'Catalog and pricing'});
  host.replaceChildren(S.root);
  try{const saved=pendingStore().get();if(saved?.body&&['settings.update','catalog.publish'].includes(saved.body.action))S.retry=saved.body;}catch{}
  render();
  void load();
}
function unmount(){
  S.generation++;S.mountId++;S.controller?.abort();S.controller=null;closeDialog();S.root?.remove();
  Object.assign(S,{root:null,host:null,data:null,base:null,loading:false,loadError:null,busy:false,quoteLoading:false,notice:null,conflict:null,retry:null,list:null,settingsErrors:{}});
}
function reset(){
  unmount();
  try{for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(String(key||'').startsWith(DRAFT_KEY))sessionStorage.removeItem(key);}}catch{}
  Object.assign(S,{draft:emptyDraft(),draftLoaded:false,settingsForm:null,settingsValues:null,settingsRevision:null,settingsRebased:false,tab:'settings',filters:{q:'',category:'',tier:'',status:'',availability:'',min:'',max:''},filtersOpen:null,shown:PAGE,ctx:null});
}
window.addEventListener('egc:signout',reset);
window.EGCCatalog=Object.freeze({mount,unmount,refresh:()=>load(),canLeave:()=>!S.busy,
  model:Object.freeze({nextVersion,priceStatus,matchesFilters,settingsForm,parseSettings,settingsChanges,rebaseSettingsForm,settingsAfterSave,verifyItem,editItem,newProduct,uniqueId,draftCatalog,catalogDiff,applyCoverage,rebaseItem,rebaseDraft,publishedDraft,formatValue,centsOf,percentOf,denverDay,dayCount})});
})();
