import { getHubSession } from '../_lib/hub-session.js';
import { customerVisitRequestStorage, officeVisitRequests, reviewVisitRequest } from '../_lib/customer-visit-requests.js';
import { readVisitJson } from '../_lib/customer-visit-http.js';
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const failed=error=>reply(error.status||503,{ok:false,code:error.code||'CUSTOMER_VISIT_UNAVAILABLE',error:error.code?error.message:'Requests could not be loaded. Try again.'});
export function customerVisitRequestsHandlers({storage=customerVisitRequestStorage,session=getHubSession,now=()=>new Date()}={}){return {
  async get({request,env}){try{const actor=await session(request,env);if(!actor)return reply(401,{ok:false,error:'Sign in to the Hub.'});return reply(200,await officeVisitRequests(storage(env),actor,env));}catch(error){return failed(error);}},
  async post({request,env}){try{const actor=await session(request,env);if(!actor)return reply(401,{ok:false,error:'Sign in to the Hub.'});const data=await readVisitJson(request);return reply(200,await reviewVisitRequest(storage(env),actor,env,data,now().toISOString()));}catch(error){return failed(error);}},
};}
const handlers=customerVisitRequestsHandlers();export const onRequestGet=handlers.get;export const onRequestPost=handlers.post;
