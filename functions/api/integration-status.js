/** Returns configuration readiness only. Secret values never leave the server. */
export async function onRequestGet({env}){
  const all=(...keys)=>keys.every(k=>Boolean(env[k]));
  const any=(...keys)=>keys.some(k=>Boolean(env[k]));
  const status={
    firebase:any('FIREBASE_API_KEY','FIREBASE_SERVICE_ACCOUNT_JSON'),
    highlevel:any('HIGHLEVEL_API_KEY','GHL_API_KEY')&&any('HIGHLEVEL_LOCATION_ID','GHL_LOCATION_ID'),
    quo:any('QUO_API_KEY','QUO'),
    google:all('GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'),
    openai:any('openaiapi','OPENAI_API_KEY'),
    stripe:all('STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'),
    automations:all('WEBSITE_LEAD_HOOK_URL','QUOTE_FOLLOWUP_WEBHOOK_URL','BOOKING_WEBHOOK_URL','REVIEW_WEBHOOK_URL','META_SIGNAL_WEBHOOK_URL')
  };
  return new Response(JSON.stringify({ok:true,status}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
