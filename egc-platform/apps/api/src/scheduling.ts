import {and,desc,eq,inArray,sql} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
import {GhlClient,asDate,asRecord,asString} from "@egc/ghl";
import {recomputeLeadState} from "@egc/lead-audit";
import {ReliableAppointments,postgresAppointmentStore,AppointmentOperationError,OperationsError,appointmentStatus,type Actor,type Command,type AppointmentProvider} from "@egc/operations";
type Json=Record<string,unknown>;
type Sync=Extract<Command,{command:"schedule.sync_provider"}>;
type Portal=(actor:Actor,command:Command)=>Promise<Json>;
const raw=(p:Json)=>Object.keys(asRecord(p.event)).length?asRecord(p.event):p;

export async function syncPortalSchedule(actor:Actor,command:Sync,portal:Portal,options:{env?:NodeJS.ProcessEnv;db?:ReturnType<typeof getDb>;provider?:AppointmentProvider&GhlClient}={}){
  const env=options.env??process.env,db=options.db??getDb(),provider=options.provider??GhlClient.fromEnv();
  const system:Actor={id:`schedule-sync:${actor.id}`,kind:"integration",role:"integration",workspace:actor.workspace};
  try{
    let visit:Json;
    try{visit=asRecord((await portal(actor,{command:"schedule.resolve",portalVisitId:command.portalVisitId})).visit);}
    catch(error){
      if(!(error instanceof OperationsError)||error.code!=="schedule_customer_link_missing")throw error;
      const job=asRecord((await portal(actor,{command:"portal.job",jobId:command.portalVisitId})).job);
      const providerContactId=asString(job.highlevelContactId)??command.contactProviderId;
      if(!providerContactId||!job.revision)throw new OperationsError("schedule_provider_contact_not_linked",409);
      const result=await provider.getContact(providerContactId),contact=Object.keys(asRecord(result.contact)).length?asRecord(result.contact):result;
      if(contact.id!==providerContactId||contact.locationId&&contact.locationId!==provider.locationId)throw new OperationsError("schedule_provider_contact_mismatch",409);
      visit=asRecord((await portal(system,{command:"schedule.link_customer",portalVisitId:command.portalVisitId,expectedRevision:String(job.revision),providerContact:contact})).visit);
    }
    if(visit.portalVisitId!==command.portalVisitId||!visit.portalCustomerId||!visit.startTime||!visit.endTimeInstant)throw new OperationsError("schedule_identity_unverified",409);
    if(command.contactProviderId&&visit.highlevelContactId&&command.contactProviderId!==visit.highlevelContactId)throw new OperationsError("schedule_provider_contact_mismatch",409);
    const providerContactId=asString(visit.highlevelContactId)??command.contactProviderId;
    if(!providerContactId)throw new OperationsError("schedule_provider_contact_not_linked",409);
    // Claim the native exact visit before any provider write. The contact GET is
    // proof for the signed customer bridge, not browser-supplied customer data.
    const identityResult=await provider.getContact(providerContactId),identity=Object.keys(asRecord(identityResult.contact)).length?asRecord(identityResult.contact):identityResult;
    if(identity.id!==providerContactId||identity.locationId&&identity.locationId!==provider.locationId)throw new OperationsError("schedule_provider_contact_mismatch",409);
    visit=asRecord((await portal(system,{command:"schedule.link_customer",portalVisitId:command.portalVisitId,expectedRevision:String(visit.revision),providerContact:identity})).visit);
    let [contact]=await db.select().from(schema.contacts).where(and(eq(schema.contacts.provider,"ghl"),eq(schema.contacts.providerId,providerContactId))).limit(1);
    if(!contact){
      const result=await provider.getContact(providerContactId),c=Object.keys(asRecord(result.contact)).length?asRecord(result.contact):result;
      if(c.id!==providerContactId||c.locationId&&c.locationId!==provider.locationId)throw new OperationsError("schedule_provider_contact_mismatch",409);
      [contact]=await db.insert(schema.contacts).values({provider:"ghl",providerId:providerContactId,name:asString(c.name)??[asString(c.firstName),asString(c.lastName)].filter(Boolean).join(" "),phone:asString(c.phone)??null,email:asString(c.email)??null,source:asString(c.source)??null,raw:c,providerCreatedAt:asDate(c.dateAdded)??null}).onConflictDoUpdate({target:[schema.contacts.provider,schema.contacts.providerId],set:{updatedAt:new Date()}}).returning();
    }
    if(!contact)throw new OperationsError("schedule_contact_mirror_unavailable",503);
    await db.insert(schema.leads).values({contactId:contact.id,source:contact.source,createdAt:contact.providerCreatedAt??new Date()}).onConflictDoNothing();
    const history=await db.select().from(schema.appointmentOperations).where(and(sql`${schema.appointmentOperations.request}->'context'->>'portalVisitId'=${command.portalVisitId}`,inArray(schema.appointmentOperations.status,["in_flight","unknown","accepted"]))).orderBy(desc(schema.appointmentOperations.createdAt));
    const unresolved=history.find(o=>o.status!=="accepted");
    const sender=new ReliableAppointments(postgresAppointmentStore(db),provider);
    if(unresolved){
      // Recover the original command before considering a changed Hub schedule.
      await sender.reconcile(unresolved.id);
    }
    const recordedIds=[...new Set(history.map(o=>o.providerAppointmentId).filter((id):id is string=>Boolean(id)))];
    if(recordedIds.length>1)throw new OperationsError("schedule_provider_links_ambiguous",409);
    let providerId=asString(visit.highlevelAppointmentId)??recordedIds[0]??null;
    if(!providerId&&unresolved){providerId=(await postgresAppointmentStore(db).get(unresolved.id))?.providerAppointmentId??null;}
    if(visit.highlevelAppointmentId&&recordedIds[0]&&recordedIds[0]!==visit.highlevelAppointmentId)throw new OperationsError("schedule_provider_link_conflict",409);
    const state=String(visit.status).toLowerCase(),status=["cancelled","canceled"].includes(state)?"cancelled":["completed","paid","invoiced","closed","review_requested"].includes(state)?"showed":["noshow","no_show","no-show"].includes(state)?"noshow":"confirmed";
    const payload:Json={title:String(visit.title),startTime:String(visit.startTime),endTime:String(visit.endTimeInstant),address:String(visit.address??""),appointmentStatus:status,toNotify:command.runAutomations};
    const context={contactId:contact.id,contactProviderId:providerContactId,portalVisitId:command.portalVisitId};
    let verified;
    if(providerId){
      const existing=raw(await provider.getAppointment(providerId));
      if(existing.id!==providerId||existing.contactId!==providerContactId)throw new OperationsError("schedule_provider_link_conflict",409);
      verified=await sender.update(providerId,payload,context,command.requestId);
    }else{
      if(status==="cancelled"||status==="noshow")return{ok:true,authority:"employee_hub",portalVisitId:command.portalVisitId,providerSync:"not_needed",appointmentId:null};
      const calendarPayload=await provider.getCalendars(),calendars=Array.isArray(calendarPayload.calendars)?calendarPayload.calendars.map(asRecord):[];
      const configured=visit.type==="walkthrough"?env.GHL_WALKTHROUGH_CALENDAR_ID:env.GHL_JOBS_CALENDAR_ID;
      const candidates=calendars.filter(c=>typeof c.id==="string"&&(configured?c.id===configured:visit.type==="walkthrough"?/walkthrough/i.test(String(c.name)):/customer.?jobs/i.test(String(c.name))));
      if(candidates.length!==1||/employee|hiring|interview/i.test(String(candidates[0]?.name)))throw new OperationsError("schedule_calendar_ambiguous_or_unavailable",409);
      verified=await sender.create({...payload,calendarId:candidates[0]!.id,contactId:providerContactId},context,null,command.requestId);
    }
    const event=verified.event;
    const [prior]=await db.select().from(schema.appointments).where(eq(schema.appointments.providerId,String(event.id))).limit(1);
    const values={providerId:String(event.id),contactId:contact.id,calendarId:asString(event.calendarId)??null,title:asString(event.title)??null,status:appointmentStatus(event.appointmentStatus??event.appoinmentStatus??event.status) as "new"|"confirmed"|"cancelled"|"showed"|"noshow"|"invalid",assignedUserId:asString(event.assignedUserId)??null,appointmentCreatedAt:asDate(event.dateAdded)??asDate(event.createdAt)??prior?.appointmentCreatedAt??null,appointmentStartAt:new Date(String(event.startTime)),appointmentEndAt:asDate(event.endTime)??null,notes:asString(event.description)??asString(event.notes)??null,raw:event,updatedAt:new Date()};
    const [appointment]=await db.insert(schema.appointments).values(values).onConflictDoUpdate({target:schema.appointments.providerId,set:values}).returning();
    await recomputeLeadState(contact.id);
    // Read the current revision for a link-only CAS. The portal verifies all saved
    // schedule fields still equal this provider event before acknowledging sync.
    const latest=asRecord((await portal(actor,{command:"schedule.resolve",portalVisitId:command.portalVisitId})).visit);
    await portal(system,{command:"schedule.bind_provider",portalVisitId:command.portalVisitId,expectedRevision:String(latest.revision),operationId:verified.operationId,event});
    await db.insert(schema.auditLogs).values({actor:actor.id,action:"schedule.provider.verified",entity:"appointment",entityId:appointment!.id,newValue:{operationId:verified.operationId,portalVisitId:command.portalVisitId,providerAppointmentId:event.id},source:"operations"});
    return {ok:true,authority:"employee_hub",providerSync:"verified",portalVisitId:command.portalVisitId,operationId:verified.operationId,appointmentId:event.id,contactId:providerContactId,calendarId:event.calendarId,appointment};
  }catch(error){if(error instanceof OperationsError)throw error;if(error instanceof AppointmentOperationError)throw new OperationsError(error.code,409,{operationId:error.operationId});throw new OperationsError("schedule_provider_sync_unavailable",503);}
}
