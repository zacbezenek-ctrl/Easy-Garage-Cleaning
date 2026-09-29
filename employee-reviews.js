/* Review queues (REVIEWS-UI): Stripe charges and Garage Guard members the
   webhook held for a person, approved messages whose delivery is unknown and
   the insurance certificate alert. Every change goes through the Hub APIs with
   a request ID, the record's revision and an audit entry. Nothing here charges,
   refunds or messages anyone: refunds are made in Stripe and only recorded. */
(function(){
'use strict';
const SCREEN='reviews',TZ='America/Denver';
const API={stripe:'/api/stripe-reviews',sends:'/api/message-sends',insurance:'/api/portal-documents-admin'};
const PAYMENT_REASONS={payment_exceeds_balance:'Charged more than the job balance at the time',payment_needs_review:'An earlier payment on the job was not verified yet',payment_refunded:'Stripe shows a refund on this charge',payment_tip_refused:'Includes a crew tip, and the job was closed, voided or refunded after checkout opened'};
const MEMBER_REASONS={no_customer_match:'No Hub customer has this phone or email',ambiguous_customer:'More than one Hub customer matches',contact_conflict:'The phone and email match different customers',too_many_jobs:'The customer has too many visits to check automatically',multiple_account_roots:'The customer has more than one account',account_link_invalid:'The customer’s account links need repair',no_account_job:'The customer has no account job yet',account_has_other_membership:'That account already has another membership',account_link_changed:'The linked account changed'};
const PLANS={lite:'Guard Lite',guard:'Garage Guard',black:'Guard Black'};
const INSURANCE={expiring_soon:['warning','Insurance certificate expires soon'],expired:['error','Insurance certificate expired'],missing:['error','No insurance certificate uploaded'],invalid:['error','Insurance certificate needs review'],unavailable:['error','Insurance certificate is unavailable to customers']};
const STATES=['current','expiring_soon','expired','missing','invalid','unavailable'];
const S={host:null,ctx:null,root:null,generation:0,loading:false,busy:false,data:{stripe:null,sends:null,insurance:null},errors:{},notice:'',failure:null,dialog:null,opener:null,dirty:false,draft:null,next:null};
// A review that changed under an open dialog is reloaded; what was typed is kept for that dialog (never checkboxes, which need fresh consent).
const KEEP_DRAFT=/^(stripe_review|messaging)_(revision_conflict|membership_changed|refund_on_job)$/;
const RELOAD=/^(stripe_review|messaging)_(revision_conflict|already_resolved|reconcile_not_needed|changed_since_operation|membership_changed|not_found|send_not_found|refund_on_job)$/;
// A definitive refusal (only the owner settles a charge Stripe shows refunded): shown in the dialog, never kept for a retry.
const REFUSED=/^stripe_review_owner_required$/;
const kit=()=>window.EGCHubKit;
const toast=message=>{try{S.ctx?.toast?.(message);}catch{}};
function when(value){const time=Date.parse(value||'');return Number.isFinite(time)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(time)):'';}
function dateLabel(date){return kit().validDate(date)?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z')):'';}
const plural=(count,word)=>count+' '+word+(count===1?'':'s');
const list=value=>Array.isArray(value)?value:null;
// Anything but the documented shape is "unverified", never an empty queue.
const VALID={
  stripe:data=>Boolean(list(data.paymentReviews)&&list(data.membershipReviews)&&data.coverage&&typeof data.coverage.complete==='boolean'&&data.paymentReviews.every(row=>typeof row.sessionId==='string'&&typeof row.revision==='string')&&data.membershipReviews.every(row=>typeof row.subscriptionId==='string'&&typeof row.revision==='string'&&list(row.candidates))),
  sends:data=>Boolean(list(data.sends)&&data.coverage&&typeof data.coverage.complete==='boolean'&&data.sends.every(row=>typeof row.id==='string'&&typeof row.revision==='string')&&(data.lateResults===undefined||list(data.lateResults)&&data.lateResults.every(row=>typeof row.id==='string'&&row.lateResult&&typeof row.lateResult==='object'))),
  insurance:data=>Boolean(data.insurance&&STATES.includes(data.insurance.state)),
};
const request=(path,opts={})=>kit().requestJSON(path,{prefix:'reviews',fetcher:S.ctx?.hubFetch,...opts});
// The review APIs are for operations managers and the owner; other business roles get 403, which is not an outage.
const restricted=key=>Number(S.errors[key]?.status)===403;
// Stripe's refund split in whole cents ({amountCents, refundedCents, keptCents}), or null when it is not known. A tipped
// charge's split also names the kept service part and tip (keptServiceCents, keptTipCents; null when unreadable).
function refundSplit(value){
  const amount=value?.amountCents,refunded=value?.refundedCents;
  if(!Number.isSafeInteger(amount)||!Number.isSafeInteger(refunded)||refunded<=0||refunded>amount)return null;
  const split={amountCents:amount,refundedCents:refunded,keptCents:Number.isSafeInteger(value.keptCents)&&value.keptCents>=0?value.keptCents:amount-refunded};
  if('keptServiceCents' in value||'keptTipCents' in value){const service=value.keptServiceCents,tip=value.keptTipCents,known=Number.isSafeInteger(service)&&Number.isSafeInteger(tip)&&service>=0&&tip>=0&&service+tip===split.keptCents;split.keptServiceCents=known?service:null;split.keptTipCents=known?tip:null;}
  return split;
}
// A row's crew tip in cents: 0 when untipped (or from before tips), null when it could not be read.
const tipOf=row=>row?.tipCents===null?null:Number.isSafeInteger(row?.tipCents)&&row.tipCents>0?row.tipCents:0;
const whole=value=>Number.isSafeInteger(value)&&value>=0;
// What a tipped charge keeps after a refund, split into service and tip (the server's keptSplit): the refund read as coming
// out of the service first, or (tipFirst) the crew tip first. tipBefore is the tip still kept before this refund.
function keptParts(kept,tip,{tipFirst=false,refunded=null,tipBefore=tip}={}){
  if(!whole(kept)||!(tip>0))return null;
  const before=whole(tipBefore)&&tipBefore<=tip?tipBefore:tip,keptTip=tipFirst?(whole(refunded)?Math.max(0,before-refunded):null):Math.min(kept,before);
  return keptTip===null||keptTip>kept?null:{keptServiceCents:kept-keptTip,keptTipCents:keptTip};
}
// Both readings of a tipped row's refund. A follow-up that names what the earlier recorded refund kept is read on its own
// (stacked): only the refund beyond that one is split, out of what it left.
function readings(row,split){
  const tip=tipOf(row),prior=Number.isSafeInteger(row.priorRefundedCents)&&row.priorRefundedCents>0?row.priorRefundedCents:0;
  const stacked=Boolean(prior)&&whole(row.priorKeptTipCents)&&whole(row.priorKeptServiceCents)&&split.refundedCents>=prior;
  const base={refunded:stacked?split.refundedCents-prior:split.refundedCents,tipBefore:stacked?row.priorKeptTipCents:tip};
  return {service:keptParts(split.keptCents,tip,base),tip:keptParts(split.keptCents,tip,{...base,tipFirst:true}),stacked,prior,serviceBefore:stacked?row.priorKeptServiceCents:Number.isSafeInteger(row.serviceCents)?row.serviceCents:null};
}
// What to record on the job, BEFORE the refund is recorded, from money kept on a charge not on the job (the open review
// still holds the customer's Pay button): a tipped charge's service part only, which depends on which part was refunded.
function keptFirst(row,split){
  const {money}=kit(),tip=tipOf(row);
  if(tip===0)return 'record the '+money(split.keptCents)+' kept on the job under Estimates & payments';
  const r=tip===null?null:readings(row,split);
  if(!r?.service||!r.tip)return 'check in Stripe how much of the '+money(split.keptCents)+' kept is the crew tip, and record only the service part on the job under Estimates & payments';
  const amounts=r.service.keptServiceCents===r.tip.keptServiceCents?'its '+money(r.service.keptServiceCents)+' service part on the job under Estimates & payments':'its service part on the job under Estimates & payments ('+money(r.service.keptServiceCents)+' if the refund came out of the service first, or '+money(r.tip.keptServiceCents)+' if the crew tip was refunded first)';
  return 'record '+amounts+'; up to '+money(r.service.keptTipCents)+' of the '+money(split.keptCents)+' kept is the crew tip, which is never a service payment';
}
// What the crew is owed of a tip once part of it may have been refunded.
function tipPay(keptTip,tip){const {money}=kit();return keptTip<=0?'pay the crew none of the '+money(tip)+' tip':keptTip<tip?'pay the crew only '+money(keptTip)+' of the '+money(tip)+' tip':'pay the crew the whole '+money(tip)+' tip';}
// The correction for a refund on a tipped charge the job already counts as paid: its service payment (only the service
// part is in the job's paid total) and the crew tip (kept apart on the job; tip payroll holds it until it is paid by hand).
function onJobFix(parts,serviceBefore,tip,more){
  const {money}=kit(),reduce=serviceBefore-parts.keptServiceCents;
  return (reduce>0?'reduce the job’s service payment by '+money(reduce)+(more?' more':''):'leave the job’s service payment as it is')+' and '+tipPay(parts.keptTipCents,tip);
}
const cap=text=>text.charAt(0).toUpperCase()+text.slice(1);
function onJobTipped(row,split){
  const {money}=kit(),tip=tipOf(row),r=readings(row,split);
  if(!r.service||!r.tip||!whole(r.serviceBefore))return 'Check in Stripe how much of the refund was the crew tip, then correct the job’s service payment and the crew tip.';
  // An earlier refund whose split is not known: what the job was already corrected by cannot be read here.
  if(r.prior&&!r.stacked)return 'Check the job’s service payment and the crew tip against Stripe before changing them.';
  const intro=(r.stacked?'After the earlier refund the job counts '+money(r.serviceBefore)+' of service as paid':'The job counts only the '+money(r.serviceBefore)+' service part as paid')+'; the '+money(tip)+' tip is kept apart, and tip payroll holds it until you pay what is owed by hand. ';
  const a=onJobFix(r.service,r.serviceBefore,tip,r.stacked),b=onJobFix(r.tip,r.serviceBefore,tip,r.stacked);
  return intro+(a===b?cap(a)+'.':'If the refund'+(r.stacked?' beyond it':'')+' came out of the service first, '+a+'. If the crew tip was refunded first, '+b+'.');
}
// A tipped charge: its service part and crew tip, so the tip is never settled as service money.
function tipLine(row){
  const {money}=kit();
  if(row.tipCents===null)return 'Includes a crew tip whose amount could not be read: check the charge in Stripe before settling it.';
  if(!(Number.isSafeInteger(row.tipCents)&&row.tipCents>0))return '';
  const parts='Includes a crew tip: '+(Number.isSafeInteger(row.serviceCents)?money(row.serviceCents)+' service + ':'')+money(row.tipCents)+' tip. ';
  return parts+(row.recordedOnJob?'The job counts only the service part as paid; the tip is kept apart on the job for tip payroll.':'Only the service part is ever recorded on the job; the tip is paid to the crew by hand.');
}
function pending(){try{return kit().pending(SCREEN);}catch{return null;}}
// A payment review is resolved by its own ID: the session ID, or a refund follow-up ({sessionId}:refund, {sessionId}:refund:2 ...) the server names in reviewId.
const paymentId=row=>typeof row.reviewId==='string'&&row.reviewId?row.reviewId:row.sessionId;

async function load(){
  if(!S.root)return;
  const generation=++S.generation;S.loading=true;render();
  const results=await Promise.allSettled(Object.entries(API).map(([key,path])=>request(path,{validate:VALID[key]}).then(data=>[key,data])));
  if(generation!==S.generation||!S.root)return;
  Object.keys(API).forEach((key,index)=>{const result=results[index];if(result.status==='fulfilled'){S.data[key]=result.value[1];delete S.errors[key];}else{S.errors[key]=result.reason;if([401,403].includes(Number(result.reason?.status)))S.data[key]=null;}});
  S.loading=false;render();
}

function closeDialog(){
  const dialog=S.dialog,opener=S.opener;S.dialog=null;S.opener=null;S.dirty=false;
  if(dialog){try{dialog.close?.();}catch{}dialog.remove();}
  if(opener?.isConnected)opener.focus?.();
}
// One action dialog: fields, a confirm button and an error area. submit(values,draft) resolves '' when the change saved, else the message to show.
function openDialog({title,copy,warning='',fields=[],confirmLabel,danger=false,draftKey='',submit}){
  if(S.dialog||S.busy)return;
  const {h,button,field}=kit(),id='rv-dialog-'+(S.generation+1)+'-'+Date.now().toString(36);
  const kept=draftKey&&S.draft?.key===draftKey?S.draft.values:null;if(kept)S.draft=null;
  const error=h('p',{class:'hub-notice error rv-dialog-error',role:'alert',hidden:true});
  const specs=fields.map(spec=>kept&&spec.type!=='checkbox'&&typeof kept[spec.name]==='string'?{...spec,value:kept[spec.name]}:spec);
  const form=h('form',{class:'hub-dialog-body',oninput:()=>{S.dirty=true;},onsubmit:event=>{event.preventDefault();void confirm();}},h('p',{class:'rv-copy'},copy),warning?h('p',{class:'hub-notice warning rv-dialog-warning'},warning):null,kept?h('p',{class:'rv-muted',role:'status'},'What you typed before is filled in. Check it against the latest details.'):null,specs.map(spec=>field(spec)),error);
  const confirmButton=button(confirmLabel,()=>void confirm(),danger?'danger':'primary');
  const cancel=button('Cancel',()=>{if(!S.busy)closeDialog();});
  const dialog=h('dialog',{class:'hub-dialog rv-dialog','aria-labelledby':id,oncancel:event=>{event.preventDefault();if(!S.busy)closeDialog();}},
    h('header',{},h('h2',{id},title)),form,h('footer',{},cancel,confirmButton));
  async function confirm(){
    if(S.busy)return;
    const values={};
    for(const spec of fields){
      const control=form.querySelector('[name="'+spec.name+'"]');
      if(spec.type==='checkbox'){values[spec.name]=control?.checked===true;if(spec.required&&!values[spec.name]){error.textContent=spec.requiredText||'Tick the box to continue.';error.hidden=false;control?.focus?.();return;}continue;}
      values[spec.name]=String(control?.value??'').trim();if(spec.required&&!values[spec.name]){error.textContent=spec.label+' is required.';error.hidden=false;control?.focus?.();return;}
    }
    error.hidden=true;S.busy=true;confirmButton.disabled=true;cancel.disabled=true;confirmButton.setAttribute('aria-busy','true');
    let message='';
    try{message=await submit(values,draftKey?{key:draftKey,values:Object.fromEntries(Object.entries(values).filter(([,value])=>typeof value==='string'&&value))}:null);}finally{S.busy=false;}
    // The dialog closed (saved, kept for retry, reloaded or replaced): redraw now that nothing is busy, then open any follow-up dialog.
    if(!S.dialog){render();const next=S.next;S.next=null;next?.();return;}
    confirmButton.disabled=false;cancel.disabled=false;confirmButton.removeAttribute('aria-busy');
    if(message){error.textContent=message;error.hidden=false;}
  }
  S.opener=document.activeElement;S.dialog=dialog;S.dirty=Boolean(kept);document.body.append(dialog);
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  form.querySelector('textarea,select,input')?.focus?.();
}

// Sends one change with a request ID kept until the server answers. Returns '' when saved, else the message to show.
// success is the notice text, or a function of the saved response that returns it. handlers maps an error code
// to a function of the error that returns the message to show ('' when it closed the dialog itself).
async function save(path,body,success,draft=null,handlers={}){
  const store=pending();
  if(!store)return 'The Hub could not start this change. Refresh and try again.';
  try{
    const data=await store.submit(path,body),notice=typeof success==='function'?success(data):success;
    S.failure=null;S.draft=null;S.notice=notice;closeDialog();toast(notice);await load();
    return '';
  }catch(error){
    const {errorText}=kit(),code=String(error.code||''),message=errorText(error,{hub_pending_exists:'An earlier change was not confirmed. Retry or discard it first.'});
    if(REFUSED.test(code)){store.discard();return error.message||message;}
    if(error.pending){S.failure={message};closeDialog();render();return '';}
    if(Object.hasOwn(handlers,code))return handlers[code](error);
    if(RELOAD.test(code)){
      const keep=KEEP_DRAFT.test(code)&&draft&&Object.keys(draft.values).length?draft:null,text=/_revision_conflict$/.test(code)?'This record changed while you were editing. The latest version is loaded; check it before trying again.':message;
      closeDialog();S.notice='';S.failure=null;S.draft=keep;await load();
      S.notice=keep?text+' What you typed is kept: open it again to finish.':text;render();return '';
    }
    return message;
  }
}
async function retrySaved(){
  const store=pending();if(!store||S.busy)return;
  S.busy=true;render();
  try{await store.replay();S.failure=null;S.notice='The saved change is confirmed.';toast(S.notice);}
  catch(error){S.failure=error.pending?{message:kit().errorText(error)}:null;if(!error.pending){S.notice=kit().errorText(error);}}
  finally{S.busy=false;}
  await load();
}
function discardSaved(){pending()?.discard();S.failure=null;S.notice='';void load();}

// A test-mode charge the Hub's Stripe key cannot show (no key, or a live key) is closed by the owner without the check; the notice says so.
const UNCHECKED={other_mode:'the Hub now uses a live Stripe key',unconfigured:'no Stripe key is set'};
function reconcileNotice(data){
  const check=data?.review?.stripeCheck,elsewhere=data?.review?.serviceAppliedElsewhere===true?' Its service part was applied to another job or settled outside the Hub.':'';
  return (UNCHECKED[check]?'Charge marked reconciled without a Stripe check (test-mode charge; '+UNCHECKED[check]+').':'Charge marked reconciled.')+elsewhere;
}
// The Hub checks the charge in Stripe before it is reconciled. A charge Stripe shows refunded is never reconciled:
// the owner is taken to Record refund (which confirms any amount kept), with what was typed carried over.
function reconcilePayment(row){
  const refunded=row.reason==='payment_refunded';
  // Only a test-mode charge can be closed without the Stripe check, and only by the owner.
  const unchecked=row.livemode?'':' If Stripe cannot be checked for this test-mode charge (no Stripe key, or a live key), only the owner can close it, without the check.';
  // A tipped charge not on its job (not a follow-up, whose earlier close settled where its money went): closing it gives the
  // customer's Pay button back, so its service part must be on the job first, or the person says it went elsewhere.
  const tip=tipOf(row),service=!row.recordedOnJob&&tip!==0&&paymentId(row)===row.sessionId;
  const {money}=kit(),part=Number.isSafeInteger(row.serviceCents)?'its '+money(row.serviceCents)+' service part':'its service part';
  openDialog({title:'Mark this charge reconciled?',confirmLabel:'Mark reconciled',draftKey:'payment.reconcile:'+paymentId(row),
    copy:(refunded?'Stripe showed a refund on this charge. A refund in Stripe is not reconciled here: record it with Record refund. Mark it reconciled only if Stripe no longer shows the refund (for example, the refund failed), and say how the charge was settled. The Hub checks Stripe first. Nothing changes on the job or in Stripe.'+(service?' Its service part must be on the job first, as below.':'')
      :row.recordedOnJob?'This charge is already on the job. Marking it reconciled closes the review; nothing changes on the job or in Stripe. The Hub checks Stripe first: if it shows a refund, the owner records the refund instead.'
      :(service?'This charge is not on the job. Record '+part+' on the job under Estimates & payments before marking it reconciled (never the '+(tip>0?money(tip)+' ':'')+'crew tip, which is paid to the crew by hand), or, if it was applied to another job or settled outside the Hub, tick that box below. ':'This charge is not on the job. Say how it was settled (for example, recorded on the job by hand or applied to another job). ')+'A refund in Stripe is not reconciled here: the owner records it with Record refund. The Hub checks Stripe first. Nothing changes on the job or in Stripe.')+unchecked,
    warning:service?'Marking it reconciled lets the customer pay the job’s balance again. The Hub refuses it until '+part+' is recorded on the job, unless you tick the box.':'',
    fields:[{label:row.recordedOnJob?'Note (optional)':'How it was reconciled',name:'note',type:'textarea',required:!row.recordedOnJob,maxlength:500,rows:3},
      ...(service?[{label:'Applied to another job or settled outside the Hub: '+part+' is not recorded on this job',name:'appliedElsewhere',type:'checkbox'}]:[])],
    submit:(values,draft)=>save(API.stripe,{action:'payment.reconcile',reviewId:paymentId(row),expectedRevision:row.revision,...(values.note?{note:values.note}:{}),...(service&&values.appliedElsewhere===true?{appliedElsewhere:true}:{})},reconcileNotice,draft,
      {stripe_review_refund_shown:error=>refundInstead(row,error,values)})});
}
// Stripe shows a refund on the charge being reconciled (409 stripe_review_refund_shown with Stripe's amounts):
// reopen as Record refund, the partial dialog when money was kept, with the typed note carried over.
function refundInstead(row,error,values){
  const split=refundSplit(error.details),onJob=error.details?.recordedOnJob===true;
  if(!split||S.data.stripe?.viewer?.canRecordRefund!==true)return kit().errorText(error);
  S.draft=values.note?{key:'payment.refund:'+paymentId(row),values:{note:values.note}}:null;
  S.next=()=>refundPayment({...row,recordedOnJob:onJob,...(onJob?{amountCents:split.amountCents,refundedCents:split.refundedCents,keptCents:split.keptCents}:{})},split.keptCents>0&&!onJob?split:null,'Stripe shows a refund on this charge, so it is recorded as a refund, not reconciled.');
  closeDialog();return '';
}
// What the saved refund means for the job, from the resolved review (row: the queue row it resolved, for a tipped charge's
// service part and any earlier recorded refund).
function refundNotice(data,row={}){
  const {money}=kit(),review=data?.review||{},split=refundSplit(review),onJob=review.recordedOnJobAtResolution===true,tip=tipOf(review);
  // A follow-up of a charge not on its job: what its earlier review kept was recorded by hand (on this job or another).
  const later=!onJob&&review.settledEarlierAtResolution===true;
  if((onJob||later)&&tip>0){
    const parts=review.refundFull===true?{keptServiceCents:0,keptTipCents:0}:whole(review.keptServiceCents)&&whole(review.keptTipCents)?{keptServiceCents:review.keptServiceCents,keptTipCents:review.keptTipCents}:null;
    const r=split?readings({...row,tipCents:tip,serviceCents:Number.isSafeInteger(review.amountCents)?review.amountCents-tip:row.serviceCents},split):null;
    const head=split&&review.refundFull===false?'Refund recorded: '+money(split.refundedCents)+' of '+money(split.amountCents)+' refunded. ':'Refund recorded. ';
    if(parts&&r&&whole(r.serviceBefore)&&!(r.prior&&!r.stacked))return head+(later?'What the earlier review kept was recorded by hand, on this job or another: ':'')+(later?onJobFix(parts,r.serviceBefore,tip,r.stacked):cap(onJobFix(parts,r.serviceBefore,tip,r.stacked)))+'.';
    return head+(later?'Correct the payment recorded when the earlier review was closed, and the crew tip.':'The job still counts this charge’s service part as paid until its payment and the crew tip are corrected.');
  }
  if(later)return (split&&review.refundFull===false?'Refund recorded: '+money(split.refundedCents)+' of '+money(split.amountCents)+' refunded. ':'Refund recorded. ')+'The payment recorded when this charge’s earlier review was closed (on this job or another) still counts until it is corrected.';
  if(split&&review.refundFull===false){
    if(onJob)return 'Refund recorded: '+money(split.refundedCents)+' of '+money(split.amountCents)+' refunded. The job still counts this charge as paid until its payment is corrected.';
    const head='Refund recorded: '+money(split.refundedCents)+' of '+money(split.amountCents)+' refunded. ';
    if(tip===0)return head+'The '+money(split.keptCents)+' kept belongs on the job: check it is recorded under Estimates & payments.';
    if(whole(split.keptServiceCents)&&whole(split.keptTipCents))return head+'Of the '+money(split.keptCents)+' kept, the '+money(split.keptServiceCents)+' service part belongs on the job (under Estimates & payments) and the '+money(split.keptTipCents)+' crew tip is paid to the crew by hand, never as a service payment.';
    return head+'Record only the service part of the '+money(split.keptCents)+' kept on the job under Estimates & payments, never the crew tip.';
  }
  if(onJob)return 'Refund recorded. The job still counts this charge as paid until its payment is corrected.';
  return split?'Refund recorded: Stripe shows the full '+money(split.amountCents)+' refunded.':'Refund recorded.';
}
// partial is Stripe's split from a stripe_review_refund_partial answer: the owner records the money kept on the job first,
// then confirms the exact amount kept. why says why the dialog opened when it replaces a reconcile. A tipped charge
// partly refunded also asks which part was refunded, which decides its service part.
function refundPayment(row,partial=null,why=''){
  const {money}=kit(),reasons=S.data.stripe?.reasons?.refund||{},onJob=row.recordedOnJob===true,tip=tipOf(row);
  // A follow-up of a charge not on its job: its earlier close already put what it kept on the job by hand (or elsewhere),
  // so, as for a charge on the job, the owner confirms the correction and records nothing more first.
  const later=!onJob&&paymentId(row)!==row.sessionId,keep=partial&&!onJob&&!later?partial.keptCents:null;
  const known=partial||refundSplit(row),askPart=tip>0&&Boolean(known)&&known.keptCents>0;
  const r=keep!==null&&tip>0?readings(row,partial):null,kept=r?.service&&r.tip?[r.service.keptServiceCents,r.tip.keptServiceCents]:null;
  const warning=[why,later?'This charge is not on the job, but when its earlier review was closed, what it kept was recorded on the job by hand or applied to another job. Recording this further refund closes the review but changes neither: correct that payment'+(tip!==0?' and the crew tip':'')+' afterwards, as the card shows.':onJob?(tip>0&&Number.isSafeInteger(row.serviceCents)?'This charge is already on the job, which counts its '+money(row.serviceCents)+' service part as paid (the '+money(tip)+' tip is kept apart). Recording the refund here closes the review but does not change the job: correct the job’s service payment and the crew tip afterwards, as the card shows.':'This charge is already on the job, which counts it as paid. Recording the refund here closes the review but does not change the job: correct the job’s payment afterwards.'):'',
    keep!==null?'Stripe shows '+money(partial.refundedCents)+' of '+money(partial.amountCents)+' refunded. The '+money(keep)+' kept is not on the job, and recording this refund closes the review for good'+(tip===0?'':' (the customer’s Pay button comes back)')+'. Before recording it, '+keptFirst(row,partial)+'.':''].filter(Boolean).join(' ');
  const keptLabel=tip===0?'I have recorded the '+money(keep)+' kept on the job under Estimates & payments'
    :kept?'I have recorded the service part kept ('+(kept[0]===kept[1]?money(kept[0]):money(kept[0])+', or '+money(kept[1])+' if the crew tip was refunded first')+') on the job under Estimates & payments, never the tip'
      :'I have recorded only the service part kept on the job under Estimates & payments, never the tip';
  openDialog({title:partial?'Record a partial Stripe refund?':'Record the Stripe refund?',confirmLabel:'Record refund',danger:true,draftKey:'payment.refund:'+paymentId(row),
    copy:'Refund the charge in the Stripe dashboard first (all of it or part of it). The Hub checks Stripe and records the refund only when Stripe shows it. If only part was refunded, the Hub shows the amount kept, which you record on the job before recording the refund. Your note is visible to the owner only.',
    warning,
    fields:[{label:'Reason',name:'reason',type:'select',required:true,options:[{value:'',label:'Choose a reason'},...Object.entries(reasons).map(([value,label])=>({value,label}))]},
      ...(askPart?[{label:'Which part did you refund in Stripe?',name:'refundedPart',type:'select',required:true,options:[{value:'',label:'Choose which part'},{value:'service',label:'The service first (the tip only past the service part)'},{value:'tip',label:'The crew tip first, then the service'}]}]:[]),
      {label:'Note (owner only)',name:'note',type:'textarea',maxlength:500,rows:3},
      ...(onJob?[{label:tip>0?'I will correct the job’s service payment and the crew tip; the job still counts the service part as paid':'I will correct the job’s payment; the job still counts this charge as paid',name:'jobPaymentAcknowledged',type:'checkbox',required:true,requiredText:'Confirm that you will correct the job’s payment before recording the refund.'}]:[]),
      ...(later?[{label:'I will correct the payment recorded when the earlier review was closed (on this job or another)'+(tip!==0?' and the crew tip':''),name:'jobPaymentAcknowledged',type:'checkbox',required:true,requiredText:'Confirm that you will correct that payment before recording the refund.'}]:[]),
      ...(keep!==null?[{label:keptLabel,name:'keptAcknowledged',type:'checkbox',required:true,requiredText:'Confirm the '+money(keep)+' kept before recording the refund.'}]:[])],
    submit:(values,draft)=>save(API.stripe,{action:'payment.refund',reviewId:paymentId(row),expectedRevision:row.revision,reason:values.reason,...(values.note?{note:values.note}:{}),...(onJob||later?{jobPaymentAcknowledged:values.jobPaymentAcknowledged===true}:{}),...(keep!==null&&values.keptAcknowledged===true?{keptCentsAcknowledged:keep}:{}),...(askPart?{tipRefundedFirst:values.refundedPart==='tip'}:{})},
      data=>refundNotice(data,row),draft,{stripe_review_refund_partial:error=>{
        // Stripe shows only part refunded: reopen with the amounts and a required confirmation, keeping what was typed.
        const split=refundSplit(error.details);
        if(!split||split.keptCents<1)return kit().errorText(error);
        S.draft=draft&&Object.keys(draft.values).length?draft:null;S.next=()=>refundPayment(row,split);closeDialog();return '';
      }})});
}
function linkMember(row,candidate){
  openDialog({title:'Link this member to '+(candidate.name||'this customer')+'?',confirmLabel:'Link member',
    copy:'The membership is saved on this customer’s account and its plan, status and visits show on their account job. Later Stripe renewals follow this link. No one is messaged.',
    submit:()=>save(API.stripe,{action:'membership.link',reviewId:row.subscriptionId,expectedRevision:row.revision,customerId:candidate.id},'Member linked.')});
}
function dismissMember(row){
  const reasons=S.data.stripe?.reasons?.dismiss||{};
  openDialog({title:'Close this member review without a link?',confirmLabel:'Close review',draftKey:'membership.dismiss:'+row.subscriptionId,
    copy:'The membership stays in Stripe and in the Hub without a customer link, and later renewals will not reopen this review or guess a customer.',
    fields:[{label:'Reason',name:'reason',type:'select',required:true,options:[{value:'',label:'Choose a reason'},...Object.entries(reasons).map(([value,label])=>({value,label}))]},{label:'Note',name:'note',type:'textarea',maxlength:500,rows:3,help:'Required when the reason is Other.'}],
    submit:(values,draft)=>save(API.stripe,{action:'membership.dismiss',reviewId:row.subscriptionId,expectedRevision:row.revision,reason:values.reason,...(values.note?{note:values.note}:{})},'Member review closed.',draft)});
}
// Who may send a message again after "not delivered" depends on how it was approved: the owner's automation retries its own sends.
function notDeliveredCopy(row){
  const tries=Number.isSafeInteger(row.maxAttempts)?' (it tries up to '+plural(row.maxAttempts,'time')+')':'';
  return row.automationMayResend?'Only do this after checking the HighLevel conversation. Nothing is sent now, but the owner’s automation may send this message again on its next run'+tries+' unless you tick “Do not send it again”.'
    :'Only do this after checking the HighLevel conversation. Nothing is sent now; a person can preview and send it again'+tries+' unless you tick “Do not send it again”.';
}
function reconcileSend(row,outcome){
  const delivered=outcome==='delivered';
  openDialog({title:delivered?'Mark this message delivered?':'Mark this message not delivered?',confirmLabel:delivered?'Mark delivered':'Mark not delivered',danger:!delivered,draftKey:outcome+':'+row.id,
    copy:delivered?'Only do this after you see the message in the HighLevel conversation. It then counts as sent and is never sent again.':notDeliveredCopy(row),
    fields:[{label:'How you checked',name:'note',type:'textarea',required:true,maxlength:500,rows:3,placeholder:'For example: checked the HighLevel conversation at 2:15 PM'},
      ...(delivered?[]:[{label:'Do not send it again',name:'stop',type:'checkbox',help:row.automationMayResend?'Neither a person nor the owner’s automation will send this message again.':'Nobody will be able to send this message again.'}])],
    submit:(values,draft)=>save(API.sends,{action:'reconcile',ledgerId:row.id,expectedRevision:row.revision,outcome,note:values.note,...(!delivered&&values.stop===true?{resend:false}:{})},
      delivered?'Message marked delivered.':values.stop===true?'Message marked not delivered. It will not be sent again.':row.automationMayResend?'Message marked not delivered. The owner’s automation may send it again.':'Message marked not delivered.',draft)});
}

function unavailable(key,label){
  const {h,button,errorText}=kit(),error=S.errors[key];
  return h('div',{class:'hub-notice error',role:'alert'},h('strong',{},label+' could not be loaded'),h('p',{},error?errorText(error):'Nothing here is shown as current until it loads.'),h('div',{class:'hub-actions'},button('Retry',()=>void load(),'',{disabled:S.loading})));
}
function loadingBlock(label){const {h}=kit();return h('div',{class:'rv-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading '+label+'…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}));}
function section(key,title,count,body,note){
  const {h}=kit(),heading='rv-'+key+'-title';
  return h('section',{class:'rv-section','aria-labelledby':heading},h('div',{class:'rv-section-head'},h('h2',{id:heading},title),count==null?null:h('span',{class:'rv-count'+(count?' open':'')},String(count))),note||null,body);
}
function insuranceAlert(){
  const {h,button}=kit(),data=S.data.insurance;
  if(!data)return S.errors.insurance&&![401,403].includes(Number(S.errors.insurance.status))?unavailable('insurance','The insurance certificate status'):null;
  const state=data.insurance.state,copy=INSURANCE[state];
  if(!copy)return null;
  const until=dateLabel(data.insurance.expiresOn),detail={expiring_soon:'It expires '+(until||'soon')+'. Upload the renewed certificate before then so customers can keep downloading it.',expired:'It expired '+(until||'')+'. Customers cannot download it until the renewed certificate is uploaded.',missing:'Customers are asked to call or text for a copy until one is uploaded.',invalid:'The saved record is incomplete. Upload the certificate again.',unavailable:'Google Drive is not connected, so customers cannot download it.'}[state];
  return h('div',{class:'hub-notice '+copy[0]+' rv-alert',role:copy[0]==='error'?'alert':'status'},h('strong',{},copy[1]),h('p',{},detail),h('div',{class:'hub-actions'},button('Open Settings',()=>S.ctx?.go?.('settings'))));
}
// What Stripe's refund means for the job. An untipped charge already on the job is counted there in full, so the job is
// reduced by the amount refunded, less a refund recorded earlier on the same charge (prior, from a follow-up review), so it
// is never reduced twice. A tipped charge on the job is counted there by its service part only (its tip is kept apart), so
// only the service refunded comes off the job's payment and the crew is paid only the tip kept. A charge not on the job
// leaves any amount kept on no job until it is recorded there, before the refund is recorded.
function refundLine(row,split,prior=0){
  const {money}=kit(),full=split.keptCents<=0,tip=tipOf(row);
  // A follow-up of a charge not on its job: when its earlier review was closed, what it kept was recorded on the job by
  // hand (or the charge was applied to another job), so the further refund is corrected there, never recorded again.
  if(row.recordedOnJob!==true&&typeof row.reviewId==='string'&&row.reviewId!==''&&row.reviewId!==row.sessionId){
    const shown='Stripe shows '+(full?'the full '+money(split.amountCents):money(split.refundedCents)+' of '+money(split.amountCents))+' refunded'+(prior?'; a '+money(prior)+' refund was recorded earlier':'')+'. ';
    const where='When this charge’s earlier review was closed, what it kept was recorded on the job by hand or applied to another job. ';
    if(prior&&split.refundedCents<=prior)return shown+where+'Check that payment against Stripe before changing it.';
    if(tip===null)return shown+where+'Check in Stripe how much of it was the crew tip, then correct that service payment and the crew tip.';
    if(tip===0)return shown+where+'Reduce that payment by '+money(split.refundedCents-prior)+(prior?' more':'')+'.';
    const r=readings(row,split);
    if(!r.service||!r.tip||!whole(r.serviceBefore)||(r.prior&&!r.stacked))return shown+where+'Check that service payment and the crew tip against Stripe before changing them.';
    const a=onJobFix(r.service,r.serviceBefore,tip,r.stacked),b=onJobFix(r.tip,r.serviceBefore,tip,r.stacked);
    return shown+where+(a===b?cap(a)+'.':'If the refund'+(r.stacked?' beyond it':'')+' came out of the service first, '+a+'. If the crew tip was refunded first, '+b+'.');
  }
  if(row.recordedOnJob&&tip!==0){
    const shown='Stripe shows '+(full?'the full '+money(split.amountCents):money(split.refundedCents)+' of '+money(split.amountCents))+' refunded'+(prior?'; a '+money(prior)+' refund was recorded earlier':'')+'. ';
    if(prior&&split.refundedCents<=prior)return shown+'Check the job’s service payment and the crew tip against Stripe before changing them.';
    return shown+(tip===null?'Check in Stripe how much of it was the crew tip, then correct the job’s service payment and the crew tip.':onJobTipped(row,split));
  }
  if(row.recordedOnJob&&prior){
    const shown='Stripe shows '+(full?'the full '+money(split.amountCents):money(split.refundedCents)+' of '+money(split.amountCents))+' refunded. ';
    if(split.refundedCents<=prior)return shown+'A '+money(prior)+' refund was recorded earlier: check the job’s payment against Stripe before changing it.';
    return shown+'Reduce the job’s payment by '+money(split.refundedCents-prior)+' more ('+money(split.refundedCents)+' refunded in all, '+money(prior)+' recorded earlier)'+(full?'.':', so it counts only the '+money(split.keptCents)+' kept.');
  }
  if(row.recordedOnJob)return full?'Stripe shows the full '+money(split.amountCents)+' refunded. The job still counts it as paid: reduce the job’s payment by '+money(split.amountCents)+'.'
    :'Stripe shows '+money(split.refundedCents)+' of '+money(split.amountCents)+' refunded. The job still counts the full '+money(split.amountCents)+' as paid: reduce the job’s payment by the '+money(split.refundedCents)+' refunded, so it counts only the '+money(split.keptCents)+' kept.';
  return full?'Stripe shows the full '+money(split.amountCents)+' refunded.':'Stripe shows '+money(split.refundedCents)+' of '+money(split.amountCents)+' refunded; the '+money(split.keptCents)+' kept is not on the job'+(tip===0?'.':'. Before recording the refund, '+keptFirst(row,split)+'.');
}
function paymentCard(row,canRefund){
  const {h,button,money}=kit(),reason=PAYMENT_REASONS[row.reason]||'Held for review',refunded=row.reason==='payment_refunded',split=refunded?refundSplit(row):null;
  // A refund is the owner's to record: managers cannot close a refunded charge as reconciled.
  const canReconcile=!refunded||canRefund,first=refunded&&PAYMENT_REASONS[row.heldReason]&&row.heldReason!=='payment_refunded'?PAYMENT_REASONS[row.heldReason]:'';
  const prior=Number.isSafeInteger(row.priorRefundedCents)&&row.priorRefundedCents>0?row.priorRefundedCents:0;
  return h('article',{class:'hub-card rv-card'},
    h('div',{class:'rv-card-head'},h('h3',{},money(row.amountCents)+' · '+(row.customer||(row.jobFound?'Customer not named':'Job not found'))),h('span',{class:'rv-badge '+(row.recordedOnJob?'good':'warn')},row.recordedOnJob?'Already on the job':'Not on the job')),
    h('p',{class:'rv-reason'},reason+'.'),
    tipLine(row)?h('p',{class:'rv-tip'},tipLine(row)):null,
    split?h('p',{class:'hub-notice warning rv-refund'},refundLine(row,split,prior)):null,
    first?h('p',{class:'rv-muted'},'First held because: '+first.charAt(0).toLowerCase()+first.slice(1)+'.'):null,
    paymentId(row)!==row.sessionId?h('p',{class:'rv-muted'},prior?'A '+money(prior)+' refund on this charge was recorded earlier, and Stripe now shows more refunded. '+(!row.recordedOnJob?'Correct only for the refund beyond it.':tipOf(row)!==0?'Correct the job only for the refund beyond it.':'If the job was already reduced by '+money(prior)+', reduce it only by the difference.'):'Stripe showed this refund after the charge’s earlier review was closed.'):null,
    h('dl',{class:'rv-facts'},
      h('div',{},h('dt',{},'Job'),h('dd',{},row.jobId||'Unknown')),
      h('div',{},h('dt',{},'When held'),h('dd',{},when(row.createdAt)||'Unknown')),
      h('div',{},h('dt',{},'Balance then'),h('dd',{},money(row.jobBalanceCents)+' of '+money(row.jobTotalCents))),
      h('div',{},h('dt',{},'Link opened by'),h('dd',{},row.createdBy==='customer_portal'?'Customer portal':row.createdBy||'Unknown'))),
    row.livemode?null:h('p',{class:'rv-muted'},'Stripe test mode charge.'),
    canReconcile||canRefund?h('div',{class:'hub-actions rv-actions'},canReconcile?button('Mark reconciled',()=>reconcilePayment(row),refunded?'':'primary'):null,canRefund?button('Record refund',()=>refundPayment(row),refunded?'primary':''):null):null,
    canRefund?null:h('p',{class:'rv-muted'},refunded?'Stripe shows a refund on this charge, so only the owner settles it by recording the refund.':'Only the owner records refunds.'));
}
function memberCard(row){
  const {h,button}=kit(),name=row.customerName||row.customerEmail||row.phone||row.subscriptionId;
  const candidates=row.candidates.length?h('ul',{class:'rv-candidates','aria-label':'Matching customers'},row.candidates.map(candidate=>h('li',{},
    h('div',{},h('strong',{},candidate.found?candidate.name||'Unnamed customer':'Customer record not found'),h('span',{},[candidate.phone,candidate.email].filter(Boolean).join(' · ')),candidate.address?h('span',{},candidate.address):null),
    candidate.found?button('Link to this customer',()=>linkMember(row,candidate)):null))):h('p',{class:'rv-muted'},'No Hub customer matched. Add or update the customer in the Hub first, or close the review.');
  return h('article',{class:'hub-card rv-card'},
    h('div',{class:'rv-card-head'},h('h3',{},name),h('span',{class:'rv-badge'},PLANS[row.plan]||'Garage Guard')),
    h('p',{class:'rv-reason'},(MEMBER_REASONS[row.reason]||'Needs a person to choose the customer')+'.'),
    h('p',{class:'rv-muted'},[row.customerEmail,row.phone].filter(Boolean).join(' · ')||'No contact details from Stripe'),
    row.serviceAddress?h('p',{class:'rv-muted'},row.serviceAddress):null,
    candidates,
    h('div',{class:'hub-actions rv-actions'},button('Close without linking',()=>dismissMember(row))));
}
function sendCard(row){
  const {h,button}=kit(),status=row.status==='uncertain'?'Outcome unknown':row.inFlight?'May still be sending':'Stuck while sending';
  return h('article',{class:'hub-card rv-card'},
    h('div',{class:'rv-card-head'},h('h3',{},row.label+' · '+(row.targetName||row.targetId||'Unknown record')),h('span',{class:'rv-badge '+(row.inFlight?'':'warn')},status)),
    h('p',{class:'rv-muted'},[row.channel,row.recipient,when(row.attemptedAt)?'tried '+when(row.attemptedAt):'',row.actorId?'by '+row.actorId:''].filter(Boolean).join(' · ')),
    row.excerpt?h('blockquote',{class:'rv-excerpt'},row.excerpt):null,
    row.inFlight?h('p',{class:'rv-muted'},'Wait '+(S.data.sends?.staleAfterMinutes||10)+' minutes from the attempt before reconciling; it may still reach the customer.'):null,
    h('div',{class:'hub-actions rv-actions'},button('Mark delivered',()=>reconcileSend(row,'delivered'),'primary',{disabled:row.inFlight}),button('Mark not delivered',()=>reconcileSend(row,'not_delivered'),'',{disabled:row.inFlight})));
}
function ownersOnly(what){
  const {h}=kit();
  return h('div',{class:'hub-notice rv-owners-only',role:'status'},h('strong',{},'Managers and the owner only'),h('p',{},what+' are resolved by an operations manager or the owner. Ask one of them to check this queue.'));
}
// HighLevel answered after a person reconciled the message: both answers stay on record.
function lateCard(row){
  const {h}=kit(),late=row.lateResult||{},delivered=row.reconciled?.outcome==='delivered',accepted=late.status==='submitted',differs=accepted?!delivered:late.status==='failed'?delivered:null;
  const answer=accepted?'HighLevel then accepted it'+(late.messageId?' (message '+late.messageId+')':''):late.status==='failed'?'HighLevel then refused it'+(late.httpStatus?' (HTTP '+late.httpStatus+')':''):'HighLevel’s later answer was unclear';
  return h('article',{class:'hub-card rv-card'},
    h('div',{class:'rv-card-head'},h('h3',{},row.label+' · '+(row.targetName||row.targetId||'Unknown record')),h('span',{class:'rv-badge '+(differs===false?'good':'warn')},differs===null?'Unclear answer':differs?'Differs from the reconcile':'Matches the reconcile')),
    h('p',{},'Marked '+(delivered?'delivered':'not delivered')+(row.reconciled?.by?' by '+row.reconciled.by:'')+(when(row.reconciled?.at)?' on '+when(row.reconciled.at):'')+'. '+answer+(when(late.at)?' on '+when(late.at):'')+'.'),
    accepted?h('p',{class:'rv-muted'},'It reached HighLevel, so it is never sent again.'):delivered?h('p',{class:'rv-muted'},'It still counts as sent. Check the HighLevel conversation; the customer may not have it.'):null);
}
function stripeSections(){
  const {h}=kit(),data=S.data.stripe;
  if(!data){const body=restricted('stripe')?ownersOnly('Held card payments and Garage Guard member matches'):S.errors.stripe?unavailable('stripe','Held Stripe payments and member matches'):loadingBlock('Stripe reviews');return[section('payments','Held card payments',null,body)];}
  const partial=data.coverage.complete?null:h('p',{class:'hub-notice warning'},'Showing the first reviews only; more are waiting. Resolve these, then refresh.');
  const payments=data.paymentReviews.length?h('div',{class:'rv-list'},data.paymentReviews.map(row=>paymentCard(row,data.viewer?.canRecordRefund===true))):h('p',{class:'rv-empty'},'No card payments are held for review.');
  const members=data.membershipReviews.length?h('div',{class:'rv-list'},data.membershipReviews.map(memberCard)):h('p',{class:'rv-empty'},'Every Garage Guard member is linked or closed.');
  return[
    section('payments','Held card payments',data.paymentReviews.length,[partial,payments],paymentNote(data)),
    section('members','Garage Guard member matches',data.membershipReviews.length,members),
  ];
}
// The block flag stops new checkouts on every job listed; a held tipped charge not on its job stops them while customer
// tips are on, and turning tips off lifts that stop, so the owner resolves those first.
function paymentNote(data){
  const {h}=kit(),tipped=data.paymentReviews.filter(row=>row.recordedOnJob!==true&&(row.tipCents===null||Number.isSafeInteger(row.tipCents)&&row.tipCents>0)).length;
  const notes=[data.checkoutBlock&&data.paymentReviews.length?'New card checkouts on these jobs are blocked until each review is resolved.':'',
    tipped?(tipped===1?'One held charge includes a crew tip':tipped+' held charges include a crew tip')+(data.checkoutBlock?'.':': while customer tips are on, no new card checkout opens on '+(tipped===1?'its job':'their jobs')+' until '+(tipped===1?'it is':'each is')+' resolved.')+' Resolve '+(tipped===1?'it':'them')+' before turning customer tips off.':''].filter(Boolean);
  return notes.length?h('p',{class:'rv-muted'},notes.join(' ')):null;
}
function sendSection(){
  const {h}=kit(),data=S.data.sends;
  if(!data)return section('messages','Messages with an unknown outcome',null,restricted('sends')?ownersOnly('Messages with an unknown outcome'):S.errors.sends?unavailable('sends','Messages with an unknown outcome'):loadingBlock('messages'));
  const partial=data.coverage.complete?null:h('p',{class:'hub-notice warning'},'Showing the first '+data.sends.length+' messages only; more are waiting. Reconcile these, then refresh.');
  const body=data.sends.length?h('div',{class:'rv-list'},data.sends.map(sendCard)):h('p',{class:'rv-empty'},'Every approved message has a known outcome.');
  const lates=list(data.lateResults)||[],days=Number.isSafeInteger(data.lateResultCoverage?.days)?data.lateResultCoverage.days:7;
  const late=lates.length?h('div',{class:'rv-late'},h('h3',{},'HighLevel answered after a person reconciled'),h('p',{class:'rv-muted'},'From the last '+plural(days,'day')+'. What the person recorded stays; HighLevel’s answer is shown beside it.'),h('div',{class:'rv-list'},lates.map(lateCard))):null;
  return section('messages','Messages with an unknown outcome',data.sends.length,[partial,body,late],h('p',{class:'rv-muted'},'Check the HighLevel conversation first. Nothing is ever resent from this screen.'));
}
function summary(){
  const {h}=kit(),stripe=S.data.stripe,sends=S.data.sends,parts=[];
  if(stripe)parts.push(plural(stripe.paymentReviews.length,'held payment'),stripe.membershipReviews.length+' member match'+(stripe.membershipReviews.length===1?'':'es'));
  if(sends)parts.push(plural(sends.sends.length,'unconfirmed message'));
  return parts.length?h('p',{class:'rv-summary',role:'status'},parts.join(' · ')):null;
}
function feedback(){
  const {h,button}=kit(),items=[];
  if(S.failure)items.push(h('div',{class:'hub-notice error',role:'alert'},h('strong',{},'The last change was not confirmed'),h('p',{},S.failure.message),h('div',{class:'hub-actions'},button('Retry original change',()=>void retrySaved(),'primary',{disabled:S.busy}),button('Discard it',discardSaved,'',{disabled:S.busy}))));
  else if(S.notice)items.push(h('p',{class:'hub-notice success'},S.notice));
  return h('div',{class:'rv-feedback','aria-live':'polite'},items);
}
function render(){
  if(!S.root||!kit())return;
  const {h,button}=kit();
  if(!S.failure&&pending()?.get())S.failure={message:'A change you made earlier was not confirmed. Retry it to check whether it saved, or discard it.'};
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'OWNER REVIEWS'),h('h1',{},'Review queues'),h('p',{},'What automation held for a person: card charges, Garage Guard member matches, messages with an unknown outcome and the insurance certificate. Nothing here charges, refunds or messages a customer.')),
    h('div',{class:'hub-actions'},button(S.loading?'Checking…':'Refresh',()=>void load(),'',{disabled:S.loading||S.busy}),button('Message templates',()=>S.ctx?.go?.('message_templates'))));
  S.root.replaceChildren(head,feedback(),summary(),insuranceAlert(),...stripeSections(),sendSection());
}
function mount(host,ctx={}){
  if(!host||!kit())return;
  if(S.host===host&&S.root?.isConnected)return;
  unmount();
  S.host=host;S.ctx=ctx;S.root=kit().h('div',{class:'hub-screen egc-reviews'});
  host.replaceChildren(S.root);
  render();void load();
}
function unmount(){closeDialog();S.generation++;S.root?.remove();Object.assign(S,{host:null,root:null,loading:false,busy:false,notice:'',failure:null,draft:null,next:null,data:{stripe:null,sends:null,insurance:null},errors:{}});}
window.addEventListener('egc:signout',()=>{const host=S.host;unmount();host?.replaceChildren();S.ctx=null;});
window.EGCReviews=Object.freeze({mount,unmount,refresh:()=>load(),canLeave:()=>!S.busy&&!(S.dialog&&S.dirty)});
})();
