import { employeeInvitationStore, employeeAccountsConfigured } from '../_lib/employee-accounts.js';
import { employeeVaultReadOnly } from '../_lib/employee-vault-key.js';
import { getHubUserProfile } from '../_lib/hub-session.js';
import { STAFF_INVITATIONS } from '../_lib/staff-invitation-manifest.js';
import { createStaffInvitationService } from '../_lib/staff-invitation-service.js';
const ORIGIN='https://easygaragecleaning.com';
export function staffSetupReply(status,body){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}});}
export async function handleStaffSetup(request,service){
  if(request.method==='GET')return staffSetupReply(200,{ok:true,version:'named-staff-v2',singleUse:true});
  if(request.method!=='POST')return staffSetupReply(405,{error:'Method not allowed'});
  if(new URL(request.url).origin!==ORIGIN||request.headers.get('Origin')!==ORIGIN||request.headers.get('Sec-Fetch-Site')==='cross-site'||request.headers.get('X-EGC-Staff-Setup')!=='1')return staffSetupReply(403,{error:'Open the original EGC setup page and try again.'});
  if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return staffSetupReply(415,{error:'JSON required'});
  try{
    const reader=request.body?.getReader();if(!reader)return staffSetupReply(400,{error:'Request required'});
    const chunks=[];let count=0;
    while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>4096){await reader.cancel();return staffSetupReply(413,{error:'Request too large'});}chunks.push(value);}
    const bytes=new Uint8Array(count);let offset=0;for(const item of chunks){bytes.set(item,offset);offset+=item.length;}
    let input;try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{return staffSetupReply(400,{error:'Invalid JSON'});}
    if(!input||typeof input!=='object'||Array.isArray(input))return staffSetupReply(400,{error:'Invalid request'});
    const keys={inspect:['action','invite'],redeem:['action','invite','email','password','confirmPassword']};
    if(!Object.hasOwn(keys,input.action)||Object.keys(input).some(k=>!keys[input.action].includes(k)))return staffSetupReply(400,{error:'Invalid request fields'});
    return staffSetupReply(200,input.action==='inspect'?await service.inspect(input.invite):await service.redeem(input.invite,input));
  }catch(error){return staffSetupReply(error.status||503,{error:error.publicMessage||'Setup could not be confirmed. If you submitted a password, try normal staff sign-in before asking for another link.'});}
}
export async function onRequest({request,env}){
  if(!employeeAccountsConfigured(env)||employeeVaultReadOnly(env))return staffSetupReply(503,{error:'Secure staff setup is unavailable. Please contact Zac.'});
  return handleStaffSetup(request,createStaffInvitationService({store:employeeInvitationStore(env),manifests:STAFF_INVITATIONS,staticUsernameExists:username=>Boolean(getHubUserProfile(env,username))}));
}
