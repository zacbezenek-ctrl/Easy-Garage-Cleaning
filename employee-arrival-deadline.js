/* FIELD-FLAGS: when today's crew is late, not en route or not clocked in, for the Hub's Today agenda (employee-suite.js).
   One pure rule with an injected clock, run as a classic script in the Hub (window.EGCArrivalDeadline) and imported on
   the server through functions/_lib/arrival-deadline.js, so other screens can reuse it. A row is one visit: a job, or one
   of its assignment segments (visitRow, the way dispatch-segments.js jobSegments() reads them), with that visit's date,
   time and crew. Only a visit dated today in Denver gets flags; a walkthrough, a closed job or a visit missing its date or
   time gets none.
   - Late: not arrived by the end of the arrival window, or by the scheduled start plus 15 minutes when there is none.
     The window is the saved arrivalWindowStart/End, else the label dispatch saved with the default window
     (formatArrivalWindow's 'H:MM AM – H:MM PM'); it belongs to the job's first visit only.
   - Not en route: not dispatched by 30 minutes before the scheduled start (only until the visit is late).
   - Not clocked in: a scheduled crew member with no clock-in today once the scheduled start has passed. The caller
     passes the time entries it already holds (the whole history is fine: it is indexed once per array); null means they
     are unknown, and then this flag is not shown.
   Arrival and dispatch count only when recorded today in Denver and after the visit was last restored (restoredAt, as
   customer-portal.js portalStatus does), or from the job's canonical status on its first visit: a restored or later-day
   visit never inherits an earlier arrival. The canonical status stands only while nothing on the job (start, arrival,
   dispatch, last tap) is from an earlier day, so a job left working and moved to today has not arrived today. Today's
   evidence is arrivedAt/startedAt/dispatchedAt, or the last status tap (fieldExecution.activity, dated by when it was
   made on the phone, activityTappedAt, else when it reached the server, activityAt: a later day's Working tap writes
   only that, field-execution.js fieldCommand). A tap queued offline yesterday and synced today is yesterday's.
   A multi-day visit record (visits[today].startedAt, field-execution-visits.js) is written by the day's first tap,
   whatever it was, so it shows the crew moving, never arrived. A job-level arrival today covers its later segments
   that day. */
(function(root){
'use strict';
const ZONE='America/Denver',LATE_GRACE_MS=15*60000,EN_ROUTE_LEAD_MS=30*60000;
const CLOSED=new Set(['completed','complete','done','cancelled','canceled','no_show','noshow','no-show','archived','closed','invoiced','paid','review_requested']);
const ARRIVED=new Set(['arrived','in_progress']),MOVING=new Set(['dispatched']);
const ARRIVED_TAPS=new Set(['arrived','in_progress','waiting','paused']),MOVING_TAPS=new Set(['dispatched','delayed']);
const FORMAT=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const clock=value=>{const match=/^(\d{2}):(\d{2})$/.exec(typeof value==='string'?value.trim():'');return match&&Number(match[1])<24&&Number(match[2])<60?Number(match[1])*60+Number(match[2]):null};
const parts=ms=>Object.fromEntries(FORMAT.formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
const offset=ms=>{const p=parts(ms);return Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour)%24,Number(p.minute),Number(p.second))-Math.floor(ms/1000)*1000};
function denverDate(now){const ms=typeof now==='number'?now:Date.parse(now);if(!Number.isFinite(ms))return'';const p=parts(ms);return`${p.year}-${p.month}-${p.day}`}
// Denver wall clock (date + minutes after midnight) to an instant, across the DST change.
function denverInstant(date,minutes){
  if(!validDate(date)||!Number.isInteger(minutes))return null;
  const [y,m,d]=date.split('-').map(Number),wall=Date.UTC(y,m-1,d)+minutes*60000;
  const first=wall-offset(wall);return wall-offset(first);
}
const nextDate=date=>new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
const at=value=>{const ms=Date.parse(typeof value==='string'?value:'');return Number.isFinite(ms)?ms:null};
const stage=job=>String(job?.pipelineStatus||job?.status||'scheduled').toLowerCase();
const closed=job=>CLOSED.has(String(job?.status||'').toLowerCase())||CLOSED.has(String(job?.pipelineStatus||'').toLowerCase())||Boolean(job?.completedAt||job?.cancelledAt);
// One visit: the job itself, or one assignment segment with its own date, time and crew. firstVisit marks the visit the
// job's own date/time (and so its arrival window and canonical status) describe.
function visitRow(job,segment=null){
  if(!segment||segment===job)return{...job,firstVisit:true};
  const crew=Array.isArray(segment.assignedCrew)?segment.assignedCrew.filter(name=>typeof name==='string'):[];
  return{...job,assignmentSegments:null,segmentId:typeof segment.id==='string'?segment.id:null,date:segment.date||'',time:segment.time||'',endDate:segment.endDate||segment.date||'',endTime:segment.endTime||'',
    assignedCrew:crew,assignedTo:crew.join(', '),crewLead:segment.crewLead||null,firstVisit:segment.date===job.date&&segment.time===job.time};
}
// A field timestamp counts for this visit when it was recorded on the visit's Denver day, after any restore.
function current(job,value,date){const ms=at(value),restored=at(job?.restoredAt);return ms!==null&&!(restored!==null&&ms<=restored)&&denverDate(ms)===date}
// When the last status tap was made: on the phone (activityTappedAt, clamped by the server), else when it was saved.
const tapTime=row=>row.fieldExecution?.activityTappedAt||row.fieldExecution?.activityAt;
// The crew's last status tap, when it was made today (after any restore). An End day counts as today's arrival only
// when it ended a visit started and ended today: one saved offline and synced after midnight ended yesterday's visit
// (field-execution-visits.js end_day with visitDate), so it says nothing about today. A Pause made before a later
// visit's scheduled start is not that visit's arrival; a Waiting is (crew on site early, waiting on the customer).
function todayTap(row){
  const when=tapTime(row);
  if(!current(row,when,row.date))return'';
  const tap=String(row.fieldExecution?.activity||''),visit=row.fieldExecution?.visits?.[row.date];
  if(tap==='day_ended')return visit?.status==='ended'&&!visit.endedLate&&current(row,visit.startedAt,row.date)&&current(row,visit.endedAt,row.date)?'arrived':'';
  if(tap==='paused'&&row.firstVisit===false){const start=startAt(row);if(start!==null&&at(when)<start)return'';}
  return tap;
}
// Something on the job recorded on a Denver day before this visit's (after any restore): its canonical status is older.
const before=(row,value)=>{const ms=at(value),restored=at(row?.restoredAt);return ms!==null&&!(restored!==null&&ms<=restored)&&denverDate(ms)<row.date};
const stageToday=row=>row.firstVisit===true&&![row.startedAt,row.arrivedAt,row.dispatchedAt,tapTime(row)].some(value=>before(row,value));
function arrived(row){
  const date=row.date;
  return current(row,row.arrivedAt,date)||current(row,row.startedAt,date)||ARRIVED_TAPS.has(todayTap(row))||stageToday(row)&&ARRIVED.has(stage(row));
}
const moving=row=>arrived(row)||current(row,row.dispatchedAt,row.date)||current(row,row.fieldExecution?.visits?.[row.date]?.startedAt,row.date)||MOVING_TAPS.has(todayTap(row))||stageToday(row)&&MOVING.has(stage(row));
function startAt(job){const minutes=clock(job?.time);return minutes===null?null:denverInstant(job?.date,minutes)}
// The label dispatch saves with the default window (dispatch-arrival.js formatArrivalWindow), read back only in that form.
function labelMinutes(label){
  const match=/^(\d{1,2}):(\d{2}) (AM|PM) – (\d{1,2}):(\d{2}) (AM|PM)$/.exec(typeof label==='string'?label:'');
  if(!match)return null;
  const read=(h,m,half)=>{const hour=Number(h),minute=Number(m);if(hour<1||hour>12||minute>59)return null;return(hour%12+(half==='PM'?12:0))*60+minute};
  const start=read(match[1],match[2],match[3]),end=read(match[4],match[5],match[6]);
  return start===null||end===null||end<=start?null:{start,end};
}
// The window belongs to the job's first visit: saved ends when both are valid and in order, else the saved label.
function arrivalDeadline(job){
  const start=startAt(job);if(start===null)return null;
  if(job.firstVisit!==false){
    const windowStart=clock(job?.arrivalWindowStart),windowEnd=clock(job?.arrivalWindowEnd);
    if(windowStart!==null&&windowEnd!==null&&windowEnd>windowStart)return denverInstant(job.date,windowEnd);
    const label=job?.arrivalWindowStart==null&&job?.arrivalWindowEnd==null?labelMinutes(job?.arrivalWindow):null,end=label?denverInstant(job.date,label.end):null;
    if(end!==null&&end>start)return end;
  }
  return start+LATE_GRACE_MS;
}
function enRouteDeadline(job){const start=startAt(job);return start===null?null:start-EN_ROUTE_LEAD_MS}
const key=value=>String(value||'').trim().toLowerCase(),loose=value=>key(value).replace(/[^a-z0-9]/g,'');
// Who clocked in on a Denver day: one pass over the entries per array and day, kept until either changes, so a long
// timecard history costs one scan per refresh and every member check is a lookup. Each name form maps to the earliest
// clock-in that day.
let index={entries:null,date:'',firsts:null};
function clockIns(entries,date){
  if(index.entries===entries&&index.date===date)return index.firsts;
  const from=denverInstant(date,0),to=denverInstant(nextDate(date),0),firsts=new Map();
  for(const entry of entries){
    if(!entry||entry.approvalStatus==='rejected')continue;
    const ms=at(entry.clockInAt);if(ms===null||ms<from||ms>=to)continue;
    for(const name of[entry.employee,entry.employeeId,entry.username,entry.employeeName])for(const form of[key(name)&&'='+key(name),loose(name)&&'~'+loose(name)])if(form&&!(firsts.get(form)<=ms))firsts.set(form,ms);
  }
  index={entries,date,firsts};return firsts;
}
function memberClockedIn(member,firsts,now){
  const exact=key(member),fuzzy=loose(member);if(!exact)return true;
  return firsts.get('='+exact)<=now||Boolean(fuzzy)&&firsts.get('~'+fuzzy)<=now;
}
// Rows the agenda shows: walkthroughs and blocked time are not crew arrivals.
const crewJob=job=>Boolean(job)&&!['walkthrough','blocked','availability'].includes(String(job.type||'job'));
/* flags(row,{now,crew,timeEntries}) → [{kind:'late'|'not_en_route'|'not_clocked_in',tone:'red'|'amber',label,members?}]
   row: a job or a visitRow(job, segment). now: ms or ISO. crew: that visit's crew usernames or names. timeEntries: the
   clock-ins the caller holds, or null. */
function flags(job,{now,crew=[],timeEntries=null}={}){
  const nowMs=typeof now==='number'?now:Date.parse(now);
  if(!Number.isFinite(nowMs)||!crewJob(job)||closed(job))return[];
  const row=job.firstVisit===undefined?{...job,firstVisit:true}:job;
  if(row.date!==denverDate(nowMs))return[];
  const start=startAt(row);if(start===null)return[];
  const output=[],late=!arrived(row)&&nowMs>=arrivalDeadline(row);
  if(late)output.push({kind:'late',tone:'red',label:'Late'});
  // A later visit of a job already arrived or working has no en-route tap in the crew app; it can only be late.
  else if(!moving(row)&&!(row.firstVisit===false&&ARRIVED.has(stage(row)))&&nowMs>=enRouteDeadline(row))output.push({kind:'not_en_route',tone:'amber',label:'Not en route'});
  if(Array.isArray(timeEntries)&&nowMs>=start){
    const firsts=clockIns(timeEntries,row.date);
    const missing=[...new Set((Array.isArray(crew)?crew:[]).map(name=>String(name||'').trim()).filter(Boolean))].filter(name=>!memberClockedIn(name,firsts,nowMs));
    if(missing.length)output.push({kind:'not_clocked_in',tone:'amber',label:missing.length===1?'1 not clocked in':`${missing.length} not clocked in`,members:missing});
  }
  return output;
}
// underway(row): the crew of this visit (a job or a visitRow) is en route or on site today: the same evidence that
// clears Not en route. MANAGER-SLIP-ALERTS (employee-slip-alerts.js) stops alerting a visit once this is true. Only the
// visit's own evidence counts: a later visit never inherits the job's canonical status, because End day leaves a job
// worked on day 1 in_progress and day 2 would then look underway with nobody there.
function underway(job,{now}={}){const nowMs=typeof now==='number'?now:Date.parse(now);if(!Number.isFinite(nowMs))return false;const row=job?.firstVisit===undefined?{...job,firstVisit:true}:job;return row.date===denverDate(nowMs)&&moving(row)}
root.EGCArrivalDeadline=Object.freeze({flags,underway,visitRow,arrivalDeadline,enRouteDeadline,startAt,denverDate,denverInstant,LATE_GRACE_MS,EN_ROUTE_LEAD_MS});
})(typeof window!=='undefined'?window:globalThis);
