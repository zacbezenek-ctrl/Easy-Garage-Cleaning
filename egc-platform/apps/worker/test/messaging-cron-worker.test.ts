import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('@egc/database',()=>({schema:{syncCursors:{key:'key'}},getDb:()=>{throw new Error('the database is injected in these tests');}}));
import {SERVICE_ORIGINS,servicePublicKeySet,signServiceRequest,verifyServiceRequest} from '@egc/operations';
import {MESSAGING_CRON_PATH,messagingCronCounts,runMessagingCronTick,startMessagingCronWorker,webLeadRetryCounts,type MessagingCronResult} from '../src/messaging-cron-worker.js';

const SECRET='synthetic-messaging-cron-api-root-secret-0123456789';
const NOW=Date.parse('2026-09-22T18:00:00.000Z');
const ENV={API_BEARER_TOKEN:SECRET,EGC_MESSAGING_CRON_ENABLED:'true'};
const SUMMARY={scanned:40,due:3,attempted:3,sent:2,limitReached:false,budgetExhausted:false,dryRun:false,results:[{kind:'payment_reminder',jobId:'job-synthetic-private',status:'submitted'}],customer:'Synthetic Customer'};
type Call={url:string;init:RequestInit};
function hub(respond:(call:Call)=>Response|Promise<Response>=()=>Response.json({ok:true,runId:'run',summary:SUMMARY})){
 const calls:Call[]=[];
 return {calls,fetcher:async(url:string,init:RequestInit)=>{const call={url,init};calls.push(call);return respond(call);}};
}
const envelopeOf=(call:Call)=>(JSON.parse(String(call.init.body)) as {envelope:string}).envelope;
const stops:Array<()=>void>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);});
afterEach(()=>{for(const stop of stops.splice(0))stop();vi.useRealTimers();});

describe('messaging cron worker',()=>{
 it('signs a v2 request the Hub verifier accepts for exactly the messaging cron path and worker identity',async()=>{
  const {calls,fetcher}=hub(),ids=['0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b','1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'];
  const first=await runMessagingCronTick({env:ENV,fetcher,now:()=>NOW,requestId:()=>ids.shift()!});
  expect(first).toEqual({status:'completed',code:'',httpStatus:200,counts:{scanned:40,due:3,attempted:3,sent:2,limitReached:false,budgetExhausted:false,dryRun:false,quietHours:false,paused:false}});
  const [call]=calls;
  expect(call!.url).toBe(`${SERVICE_ORIGINS.hub}/api/messaging-cron`);
  expect(call!.init).toMatchObject({method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json'}});
  expect(Object.keys(JSON.parse(String(call!.init.body)))).toEqual(['envelope']);
  const keys=await servicePublicKeySet({service:'api',rootSecret:SECRET,workspace:'egc'}),nonces=new Set<string>();
  const verify=(token:string)=>verifyServiceRequest(token,{service:'hub',workspace:'egc',path:MESSAGING_CRON_PATH,now:NOW,resolveKey:async()=>keys.keys[0]!,consumeNonce:async(_issuer,nonce)=>!nonces.has(nonce)&&!!nonces.add(nonce)});
  const claims=await verify(envelopeOf(call!));
  expect(claims.actor).toEqual({id:'messaging-cron-worker',kind:'integration',role:'integration',workspace:'egc'});
  expect(claims.request).toEqual({requestId:'0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b',body:{command:'messaging.run'}});
  expect([claims.iss,claims.aud,claims.path,claims.iat]).toEqual([SERVICE_ORIGINS.api,SERVICE_ORIGINS.hub,'/api/messaging-cron',NOW/1000]);
  await expect(verifyServiceRequest(envelopeOf(call!),{service:'hub',workspace:'egc',path:'/api/operations-portal',now:NOW,resolveKey:async()=>keys.keys[0]!,consumeNonce:async()=>true})).rejects.toThrow('invalid_service_claims');
  await runMessagingCronTick({env:{...ENV,EGC_MESSAGING_CRON_DRY_RUN:'true'},fetcher,now:()=>NOW,requestId:()=>ids.shift()!});
  const second=await verify(envelopeOf(calls[1]!));
  expect(second.request).toEqual({requestId:'1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',body:{command:'messaging.run',dryRun:true}});
  expect(second.nonce).not.toBe(claims.nonce);
 });

 it('classifies Hub outcomes without echoing Hub error text',async()=>{
  const cases:Array<[()=>Response|never,Partial<MessagingCronResult>]>=[
   [()=>Response.json({ok:false,code:'messaging_cron_disabled',error:'Server messaging is turned off.'},{status:409}),{status:'disabled',code:'messaging_cron_disabled',httpStatus:409}],
   [()=>Response.json({ok:false,code:'messaging_cron_unauthorized',error:'x'},{status:401}),{status:'rejected',code:'messaging_cron_unauthorized',httpStatus:401}],
   [()=>Response.json({ok:false,code:'messaging_settings_invalid',error:'Synthetic private detail'},{status:503}),{status:'failed',code:'messaging_settings_invalid',httpStatus:503}],
   [()=>new Response('<html>Bad gateway</html>',{status:502}),{status:'failed',code:'http_502',httpStatus:502}],
   [()=>Response.json({ok:false,code:'Not A Code; token=synthetic'},{status:400}),{status:'rejected',code:'http_400',httpStatus:400}],
   [()=>{throw new Error('socket hang up token=synthetic');},{status:'unknown',code:'hub_unreachable',httpStatus:null}],
  ];
  for(const [respond,expected] of cases){const {fetcher}=hub(respond);const result=await runMessagingCronTick({env:ENV,fetcher,now:()=>NOW});expect(result).toMatchObject(expected);expect(JSON.stringify(result)).not.toMatch(/synthetic|private|gateway/i);}
  const unsigned=hub();
  expect(await runMessagingCronTick({env:{EGC_MESSAGING_CRON_ENABLED:'true'},fetcher:unsigned.fetcher,now:()=>NOW})).toEqual({status:'not_configured',code:'service_signing_not_configured',httpStatus:null,counts:{}});
  expect(unsigned.calls).toHaveLength(0);
 });

 it('stays off unless explicitly enabled',async()=>{
  const tick=vi.fn(async()=>({status:'completed',code:'',httpStatus:200,counts:{}} as MessagingCronResult));
  for(const env of [{},{EGC_MESSAGING_CRON_ENABLED:'TRUE'},{EGC_MESSAGING_CRON_ENABLED:'1'}]){stops.push(startMessagingCronWorker({env,tick,record:vi.fn(async()=>undefined),logger:{error:vi.fn()}}));}
  await vi.advanceTimersByTimeAsync(60*60_000);
  expect(tick).not.toHaveBeenCalled();
 });

 it('runs every 15 minutes and never overlaps a tick that is still running',async()=>{
  let finish:()=>void=()=>{};
  const tick=vi.fn(()=>new Promise<MessagingCronResult>(resolve=>{finish=()=>resolve({status:'completed',code:'',httpStatus:200,counts:{sent:1}});}));
  const record=vi.fn(async()=>undefined),logger={error:vi.fn(),info:vi.fn()};
  const stop=startMessagingCronWorker({env:ENV,tick,record,logger,now:()=>Date.now()});stops.push(stop);
  await vi.advanceTimersByTimeAsync(45*60_000);
  expect(tick).toHaveBeenCalledTimes(1);
  finish();await vi.advanceTimersByTimeAsync(0);
  expect(record).toHaveBeenCalledWith('messaging_cron:last_success','2026-09-22T18:45:00.000Z');
  await vi.advanceTimersByTimeAsync(14*60_000);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(tick).toHaveBeenCalledTimes(2);
  finish();stop();
  await vi.advanceTimersByTimeAsync(60*60_000);
  expect(tick).toHaveBeenCalledTimes(2);
  expect(logger.error).not.toHaveBeenCalled();
 });

 it('records and logs aggregate outcomes only and keeps running after a failed tick',async()=>{
  const {fetcher}=hub(()=>Response.json({ok:true,runId:'run',summary:SUMMARY}));
  let failNext=true;
  const tick=vi.fn(async(options:{env:Record<string,string|undefined>;now:()=>number})=>{if(failNext){failNext=false;throw new Error('token=synthetic-secret job-synthetic-private');}return runMessagingCronTick({...options,fetcher});});
  const writes:Array<[string,string]>=[],logger={error:vi.fn(),info:vi.fn()};
  const at=Date.parse('2026-09-22T18:15:00.000Z');
  stops.push(startMessagingCronWorker({env:ENV,tick,record:async(key,value)=>{writes.push([key,value]);},logger,now:()=>at}));
  await vi.advanceTimersByTimeAsync(15*60_000);
  expect(tick).toHaveBeenCalledTimes(2);
  // Signing uses real WebCrypto, which settles outside the fake timer queue.
  await vi.waitFor(()=>expect(writes).toHaveLength(2));
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(writes[1]).toEqual(['messaging_cron:last_success','2026-09-22T18:15:00.000Z']);
  const [key,value]=writes[0]!;
  expect(key).toBe('messaging_cron:last_result');
  expect(JSON.parse(value)).toEqual({event:'messaging_cron',status:'completed',code:'',httpStatus:200,...messagingCronCounts(SUMMARY),observedAt:'2026-09-22T18:15:00.000Z'});
  const everything=JSON.stringify([writes,logger.info.mock.calls,logger.error.mock.calls]);
  for(const secret of [SECRET,'synthetic-secret','job-synthetic-private','Synthetic Customer','envelope'])expect(everything).not.toContain(secret);
 });

 it('reports FUN-13 website-lead retry counts on completed and disabled ticks, never lead data, and alerts on abandoned or unavailable retries',async()=>{
  const leads={at:'2026-09-22T18:00:00.000Z',dryRun:false,due:3,attempted:2,synced:1,failed:0,abandoned:1,held:0,purged:1,skipped:0,notAttempted:1,timeLimited:true,deferred:'time_window',name:'Synthetic Lead',phone:'(970) 555-0101'};
  const counts={webLeadsDue:3,webLeadsAttempted:2,webLeadsSynced:1,webLeadsFailed:0,webLeadsAbandoned:1,webLeadsHeld:0,webLeadsPurged:1,webLeadsNotAttempted:1,webLeadsDeferred:'time_window',webLeadsUnavailable:false};
  expect(webLeadRetryCounts(leads)).toEqual(counts);
  expect(webLeadRetryCounts(undefined)).toEqual({});
  expect(webLeadRetryCounts({error:'web_lead_retry_unavailable'})).toMatchObject({webLeadsDue:null,webLeadsUnavailable:true});
  expect(webLeadRetryCounts({deferred:'Not A Code; phone=970'}).webLeadsDeferred).toBeNull();
  const completed=await runMessagingCronTick({env:ENV,fetcher:hub(()=>Response.json({ok:true,runId:'run',summary:SUMMARY,webLeads:leads})).fetcher,now:()=>NOW});
  expect(completed.counts).toEqual({...messagingCronCounts(SUMMARY),...counts});
  // While server messaging is off the Hub still retries leads; the worker now reports them instead of logging nothing.
  const disabled=await runMessagingCronTick({env:ENV,fetcher:hub(()=>Response.json({ok:false,code:'messaging_cron_disabled',error:'Server messaging is turned off.',webLeads:leads},{status:409})).fetcher,now:()=>NOW});
  expect(disabled).toEqual({status:'disabled',code:'messaging_cron_disabled',httpStatus:409,counts});
  expect(JSON.stringify([completed,disabled])).not.toMatch(/Synthetic Lead|555-0101/);
  const tickOf=(result:MessagingCronResult)=>vi.fn(async()=>result);
  for(const [result,alerts] of [[disabled,1],[{...disabled,counts:{...counts,webLeadsAbandoned:0}},0],[{...completed,counts:{...messagingCronCounts(SUMMARY),...webLeadRetryCounts({error:'web_lead_retry_unavailable'})}},1],[{...completed,counts:messagingCronCounts(SUMMARY)},0]] as Array<[MessagingCronResult,number]>){
   const logger={error:vi.fn(),info:vi.fn()};
   stops.push(startMessagingCronWorker({env:ENV,tick:tickOf(result),record:async()=>{},logger,now:()=>NOW}));
   await vi.waitFor(()=>expect(logger.info).toHaveBeenCalledTimes(1));
   expect(JSON.parse(String(logger.info.mock.calls[0]![0]))).toMatchObject({event:'messaging_cron',status:result.status,...result.counts});
   expect(logger.error).toHaveBeenCalledTimes(alerts);
   if(alerts)expect(logger.error).toHaveBeenCalledWith('Website lead HighLevel retries were abandoned or unavailable; inspect web_lead_receipts in Firestore.');
  }
 });

 it('signs with the shared API root so the Hub resolves the key the API already publishes',async()=>{
  const sign=vi.fn(signServiceRequest),{fetcher}=hub();
  await runMessagingCronTick({env:{...ENV,EGC_OPERATIONS_WORKSPACE:'egc'},fetcher,sign,now:()=>NOW,requestId:()=>'2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'});
  expect(sign).toHaveBeenCalledWith({service:'api',rootSecret:SECRET,workspace:'egc',path:'/api/messaging-cron',actor:{id:'messaging-cron-worker',kind:'integration',role:'integration',workspace:'egc'},request:{requestId:'2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',body:{command:'messaging.run'}},now:NOW});
 });
});
