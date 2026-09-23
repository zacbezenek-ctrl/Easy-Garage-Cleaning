const failure=(status,message)=>Object.assign(new Error(message),{status,publicMessage:message});
const invalid=()=>failure(410,'This setup link is invalid, expired or already used. If you already chose a password, use normal staff sign-in. Otherwise ask Zac for help.');
export async function staffTokenHash(token){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
export function namedStaffRole(account){const i=account?.invitation;return account?.role==='sales'&&i?.kind==='named_staff_v1'&&i.approvedBy==='zacb'&&i.email===account.email&&i.username===account.username&&Boolean(i.consumedAt)?'sales':'crew';}
export function createStaffInvitationService({store,manifests,staticUsernameExists=()=>false,now=()=>Date.now()}){
  async function check(invite){
    if(typeof invite!=='string'||invite.length>120)throw invalid();
    const dot=invite.indexOf('.'),m=manifests.find(m=>m.id===invite.slice(0,dot)),token=invite.slice(dot+1);
    if(dot<1||!m||m.role!=='sales'||m.approvedBy!=='zacb'||!Number.isFinite(Date.parse(m.expiresAt))||Date.parse(m.expiresAt)<=now()||!/^[A-Za-z0-9_-]{43}$/.test(token)||!equal(await staffTokenHash(token),m.tokenHash))throw invalid();
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
