/* MANAGER-SLIP-ALERTS: a Hub browser alert for the owner and managers when one of today's crews slips (late, not en
   route, not clocked in). The slips are the Command center Field agenda flags (employee-arrival-deadline.js, #194);
   employee-suite.js hands this file the flagged visits (flaggedToday) after each Hub refresh and once a minute while
   the tab is hidden, and only when the server said this viewer gets them (GET /api/employee-hub slipAlerts:
   EGC_MANAGER_SLIP_ALERTS is exactly "true" and the viewer runs dispatch). Staff only: nothing here reaches a customer
   or HighLevel, and the text carries no money.
   - At most one alert per job, per slip kind, per Denver day on this device: the keys shown are saved (before anything
     is shown) under egc_slip_alerts_seen, and only today's keys are kept.
   - None once that visit's crew is en route or on site (EGCArrivalDeadline.underway), whatever the flags say.
   - Not clocked in is alerted only from fresh time entries (clockInsFresh): a hidden tab stops reading them.
   - A refresh shows at most LIMIT alerts; the rest wait for the next check rather than being dropped.
   - Tapping an alert opens the Field agenda on that job's row (open(jobId); focusRow finds the row by its [data-agenda-job]).
   Alerts follow the Hub alert path #212 made safe: every step is caught, so an alert can never fail a refresh. The page
   is open whenever this runs, so the page Notification goes first (its tap is handled here); where the constructor
   throws (Chrome for Android) the service worker registration shows it, with data {view:'today', job}. */
(function(root){
'use strict';
const KEY='egc_slip_alerts_seen',LIMIT=5,KINDS=['late','not_en_route','not_clocked_in'];
const TIME=new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',hour:'numeric',minute:'2-digit'});
const timeOf=ms=>Number.isFinite(ms)?TIME.format(new Date(ms)):'';
const text=(value,max)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);
function message(visit,flag,rule){
  const who=text(visit.customer||visit.title,80)||'a job',start=timeOf(rule.startAt?.(visit));
  if(flag.kind==='late'){const due=timeOf(rule.arrivalDeadline?.(visit));return{title:`Crew late: ${who}`,body:`${due?`Due by ${due}`:'Past its arrival time'} and not arrived. Tap to open the Field agenda.`}}
  if(flag.kind==='not_en_route')return{title:`Not en route: ${who}`,body:`${start?`Starts ${start}`:'Starts soon'} and the crew has not left. Tap to open the Field agenda.`};
  const members=(Array.isArray(flag.members)?flag.members:[]).map(name=>text(name,40)).filter(Boolean);
  return{title:`Not clocked in: ${who}`,body:`${members.length?members.join(', '):'A crew member'} not clocked in${start?` for the ${start} start`:''}. Tap to open the Field agenda.`};
}
/* pending({visits,now,seen,rule,clockInsFresh}) → [{key,jobId,kind,title,body}], earliest-visit order kept.
   visits: [{visit,flags}] (employee-suite.js flaggedToday). seen: keys already alerted. */
function pending({visits=[],now,seen=[],rule=root.EGCArrivalDeadline,clockInsFresh=true}={}){
  const nowMs=typeof now==='number'?now:Date.parse(now);
  if(!rule||!Number.isFinite(nowMs))return[];
  const date=rule.denverDate(nowMs),done=new Set(seen),out=[];
  for(const row of Array.isArray(visits)?visits:[]){
    const visit=row?.visit,jobId=typeof visit?.id==='string'?visit.id:'';
    if(!jobId||visit.date!==date)continue;
    try{if(rule.underway?.(visit,{now:nowMs}))continue}catch{continue}
    for(const flag of Array.isArray(row.flags)?row.flags:[]){
      if(!KINDS.includes(flag?.kind)||flag.kind==='not_clocked_in'&&!clockInsFresh)continue;
      const key=`${date}|${jobId}|${flag.kind}`;
      if(done.has(key))continue;
      done.add(key);out.push({key,jobId,kind:flag.kind,...message(visit,flag,rule)});
    }
  }
  return out;
}
function readSeen(storage){try{const list=JSON.parse(storage?.getItem(KEY)||'[]');return Array.isArray(list)?list.filter(key=>typeof key==='string'):[]}catch{return[]}}
function writeSeen(storage,list){try{storage?.setItem(KEY,JSON.stringify(list))}catch{}}
// The default delivery: the page Notification (tap handled here), else the service worker registration.
function deliver(title,options,onTap){
  const worker=()=>{try{const sw=root.navigator?.serviceWorker;if(typeof sw?.getRegistration!=='function')return;Promise.resolve().then(()=>sw.getRegistration()).then(reg=>typeof reg?.showNotification==='function'?reg.showNotification(title,options):null).catch(()=>{})}catch{}};
  try{
    const Alert=root.Notification;if(typeof Alert!=='function')return worker();
    const shown=new Alert(title,options);
    shown.onclick=()=>{try{root.focus?.()}catch{}try{shown.close?.()}catch{}try{onTap()}catch{}};
  }catch{worker()}
}
/* check({visits,now,storage,show,open,rule,clockInsFresh}) → the alerts shown. The seen keys are saved first, so a
   delivery that throws is not repeated every refresh. */
function check({visits,now,storage=root.localStorage,show=deliver,open=()=>{},rule=root.EGCArrivalDeadline,clockInsFresh=true}={}){
  const nowMs=typeof now==='number'?now:Date.parse(now);
  if(!rule||!Number.isFinite(nowMs))return[];
  const date=rule.denverDate(nowMs),seen=readSeen(storage).filter(key=>key.startsWith(date+'|'));
  const fresh=pending({visits,now:nowMs,seen,rule,clockInsFresh}).slice(0,LIMIT);
  writeSeen(storage,[...seen,...fresh.map(row=>row.key)].slice(-300));
  for(const row of fresh)try{show(row.title,{body:row.body,tag:'egc-slip-'+row.key,data:{view:'today',job:row.jobId}},()=>open(row.jobId))}catch{}
  return fresh;
}
// The Field agenda row for a job: highlighted, scrolled to and focused. Retries while the Today screen renders.
function focusRow(jobId,{doc=root.document,tries=20,wait=(fn,ms)=>root.setTimeout?.(fn,ms)}={}){
  if(!jobId||typeof doc?.querySelectorAll!=='function')return false;
  const row=[...doc.querySelectorAll('[data-agenda-job]')].find(node=>node.getAttribute('data-agenda-job')===jobId);
  if(!row){if(tries>0)wait(()=>focusRow(jobId,{doc,tries:tries-1,wait}),150);return false}
  const card=row.closest?.('article')||row;
  for(const node of doc.querySelectorAll('.ops-agenda-focus'))node.classList.remove('ops-agenda-focus');
  card.classList.add('ops-agenda-focus');card.scrollIntoView?.({block:'center'});(card.querySelector('a,button')||card).focus?.({preventScroll:true});
  return true;
}
root.EGCSlipAlerts=Object.freeze({pending,check,deliver,focusRow,KEY,LIMIT});
})(typeof window!=='undefined'?window:globalThis);
