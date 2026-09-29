/* WT-OUTCOME: where a walkthrough stands, for the lists built from raw Hub rows (the Hub's Today agenda and the
   gameplan's Today list). The server rule is functions/_lib/walkthrough-state.js; a row that already carries the
   server's walkthroughState (a dispatch or crew DTO) is taken as it is. tests/wt-outcome.test.mjs runs both rules on
   the same rows. A closed walkthrough (converted job, final outcome or walkthroughCompletedAt) and a no-show waiting
   for its rebook show a badge and a link, never Start. */
(function(root){
'use strict';
const FINAL=new Set(['sold_on_site','quote_to_follow','not_interested']),REBOOKABLE=new Set(['customer_no_show','rescheduled']);
const CLOSED=new Set(['sold','quote','lost','done']),CANCELLED=new Set(['cancelled','canceled','noshow','no_show','no-show']);
const STATES=new Set(['open','no_show','rescheduled','sold','quote','lost','done','cancelled']);
const LOST={price:'Price',timing:'Timing',chose_competitor:'Chose a competitor',diy:'Doing it themselves',no_response:'No response',not_a_fit:'Not a fit for us',other:'Other',other_legacy:'Other'};
const BADGES={sold:'Sold → open job',quote:'Quote to follow',done:'Walkthrough done',cancelled:'Cancelled',no_show:'No-show · rebook',rescheduled:'Rescheduled · rebook',open:''};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!/^(?:secure_|_egc_)/.test(value);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
// The saved no-show or reschedule belongs to an earlier occurrence: Dispatch has since moved the visit.
function rebooked(job){
  if(typeof job.rebookPending==='boolean')return job.rebookPending;
  const outcome=plain(job.walkthroughOutcome)?job.walkthroughOutcome:null,at=outcome&&outcome.occurrence;
  if(!outcome||!REBOOKABLE.has(outcome.outcome)||!plain(at))return false;
  const date=validDate(job.date)?job.date:null,time=typeof job.time==='string'&&/^\d\d:\d\d$/.test(job.time)?job.time:null;
  if(!date||!time)return false;
  const counter=Number.isInteger(job.scheduleOccurrence)&&job.scheduleOccurrence>=1&&job.scheduleOccurrence<=1000?job.scheduleOccurrence:null;
  return date!==at.date||time!==at.time||counter!==null&&Number.isInteger(at.scheduleOccurrence)&&counter!==at.scheduleOccurrence;
}
/** {state, closed, badge, rebookPending} for a walkthrough row; null for any other row. */
function status(job){
  if(!plain(job)||job.type!=='walkthrough')return null;
  if(STATES.has(job.walkthroughState))return{state:job.walkthroughState,closed:CLOSED.has(job.walkthroughState),badge:typeof job.walkthroughBadge==='string'?job.walkthroughBadge:'',rebookPending:job.rebookPending===true};
  const outcome=plain(job.walkthroughOutcome)?job.walkthroughOutcome:null,pending=rebooked(job),current=outcome&&!pending?outcome.outcome:'';
  const stage=String(job.pipelineStatus||job.status||'').toLowerCase(),done=FINAL.has(outcome&&outcome.outcome)||typeof job.walkthroughCompletedAt==='string'&&Boolean(job.walkthroughCompletedAt.trim());
  const state=safeId(job.convertedJobId)||current==='sold_on_site'?'sold':current==='not_interested'?'lost':current==='quote_to_follow'?'quote':done?'done':CANCELLED.has(stage)?'cancelled':current==='customer_no_show'?'no_show':current==='rescheduled'?'rescheduled':'open';
  const reason=state==='lost'?LOST[outcome.reasonCode]||'':'';
  return{state,closed:CLOSED.has(state),badge:state==='lost'?(reason?'Lost: '+reason:'Lost'):BADGES[state],rebookPending:pending};
}
/** Where a list sends the viewer: Start for an open walkthrough, else its badge and a link to the job or the walkthrough.
 * jobLink false (a rep, who is usually not on the sold job) opens the sold walkthrough instead of its job, as crew home does. */
function action(job,{jobLink=true}={}){
  const current=status(job);if(!current)return null;
  const walkthrough='/crew/gameplan.html?walkthroughId='+encodeURIComponent(job.id);
  if(current.state==='open')return{href:walkthrough,label:'Start walkthrough',badge:'',state:'open'};
  if(current.state==='sold'&&jobLink&&safeId(job.convertedJobId))return{href:'/crew/job.html?jobId='+encodeURIComponent(job.convertedJobId),label:'Open job',badge:current.badge,state:'sold'};
  return{href:walkthrough,label:'Open walkthrough',badge:current.badge,state:current.state};
}
root.EGCWalkthroughState=Object.freeze({status,action});
})(typeof window!=='undefined'?window:globalThis);
