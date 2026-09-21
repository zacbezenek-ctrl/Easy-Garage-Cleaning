/** Server-to-server only. Neither the HMAC key nor signed envelopes go to browsers. */
const encoder = new TextEncoder();
function base64(bytes) {let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decode(s) {const p=s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4);return Uint8Array.from(atob(p),c=>c.charCodeAt(0));}
export async function signOperationsEnvelope(claims,key) {
  if(typeof key!=='string'||key.length<32)throw new Error('Operations signing is not configured');
  const payload=base64(encoder.encode(JSON.stringify(claims)));
  const k=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return payload+'.'+base64(new Uint8Array(await crypto.subtle.sign('HMAC',k,encoder.encode(payload))));
}
export async function verifyOperationsEnvelope(token,key,audience,now=Date.now()) {
  if(typeof key!=='string'||key.length<32||typeof token!=='string'||token.length>200000)throw new Error('Unauthorized');
  const parts=token.split('.');
  if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw new Error('Unauthorized');
  const k=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',k,decode(parts[1]),encoder.encode(parts[0])))throw new Error('Unauthorized');
  const c=JSON.parse(new TextDecoder().decode(decode(parts[0])));
  if(c.v!==1||c.iss!=='portal'||c.aud!==audience||!Number.isInteger(c.iat)||Math.abs(now-c.iat*1000)>60000||
     !c.actor||typeof c.actor.id!=='string'||!c.actor.id||!['owner','manager','sales','integration'].includes(c.actor.role)||
     !['human','integration'].includes(c.actor.kind)||typeof c.actor.workspace!=='string'||!c.request||typeof c.request.body!=='object')throw new Error('Unauthorized');
  return c;
}
