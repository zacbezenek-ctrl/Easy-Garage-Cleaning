import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("./timeline.js",()=>({customerTimeline:vi.fn(async(_tx,_contact,_workspace,_offset,_limit,events)=>({items:events,total:events.length,nextOffset:null,coverage:{messages:true,calls:true,portalEvents:events.length}}))}));
import {OperationsService} from "./service.js";
import {customerTimeline} from "./timeline.js";
import type {Actor} from "./contracts.js";
const contactId="11111111-1111-4111-8111-111111111111",requestId="22222222-2222-4222-8222-222222222222";
const actor:Actor={id:"integration",kind:"integration",role:"integration",workspace:"egc"};
const at="2026-09-17T22:54:46Z";
function fixture(provider="ghl"){
  const contact={id:contactId,name:"Synthetic",provider,providerId:"exact-provider"};
  const limit=vi.fn(async()=>[contact]),where=vi.fn(()=>({limit})),from=vi.fn(()=>({where}));
  const db={select:vi.fn(()=>({from})),transaction:vi.fn(async(fn:(tx:unknown)=>unknown)=>fn(db))};
  return{db,contact};
}
const native=()=>({ok:true,authority:"employee_hub",contactProviderIds:["exact-provider"],coverage:{complete:true,asOf:at},records:[{id:"native-a",kind:"walkthrough",highlevelContactId:"exact-provider",createdAt:at,scope:"Five-hour relocation",financials:{timeline:[]}}]});
beforeEach(()=>vi.clearAllMocks());
describe("history service native enrichment",()=>{
  it("uses the normalized exact provider link for contact-only history and returns source coverage",async()=>{
    const f=fixture(),portalRead=vi.fn(async()=>native());
    const result=await new OperationsService(f.db as never,{workspace:"egc",portalRead}).execute(actor,{command:"history",contactId},requestId);
    expect(portalRead).toHaveBeenCalledWith(actor,{command:"portal.evidence",contactProviderIds:["exact-provider"]});
    expect(result.nativeEvidence).toMatchObject({total:1,records:[{id:"native-a",scope:"Five-hour relocation"}],coverage:{complete:true}});
    expect(result.coverage).toMatchObject({nativePortal:{complete:true,association:"exact_provider_contact"}});
    expect(customerTimeline).toHaveBeenCalledWith(f.db,contactId,"egc",0,50,[expect.objectContaining({id:"hub-record:native-a"})]);
  });
  it("keeps mirrored history readable with explicit unavailable native coverage",async()=>{
    const f=fixture();const result=await new OperationsService(f.db as never,{workspace:"egc"}).execute(actor,{command:"history",contactId},requestId);
    expect(result.ok).toBe(true);expect(result.nativeEvidence).toMatchObject({total:null,records:[],coverage:{complete:false,available:false,reason:"portal_authority_unavailable"}});
    expect(result.coverage).toMatchObject({quotes:"unavailable",payments:"unavailable"});
  });
  it("labels financial source coverage partial when the native source is partial",async()=>{
    const f=fixture(),portalRead=vi.fn(async()=>({...native(),coverage:{complete:false,asOf:at}}));
    const result=await new OperationsService(f.db as never,{workspace:"egc",portalRead}).execute(actor,{command:"history",contactId},requestId);
    expect(result.coverage).toMatchObject({quotes:"partial_exact_provider_contact_native_records",payments:"partial_exact_provider_contact_native_records",nativePortal:{complete:false,available:true}});
  });
  it("never performs a provider read for another CRM namespace",async()=>{
    const f=fixture("other"),portalRead=vi.fn(async()=>native());const result=await new OperationsService(f.db as never,{workspace:"egc",portalRead}).execute(actor,{command:"history",contactId},requestId);
    expect(portalRead).not.toHaveBeenCalled();expect(result.nativeEvidence).toMatchObject({coverage:{reason:"portal_contact_link_unresolved"}});
  });
  it("retains explicit portal-to-contact mismatch rejection before native evidence reads",async()=>{
    const f=fixture(),portalRead=vi.fn(async()=>native()),resolvePortalJob=vi.fn(async()=>({id:"native-a",revision:"rev",type:"walkthrough",highlevelContactId:"exact-provider",sourceWalkthroughId:null,customer:null,status:"scheduled"}));
    await expect(new OperationsService(f.db as never,{workspace:"egc",portalRead,resolvePortalJob}).execute(actor,{command:"history",contactId:"33333333-3333-4333-8333-333333333333",portalJobId:"native-a"},requestId)).rejects.toMatchObject({code:"portal_contact_mismatch"});
    expect(portalRead).not.toHaveBeenCalled();expect(customerTimeline).not.toHaveBeenCalled();
  });
});
