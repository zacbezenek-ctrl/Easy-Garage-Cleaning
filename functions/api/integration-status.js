import { getHubSession } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { customerPortalConfigured } from '../_lib/customer-portal.js';
import { employeeAccountsConfigured } from '../_lib/employee-accounts.js';

/** Returns configuration readiness only. Secret values never leave the server. */
export async function onRequestGet({request,env}){
  if(!await getHubSession(request,env))return new Response(JSON.stringify({ok:false,code:'HUB_AUTH_REQUIRED',error:'Sign in to the EGC Hub'}),{status:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  const all=(...keys)=>keys.every(k=>Boolean(env[k]));
  const any=(...keys)=>keys.some(k=>Boolean(env[k]));
  const normalized=(...keys)=>{const wanted=keys.map(key=>key.toLowerCase().replace(/[^a-z0-9]/g,''));return Object.entries(env||{}).some(([key,value])=>Boolean(value)&&wanted.includes(key.toLowerCase().replace(/[^a-z0-9]/g,'')))};
  const status={
    firebase:firebaseServiceAccountConfigured(env),
    employeeAccounts:employeeAccountsConfigured(env),
    customerPortal:firebaseServiceAccountConfigured(env)&&customerPortalConfigured(env),
    highlevel:any('HIGHLEVEL_API_KEY','GHL_API_KEY')&&any('HIGHLEVEL_LOCATION_ID','GHL_LOCATION_ID'),
    quo:any('QUO_API_KEY','QUO'),
    google:all('GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'),
    openai:any('openaiapi','OpenAIAPI','OPENAI_API_KEY'),
    stripe:normalized('STRIPE_SECRET_KEY','STRIPE_SECRET','STRIPE_KEY'),
    stripeWebhook:normalized('STRIPE_WEBHOOK_SECRET','STRIPE_WEBHOOK','STRIPE_WEBHOOK_KEY','STRIPE_SIGNING_SECRET'),
    quickbooks:any('QUICKBOOKS_CLIENT_ID','QBO_CLIENT_ID')&&any('QUICKBOOKS_CLIENT_SECRET','QBO_CLIENT_SECRET'),
    highlevelPipeline:any('HIGHLEVEL_SCHEDULED_STAGE_ID','GHL_SCHEDULED_STAGE_ID','HIGHLEVEL_PIPELINE_STAGE_SCHEDULED_ID','GHL_PIPELINE_STAGE_SCHEDULED_ID'),
    automations:all('WEBSITE_LEAD_HOOK_URL','QUOTE_FOLLOWUP_WEBHOOK_URL','BOOKING_WEBHOOK_URL','REVIEW_WEBHOOK_URL','META_SIGNAL_WEBHOOK_URL')
  };
  return new Response(JSON.stringify({ok:true,status}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
