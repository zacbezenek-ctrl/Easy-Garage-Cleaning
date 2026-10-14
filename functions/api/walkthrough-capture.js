import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { readWalkthroughReview, saveWalkthroughReview } from '../_lib/walkthrough-review.js';
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const failure=error=>reply(error.status||503,{ok:false,code:error.code||'walkthrough_review_unavailable',error:error.code?error.message:'Capture unavailable; keep the saved request and retry.',...(error.details?{details:error.details}:{})});
export function walkthroughCaptureHandlers({session=getHubSession,storage=dispatchStorage,now=()=>new Date()}={}){return{
  async get({request,env}){try{return reply(200,await readWalkthroughReview(storage(env),await session(request,env),new URL(request.url).searchParams.get('jobId'),{env}));}catch(error){return failure(error);}},
  async post({request,env}){try{const origin=request.headers.get('Origin')||request.headers.get('Referer');if(request.headers.get('Sec-Fetch-Site')==='cross-site'||origin&&new URL(origin).origin!==new URL(request.url).origin)return reply(403,{ok:false,error:'Open the capture in the Hub.'});
    if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')return reply(415,{ok:false,error:'Use JSON.'});const raw=await request.text();if(new TextEncoder().encode(raw).length>64000)return reply(413,{ok:false,error:'Capture is too large.'});let input;try{input=JSON.parse(raw);}catch{return reply(400,{ok:false,error:'Invalid capture JSON.'});}return reply(200,await saveWalkthroughReview(storage(env),await session(request,env),input,now().toISOString(),{env}));}catch(error){return failure(error);}}
};}
const handlers=walkthroughCaptureHandlers();export const onRequestGet=handlers.get;export const onRequestPost=handlers.post;
