import { sha256 } from '@noble/hashes/sha2.js';
import { requireQuoteAuthor } from './quote-permissions.js';
import { estimateFingerprint } from './quote-model.js';
import { stripCrewMoneyDeep } from './crew-money.js';
import { prepareWalkthroughCaptureSync } from './walkthrough-capture-sync.js';
import { jobCustomerAccess } from './estimator-customer-access.js';
const COLLECTION = 'quoteDraftOperations';
const TEXT = ['customerName','phone','address','serviceType','scopeSummary','sortMethod','garageSize','fullness','loadEstimate','shelfType','keepItems','removeItems','donateItems','exclusions','hazardPlan','damageNotes','accessNotes','parkingNotes','measurements','equipment','photoUnavailableReason','customerQuestions','pricingStatus','pricingReviewNote','quoteJobId','handoffNotes'];
const BOOL = ['customerConfirmed','addressConfirmed','accessReviewed','boundariesReviewed','decisionsReviewed','hazardsReviewed','damageReviewed','measurementsReviewed','measurementsNeeded','equipmentReviewed','questionsReviewed','pricingReviewed'];
const NUM = { crewSize: [1,20], estimatedDurationMin:[15,1440], shelfQty:[0,999], toteQty:[0,999] };
const LIST = ['hazards','finish','specialItems'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const fail = (code,message,status=409,details) => Object.assign(new Error(message),{code:'walkthrough_review_'+code,message,status,details});
const digest = value => [...sha256(new TextEncoder().encode(JSON.stringify(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export function normalizeWalkthroughReview(value) {
  if(!plain(value))throw fail('invalid','The capture must be an object.',400);
  const out={};
  for(const [key,item] of Object.entries(value)) {
    if(TEXT.includes(key)){if(typeof item!=='string'||item.length>4000)throw fail('invalid',`${key} must be text of at most 4,000 characters.`,400);out[key]=item.trim();}
    else if(BOOL.includes(key)){if(typeof item!=='boolean')throw fail('invalid',`${key} must be explicitly checked or unchecked.`,400);out[key]=item;}
    else if(NUM[key]){if(item!==null&&(!Number.isInteger(item)||item<NUM[key][0]||item>NUM[key][1]))throw fail('invalid',`${key} is outside its supported range.`,400);out[key]=item;}
    else if(LIST.includes(key)){if(!Array.isArray(item)||item.length>30||item.some(x=>typeof x!=='string'||!x.trim()||x.length>200))throw fail('invalid',`${key} must be a list of short labels.`,400);out[key]=[...new Set(item.map(x=>x.trim()))];}
    else throw fail('invalid',`Unsupported capture field: ${key}.`,400);
  }
  if(out.serviceType&&!['garage_cleanout','junk_removal','organization','cleaning','other'].includes(out.serviceType))throw fail('invalid','Choose a supported service.',400);
  if(out.pricingStatus&&!['quote_saved','needs_quote'].includes(out.pricingStatus))throw fail('invalid','Choose the pricing review status.',400);
  if(out.quoteJobId&&!id(out.quoteJobId))throw fail('invalid','Choose a valid saved quote.',400);
  return out;
}
export function walkthroughReviewGaps(data,{verifiedPhotos=0,quote=null,customer,job}={}) {
  const gaps=[];const need=(ok,field,message)=>{if(!ok)gaps.push({field,message});};
  for(const [key,label] of [['customerName','customer name'],['address','service address'],['serviceType','service type'],['scopeSummary','service scope'],['exclusions','exclusions (or explicitly “None”)']])need(Boolean(data[key]),key,`Record ${label}.`);
  const same=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  if(customer!==undefined){need(Boolean(customer),'customerName','Link the canonical Hub customer before finalizing.');if(customer?.name)need(same(customer.name)===same(data.customerName),'customerName','Customer name differs from the linked record; correct the link or record first.');const address=job?.address||customer?.address;if(address)need(same(address)===same(data.address),'address','Service address differs from the linked job/customer; correct the record first.');}
  for(const [key,label] of [['customerConfirmed','customer identity'],['addressConfirmed','service address'],['accessReviewed','access'],['boundariesReviewed','scope boundaries'],['decisionsReviewed','keep/remove/donate decisions'],['hazardsReviewed','hazards'],['damageReviewed','existing damage'],['measurementsReviewed','measurement relevance'],['equipmentReviewed','equipment needs'],['questionsReviewed','customer questions']])need(data[key]===true,key,`Review and confirm ${label}.`);
  if(['garage_cleanout','junk_removal'].includes(data.serviceType))need(Boolean(data.removeItems),'removeItems','Describe what leaves.');
  if((data.hazards||[]).some(x=>x!=='No visible hazards'))need(Boolean(data.hazardPlan),'hazardPlan','Record the hazard handling or stop-work plan.');
  if(data.measurementsNeeded===true)need(Boolean(data.measurements),'measurements','Record relevant measurements with units.');
  if((data.finish||[]).includes('shelving')){need(data.shelfQty>0,'shelfQty','Record the shelving quantity.');need(Boolean(data.shelfType),'shelfType','Record the shelf type.');}
  if((data.finish||[]).includes('totes'))need(data.toteQty>0,'toteQty','Record the bin/tote quantity.');
  need(data.crewSize>=1,'crewSize','Record the estimated crew size.');need(data.estimatedDurationMin>=15,'estimatedDurationMin','Record estimated on-site minutes.');
  need(verifiedPhotos>0||Boolean(data.photoUnavailableReason),'photoUnavailableReason','Upload reference photos or explain why verified photos are unavailable (device-only photos count as not uploaded).');
  need(Boolean(data.pricingStatus),'pricingStatus','Review pricing status.');
  need(data.pricingReviewed===true,'pricingReviewed','Confirm that pricing status and any saved quote revision match this scope.');
  if(data.pricingStatus==='quote_saved')need(Boolean(quote?.estimate?.number),'quoteJobId','Link the saved server-priced quote.');
  if(data.pricingStatus==='needs_quote')need(Boolean(data.pricingReviewNote),'pricingReviewNote','Explain what pricing work remains.');
  need(Boolean(data.handoffNotes),'handoffNotes','Record the crew handoff notes.');
  return gaps;
}
async function access(store,actor,jobId,env) {
  const rights=requireQuoteAuthor(actor,env),job=id(jobId)?await store.read('jobs',jobId):null;
  if(!job||job.recordType||!['walkthrough','job','cleanout','reorg'].includes(job.type))throw fail('not_found','Choose an existing Hub walkthrough or job.',404);
  const assigned=(job.assignedCrew||[]).some(x=>String(x).toLowerCase()===String(actor.user).toLowerCase());
  if(!rights.dispatcher&&!assigned&&job.quoteDraft?.createdBy!==actor.user)throw fail('forbidden','Only the assigned walkthrough author or a manager can open this capture.',403);
  return {job,who:{actor,rights,env,seen:await jobCustomerAccess(store,actor,rights,job,{env})}};
}
// The linked customer the capture's gaps compare with. An estimator who may not see it (estimator-customer-access.js)
// is compared with the name they typed and no stored address, so repeated saves never confirm the stored name.
async function customerFor(store,job,who){
  const customer=id(job.customerId)?await store.read('customers',job.customerId):null;
  if(!customer||!who||who.seen.full)return customer;
  return {id:customer.id,revision:customer.revision,name:who.seen.name,address:''};
}
// What such an estimator reads back of a capture someone else may have filled in: a name, phone or address another
// person wrote there (identityBy) shows as what the estimator typed on the quote (the name; the phone or address only
// when it is the one they typed), never the stored details. What they wrote themselves shows as they wrote it.
const IDENTITY=['customerName','phone','address'];
const sameText=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const mine=(state,key,who)=>String(state.identityBy?.[key]||'').toLowerCase()===String(who.actor.user).toLowerCase();
function shownDraft(state,who){
  const draft=state.draft;
  if(!who||who.seen.full||!plain(draft))return draft;
  const out={...draft},typed={customerName:who.seen.name,phone:who.seen.typed?.phone||'',address:who.seen.typed?.address||''};
  // An empty entry stays empty, so the estimator sees (and fills) what the capture still needs.
  for(const key of IDENTITY)if(key in out&&out[key]&&!mine(state,key,who))out[key]=key==='customerName'?typed.customerName:sameText(out[key])===sameText(typed[key])?out[key]:'';
  return out;
}
const stateOf=job=>job.walkthroughReview||{version:1,revision:0,stage:'draft',draft:{},latestFinalized:null};
const verifiedPhotos=job=>(job.fieldExecution?.photos||[]).filter(x=>x&&typeof x.id==='string'&&x.category==='walkthrough').length;
async function quoteFor(store,job,data){const quoteId=data.quoteJobId||(job.type!=='walkthrough'?job.id:'');if(!quoteId)return null;const quote=quoteId===job.id?job:await store.read('jobs',quoteId);if(!quote||quote.customerId!==job.customerId||(quote.id!==job.id&&quote.sourceWalkthroughId!==job.id))return null;return quote;}
async function view(store,job,who=null){const stored=stateOf(job),review={...stored,draft:shownDraft(stored,who)},quote=await quoteFor(store,job,stored.draft),customer=await customerFor(store,job,who);return{ok:true,jobId:job.id,review,gaps:walkthroughReviewGaps(review.draft,{verifiedPhotos:verifiedPhotos(job),quote,customer,job}),verifiedPhotos:verifiedPhotos(job),quoteSummary:quote?.estimate?.number?{jobId:quote.id,number:quote.estimate.number,revision:quote.estimate.revision,amountCents:quote.estimate.amountCents??Math.round(Number(quote.estimate.amount)*100)}:null,pricingChanged:Boolean(review.latestFinalized?.quote&&(!quote||estimateFingerprint(quote.estimate)!==review.latestFinalized.quote.fingerprint))};}
export async function readWalkthroughReview(store,actor,jobId,{env={}}={}){const {job,who}=await access(store,actor,jobId,env);return view(store,job,who);}
export async function saveWalkthroughReview(store,actor,input,now,{env={}}={}) {
  if(!plain(input)||Object.keys(input).some(k=>!['jobId','action','requestId','expectedRevision','data','reason','actorId'].includes(k))||!['save','finalize','amend'].includes(input.action)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId||''))throw fail('invalid','Use a valid capture action and stable request ID.',400);
  const {job,who}=await access(store,actor,input.jobId,env),state=stateOf(job);
  if(input.actorId&&input.actorId!==actor.user)throw fail('actor_changed','The signed-in employee changed.',403);
  const fingerprint=digest([actor.user,input]),receipt=await store.read(COLLECTION,input.requestId);
  if(receipt){if(receipt.fingerprint!==fingerprint||receipt.action!=='capture.'+input.action)throw fail('idempotency_conflict','That request ID belongs to different content.');return{...await view(store,job,who),replayed:true,savedRevision:receipt.savedRevision};}
  if(input.expectedRevision!==state.revision)throw fail('revision_conflict','Another save changed this capture. Reload before saving.');
  if(state.stage==='finalized'&&input.action!=='amend')throw fail('amend_required','This revision is finalized. Start an amendment to change it.');
  const incoming=normalizeWalkthroughReview(input.data||{}),shown=shownDraft(state,who);
  // Resaving what such an estimator was shown in place of someone else's entry keeps that entry.
  if(shown!==state.draft)for(const key of IDENTITY)if(key in incoming&&!mine(state,key,who)&&incoming[key]===(shown[key]??''))delete incoming[key];
  // A field is credited to whoever last changed it; resending it unchanged (the gameplan sends all three) credits no one.
  // A masked estimator never saw the stored value, so their change is judged against what they were shown: what is
  // left after the drop above is theirs, even when it happens to equal the stored value (echoing it back reveals nothing).
  const masked=shown!==state.draft,changed=key=>key in incoming&&(masked||incoming[key]!==(state.draft?.[key]??''));
  const identityBy={...(plain(state.identityBy)?state.identityBy:{}),...(input.action==='amend'?{}:Object.fromEntries(IDENTITY.filter(changed).map(key=>[key,actor.user])))};
  let data={...state.draft,...incoming},reason='';
  if(input.action==='amend'){if(state.stage!=='finalized')throw fail('invalid','Only a finalized capture needs an amendment.',400);reason=typeof input.reason==='string'?input.reason.trim():'';if(reason.length<3||reason.length>1000)throw fail('invalid','Explain the amendment in 3–1,000 characters.',400);data=state.draft;}
  const quote=await quoteFor(store,job,data),customer=await customerFor(store,job,who),gaps=walkthroughReviewGaps(shownDraft({...state,draft:data,identityBy},who),{verifiedPhotos:verifiedPhotos(job),quote,customer,job});
  if(input.action==='finalize'&&gaps.length)throw fail('incomplete','Review the listed gaps before finalizing.',400,{gaps});
  const revision=state.revision+1;
  const finalized=input.action==='finalize'?{revision,requestId:input.requestId,at:now,by:actor.user,quote:quote?.estimate?.number?{jobId:quote.id,revision:quote.estimate.revision,fingerprint:estimateFingerprint(quote.estimate)}:null}:state.latestFinalized;
  const next={version:1,revision,identityBy,stage:input.action==='finalize'?'finalized':'draft',draft:data,latestFinalized:finalized,amendmentReason:reason||state.amendmentReason||'',updatedAt:now,updatedBy:actor.user};
  const patch={walkthroughReview:next},writes=[];
  if(input.action==='finalize'){
    if(!customer?.revision)throw fail('customer_unavailable','The canonical customer revision could not be verified.',503);
    writes.push({collection:'customers',id:customer.id,revision:customer.revision,verify:true});
    const instructions=stripCrewMoneyDeep({...(job.jobInstructions&&typeof job.jobInstructions==='object'?job.jobInstructions:{}),customerGoal:data.scopeSummary,keepItems:data.keepItems||'',removeItems:data.removeItems||'',donateItems:data.donateItems||'',exclusions:data.exclusions,hazards:data.hazards||[],hazardPlan:data.hazardPlan||'',damageNotes:data.damageNotes||'',accessNotes:data.accessNotes||'',truckPlacement:data.parkingNotes||'',measurements:data.measurements||'',equipment:data.equipment||'',customerQuestions:data.customerQuestions||'',operationalScope:data.handoffNotes});
    Object.assign(instructions,{finish:data.finish||[],specialItems:data.specialItems||[],sortMethod:data.sortMethod||'',shelfType:data.shelfType||'',shelfQty:data.shelfQty??0,toteQty:data.toteQty??0,crewSize:data.crewSize,estimatedJobMinutes:data.estimatedDurationMin});
    Object.assign(patch,{jobInstructions:instructions,accessInstructions:instructions.accessNotes,operationalScope:{text:instructions.operationalScope,updatedAt:now,updatedBy:actor.user,reason:'Finalized staff walkthrough review',approvalKind:'staff_operational_instructions'}});
    if(quote&&quote.id!==job.id){const qp={jobInstructions:{...(quote.jobInstructions||{}),...instructions},accessInstructions:instructions.accessNotes,operationalScope:patch.operationalScope,walkthroughReviewReference:{sourceJobId:job.id,...finalized}};qp.walkthroughCaptureSync=prepareWalkthroughCaptureSync({...quote,...qp},now);writes.push({collection:'jobs',id:quote.id,revision:quote.revision,patch:qp});}
    else if(job.quoteDraft)patch.walkthroughCaptureSync=prepareWalkthroughCaptureSync({...job,...patch},now);
  }
  writes.push({collection:'jobs',id:job.id,revision:job.revision,patch},{collection:COLLECTION,id:input.requestId,patch:{action:'capture.'+input.action,fingerprint,jobId:job.id,savedRevision:revision,actorId:actor.user,createdAt:now,amendmentReason:next.amendmentReason,...(input.action==='finalize'?{finalizedSnapshot:data,finalized}: {})}});
  try{await store.commit(writes);}catch(error){let committed;try{committed=await store.read(COLLECTION,input.requestId);}catch{throw fail('outcome_unknown','The save result is unknown. Retry the original request without editing.',503);}if(committed?.fingerprint===fingerprint)return{...await view(store,await store.read('jobs',job.id),who),replayed:true,savedRevision:revision};if(error.code==='dispatch_revision_conflict')throw fail('revision_conflict','The capture or linked quote changed while saving. Reload before retrying.');throw fail('outcome_unknown','The save result is unknown. Retry the original request without editing.',503);}
  return{...await view(store,{...job,...patch},who),replayed:false,savedRevision:revision};
}
