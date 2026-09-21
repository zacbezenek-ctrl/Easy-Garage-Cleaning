import {createHash} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {getDb,schema} from "@egc/database";
import {verifyGhlWebhook} from "./webhook-signature.js";
export type Receipt={providerEventId:string;eventType:string;payload:Record<string,unknown>;processingStatus:string};
export function receiptFor(payload:Record<string,unknown>):Receipt {
  // webhookId can name a subscription. Include the canonical event payload so two
  // distinct deliveries from one subscription can never suppress each other.
  const stable=(v:unknown):string=>Array.isArray(v)?`[${v.map(stable).join(",")}]`:v&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable((v as Record<string,unknown>)[k])}`).join(",")}}`:JSON.stringify(v);
  const digest=createHash("sha256").update(stable(payload)).digest("hex");
  return {providerEventId:`sha256:${digest}`,eventType:String(payload.type??payload.eventType??"unknown"),payload,processingStatus:"pending"};
}
export async function registerGhlWebhook(app:FastifyInstance,options:{locationId?:string;verify?:(raw:Buffer,signature:string|undefined)=>boolean;store?:(receipt:Receipt)=>Promise<boolean>}={}) {
  const verify=options.verify??verifyGhlWebhook;
  const store=options.store??(async receipt=>Boolean((await getDb().insert(schema.webhookEvents).values(receipt).onConflictDoNothing({target:schema.webhookEvents.providerEventId}).returning({id:schema.webhookEvents.id}))[0]));
  app.post("/webhooks/ghl",{config:{rawBody:true},bodyLimit:2*1024*1024},async(request,reply)=>{
    const raw=(request as typeof request & {rawBody?:Buffer}).rawBody;
    const signature=request.headers["x-ghl-signature"];
    if(!raw||!verify(raw,Array.isArray(signature)?signature[0]:signature))return reply.code(401).send({error:"invalid_signature"});
    const payload=request.body;
    if(!payload||typeof payload!=="object"||Array.isArray(payload))return reply.code(400).send({error:"invalid_event"});
    const locationId=options.locationId??process.env.GHL_LOCATION_ID;
    if(!locationId)return reply.code(503).send({error:"webhook_location_not_configured"});
    if((payload as Record<string,unknown>).locationId!==locationId)return reply.code(403).send({error:"location_mismatch"});
    try {
      const inserted=await store(receiptFor(payload as Record<string,unknown>));
      return reply.code(inserted?202:200).send({ok:true,duplicate:!inserted});
    }catch {request.log.error({code:"webhook_receipt_unavailable"},"Webhook receipt failed");return reply.code(503).send({error:"webhook_receipt_unavailable"});}
  });
}
