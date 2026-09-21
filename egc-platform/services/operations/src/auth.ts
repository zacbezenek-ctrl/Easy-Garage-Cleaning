import {createHmac, timingSafeEqual} from "node:crypto";
import {signedClaimsSchema, OperationsError, type SignedClaims} from "./contracts.js";

export type SigningKeys = Partial<Record<"portal"|"mcp",string>>;
export function signRequest(claims:SignedClaims,key:string):string {
  if (key.length < 32) throw new OperationsError("signing_key_not_configured",503);
  const payload=Buffer.from(JSON.stringify(signedClaimsSchema.parse(claims))).toString("base64url");
  return payload+"."+createHmac("sha256",key).update(payload).digest("base64url");
}
export function verifyRequest(token:unknown,keys:SigningKeys,now=Date.now(),audience:"egc-operations"|"egc-portal"="egc-operations"):SignedClaims {
  if (typeof token !== "string" || token.length > 200000) throw new OperationsError("invalid_operations_signature",401);
  const parts=token.split(".");
  if (parts.length !== 2 || !parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))
    throw new OperationsError("invalid_operations_signature",401);
  const [payload,signature]=parts as [string,string];
  let untrusted:unknown;
  try {untrusted=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));}
  catch {throw new OperationsError("invalid_operations_signature",401);}
  // Only the issuer is used to choose a server-configured key. All claims remain untrusted until HMAC verification.
  const issuer=(untrusted as {iss?:unknown}|null)?.iss;
  if (issuer !== "portal" && issuer !== "mcp") throw new OperationsError("invalid_operations_signature",401);
  const key=keys[issuer];
  if (!key || key.length<32) throw new OperationsError("issuer_not_configured",503);
  const actual=Buffer.from(signature,"base64url");
  const expected=createHmac("sha256",key).update(payload).digest();
  if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new OperationsError("invalid_operations_signature",401);
  const result=signedClaimsSchema.safeParse(untrusted);
  if (!result.success) throw new OperationsError("invalid_operations_request",400);
  const claims=result.data;
  if (claims.aud !== audience) throw new OperationsError("invalid_operations_audience",401);
  if (Math.abs(now-claims.iat*1000)>60000) throw new OperationsError("operations_signature_expired",401);
  return claims;
}
