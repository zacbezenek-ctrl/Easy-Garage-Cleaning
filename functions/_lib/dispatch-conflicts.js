import { assignmentKey, jobCrewNames } from './job-assignment.js';
import { scheduleInterval, availabilityInterval, overlaps, validDate } from './dispatch-time.js';

const unavailable = row => row?.type === 'availability' || ['availability','crew_availability'].includes(row?.recordType);
const closed = row => ['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show'].includes(String(row?.pipelineStatus || row?.status || '').toLowerCase());
function resolve(value,roster,alias=true) {
  const key=assignmentKey(value),exact=roster.find(person=>person.id===key);
  if(exact)return exact.id;
  const matches=alias?roster.filter(person=>assignmentKey(person.name)===key):[];
  return matches.length===1?matches[0].id:key;
}

/** An explicit account identifier always wins over an object's display label. */
export function scheduleCrewIds(job,roster=[]) {
  const values=Array.isArray(job?.assignedCrew)&&job.assignedCrew.length?job.assignedCrew:jobCrewNames(job);
  return [...new Set(values.map(value=>{
    const explicit=value&&typeof value==='object'?(value.username||value.user||value.id):null;
    return resolve(typeof value==='string'?value:explicit||value?.name||'',roster,!explicit);
  }).filter(Boolean))];
}

/** Availability is employee-specific. Older work with unknown resource
 * assignments stays conservative; known independent crews can work in parallel. */
export function sharedScheduleResources(next,other,roster=[]) {
  if(next?.type==='blocked'||other?.type==='blocked')return true;
  const left=scheduleCrewIds(next,roster);
  if(unavailable(other)) {
    const right=other.employeeId||other.employee?[resolve(other.employeeId||other.employee,roster)]:scheduleCrewIds(other,roster);
    return left.some(id=>right.includes(id));
  }
  const right=scheduleCrewIds(other,roster);
  if(next?.vehicleId&&next.vehicleId===other?.vehicleId)return true;
  if(left.some(id=>right.includes(id)))return true;
  // A native empty crew snapshot reserves no employee. Missing legacy resource
  // metadata is different: keep that work conservative until dispatch reviews it.
  const known=(row,ids)=>row?.assignmentKnown === false ? false : ids.length>0 || Array.isArray(row?.assignedCrew);
  return !known(next,left)||!known(other,right);
}

export function scheduleRowsConflict(next,other,roster=[]) {
  if(other?.id===next?.id||closed(other)||!sharedScheduleResources(next,other,roster))return false;
  const left=scheduleInterval(next),right=unavailable(other)?availabilityInterval(other):scheduleInterval(other);
  if(!left)return true;
  if(right)return overlaps(left,right);
  // Do not invent free capacity from malformed dated work or time off.
  if (!other.date) return unavailable(other);
  if (!validDate(other.date)||!validDate(other.endDate||other.date)||(other.endDate||other.date)<other.date) return true;
  return other.date<=left.endDate&&(other.endDate||other.date)>=left.date;
}

const minutes=(value,end=false)=>{
  if(typeof value!=='string'||!/^\d{2}:\d{2}$/.test(value))return NaN;
  const hour=Number(value.slice(0,2)),minute=Number(value.slice(3));
  return hour<24&&minute<60?hour*60+minute:end&&hour===24&&minute===0?1440:NaN;
};
export function scheduleLockConflict(next,entry,date,roster=[]) {
  if(entry?.id===next?.id||closed(entry)||!sharedScheduleResources(next,entry,roster))return false;
  const start=minutes(next.date===date?next.time:'00:00'),end=minutes((next.endDate||next.date)===date?next.endTime:'24:00',true);
  const otherStart=minutes(entry.start),otherEnd=minutes(entry.end,true);
  if(![start,end,otherStart,otherEnd].every(Number.isFinite)||otherEnd<=otherStart)return true;
  return start<otherEnd&&otherStart<end;
}

/** Shared day-lock contract for native dispatch, availability and provider
 * adoption. End 24:00 means the end of this local day, never the next day 24:00. */
export function scheduleDayEntry(job,date,roster=[],now=new Date().toISOString()) {
  const assignedCrew=scheduleCrewIds(job,roster);
  return {id:job.id,type:job.type||'job',start:date===job.date?job.time:'00:00',end:date===(job.endDate||job.date)?job.endTime:'24:00',label:job.customer||job.title||'',status:job.pipelineStatus||job.status||'scheduled',assignedCrew,assignmentKnown:assignedCrew.length>0 || Array.isArray(job.assignedCrew),vehicleId:job.vehicleId||null,updatedAt:now};
}
