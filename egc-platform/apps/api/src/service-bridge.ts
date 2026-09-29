import {getDb,schema} from '@egc/database';
import {lt} from 'drizzle-orm';
import {OperationsError,ServiceAuthenticationError,actorSchema,authorizeDelegate,bridgeActorIssuer,requestSchema,verifyMcpGrant,verifyRequest,verifyServiceRequest,signServiceRequest,servicePublicKeySet,SERVICE_ORIGINS,type Actor,type BridgeIssuer,type Command,type Delegate,type ServiceKeyResolver} from '@egc/operations';
import type {FastifyBaseLogger,FastifyInstance} from 'fastify';

export const serviceAuthEnabled=(env:NodeJS.ProcessEnv)=>{const mode=env.EGC_OPERATIONS_SERVICE_AUTH;if(mode&&mode!=='v2'&&mode!=='legacy')throw new OperationsError('service_auth_mode_invalid',503);return mode==='v2';};
const workspace=(env:NodeJS.ProcessEnv)=>env.EGC_OPERATIONS_WORKSPACE??'egc';
export function serviceRootSecret(env:NodeJS.ProcessEnv){const secret=env.API_BEARER_TOKEN;if(!secret||secret.length<32)throw new OperationsError('service_auth_not_configured',503);return secret;}
let lastNonceCleanup=0;
export async function consumeServiceNonce(issuer:string,nonce:string,expiresAt:number){
 const db=getDb();
 const rows=await db.insert(schema.operationsServiceNonces).values({issuer,nonce,expiresAt:new Date(expiresAt*1000)}).onConflictDoNothing().returning({id:schema.operationsServiceNonces.id});
 if(Date.now()-lastNonceCleanup>60_000){lastNonceCleanup=Date.now();void db.delete(schema.operationsServiceNonces).where(lt(schema.operationsServiceNonces.expiresAt,new Date(Date.now()-60_000))).catch(()=>{});}
 return rows.length===1;
}
export function tokenVersion(token:unknown){if(typeof token!=='string'||token.length>220000)return null;try{return (JSON.parse(Buffer.from(token.split('.')[0]??'','base64url').toString()) as {v?:unknown}).v;}catch{return null;}}
export async function verifyHubServiceClaims(token:unknown,path:string,env:NodeJS.ProcessEnv){
 if(!serviceAuthEnabled(env)||tokenVersion(token)!==2)throw new OperationsError('invalid_service_auth_protocol',401);
 const claims=await verifyServiceRequest(token,{service:'api',workspace:workspace(env),path,consumeNonce:consumeServiceNonce}).catch(error=>{throw error instanceof ServiceAuthenticationError?new OperationsError(error.code,error.status):new OperationsError('service_auth_unavailable',503);});
 const actor=actorSchema.safeParse(claims.actor);
 if(!actor.success)throw new OperationsError('hub_principal_invalid',403);
 const command=(claims.request.body as {command?:unknown})?.command;
 const human=actor.data.kind==='human'&&['owner','manager','sales'].includes(actor.data.role);
 const scopedIntegration=path==='/operations/rpc'&&actor.data.kind==='integration'&&actor.data.role==='integration'&&((command==='schedule.sync_provider'&&/^hub-schedule:.+/.test(actor.data.id))||(command==='provider.note.ensure'&&/^hub-note:.+/.test(actor.data.id)));
 if(!human&&!scopedIntegration)throw new OperationsError('hub_principal_forbidden',403);
 return {...claims,actor:actor.data};
}
export async function verifyOperationsClaims(token:unknown,env:NodeJS.ProcessEnv){
 if(serviceAuthEnabled(env)&&tokenVersion(token)===2){const claims=await verifyHubServiceClaims(token,'/operations/rpc',env),request=requestSchema.safeParse(claims.request);if(!request.success)throw new OperationsError('invalid_operations_request',400);return{...claims,request:request.data};}
 // The MCP is a separate existing trusted issuer. A failed Hub v2 signature
 // never falls back to this path or to the legacy shared Portal key.
 return verifyRequest(token,{...(serviceAuthEnabled(env)?{}:env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET?{portal:env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET}:{}),...(env.EGC_OPERATIONS_MCP_SIGNING_SECRET?{mcp:env.EGC_OPERATIONS_MCP_SIGNING_SECRET}:{})});
}
/** BRIDGE-ADOPT-AUTHZ: the service whose key signed verified operations claims. The MCP key
 * is the MCP's; the Hub v2 key and the legacy portal key are the Hub's (the API never signs
 * its own RPC). authorize() binds every integration actor to this issuer. */
export function claimsIssuer(claims:{iss:string}):BridgeIssuer{
 if(claims.iss==='mcp')return 'mcp';
 if(claims.iss==='portal'||claims.iss===SERVICE_ORIGINS.hub)return 'hub';
 throw new OperationsError('invalid_operations_signature',401);
}
export type AuditRow=typeof schema.auditLogs.$inferInsert;
export const auditLogWriter=async(row:AuditRow)=>getDb().insert(schema.auditLogs).values(row);
export type IssuerRefusal={issuer:BridgeIssuer;actor:Actor;command:string;requestId:string;entity:'operations_request'|'recording_request';source:'operations'|'recordings'};
/** BRIDGE-ADOPT-AUTHZ: a signed request refused because its signer may not present its integration
 * actor (bridge_integration_issuer_*) is logged and kept in audit_logs, best effort: a lost audit
 * write never changes the refusal. Any other error is left alone. */
export async function recordIssuerRefusal(log:FastifyBaseLogger,audit:(row:AuditRow)=>Promise<unknown>,error:unknown,refused:IssuerRefusal){
 if(!(error instanceof OperationsError)||!/^bridge_integration_issuer_[a-z_]+$/.test(error.code))return;
 const actor=/^[A-Za-z0-9_:@.\-]{1,200}$/.test(refused.actor.id)?refused.actor.id:'invalid',{issuer,command}=refused;
 log.warn({code:error.code,issuer,actor,command},'Refused a signed request for an actor its signer does not present');
 await Promise.resolve().then(()=>audit({actor,action:'operations.issuer_refused',entity:refused.entity,entityId:refused.requestId,newValue:{code:error.code,issuer,boundTo:bridgeActorIssuer(refused.actor.id),command},source:refused.source})).catch(()=>{});
}
/** A delegated MCP grant must carry the Hub's signature over exactly this user and role; only owner or manager delegates write. */
export async function verifyDelegatedClaims(claims:{actor:Actor;request:{body:Command};delegate?:Delegate|undefined},options:{resolveKey?:ServiceKeyResolver;now?:number}={}){
 const delegate=claims.delegate;if(!delegate)return;
 authorizeDelegate(claims.actor,claims.request.body,delegate);
 // The grant is proof of what the Hub signed at approval time, so its 60-second lifetime is not re-applied here.
 const grant=await verifyMcpGrant(delegate.assertion,{allowExpired:true,...options}).catch(error=>{throw error instanceof ServiceAuthenticationError&&error.status>=500?new OperationsError(error.code,503):new OperationsError('delegate_invalid',403);});
 if(grant.hubUser!==delegate.user||grant.role!==delegate.role||grant.businessAccess!==true)throw new OperationsError('delegate_invalid',403);
}
export async function signApiServiceRequest(actor:Actor,body:Record<string,unknown>,path:string,requestId:string,env:NodeJS.ProcessEnv){
 return signServiceRequest({service:'api',rootSecret:serviceRootSecret(env),workspace:workspace(env),path,actor,request:{requestId,body}});
}
export async function registerServiceKeyRoute(app:FastifyInstance,env:NodeJS.ProcessEnv=process.env){
 app.get('/operations/service-keys',async(_request,reply)=>{
  reply.header('Cache-Control','public, max-age=60');
  if(env.EGC_OPERATIONS_ENABLED!=='true'||!serviceAuthEnabled(env))return reply.code(503).send({error:'service_auth_not_enabled'});
  try{return await servicePublicKeySet({service:'api',rootSecret:serviceRootSecret(env),workspace:workspace(env)});}catch{return reply.code(503).send({error:'service_auth_unavailable'});}
 });
}
