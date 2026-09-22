import {createHash} from 'node:crypto';
import type {CanonicalEvent,CustomerEventType,EvidenceEvent,Json,SourceRecord} from './types.js';

export type OccurrenceKind='walkthrough'|'job'|'quote';
export type OccurrenceAlias={namespace:string;recordId:string;kind:OccurrenceKind};
export interface OccurrenceIdentity {
  kind:OccurrenceKind; aliases:OccurrenceAlias[]; authoritativePortalId?:string;
  parents?:Array<{relationship:'job_from_walkthrough'|'deal_contains_job'|'quote_for_job';alias:OccurrenceAlias}>;
}
export interface CustomerOccurrence {
  id:string;contactId:string;leadId:string|null;kind:OccurrenceKind;createdAt:string;
  originalSourceType:string;originalSourceRecordId:string;authoritativePortalIds:string[];
  status:'resolved'|'unassigned'|'merged';mergedIntoId:string|null;details:Json;
}
export interface PersistedOccurrenceAlias extends OccurrenceAlias {occurrenceId:string;contactId:string}
export interface OccurrenceLink {id:string;contactId:string;fromOccurrenceId:string;toOccurrenceId:string;relationship:string}
export interface OccurrenceResolution {
  records:SourceRecord[];occurrences:CustomerOccurrence[];aliases:PersistedOccurrenceAlias[];links:OccurrenceLink[];
  issues:Array<{code:string;sourceIds:string[];detail:string}>;
}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const aliasKey=(a:OccurrenceAlias)=>`${a.kind}:${a.namespace}:${a.recordId}`;
const accepted=(e:CanonicalEvent)=>['accepted','deduplicated'].includes(e.syncState);
export function eventOccurrenceKind(type:CustomerEventType):OccurrenceKind|null {
  if(type.startsWith('walkthrough_'))return 'walkthrough';
  if(['job_verbally_accepted','job_sold','job_scheduled','job_completed','revenue_collected','deposit_collected','payment_discussed'].includes(type))return 'job';
  if(['video_quote_requested','video_quote_customer_agreed','video_quote_received','video_quote_in_progress','quote_prepared','quote_delivered','customer_deciding'].includes(type))return 'quote';
  return null;
}
export function readOccurrenceIdentity(event:Pick<EvidenceEvent,'details'>):OccurrenceIdentity|null {
  const value=obj(event.details?.occurrenceIdentity);
  if(!['job','walkthrough','quote'].includes(String(value.kind))||!Array.isArray(value.aliases))return null;
  const kind=value.kind as OccurrenceKind;
  const aliases=value.aliases.map(obj).filter(a=>a.kind===kind&&typeof a.namespace==='string'&&a.namespace&&typeof a.recordId==='string'&&a.recordId).map(a=>({kind,namespace:String(a.namespace),recordId:String(a.recordId)}));
  if(!aliases.length)return null;
  const parents=(Array.isArray(value.parents)?value.parents:[]).map(obj).flatMap(p=>{
    const alias=obj(p.alias);
    return ['job_from_walkthrough','deal_contains_job','quote_for_job'].includes(String(p.relationship))&&['job','walkthrough','quote'].includes(String(alias.kind))&&typeof alias.namespace==='string'&&typeof alias.recordId==='string'?[{relationship:p.relationship as NonNullable<OccurrenceIdentity['parents']>[number]['relationship'],alias:alias as OccurrenceAlias}]:[];
  });
  return {kind,aliases,...(typeof value.authoritativePortalId==='string'?{authoritativePortalId:value.authoritativePortalId}:{}),...(parents.length?{parents}:{})};
}

/** Exact entity links only. A shared customer, opportunity, date, address or price
 * never identifies two jobs as the same work. Persistent aliases outlive retries. */
export function resolveCustomerOccurrences(input:{contactId:string;leadId:string|null;records:SourceRecord[];existingOccurrences?:CustomerOccurrence[];existingAliases?:PersistedOccurrenceAlias[];existingEvents?:CanonicalEvent[];now?:string}):OccurrenceResolution {
  const now=input.now??new Date().toISOString(),issues:OccurrenceResolution['issues']=[],links:OccurrenceLink[]=[];
  const occurrences=new Map((input.existingOccurrences??[]).filter(o=>o.contactId===input.contactId).map(o=>[o.id,{...o,authoritativePortalIds:[...o.authoritativePortalIds],details:{...o.details}}]));
  const aliases=new Map<string,PersistedOccurrenceAlias>();
  for(const a of input.existingAliases??[]){if(a.contactId===input.contactId)aliases.set(aliasKey(a),{...a});else issues.push({code:'occurrence_cross_customer_alias',sourceIds:[a.recordId],detail:'An entity alias belongs to another customer; it was not attached.'});}
  const records=input.records.map(r=>({...r,events:(r.events??[]).map(e=>({...e,details:{...e.details}}))}));
  type Claim={record:SourceRecord;event:EvidenceEvent;identity:OccurrenceIdentity};
  const claims:Claim[]=records.flatMap(record=>(record.events??[]).flatMap(event=>{const identity=readOccurrenceIdentity(event);return identity?[{record,event,identity}]:[];}));
  claims.sort((a,b)=>a.record.occurredAt.localeCompare(b.record.occurredAt)||Number(Boolean(b.identity.authoritativePortalId))-Number(Boolean(a.identity.authoritativePortalId))||a.identity.aliases.map(aliasKey).sort()[0]!.localeCompare(b.identity.aliases.map(aliasKey).sort()[0]!));
  const redirect=(id:string):string=>{const seen=new Set<string>();while(occurrences.get(id)?.mergedIntoId&&!seen.has(id)){seen.add(id);id=occurrences.get(id)!.mergedIntoId!;}return id;};
  const legacyEvents=input.existingEvents??[];
  for(const {record,event,identity} of claims) {
    const ids=[...new Set(identity.aliases.flatMap(a=>{const found=aliases.get(aliasKey(a));return found?[redirect(found.occurrenceId)]:[];}))];
    const portalIds=new Set([...ids.flatMap(id=>occurrences.get(id)?.authoritativePortalIds??[]),...(identity.authoritativePortalId?[identity.authoritativePortalId]:[])]);
    const acceptedIds=ids.filter(id=>legacyEvents.some(e=>e.occurrenceId===id&&accepted(e)));
    if(portalIds.size>1||acceptedIds.length>1) {
      const code=portalIds.size>1?'occurrence_identity_conflict':'occurrence_accepted_identity_conflict';
      issues.push({code,sourceIds:[record.sourceRecordId,...portalIds],detail:'Exact links conflict with distinct authoritative work records or accepted deliveries; automatic identity merging is blocked.'});
      event.humanReviewNeeded=true;event.details={...event.details,occurrenceIdentityConflict:true};
      // Keep the authoritative Portal object separately inspectable even when a
      // broken shared provider link would otherwise collapse two jobs.
      const own=identity.aliases.find(a=>a.namespace.startsWith('portal_'));
      if(!own)continue;
      const existing=aliases.get(aliasKey(own));
      if(existing){event.details={...event.details,occurrenceId:redirect(existing.occurrenceId)};continue;}
      const id=`egco_${digest(`${input.contactId}:${aliasKey(own)}`)}`;
      occurrences.set(id,{id,contactId:input.contactId,leadId:input.leadId,kind:identity.kind,createdAt:now,originalSourceType:record.sourceType,originalSourceRecordId:record.sourceRecordId,authoritativePortalIds:identity.authoritativePortalId?[identity.authoritativePortalId]:[],status:'resolved',mergedIntoId:null,details:{identityConflict:true}});
      aliases.set(aliasKey(own),{...own,contactId:input.contactId,occurrenceId:id});event.details={...event.details,occurrenceId:id};continue;
    }
    let id=ids.sort((a,b)=>Number(acceptedIds.includes(b))-Number(acceptedIds.includes(a))||(occurrences.get(a)?.createdAt??now).localeCompare(occurrences.get(b)?.createdAt??now)||a.localeCompare(b))[0];
    if(!id){const first=[...identity.aliases].sort((a,b)=>Number(b.namespace.startsWith('portal_'))-Number(a.namespace.startsWith('portal_'))||aliasKey(a).localeCompare(aliasKey(b)))[0]!;id=`egco_${digest(`${input.contactId}:${aliasKey(first)}`)}`;occurrences.set(id,{id,contactId:input.contactId,leadId:input.leadId,kind:identity.kind,createdAt:now,originalSourceType:record.sourceType,originalSourceRecordId:record.sourceRecordId,authoritativePortalIds:[],status:'resolved',mergedIntoId:null,details:{}});}
    const winner=occurrences.get(id)!;winner.authoritativePortalIds=[...portalIds].sort();
    for(const loser of ids.filter(value=>value!==id)){const old=occurrences.get(loser)!;old.status='merged';old.mergedIntoId=id;links.push({id:`egcol_${digest(`${loser}:merged_duplicate_of:${id}`)}`,contactId:input.contactId,fromOccurrenceId:loser,toOccurrenceId:id,relationship:'merged_duplicate_of'});}
    for(const a of identity.aliases)aliases.set(aliasKey(a),{...a,contactId:input.contactId,occurrenceId:id});
    event.details={...event.details,occurrenceId:id,occurrenceKind:identity.kind,occurrenceIdentityStatus:'resolved'};
  }
  // A later claim may connect earlier aliases. Apply redirects only after all
  // exact bindings have been considered, making source order immaterial.
  for(const record of records)for(const event of record.events??[]){if(typeof event.details?.occurrenceId==='string')event.details.occurrenceId=redirect(event.details.occurrenceId);}
  for(const a of aliases.values())a.occurrenceId=redirect(a.occurrenceId);
  for(const {event,identity} of claims){const from=event.details?.occurrenceId;if(typeof from!=='string')continue;for(const parent of identity.parents??[]){const to=aliases.get(aliasKey(parent.alias))?.occurrenceId;if(to&&to!==from)links.push({id:`egcol_${digest(`${from}:${parent.relationship}:${to}`)}`,contactId:input.contactId,fromOccurrenceId:from,toOccurrenceId:to,relationship:parent.relationship});}}
  const knownByKind=(kind:OccurrenceKind)=>[...new Set(claims.filter(c=>c.identity.kind===kind&&!c.event.humanReviewNeeded).map(c=>c.event.details?.occurrenceId).filter((id):id is string=>typeof id==='string'))];
  for(const record of records)for(const event of record.events??[]) {
    const kind=eventOccurrenceKind(event.eventType);if(!kind||event.details?.occurrenceId||event.details?.occurrenceIdentityConflict)continue;
    const prior=legacyEvents.find(e=>e.eventType===event.eventType&&e.occurrenceId&&e.evidence.some(ref=>ref.sourceType===record.sourceType&&ref.sourceRecordId===record.sourceRecordId));
    if(prior?.occurrenceId){event.details={...event.details,occurrenceId:redirect(prior.occurrenceId),occurrenceKind:kind,occurrenceIdentityStatus:'unassigned'};continue;}
    // No invented aliases to a known job: an independently supported commitment
    // is retained with its source/span identity and explicitly unassigned.
    const span=typeof event.details?.commitmentSpanKey==='string'?event.details.commitmentSpanKey:'single';
    // The ordinary unresolved bucket is explicitly not a real job identity.
    // Repeated messages cannot manufacture repeated sales. Independently named
    // commitments in one source can have separate exact span keys.
    const alias:OccurrenceAlias=span==='single'?{kind,namespace:'unassigned_acquisition',recordId:input.leadId??input.contactId}:{kind,namespace:`unassigned_${record.sourceType}`,recordId:`${record.sourceRecordId}:${span}`};
    let id=aliases.get(aliasKey(alias))?.occurrenceId;
    if(!id){id=`egco_${digest(`${input.contactId}:${aliasKey(alias)}`)}`;occurrences.set(id,{id,contactId:input.contactId,leadId:input.leadId,kind,createdAt:now,originalSourceType:record.sourceType,originalSourceRecordId:record.sourceRecordId,authoritativePortalIds:[],status:'unassigned',mergedIntoId:null,details:{}});aliases.set(aliasKey(alias),{...alias,contactId:input.contactId,occurrenceId:id});}
    event.details={...event.details,occurrenceId:id,occurrenceKind:kind,occurrenceIdentityStatus:'unassigned',knownOccurrencesOfKind:knownByKind(kind).length};
  }
  // Old lead-stage IDs are reserved for the exact source occurrence they already
  // represent. Splitting a historically collapsed row preserves one original ID;
  // subsequent work gets a distinct business ID, never a new Meta stage ID.
  const allocations=new Map<string,string>();
  const candidates=records.flatMap(record=>(record.events??[]).map(event=>({record,event}))).sort((a,b)=>(a.event.occurredAt??a.record.occurredAt).localeCompare(b.event.occurredAt??b.record.occurredAt)||a.record.sourceRecordId.localeCompare(b.record.sourceRecordId));
  for(const {record,event} of candidates){const occurrenceId=event.details?.occurrenceId;if(typeof occurrenceId!=='string')continue;
    const prior=legacyEvents.filter(e=>e.eventType===event.eventType&&e.details?.paymentReceiptKey===event.details?.paymentReceiptKey&&(e.occurrenceId?redirect(e.occurrenceId)===occurrenceId:e.evidence.some(ref=>ref.sourceType===record.sourceType&&ref.sourceRecordId===record.sourceRecordId))).sort((a,b)=>Number(accepted(b))-Number(accepted(a))||a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId))[0];
    if(prior&&(!allocations.has(prior.eventId)||allocations.get(prior.eventId)===occurrenceId)){allocations.set(prior.eventId,occurrenceId);event.details={...event.details,canonicalEventId:prior.eventId};}
  }
  const transitionKey=(event:EvidenceEvent)=>`${event.details?.occurrenceId}:${event.eventType}:${event.details?.paymentReceiptKey??''}`;
  const chosen=new Map(candidates.flatMap(({event})=>typeof event.details?.canonicalEventId==='string'?[[transitionKey(event),event.details.canonicalEventId] as const]:[]));
  for(const {event} of candidates){const old=chosen.get(transitionKey(event));if(old)event.details={...event.details,canonicalEventId:old};}
  return {records,occurrences:[...occurrences.values()],aliases:[...aliases.values()],links:[...new Map(links.map(l=>[l.id,l])).values()],issues};
}
