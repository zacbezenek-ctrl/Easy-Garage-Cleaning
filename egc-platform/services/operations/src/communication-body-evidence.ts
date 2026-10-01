import {createHash} from "node:crypto";

const digest=(body:string)=>createHash("sha256").update(body).digest("hex");
const TRANSFORM="sms_u2019_to_ascii_apostrophe";
export type CommunicationBodyEvidence={version:1;bodyHash:string}|{
  version:2;bodyHash:string;approvedBodyHash:string;providerBodyHash:string;
  providerBody:string;bodyTransform:typeof TRANSFORM;
};

/** A provider SMS may replace U+2019 with ASCII apostrophe. This is deliberately
 * one-way and SMS-only: no whitespace, case, Unicode, quote or dash normalization.
 * Approval/deduplication continue to bind the untouched outbound payload.
 */
export function communicationBodyEvidence(approved:unknown,observed:unknown,type:unknown):CommunicationBodyEvidence|null {
  if(typeof approved!=="string"||typeof observed!=="string")return null;
  if(approved===observed)return {version:1,bodyHash:digest(observed)};
  if(type!=="SMS"||!approved.includes("\u2019")||approved.replaceAll("\u2019","'")!==observed)return null;
  const providerBodyHash=digest(observed);
  return {version:2,bodyHash:providerBodyHash,approvedBodyHash:digest(approved),providerBodyHash,providerBody:observed,bodyTransform:TRANSFORM};
}

/** Completion independently rechecks the proof against the original approved
 * draft and stored raw send. Version-one exact-body receipts remain compatible.
 */
export function approvedCommunicationBodyMatches(evidence:Record<string,unknown>,approved:unknown,sent:unknown,type:unknown):boolean {
  if(typeof approved!=="string"||sent!==approved)return false;
  if(evidence.version===1)return evidence.bodyHash===digest(approved);
  if(evidence.version!==2)return false;
  const expected=communicationBodyEvidence(approved,evidence.providerBody,type);
  return expected?.version===2&&evidence.bodyTransform===expected.bodyTransform&&
    evidence.bodyHash===expected.bodyHash&&evidence.approvedBodyHash===expected.approvedBodyHash&&
    evidence.providerBodyHash===expected.providerBodyHash;
}
