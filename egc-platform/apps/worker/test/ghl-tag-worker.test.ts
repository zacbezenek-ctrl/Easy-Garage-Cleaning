import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('@egc/database',()=>({schema:{syncCursors:{key:'key'}},getDb:()=>{throw new Error('the database is injected in these tests');}}));
import {SERVICE_ORIGINS,servicePublicKeySet,signServiceRequest,verifyServiceRequest} from '@egc/operations';
import {GHL_TAG_DRAIN_INTERVAL_MS,GHL_TAG_DRAIN_PATH,ghlTagDrainCounts,runGhlTagDrainTick,startGhlTagWorker,type GhlTagDrainResult} from '../src/ghl-tag-worker.js';

const SECRET='synthetic-ghl-tag-worker-api-root-secret-0123456789';
const NOW=Date.parse('2026-09-22T18:00:00.000Z');
const ENV={API_BEARER_TOKEN:SECRET,EGC_GHL_TAG_DRAIN_ENABLED:'true'};
const SUMMARY={due:4,attempted:3,done:1,waiting:1,retrying:1,parked:0,skipped:0,busy:0,truncated:false,jobIds:['visit-synthetic-private'],tags:['egc-hub-scheduled']};
type Call={url:string;init:RequestInit};
function hub(respond:(call:Call)=>Response|Promise<Response>=()=>Response.json({ok:true,summary:SUMMARY})){
 const calls:Call[]=[];
 return {calls,fetcher:async(url:string,init:RequestInit)=>{const call={url,init};calls.push(call);return respond(call);}};
}
const envelopeOf=(call:Call)=>(JSON.parse(String(call.init.body)) as {envelope:string}).envelope;
const stops:Array<()=>void>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);});
afterEach(()=>{for(const stop of stops.splice(0))stop();vi.useRealTimers();});

describe('HighLevel tag drain worker',()=>{
 it('signs a v2 request the Hub verifier accepts for exactly the tag drain path and the ghl-tag-worker identity',async()=>{
  const {calls,fetcher}=hub();
  const result=await runGhlTagDrainTick({env:ENV,fetcher,now:()=>NOW,requestId:()=>'0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b'});
  expect(result).toEqual({status:'completed',code:'',httpStatus:200,counts:{due:4,attempted:3,done:1,waiting:1,retrying:1,parked:0,skipped:0,busy:0,truncated:false}});
  const [call]=calls;
  expect(call!.url).toBe(`${SERVICE_ORIGINS.hub}/api/ghl-tag-drain`);
  expect(call!.init).toMatchObject({method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json'}});
  expect(Object.keys(JSON.parse(String(call!.init.body)))).toEqual(['envelope']);
  const keys=await servicePublicKeySet({service:'api',rootSecret:SECRET,workspace:'egc'}),nonces=new Set<string>();
  const claims=await verifyServiceRequest(envelopeOf(call!),{service:'hub',workspace:'egc',path:GHL_TAG_DRAIN_PATH,now:NOW,resolveKey:async()=>keys.keys[0]!,consumeNonce:async(_issuer,nonce)=>!nonces.has(nonce)&&!!nonces.add(nonce)});
  expect(claims.actor).toEqual({id:'ghl-tag-worker',kind:'integration',role:'integration',workspace:'egc'});
  expect(claims.request).toEqual({requestId:'0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b',body:{command:'ghl_tags.drain'}});
  expect([claims.iss,claims.aud,claims.path,claims.iat]).toEqual([SERVICE_ORIGINS.api,SERVICE_ORIGINS.hub,'/api/ghl-tag-drain',NOW/1000]);
  await expect(verifyServiceRequest(envelopeOf(call!),{service:'hub',workspace:'egc',path:'/api/messaging-cron',now:NOW,resolveKey:async()=>keys.keys[0]!,consumeNonce:async()=>true})).rejects.toThrow('invalid_service_claims');
  expect(JSON.stringify(result)).not.toMatch(/visit-synthetic-private|egc-hub-scheduled/);
 });

 it('classifies Hub outcomes without echoing Hub error text',async()=>{
  const cases:Array<[()=>Response|never,Partial<GhlTagDrainResult>]>=[
   [()=>Response.json({ok:false,code:'ghl_tag_outbox_disabled',error:'The HighLevel tag outbox is turned off.'},{status:409}),{status:'disabled',code:'ghl_tag_outbox_disabled',httpStatus:409}],
   [()=>Response.json({ok:false,code:'ghl_tag_drain_unauthorized',error:'x'},{status:401}),{status:'rejected',code:'ghl_tag_drain_unauthorized',httpStatus:401}],
   [()=>Response.json({ok:false,code:'ghl_tag_highlevel_not_configured',error:'Synthetic private detail'},{status:503}),{status:'failed',code:'ghl_tag_highlevel_not_configured',httpStatus:503}],
   [()=>new Response('<html>Bad gateway</html>',{status:502}),{status:'failed',code:'http_502',httpStatus:502}],
   [()=>{throw new Error('socket hang up token=synthetic');},{status:'unknown',code:'hub_unreachable',httpStatus:null}],
  ];
  for(const [respond,expected] of cases){const {fetcher}=hub(respond);const result=await runGhlTagDrainTick({env:ENV,fetcher,now:()=>NOW});expect(result).toMatchObject(expected);expect(JSON.stringify(result)).not.toMatch(/synthetic|private|gateway/i);}
  const unsigned=hub();
  expect(await runGhlTagDrainTick({env:{EGC_GHL_TAG_DRAIN_ENABLED:'true'},fetcher:unsigned.fetcher,now:()=>NOW})).toEqual({status:'not_configured',code:'service_signing_not_configured',httpStatus:null,counts:{}});
  expect(unsigned.calls).toHaveLength(0);
  expect(ghlTagDrainCounts({due:-1,done:'2',parked:1.5,waiting:-3})).toMatchObject({due:null,done:null,parked:null,waiting:null});
  expect(ghlTagDrainCounts({waiting:2}).waiting).toBe(2);
 });

 it('stays off unless EGC_GHL_TAG_DRAIN_ENABLED is exactly true',async()=>{
  const tick=vi.fn(async()=>({status:'completed',code:'',httpStatus:200,counts:{}} as GhlTagDrainResult));
  for(const env of [{},{EGC_GHL_TAG_DRAIN_ENABLED:'TRUE'},{EGC_GHL_TAG_DRAIN_ENABLED:'1'},{EGC_MESSAGING_CRON_ENABLED:'true'}])stops.push(startGhlTagWorker({env,tick,record:vi.fn(async()=>undefined),logger:{error:vi.fn()}}));
  await vi.advanceTimersByTimeAsync(60*60_000);
  expect(tick).not.toHaveBeenCalled();
 });

 it('ticks every 2 minutes, never overlaps a tick that is still running, and stops cleanly',async()=>{
  expect(GHL_TAG_DRAIN_INTERVAL_MS).toBe(120_000);
  let finish:()=>void=()=>{};
  const tick=vi.fn(()=>new Promise<GhlTagDrainResult>(resolve=>{finish=()=>resolve({status:'completed',code:'',httpStatus:200,counts:{done:1,parked:0}});}));
  const record=vi.fn(async()=>undefined),logger={error:vi.fn(),info:vi.fn()};
  const stop=startGhlTagWorker({env:ENV,tick,record,logger,now:()=>Date.now()});stops.push(stop);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(6*60_000);
  expect(tick).toHaveBeenCalledTimes(1);
  finish();await vi.advanceTimersByTimeAsync(0);
  expect(record).toHaveBeenCalledWith('ghl_tag_drain:last_success','2026-09-22T18:06:00.000Z');
  await vi.advanceTimersByTimeAsync(119_000);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(tick).toHaveBeenCalledTimes(2);
  finish();stop();
  await vi.advanceTimersByTimeAsync(60*60_000);
  expect(tick).toHaveBeenCalledTimes(2);
  expect(logger.error).not.toHaveBeenCalled();
 });

 it('reports a parked entry or a failed tick without job or provider detail',async()=>{
  const results:GhlTagDrainResult[]=[{status:'completed',code:'',httpStatus:200,counts:{parked:2}},{status:'failed',code:'ghl_tag_unavailable',httpStatus:503,counts:{}}];
  const tick=vi.fn(async()=>results.shift()!),record=vi.fn(async()=>undefined),logger={error:vi.fn(),info:vi.fn()};
  stops.push(startGhlTagWorker({env:ENV,tick,record,logger,now:()=>Date.now()}));
  await vi.advanceTimersByTimeAsync(GHL_TAG_DRAIN_INTERVAL_MS);
  expect(logger.error.mock.calls.map(([line])=>line)).toEqual(['HighLevel tag outbox entries were parked; a manager can retry them from the Hub Command center.','HighLevel tag drain tick did not complete; inspect ghlTagOutbox in the Hub.']);
  expect(JSON.parse(String(record.mock.calls[0]![1]))).toEqual({event:'ghl_tag_drain',status:'completed',code:'',httpStatus:200,parked:2,observedAt:'2026-09-22T18:00:00.000Z'});
 });
});
