import {describe,it,expect} from "vitest";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import {registerGhlWebhook,receiptFor} from "./webhooks.js";
describe("durable GHL receipt boundary",()=>{
  it("deduplicates serialization differences but not different events sharing a subscription",()=>{
    expect(receiptFor({type:"ContactUpdate",id:"a",webhookId:"sub"}).providerEventId).toBe(receiptFor({webhookId:"sub",id:"a",type:"ContactUpdate"}).providerEventId);
    expect(receiptFor({webhookId:"sub",id:"a"}).providerEventId).not.toBe(receiptFor({webhookId:"sub",id:"b"}).providerEventId);
  });
  it("rejects unverified and other-location writes before storage and safely acknowledges duplicate races",async()=>{
    const app=Fastify(),ids=new Set<string>();await app.register(rawBody,{global:false,encoding:false,runFirst:true});
    await registerGhlWebhook(app,{locationId:"fixture",verify:(_raw,sig)=>sig==="valid",store:async r=>{if(ids.has(r.providerEventId))return false;ids.add(r.providerEventId);return true;}});
    const payload={type:"ContactCreate",locationId:"fixture",id:"synthetic"};
    expect((await app.inject({method:"POST",url:"/webhooks/ghl",payload})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/webhooks/ghl",payload:{...payload,locationId:"other"},headers:{"x-ghl-signature":"valid"}})).statusCode).toBe(403);
    expect(ids.size).toBe(0);
    const results=await Promise.all([1,2].map(()=>app.inject({method:"POST",url:"/webhooks/ghl",payload,headers:{"x-ghl-signature":"valid"}})));
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,202]);expect(ids.size).toBe(1);await app.close();
  });
  it("does not acknowledge a failed durable receipt or return provider/secrets details",async()=>{
    const app=Fastify();await app.register(rawBody,{global:false,encoding:false,runFirst:true});await registerGhlWebhook(app,{locationId:"fixture",verify:()=>true,store:async()=>{throw new Error("token=private-password");}});
    const response=await app.inject({method:"POST",url:"/webhooks/ghl",payload:{locationId:"fixture"}});
    expect(response.statusCode).toBe(503);expect(response.body).not.toContain("private-password");await app.close();
  });
});
