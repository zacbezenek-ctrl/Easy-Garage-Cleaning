import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {authorize,commandSchema,PORTAL_PASSTHROUGH,RECURRING_HORIZON_ACTOR,RECURRING_HORIZON_COMMAND,WRITE_COMMANDS,type Actor} from './contracts.js';
import {OperationsService} from './service.js';

const worker:Actor={id:RECURRING_HORIZON_ACTOR,kind:'integration',role:'integration',workspace:'egc'};
const denied=(actor:Actor)=>{try{authorize(actor,commandSchema.parse({command:RECURRING_HORIZON_COMMAND}),'egc');return null;}catch(error){return (error as {code?:string}).code;}};
describe('recurring.extend_horizon bridge contract',()=>{
 it('is a bounded strict write command that is never a portal passthrough',()=>{
  expect(RECURRING_HORIZON_COMMAND).toBe('recurring.extend_horizon');
  expect(WRITE_COMMANDS.has(RECURRING_HORIZON_COMMAND)).toBe(true);expect(PORTAL_PASSTHROUGH.has(RECURRING_HORIZON_COMMAND)).toBe(false);
  for(const body of [{},{after:'plan_abc'},{after:null,maxPlans:25,limit:20},{maxPlans:1,limit:1}])expect(commandSchema.safeParse({command:RECURRING_HORIZON_COMMAND,...body}).success).toBe(true);
  for(const body of [{maxPlans:0},{maxPlans:26},{limit:21},{limit:1.5},{after:'bad id'},{now:'2026-09-22T12:00:00Z'},{actor:worker},{planId:'plan_a'}])expect(commandSchema.safeParse({command:RECURRING_HORIZON_COMMAND,...body}).success,JSON.stringify(body)).toBe(false);
 });
 it('authorizes only the recurring-horizon-worker integration actor',()=>{
  expect(denied(worker)).toBeNull();
  for(const actor of [{...worker,id:'booking-adoption-worker'},{...worker,id:'mcp-oauth-grant:owner'},{id:'zacb',kind:'human',role:'owner',workspace:'egc'},{id:'tylerg',kind:'human',role:'manager',workspace:'egc'}] as Actor[])expect(denied(actor)).toBe('recurring_horizon_internal_only');
  expect(denied({...worker,workspace:'other'})).toBe('workspace_forbidden');
 });
 it('is never executed or forwarded through the public operations service, even for the worker actor',async()=>{
  const service=new OperationsService({} as ConstructorParameters<typeof OperationsService>[0],{workspace:'egc',portalRead:async()=>{throw new Error('must not forward');}});
  await expect(service.execute(worker,{command:RECURRING_HORIZON_COMMAND},randomUUID())).rejects.toMatchObject({code:'recurring_horizon_internal_only',status:403});
  await expect(service.execute({id:'zacb',kind:'human',role:'owner',workspace:'egc'},{command:RECURRING_HORIZON_COMMAND},randomUUID())).rejects.toMatchObject({code:'recurring_horizon_internal_only',status:403});
 });
});
