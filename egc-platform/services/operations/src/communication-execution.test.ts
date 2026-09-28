import {describe,it,expect,vi} from "vitest";
import {createHash} from "node:crypto";
import {schema} from "@egc/database";
import {normalizedCommunicationPayload,preflightRecipient} from "./communication-execution.js";
const sha=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sms={type:"SMS",contactId:"synthetic-provider-id",message:"Synthetic approved message",toNumber:"+15555550100"};
const urls=["https://easygaragecleaning.com/portal/quote/synthetic-1","https://easygaragecleaning.com/gallery/synthetic?set=2#top"];
describe("normalized communication payload",()=>{
 it("keeps the exact pre-attachment payload and hash when there are no attachments",()=>{
  const legacy={type:"SMS",contactId:sms.contactId,message:sms.message,subject:null,emailFrom:null,emailTo:null,fromNumber:null,toNumber:sms.toNumber};
  for(const raw of [sms,{...sms,attachments:[]},{...sms,attachments:null},{...sms,attachments:undefined}]){const {payload,hash}=normalizedCommunicationPayload(raw);expect(payload).toEqual(legacy);expect("attachments" in payload).toBe(false);expect(hash).toBe(sha(legacy));}
 });
 it("puts the exact attachment URLs, in order, in the payload and its hash",()=>{
  const plain=normalizedCommunicationPayload(sms),withLinks=normalizedCommunicationPayload({...sms,attachments:urls}),reversed=normalizedCommunicationPayload({...sms,attachments:[...urls].reverse()});
  expect(withLinks.payload.attachments).toEqual(urls);expect(withLinks.hash).toBe(sha({...plain.payload,attachments:urls}));
  expect(new Set([plain.hash,withLinks.hash,reversed.hash]).size).toBe(3);
  expect(normalizedCommunicationPayload({...sms,attachments:[urls[0]]}).hash).not.toBe(withLinks.hash);
 });
 it("copies the list so later caller mutation cannot change what was hashed",()=>{const list=[...urls],{payload,hash}=normalizedCommunicationPayload({...sms,attachments:list});list.push("https://example.com/late");expect(payload.attachments).toEqual(urls);expect(sha(payload)).toBe(hash);});
 it("rejects attachment lists that are not non-empty strings",()=>{for(const attachments of ["https://example.com/a",[""],[1],[null],[{url:urls[0]}],{0:urls[0]}])expect(()=>normalizedCommunicationPayload({...sms,attachments})).toThrow("message_attachments_invalid");});
});
type Rows={contact?:Record<string,unknown>;lead?:Record<string,unknown>};
function fakeDb(rows:Rows){
 const limit=(table:unknown)=>async()=>table===schema.contacts?(rows.contact?[rows.contact]:[]):table===schema.leads?(rows.lead?[rows.lead]:[]):[];
 return {select:()=>({from:(table:unknown)=>({where:()=>({limit:limit(table)})})})} as unknown as Parameters<typeof preflightRecipient>[2];
}
const contact={id:"00000000-0000-4000-8000-000000000001",provider:"ghl",providerId:"synthetic-provider-id"};
const live=(extra:Record<string,unknown>={})=>({contact:{id:contact.providerId,locationId:"synthetic-location",phone:"+1 (555) 555-0100",email:"Synthetic@Example.invalid",...extra}});
const run=(provider:{getContact:ReturnType<typeof vi.fn>},rows:Rows={contact,lead:{dnd:false}},input:Partial<Parameters<typeof preflightRecipient>[0]>={})=>{const connect=vi.fn(()=>provider);return {connect,result:preflightRecipient({contactId:contact.id,channel:"SMS",toNumber:"+15555550100",...input},connect,fakeDb(rows))};};
describe("recipient preflight",()=>{
 it("verifies the live phone by digits and returns the saved contact and provider",async()=>{const provider={getContact:vi.fn(async()=>live())},{connect,result}=run(provider);const r=await result;expect(r).toMatchObject({ok:true,contact,phone:"+1 (555) 555-0100",email:"Synthetic@Example.invalid"});expect(r.ok&&r.provider).toBe(provider);expect(connect).toHaveBeenCalledTimes(1);expect(provider.getContact).toHaveBeenCalledWith(contact.providerId);});
 it("never connects to the provider for an unknown contact",async()=>{const provider={getContact:vi.fn()},{connect,result}=run(provider,{});expect(await result).toEqual({ok:false,error:"contact_not_found"});expect(connect).not.toHaveBeenCalled();});
 it("refuses the lead flag, provider DND and an active channel DND",async()=>{
  for(const [rows,extra] of [[{contact,lead:{dnd:true}},{}],[{contact},{dnd:true}],[{contact},{dndSettings:{SMS:{status:"active"}}}]] as [Rows,Record<string,unknown>][]){const {result}=run({getContact:vi.fn(async()=>live(extra))},rows);expect(await result).toEqual({ok:false,error:"contact_do_not_contact"});}
  const {result}=run({getContact:vi.fn(async()=>live({dndSettings:{Email:{status:"active"},SMS:{status:"inactive"}}}))});expect((await result).ok).toBe(true);
 });
 it("reports an unavailable provider without echoing its error",async()=>{const {result}=run({getContact:vi.fn(async()=>{throw new Error("token=synthetic-secret");})});const r=await result;expect(r).toEqual({ok:false,error:"contact_preflight_unavailable"});expect(JSON.stringify(r)).not.toContain("synthetic-secret");});
 it("requires the named destination to be the provider's verified phone or email",async()=>{
  expect(await run({getContact:vi.fn(async()=>live())},undefined,{toNumber:"+15555550199"}).result).toEqual({ok:false,error:"verified_contact_phone_required"});
  expect(await run({getContact:vi.fn(async()=>live({phone:""}))}).result).toEqual({ok:false,error:"verified_contact_phone_required"});
  expect(await run({getContact:vi.fn(async()=>live())},undefined,{channel:"Email",toNumber:undefined,emailTo:"other@example.invalid"}).result).toEqual({ok:false,error:"verified_contact_email_required"});
  expect((await run({getContact:vi.fn(async()=>live())},undefined,{channel:"Email",toNumber:undefined,emailTo:"synthetic@example.invalid"}).result).ok).toBe(true);
 });
});
