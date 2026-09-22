import {portalServicePublicKeys} from '../_lib/operations-service-auth.js';
export async function onRequestGet({env}){
  try{return Response.json(await portalServicePublicKeys(env),{headers:{'Cache-Control':'public, max-age=60','X-Content-Type-Options':'nosniff'}});}
  catch{return Response.json({error:'service_signing_not_configured'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
