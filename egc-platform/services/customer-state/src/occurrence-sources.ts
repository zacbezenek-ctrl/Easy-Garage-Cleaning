import type {SourceBundle} from './sources.js';
import type {SourceRecord,Json} from './types.js';
import {eventOccurrenceKind,type OccurrenceIdentity,type OccurrenceAlias} from './occurrences.js';
const str=(v:unknown)=>typeof v==='string'?v:'';
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};

/** Source identities survive cached extraction in event details. Only exact
 * provider/local/Portal keys may join work; parent deal/visit links stay separate. */
export function attachOccurrenceIdentities(records:SourceRecord[],bundle:SourceBundle):SourceRecord[] {
  return records.map(record=>record.events?({...record,events:record.events.map(event=>{
    const kind=eventOccurrenceKind(event.eventType);if(!kind)return event;
    const aliases:OccurrenceAlias[]=[],parents:NonNullable<OccurrenceIdentity['parents']>=[];
    const alias=(namespace:string,id:unknown)=>{if(str(id))aliases.push({namespace,recordId:str(id),kind});};
    let authoritativePortalId:string|undefined;
    if(record.sourceType==='appointment'){alias('provider_appointment',record.sourceRecordId);alias('local_appointment',record.appointmentId);}
    if(record.sourceType==='job'||(record.sourceType==='job_note'&&kind==='job')){
      alias('local_job',record.jobId??record.sourceRecordId);
      const job=(bundle.jobs??[]).find(j=>j.id===(record.jobId??record.sourceRecordId)),appointment=(bundle.appointments??[]).find(a=>a.id===job?.appointmentId);
      alias('local_appointment',job?.appointmentId);alias('provider_appointment',appointment?.providerId);
      if(job?.opportunityId)parents.push({relationship:'deal_contains_job',alias:{kind:'job',namespace:'local_opportunity',recordId:str(job.opportunityId)}});
    }
    if(record.sourceType==='walkthrough'){
      const visit=(bundle.walkthroughs??[]).find(w=>w.id===record.sourceRecordId);alias('local_walkthrough',record.sourceRecordId);alias('portal_walkthrough',visit?.portalVisitId);
      if(visit?.portalVisitId)authoritativePortalId=str(visit.portalVisitId);
    }
    if(record.sourceType==='portal_job'||record.sourceType==='portal_visit'||record.sourceType==='portal_payment'){
      const portal=(bundle.portalRecords??[]).find(p=>p.id===record.sourceRecordId&&p.highlevelContactId===bundle.contact.providerId);
      authoritativePortalId=portal?.kind==='payment'?portal.jobId??undefined:portal?.id??record.sourceRecordId;
      alias(`portal_${kind}`,authoritativePortalId);
      alias('local_job',portal?.normalizedLocalJobId);alias('local_appointment',portal?.normalizedLocalAppointmentId);
      alias('provider_appointment',portal?.highlevelAppointmentId??event.details?.providerAppointmentId);
      if(portal?.sourceWalkthroughId)parents.push({relationship:'job_from_walkthrough',alias:{kind:'walkthrough',namespace:'portal_walkthrough',recordId:portal.sourceWalkthroughId}});
      const quote=obj(portal?.financials?.quote);
      if(kind==='quote'&&str(quote.id)){aliases.length=0;alias('portal_quote_revision',`${quote.id}:${quote.revision??'initial'}`);authoritativePortalId=undefined;}
    }
    if(!aliases.length)return event;
    const occurrenceIdentity:OccurrenceIdentity={kind,aliases,...(authoritativePortalId?{authoritativePortalId}:{}),...(parents.length?{parents}:{})};
    return {...event,details:{...event.details,occurrenceIdentity}};
  })}):record);
}
