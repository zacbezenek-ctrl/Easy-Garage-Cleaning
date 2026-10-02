import {describe,it,expect,vi} from 'vitest';
import {selectSemanticWork,semanticRetryDelay,semanticQuotaExhausted,runSemanticQueue,type SemanticCandidate,type SemanticCursor} from './semantic-queue.js';
const now=new Date('2026-09-22T08:00:00Z');
const candidate=(id:string,patch:Partial<SemanticCandidate>={}):SemanticCandidate=>({contactId:id,leadCreatedAt:'2026-09-21T00:00:00Z',lastActivityAt:'2026-09-21T00:00:00Z',material:true,complete:false,workKey:`hash-${id}`,pendingSourceCount:1,missingTranscriptCount:0,cursor:null,...patch});
const cursor=(patch:Partial<SemanticCursor>={}):SemanticCursor=>({status:'partial',attemptedAt:'2026-09-20T00:00:00Z',nextAttemptAt:'2026-09-21T00:00:00Z',attemptCount:1,failureCount:1,workKey:'original',...patch});
describe('bounded semantic extraction scheduling',()=>{
  it('prioritizes recent material incomplete work while reserving old-lead rotation',()=>{
    const recent=Array.from({length:25},(_,i)=>candidate(`recent-${i}`)),old=Array.from({length:5},(_,i)=>candidate(`old-${i}`,{leadCreatedAt:'2026-01-01T00:00:00Z',lastActivityAt:'2026-09-01T00:00:00Z',cursor:cursor({workKey:`hash-old-${i}`})}));
    const selected=selectSemanticWork([...old,...recent],now,12);expect(selected.slice(0,3).every(c=>c.contactId.startsWith('recent'))).toBe(true);expect(selected.filter(c=>c.contactId.startsWith('old'))).toHaveLength(3);expect(new Set(selected.map(c=>c.contactId)).size).toBe(12);
  });
  it('respects active leases and backoff, but recognizes changed pending work',()=>{
    const rows=[candidate('leased',{cursor:cursor({status:'processing',leaseUntil:'2026-09-22T09:00:00Z'})}),candidate('backoff',{cursor:cursor({workKey:'hash-backoff',nextAttemptAt:'2026-09-22T09:00:00Z'})}),candidate('changed',{cursor:cursor({workKey:'old-work',nextAttemptAt:'2026-09-22T09:00:00Z'})})];
    expect(selectSemanticWork(rows,now).map(c=>c.contactId)).toEqual(['changed']);
  });
  it('bounds transient retries and gives configuration failures a slower backoff',()=>{
    expect(semanticRetryDelay(['semantic_provider_http_429'],1,false)).toBe(30000);expect(semanticRetryDelay(['semantic_provider_http_429'],20,false)).toBe(900000);expect(semanticRetryDelay(['semantic_provider_http_400;code=invalid_json_schema'],1,false)).toBe(300000);expect(semanticRetryDelay(['semantic_batch_budget_deferred'],2,false)).toBe(15000);expect(semanticRetryDelay([],1,false,true)).toBe(300000);expect(semanticRetryDelay([],1,false)).toBe(30000);
  });
  it('limits concurrent contacts to three and writes progress as work finishes',async()=>{
    let active=0,maximum=0;const progress=vi.fn(async()=>{}),finish=vi.fn(async()=>true);
    const reconcile=vi.fn(async({contactIds})=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return {failed:0,results:[{contactId:contactIds[0],coverage:{extraction:{complete:true,errors:[]}}}]};});
    const result=await runSemanticQueue(reconcile,{limit:12,concurrency:3},{candidates:async()=>({candidates:Array.from({length:20},(_,i)=>candidate(String(i))),truncated:false}),claim:async(c)=>cursor({leaseToken:c.contactId,attemptedAt:now.toISOString(),workKey:c.workKey}),finish,now:()=>now,progress});
    expect(maximum).toBe(3);expect(reconcile).toHaveBeenCalledTimes(12);expect(finish).toHaveBeenCalledTimes(12);expect(result.pending).toBe(8);expect(result.complete).toBe(false);expect(progress).toHaveBeenCalledTimes(26);expect(reconcile.mock.calls.every(([args])=>args.semanticMaxBatches===1&&args.semanticTimeoutMs===75000)).toBe(true);
  });
  it('stops starting new contacts at the chunk deadline while finishing in-flight work',async()=>{
    let clock=now.valueOf();const reconcile=vi.fn(async({contactIds})=>{clock+=80000;return {failed:0,results:[{contactId:contactIds[0],coverage:{extraction:{complete:true,errors:[]}}}]};});
    const result=await runSemanticQueue(reconcile,{limit:12,concurrency:1,deadlineMs:150000},{candidates:async()=>({candidates:Array.from({length:12},(_,i)=>candidate(String(i))),truncated:false}),claim:async(c)=>cursor({leaseToken:c.contactId,attemptedAt:now.toISOString()}),finish:async()=>true,now:()=>new Date(clock),progress:async()=>{}});
    expect(reconcile).toHaveBeenCalledTimes(2);expect(result.deferred).toBe(10);expect(result.complete).toBe(false);
  });
});

describe('customer isolation and provider quota circuit',()=>{
  it('keeps hiring records out of customer semantic processing without excluding DNC customer history',async()=>{
    const {customerSemanticEligible}=await import('./semantic-queue.js');
    for(const tags of [['applicant'],['Applicant-active'],['applicant_interview'],['internal']])expect(customerSemanticEligible({tags})).toBe(false);
    expect(customerSemanticEligible({tags:['dnc']})).toBe(true);expect(customerSemanticEligible({tags:['customer']})).toBe(true);
  });
  it.each(['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded'])('recognizes explicit quota code %s with the existing cooldown',(code)=>{
    const error=`semantic_provider_http_429;code=${code}`;
    expect(semanticQuotaExhausted([error])).toBe(true);
    expect(semanticRetryDelay([error],1,false)).toBe(3600000);
    expect(semanticRetryDelay([error],999,false)).toBe(3600000);
  });
  it('recognizes the provider quota type when a specific code is absent',()=>{
    const error='semantic_provider_http_429;type=insufficient_quota;provider_project=proj_SyntheticProject123';
    expect(semanticQuotaExhausted([error])).toBe(true);
    expect(semanticRetryDelay([error],233,false)).toBe(3600000);
  });
  it.each(['semantic_provider_http_429','semantic_provider_http_429;code=rate_limit_exceeded;type=rate_limit_error','semantic_provider_http_429;code=insufficient_quota_extra','semantic_provider_http_429;type=insufficient_quota_extra','semantic_provider_http_429;detail=insufficient_quota','semantic_provider_http_429;code=unknown'])('preserves ordinary throttle backoff for %s',(error)=>{
    expect(semanticQuotaExhausted([error])).toBe(false);
    expect(semanticRetryDelay([error],1,false)).toBe(30000);
    expect(semanticRetryDelay([error],99,false)).toBe(900000);
  });
  it('requires HTTP 429 and exact diagnostic fields',()=>{
    for(const error of ['semantic_provider_http_400;code=insufficient_quota','semantic_provider_http_503;type=insufficient_quota','other_semantic_provider_http_429;type=insufficient_quota','semantic_provider_http_4290;type=insufficient_quota'])expect(semanticQuotaExhausted([error])).toBe(false);
  });
  it.each(['code=insufficient_quota','type=insufficient_quota','code=project_spend_limit_exceeded'])('stops new work for %s, preserves pending work during cooldown, then probes once',async(diagnostic)=>{
    let circuit:any=null,clock=now.valueOf();const writes:any[]=[];
    const deps={candidates:async()=>({candidates:Array.from({length:12},(_,i)=>candidate(String(i))),truncated:false}),claim:async(c:SemanticCandidate)=>cursor({leaseToken:c.contactId,attemptedAt:new Date(clock).toISOString(),workKey:c.workKey}),finish:async()=>true,now:()=>new Date(clock),progress:async(v:any)=>{writes.push(v);},readProviderCircuit:async()=>circuit,writeProviderCircuit:async(v:any)=>{circuit=v;}};
    const reconcile=vi.fn(async({contactIds})=>({failed:0,results:[{contactId:contactIds[0],coverage:{extraction:{complete:false,errors:[`semantic_provider_http_429;${diagnostic}`]}}}]}));
    const first=await runSemanticQueue(reconcile,{concurrency:1},deps);expect(reconcile).toHaveBeenCalledTimes(1);expect(first).toMatchObject({pending:12,complete:false,deferred:11,providerCircuit:{reason:'insufficient_quota'}});
    await runSemanticQueue(reconcile,{},deps);expect(reconcile).toHaveBeenCalledTimes(1);expect(writes.at(-1).status).toBe('provider_cooldown');
    clock+=3600001;reconcile.mockImplementation(async({contactIds})=>({failed:0,results:[{contactId:contactIds[0],coverage:{extraction:{complete:true,errors:[]}}}]}));
    const recovered=await runSemanticQueue(reconcile,{},deps);expect(reconcile).toHaveBeenCalledTimes(2);expect(recovered.selected).toBe(1);expect(circuit).toBeNull();
  });
});
