/* GUARD-SELL: Garage Guard sales in the Hub (owners and managers). "Sell Garage Guard" opens the same sales sheet the
   crew, estimators and door-to-door reps use (crew/guard-sell.js, channel 'hub'): pick the plan, the customer scans the
   code and pays on their own phone. Below it, the memberships staff sold and who sold each one, from
   GET /api/garage-guard-members (dispatcher only): the seller is kept on the membership record when Stripe confirms the
   payment (memberships are recorded while GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED is on). No commission is paid for Garage
   Guard, so no amount is shown for the seller. A customer's own record offers the same sheet pre-filled
   (employee-suite.js opsSellGuard). Registered in employee-hub-screens.js; runs with the UI kit (window.EGCHubKit). */
(function(){
'use strict';
const PATH='/api/garage-guard-members?period=ytd',PREFIX='guard_sales',TOOL='/crew/guard-sell.js?v=20261030guard1';
const CHANNELS={postjob:'Post-job playbook',walkthrough:'Walkthrough',knock:'Door to door',hub:'Hub'};
const PLANS={lite:'Guard Lite',guard:'Garage Guard',black:'Guard Black'};
const STATUS={active:'Active',past_due:'Payment failed',cancelled:'Cancelled',pending:'Paying'};
const S={host:null,ctx:null,data:null,error:null,loading:false,generation:0,toolError:''};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const day=value=>{const at=Date.parse(value||'');return Number.isFinite(at)?new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',month:'short',day:'numeric',year:'numeric'}).format(new Date(at)):'—';};
const valid=data=>Boolean(data&&data.ok===true&&Array.isArray(data.memberships));
let loadingTool=null;
function tool(){
  if(window.EGCGuardSell)return Promise.resolve(window.EGCGuardSell);
  return loadingTool||=new Promise((resolve,reject)=>{
    const tag=document.createElement('script');tag.src=TOOL;
    tag.onload=()=>window.EGCGuardSell?resolve(window.EGCGuardSell):reject(new Error('missing'));
    tag.onerror=()=>{tag.remove();reject(new Error('load'));};
    document.head.append(tag);
  }).catch(error=>{loadingTool=null;throw error;});
}
async function sell(){
  S.toolError='';render();
  try{(await tool()).open({channel:'hub',fetch:fetcher(),onClose:result=>{if(result.member)load();}});}
  catch{S.toolError='The Garage Guard sign-up could not load. Check the connection and try again.';render();}
}
async function load(){
  const generation=++S.generation;S.loading=true;S.error=null;render();
  try{const data=await kit().requestJSON(PATH,{prefix:PREFIX,validate:valid,fetcher:fetcher()});if(generation===S.generation)S.data=data;}
  catch(error){if(generation===S.generation)S.error=error;}
  finally{if(generation===S.generation){S.loading=false;render();}}
}
function salesTable(rows){
  if(!rows.length)return h('p',{class:'gs-muted'},'No staff sales recorded yet. A sale shows here once the customer has paid and Stripe has told the Hub.');
  const cell=(label,...children)=>h('td',{'data-label':label},...children);
  return h('div',{class:'gs-table-wrap'},h('table',{class:'gs-table'},
    h('thead',{},h('tr',{},...['Customer','Plan','Status','Sold by','Where','Sold on'].map(label=>h('th',{scope:'col'},label)))),
    h('tbody',{},...rows.map(row=>h('tr',{'data-membership':row.subscriptionId},
      h('th',{scope:'row','data-label':'Customer'},row.customerName||'Unnamed member'),
      cell('Plan',PLANS[row.plan]||row.plan||'—'),
      cell('Status',STATUS[row.status]||row.status||'—'),
      cell('Sold by',row.soldBy.staffKey),
      cell('Where',CHANNELS[row.soldBy.channel]||row.soldBy.channel||'—'),
      cell('Sold on',day(row.soldBy.at||row.startedAt)))))));
}
function render(){
  if(!S.host)return;
  const sold=S.data?S.data.memberships.filter(row=>row&&row.soldBy&&typeof row.soldBy.staffKey==='string').sort((a,b)=>String(b.soldBy.at||'').localeCompare(String(a.soldBy.at||''))):[];
  const other=S.data?S.data.memberships.length-sold.length:0;
  const forbidden=[401,403].includes(Number(S.error?.status));
  S.host.replaceChildren(h('div',{class:'hub-screen gs-screen'},
    h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'GARAGE GUARD'),h('h1',{},'Garage Guard sales'),
      h('p',{},'Sign a customer up on the spot: pick the plan, they scan the code and pay on their own phone. Each sale records who sold it. No commission is paid for Garage Guard.'))),
    h('section',{class:'hub-card gs-sell'},
      h('h2',{},'Sell a membership'),
      h('p',{class:'gs-muted'},'To fill in a customer’s email and address, open their record under Customers and use Sell Garage Guard there.'),
      kit().button('Sell Garage Guard',sell,'primary',{'data-guard-sell':'1'}),
      S.toolError?h('p',{class:'hub-notice error',role:'alert'},S.toolError):null),
    h('section',{class:'hub-card gs-sold','aria-labelledby':'gs-sold-title'},
      h('h2',{id:'gs-sold-title'},`Sold by staff${sold.length?` (${sold.length})`:''}`),
      S.loading&&!S.data?h('p',{class:'gs-muted',role:'status'},'Loading memberships…')
        :forbidden?h('p',{class:'gs-muted'},'Owners and managers see who sold each membership.')
        :S.error?h('div',{},h('p',{class:'hub-notice error',role:'alert'},S.error.message||'Memberships could not be loaded.'),kit().button('Try again',load))
        :h('div',{},salesTable(sold),other?h('p',{class:'gs-muted'},`${other} other membership${other===1?'':'s'} came from the public Garage Guard page.`):null))));
}
window.EGCGuardSales=Object.freeze({
  mount(host,ctx={}){S.host=host;S.ctx=ctx||{};S.data=null;S.error=null;S.toolError='';render();return load();},
  unmount(){S.generation++;S.host=null;S.data=null;window.EGCGuardSell?.close?.();},
  canLeave(){return true;},
  refresh(){return load();},
});
})();
