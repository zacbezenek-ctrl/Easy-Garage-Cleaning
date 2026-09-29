import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireQuoteAuthor } from '../_lib/quote-permissions.js';
import { prepareHandoff, saveWalkthroughHandoff } from '../_lib/walkthrough-handoff.js';
import { expireStaleCheckout } from '../_lib/quote-draft.js';
import { stripeRequest, stripeSecretKey } from '../_lib/customer-payments.js';
const reply = (status, body) => Response.json(body, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
// A refused save names each owner rule (or overlapping work) that stopped it. Only
// each conflict's code and message leave the server, and no other details are
// passed on. For a quote author who is not a dispatcher, saveWalkthroughHandoff
// has already reduced these rows (and every warning of a saved or replayed
// handoff) to name-free text (authorRuleRows): no employee name or id, no other
// job id and no other job's workload.
function conflictDetails(error) {
  const rows = Array.isArray(error?.details?.conflicts) ? error.details.conflicts : null;
  return rows ? {details:{conflicts:rows.filter(row => typeof row?.message === 'string' && row.message.trim()).slice(0, 10).map(row => ({code:typeof row.code === 'string' ? row.code : '', message:row.message.trim().slice(0, 600)}))}} : {};
}
function failure(error) {
  if (/^(handoff_|dispatch_|quote_)/.test(error?.code || '')) return reply(error.status || 503, {ok:false, code:error.code, error:error.message, ...conflictDetails(error)});
  return reply(503, {ok:false,code:'handoff_unavailable',error:'The handoff could not be verified. Keep the saved request and retry; do not create another job.'});
}
const stripeFor=env=>{const secret=stripeSecretKey(env);return secret?(path,options)=>stripeRequest(secret,path,options):null;};
export function handoffHandlers({session=getHubSession,storage=dispatchStorage,now=()=>new Date(),stripe=stripeFor}={}) {
  return {
    async get({request,env}) {
      try { const actor=await session(request,env); requireQuoteAuthor(actor,env); return reply(200,{...await prepareHandoff(storage(env),actor,Object.fromEntries(new URL(request.url).searchParams),{env}),viewer:{id:actor.user}}); }
      catch(error) { return failure(error); }
    },
    async post({request,env}) {
      try {
        const origin=request.headers.get('Origin')||request.headers.get('Referer');
        if(request.headers.get('Sec-Fetch-Site')==='cross-site'||origin&&new URL(origin).origin!==new URL(request.url).origin)return reply(403,{ok:false,code:'handoff_origin_forbidden',error:'Open the walkthrough in the Employee Hub before saving.'});
        const actor=await session(request,env); requireQuoteAuthor(actor,env);
        if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{ok:false,error:'The handoff must use JSON.'});
        if(Number(request.headers.get('Content-Length'))>320000)return reply(413,{ok:false,error:'The walkthrough is too large.'});
        const raw=await request.text(); if(new TextEncoder().encode(raw).byteLength>320000)return reply(413,{ok:false,error:'The walkthrough is too large.'});
        let input; try{input=JSON.parse(raw);}catch{return reply(400,{ok:false,error:'The walkthrough request is incomplete.'});}
        const store=storage(env),at=now().toISOString();
        // A signed revision closes an open portal checkout for the earlier terms.
        return reply(200,await saveWalkthroughHandoff(store,actor,input,at,{env,checkouts:job=>expireStaleCheckout({store,job,stripe:stripe(env),now:at})}));
      } catch(error) { return failure(error); }
    }
  };
}
const handlers=handoffHandlers();
export const onRequestGet=handlers.get;
export const onRequestPost=handlers.post;
