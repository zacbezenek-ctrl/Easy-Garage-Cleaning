import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireQuoteAuthor } from '../_lib/quote-permissions.js';
import { handoffCrewOpenings, handoffSyncView, prepareHandoff, releaseHandoffPrices, saveWalkthroughHandoff } from '../_lib/walkthrough-handoff.js';
import { sendAcceptedQuotePortal } from '../_lib/portal-invitation.js';
import { syncSavedHandoff } from './highlevel.js';
import { expireStaleCheckout } from '../_lib/quote-draft.js';
import { stripeRequest, stripeSecretKey } from '../_lib/customer-payments.js';
import { moneyTotalsMode } from '../_lib/money-core.js';
import { gameplanWalkthroughs, gameplanWalkthroughStorage } from '../_lib/gameplan-walkthroughs.js';
import { crewAutoAssignEnabled } from '../_lib/dispatch-crew-assign.js';
import { quoteBuilderEnabled } from '../_lib/catalog-store.js';
const reply = (status, body) => Response.json(body, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
// A refused save names each owner rule (or overlapping work) that stopped it. Only
// each conflict's code and message leave the server, and no other details are
// passed on. For a quote author who is not a dispatcher, saveWalkthroughHandoff
// has already reduced these rows (and every warning of a saved or replayed
// handoff) to name-free text (authorRuleRows): no employee name or id, no other
// job id and no other job's workload.
// EGC_QUOTE_BUILDER_ENABLED: a builder price refusal also says what the server priced (handoff_builder_price_mismatch:
// the selection's total and menu version) or which prices still wait for the owner (the builder's send gate,
// quote_draft_composite_prices_unapproved or, for a walkthrough-priced job, quote_draft_builder_required: id, name,
// unit price and reason of each), as the quote builder shows them.
function conflictDetails(error) {
  const rows = Array.isArray(error?.details?.conflicts) ? error.details.conflicts : null;
  if (error?.code === 'handoff_builder_price_mismatch' && Number.isSafeInteger(error.details?.totalCents)) return {details:{totalCents:error.details.totalCents, menuVersion:typeof error.details.menuVersion === 'string' ? error.details.menuVersion : null}};
  if (['quote_draft_composite_prices_unapproved', 'quote_draft_builder_required'].includes(error?.code) && Array.isArray(error.details?.unapproved)) return {details:{unapproved:error.details.unapproved.slice(0, 60).map(row => ({id:typeof row?.id === 'string' ? row.id : null, name:String(row?.name || '').slice(0, 160), unitCents:Number.isSafeInteger(row?.unitCents) ? row.unitCents : null, reason:String(row?.reason || '').slice(0, 600)}))}};
  return rows ? {details:{conflicts:rows.filter(row => typeof row?.message === 'string' && row.message.trim()).slice(0, 10).map(row => ({code:typeof row.code === 'string' ? row.code : '', message:row.message.trim().slice(0, 600)}))}} : {};
}
function failure(error) {
  if (/^(handoff_|dispatch_|quote_)/.test(error?.code || '')) return reply(error.status || 503, {ok:false, code:error.code, error:error.message, ...conflictDetails(error)});
  return reply(503, {ok:false,code:'handoff_unavailable',error:'The handoff could not be verified. Keep the saved request and retry; do not create another job.'});
}
const stripeFor=env=>{const secret=stripeSecretKey(env);return secret?(path,options)=>stripeRequest(secret,path,options):null;};
// PORTAL-LINKS (B): after a signed save commits, the server runs the walkthrough's first HighLevel sync itself (highlevel.js
// syncSavedHandoff: the contact, the pinned internal brief, the appointment, the existing tags, then the accepted-quote
// portal invitation under its own rules), for every quote author, after the response (waitUntil). A save that is
// already synced starts nothing. The answer says serverSync:'started' so the walkthrough page can follow it (view=sync).
// After the owner releases held prices the job's portal invitation goes out the same way. Without waitUntil (tests)
// nothing runs in the background and the Hub's page-load retry stays the only sender, as before.
const defaultSync=(env,actor,input)=>syncSavedHandoff(env,actor,input);
const defaultInvite=(env,jobId)=>sendAcceptedQuotePortal(env,jobId,{requireRequested:true,automatic:true});
// compositeState (tests): the builder's pricing state; by default the library reads it (catalog-store.js readCompositeState).
export function handoffHandlers({session=getHubSession,storage=dispatchStorage,walkthroughs=gameplanWalkthroughStorage,now=()=>new Date(),stripe=stripeFor,compositeState=null,serverSync=defaultSync,invite=defaultInvite}={}) {
  const priced = compositeState ? {compositeState} : {};
  return {
    async get({request,env}) {
      try {
        const actor=await session(request,env); requireQuoteAuthor(actor,env);
        const query=Object.fromEntries(new URL(request.url).searchParams);
        // view=crew_openings (EGC_DISPATCH_CREW_AUTO_ASSIGN): rep-safe crew openings for the sold job (handoffCrewOpenings).
        // Off, the view is refused as before (an unknown walkthroughs lookup).
        if(query.view==='crew_openings'&&crewAutoAssignEnabled(env))return reply(200,{...await handoffCrewOpenings(storage(env),actor,query,now(),{env}),viewer:{id:actor.user}});
        // view=sync (PORTAL-LINKS): where the server's first HighLevel sync of a signed job stands (handoffSyncView).
        if(query.view==='sync')return reply(200,{...await handoffSyncView(storage(env),actor,query,{env,now:now()}),viewer:{id:actor.user}});
        // view=walkthroughs: the gameplan's Today list and its requested walkthrough (gameplan-walkthroughs.js), no SDK read.
        if('view' in query)return reply(200,{...await gameplanWalkthroughs(walkthroughs(env),actor,query,{env,now:now()}),viewer:{id:actor.user}});
        return reply(200,{...await prepareHandoff(storage(env),actor,query,{env}),viewer:{id:actor.user}});
      }
      catch(error) { return failure(error); }
    },
    async post({request,env,waitUntil}) {
      try {
        const origin=request.headers.get('Origin')||request.headers.get('Referer');
        if(request.headers.get('Sec-Fetch-Site')==='cross-site'||origin&&new URL(origin).origin!==new URL(request.url).origin)return reply(403,{ok:false,code:'handoff_origin_forbidden',error:'Open the walkthrough in the Employee Hub before saving.'});
        const actor=await session(request,env); requireQuoteAuthor(actor,env);
        if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{ok:false,error:'The handoff must use JSON.'});
        if(Number(request.headers.get('Content-Length'))>320000)return reply(413,{ok:false,error:'The walkthrough is too large.'});
        const raw=await request.text(); if(new TextEncoder().encode(raw).byteLength>320000)return reply(413,{ok:false,error:'The walkthrough is too large.'});
        let input; try{input=JSON.parse(raw);}catch{return reply(400,{ok:false,error:'The walkthrough request is incomplete.'});}
        const store=storage(env),at=now().toISOString();
        // action prices.release (EGC_QUOTE_BUILDER_ENABLED): a job booked with unapproved builder prices passes the builder's send gate.
        // Off, the request is refused as before (not a signed walkthrough).
        if(quoteBuilderEnabled(env)&&input&&typeof input==='object'&&!Array.isArray(input)&&input.action==='prices.release'){
          const released=await releaseHandoffPrices(store,actor,input,at,{env,...priced});
          if(released.released&&typeof waitUntil==='function')waitUntil(Promise.resolve().then(()=>invite(env,released.job.id)).catch(()=>null));
          return reply(200,released);
        }
        // A signed revision closes an open portal checkout for the earlier terms.
        const saved=await saveWalkthroughHandoff(store,actor,input,at,{env,...priced,checkouts:job=>expireStaleCheckout({store,job,stripe:stripe(env),now:at,mode:moneyTotalsMode(env)})});
        if(typeof waitUntil==='function'&&saved?.ok&&saved.job?.id&&saved.job.syncStatus!=='synced'){
          waitUntil(Promise.resolve().then(()=>serverSync(env,actor,{jobId:saved.job.id,handoffRequestId:saved.requestId,waitUntil})).catch(()=>null));
          return reply(200,{...saved,serverSync:'started'});
        }
        return reply(200,saved);
      } catch(error) { return failure(error); }
    }
  };
}
const handlers=handoffHandlers();
export const onRequestGet=handlers.get;
export const onRequestPost=handlers.post;
