/** Manager-reviewed coaching, attached to a real walkthrough. No customer sends or AI grading. */
import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { auditWrite } from '../_lib/hub-audit.js';
import { sameOrigin } from './operations.js';
import { denverWorkDate } from '../_lib/timesheet-week.js';
import { addDays } from '../_lib/dispatch-time.js';

export const COACHING_CRITERIA = Object.freeze([
  ['discovery','Customer goal and keep/remove decisions'],
  ['scope','Scope, access and hazards'],
  ['estimate','Estimate explained and expectations confirmed'],
  ['questions','Customer questions addressed'],
  ['handoff','Next step and crew handoff confirmed'],
]);
const COLLECTION='estimatorCoaching', RECEIPTS='estimatorCoachingReceipts';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(v)&&!v.startsWith('_egc_')&&!v.startsWith('secure_');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const key=v=>String(v||'').trim().toLowerCase();
const fail=(message,status=400)=>Object.assign(new Error(message),{status,coaching:true});
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
function allowed(actor){if(!actor?.user)throw fail('Sign in to review coaching.',401);if(!hasBusinessAccess(actor)||!['owner','manager'].includes(actor.role))throw fail('Only the owner and managers can review coaching.',403);}
export function coachingEstimators(job){const started=key(job.walkthroughVisit?.startedBy);return started?[started]:[...new Set((Array.isArray(job.assignedCrew)?job.assignedCrew:[]).map(key).filter(Boolean))];}
function visit(job){return {id:job.id,date:job.date||'',customer:job.customer||'Walkthrough',revision:job.revision,estimators:coachingEstimators(job),outcome:job.walkthroughOutcome?.outcome||'Not recorded'};}
function text(value,max){return typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);}
export function validateCoaching(input){
  if(!plain(input)||!id(input.walkthroughId)||!uuid(input.requestId)||typeof input.jobRevision!=='string'||!input.jobRevision||!(input.expectedRevision===null||typeof input.expectedRevision==='string'&&input.expectedRevision.length>0))throw fail('Reload the walkthrough before saving.');
  if(!text(input.estimator,120)||!input.estimator.trim()||!['recording','observation'].includes(input.source)||!text(input.nextStep,2000)||!input.nextStep.trim())throw fail('Choose the estimator, evidence source and one coaching action.');
  if(!plain(input.ratings)||Object.keys(input.ratings).length!==COACHING_CRITERIA.length)throw fail('Complete every coaching criterion.');
  const ratings={};
  for(const [criterion] of COACHING_CRITERIA){const row=input.ratings[criterion];if(!plain(row)||![null,1,2,3].includes(row.score)||!text(row.evidence,1000)||(row.score!==null&&!row.evidence.trim()))throw fail('Each scored criterion needs evidence; use Not observed when evidence is missing.');ratings[criterion]={score:row.score,evidence:row.evidence.trim()};}
  if(!Object.values(ratings).some(r=>r.score!==null))throw fail('Observe at least one criterion before saving.');
  return {walkthroughId:input.walkthroughId,estimator:key(input.estimator),source:input.source,ratings,nextStep:input.nextStep.trim()};
}
export function estimatorCoachingHandlers({session=getHubSession,storage=dispatchStorage,now=()=>new Date()}={}){
  const error=e=>reply(e.coaching?e.status:e.status===409?409:503,{ok:false,error:e.coaching?e.message:e.status===409?'The walkthrough or review changed. Reload before saving.':'Coaching could not be verified. Retry the same save to check its result.'});
  return {
    async get({request,env}){try{
      const actor=await session(request,env);allowed(actor);const store=storage(env),target=new URL(request.url).searchParams.get('walkthroughId');
      if(target!==null){if(!id(target))throw fail('Choose a valid walkthrough.');const job=await store.read('jobs',target);if(!job||job.type!=='walkthrough')throw fail('Walkthrough not found.',404);const review=await store.read(COLLECTION,target);return reply(200,{ok:true,visit:visit(job),review,criteria:COACHING_CRITERIA});}
      const today=denverWorkDate(now().toISOString()),jobs=await store.datedJobs(addDays(today,-90),today,['type','date','customer','assignedCrew','walkthroughVisit.startedBy','walkthroughOutcome.outcome']);
      return reply(200,{ok:true,visits:jobs.filter(j=>j.type==='walkthrough').map(visit).sort((a,b)=>b.date.localeCompare(a.date))});
    }catch(e){return error(e);}},
    async post({request,env}){try{
      if(!sameOrigin(request))throw fail('Same-origin request required.',403);
      const actor=await session(request,env);allowed(actor);
      if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw fail('JSON required.',415);
      const raw=await request.text();if(raw.length>12000)throw fail('Review is too large.',413);let input;try{input=JSON.parse(raw);}catch{throw fail('Invalid review.');}
      const data=validateCoaching(input),store=storage(env),requestId=input.requestId.toLowerCase();
      const fingerprint=JSON.stringify({actor:key(actor.user),...data,jobRevision:input.jobRevision,expectedRevision:input.expectedRevision});
      const receipt=await store.read(RECEIPTS,requestId);
      if(receipt){if(receipt.fingerprint!==fingerprint)throw fail('This save ID was used for a different review. Reload.',409);return reply(200,{ok:true,replayed:true});}
      const job=await store.read('jobs',data.walkthroughId);if(!job||job.type!=='walkthrough')throw fail('Walkthrough not found.',404);
      if(job.revision!==input.jobRevision)throw fail('The walkthrough changed. Reload before saving.',409);
      if(!coachingEstimators(job).includes(data.estimator))throw fail('The selected estimator is not linked to this walkthrough.',409);
      const current=await store.read(COLLECTION,data.walkthroughId);if((current?.revision??null)!==input.expectedRevision)throw fail('Another review was saved. Reload before changing it.',409);
      const at=now().toISOString(),patch={schemaVersion:1,...data,reviewedBy:key(actor.user),reviewedAt:at,requestId};
      const audit=auditWrite({actor:{id:actor.user,kind:'human',role:actor.role},via:'hub',action:'estimator_coaching.review',entity:{collection:COLLECTION,id:data.walkthroughId},before:current?{estimator:current.estimator,ratings:current.ratings,nextStep:current.nextStep}:{},after:data,requestId,visibility:'business',now:at});
      await store.commit([{collection:'jobs',id:job.id,revision:job.revision,verify:true},{collection:COLLECTION,id:job.id,revision:current?.revision,patch},{collection:RECEIPTS,id:requestId,patch:{fingerprint,at}},{collection:audit.collection,id:audit.id,patch:audit.patch}]);
      return reply(200,{ok:true,replayed:false});
    }catch(e){return error(e);}},
  };
}
const handlers=estimatorCoachingHandlers();
export const onRequestGet=handlers.get;
export const onRequestPost=handlers.post;
