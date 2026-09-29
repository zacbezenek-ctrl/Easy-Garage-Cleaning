/* Command Center alert for the review queues (REVIEWS-UI): held Stripe charges,
   Garage Guard member matches, approved messages with an unknown outcome (not
   ones that may still be sending) and an expired, expiring or missing insurance
   certificate. Read-only: it links to Review queues and Settings and never
   changes anything. Rows reuse the Command Center's attention list styles. */
(function(){
'use strict';
const TTL=120000,SOURCES=[['stripe','/api/stripe-reviews'],['sends','/api/message-sends'],['insurance','/api/portal-documents-admin']];
const INSURANCE={expiring_soon:'The insurance certificate expires soon',expired:'The insurance certificate expired',missing:'No insurance certificate is uploaded',invalid:'The insurance certificate needs review',unavailable:'Customers cannot download the insurance certificate'};
const S={slot:null,ctx:null,items:null,total:0,at:0,request:null,generation:0};
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value]of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else node.setAttribute(name,String(value));}for(const child of children.flat())if(child!=null&&child!==false)node.append(child instanceof Node?child:String(child));return node;}
const plural=(count,one,many)=>count+' '+(count===1?one:many);
const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}),money=cents=>usd.format(cents/100);
const refundKnown=row=>Number.isSafeInteger(row.amountCents)&&Number.isSafeInteger(row.refundedCents)&&row.refundedCents>0;
// A charge with a crew tip (or one whose tip could not be read): only its service part is ever service money, so the
// alert never names a lump amount to record or reduce; Review queues shows the service and tip split.
const tipped=row=>row?.tipCents===null||Number.isSafeInteger(row?.tipCents)&&row.tipCents>0;
// Held charges not on their job: Stripe shows refunded ones are the owner's to settle; a partial refund leaves money kept that is on no job.
function heldCopy(rows){
  let copy='Stripe confirmed the charge but it was not applied to the job. Reconcile it, or the owner records the refund.';
  const refunded=rows.filter(row=>row?.reason==='payment_refunded');
  if(!refunded.length)return copy;
  copy+=rows.length===1?' Stripe shows a refund on it, so only the owner settles it.':' Stripe shows a refund on '+refunded.length+' of them; only the owner settles those.';
  const partial=refunded.filter(row=>refundKnown(row)&&Number.isSafeInteger(row.keptCents)&&row.keptCents>0);
  if(partial.length===1){const row=partial[0];copy+=' '+money(row.refundedCents)+' of '+money(row.amountCents)+' was refunded, so the '+money(row.keptCents)+' kept is not on the job '+(tipped(row)?'and includes a crew tip: record only its service part under Estimates & payments (Review queues shows how much) before the refund is recorded.':'until it is recorded under Estimates & payments.');}
  else if(partial.length){
    // A tipped charge's kept money includes its crew tip, which is never recorded as a service payment: it is never in the lump.
    const plain=partial.filter(row=>!tipped(row)),tips=partial.length-plain.length;
    if(plain.length)copy+=' '+(plain.length===1?'1 was':plain.length+' were')+' only partly refunded: the '+money(plain.reduce((sum,row)=>sum+row.keptCents,0))+' kept is not on '+(plain.length===1?'its job':'any job')+' until it is recorded under Estimates & payments.';
    if(tips)copy+=' '+(tips===1?'1 partly refunded charge includes':tips+' partly refunded charges include')+' a crew tip: record only '+(tips===1?'its':'each one’s')+' service part under Estimates & payments, as Review queues shows, before the refund is recorded.';
  }
  return copy;
}
// A further refund on a charge not on its job whose earlier review was closed (a follow-up review): what that review kept
// was recorded on the job by hand, or applied to another job, so it is corrected there, never recorded again.
const followUp=row=>typeof row?.reviewId==='string'&&row.reviewId!==''&&typeof row.sessionId==='string'&&row.reviewId!==row.sessionId;
function laterCopy(rows){
  return rows.length===1?'Stripe shows a further refund on a charge not on its job whose earlier review was closed: what that review kept was recorded on the job by hand or applied to another job. Only the owner settles it: record the refund, then correct that payment as Review queues shows.'
    :'Stripe shows further refunds on '+rows.length+' charges not on their jobs whose earlier reviews were closed: what those reviews kept was recorded on the jobs by hand or applied to other jobs. Only the owner settles them: record each refund, then correct those payments as Review queues shows.';
}
// A refund on this charge the owner recorded earlier (a follow-up review), confirming then that the job is reduced by it: only the difference is left.
const priorOf=row=>Number.isSafeInteger(row.priorRefundedCents)&&row.priorRefundedCents>0?row.priorRefundedCents:0;
// Refunds on charges their job already counts as paid in full: the owner records each refund and reduces the job by the amount
// refunded, less any refund recorded earlier on the same charge, so acting from the alert never reduces a job twice.
function onJobRefundCopy(rows){
  // A charge with a crew tip is never in a lump amount to reduce: it goes to Review queues on its own.
  if(rows.length>1&&rows.some(tipped)){
    const plain=rows.filter(row=>!tipped(row)),tips=rows.length-plain.length,parts=plain.length?[onJobRefundCopy(plain)]:[];
    parts.push('Stripe '+(plain.length?'also ':'')+'shows '+(tips===1?'a refund on 1 charge with a crew tip that its job already counts':'refunds on '+tips+' charges with a crew tip that their jobs already count')+' as paid (by the service part); only the owner settles '+(tips===1?'it':'them')+': record '+(tips===1?'the refund':'each refund')+' in Review queues. A charge with a crew tip is corrected by its service part and tip apart, as Review queues shows.');
    return parts.join(' ');
  }
  if(rows.length===1){
    const row=rows[0],prior=priorOf(row);
    // A tipped charge counts only its service part on the job: the correction splits service and tip (Review queues shows it).
    if(tipped(row))return 'Stripe shows '+(refundKnown(row)?(row.refundedCents>=row.amountCents?'the full '+money(row.amountCents):money(row.refundedCents)+' of '+money(row.amountCents))+' refunded':'a refund')+' on a charge with a crew tip that the job already counts as paid (its service part). Only the owner settles it: record the refund, then correct the job’s service payment and the crew tip as Review queues shows.';
    if(!refundKnown(row))return 'Stripe shows a refund on a charge the job already counts as paid. Only the owner settles it: record the refund, then reduce the job’s payment by the amount refunded'+(prior?' beyond the '+money(prior)+' recorded earlier':'')+'.';
    const shown=row.refundedCents>=row.amountCents?'the full '+money(row.amountCents):money(row.refundedCents)+' of '+money(row.amountCents);
    const reduce=!prior?'then reduce the job’s payment by the '+money(row.refundedCents)+' refunded.'
      :row.refundedCents>prior?'then reduce the job’s payment by '+money(row.refundedCents-prior)+' more ('+money(row.refundedCents)+' refunded in all, '+money(prior)+' recorded earlier).'
      :'then check the job’s payment against Stripe before changing it: '+money(prior)+' was recorded earlier.';
    return 'Stripe shows '+shown+' refunded on a charge the job already counts as paid. Only the owner settles it: record the refund, '+reduce;
  }
  const prior=rows.reduce((sum,row)=>sum+priorOf(row),0),known=rows.every(row=>refundKnown(row)&&row.refundedCents>priorOf(row));
  const total=known?' ('+(prior?money(rows.reduce((sum,row)=>sum+row.refundedCents-priorOf(row),0))+' more to reduce in all, '+money(prior)+' recorded earlier':money(rows.reduce((sum,row)=>sum+row.refundedCents,0))+' refunded in all')+')':'';
  return 'Stripe shows refunds on '+rows.length+' charges their jobs already count as paid'+total+'. Only the owner settles them: record each refund, then reduce each job’s payment by the amount refunded'+(prior?', less any refund recorded earlier on that charge':'')+'.';
}
function paymentCopy(rows){
  const onJob=rows.filter(row=>row?.recordedOnJob===true),off=rows.filter(row=>row?.recordedOnJob!==true),later=off.filter(followUp),held=off.filter(row=>!followUp(row)),refunded=onJob.filter(row=>row?.reason==='payment_refunded'),settled=onJob.length-refunded.length,parts=[];
  if(held.length)parts.push(heldCopy(held));
  if(later.length)parts.push(laterCopy(later));
  if(refunded.length)parts.push(onJobRefundCopy(refunded));
  // A held charge a crew return has since put on its job only needs its review closed.
  if(settled)parts.push(settled===1?'One held charge is now on its job: mark it reconciled to close its review.':settled+' held charges are now on their jobs: mark them reconciled to close their reviews.');
  return parts.join(' ');
}
async function read(path){
  const run=S.ctx?.hubFetch||(typeof hubFetch==='function'?hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'}));
  const response=await run(path,{cache:'no-store',credentials:'same-origin'}),data=await response.json().catch(()=>null);
  if(!response.ok||!data||data.ok!==true)throw Object.assign(new Error('unavailable'),{status:response.status});
  return data;
}
// [title, copy, view, count] rows; a source that could not be read is its own row, never "all clear".
function rows(results){
  const out=[],value=key=>results[key]?.status==='fulfilled'?results[key].value:null,failed=key=>results[key]?.status==='rejected'&&![401,403].includes(Number(results[key].reason?.status));
  const stripe=value('stripe'),sends=value('sends'),insurance=value('insurance');
  if(stripe&&Array.isArray(stripe.paymentReviews)&&stripe.paymentReviews.length)out.push([plural(stripe.paymentReviews.length,'card payment is','card payments are')+' held for review',paymentCopy(stripe.paymentReviews),'reviews',stripe.paymentReviews.length]);
  if(stripe&&Array.isArray(stripe.membershipReviews)&&stripe.membershipReviews.length)out.push([plural(stripe.membershipReviews.length,'Garage Guard member needs','Garage Guard members need')+' a customer link','Choose the matching Hub customer or close the review.','reviews',stripe.membershipReviews.length]);
  // A send still inside its delivery window may yet reach HighLevel; it is not waiting for a person.
  const unknown=sends&&Array.isArray(sends.sends)?sends.sends.filter(row=>row?.inFlight!==true).length:0;
  if(unknown)out.push([plural(unknown,'message has','messages have')+' an unknown outcome','Check HighLevel, then mark each delivered or not delivered. Nothing is resent while its outcome is unknown.','reviews',unknown]);
  if(insurance?.insurance&&INSURANCE[insurance.insurance.state])out.push([INSURANCE[insurance.insurance.state],insurance.insurance.state==='expiring_soon'?'Upload the renewed certificate before it lapses so customers can keep downloading it.':'Customers cannot download it from their portal until a current certificate is uploaded.','settings',1]);
  if(['stripe','sends','insurance'].some(failed))out.push(['Review queues could not be checked','Open Review queues to retry. Nothing is shown as clear until it loads.','reviews',0]);
  return out;
}
function render(){
  const slot=S.slot;
  if(!slot||!slot.isConnected)return;
  if(!S.items||!S.items.length){slot.replaceChildren();return;}
  const go=view=>{try{S.ctx?.go?.(view);}catch{}},total=S.items.reduce((sum,row)=>sum+row[3],0);
  const section=h('section',{class:'ops-card egc-review-alert','aria-labelledby':'ops-review-alert-title'},
    h('span',{class:'ops-eyebrow'},'NEEDS YOUR REVIEW'),
    h('h2',{id:'ops-review-alert-title'},total?plural(total,'item is','items are')+' waiting for a person':'Review queues need a check'),
    h('div',{class:'ops-attention'},S.items.map(([title,copy,view])=>h('button',{type:'button',onclick:()=>go(view)},h('i',{}),h('div',{},h('strong',{},title),h('small',{},copy)),h('b',{'aria-hidden':'true'},'\u2192')))));
  section.style.marginBottom='18px';
  slot.replaceChildren(section);
}
async function load(){
  if(S.request)return S.request;
  const generation=S.generation;
  S.request=(async()=>{
    const settled=await Promise.allSettled(SOURCES.map(([,path])=>read(path)));
    if(generation!==S.generation)return;
    S.items=rows(Object.fromEntries(SOURCES.map(([key],index)=>[key,settled[index]])));S.at=Date.now();render();
  })().finally(()=>{if(generation===S.generation)S.request=null;});
  return S.request;
}
// The Command Center is rebuilt on background refreshes: the cached rows go into the new slot at once and reload after TTL.
function mount(slot,ctx={}){
  if(!slot)return;
  S.slot=slot;S.ctx=ctx;render();
  if(!S.items||Date.now()-S.at>TTL)void load();
}
function unmount(){S.slot=null;}
window.addEventListener('egc:signout',()=>{S.generation++;S.request=null;S.items=null;S.at=0;S.slot?.replaceChildren();S.slot=null;S.ctx=null;});
window.EGCReviewAlerts=Object.freeze({mount,unmount,refresh:()=>{S.at=0;return load();}});
})();
