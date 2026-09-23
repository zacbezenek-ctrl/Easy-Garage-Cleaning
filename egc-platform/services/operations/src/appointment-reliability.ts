import {createHash} from "node:crypto";

type Json = Record<string, unknown>;
export type AppointmentOperationStatus = "pending" | "in_flight" | "accepted" | "unknown" | "failed";
export interface AppointmentIntent {
  operationKey:string; resourceKey:string; kind:"create"|"update"|"cancel";
  payloadHash:string; request:Json; providerAppointmentId:string|null;
}
export interface AppointmentOperation extends AppointmentIntent {
  id:string; status:AppointmentOperationStatus; response:Json|null; lastError:string|null;
  attemptCount:number; leaseExpiresAt:Date|null;
}
export interface AppointmentStore {
  reserve(intent:AppointmentIntent):Promise<AppointmentOperation>;
  get(id:string):Promise<AppointmentOperation|null>;
  claim(operation:AppointmentOperation,now:Date):Promise<boolean>;
  finish(id:string,status:AppointmentOperationStatus,data:{response?:Json;providerAppointmentId?:string;lastError?:string}):Promise<void>;
}
export interface AppointmentProvider {
  locationId:string;
  getCalendarEvents(params:Record<string,string|number>):Promise<Json>;
  getAppointment(id:string):Promise<Json>;
  createAppointment(payload:Json):Promise<Json>;
  updateAppointment(id:string,payload:Json):Promise<Json>;
}
export class AppointmentOperationError extends Error {
  constructor(public code:string,public operationId:string|null=null) {super(code);}
}
const record=(value:unknown):Json=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Json:{};
const string=(value:unknown)=>typeof value==="string"&&value.length?value:null;
export const appointmentRecord=(payload:Json):Json=>Object.keys(record(payload.event)).length?record(payload.event):payload;
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const appointmentDigest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const time=(value:unknown)=>typeof value==="string"&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function appointmentStatus(value:unknown):string|null {
  const s=typeof value==="string"?value.toLowerCase():null;
  if(s==="active")return "confirmed";
  if(s==="canceled")return "cancelled";
  if(s==="completed")return "showed";
  if(s==="no_show"||s==="no-show")return "noshow";
  return s;
}
const status=(raw:Json)=>appointmentStatus(raw.appointmentStatus??raw.appoinmentStatus??raw.status);
const active=(raw:Json)=>["new","confirmed","showed"].includes(status(raw)??"");
/** Every requested persisted field is verified. Notification/validation flags are
 * command controls, not fields GHL returns. A missing field never proves success. */
export function appointmentMatches(payload:Json,expected:Json,id?:string):boolean {
  const raw=appointmentRecord(payload);
  if(!string(raw.id)||(id&&raw.id!==id)||time(raw.startTime)===null)return false;
  for(const key of ["contactId","calendarId","title","assignedUserId","description","address"]) {
    if(expected[key]===undefined)continue;
    const actual=key==="description"?(raw.description??raw.notes):raw[key];
    if(expected[key]===null) {if(actual!==null&&actual!=="")return false;}
    else if(actual!==expected[key])return false;
  }
  for(const key of ["startTime","endTime"])if(expected[key]!==undefined) {
    if(expected[key]===null) {if(raw[key]!==null)return false;}
    else if(time(raw[key])===null||time(raw[key])!==time(expected[key]))return false;
  }
  if(expected.appointmentStatus!==undefined&&status(raw)!==appointmentStatus(expected.appointmentStatus))return false;
  return true;
}
function validatePayload(payload:Json,create:boolean) {
  if(create&&(!string(payload.contactId)||!string(payload.calendarId)||time(payload.startTime)===null))throw new AppointmentOperationError("appointment_identity_required");
  if(payload.startTime!==undefined&&time(payload.startTime)===null)throw new AppointmentOperationError("appointment_start_invalid");
  if(payload.endTime!==undefined&&(time(payload.endTime)===null||(time(payload.startTime)!==null&&time(payload.endTime)!<=time(payload.startTime)!)))throw new AppointmentOperationError("appointment_end_invalid");
  if(create&&!active(payload))throw new AppointmentOperationError("appointment_create_requires_active_status");
}
export interface AppointmentResult {operationId:string;event:Json;source:"created"|"provider-preflight"|"provider-recovery"|"verified-replay"|"updated";duplicatePrevented:boolean;}

/** No provider supports the local ledger's key implicitly. We claim durably before
 * a write, and any uncertain write is reconciliation-only, including after restart. */
export class ReliableAppointments {
  constructor(private store:AppointmentStore,private provider:AppointmentProvider,private now:()=>Date=()=>new Date()){}
  private fail(code:string,operation:AppointmentOperation):never {throw new AppointmentOperationError(code,operation.id);}
  private async candidates(payload:Json):Promise<Json[]> {
    const start=time(payload.startTime);
    if(start===null||!string(payload.calendarId)||!string(payload.contactId))throw new AppointmentOperationError("appointment_reconciliation_identity_missing");
    const list=await this.provider.getCalendarEvents({calendarId:String(payload.calendarId),startTime:start-90_000,endTime:start+90_000});
    if(!Array.isArray(list.events)||list.events.length>250||list.nextPageToken||list.nextPage)throw new AppointmentOperationError("appointment_calendar_response_incomplete");
    const found=new Map<string,Json>();
    for(const item of list.events) {
      let raw=record(item);const id=string(raw.id);
      if(!id)throw new AppointmentOperationError("appointment_calendar_response_malformed");
      if(!string(raw.contactId)||time(raw.startTime)===null||!string(raw.calendarId)||!status(raw))raw=appointmentRecord(await this.provider.getAppointment(id));
      if(raw.id!==id||!string(raw.contactId)||time(raw.startTime)===null||!string(raw.calendarId)||!status(raw))throw new AppointmentOperationError("appointment_calendar_response_malformed");
      if(raw.contactId!==payload.contactId||raw.calendarId!==payload.calendarId||Math.abs(time(raw.startTime)!-start)>90_000||!active(raw))continue;
      // Nearby bookings require review; never silently create beside a possible duplicate.
      found.set(id,raw);
    }
    return [...found.values()];
  }
  private async accepted(operation:AppointmentOperation,event:Json,source:AppointmentResult["source"]):Promise<AppointmentResult> {
    const id=string(event.id);if(!id)this.fail("appointment_verification_failed",operation);
    await this.store.finish(operation.id,"accepted",{providerAppointmentId:id,response:event});
    return {operationId:operation.id,event,source,duplicatePrevented:source!=="created"};
  }
  async create(payload:Json,context:Json={},existingProviderId:string|null=null,requestId?:string):Promise<AppointmentResult> {
    validatePayload(payload,true);
    const resourceKey=typeof context.portalVisitId==="string"?`create:portal:${this.provider.locationId}:${context.portalVisitId}`:`create:${appointmentDigest({locationId:this.provider.locationId,contactId:payload.contactId,calendarId:payload.calendarId,startTime:new Date(String(payload.startTime)).toISOString()})}`;
    const request={payload,context};
    const operation=await this.store.reserve({operationKey:requestId?`${resourceKey}:${requestId}`:resourceKey,resourceKey,kind:"create",payloadHash:appointmentDigest(request),request,providerAppointmentId:existingProviderId});
    return this.run(operation);
  }
  async update(providerAppointmentId:string,payload:Json,context:Json={},requestId?:string):Promise<AppointmentResult> {
    validatePayload(payload,false);
    const resourceKey=`appointment:${this.provider.locationId}:${providerAppointmentId}`;
    const request={payload,context};
    const kind=appointmentStatus(payload.appointmentStatus)==="cancelled"?"cancel":"update";
    const operationKey=`${resourceKey}:${requestId??appointmentDigest(request)}`;
    const operation=await this.store.reserve({operationKey,resourceKey,kind,payloadHash:appointmentDigest(request),request,providerAppointmentId});
    return this.run(operation);
  }
  async reconcile(id:string,observedProviderAppointmentId?:string):Promise<AppointmentResult> {
    const operation=await this.store.get(id);
    if(!operation)throw new AppointmentOperationError("appointment_operation_not_found",id);
    if(operation.status==="in_flight"&&operation.leaseExpiresAt&&operation.leaseExpiresAt>this.now())this.fail("appointment_operation_in_flight",operation);
    if(observedProviderAppointmentId&&operation.providerAppointmentId&&observedProviderAppointmentId!==operation.providerAppointmentId)this.fail("appointment_observed_provider_id_conflict",operation);
    return this.recover(operation,observedProviderAppointmentId);
  }
  private async recover(operation:AppointmentOperation,observedProviderAppointmentId?:string):Promise<AppointmentResult> {
    const payload=record(operation.request.payload);
    let event:Json|null=null;
    try {
      const exactProviderId=observedProviderAppointmentId??operation.providerAppointmentId;
      if(exactProviderId)event=appointmentRecord(await this.provider.getAppointment(exactProviderId));
      else {
        const candidates=await this.candidates(payload);
        if(candidates.length>1)this.fail("appointment_ambiguous_matches",operation);
        event=candidates[0]??null;
      }
      const contact=record(operation.request.context).contactProviderId;
      if(!event||(contact&&event.contactId!==contact)||!appointmentMatches(event,payload,exactProviderId??undefined)||(operation.kind==="create"&&!active(event)))this.fail(operation.status==="accepted"?"appointment_changed_since_acceptance":"appointment_outcome_unknown",operation);
    } catch(error) {
      if(operation.status!=="accepted")await this.store.finish(operation.id,"unknown",{lastError:error instanceof AppointmentOperationError?error.code:"appointment_reconciliation_unavailable"});
      if(error instanceof AppointmentOperationError)throw error;
      this.fail("appointment_reconciliation_unavailable",operation);
    }
    return this.accepted(operation,event,operation.status==="accepted"?"verified-replay":"provider-recovery");
  }
  private async run(operation:AppointmentOperation):Promise<AppointmentResult> {
    if(["accepted","unknown","in_flight"].includes(operation.status))return this.reconcile(operation.id);
    if(!await this.store.claim(operation,this.now()))this.fail("appointment_operation_in_flight_or_unresolved",operation);
    const payload=record(operation.request.payload);
    // A failed preflight is definitely before any provider write, so it is retryable.
    try {
      if(operation.kind==="create") {
        if(operation.providerAppointmentId){
          const known=appointmentRecord(await this.provider.getAppointment(operation.providerAppointmentId));
          if(!appointmentMatches(known,payload,operation.providerAppointmentId)||!active(known))this.fail("appointment_linked_provider_state_conflict",operation);
          return this.accepted(operation,known,"provider-preflight");
        }
        const candidates=await this.candidates(payload);
        if(candidates.length>1)this.fail("appointment_ambiguous_matches",operation);
        if(candidates[0]) {
          const actual=appointmentRecord(await this.provider.getAppointment(String(candidates[0].id)));
          if(!appointmentMatches(actual,payload))this.fail("appointment_existing_booking_conflict",operation);
          return this.accepted(operation,actual,"provider-preflight");
        }
      } else {
        const current=appointmentRecord(await this.provider.getAppointment(operation.providerAppointmentId!));
        if(current.id!==operation.providerAppointmentId||time(current.startTime)===null)this.fail("appointment_provider_identity_mismatch",operation);
        const expectedContact=record(operation.request.context).contactProviderId;
        if(expectedContact&&current.contactId!==expectedContact)this.fail("appointment_provider_contact_mismatch",operation);
        if(appointmentMatches(current,payload,operation.providerAppointmentId!))return this.accepted(operation,current,"provider-preflight");
        const start=time(payload.startTime??current.startTime),end=time(payload.endTime??current.endTime);
        if(start!==null&&end!==null&&end<=start)this.fail("appointment_end_invalid",operation);
      }
    } catch(error) {
      const code=error instanceof AppointmentOperationError?error.code:"appointment_preflight_unavailable";
      await this.store.finish(operation.id,"failed",{lastError:code});
      this.fail(code,operation);
    }
    // Never retry this write. Even an error response can follow a committed provider side effect.
    let providerId=operation.providerAppointmentId;
    try {
      const response=operation.kind==="create"?await this.provider.createAppointment(payload):await this.provider.updateAppointment(providerId!,payload);
      const returnedId=string(appointmentRecord(response).id);
      if(operation.kind!=="create"&&returnedId&&returnedId!==providerId)this.fail("appointment_provider_identity_mismatch",operation);
      providerId=providerId??returnedId;
      if(providerId)await this.store.finish(operation.id,"in_flight",{providerAppointmentId:providerId});
      if(!providerId)this.fail("appointment_write_response_incomplete",operation);
      const actual=appointmentRecord(await this.provider.getAppointment(providerId));
      if(!appointmentMatches(actual,payload,providerId))this.fail("appointment_write_verification_failed",operation);
      return this.accepted(operation,actual,operation.kind==="create"?"created":"updated");
    } catch {
      await this.store.finish(operation.id,"unknown",{...(providerId?{providerAppointmentId:providerId}:{}),lastError:"appointment_write_outcome_unknown"});
      return this.recover({...operation,status:"unknown",providerAppointmentId:providerId});
    }
  }
}
