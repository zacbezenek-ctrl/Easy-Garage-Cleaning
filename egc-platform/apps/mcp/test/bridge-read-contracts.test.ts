import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/server';

const timeline=vi.hoisted(()=>vi.fn());
vi.mock('@egc/customer-state',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),getCustomerTimeline:timeline}));
import {callOperations,operationsPrincipal,registerOperationsTools} from '../src/operations.js';

const env={...process.env};
const contactId='3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b';
const requestId='3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70';
const actor={id:'mcp-oauth-grant:isolated-read-contract',role:'integration' as const,kind:'integration' as const,workspace:'egc'};
const tools=new Map<string,{config:any;handler:(args:unknown)=>Promise<any>}>();
beforeEach(()=>{
  Object.assign(process.env,{EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_API_ORIGIN:'https://operations.example.test',EGC_OPERATIONS_MCP_SIGNING_SECRET:'synthetic-isolated-signing-key-never-production-0123456789'});
  tools.clear();timeline.mockReset();
  registerOperationsTools({registerTool:(name:string,config:any,handler:any)=>tools.set(name,{config,handler})} as unknown as McpServer);
});
afterEach(()=>{process.env={...env};vi.unstubAllGlobals();});
const call=(name:string,args:Record<string,unknown>)=>{
  const tool=tools.get(name)!;
  return operationsPrincipal.run(actor,()=>tool.handler(tool.config.inputSchema.parse(args)));
};

describe('operations bridge read and failure contracts',()=>{
  it('reads exact customer history without refreshing or persisting canonical state and retains freshness',async()=>{
    const canonical={contactId,customer:null,lastReconciledAt:'2026-09-22T12:00:00.000Z',coverage:{complete:false,error:'customer_not_reconciled'}};
    timeline.mockResolvedValue(canonical);
    const fetcher=vi.fn(async()=>Response.json({ok:true,authority:'employee_hub',items:[],coverage:{complete:false}}));vi.stubGlobal('fetch',fetcher);
    const response=await call('egc.customer_history',{contactId});
    expect(timeline).toHaveBeenCalledWith({contactId,refresh:false});
    expect(response.structuredContent.result).toMatchObject({canonical,coverage:{complete:false}});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  for(const status of [429,503]){
    it(`marks HTTP ${status} JSON failures as tool errors, without falling back to an empty calendar`,async()=>{
      const fetcher=vi.fn(async()=>Response.json({error:'portal_authority_unavailable',message:'synthetic private provider body',authorization:'synthetic secret'},{status}));vi.stubGlobal('fetch',fetcher);
      const response=await call('egc.calendar',{startDate:'2026-09-22',endDate:'2026-09-23'});
      expect(response.isError).toBe(true);
      expect(response.structuredContent.result).toMatchObject({error:'portal_authority_unavailable',httpStatus:status});
      expect(response.structuredContent.result).not.toHaveProperty('items');
      expect(JSON.stringify(response)).not.toMatch(/synthetic private|synthetic secret/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it(`keeps HTTP ${status} non-JSON failures bounded, explicit and retryable`,async()=>{
      const fetcher=vi.fn(async()=>new Response('synthetic private edge body',{status}));vi.stubGlobal('fetch',fetcher);
      const response=await call('egc.calendar',{startDate:'2026-09-22',endDate:'2026-09-23'});
      expect(response.isError).toBe(true);
      expect(response.structuredContent.result).toMatchObject({httpStatus:status,retryable:true,coverage:{complete:false}});
      expect(response.structuredContent.result).not.toHaveProperty('items');
      expect(JSON.stringify(response)).not.toContain('synthetic private');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }

  it('never treats HTTP 503 with an inconsistent success body as a successful read',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:true,items:[],coverage:{complete:true}},{status:503})));
    const response=await call('egc.calendar',{startDate:'2026-09-22',endDate:'2026-09-23'});
    expect(response.isError).toBe(true);
    expect(response.structuredContent.result).toMatchObject({ok:false,httpStatus:503,coverage:{complete:false}});
    expect(response.structuredContent.result).not.toHaveProperty('items');
  });

  it('preserves the logical request for an unknown write outcome and never retries automatically',async()=>{
    const fetcher=vi.fn(async()=>new Response('synthetic private edge body',{status:503}));
    const response=await operationsPrincipal.run(actor,()=>callOperations({command:'brief.create',dueBefore:'2026-09-22T12:00:00.000Z',timeZone:'America/Denver'},requestId,fetcher));
    expect(response).toMatchObject({error:'operations_outcome_unknown',httpStatus:503,requestId,retryMode:'same_request_id'});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain('synthetic private');
  });

  it('rejects a malformed successful response instead of fabricating data',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json([])));
    const response=await call('egc.calendar',{startDate:'2026-09-22',endDate:'2026-09-23'});
    expect(response.isError).toBe(true);
    expect(response.structuredContent.result).toMatchObject({error:'operations_response_invalid',coverage:{complete:false}});
    expect(response.structuredContent.result).not.toHaveProperty('items');
  });
});
