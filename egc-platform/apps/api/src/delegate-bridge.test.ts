import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {MCP_GRANT,SERVICE_ORIGINS,ServiceAuthenticationError,servicePublicKeySet,signRequest,signServiceAssertion,type Actor,type Command,type OperationsService} from '@egc/operations';
import {registerOperationsRoutes} from './operations.js';
import {verifyDelegatedClaims} from './service-bridge.js';

const hubSecret='synthetic-hub-root-secret-for-delegates-0123456789',mcpSecret='synthetic-mcp-signing-secret-for-delegates-0123456789';
const env={EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_MCP_SIGNING_SECRET:mcpSecret,EGC_OPERATIONS_WORKSPACE:'egc'};
const GRANT='3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b';
const fetcher=vi.fn(async(url:unknown)=>{expect(url).toBe(SERVICE_ORIGINS.hub+'/api/operations-service-keys');return new Response(JSON.stringify(await servicePublicKeySet({service:'hub',rootSecret:hubSecret,workspace:'egc'})),{headers:{'content-type':'application/json'}});});
// The API checks the MCP envelope's iat against its clock, so only Date is faked, at a fixed instant.
const NOW=Date.parse('2026-09-22T12:00:00Z');
beforeAll(()=>{vi.stubGlobal('fetch',fetcher);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(NOW);});
afterAll(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const grant=(hubUser:string,role:string,rootSecret=hubSecret,businessAccess=true)=>signServiceAssertion({service:'hub',rootSecret,workspace:'egc',...MCP_GRANT,claims:{hubUser,role,businessAccess,grantNonce:'x'.repeat(43),resource:'https://egc-mcp.example.invalid',scope:'egc:read egc:write',client:'Claude (claude.ai)'},now:NOW});
const actorFor=(user:string):Actor=>({id:`mcp:${user}:${GRANT}`,kind:'integration',role:'integration',workspace:'egc'});
// The API verifies the MCP envelope within 60 seconds of its clock; the Hub grant itself is verified without its 60-second lifetime.
const envelope=(actor:Actor,body:Command,delegate?:{user:string;role:'owner'|'manager'|'crew';assertion:string},at=NOW)=>signRequest({v:1,iss:'mcp',aud:'egc-operations',iat:Math.floor(at/1000),nonce:randomUUID(),actor,...(delegate?{delegate}:{}),request:{requestId:randomUUID(),body}},mcpSecret);
const task:Command={command:'task.create',task:{title:'Synthetic task',description:'',kind:'manual',priority:'medium',assignedUserId:'zacb',dueAt:'2026-09-22T12:00:00-06:00',timeZone:'America/Denver',waitingOn:'none',reviewAt:null,portalJobId:null,portalVisitId:null,contactId:null,jobId:null,completionCondition:'Synthetic done',sourceEvidence:[],dependencies:[],draft:null}};
async function setup(){const app=Fastify();const execute=vi.fn(async(..._args:unknown[])=>({ok:true}));await registerOperationsRoutes(app,{env,service:{execute} as unknown as OperationsService});return{app,execute};}
const rpc=async(app:Awaited<ReturnType<typeof setup>>['app'],token:string)=>{const response=await app.inject({method:'POST',url:'/operations/rpc',payload:{envelope:token}});return{status:response.statusCode,body:response.json()};};

describe('delegated MCP grants at the API',()=>{
  it('a manager delegate with the Hub signature reaches the service as the plain integration actor',async()=>{
    const {app,execute}=await setup();
    const result=await rpc(app,envelope(actorFor('tylerg'),task,{user:'tylerg',role:'manager',assertion:await grant('tylerg','manager')}));
    expect(result).toEqual({status:200,body:{ok:true}});
    expect(execute.mock.calls[0]?.[0]).toEqual(actorFor('tylerg'));
    // The envelope window is judged by the injected clock: 61 seconds old is refused.
    expect((await rpc(app,envelope(actorFor('tylerg'),task,{user:'tylerg',role:'manager',assertion:await grant('tylerg','manager')},NOW-61_000))).status).toBe(401);
    expect(execute).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('a crew delegate may read but never write, even with a valid Hub signature',async()=>{
    const {app,execute}=await setup(),assertion=await grant('crew1','crew');
    expect(await rpc(app,envelope(actorFor('crew1'),task,{user:'crew1',role:'crew',assertion}))).toEqual({status:403,body:{error:'delegate_write_forbidden'}});
    expect((await rpc(app,envelope(actorFor('crew1'),{command:'status'},{user:'crew1',role:'crew',assertion}))).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('refuses a delegate the Hub did not sign exactly as presented',async()=>{
    const {app,execute}=await setup();
    for(const [actor,delegate] of [
      [actorFor('tylerg'),{user:'tylerg',role:'owner' as const,assertion:await grant('tylerg','manager')}],
      [actorFor('zacb'),{user:'zacb',role:'owner' as const,assertion:await grant('tylerg','owner')}],
      [actorFor('zacb'),{user:'zacb',role:'owner' as const,assertion:await grant('zacb','owner',`${hubSecret}-forged`)}],
      [actorFor('zacb'),{user:'zacb',role:'owner' as const,assertion:await grant('zacb','owner',hubSecret,false)}],
      [actorFor('tylerg'),{user:'zacb',role:'owner' as const,assertion:await grant('zacb','owner')}],
      [{id:'mcp-oauth-grant:'+GRANT,kind:'integration' as const,role:'integration' as const,workspace:'egc'},{user:'zacb',role:'owner' as const,assertion:await grant('zacb','owner')}]
    ] as const){
      const result=await rpc(app,envelope(actor,{command:'status'},delegate));
      expect(result,JSON.stringify(delegate.user)).toEqual({status:403,body:{error:'delegate_invalid'}});
    }
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });
  it('grants without a delegate never fetch the Hub key, and an unreachable key source is a retryable 503',async()=>{
    const {app,execute}=await setup(),before=fetcher.mock.calls.length;
    expect((await rpc(app,envelope({id:'mcp-oauth-grant:'+GRANT,kind:'integration',role:'integration',workspace:'egc'},task))).status).toBe(200);
    expect(fetcher.mock.calls.length).toBe(before);expect(execute).toHaveBeenCalledTimes(1);
    const claims={actor:actorFor('zacb'),request:{body:{command:'status'} as Command},delegate:{user:'zacb',role:'owner' as const,assertion:await grant('zacb','owner')}};
    await expect(verifyDelegatedClaims(claims,{resolveKey:async()=>{throw new ServiceAuthenticationError('service_key_source_unavailable',503);}})).rejects.toMatchObject({code:'service_key_source_unavailable',status:503});
    await app.close();
  });
});
