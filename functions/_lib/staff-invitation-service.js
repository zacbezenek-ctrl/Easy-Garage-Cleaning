import { OWNER_USERNAME } from './business-users.js';
const failure=(status,message)=>Object.assign(new Error(message),{status,publicMessage:message});
const invalid=()=>failure(410,'This setup link is invalid, expired or already used. If you already chose a password, use normal staff sign-in. Otherwise ask Zac for help.');
export async function staffTokenHash(token){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
// STAFF-ACCESS sign-in resets: a single-use link valid 24 hours that sets a new password on an approved employee
// account. The link is `reset-<base64url username>.<256-bit token>`; only the token's SHA-256 digest is sealed on the
// account (signInReset), and the manager who issued it copies the link to the employee. Nothing is sent from the Hub.
export const STAFF_RESET_HOURS=24;
const RESET_PREFIX='reset-',b64=text=>btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function unb64(value){try{const padded=value.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((value.length+3)%4);return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(padded),c=>c.charCodeAt(0)));}catch{return '';}}
export const staffResetInvite=(username,token)=>RESET_PREFIX+b64(String(username).trim().toLowerCase())+'.'+token;
export function parseStaffResetInvite(invite){
  if(typeof invite!=='string'||invite.length>120||!invite.startsWith(RESET_PREFIX))return null;
  const dot=invite.indexOf('.'),id=invite.slice(RESET_PREFIX.length,dot),token=invite.slice(dot+1),username=unb64(id);
  return dot>RESET_PREFIX.length&&/^[A-Za-z0-9_-]+$/.test(id)&&b64(username)===id&&/^[a-z][a-z0-9._-]{3,31}$/.test(username)&&/^[A-Za-z0-9_-]{43}$/.test(token)?{username,token}:null;
}
/** A new reset for `username` issued by `issuedBy` at `now` (ms): the bearer invite (shown once) and the record sealed on the account. */
export async function createStaffReset(username,issuedBy,now){
  const bytes=crypto.getRandomValues(new Uint8Array(32)),token=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const issuedAt=new Date(now).toISOString(),expiresAt=new Date(now+STAFF_RESET_HOURS*3600000).toISOString();
  return {invite:staffResetInvite(username,token),record:{kind:'staff_reset_v1',id:crypto.randomUUID(),tokenHash:await staffTokenHash(token),issuedAt,expiresAt,issuedBy:String(issuedBy||'').slice(0,80),consumedAt:''}};
}
export function namedStaffRole(account){const i=account?.invitation;return account?.role==='sales'&&i?.kind==='named_staff_v1'&&i.approvedBy===OWNER_USERNAME&&i.email===account.email&&i.username===account.username&&Boolean(i.consumedAt)?'sales':'crew';}
// resets (EGC_STAFF_PASSWORD_RESET on): {read(username)->{account,version}|null, password(p)->{passwordSalt,passwordHash},
// passwordProblem(p)->'' or a message, save(account,version,at)} for sign-in reset links; null leaves reset links invalid.
export function createStaffInvitationService({store,manifests,staticUsernameExists=()=>false,now=()=>Date.now(),resets=null}){
  async function checkReset(invite){
    const parsed=resets&&parseStaffResetInvite(invite);if(!parsed)throw invalid();
    const found=await resets.read(parsed.username),a=found?.account,r=a?.signInReset;
    if(!a||a.status!=='approved'||String(a.username).toLowerCase()!==parsed.username||!r||r.kind!=='staff_reset_v1'||r.consumedAt||!Number.isFinite(Date.parse(r.expiresAt))||Date.parse(r.expiresAt)<=now()||!equal(await staffTokenHash(parsed.token),r.tokenHash))throw invalid();
    return {account:a,version:found.version,record:r};
  }
  async function check(invite){
    if(typeof invite!=='string'||invite.length>120)throw invalid();
    const dot=invite.indexOf('.'),m=manifests.find(m=>m.id===invite.slice(0,dot)),token=invite.slice(dot+1);
    if(dot<1||!m||m.role!=='sales'||m.approvedBy!==OWNER_USERNAME||!Number.isFinite(Date.parse(m.expiresAt))||Date.parse(m.expiresAt)<=now()||!/^[A-Za-z0-9_-]{43}$/.test(token)||!equal(await staffTokenHash(token),m.tokenHash))throw invalid();
    // All storage reads and every account mutation require proof of the private
    // invitation. There is no public provision/create-account action.
    if(await staticUsernameExists(m.username))throw failure(409,'An existing staff account needs review; it was not changed.');
    const record=await store.read(m.username),a=record?.account;
    if(a)throw invalid();
    const all=await store.list();
    if(all.some(a=>String(a.username).toLowerCase()===m.username.toLowerCase()||String(a.email||'').toLowerCase()===m.email))throw failure(409,'An existing employee identity needs review. No duplicate account was created.');
    return m;
  }
  return {
    resets:Boolean(resets),
    resetInvite:invite=>Boolean(parseStaffResetInvite(invite)),
    async inspectReset(invite){const {account,record}=await checkReset(invite);return {kind:'reset',username:account.username,name:account.displayName||account.username,status:'reset',expiresAt:record.expiresAt};},
    // Sets the new password once: the save is compare-and-set on the account version read here, and it marks the
    // reset used, so a replay or a second browser gets the invalid-link answer. Earlier sessions end (sessionVersion).
    async reset(invite,input){
      const target=await checkReset(invite),p=input.password;
      if(typeof p!=='string'||p.length>128||input.confirmPassword!==p)throw failure(400,'Enter the same new password twice (at most 128 characters).');
      const problem=resets.passwordProblem(p);if(problem)throw failure(400,problem+'.');
      const credentials=await resets.password(p),at=new Date(now()).toISOString();
      if(Date.parse(target.record.expiresAt)<=now())throw invalid();
      const account={...target.account,...credentials,sessionVersion:crypto.randomUUID(),passwordChangedAt:at,updatedAt:at,signInReset:{...target.record,consumedAt:at}};
      try{await resets.save(account,target.version,at);}catch(error){if(error?.status===409)throw invalid();throw error;}
      return {ok:true,username:account.username,reset:true,loginUrl:'/staff-login'};
    },
    async inspect(invite){const m=await check(invite);return {username:m.username,email:m.email,name:`${m.firstName} ${m.lastName}`,status:'invited',role:'sales',businessAccess:false,expiresAt:m.expiresAt};},
    async redeem(invite,input){
      const m=await check(invite);
      if(typeof input.email!=='string'||input.email.trim().toLowerCase()!==m.email)throw failure(400,'Use the work email address to which Zac sent this invitation.');
      const p=input.password;
      if(typeof p!=='string'||p.length<12||p.length>128||input.confirmPassword!==p)throw failure(400,'Choose a password of 12–128 characters and enter it twice.');
      const credentials=await store.password(p),at=new Date(now()).toISOString();
      if(Date.parse(m.expiresAt)<=now())throw invalid();
      const account={username:m.username,usernameKey:m.username,firstName:m.firstName,lastName:m.lastName,displayName:`${m.firstName} ${m.lastName}`,email:m.email,phone:'',...credentials,status:'approved',role:'sales',businessAccess:false,payType:'hourly',hourlyRate:0,appliedAt:at,updatedAt:at,reviewedAt:at,reviewedBy:m.approvedBy,sessionVersion:crypto.randomUUID(),invitation:{kind:'named_staff_v1',id:m.id,username:m.username,email:m.email,expiresAt:m.expiresAt,approvedBy:m.approvedBy,createdAt:m.createdAt,consumedAt:at}};
      // An atomic create-only encrypted employee record consumes this fixed
      // invitation and creates its password together. A competing browser or
      // a replay cannot overwrite the account or obtain a second activation.
      try{await store.create(account);}catch(error){if(error.message==='That username is already registered')throw invalid();throw error;}
      return {ok:true,username:m.username,role:'sales',activated:true,loginUrl:'/business-hub?staff=1'};
    },
  };
}
