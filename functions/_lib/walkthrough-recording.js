import { isHubOwner } from './hub-session.js';
import { mutateDispatch, projectDispatchJob } from './dispatch-service.js';
import { scheduleInterval } from './dispatch-time.js';
import { highLevelConfig, ghl } from './highlevel-tags.js';

const TZ = 'America/Denver';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code,message,status=409) => Object.assign(new Error(message),{code:`dispatch_recording_${code}`,status});
const canonical = value => Array.isArray(value) ? `[${value.map(canonical)}]` : object(value) ? `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`)}}` : JSON.stringify(value);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');
const phone = value => String(value||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
const email = value => String(value||'').trim().toLowerCase();
const text = (value,max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function requireRecordingOwner(actor) {
  if (!actor) throw fail('sign_in','Sign in to record a walkthrough.',401);
  if (!isHubOwner(actor)) throw fail('forbidden','Only the Hub owner can record or import a walkthrough.',403);
}

function validate(input) {
  const keys=['mode','customerId','employeeId','address','scope','reason','date','time','endTime','appointmentId','calendarId'];
  if (!object(input) || Object.keys(input).some(k=>!keys.includes(k)) || !['hub_only','import'].includes(input.mode) || !id(input.customerId) || !id(input.employeeId) || !text(input.address,500) || !text(input.scope,4000) || !text(input.reason,500)) throw fail('invalid','Choose a customer and employee, and enter the address, work scope and recording reason.',400);
  if (input.mode === 'import' ? !id(input.appointmentId) || !id(input.calendarId) || ['date','time','endTime'].some(k=>k in input) : ['appointmentId','calendarId'].some(k=>k in input)) throw fail('invalid','Import needs the exact appointment and calendar IDs. Hub-only booking needs its own time.',400);
}

function localParts(instant) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}

// GETs only. The appointment is read last, including on the save request. The
// caller compares the complete reviewed snapshot; no calendar-name inference.
export async function readRecordingAppointment(env,input,customer,fetcher=fetch) {
  const c={...highLevelConfig(env),fetch:fetcher};
  if (!c.token || !id(c.locationId) || !id(customer.highlevelContactId)) throw fail('contact_required','Import requires a verified linked Hub customer and configured HighLevel access.');
  let contact,calendars,event;
  try {
    const result=await ghl(c,`/contacts/${encodeURIComponent(customer.highlevelContactId)}`,{signal:AbortSignal.timeout(15000),redirect:'error'});
    contact=result.contact;
    const list=await ghl(c,`/calendars/?locationId=${encodeURIComponent(c.locationId)}`,{signal:AbortSignal.timeout(15000),redirect:'error'});
    calendars=list.calendars;
    const resultEvent=await ghl(c,`/calendars/events/appointments/${encodeURIComponent(input.appointmentId)}`,{signal:AbortSignal.timeout(15000),redirect:'error'});
    event=resultEvent.event || resultEvent.appointment || resultEvent;
  } catch { throw fail('provider_unavailable','The existing appointment could not be verified. Nothing was saved.',503); }
  if (!object(contact) || contact.id!==customer.highlevelContactId || contact.locationId!==c.locationId || !((phone(customer.phone).length>=10 && phone(customer.phone)===phone(contact.phone)) || (email(customer.email) && email(customer.email)===email(contact.email)))) throw fail('contact_mismatch','The provider contact does not match this linked Hub customer.');
  const matches=Array.isArray(calendars)?calendars.filter(c=>c.id===input.calendarId):[];
  if (matches.length!==1 || matches[0].locationId && matches[0].locationId!==c.locationId || matches[0].isActive===false) throw fail('calendar_mismatch','The exact calendar is unavailable in this location.');
  if (!object(event) || event.id!==input.appointmentId || event.calendarId!==input.calendarId || event.contactId!==customer.highlevelContactId || event.locationId && event.locationId!==c.locationId) throw fail('appointment_mismatch','The appointment, calendar and linked customer must match exactly.');
  const status=String(event.appointmentStatus || event.appoinmentStatus || event.status || '').toLowerCase();
  if (!['new','confirmed'].includes(status)) throw fail('appointment_inactive','Only an active new or confirmed appointment can be imported. Review cancellations, no-shows or completed appointments in HighLevel.');
  const instant=value=>typeof value==='string' && /T\d\d:\d\d:00(?:\.000)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const startAt=instant(event.startTime),endAt=instant(event.endTime);
  if (!startAt || !endAt || endAt<=startAt) throw fail('time_invalid','The provider must supply an exact start and end, including the time zone.');
  return {appointmentId:event.id,calendarId:event.calendarId,calendarName:String(matches[0].name||''),contactId:contact.id,locationId:c.locationId,startAt,endAt,status,assignedUserId:typeof event.assignedUserId==='string'?event.assignedUserId:null,providerAddress:String(event.address||''),providerUpdatedAt:event.dateUpdated || event.updatedAt || null};
}

export async function previewRecording(store,actor,input,env,{appointment=readRecordingAppointment,now=()=>new Date()}={}) {
  requireRecordingOwner(actor);validate(input);
  const customer=await store.read('customers',input.customerId);
  if (!customer || customer.id!==input.customerId || customer.recordType || !customer.revision) throw fail('customer_missing','The exact Hub customer could not be verified.');
  const roster=await store.roster(),employee=roster.find(p=>p.id===input.employeeId);
  if (!employee) throw fail('employee_inactive','Choose an employee from the current active roster.');
  const provider=input.mode==='import'?await appointment(env,input,customer):null;
  const start=provider?localParts(provider.startAt):{date:input.date,time:input.time};
  const end=provider?localParts(provider.endAt):{date:input.date,time:input.endTime};
  const interval=scheduleInterval({...start,endDate:end.date,endTime:end.time});
  if (!interval || start.date!==end.date || interval.end-interval.start>4*3600000 || provider && (provider.startAt!==interval.startAt || provider.endAt!==interval.endAt)) throw fail('time_invalid','Choose an unambiguous same-day walkthrough, up to four hours, with an exact end time.');
  // A just-started visit may be recorded on its local day, as may an earlier
  // visit that day. Historical imports outside today are deliberately excluded.
  const today=localParts(now().toISOString()).date;
  if (start.date<today || interval.start>Date.parse(now().toISOString())+180*86400000) throw fail('time_out_of_scope','Record today or a date within the next 180 days.');
  const snapshot={mode:input.mode,customerId:customer.id,customerRevision:customer.revision,contactId:customer.highlevelContactId||null,employeeId:employee.id,employeeName:employee.name,address:input.address.trim(),scope:input.scope.trim(),reason:input.reason.trim(),date:start.date,time:start.time,endDate:end.date,endTime:end.time,startAt:interval.startAt,endAt:interval.endAt,timeZone:TZ,durationMinutes:(interval.end-interval.start)/60000,provider};
  return {snapshot,fingerprint:await hash(snapshot),customer};
}

export async function saveRecording(store,actor,body,env,deps={}) {
  requireRecordingOwner(actor);
  if (!object(body) || Object.keys(body).some(k=>!['input','fingerprint','requestId'].includes(k)) || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(body.requestId||'') || !/^[a-f\d]{64}$/.test(body.fingerprint||'')) throw fail('invalid','Review the walkthrough before saving with a stable request ID.',400);
  validate(body.input);
  const receiptId=body.requestId.toLowerCase(),bodyHash=await hash({actor:actor.user,body});
  const replay=async()=>{
    const receipt=await store.read('walkthroughRecordings',receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint!==bodyHash || receipt.actorId!==actor.user) throw fail('idempotency_conflict','This request ID was already used for a different recording.');
    const job=await store.read('jobs',receipt.jobId);
    if (!job || job.ownerWalkthrough?.requestId!==receiptId) throw fail('saved_record_changed','The recording was saved but its current record needs review.');
    return {ok:true,requestId:body.requestId,replayed:true,job:projectDispatchJob(job),providerWrites:false};
  };
  const prior=await replay();if(prior)return prior;
  try {
    const reviewed=await previewRecording(store,actor,body.input,env,deps),s=reviewed.snapshot;
    if (reviewed.fingerprint!==body.fingerprint) throw fail('changed','The customer, employee or provider appointment changed. Review a fresh preview before saving.');
    const at=(deps.now||(()=>new Date()))().toISOString();
    const policy={mode:s.mode,providerWrites:'blocked',requestId:receiptId,recordedBy:actor.user,recordedAt:at,reason:s.reason,reviewedFingerprint:body.fingerprint,provider:s.provider};
    const wrapped={...store,async commit(writes){
      const job=writes.find(w=>w.collection==='jobs' && w.patch?.ownerWalkthrough);
      if (!job) throw fail('invalid','No verified walkthrough was prepared.');
      if (s.provider) {
        // Legacy Hub visits may predate the import claim collection. This scan
        // is under Dispatch's already-read revision and day-lock preconditions.
        const existing=(await store.jobs()).find(row=>row.highlevelAppointmentId===s.provider.appointmentId);
        if(existing)throw fail('already_imported','This appointment is already linked to a Hub visit. Review that visit instead.');
        const fresh=await (deps.appointment||readRecordingAppointment)(env,body.input,reviewed.customer);
        if(await hash(fresh)!==await hash(s.provider))throw fail('changed','The provider appointment changed during save. Review a fresh preview.');
      }
      const extra=[{collection:'customers',id:s.customerId,revision:reviewed.customer.revision,verify:true},{collection:'walkthroughRecordings',id:receiptId,patch:{actorId:actor.user,fingerprint:bodyHash,jobId:job.id,createdAt:at}}];
      if(s.provider)extra.push({collection:'walkthroughProviderLinks',id:s.provider.appointmentId,patch:{jobId:job.id,calendarId:s.provider.calendarId,contactId:s.provider.contactId,createdAt:at}});
      await store.commit([...writes,...extra]);
    }};
    if(s.provider && await store.read('walkthroughProviderLinks',s.provider.appointmentId)) throw fail('already_imported','This provider appointment has already been imported. Open the existing walkthrough.');
    const result=await mutateDispatch(wrapped,actor,{action:'schedule.create',requestId:body.requestId,customerId:s.customerId,kind:'walkthrough',changes:{date:s.date,time:s.time,endDate:s.endDate,endTime:s.endTime,address:s.address,jobInstructions:s.scope,assignedCrew:[s.employeeId],crewLead:s.employeeId,notify:false}},at,{ownerWalkthrough:policy});
    return {...result,providerWrites:false};
  } catch(error) {const recovered=await replay();if(recovered)return recovered;throw error;}
}
