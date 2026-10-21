/* FIELD-FLAGS: when today's crew is late, not en route or not clocked in, for the Hub's Today agenda (employee-suite.js).
   One pure rule with an injected clock, run as a classic script in the Hub (window.EGCArrivalDeadline) and imported on
   the server through functions/_lib/arrival-deadline.js, so other screens can reuse it. Only a job dated today in
   Denver gets flags; a walkthrough, a closed job or a row missing its date or time gets none.
   - Late: not arrived by the end of the arrival window, or by the scheduled start plus 15 minutes when there is none.
   - Not en route: not dispatched by 30 minutes before the scheduled start (only until the job is late).
   - Not clocked in: a scheduled crew member with no clock-in today once the scheduled start has passed. The caller
     passes the time entries it already holds; null means they are unknown, and then this flag is not shown. */
(function(root){
'use strict';
const ZONE='America/Denver',LATE_GRACE_MS=15*60000,EN_ROUTE_LEAD_MS=30*60000;
const CLOSED=new Set(['completed','complete','done','cancelled','canceled','no_show','noshow','no-show','archived','closed']);
const ARRIVED=new Set(['arrived','in_progress','completed']),MOVING=new Set(['dispatched','en_route','on_the_way']);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const clock=value=>{const match=/^(\d{2}):(\d{2})$/.exec(typeof value==='string'?value.trim():'');return match&&Number(match[1])<24&&Number(match[2])<60?Number(match[1])*60+Number(match[2]):null};
const parts=ms=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:ZONE,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
const offset=ms=>{const p=parts(ms);return Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour)%24,Number(p.minute),Number(p.second))-Math.floor(ms/1000)*1000};
function denverDate(now){const ms=typeof now==='number'?now:Date.parse(now);if(!Number.isFinite(ms))return'';const p=parts(ms);return`${p.year}-${p.month}-${p.day}`}
// Denver wall clock (date + minutes after midnight) to an instant, across the DST change.
function denverInstant(date,minutes){
  if(!validDate(date)||!Number.isInteger(minutes))return null;
  const [y,m,d]=date.split('-').map(Number),wall=Date.UTC(y,m-1,d)+minutes*60000;
  const first=wall-offset(wall);return wall-offset(first);
}
const at=value=>{const ms=Date.parse(typeof value==='string'?value:'');return Number.isFinite(ms)?ms:null};
const stage=job=>String(job?.fieldExecution?.activity||job?.pipelineStatus||job?.status||'').toLowerCase();
function closed(job){const status=String(job?.status||'').toLowerCase(),pipeline=String(job?.pipelineStatus||'').toLowerCase();return CLOSED.has(status)||CLOSED.has(pipeline)||Boolean(job?.completedAt||job?.cancelledAt)}
const arrived=job=>Boolean(at(job?.arrivedAt)||at(job?.startedAt))||ARRIVED.has(stage(job))||ARRIVED.has(String(job?.status||'').toLowerCase());
const moving=job=>arrived(job)||Boolean(at(job?.dispatchedAt))||MOVING.has(stage(job));
function startAt(job){const minutes=clock(job?.time);return minutes===null?null:denverInstant(job?.date,minutes)}
// The window end counts only when both ends are valid and the end comes after the start (dispatch-arrival.js).
function arrivalDeadline(job){
  const start=startAt(job);if(start===null)return null;
  const windowStart=clock(job?.arrivalWindowStart),windowEnd=clock(job?.arrivalWindowEnd);
  if(windowStart!==null&&windowEnd!==null&&windowEnd>windowStart)return denverInstant(job.date,windowEnd);
  return start+LATE_GRACE_MS;
}
function enRouteDeadline(job){const start=startAt(job);return start===null?null:start-EN_ROUTE_LEAD_MS}
const key=value=>String(value||'').trim().toLowerCase(),loose=value=>key(value).replace(/[^a-z0-9]/g,'');
function memberClockedIn(member,entries,date,now){
  const exact=key(member),fuzzy=loose(member);if(!exact)return true;
  return entries.some(entry=>{
    if(!entry||entry.approvalStatus==='rejected')return false;
    const clockIn=at(entry.clockInAt);if(clockIn===null||clockIn>now||denverDate(clockIn)!==date)return false;
    return[entry.employee,entry.employeeId,entry.username,entry.employeeName].some(name=>key(name)===exact||fuzzy&&loose(name)===fuzzy);
  });
}
// Rows the agenda shows: walkthroughs and blocked time are not crew arrivals.
const crewJob=job=>Boolean(job)&&!['walkthrough','blocked','availability'].includes(String(job.type||'job'));
/* flags(job,{now,crew,timeEntries}) → [{kind:'late'|'not_en_route'|'not_clocked_in',tone:'red'|'amber',label,members?}]
   now: ms or ISO. crew: the scheduled crew's usernames or names. timeEntries: the clock-ins the caller holds, or null. */
function flags(job,{now,crew=[],timeEntries=null}={}){
  const nowMs=typeof now==='number'?now:Date.parse(now);
  if(!Number.isFinite(nowMs)||!crewJob(job)||closed(job)||job.date!==denverDate(nowMs))return[];
  const start=startAt(job);if(start===null)return[];
  const output=[],deadline=arrivalDeadline(job),late=!arrived(job)&&nowMs>=deadline;
  if(late)output.push({kind:'late',tone:'red',label:'Late'});
  else if(!moving(job)&&nowMs>=enRouteDeadline(job))output.push({kind:'not_en_route',tone:'amber',label:'Not en route'});
  if(Array.isArray(timeEntries)&&nowMs>=start){
    const missing=[...new Set((Array.isArray(crew)?crew:[]).map(name=>String(name||'').trim()).filter(Boolean))].filter(name=>!memberClockedIn(name,timeEntries,job.date,nowMs));
    if(missing.length)output.push({kind:'not_clocked_in',tone:'amber',label:missing.length===1?'1 not clocked in':`${missing.length} not clocked in`,members:missing});
  }
  return output;
}
root.EGCArrivalDeadline=Object.freeze({flags,arrivalDeadline,enRouteDeadline,startAt,denverDate,denverInstant,LATE_GRACE_MS,EN_ROUTE_LEAD_MS});
})(typeof window!=='undefined'?window:globalThis);
