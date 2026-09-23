import {describe,it,expect,vi} from 'vitest';
import {selectSemanticWork,semanticRetryDelay,runSemanticQueue,type SemanticCandidate,type SemanticCursor} from './semantic-queue.js';
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
    expect(semanticRetryDelay(['semantic_provider_http_429'],1,false)).toBe(300000);expect(semanticRetryDelay(['semantic_provider_http_429'],20,false)).toBe(21600000);expect(semanticRetryDelay(['semantic_provider_http_400;code=invalid_json_schema'],1,false)).toBe(300000);expect(semanticRetryDelay(['semantic_batch_budget_deferred'],2,false)).toBe(15000);expect(semanticRetryDelay([],1,false,true)).toBe(300000);expect(semanticRetryDelay([],1,false)).toBe(30000);
  });
  it('persists a global provider cooldown after a rate limit so later chunks do not rotate through other contacts',async()=>{
    let clock=now.valueOf();const progress=vi.fn(async()=>{}),finish=vi.fn(async()=>true);
    const reconcile=vi.fn(async({contactIds})=>({failed:0,results:[{contactId:contactIds[0],coverage:{extraction:{complete:false,errors:['semantic_provider_http_429']}}}]}));
    const first=await runSemanticQueue(reconcile,{limit:12,concurrency:1},{candidates:async()=>({candidates:Array.from({length:12},(_,i)=>candidate(String(i))),truncated:false}),claim:async(c)=>cursor({leaseToken:c.contactId,attemptedAt:new Date(clock).toISOString(),workKey:c.workKey}),finish,now:()=>new Date(clock),progress});
    expect(reconcile).toHaveBeenCalledTimes(1);expect(first.providerBackoffUntil).toBe('2026-09-22T08:30:00.000Z');expect(first.deferred).toBe(11);
    const secondProgress=vi.fn(async()=>{});
    const second=await runSemanticQueue(reconcile,{limit:12,concurrency:1},{candidates:async()=>({candidates:Array.from({length:12},(_,i)=>candidate(String(i))),truncated:false,providerBackoffUntil:first.providerBackoffUntil}),claim:async()=>{throw new Error('must not claim during provider cooldown');},finish,now:()=>new Date(clock+60000),progress:secondProgress});
    expect(second.selected).toBe(0);expect(second.inspected).toBe(0);expect(second.providerBackoffUntil).toBe(first.providerBackoffUntil);expect(reconcile).toHaveBeenCalledTimes(1);expect(secondProgress).toHaveBeenCalledWith(expect.objectContaining({status:'provider_backoff'}));
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
