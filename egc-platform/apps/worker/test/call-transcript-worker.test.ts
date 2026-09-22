import {afterEach,describe,expect,it,vi} from 'vitest';
import {GhlError} from '@egc/ghl';
import {parseProviderTranscript,recoverCallTranscripts,startCallTranscriptWorker,type ParsedTranscript,type TranscriptCandidate,type TranscriptRecoveryStore,type TranscriptRetryState} from '../src/call-transcript-worker.js';

const now=new Date('2026-09-22T07:00:00Z');
function memory(rows:Partial<TranscriptCandidate>[]=[{}]){
 const data=rows.map((r,i):TranscriptCandidate=>({callId:`call-${i}`,providerMessageId:`provider-${i}`,contactId:`contact-${i}`,existingText:null,retry:null,...r}));
 const saved=new Map<string,ParsedTranscript>(),runs:Record<string,unknown>[]=[];
 const store:TranscriptRecoveryStore={listCandidates:vi.fn(async()=>data),persist:vi.fn(async(id,t)=>{const row=data.find(r=>r.callId===id)!;const changed=row.existingText!==t.text;row.existingText=t.text;saved.set(id,t);return changed;}),saveRetry:vi.fn(async(id,state)=>{data.find(r=>r.callId===id)!.retry=state;}),saveRun:vi.fn(async(r)=>{runs.push(r);})};
 return {data,saved,runs,store};
}
const provider=()=>({downloadCallTranscript:vi.fn(),getCallTranscript:vi.fn()});
afterEach(()=>vi.useRealTimers());
describe('strict provider transcript parsing',()=>{
 it.each(['','null','undefined','No transcript found','No transcription available for this message.','Transcription processing','<html><body>403 Forbidden</body></html>',{error:'Unauthorized',text:'must not become transcript'},{statusCode:404,message:'No transcript'},{message:'No transcript'},'{"error":"private customer token"}','{malformed'])('rejects provider placeholder/error content %s',payload=>{expect(parseProviderTranscript(payload)).toBeNull();});
 it('parses text, nested GHL segment payloads and JSON download content without inferring contact',()=>{
  const a=parseProviderTranscript({data:{transcriptions:[{text:'Tuesday at 2:15 works.',speaker:'customer',start:10},{transcript:'Please send your address.',speaker:'staff',start:13}]}})!;
  expect(a.text).toBe('Tuesday at 2:15 works.\nPlease send your address.');expect(a.segments[0]).toMatchObject({speaker:'customer',start:10});
  expect(parseProviderTranscript(JSON.stringify({transcript:a.text}))?.contentHash).toBe(a.contentHash);
  expect(parseProviderTranscript('Hello?')?.text).toBe('Hello?'); // speech storage is separate from sales/contact classification
 });
});
describe('provider-only delayed transcript recovery',()=>{
 it('retries delayed availability after durable backoff, then stores one idempotent hash',async()=>{
  const m=memory(),p=provider();p.downloadCallTranscript.mockResolvedValueOnce('No transcription found').mockResolvedValue('Customer: Tuesday at 2:15 works.');p.getCallTranscript.mockResolvedValue({message:'not available'});
  expect(await recoverCallTranscripts({provider:p,store:m.store,now})).toMatchObject({attempted:1,unavailable:1,recovered:0});
  expect(m.data[0]?.retry).toMatchObject({status:'pending',attemptCount:1,error:'transcript_not_available',nextAttemptAt:'2026-09-22T07:05:00.000Z'});
  expect(await recoverCallTranscripts({provider:p,store:m.store,now:new Date(now.valueOf()+60000)})).toMatchObject({deferred:1,attempted:0});expect(p.downloadCallTranscript).toHaveBeenCalledTimes(1);
  expect(await recoverCallTranscripts({provider:p,store:m.store,now:new Date(now.valueOf()+5*60000)})).toMatchObject({recovered:1});
  const hash=m.data[0]?.retry?.contentHash;expect(hash).toMatch(/^[a-f0-9]{64}$/);expect(m.data[0]?.retry).toMatchObject({status:'complete',nextAttemptAt:null,error:null,attemptCount:2});
  expect(await recoverCallTranscripts({provider:p,store:m.store,now:new Date(now.valueOf()+10*60000)})).toMatchObject({unchanged:1,attempted:0});expect(m.store.persist).toHaveBeenCalledTimes(1);expect(p.downloadCallTranscript).toHaveBeenCalledTimes(2);
 });
 it('repairs an existing bad placeholder and uses structured fallback when download is unavailable',async()=>{
  const m=memory([{existingText:'No transcript found'}]),p=provider();p.downloadCallTranscript.mockRejectedValue(new GhlError('no recording',404,'private body'));p.getCallTranscript.mockResolvedValue([{transcript:'We can send a video this afternoon.',speaker:'customer'}]);
  const result=await recoverCallTranscripts({provider:p,store:m.store,now});expect(result.recovered).toBe(1);expect(m.saved.get('call-0')?.text).toContain('send a video');expect(m.data[0]?.retry?.error).toBeNull();
 });
 it('never persists permission error bodies and avoids a second endpoint retry on the same denied permission',async()=>{
  const m=memory(),p=provider();p.downloadCallTranscript.mockRejectedValue(new GhlError('SECRET_TOKEN customer text',403,'SECRET_BODY'));
  expect(await recoverCallTranscripts({provider:p,store:m.store,now})).toMatchObject({failed:1,recovered:0});expect(p.getCallTranscript).not.toHaveBeenCalled();expect(m.store.persist).not.toHaveBeenCalled();
  expect(m.data[0]?.retry).toMatchObject({status:'failed',error:'provider_permission_denied',nextAttemptAt:'2026-09-22T13:00:00.000Z'});expect(JSON.stringify(m.runs)+JSON.stringify(m.data[0]?.retry)).not.toMatch(/SECRET/);
 });
 it('uses bounded exponential retry for rate limits and preserves other recovered calls',async()=>{
  const retry:TranscriptRetryState={status:'failed',attemptCount:2,attemptedAt:'2026-09-21T00:00:00Z',nextAttemptAt:'2026-09-21T00:10:00Z',error:'provider_rate_limited'};
  const m=memory([{retry},{}]),p=provider();p.downloadCallTranscript.mockRejectedValueOnce(new GhlError('rate limit',429,'body')).mockResolvedValueOnce('Customer: I accept the quoted work.');
  expect(await recoverCallTranscripts({provider:p,store:m.store,now})).toMatchObject({attempted:2,failed:1,recovered:1});expect(m.data[0]?.retry?.nextAttemptAt).toBe('2026-09-22T07:20:00.000Z');expect(m.saved.size).toBe(1);
 });
 it('canonicalizes a previously stored JSON envelope without hitting the provider',async()=>{
  const m=memory([{existingText:'{"transcript":"Real customer speech."}'}]),p=provider();expect(await recoverCallTranscripts({provider:p,store:m.store,now})).toMatchObject({recovered:1,attempted:0});expect(p.downloadCallTranscript).not.toHaveBeenCalled();expect(m.data[0]?.existingText).toBe('Real customer speech.');
 });
 it('bounds calls, reports truncated coverage and asks storage for recent30d plus active-contact selection',async()=>{
  const m=memory([{},{}]),p=provider();p.downloadCallTranscript.mockResolvedValue('Customer speech.');const result=await recoverCallTranscripts({provider:p,store:m.store,now,limit:1});expect(result).toMatchObject({truncated:true,inspected:1,attempted:1});expect(m.store.listCandidates).toHaveBeenCalledWith(new Date('2026-08-23T07:00:00Z'),2);expect(p.downloadCallTranscript).toHaveBeenCalledTimes(1);
 });
 it('does not write any transcript or change contact state for an unavailable completed call',async()=>{
  const m=memory(),p=provider();p.downloadCallTranscript.mockResolvedValue('No transcript found');p.getCallTranscript.mockResolvedValue({status:'completed'});await recoverCallTranscripts({provider:p,store:m.store,now});expect(m.store.persist).not.toHaveBeenCalled();expect(m.data[0]?.existingText).toBeNull();
 });
 it('prevents overlapping runs, recovers after errors and sanitizes worker log output',async()=>{
  vi.useFakeTimers();let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;});const recover=vi.fn(async()=>{await pending;throw new Error('secret provider body');}),logger={log:vi.fn(),error:vi.fn()};const stop=startCallTranscriptWorker({recover,intervalMs:1000,logger});
  await vi.advanceTimersByTimeAsync(3000);expect(recover).toHaveBeenCalledTimes(1);release();await vi.advanceTimersByTimeAsync(1000);expect(recover).toHaveBeenCalledTimes(2);expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');stop();await vi.advanceTimersByTimeAsync(5000);expect(recover).toHaveBeenCalledTimes(2);
 });
});
