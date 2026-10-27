import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireRecordingOwner, previewRecording, saveRecording } from '../_lib/walkthrough-recording.js';

const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function walkthroughRecordingHandlers({session=getHubSession,storage=dispatchStorage,now=()=>new Date(),appointment}={}) {
  return {async post({request,env}) {
    try {
      const actor=await session(request,env);requireRecordingOwner(actor);
      const origin=request.headers.get('Origin') || request.headers.get('Referer');
      if (request.headers.get('Sec-Fetch-Site')==='cross-site' || origin && new URL(origin).origin!==new URL(request.url).origin) return reply(403,{ok:false,error:'Open this form in the Hub.'});
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json') return reply(415,{ok:false,error:'JSON is required.'});
      if (Number(request.headers.get('Content-Length'))>12000) return reply(413,{ok:false,error:'Request too large.'});
      const raw=await request.text();if(new TextEncoder().encode(raw).length>12000)return reply(413,{ok:false,error:'Request too large.'});
      let body;try{body=JSON.parse(raw);}catch{return reply(400,{ok:false,error:'Invalid JSON.'});}
      if(!body || !['preview','save'].includes(body.action) || Object.keys(body).some(k=>!['action','input','fingerprint','requestId'].includes(k)))return reply(400,{ok:false,error:'Choose preview or save.'});
      const store=storage(env),deps={now,...(appointment?{appointment}:{})};
      if(body.action==='preview') {
        const {snapshot,fingerprint}=await previewRecording(store,actor,body.input,env,deps);
        return reply(200,{ok:true,snapshot,fingerprint,providerWrites:false});
      }
      const {action,...save}=body;
      return reply(200,await saveRecording(store,actor,save,env,deps));
    }catch(error){return reply(error.status||503,{ok:false,code:error.code||'dispatch_recording_unavailable',error:error.code?.startsWith('dispatch_')?error.message:'Recording could not be verified. Keep this request and retry.'});}
  }};
}
export const onRequestPost=walkthroughRecordingHandlers().post;
