import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { prepareHandoff, saveWalkthroughHandoff } from '../_lib/walkthrough-handoff.js';
const reply = (status, body) => Response.json(body, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function failure(error) {
  if (/^(handoff_|dispatch_)/.test(error?.code || '')) return reply(error.status || 503, {ok:false, code:error.code, error:error.message});
  return reply(503, {ok:false,code:'handoff_unavailable',error:'The handoff could not be verified. Keep the saved request and retry; do not create another job.'});
}
export function handoffHandlers({session=getHubSession,storage=dispatchStorage}={}) {
  return {
    async get({request,env}) {
      try { const actor=await session(request,env); requireDispatcher(actor); return reply(200,{...await prepareHandoff(storage(env),actor,Object.fromEntries(new URL(request.url).searchParams)),viewer:{id:actor.user}}); }
      catch(error) { return failure(error); }
    },
    async post({request,env}) {
      try {
        const origin=request.headers.get('Origin')||request.headers.get('Referer');
        if(request.headers.get('Sec-Fetch-Site')==='cross-site'||origin&&new URL(origin).origin!==new URL(request.url).origin)return reply(403,{ok:false,code:'handoff_origin_forbidden',error:'Open the walkthrough in the Employee Hub before saving.'});
        const actor=await session(request,env); requireDispatcher(actor);
        if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{ok:false,error:'The handoff must use JSON.'});
        if(Number(request.headers.get('Content-Length'))>320000)return reply(413,{ok:false,error:'The walkthrough is too large.'});
        const raw=await request.text(); if(new TextEncoder().encode(raw).byteLength>320000)return reply(413,{ok:false,error:'The walkthrough is too large.'});
        let input; try{input=JSON.parse(raw);}catch{return reply(400,{ok:false,error:'The walkthrough request is incomplete.'});}
        return reply(200,await saveWalkthroughHandoff(storage(env),actor,input));
      } catch(error) { return failure(error); }
    }
  };
}
const handlers=handoffHandlers();
export const onRequestGet=handlers.get;
export const onRequestPost=handlers.post;
