import { getHubSession, hasBusinessAccess, listHubAccessProfiles } from '../_lib/hub-session.js';
import { firebaseAdminConfigured, firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { firebaseReadStatus } from '../_lib/firebase-read-status.js';
import { customerPortalConfigured } from '../_lib/customer-portal.js';
import { employeeAccountsConfigured } from '../_lib/employee-accounts.js';
import { gustoConfiguration } from '../_lib/gusto-client.js';
import { moneyApiEnabled } from '../_lib/money-service.js';
import { moneyTotalsMode } from '../_lib/money-core.js';
import { lifecycleApiEnabled } from '../_lib/customer-lifecycle.js';
import { serverMessagingEnabled } from '../_lib/messaging-settings.js';
import { serverScheduleSyncActive } from '../_lib/schedule-sync-queue.js';
import { firebaseRevocations, firebaseRevocationStatus, reconcilesStaffRoster } from '../_lib/firebase-revocation.js';
import { staffPageGateState } from '../_lib/staff-page-gate.js';

/** Returns configuration readiness and a bounded Firebase read check. Secret
 * values and Firestore documents never leave the server. Business users also
 * get the Firebase session revocation state (a slow read
 * answers 'unavailable' after 3 s); reading it retries pending revocations
 * and, on the production host only, reconciles removed or changed staff after
 * the response (context.waitUntil), including employee accounts whose stored
 * manager role gives them business access. With EGC_SCHEDULE_SYNC_WORKER on, it also
 * reads the schedule-sync worker's last check-in (3 s cap). */
export function integrationStatusHandlers({session=getHubSession,revocations=firebaseRevocations,scheduleSync=serverScheduleSyncActive,firebaseRead=firebaseReadStatus,now=()=>new Date()}={}){
  return {async get(context){
  const {request,env}=context;
  const viewer=await session(request,env);
  if(!viewer)return new Response(JSON.stringify({ok:false,code:'HUB_AUTH_REQUIRED',error:'Sign in to the EGC Hub'}),{status:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  const business=hasBusinessAccess(viewer);
  // Start before other readiness checks so the read's 3-second deadline also
  // bounds the service-account token exchange without adding serial latency.
  const firebaseReadPromise=business&&firebaseAdminConfigured(env)?Promise.resolve().then(()=>firebaseRead(env)).catch(()=>({state:'unavailable'})):null;
  const all=(...keys)=>keys.every(k=>Boolean(env[k]));
  const any=(...keys)=>keys.some(k=>Boolean(env[k]));
  const normalized=(...keys)=>{const wanted=keys.map(key=>key.toLowerCase().replace(/[^a-z0-9]/g,''));return Object.entries(env||{}).some(([key,value])=>Boolean(value)&&wanted.includes(key.toLowerCase().replace(/[^a-z0-9]/g,'')))};
  const defer=typeof context.waitUntil==='function'?work=>context.waitUntil(work):null;
  const profiles=business&&reconcilesStaffRoster(request.url)?()=>listHubAccessProfiles(env):null;
  const checks=Promise.all([
    scheduleSync(env,{now:now()}),
    business?firebaseRevocationStatus(revocations(env),profiles,now().toISOString(),{defer}):null,
    firebaseReadPromise
  ]);
  const [scheduleSyncState,revocationState,firebaseReadState]=await checks;
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
    gusto:gustoConfiguration(env).configured,
    highlevelPipeline:any('HIGHLEVEL_SCHEDULED_STAGE_ID','GHL_SCHEDULED_STAGE_ID','HIGHLEVEL_PIPELINE_STAGE_SCHEDULED_ID','GHL_PIPELINE_STAGE_SCHEDULED_ID'),
    automations:all('WEBSITE_LEAD_HOOK_URL','QUOTE_FOLLOWUP_WEBHOOK_URL','BOOKING_WEBHOOK_URL','REVIEW_WEBHOOK_URL','META_SIGNAL_WEBHOOK_URL'),
    // True once the signed messaging cron owns reminders and portal-invitation
    // retries; the Hub then stops triggering them from a manager's page load.
    serverMessaging:serverMessagingEnabled(env),
    // True while EGC_SCHEDULE_SYNC_WORKER is on AND the platform schedule-sync worker
    // checked in recently; page loads then stop auto-retrying the operations visits it
    // mirrors. Off, silent or unreadable: false, and page loads retry as before.
    serverScheduleSync:scheduleSyncState
  };
  // OPS-08: once EGC_STAFF_PAGE_GATE is set, whether the edge gates the staff pages; a value that is neither on nor
  // off leaves them public, so business users also see that value to correct it.
  if(typeof env?.EGC_STAFF_PAGE_GATE==='string'&&env.EGC_STAFF_PAGE_GATE.trim()){
    const gate=staffPageGateState(env);
    status.staffPageGate={...gate,...(!gate.recognized&&business?{value:env.EGC_STAFF_PAGE_GATE.trim().slice(0,40)}:{})};
  }
  if(business){
    if(firebaseReadPromise)status.firebaseRead=firebaseReadState;
    Object.assign(status,revocationState);
  }
  // Browser feature flags (booleans only); money writes stay in the browser unless moneyApi is on,
  // and customer credits, decisions and rebooking follow-ups unless lifecycleApi is on. unifiedTotals, present only with
  // MONEY_UNIFIED_TOTALS=true and MONEY_API_ENABLED=true (the finance buttons then cap and record through /api/money, which
  // serves the same unified money), makes the Hub finance board show money-core's unified totals.
  const moneyApi=moneyApiEnabled(env);
  const flags={moneyApi,lifecycleApi:lifecycleApiEnabled(env),...(moneyApi&&moneyTotalsMode(env)==='unified'?{unifiedTotals:true}:{})};
  return new Response(JSON.stringify({ok:true,status,flags}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }};
}

const handlers=integrationStatusHandlers();
export const onRequestGet=handlers.get;
