import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {authorize,commandSchema,type Actor} from './contracts.js';
import {OperationsService} from './service.js';
const actor:Actor={id:'booking-adoption-worker',kind:'integration',role:'integration',workspace:'egc'};
const input=()=>({command:'schedule.adopt',requestId:randomUUID(),proof:{source:'ghl_appointment',sourceId:'verified-appointment',sourceRevision:'r1',contactProviderId:'verified-contact',providerContact:{id:'verified-contact'},kind:'walkthrough',startAt:'2026-09-22T20:15:00Z',endAt:'2026-09-22T20:45:00Z',address:'Synthetic address',title:'Walkthrough',originalBookingAt:null,sourceCreatedAt:null,verifiedAt:'2026-09-22T07:00:00Z',providerAppointmentId:'verified-appointment',providerCalendarId:'verified-calendar',providerStatus:'confirmed',localJobId:null,normalizedLocalAppointmentId:null,evidenceIds:['source:verified']}});
describe('internal booking adoption contract',()=>{
 it('permits only bounded exact local operational scope and rejects structured financial transfer',()=>{
  const localJobId=randomUUID(),scope={sourceType:'local_job',sourceId:localJobId,sourceCreatedAt:null,sourceUpdatedAt:null,serviceType:'Garage relocation',accessNotes:'Use side gate',itemsKeep:[],itemsRelocate:['Move workout items'],itemsRemove:[],estimatedLaborHours:5},i=input(),proof={...i.proof,localJobId,operationalScope:scope};
  expect(commandSchema.safeParse({...i,proof}).success).toBe(true);
  for(const change of [{sourceId:randomUUID()},{sourceCreatedAt:'bad-date'},{priceCents:13900},{itemsRelocate:'move item'},{estimatedLaborHours:Infinity},{itemsKeep:Array(19).fill('x'.repeat(1000))}])expect(commandSchema.safeParse({...i,proof:{...proof,operationalScope:{...scope,...change}}}).success).toBe(false);
 });
 it('requires exact proof shape and source links without open-ended payload or notification options',()=>{expect(commandSchema.safeParse(input()).success).toBe(true);expect(commandSchema.safeParse({...input(),runAutomations:true}).success).toBe(false);const i=input();expect(commandSchema.safeParse({...i,proof:{...i.proof,customerName:'name match'}}).success).toBe(false);expect(commandSchema.safeParse({...i,proof:{...i.proof,evidenceIds:[]}}).success).toBe(false);});
 it('rejects human and generic integration callers even with a syntactically valid proof',()=>{const c=commandSchema.parse(input());expect(()=>authorize(actor,c,'egc')).not.toThrow();for(const a of [{...actor,id:'mcp'},{...actor,kind:'human',role:'owner'}])expect(()=>authorize(a as Actor,c,'egc')).toThrow('schedule_adoption_internal_only');});
 it('never forwards public RPC proof, including a forged internal actor, to the portal',async()=>{const service=new OperationsService({} as ConstructorParameters<typeof OperationsService>[0],{workspace:'egc',portalRead:async()=>{throw new Error('must not forward');}});await expect(service.execute(actor,input(),randomUUID())).rejects.toMatchObject({code:'schedule_adoption_internal_only',status:403});});
});
