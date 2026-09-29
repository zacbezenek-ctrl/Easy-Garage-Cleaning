import { fieldJobProjection } from './field-execution.js';
import { segmented } from './dispatch-segments.js';

const text = (value, max=1000) => typeof value === 'string' ? value.slice(0,max) : '';
/** Every stored field crewJobProjection and fieldJobProjection read (id and
 * revision come from document metadata). Masked scans load only these, so
 * signatures, payment evidence and provider payloads never reach Worker memory.
 * Extend this list whenever either projection starts reading a new field. Maps
 * that may also be stored as strings (jobInstructions, instructions, scope) are
 * read whole; the other maps are narrowed to the members the projection reads. */
export const CREW_PROJECTION_FIELDS = Object.freeze([
  'type','employee','date','endDate','time','endTime','allDay','status','reason',
  'pipelineStatus','customer','phone','address','startAt','endAt','arrivalWindow','serviceType',
  'assignedCrew','assignedTo','crewLead','crewId','crewName','vehicleId','vehicleName','crewNeeded','requiredCrewSize','crewSize',
  'jobInstructions','instructions','scope','operationalScope.text','scopeOfWork','discovery.success',
  'logistics.notes','logistics.access','logistics.truck_placement','logistics.requiredEquipment',
  'accessInstructions','customerInstructions','customerNotesSummary','requiredEquipment','materials','requiredMaterials',
  'clientChecklists.preJob','clientChecklists.postJob',
  'fieldExecution.activity','fieldExecution.activityReason','fieldExecution.checklistTemplate','fieldExecution.checks',
  'fieldExecution.materialStates','fieldExecution.photos','fieldExecution.attention','fieldExecution.completion','fieldExecution.jobTime',
  'fieldCompletionSync.status','fieldCompletionSync.message','fieldCompletionSync.attemptedAt','fieldCompletionSync.syncedAt',
  'startedAt','completedAt','cancelledAt',
  'title','durationMin','estimatedDurationMin','shiftPickupEnabled','openShift','shiftClaims','lastShiftClaim',
  'customerConversation','customerConversationUpdatedAt','assignmentSegments',
]);
/** Compatibility DTO for the existing Hub shift and communication cards.
 * Raw Firestore records may contain signatures, costs, payment receipts and
 * private management notes. No crew response may spread those records.
 */
export function crewJobProjection(job, options = {}) {
  if(job.type==='availability')return {
    id:job.id,revision:job.__updateTime||job.revision||'',type:'availability',recordType:'crew_availability',
    employee:text(job.employee,120),date:text(job.date,10),endDate:text(job.endDate||job.date,10),
    time:text(job.time,8),endTime:text(job.endTime,8),allDay:job.allDay===true,status:text(job.status,40),reason:text(job.reason,2000)
  };
  const field=fieldJobProjection(job,[],options),split=segmented(job);
  const ownClaim = claim => claim && typeof claim === 'object' ? {employee:text(claim.employee,120),claimedAt:text(claim.claimedAt,40)} : {employee:text(claim,120)};
  return {
    ...field,type:text(job.type||'job',40),pipelineStatus:field.status,revision:field.expectedRevision,
    assignedTo:field.assignedCrew.join(' + '),title:text(job.title,300),
    durationMin:Number.isFinite(Number(job.durationMin))?Number(job.durationMin):null,
    // Dispatch clears a saved length with null; that reads as no estimate, not 0.
    estimatedDurationMin:job.estimatedDurationMin!==null&&Number.isFinite(Number(job.estimatedDurationMin))?Number(job.estimatedDurationMin):null,
    shiftPickupEnabled:job.shiftPickupEnabled===true,openShift:job.openShift===true,
    // A split job is never an open shift; its old claims would name other segments' crew.
    shiftClaims:(!split&&Array.isArray(job.shiftClaims)?job.shiftClaims:[]).map(ownClaim),
    lastShiftClaim:!split&&job.lastShiftClaim?ownClaim(job.lastShiftClaim):null,
    customerConversation:(Array.isArray(job.customerConversation)?job.customerConversation:[]).slice(-100).map(message=>({
      id:text(message.id,140),requestId:text(message.requestId,140),direction:text(message.direction,40),
      authorRole:text(message.authorRole,40),authorName:text(message.authorName,150),body:text(message.body,4000),createdAt:text(message.createdAt,40),
      delivery:message.delivery?{channel:text(message.delivery.channel,30),status:text(message.delivery.status,40),attemptedAt:text(message.delivery.attemptedAt,40)}:null
    })),
    customerConversationUpdatedAt:text(job.customerConversationUpdatedAt,40)
  };
}
