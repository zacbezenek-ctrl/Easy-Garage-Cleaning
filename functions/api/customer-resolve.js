import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { resolveCustomer, verifiedHighLevelContact } from '../_lib/customer-resolution.js';

const reply=(status,data)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function customerResolveHandler({session=getHubSession,storage=dispatchStorage,verifyContact=verifiedHighLevelContact}={}){
  return async({request,env})=>{
    const source=request.headers.get('Origin')||request.headers.get('Referer');
    try{if(request.headers.get('Sec-Fetch-Site')==='cross-site'||source&&new URL(source).origin!==new URL(request.url).origin)return reply(403,{ok:false,code:'customer_resolve_origin_forbidden',error:'Open the Employee Hub before resolving customers.'});}catch{return reply(403,{ok:false,error:'Invalid request origin.'});}
    try{
      const actor=await session(request,env);requireDispatcher(actor);
      if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{ok:false,error:'Customer details must use JSON.'});
      if(Number(request.headers.get('Content-Length'))>8192)return reply(413,{ok:false,error:'Customer details are too large.'});
      const raw=await request.text();if(new TextEncoder().encode(raw).byteLength>8192)return reply(413,{ok:false,error:'Customer details are too large.'});
      let input;try{input=JSON.parse(raw);}catch{return reply(400,{ok:false,error:'Customer details were incomplete.'});}
      return reply(200,await resolveCustomer(storage(env),actor,input,{verifyContact:id=>verifyContact(env,id)}));
    }catch(problem){if(problem.code?.startsWith('customer_resolve_')||problem.code?.startsWith('dispatch_'))return reply(problem.status||503,{ok:false,code:problem.code,error:problem.message});return reply(503,{ok:false,code:'customer_resolve_unavailable',error:'The customer could not be verified. Keep the original request and retry.'});}
  };
}
export const onRequestPost=customerResolveHandler();
