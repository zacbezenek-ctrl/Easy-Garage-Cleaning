/* Open quotes (owner and managers, read only): every estimator quote that is out with the customer and not yet approved
   or signed, oldest first, in age buckets (0–2, 3–7, 8–14, 15+ days and expired) with counts and dollar totals, and each
   estimator's close rate over the last 30 and 90 days. The server computes every figure (functions/_lib/open-quotes.js,
   GET /api/open-quotes, business access only); this screen only formats them. It sends nothing to customers or
   HighLevel. Its one action, "Copy customer portal link", copies the customer's portal link from the existing
   POST /api/customer-portal-link (business access). Customer names are rendered as text nodes through the kit's h(), never as HTML.
   Registered in employee-hub-screens.js and runs standalone with the UI kit (window.EGCHubKit). */
(function(){
'use strict';
const PATH='/api/open-quotes',PREFIX='open_quotes',LINK='/api/customer-portal-link';
const BUCKET_IDS=['fresh','warm','cooling','cold','expired'];
const S={host:null,ctx:null,data:null,error:null,loading:false,generation:0,copying:'',feedback:'',feedbackError:false};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const int=value=>Number.isSafeInteger(value);
const money=value=>int(value)?kit().money(value):'—';
const pct=value=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(1)+'%':'—';
const days=value=>typeof value==='number'&&Number.isFinite(value)?`${value} day${value===1?'':'s'}`:'—';
const day=value=>{try{return value?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(value+'T12:00:00Z')):'—';}catch{return'—';}};
const who=value=>typeof value==='string'&&value?value:'Unknown';
const validRow=r=>Boolean(r&&typeof r.jobId==='string'&&typeof r.customer==='string'&&(r.totalCents===null||int(r.totalCents))&&typeof r.sentDay==='string'&&int(r.ageDays)&&typeof r.expired==='boolean'&&BUCKET_IDS.includes(r.bucket)&&[true,false,null].includes(r.draftPricesWaiting));
const validRates=t=>Boolean(t&&typeof t.from==='string'&&Array.isArray(t.estimators)&&t.total&&int(t.total.sent)&&int(t.total.closed));
const valid=d=>Boolean(d&&d.ok===true&&d.window&&Array.isArray(d.buckets)&&d.buckets.length===BUCKET_IDS.length&&d.buckets.every(b=>BUCKET_IDS.includes(b.id)&&int(b.count)&&int(b.totalCents))&&Array.isArray(d.rows)&&d.rows.every(validRow)&&d.closeRates&&validRates(d.closeRates.last30)&&validRates(d.closeRates.last90));
async function load(){
  const generation=++S.generation;S.loading=true;S.error=null;render();
  try{const data=await kit().requestJSON(PATH,{prefix:PREFIX,validate:valid,fetcher:fetcher()});if(generation===S.generation)S.data=data;}
  catch(error){if(generation===S.generation)S.error=error;}
  finally{if(generation===S.generation){S.loading=false;render();}}
}
async function copyText(text){
  try{await navigator.clipboard.writeText(text);return true;}
  catch{
    const field=document.createElement('textarea');field.value=text;field.readOnly=true;field.setAttribute('aria-label','Private customer portal link');field.style.cssText='position:fixed;left:-9999px;top:0';
    document.body.append(field);field.select();let copied=false;try{copied=document.execCommand('copy');}catch{}field.remove();return copied;
  }
}
// The same request the Hub's other "Copy customer portal" buttons make; the server checks business access. Nothing is
// sent to the customer.
async function copyPortal(row){
  if(S.copying)return;
  S.copying=row.jobId;S.feedback='';render();
  try{
    const send=fetcher()||((url,options)=>fetch(url,{credentials:'same-origin',...options}));
    const response=await send(LINK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job_id:row.jobId})});
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result?.ok||typeof result.url!=='string')throw new Error(result?.error||'The portal link could not be created.');
    const copied=await copyText(result.url);
    S.feedback=copied?`Private portal link copied for ${row.customer||'the customer'}. Nothing was sent to them.`:'The link was created but could not be copied. Try again in a secure browser.';S.feedbackError=!copied;
  }catch(error){S.feedback=error?.message||'The portal link could not be created.';S.feedbackError=true;}
  finally{S.copying='';render();}
}
function bucketCard(b){
  return h('div',{class:'oq-bucket oq-bucket-'+b.id,'data-bucket':b.id},
    h('span',{class:'oq-bucket-label'},b.label),
    h('strong',{},String(b.count)),
    h('small',{},money(b.totalCents)+(b.unpricedCount?` · ${b.unpricedCount} unpriced`:'')));
}
function quoteRow(r){
  const cell=(label,cls,...children)=>h('td',{'data-label':label,class:cls},h('span',{class:'oq-cell'},...children));
  const prices=r.draftPricesWaiting===true?h('span',{class:'oq-flag'},'Waiting for owner'):r.draftPricesWaiting===null?'Unknown':'No';
  const valid=r.validUntil?day(r.validUntil):'—',validNote=r.expired?h('small',{class:'oq-expired'},'Expired'):int(r.daysLeft)?h('small',{},`${r.daysLeft} day${r.daysLeft===1?'':'s'} left`):null;
  const links=[h('a',{href:`/crew/job.html?jobId=${encodeURIComponent(r.jobId)}`},'Job')];
  if(r.walkthroughId)links.push(h('a',{href:`/crew/gameplan.html?walkthroughId=${encodeURIComponent(r.walkthroughId)}`},'Walkthrough'));
  return h('tr',{'data-quote':r.jobId,class:'oq-'+r.bucket},
    h('th',{scope:'row','data-label':'Customer'},h('span',{class:'oq-cell'},r.customer||'Unnamed customer')),
    cell('Estimator','',who(r.estimator)),
    cell('Total','num',money(r.totalCents)),
    cell('Sent','',day(r.sentDay)),
    cell('Age','num',days(r.ageDays)),
    cell('Valid until','',valid,validNote),
    cell('Draft prices','',prices),
    cell('Open','oq-links',...links),
    cell('Action','oq-action',kit().button(S.copying===r.jobId?'Creating link…':'Copy customer portal link',()=>copyPortal(r),'',{disabled:Boolean(S.copying),'data-copy':r.jobId})));
}
function quotesTable(){
  const rows=S.data.rows;
  if(!rows.length)return h('section',{class:'hub-card oq-quotes','aria-label':'Open quotes'},h('h2',{},'Open quotes'),h('p',{class:'oq-muted'},'No sent quote is waiting on a customer right now.'));
  return h('section',{class:'hub-card oq-quotes','aria-label':'Open quotes'},
    h('h2',{},`Open quotes (${rows.length})`),
    h('p',{class:'oq-muted'},'Oldest first. Age counts days since the quote was last sent. Quotes sent more than 120 days ago are not listed: every one of them has expired.'),
    h('div',{class:'hub-table-scroll oq-table-scroll'},h('table',{class:'oq-table'},
      h('thead',{},h('tr',{},['Customer','Estimator','Total','Sent','Age','Valid until','Draft prices','Open','Action'].map(text=>h('th',{scope:'col'},text)))),
      h('tbody',{},rows.map(quoteRow)))));
}
function ratesTable(title,t){
  const line=(r,total)=>h('tr',{'data-estimator':total?'__total':who(r.estimator),class:total?'oq-total':''},
    h('th',{scope:'row','data-label':'Estimator'},h('span',{class:'oq-cell'},total?'All estimators':who(r.estimator))),
    h('td',{'data-label':'Sent','class':'num'},h('span',{class:'oq-cell'},String(r.sent),r.signedOnSite?h('small',{},`${r.signedOnSite} signed on site`):null)),
    h('td',{'data-label':'Closed','class':'num'},h('span',{class:'oq-cell'},String(r.closed))),
    h('td',{'data-label':'Close %','class':'num'},h('span',{class:'oq-cell'},pct(r.closePercent))),
    h('td',{'data-label':'Avg days to close','class':'num'},h('span',{class:'oq-cell'},r.averageDaysToClose===null?'—':r.averageDaysToClose.toFixed(1),r.averageDaysToCloseSent!==null&&r.signedOnSite?h('small',{},`${r.averageDaysToCloseSent.toFixed(1)} on sent quotes`):null)));
  return h('section',{class:'hub-card oq-rates','aria-label':title,'data-window':title},
    h('h2',{},title),
    t.estimators.length?h('div',{class:'hub-table-scroll oq-table-scroll'},h('table',{class:'oq-table oq-rate-table'},
      h('thead',{},h('tr',{},['Estimator','Sent','Closed','Close %','Avg days to close'].map(text=>h('th',{scope:'col'},text)))),
      h('tbody',{},t.estimators.map(r=>line(r,false)),t.estimators.length>1?line(t.total,true):null))):h('p',{class:'oq-muted'},'No quotes sent or signed in this window.'));
}
function render(){
  if(!S.host)return;
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'OFFICE'),h('h1',{},'Open quotes'),h('p',{},'Sent quotes the customer has not approved or signed yet, and each estimator\'s close rate. Read only: nothing here is sent to a customer.')),
    h('div',{class:'hub-actions'},kit().button(S.loading?'Loading…':'Refresh',load,'',{disabled:S.loading})));
  let body;
  if(S.error&&!S.data)body=[h('div',{class:'hub-notice error',role:'alert'},'Open quotes are unavailable. '+kit().errorText(S.error)),kit().button('Retry',load,'primary')];
  else if(!S.data)body=[h('p',{class:'hub-screen-loading'},'Loading open quotes…')];
  else{
    const d=S.data,notices=[];
    if(d.sources?.prices==='unavailable')notices.push(h('div',{class:'hub-notice warning'},'The owner\'s price approvals could not be read, so "Draft prices" shows Unknown on builder quotes. Refresh to try again.'));
    if(S.error)notices.push(h('div',{class:'hub-notice error',role:'alert'},kit().errorText(S.error)));
    body=[...notices,
      h('section',{class:'hub-card oq-summary','aria-label':'Open quotes by age'},
        h('h2',{},'By age'),
        h('p',{class:'oq-muted'},`${d.totals.count} open quote${d.totals.count===1?'':'s'} worth ${money(d.totals.totalCents)}.`),
        h('div',{class:'oq-buckets'},d.buckets.map(bucketCard))),
      S.feedback?h('p',{role:S.feedbackError?'alert':'status',class:'oq-feedback'+(S.feedbackError?' error':'')},S.feedback):null,
      quotesTable(),
      h('div',{class:'oq-rates-grid'},ratesTable('Close rate, last 30 days',d.closeRates.last30),ratesTable('Close rate, last 90 days',d.closeRates.last90)),
      h('p',{class:'oq-muted oq-rate-note'},'Quotes are counted by the day they were sent. A walkthrough the customer signed on site counts as a quote sent and closed the same day (0 days), which raises the close rate and lowers the average days to close. Quotes sent recently that are still open count as not closed yet.')];
  }
  const root=h('section',{class:'hub-screen egc-open-quotes'},head,...body);
  S.host.querySelector('.egc-open-quotes')?.remove();
  S.host.append(root);
}
function mount(host,ctx){S.host=host;S.ctx=ctx||{};S.data=null;S.error=null;S.feedback='';S.copying='';return load();}
function unmount(){S.generation++;S.host?.querySelector('.egc-open-quotes')?.remove();S.host=null;S.ctx=null;}
window.EGCOpenQuotes={mount,unmount,canLeave:()=>true,refresh:load};
})();
