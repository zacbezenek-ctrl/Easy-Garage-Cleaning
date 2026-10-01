import {OperationsError} from "./contracts.js";

export const isSmsFromNumber=(value:unknown):value is string=>typeof value==="string"&&/^\+[1-9]\d{6,14}$/.test(value);
/** A deployment-owned allowlist, never a sender default. One invalid entry disables
 * the whole list rather than silently authorizing a partially parsed configuration. */
export function validSmsFromNumbers(value:unknown):string[] {
  return Array.isArray(value)&&value.length<=20&&value.every(isSmsFromNumber)?[...new Set(value)]:[];
}
export function assertSmsDraftSender(draft:Record<string,unknown>,allowed:unknown) {
  if(draft.channel!=="sms")return;
  if(!isSmsFromNumber(draft.fromNumber))throw new OperationsError("sms_sender_required",409,{sent:false});
  if(!validSmsFromNumbers(allowed).includes(draft.fromNumber))throw new OperationsError("sms_sender_not_configured",409,{sent:false});
}
