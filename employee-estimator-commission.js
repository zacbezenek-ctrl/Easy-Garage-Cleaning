/* My commission (D6b): the signed-in estimator's own 7%, read only. One row per walkthrough they sold directly (signed in
   the Hub) or took from a door-to-door rep, with its state and their share: projected while the job is closed but not
   paid in full, earned once it is. Until the owner approves the walkthrough-setting and estimator terms it says so and
   shows no amount. GET /api/estimator-commission (functions/api/estimator-commission.js); never another employee's
   pay, a setter or a customer. Registered in employee-hub-screens.js and runs on the UI kit (window.EGCHubKit). */
(function(){
'use strict';
const PATH='/api/estimator-commission';
const S={host:null,ctx:null,data:null,error:null,loading:false,generation:0};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const ERRORS={estimator_commission_sign_in:'Sign in again to see your commission.',estimator_commission_unavailable:'Your commission could not be loaded. Retry in a moment.'};
const STATES={earned:'Earned',awaiting_completion:'Not earned yet — job not complete',awaiting_collection:'Waiting for full payment',awaiting_close:'Quote not accepted yet',review_required:'Held for review',excluded:'No commission',no_show:'No-show',cancelled:'Cancelled',lost:'Not sold'};
const REASONS={commission_terms_unapproved:'the owner has not approved the terms yet',service_scope_unverified:'the office has not confirmed it is garage work',collection_unverified:'a payment is not verified yet',partial_collection_policy_unconfigured:'the payment does not match the price',cancellation_review:'the job was cancelled',recipient_unverified:'the estimator is not confirmed',recipient_overlap_review:'the setter and estimator are the same person',payroll_anchor_unconfigured:'the owner has not approved the terms yet',calculation_base_unconfigured:'the owner has not approved the terms yet',
  // Owner decision 2026-10-30: earned at job completion; a quote approved online within 30 days of the walkthrough pays.
  job_not_complete:'the job is not complete yet',balance_due:'the customer still owes the balance',approved_after_30_days:'the quote was approved more than 30 days after the walkthrough',
  walkthrough_date_unverified:'the walkthrough date is missing',walkthrough_unverified:'the walkthrough could not be read',refund_review:'a refund came before the share was earned',refund_unverified:'a refund is missing its amount or date'};
const dollars=value=>Number.isFinite(value)?kit().money(Math.round(value*100)):'—';
const valid=data=>Boolean(data&&data.ok===true&&data.terms&&typeof data.terms.verified==='boolean'&&Array.isArray(data.rows)&&data.totals&&data.rows.every(row=>row&&typeof row.id==='string'&&typeof row.state==='string'&&Array.isArray(row.reviewReasons)));
const dayLabel=date=>{try{return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z'));}catch{return date;}};
async function load(){
  const generation=++S.generation;
  S.loading=true;S.error=null;render();
  try{
    const data=await kit().requestJSON(PATH,{prefix:'estimator_commission',validate:valid,fetcher:fetcher()});
    if(generation!==S.generation)return;
    S.data=data;
  }catch(error){if(generation===S.generation)S.error=error;}
  finally{if(generation===S.generation){S.loading=false;render();}}
}
function share(row){
  // A refund or cancellation after it was earned takes part of it back on a later statement (clawedBackCommission).
  if(row.state==='earned')return `${dollars(row.earnedCommission)} earned${row.clawedBackCommission>0?`, ${dollars(row.clawedBackCommission)} taken back`:''}`;
  if(Number.isFinite(row.projectedCommission))return `${dollars(row.projectedCommission)} once ${row.state==='awaiting_completion'?'the job is done and ':''}paid in full`;
  return row.earnedCommission===0?dollars(0):'No amount yet';
}
function rowNode(row){
  const reasons=[...new Set(row.reviewReasons.map(code=>REASONS[code]||code.replaceAll('_',' ')))];
  return h('li',{class:'ec-row','data-row':row.id},
    h('div',{class:'ec-row-text'},
      h('strong',{},row.jobDate?dayLabel(row.jobDate):'Job date not set'),
      h('small',{},row.channel==='door_to_door'?'Set at the door by a door-to-door rep':'Your walkthrough sale'),
      reasons.length?h('small',{class:'ec-reasons'},`Held: ${reasons.join('; ')}.`):null),
    h('div',{class:'ec-amount'},h('span',{class:`ec-state ${row.state}`},STATES[row.state]||row.state.replaceAll('_',' ')),h('span',{class:'ec-share'},share(row))));
}
function render(){
  const host=S.host;if(!host)return;
  const percent=S.data?.terms?.percent||7;
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'Estimator commission'),h('h2',{},'My commission'),
    h('p',{},`${percent}% of each walkthrough you sell, whether you sold it yourself or a door-to-door rep set it. It is earned once the customer has paid the whole price, goods included, and paid every two weeks. Read only; the office keeps the pay records.`)));
  if(!S.data){
    host.replaceChildren(h('div',{class:'hub-screen egc-commission'},head,S.error?h('div',{class:'hub-notice error',role:'alert'},h('strong',{},'Your commission is unavailable'),h('p',{},kit().errorText(S.error,ERRORS)),h('div',{class:'hub-actions'},kit().button('Retry',()=>load(),'primary')))
      :h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading your commission…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}))));
    return;
  }
  const {terms,rows,totals}=S.data;
  host.replaceChildren(h('div',{class:'hub-screen egc-commission'},head,
    terms.verified?null:h('p',{class:'hub-notice'},'Not approved yet: the owner has not approved the estimator terms, so nothing is earned or payable and no amount is shown. Your walkthrough sales are listed so you can check them.'),
    terms.verified?h('div',{class:'ec-totals'},h('div',{},h('span',{},'Earned'),h('strong',{},dollars(totals.earned))),h('div',{},h('span',{},'Projected'),h('strong',{},dollars(totals.projected)))):null,
    h('div',{class:'hub-actions'},kit().button('Refresh',()=>load(),'',{disabled:S.loading})),
    S.error?h('p',{class:'hub-notice error',role:'alert'},kit().errorText(S.error,ERRORS)):null,
    rows.length?h('ul',{class:'ec-rows'},rows.map(rowNode)):h('p',{class:'hub-notice'},'No walkthrough sales yet. Walkthroughs you sign in the Hub, and ones door-to-door reps set for you, show here.'),
    S.data.truncated?h('p',{class:'hub-notice'},'Some door-to-door records could not all be read; the office is reviewing them.'):null,
    S.loading?h('p',{class:'ec-refresh',role:'status'},'Refreshing…'):null));
}
function mount(host,ctx={}){S.host=host;S.ctx=ctx;render();return load();}
function unmount(){S.generation++;S.host?.replaceChildren();S.host=null;S.ctx=null;S.data=null;S.error=null;S.loading=false;}
window.addEventListener('egc:signout',()=>unmount());
window.EGCEstimatorCommission=Object.freeze({mount,unmount,refresh:()=>S.host?load():Promise.resolve(),canLeave:()=>true});
})();
