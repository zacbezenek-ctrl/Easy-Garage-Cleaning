import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { dispatchOpenings } from '../_lib/dispatch-openings.js';

const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function dispatchOpeningsHandlers({session=getHubSession,storage=dispatchStorage,now=()=>new Date()}={}) {
  return {async get({request,env}) {
    try {
      const actor=await session(request,env);requireDispatcher(actor);
      const params=new URL(request.url).searchParams;
      if(new Set(params.keys()).size!==[...params.keys()].length)return reply(400,{ok:false,code:'dispatch_openings_invalid',error:'Each openings filter can only be supplied once.'});
      return reply(200,await dispatchOpenings(storage(env),actor,Object.fromEntries(params),now()));
    } catch(error) {
      if(error?.code?.startsWith('dispatch_'))return reply(error.status||503,{ok:false,code:error.code,error:error.message});
      return reply(503,{ok:false,code:'dispatch_openings_unavailable',error:'Scheduling capacity could not be verified. Retry before choosing a time.'});
    }
  }};
}
export const onRequestGet=dispatchOpeningsHandlers().get;
