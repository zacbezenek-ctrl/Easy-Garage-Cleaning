/* Booked jobs waiting for prices on the Hub home (owner and managers; EGC_QUOTE_BUILDER_ENABLED). Mounted by the
   home-widget registry (employee-hub-screens.js HOME_WIDGETS). Opening the home posts POST /api/held-jobs
   {action:'sweep'}: the first open after a pricing-menu change releases the signed jobs the menu now approves (their
   customers get the estimate and deposit request), later opens only count the jobs still held. The owner's
   "Release held jobs (N)" button runs the release on demand. Nothing shows while no job is held or released. */
(function(){
'use strict';
const S={host:null,ctx:{},generation:0,busy:false,state:null};
const kit=()=>window.EGCHubKit;
const fetcher=()=>typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const owner=()=>Array.isArray(S.ctx.capabilities)&&S.ctx.capabilities.includes('owner');
const count=value=>value===undefined||Number.isSafeInteger(value)&&value>=0;
const valid=data=>data?.enabled===false||data?.enabled===true&&Number.isSafeInteger(data.held)&&Array.isArray(data.released)&&typeof data.more==='boolean'&&count(data.signedAbove)&&count(data.stuck);
// The held jobs, told apart: signedAbove are signed above the approved price (rebuilt and signed again; no approval
// releases them), stuck could not be released automatically (the Release held jobs button tries again), the rest wait
// for prices. more: the count stopped at its cap, so the numbers are at least these ('+').
function heldLines(state,releaser,approver){
  const plus=state.more?'+':'',above=state.signedAbove||0,stuck=state.stuck||0,rest=Math.max(0,state.held-above-stuck),jobs=n=>`booked job${n===1?'':'s'}`;
  return[
    rest||state.more?`${rest}${plus} ${jobs(rest)} ${rest===1&&!plus?'still waits':'still wait'} for prices: an unapproved price on the quote, or a walkthrough-priced quote ${releaser} from the job.`:'',
    above?`${above} ${jobs(above)} ${above===1?'was':'were'} signed above the price ${approver}, so ${above===1?'it is':'they are'} not released: rebuild the quote and have the customer sign it again.`:'',
    stuck?`${stuck} ${jobs(stuck)} couldn't be released automatically after three tries: press Release held jobs to try again.`:'',
  ].filter(Boolean);
}

function render(){
  if(!S.host)return;
  const state=S.state,h=kit().h;
  if(!state||!state.held&&!state.released&&!state.error){S.host.replaceChildren();return;}
  const total=state.held+(state.more?'+':'');
  S.host.replaceChildren(h('section',{class:'hub-card egc-held-jobs','aria-labelledby':'hj-title'},
    h('h2',{id:'hj-title'},'Booked jobs waiting for prices'),
    state.released?h('p',{},`${state.released} booked job${state.released===1?' was':'s were'} released after the price menu changed: the customer${state.released===1?' gets its':'s get their'} estimate and deposit request.`):null,
    ...heldLines(state,'the owner releases','the owner approved').map(text=>h('p',{},text)),
    state.error?h('p',{class:'hub-notice error',role:'alert'},state.error):null,
    owner()&&state.held?h('div',{class:'hub-actions'},kit().button(`Release held jobs (${total})`,()=>void run('release'),'',{disabled:S.busy})):null));
}
async function run(action){
  if(!S.host||S.busy)return;
  const generation=S.generation;S.busy=action==='release';if(S.busy)render();
  try{
    const data=await kit().requestJSON('/api/held-jobs',{method:'POST',body:{action},prefix:'held_jobs',fetcher:fetcher(),validate:valid});
    if(generation!==S.generation)return;
    S.state=data.enabled?{held:data.held,released:data.released.length,more:data.more,signedAbove:data.signedAbove||0,stuck:data.stuck||0,error:''}:null;
  }catch(error){
    if(generation!==S.generation)return;
    // A manager cannot press the button and a refused sweep shows nothing new: the count is never shown as zero.
    S.state=[401,403].includes(Number(error?.status))&&action==='sweep'?null:{...(S.state||{held:0,released:0,more:false}),error:error?.message||'The held jobs could not be checked.'};
  }finally{if(generation===S.generation){S.busy=false;render();}}
}
window.EGCHeldJobsHome=Object.freeze({
  mount(host,ctx={}){S.host=host;S.ctx=ctx||{};S.generation++;S.state=null;S.busy=false;render();return run('sweep');},
  unmount(){S.generation++;S.host=null;S.state=null;},
  refresh(){return run('sweep');},
});
})();
