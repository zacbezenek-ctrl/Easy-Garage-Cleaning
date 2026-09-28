import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { dispatchTravelRoutes, travelEstimator } from '../_lib/dispatch-travel.js';

const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function dispatchTravelHandlers({session=getHubSession,storage=dispatchStorage,now=()=>new Date(),travel=travelEstimator}={}) {
  return {async get({request,env}) {
    try {
      const actor=await session(request,env);requireDispatcher(actor);
      const params=new URL(request.url).searchParams;
      if(new Set(params.keys()).size!==[...params.keys()].length)return reply(400,{ok:false,code:'dispatch_travel_invalid',error:'Each drive-time filter can only be supplied once.'});
      const store=storage(env);
      return reply(200,await dispatchTravelRoutes(store,actor,Object.fromEntries(params),now(),{travel:travel({env,store,now})}));
    } catch(error) {
      if(error?.code?.startsWith('dispatch_'))return reply(error.status||503,{ok:false,code:error.code,error:error.message});
      return reply(503,{ok:false,code:'dispatch_travel_unavailable',error:'Drive times could not be verified. Retry before relying on this route.'});
    }
  }};
}
export const onRequestGet=dispatchTravelHandlers().get;
