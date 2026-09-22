import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { dispatchSearch } from '../_lib/dispatch-search.js';

const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function dispatchSearchHandlers({session=getHubSession,storage=dispatchStorage}={}) {
  return {async get({request,env}) {
    try{
      const actor=await session(request,env);requireDispatcher(actor);
      const params=new URL(request.url).searchParams;
      if(new Set(params.keys()).size!==[...params.keys()].length)return reply(400,{ok:false,code:'dispatch_search_invalid',error:'Each search filter can only be supplied once.'});
      return reply(200,await dispatchSearch(storage(env),actor,Object.fromEntries(params)));
    }catch(error){
      if(error?.code?.startsWith('dispatch_'))return reply(error.status||503,{ok:false,code:error.code,error:error.message});
      return reply(503,{ok:false,code:'dispatch_search_unavailable',error:'The complete job history could not be verified. Retry the search.'});
    }
  }};
}
export const onRequestGet=dispatchSearchHandlers().get;
