import {describe,it,expect} from 'vitest';
import {ReconciliationFailure,reconciliationDiagnostic,safeReconciliationCode} from './reconciliation-diagnostics.js';
describe('safe reconciliation diagnostics',()=>{
 it('preserves only finite bridge codes and bounded HTTP status',()=>{
  expect(reconciliationDiagnostic({code:'service_key_source_unavailable',status:503,details:{upstreamStatus:502,token:'secret'},message:'private customer'},'hub_calendar')).toEqual({stage:'hub_calendar',errorCode:'service_key_source_unavailable',httpStatus:503,upstreamStatus:502});
  expect(safeReconciliationCode('service_private_customer_name')).toBeNull();
 });
 it('drops provider bodies, messages, stack traces, unknown codes and invalid status',()=>{
  expect(reconciliationDiagnostic({code:'customer-secret',message:'Bearer secret body',stack:'private',status:123456,details:{upstreamStatus:'503'}})).toEqual({stage:'startup',errorCode:'reconciliation_unavailable'});
 });
 it('extracts only known SQLSTATE and transport causes through bounded wrappers',()=>{
  expect(reconciliationDiagnostic(new Error('select customer data',{cause:{code:'42703',message:'private SQL'}}),'provider_snapshot')).toEqual({stage:'provider_snapshot',errorCode:'database_unavailable',sqlState:'42703'});
  expect(reconciliationDiagnostic(new Error('fetch URL token',{cause:{code:'ECONNRESET'}}),'hub_calendar')).toEqual({stage:'hub_calendar',errorCode:'network_unavailable'});
  const cyclic:{cause?:unknown}={};cyclic.cause=cyclic;expect(reconciliationDiagnostic(cyclic).errorCode).toBe('reconciliation_unavailable');
 });
 it('retains the actual worker stage through outer startup failure handling',()=>{
  const failure=new ReconciliationFailure({code:'service_request_replayed',status:409},'hub_job');
  expect(reconciliationDiagnostic(failure,'startup')).toEqual({stage:'hub_job',errorCode:'service_request_replayed',httpStatus:409});
  expect(failure.message).toBe('service_request_replayed');expect(failure).not.toHaveProperty('cause');
 });
});
