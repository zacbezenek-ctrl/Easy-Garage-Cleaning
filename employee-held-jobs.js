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
const valid=data=>data?.enabled===false||data?.enabled===true&&Number.isSafeInteger(data.held)&&Array.isArray(data.released)&&typeof data.more==='boolean';
function render(){
  if(!S.host)return;
  const state=S.state,h=kit().h;
  if(!state||!state.held&&!state.released&&!state.error){S.host.replaceChildren();return;}
  const count=state.held+(state.more?'+':'');
  S.host.replaceChildren(h('section',{class:'hub-card egc-held-jobs','aria-labelledby':'hj-title'},
    h('h2',{id:'hj-title'},'Booked jobs waiting for prices'),
    state.released?h('p',{},`${state.released} booked job${state.released===1?' was':'s were'} released after the price menu changed: the customer${state.released===1?' gets its':'s get their'} estimate and deposit request.`):null,
    state.held?h('p',{},`${count} booked job${state.held===1&&!state.more?' still waits':'s still wait'} for prices: an unapproved price on the quote, or a walkthrough-priced quote the owner releases from the job.`):null,
    state.error?h('p',{class:'hub-notice error',role:'alert'},state.error):null,
    owner()&&state.held?h('div',{class:'hub-actions'},kit().button(`Release held jobs (${count})`,()=>void run('release'),'',{disabled:S.busy})):null));
}
async function run(action){
  if(!S.host||S.busy)return;
  const generation=S.generation;S.busy=action==='release';if(S.busy)render();
  try{
    const data=await kit().requestJSON('/api/held-jobs',{method:'POST',body:{action},prefix:'held_jobs',fetcher:fetcher(),validate:valid});
    if(generation!==S.generation)return;
    S.state=data.enabled?{held:data.held,released:data.released.length,more:data.more,error:''}:null;
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
