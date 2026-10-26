import { customerLoginEnabled } from '../_lib/customer-magic-link.js';
import { readCustomerAccountContext, readCustomerAccountJob, customerAccountPortalCookie } from '../_lib/customer-account-access.js';
import { readCustomerAccountSession, signOutCustomerAccountSession } from '../_lib/customer-account-session.js';
import { clearCustomerPortalSessionCookie } from '../_lib/customer-portal.js';
import { customerVisitRequestStorage, accountVisitRequests, submitVisitChange } from '../_lib/customer-visit-requests.js';
import { customerVisitCalendar } from '../_lib/customer-visit-calendar.js';
import { validDate, denverToday } from '../_lib/dispatch-time.js';
import { readVisitJson } from '../_lib/customer-visit-http.js';

const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const reply=(status,body,cookies=[])=>{const h=new Headers(headers);h.set('Content-Type','application/json');for(const cookie of cookies)h.append('Set-Cookie',cookie);return new Response(JSON.stringify(body),{status,headers:h});};
const error=problem=>reply(problem.status||503,{ok:false,code:problem.code||'CUSTOMER_ACCOUNT_UNAVAILABLE',error:problem.code?problem.message:'Your account could not be loaded. Please retry.'});
const fail=(message,status=400)=>Object.assign(new Error(message),{code:'CUSTOMER_ACCOUNT_REQUEST_INVALID',status});
const input = request => readVisitJson(request, { portal: true });
export function customerAccountHandlers({storage=customerVisitRequestStorage,now=()=>new Date()}={}){return {
  async get({request,env}){try{
    if(!customerLoginEnabled(env))return reply(404,{ok:false,error:'Not found'});
    const store=storage(env),at=now(),session=await readCustomerAccountSession(store,env,request,at.toISOString()),url=new URL(request.url);
    if(url.searchParams.get('format')==='ics'){const {job}=await readCustomerAccountJob(store,session,url.searchParams.get('jobId'));return new Response(customerVisitCalendar(job,at),{headers:{...headers,'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'attachment; filename="egc-visit.ics"'}});}
    const filter=url.searchParams.get('filter')||'all',from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'',query=(url.searchParams.get('q')||'').trim().toLowerCase();
    if(!['all','upcoming','past','cancelled'].includes(filter)||from&&!validDate(from)||to&&!validDate(to)||from&&to&&from>to||query.length>120)throw fail('Choose valid visit filters.');
    const context=await readCustomerAccountContext(store,session,{now:at}),today=denverToday(at);
    const changes=await accountVisitRequests(store,session,{jobIds:new Set(context.view.jobs.map(job=>job.jobId))});
    const jobs=context.view.jobs.filter(job=>(filter==='all'||filter==='cancelled'&&job.status==='cancelled'||filter==='upcoming'&&job.date>=today&&!['cancelled','completed','closed','paid','invoiced','review_requested'].includes(job.status)||filter==='past'&&(job.date&&job.date<today||['completed','closed','paid','invoiced','review_requested'].includes(job.status)))&&(!from||job.date>=from)&&(!to||job.date<=to)&&(!query||`${job.service} ${job.address}`.toLowerCase().includes(query)));
    return reply(200,{ok:true,...context.view,jobs,requests:changes.requests,requestsComplete:changes.complete,filter,today});
  }catch(problem){return error(problem);}},
  async post({request,env}){try{
    const data=await input(request),store=storage(env),at=now();
    if(data.action==='sign_out'){const result=await signOutCustomerAccountSession(store,env,request,at.toISOString(),{strict:true});return reply(200,{ok:true},[result.cookie,clearCustomerPortalSessionCookie()]);}
    if(!customerLoginEnabled(env))return reply(404,{ok:false,error:'Not found'});
    const session=await readCustomerAccountSession(store,env,request,at.toISOString());
    if(data.action==='open_project'){if(Object.keys(data).some(key=>!['action','jobId'].includes(key)))throw fail('Choose a project from My visits.');const cookie=await customerAccountPortalCookie(store,env,session,data.jobId,at.getTime());return reply(200,{ok:true,url:'/customer-portal'},[cookie]);}
    if(data.action==='request_change')return reply(200,await submitVisitChange(store,session,data,at.toISOString()));
    throw fail('Choose a supported account action.');
  }catch(problem){return error(problem);}},
};}
const handlers=customerAccountHandlers();export const onRequestGet=handlers.get;export const onRequestPost=handlers.post;
