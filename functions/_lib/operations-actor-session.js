import {hasBusinessAccess} from './hub-session.js';

/* A verified bridge actor reaches dispatch/timecard modules only as a session-shaped
 * object built from the CURRENT Hub profile. A human is the signed Hub user; an
 * integration needs a delegate the owner configured in EGC_OPERATIONS_HUB_DELEGATES_JSON
 * and is read-only. Crew roles never get a session. No pay or credential fields. */
const fail=(code,status=403)=>Object.assign(new Error(code),{code,status});
export const BRIDGE_ROLES=Object.freeze(['owner','manager','sales']);
const ACTOR_ID=/^[A-Za-z0-9_:@.\-]{1,200}$/,USERNAME=/^[a-z0-9][a-z0-9._-]{0,79}$/;
const username=value=>typeof value==='string'?value.trim().toLowerCase():'';

export function operationsDelegates(env={}){
  const raw=env.EGC_OPERATIONS_HUB_DELEGATES_JSON;
  if(raw===undefined||raw===null||String(raw).trim()==='')return new Map();
  let parsed;try{parsed=JSON.parse(raw);}catch{throw fail('hub_delegate_config_invalid',503);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw fail('hub_delegate_config_invalid',503);
  const delegates=new Map();
  for(const [actorId,user] of Object.entries(parsed)){
    if(!ACTOR_ID.test(actorId)||!USERNAME.test(username(user)))throw fail('hub_delegate_config_invalid',503);
    delegates.set(actorId,username(user));
  }
  return delegates;
}

export function operationsActorSession(actor,{profiles=[],delegates=new Map(),delegate,write=false}={}){
  if(!actor||typeof actor!=='object'||!ACTOR_ID.test(String(actor.id||''))||!['human','integration'].includes(actor.kind)||(actor.kind==='integration')!==(actor.role==='integration'))throw fail('hub_actor_invalid');
  let user;
  if(actor.kind==='human'){
    if(!BRIDGE_ROLES.includes(actor.role))throw fail('hub_actor_role_forbidden');
    if(delegate!==undefined)throw fail('hub_delegate_not_allowed');
    user=username(actor.id);
  }else{
    if(write)throw fail('hub_integration_write_forbidden');
    if(typeof delegate!=='string'||!delegate)throw fail('hub_delegate_required');
    const mapped=delegates.get(actor.id);
    if(!mapped||mapped!==username(delegate))throw fail('hub_delegate_unverified');
    user=mapped;
  }
  const matches=profiles.filter(profile=>username(profile?.user)===user);
  if(matches.length!==1)throw fail(actor.kind==='human'?'hub_actor_unknown':'hub_delegate_unverified');
  const [profile]=matches;
  if(!BRIDGE_ROLES.includes(profile.role)||!hasBusinessAccess(profile))throw fail('hub_actor_role_forbidden');
  // The signed role is at most a minute old; a changed Hub role must sign in again.
  if(actor.kind==='human'&&profile.role!==actor.role)throw fail('hub_actor_changed');
  return Object.freeze({user:profile.user,displayName:String(profile.displayName||profile.user),role:profile.role,businessAccess:true,source:'operations_bridge',
    actorId:actor.id,actorKind:actor.kind,delegatedBy:actor.kind==='integration'?actor.id:null,readOnly:actor.kind==='integration'});
}
