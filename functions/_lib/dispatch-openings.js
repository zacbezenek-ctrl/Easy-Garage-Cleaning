import { requireDispatcher } from './dispatch-service.js';
import { DISPATCH_TIME_ZONE } from './dispatch-contract.js';
import { assignmentKey } from './job-assignment.js';
import { sharedScheduleResources, scheduleRowsConflict } from './dispatch-conflicts.js';
import { validDate, addDays, denverToday, scheduleInterval, availabilityInterval } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';

const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const closed=row=>['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show'].includes(row.pipelineStatus || row.status);
const unavailable=row=>row.type==='availability'||['availability','crew_availability'].includes(row.recordType);
const operational=row=>!row.recordType&&['job','walkthrough','cleanout','reorg','blocked'].includes(row.type)||unavailable(row);
const minutes=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):NaN;
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:DISPATCH_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function wall(ms) {
  const p=Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part=>[part.type,part.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
function integer(value,label,min,max,defaultValue) {
  const parsed=value===undefined?defaultValue:typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
  if (!Number.isInteger(parsed)||parsed<min||parsed>max) throw fail('dispatch_openings_invalid',`${label} must be a whole number from ${min} to ${max}.`);
  return parsed;
}
function parseQuery(query,now) {
  const keys=['startDate','endDate','durationMinutes','workdayStart','workdayEnd','employeeIds','vehicleId','travelBufferMinutes'];
  if (!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>!keys.includes(key))) throw fail('dispatch_openings_invalid','The openings request contains unsupported fields.');
  const startDate=query.startDate||denverToday(now),endDate=query.endDate||addDays(startDate,7);
  if (!validDate(startDate)||!validDate(endDate)||endDate<=startDate||Date.parse(endDate)-Date.parse(startDate)>14*86400000) throw fail('dispatch_openings_range_invalid','Choose a date range of up to 14 days. The end date is exclusive.');
  const workdayStart=query.workdayStart||'08:00',workdayEnd=query.workdayEnd||'17:00';
  if (!Number.isFinite(minutes(workdayStart))||!(workdayEnd==='24:00'||Number.isFinite(minutes(workdayEnd)))||(workdayEnd==='24:00'?1440:minutes(workdayEnd))<=minutes(workdayStart)) throw fail('dispatch_openings_invalid','Choose a workday start and later end on the same local date. Use 24:00 for the end of the day.');
  const values=Array.isArray(query.employeeIds)?query.employeeIds:typeof query.employeeIds==='string'?query.employeeIds.split(','):[];
  if (!values.length||values.length>20||values.some(value=>typeof value!=='string'||!value.trim())) throw fail('dispatch_openings_employees_required','Select one to 20 active employees to check together.');
  const employeeIds=values.map(assignmentKey).sort();
  if (new Set(employeeIds).size!==employeeIds.length) throw fail('dispatch_openings_invalid','Choose each employee only once.');
  const vehicleId=query.vehicleId || null;
  if (vehicleId!==null&&(typeof vehicleId!=='string'||!/^[A-Za-z0-9_-]{1,180}$/.test(vehicleId))) throw fail('dispatch_resource_invalid','Choose a valid vehicle.');
  const dates=[];for(let date=startDate;date<endDate;date=addDays(date,1))dates.push(date);
  return {startDate,endDate,dates,durationMinutes:integer(query.durationMinutes,'Duration',15,1440,120),workdayStart,workdayEnd,employeeIds,vehicleId,travelBufferMinutes:integer(query.travelBufferMinutes,'Travel buffer',0,180,20)};
}

// A suggestion never reserves capacity. Detect changes across the paginated
// reads using the global dispatch guard, legacy day locks and active roster.
// One bounded retry tolerates ordinary dispatch activity without hiding races.
async function snapshot(store,dates) {
  const locks=()=>Promise.all(dates.map(date=>store.read('jobs',`_egc_schedule_lock_${date}`)));
  const same=(a,b)=>a?.revision===b?.revision;
  const rosterKey=rows=>JSON.stringify(rows.map(row=>({id:row.id,name:row.name,role:row.role})).sort((a,b)=>a.id.localeCompare(b.id)));
  for(let attempt=0;attempt<2;attempt++) {
    const guard=await store.read('dispatchState','revision');
    const before=await locks();
    const [jobs,resources,roster]=await Promise.all([store.jobs(),store.resources(),store.roster()]);
    const [after,rosterAfter]=await Promise.all([locks(),store.roster()]);
    const guardAfter=await store.read('dispatchState','revision');
    if (!same(guard,guardAfter)||before.some((lock,index)=>!same(lock,after[index]))||rosterKey(roster)!==rosterKey(rosterAfter))continue;
    for(const lock of after) if (lock&&(lock.recordType!=='schedule_lock'||!Array.isArray(lock.entries)||lock.entries.some(entry=>!entry||typeof entry!=='object'||Array.isArray(entry)))) throw fail('dispatch_lock_unavailable','A scheduling guard is malformed. Repair it before using capacity suggestions.',503);
    return {jobs,resources,roster,locks:after,revision:guard?.revision || null};
  }
  throw fail('dispatch_snapshot_changed','The schedule changed while openings were checked. Refresh to get current suggestions.',409);
}

function mergeIntervals(intervals,start,end) {
  const merged=[];
  for (const span of intervals.filter(span=>span.end>start&&span.start<end).map(span=>({start:Math.max(start,span.start),end:Math.min(end,span.end)})).sort((a,b)=>a.start-b.start||a.end-b.end)) {
    const previous=merged.at(-1);
    if(previous&&span.start<=previous.end)previous.end=Math.max(previous.end,span.end);
    else merged.push(span);
  }
  return merged;
}

/** GET query documented in dispatch-contract.js. No mutation/provider request. */
export async function dispatchOpenings(store,session,query={},now=new Date()) {
  requireDispatcher(session);
  const input=parseQuery(query,now),data=await snapshot(store,input.dates);
  if (input.employeeIds.some(id=>!data.roster.some(person=>person.id===id))) throw fail('dispatch_employee_inactive','A selected employee is no longer active. Refresh the roster.');
  if (input.vehicleId&&!data.resources.some(row=>row.recordType==='vehicle'&&row.id===input.vehicleId&&row.status==='available')) throw fail('dispatch_vehicle_unavailable','The selected vehicle is missing, inactive, or out of service.');
  const warnings=[{code:'working_availability_unconfirmed',message:'These gaps have no recorded scheduling conflict. Confirm that the selected employees are working; unmarked time is not approved availability.'}];
  if(input.travelBufferMinutes)warnings.push({code:'travel_buffer_estimate',message:'Travel buffers reserve time around other jobs. They are not route or driving-time estimates.'});
  const sources=[...data.jobs.filter(operational),...data.resources.filter(unavailable)];
  // An orphan lock is still a reservation until an operations manager reviews
  // it. Existing jobs, including completed work, are authoritative over old locks.
  const canonicalIds=new Set(data.jobs.map(row=>row.id));
  data.locks.forEach((lock,index)=>{
    for(const entry of lock?.entries || []) {
      if (canonicalIds.has(entry.id))continue;
      const date=input.dates[index];
      sources.push({...entry,id:entry.id||`guard:${date}`,type:entry.type||'job',date,time:entry.start,endDate:entry.end==='24:00'?addDays(date,1):date,endTime:entry.end==='24:00'?'00:00':entry.end});
    }
  });
  const resourceProbe={assignedCrew:input.employeeIds,vehicleId:input.vehicleId};
  const prepared=sources.filter(row=>!closed(row)&&sharedScheduleResources(resourceProbe,row,data.roster)).filter(row=>{
    const endDate=row.endDate||row.date;
    if(!validDate(row.date)||!validDate(endDate)||endDate<row.date)return true;
    return endDate>=addDays(input.startDate,-1)&&row.date<=input.endDate;
  }).map(row=>({row,interval:unavailable(row)?availabilityInterval(row):scheduleInterval(row)}));
  const candidates=[],warningKeys=new Set(),earliest=Math.ceil(now.getTime()/60000)*60000;
  let total=0;
  const addWarning=(code,row,date)=>{
    const key=`${code}:${row.id}:${date}`;if(warningKeys.has(key))return;warningKeys.add(key);
    if(warnings.length<100)warnings.push({code,recordId:row.id,date,message:'A relevant saved schedule has invalid dates or times. This date is excluded until dispatch repairs it.'});
  };
  for(const date of input.dates) {
    const day={id:'_capacity_probe',type:'job',date,time:input.workdayStart,endDate:input.workdayEnd==='24:00'?addDays(date,1):date,endTime:input.workdayEnd==='24:00'?'00:00':input.workdayEnd,assignedCrew:input.employeeIds,vehicleId:input.vehicleId};
    const window=scheduleInterval(day);
    if(!window) { warnings.push({code:'workday_time_ambiguous',date,message:'This workday begins or ends in a missing or repeated Mountain time. Choose an unambiguous workday boundary.'});continue; }
    const spans=[];
    for(const {row,interval} of prepared) {
      if (!interval) {
        if (scheduleRowsConflict(day,row,data.roster)) {spans.push(window);addWarning('invalid_schedule',row,date);}
        continue;
      }
      const requested=Number(row.travelBufferMinutes),buffer=unavailable(row)||row.type==='blocked'?0:Math.max(input.travelBufferMinutes,Number.isFinite(requested)&&requested>0?requested:0)*60000;
      spans.push({start:interval.start-buffer,end:interval.end+buffer});
    }
    const occupied=mergeIntervals(spans,window.start,window.end),gaps=[];
    let cursor=Math.max(window.start,earliest);
    for(const span of occupied) {if(span.start>cursor)gaps.push({start:cursor,end:span.start});cursor=Math.max(cursor,span.end);}
    if(cursor<window.end)gaps.push({start:cursor,end:window.end});
    for(const gap of gaps) {
      let start=Math.ceil(gap.start/60000)*60000,end=start+input.durationMinutes*60000,localStart,localEnd;
      // A repeated DST wall hour cannot round-trip through the booking API.
      // Move forward to the first start/end pair the canonical API can represent.
      for(;end<=gap.end;start+=60000,end+=60000) {
        localStart=wall(start);localEnd=wall(end);
        if(localInstant(localStart.date,localStart.time)===new Date(start).toISOString()&&localInstant(localEnd.date,localEnd.time)===new Date(end).toISOString())break;
      }
      if(end>gap.end)continue;
      total++;
      if(candidates.length<20)candidates.push({date:localStart.date,time:localStart.time,endDate:localEnd.date,endTime:localEnd.time,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),gapStartAt:new Date(gap.start).toISOString(),gapEndAt:new Date(gap.end).toISOString(),gapMinutes:Math.floor((gap.end-gap.start)/60000)});
    }
  }
  if(warningKeys.size>100)warnings.push({code:'additional_schedule_issues',message:'Additional invalid schedule records also blocked these dates. Review dispatch data before booking.'});
  const {dates,...constraints}=input;
  return {ok:true,timeZone:DISPATCH_TIME_ZONE,startDate:input.startDate,endDate:input.endDate,asOf:now.toISOString(),coverage:{complete:true,consistent:true,mode:'dispatch_revision_and_day_locks',revision:data.revision,asOf:now.toISOString()},constraints:{...constraints,workingAvailabilityConfirmed:false},candidates,total,truncated:total>20,warnings,roster:data.roster,vehicles:data.resources.filter(row=>row.recordType==='vehicle').map(row=>({id:row.id,name:row.name,status:row.status}))};
}
