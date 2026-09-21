import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import * as z from 'zod/v4';
import {actorSchema,createTaskSchema,OperationsError,type Actor} from '@egc/operations';
import {walkthroughExtractionSchema} from '@egc/schemas';
export const MAX_AUDIO_BYTES=24*1024*1024;
const recordId=z.string().uuid();
const hubId=z.string().regex(/^[A-Za-z0-9_-]{1,180}$/);
export const recordingCommand=z.discriminatedUnion('command',[
  z.object({command:z.literal('recording.list'),portalJobId:hubId,offset:z.number().int().min(0).default(0)}).strict(),
  z.object({command:z.literal('recording.get'),recordingId:recordId}).strict(),
  z.object({command:z.literal('recording.retry'),recordingId:recordId}).strict(),
  z.object({command:z.literal('recording.refresh_source'),recordingId:recordId}).strict(),
  z.object({command:z.literal('recording.upload'),portalJobId:hubId,audioSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({command:z.literal('recording.approve'),recordingId:recordId,revision:z.string().datetime({offset:true}),extraction:walkthroughExtractionSchema,
    actions:z.array(createTaskSchema).max(30).default([])}).strict()
]);
export type RecordingCommand=z.infer<typeof recordingCommand>;
export type RecordingClaims={v:1;iss:'portal'|'mcp';aud:'egc-recordings';iat:number;nonce:string;actor:Actor;request:{requestId:string;body:RecordingCommand}};
const claimsSchema=z.object({v:z.literal(1),iss:z.enum(['portal','mcp']),aud:z.literal('egc-recordings'),iat:z.number().int(),nonce:recordId,actor:actorSchema,request:z.object({requestId:recordId,body:recordingCommand}).strict()}).strict();
export function fingerprint(value:unknown):string{const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
export function stableUuid(value:string){const hash=createHash('sha256').update(value).digest('hex');return`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
export function signRecordingEnvelope(claims:unknown,key:string){if(key.length<32)throw new OperationsError('recording_bridge_not_configured',503);const p=Buffer.from(JSON.stringify(claims)).toString('base64url');return p+'.'+createHmac('sha256',key).update(p).digest('base64url');}
export function verifyRecordingEnvelope(token:unknown,keys:string|{portal:string;mcp:string},workspace:string,now=Date.now()):RecordingClaims{
  if(typeof token!=='string'||token.length>200000)throw new OperationsError('invalid_recording_signature',401);
  const parts=token.split('.');if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw new OperationsError('invalid_recording_signature',401);
  let decoded:unknown;try{decoded=JSON.parse(Buffer.from(parts[0]!,'base64url').toString());}catch{throw new OperationsError('invalid_recording_request',400);}
  const issuer=(decoded as {iss?:unknown})?.iss;if(issuer!=='portal'&&issuer!=='mcp')throw new OperationsError('invalid_recording_signature',401);
  const key=typeof keys==='string'?keys:keys[issuer];if(key.length<32)throw new OperationsError('recording_bridge_not_configured',503);
  const expected=createHmac('sha256',key).update(parts[0]!).digest(),actual=Buffer.from(parts[1]!,'base64url');
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new OperationsError('invalid_recording_signature',401);
  const parsed=claimsSchema.safeParse(decoded);if(!parsed.success)throw new OperationsError('invalid_recording_request',400);
  const c=parsed.data;if(Math.abs(now-c.iat*1000)>60000)throw new OperationsError('recording_signature_expired',401);
  const integrationRead=c.iss==='mcp'&&c.actor.kind==='integration'&&c.actor.role==='integration'&&['recording.list','recording.get','recording.retry'].includes(c.request.body.command);
  const human=c.iss==='portal'&&c.actor.kind==='human'&&['owner','manager','sales'].includes(c.actor.role);
  if(c.actor.workspace!==workspace||(!human&&!integrationRead))throw new OperationsError('recording_role_forbidden',403);
  if(['recording.approve','recording.refresh_source'].includes(c.request.body.command)&&!['owner','manager'].includes(c.actor.role))throw new OperationsError('human_manager_approval_required',403);
  return c;
}
export function safeRecordingError(error:unknown){return error instanceof OperationsError?error.code:'recording_processing_failed';}
