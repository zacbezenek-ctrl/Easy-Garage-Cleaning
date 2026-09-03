/**
 * Private integration relay for employee-hub workflow events.
 * POST /api/operations-event { event, payload }
 * Webhook destinations stay in Cloudflare environment variables, never HTML.
 */
const HOST=/^(localhost|127\.0\.0\.1)(:\d+)?$|(^|\.)easygaragecleaning\.com$|\.pages\.dev$/;
const ROUTES={
  quote_followup:'QUOTE_FOLLOWUP_WEBHOOK_URL',
  booking:'BOOKING_WEBHOOK_URL',
  review_request:'REVIEW_WEBHOOK_URL',
  meta_signal:'META_SIGNAL_WEBHOOK_URL'
};
function reply(status,body){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}})}
function allowed(request){const raw=request.headers.get('Origin')||request.headers.get('Referer');if(!raw)return true;try{return HOST.test(new URL(raw).host)}catch{return false}}
export async function onRequestOptions(){return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}})}
export async function onRequestGet(){return new Response('Method Not Allowed',{status:405,headers:{Allow:'POST, OPTIONS'}})}
export async function onRequestPost({request,env}){
  if(!allowed(request))return reply(403,{ok:false,error:'Forbidden origin'});
  const raw=await request.text();if(raw.length>64*1024)return reply(413,{ok:false,error:'Payload too large'});
  let body;try{body=JSON.parse(raw)}catch{return reply(400,{ok:false,error:'Invalid JSON'})}
  const event=String(body.event||''),key=ROUTES[event];if(!key)return reply(400,{ok:false,error:'Unknown event'});
  const payload=body.payload&&typeof body.payload==='object'?body.payload:{};
  if(event==='review_request'&&!payload.phone)return reply(400,{ok:false,error:'Review request requires phone'});
  if(event==='meta_signal'&&!['qualified','converted','not_interested','archived'].includes(payload.signal))return reply(400,{ok:false,error:'Invalid conversion signal'});
  const url=env[key];if(!url)return reply(501,{ok:false,error:key+' is not configured'});
  try{const upstream=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event,...payload})});if(!upstream.ok)return reply(502,{ok:false,error:'Integration rejected event',status:upstream.status});return reply(200,{ok:true,event})}catch{return reply(502,{ok:false,error:'Integration unavailable'})}
}
