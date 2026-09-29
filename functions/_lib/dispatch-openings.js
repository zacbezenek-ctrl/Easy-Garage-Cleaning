import { requireDispatcher } from './dispatch-service.js';
import { DISPATCH_TIME_ZONE } from './dispatch-contract.js';
import { assignmentKey } from './job-assignment.js';
import { sharedScheduleResources, scheduleRowsConflict, scheduleCrewIds } from './dispatch-conflicts.js';
import { validDate, addDays, denverToday, scheduleInterval, availabilityInterval } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { legacyBlockedDays } from './dispatch-legacy-blocks.js';
import { jobSegments, lockEntryOwner } from './dispatch-segments.js';
import { dispatchRuleSettings } from './dispatch-settings.js';
import { capacityExceeded, capacityIndex, capacityLimitText, missingSkills, qualified, skillLevels, takesFieldWork, workingWindows } from './dispatch-rules.js';
import { SKILL_CATALOG } from './staff-skills.js';
import { jobsForWindow, lockOwnerIds } from './dispatch-window-reads.js';

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
// Workday and travel buffer default to the owner settings (dispatch-settings.js) in withSettings().
function parseQuery(query,now) {
  const keys=['startDate','endDate','durationMinutes','workdayStart','workdayEnd','employeeIds','vehicleId','travelBufferMinutes','address','zip','requiredSkills'];
  if (!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>!keys.includes(key))) throw fail('dispatch_openings_invalid','The openings request contains unsupported fields.');
  const startDate=query.startDate||denverToday(now),endDate=query.endDate||addDays(startDate,7);
  if (!validDate(startDate)||!validDate(endDate)||endDate<=startDate||Date.parse(endDate)-Date.parse(startDate)>14*86400000) throw fail('dispatch_openings_range_invalid','Choose a date range of up to 14 days. The end date is exclusive.');
  const workdayStart=query.workdayStart||undefined,workdayEnd=query.workdayEnd||undefined;
  if (workdayStart!==undefined&&!Number.isFinite(minutes(workdayStart))||workdayEnd!==undefined&&!(workdayEnd==='24:00'||Number.isFinite(minutes(workdayEnd)))) throw fail('dispatch_openings_invalid','Choose a workday start and later end on the same local date. Use 24:00 for the end of the day.');
  const skillValues=typeof query.requiredSkills==='string'&&query.requiredSkills?query.requiredSkills.split(','):Array.isArray(query.requiredSkills)?query.requiredSkills:[];
  if (query.requiredSkills!==undefined&&typeof query.requiredSkills!=='string'&&!Array.isArray(query.requiredSkills)||skillValues.length>SKILL_CATALOG.length||skillValues.some(id=>!SKILL_CATALOG.some(skill=>skill.id===id))||new Set(skillValues).size!==skillValues.length) throw fail('dispatch_openings_invalid','Choose required skills from the staff skill catalog, each once.');
  const values=Array.isArray(query.employeeIds)?query.employeeIds:typeof query.employeeIds==='string'&&(query.employeeIds||!skillValues.length)?query.employeeIds.split(','):[];
  // No employees with required skills searches each qualified employee on their own.
  if (!skillValues.length&&!values.length||values.length>20||values.some(value=>typeof value!=='string'||!value.trim())) throw fail('dispatch_openings_employees_required','Select one to 20 active employees to check together, or required skills to search any qualified employee.');
  const employeeIds=values.map(assignmentKey).sort();
  if (new Set(employeeIds).size!==employeeIds.length) throw fail('dispatch_openings_invalid','Choose each employee only once.');
  const vehicleId=query.vehicleId || null;
  if (vehicleId!==null&&(typeof vehicleId!=='string'||!/^[A-Za-z0-9_-]{1,180}$/.test(vehicleId))) throw fail('dispatch_resource_invalid','Choose a valid vehicle.');
  const dates=[];for(let date=startDate;date<endDate;date=addDays(date,1))dates.push(date);
  // Optional new-job location pads gaps with drive estimates; never required.
  if(query.address!==undefined&&(typeof query.address!=='string'||!query.address.trim()||query.address.length>500)||query.zip!==undefined&&(typeof query.zip!=='string'||!/^\d{5}$/.test(query.zip))||query.address!==undefined&&query.zip!==undefined) throw fail('dispatch_openings_invalid','Enter either a job address of up to 500 characters or a 5-digit ZIP code, not both.');
  const destination=query.address!==undefined?{address:query.address.trim()}:query.zip!==undefined?{zip:query.zip}:{};
  return {startDate,endDate,dates,durationMinutes:integer(query.durationMinutes,'Duration',15,1440,120),workdayStart,workdayEnd,employeeIds,requiredSkills:[...skillValues].sort(),vehicleId,travelBufferMinutes:query.travelBufferMinutes===undefined?undefined:integer(query.travelBufferMinutes,'Travel buffer',0,180),...destination};
}
function withSettings(input,settings) {
  const workdayStart=input.workdayStart||settings.workdayStart,workdayEnd=input.workdayEnd||settings.workdayEnd;
  if ((workdayEnd==='24:00'?1440:minutes(workdayEnd))<=minutes(workdayStart)) throw fail('dispatch_openings_invalid','Choose a workday start and later end on the same local date. Use 24:00 for the end of the day.');
  return {...input,workdayStart,workdayEnd,travelBufferMinutes:input.travelBufferMinutes===undefined?settings.defaultTravelBufferMinutes:input.travelBufferMinutes};
}

// A suggestion never reserves capacity. Detect changes across the paginated
// reads using the global dispatch guard, legacy day locks and active roster.
// One bounded retry tolerates ordinary dispatch activity without hiding races.
async function snapshot(store,dates) {
  const locks=()=>Promise.all(dates.map(date=>store.read('jobs',`_egc_schedule_lock_${date}`)));
  const same=(a,b)=>a?.revision===b?.revision;
  const rosterKey=rows=>JSON.stringify(rows.map(row=>({id:row.id,name:row.name,role:row.role,skills:row.skills??null,weeklyAvailability:row.weeklyAvailability??null})).sort((a,b)=>a.id.localeCompare(b.id)));
  for(let attempt=0;attempt<2;attempt++) {
    const guard=await store.read('dispatchState','revision');
    const before=await locks();
    const [jobs,resources,roster,settings]=await Promise.all([jobsForWindow(store,{startDate:dates[0],endDate:addDays(dates.at(-1),1)},'openings'),store.resources(),store.roster(),dispatchRuleSettings(store)]);
    const [after,rosterAfter]=await Promise.all([locks(),store.roster()]);
    const guardAfter=await store.read('dispatchState','revision');
    if (!same(guard,guardAfter)||before.some((lock,index)=>!same(lock,after[index]))||rosterKey(roster)!==rosterKey(rosterAfter))continue;
    for(const lock of after) if (lock&&(lock.recordType!=='schedule_lock'||!Array.isArray(lock.entries)||lock.entries.some(entry=>!entry||typeof entry!=='object'||Array.isArray(entry)))) throw fail('dispatch_lock_unavailable','A scheduling guard is malformed. Repair it before using capacity suggestions.',503);
    return {jobs,resources,roster,settings,locks:after,revision:guard?.revision || null};
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

/** GET query documented in dispatch-contract.js. No schedule mutation. Optional
 * address/zip drive estimates follow dispatch-travel.js (off by default). Owner
 * rules (dispatch-rules.js): recorded weekly working hours limit the gaps,
 * required skills pick the employees ('any qualified' when none are named) and
 * daily limits skip a date only when the owner made them blocking. */
export async function dispatchOpenings(store,session,query={},now=new Date(),{travel=null,authorize=requireDispatcher}={}) {
  authorize(session);
  const parsed=parseQuery(query,now),data=await snapshot(store,parsed.dates),legacy=await legacyBlockedDays(store,parsed.dates),settings=data.settings,input=withSettings(parsed,settings);
  if (input.employeeIds.some(id=>!data.roster.some(person=>person.id===id))) throw fail('dispatch_employee_inactive','A selected employee is no longer active. Refresh the roster.');
  if (input.vehicleId&&!data.resources.some(row=>row.recordType==='vehicle'&&row.id===input.vehicleId&&row.status==='available')) throw fail('dispatch_vehicle_unavailable','The selected vehicle is missing, inactive, or out of service.');
  const person=id=>data.roster.find(row=>row.id===id),anyQualified=!input.employeeIds.length;
  // Office-only owners and managers (fieldWork:false, owner decision F19) are never proposed.
  const holds=row=>input.requiredSkills.every(skill=>qualified(row,skill));
  const searched=anyQualified?data.roster.filter(row=>takesFieldWork(row)&&holds(row)).map(row=>row.id):input.employeeIds;
  let groups=anyQualified?searched.map(id=>[id]):[input.employeeIds];
  const hoursRecorded=searched.length>0&&searched.every(id=>workingWindows(person(id),input.startDate)!==null);
  const warnings=hoursRecorded?[{code:'working_hours_applied',message:'Openings stay inside each employee\'s recorded weekly working hours. Time off and other work are also excluded.'}]:[{code:'working_availability_unconfirmed',message:'These gaps have no recorded scheduling conflict. Confirm that the selected employees are working; unmarked time is not approved availability.'}];
  if(input.travelBufferMinutes)warnings.push({code:'travel_buffer_estimate',message:'Travel buffers reserve time around other jobs. They are not route or driving-time estimates.'});
  const office=anyQualified&&!searched.length&&data.roster.some(row=>!takesFieldWork(row)&&holds(row))?' The owner and managers who hold them are searched only when they take field work.':'';
  if(anyQualified&&!searched.length)warnings.push({code:'no_qualified_employees',message:(data.roster.some(row=>!skillLevels(row))?'No active employee has every required skill recorded at proficient or lead level. Record skills in the staff directory, or choose employees.':'No active employee has every required skill at proficient or lead level. Choose employees, or fewer skills.')+office});
  const missing=anyQualified?[]:missingSkills(input.employeeIds,data.roster,input.requiredSkills);
  if(missing.length) {
    warnings.push({code:'skill_missing',missingSkills:missing,message:`No selected employee is qualified for ${missing.map(id=>SKILL_CATALOG.find(skill=>skill.id===id)?.label||id).join(', ')}.${settings.blockSkillMissing?' Dispatch rules block this crew, so no openings are suggested.':''}`,...(settings.blockSkillMissing?{blocking:true}:{})});
    if(settings.blockSkillMissing)groups=[];
  }
  // Each assignment segment reserves only its own window, crew and vehicle.
  const sources=[...data.jobs.filter(operational).flatMap(jobSegments),...data.resources.filter(unavailable)];
  // An orphan lock is still a reservation until an operations manager reviews
  // it. Existing jobs, including completed work, are authoritative over old locks.
  const canonicalIds=await lockOwnerIds(store,data.jobs,data.locks);
  data.locks.forEach((lock,index)=>{
    for(const entry of lock?.entries || []) {
      if (canonicalIds.has(entry.id)||canonicalIds.has(lockEntryOwner(entry)))continue;
      const date=input.dates[index];
      sources.push({...entry,id:entry.id||`guard:${date}`,type:entry.type||'job',date,time:entry.start,endDate:entry.end==='24:00'?addDays(date,1):date,endTime:entry.end==='24:00'?'00:00':entry.end});
    }
  });
  // Legacy calendar day blocks are company-wide and never suggested as openings.
  for(const row of legacy.rows){sources.push(row);warnings.push({code:'legacy_blocked_day',date:row.date,legacyBlockId:row.id,message:`${row.date} is blocked on the Hub calendar, so it has no suggested openings.`});}
  const nearRange=row=>{const endDate=row.endDate||row.date;return !validDate(row.date)||!validDate(endDate)||endDate<row.date||endDate>=addDays(input.startDate,-1)&&row.date<=input.endDate;};
  const live=sources.filter(row=>!closed(row)&&nearRange(row)),intervals=new Map(live.map(row=>[row,unavailable(row)?availabilityInterval(row):scheduleInterval(row)]));
  const plans=groups.map(ids=>({ids,prepared:live.filter(row=>sharedScheduleResources({assignedCrew:ids,vehicleId:input.vehicleId},row,data.roster)).map(row=>({row,interval:intervals.get(row)}))}));
  const destination=input.address||input.zip||null,travelled=row=>!unavailable(row)&&row.type!=='blocked';
  let estimate=()=>null;
  if(destination&&travel?.enabled) {
    const nearby=[...new Set(plans.flatMap(plan=>plan.prepared).filter(({row,interval})=>interval&&travelled(row)).map(({row})=>row))].sort((a,b)=>intervals.get(a).start-intervals.get(b).start);
    estimate=await travel.prefetch(nearby.filter(row=>String(row.address||'').trim()).flatMap(row=>[[destination,row],[row,destination]]));
    const unestimated=nearby.filter(row=>!estimate(destination,row)||!estimate(row,destination)).length;
    warnings.push({code:'travel_time_estimated',message:'Gaps also reserve the estimated drive between this job location and nearby assignments. The travel buffer is always the minimum.'});
    if(unestimated)warnings.push({code:'travel_estimate_unavailable',count:unestimated,message:`${unestimated} nearby ${unestimated===1?'assignment has':'assignments have'} no drive estimate (unknown ZIP or address); the travel buffer is used.`});
  } else if(destination)warnings.push({code:'travel_estimates_disabled',message:'Drive-time estimates are turned off. Gaps use the travel buffer only.'});
  // Scheduled work per employee and date, only when the owner set daily limits.
  const limited=Boolean(capacityLimitText(settings)),capacity=limited?capacityIndex(live.filter(row=>travelled(row)&&operational(row)),row=>scheduleCrewIds(row,data.roster),row=>intervals.get(row)):null;
  const found=[],warningKeys=new Set(),capacityKeys=new Set(),earliest=Math.ceil(now.getTime()/60000)*60000;
  const addWarning=(code,row,date)=>{
    const key=`${code}:${row.id}:${date}`;if(warningKeys.has(key))return;warningKeys.add(key);
    if(warnings.length<100)warnings.push({code,recordId:row.id,date,message:'A relevant saved schedule has invalid dates or times. This date is excluded until dispatch repairs it.'});
  };
  const instant=(date,minute)=>minute>=1440?localInstant(addDays(date,1),'00:00'):localInstant(date,`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`);
  for(const date of input.dates) {
    const day={id:'_capacity_probe',type:'job',date,time:input.workdayStart,endDate:input.workdayEnd==='24:00'?addDays(date,1):date,endTime:input.workdayEnd==='24:00'?'00:00':input.workdayEnd,assignedCrew:input.employeeIds,vehicleId:input.vehicleId};
    const window=scheduleInterval(day);
    if(!window) { warnings.push({code:'workday_time_ambiguous',date,message:'This workday begins or ends in a missing or repeated Mountain time. Choose an unambiguous workday boundary.'});continue; }
    for(const {ids,prepared} of plans) {
      const spans=[];
      for(const {row,interval} of prepared) {
        if (!interval) {
          if (scheduleRowsConflict({...day,assignedCrew:ids},row,data.roster)) {spans.push(window);addWarning('invalid_schedule',row,date);}
          continue;
        }
        const requested=Number(row.travelBufferMinutes),buffer=unavailable(row)||row.type==='blocked'?0:Math.max(input.travelBufferMinutes,Number.isFinite(requested)&&requested>0?requested:0);
        const before=travelled(row)?Math.max(buffer,estimate(destination,row)?.minutes||0):buffer,after=travelled(row)?Math.max(buffer,estimate(row,destination)?.minutes||0):buffer;
        spans.push({start:interval.start-before*60000,end:interval.end+after*60000});
      }
      // Time outside an employee's recorded weekly hours is not available. A
      // boundary that is not a single Mountain time closes the whole workday.
      for(const id of ids) {
        const windows=workingWindows(person(id),date);
        if(!windows)continue;
        let from=0;
        for(const edge of [...windows,{start:1440,end:1440}]) {
          if(edge.start>from) {const start=instant(date,from),end=instant(date,edge.start);spans.push(start&&end?{start:Date.parse(start),end:Date.parse(end)}:window);}
          from=Math.max(from,edge.end);
        }
      }
      if(limited) {
        const over=ids.filter(id=>{const booked=capacity.get(`${id}|${date}`)||new Map();return capacityExceeded(settings,booked.size+1,[...booked.values()].reduce((sum,used)=>sum+used,0)+input.durationMinutes);});
        for(const id of over)if(!capacityKeys.has(`${id}|${date}`)&&warnings.length<100){capacityKeys.add(`${id}|${date}`);warnings.push({code:'employee_daily_capacity',employeeId:id,date,message:`${person(id)?.name||id} would pass the daily limit of ${capacityLimitText(settings)} on ${date}.${settings.blockOverCapacity?' Dispatch rules block this, so that date has no openings for them.':''}`,...(settings.blockOverCapacity?{blocking:true}:{})});}
        if(over.length&&settings.blockOverCapacity)continue;
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
        found.push({date:localStart.date,time:localStart.time,endDate:localEnd.date,endTime:localEnd.time,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),gapStartAt:new Date(gap.start).toISOString(),gapEndAt:new Date(gap.end).toISOString(),gapMinutes:Math.floor((gap.end-gap.start)/60000),employeeIds:ids});
      }
    }
  }
  if(warningKeys.size>100)warnings.push({code:'additional_schedule_issues',message:'Additional invalid schedule records also blocked these dates. Review dispatch data before booking.'});
  found.sort((a,b)=>a.startAt.localeCompare(b.startAt)||a.employeeIds.join(',').localeCompare(b.employeeIds.join(',')));
  const {dates,...constraints}=input,total=found.length;
  return {ok:true,timeZone:DISPATCH_TIME_ZONE,startDate:input.startDate,endDate:input.endDate,asOf:now.toISOString(),coverage:{complete:true,consistent:true,mode:'dispatch_revision_and_day_locks',revision:data.revision,asOf:now.toISOString()},constraints:{...constraints,mode:anyQualified?'any_qualified':'together',searchedEmployeeIds:searched,workingAvailabilityConfirmed:hoursRecorded},candidates:found.slice(0,20),total,truncated:total>20,warnings,roster:data.roster,vehicles:data.resources.filter(row=>row.recordType==='vehicle').map(row=>({id:row.id,name:row.name,status:row.status}))};
}
