type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
const lower = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

export function isCallMessage(type: string) {
  return /call|voicemail/i.test(type) || ["1", "10"].includes(type);
}

/** Provider call completion and duration also describe screening/voicemail.
 * Only actual dialogue evidence proves contact. Unlabelled transcripts are
 * classified by customer-state extraction and merged from its durable ledger.
 */
export function callContactEvidence(raw: Raw, transcript?: string | null) {
  const meta = record(raw.meta);
  const call = record(meta.call);
  const status = lower(raw.status);
  const callStatus = lower(raw.callStatus ?? meta.callStatus ?? call.status);
  const answeredBy = lower(raw.answeredBy ?? meta.answeredBy);
  const disposition = lower(raw.disposition ?? meta.disposition);
  const combined = [status, callStatus, answeredBy, disposition, lower(raw.messageTypeString)].join(" ");
  if (/screen/.test(combined)) return { outcome: "screened", answered: false, twoWay: false } as const;
  if (/voicemail|machine|answering.machine/.test(combined)) return { outcome: "voicemail", answered: false, twoWay: false } as const;
  if (/no.?answer|missed|busy|failed|cancel/.test(combined)) return { outcome: "unanswered", answered: false, twoWay: false } as const;
  if(transcript && /please (?:leave|record) (?:your |a )?(?:message|name)|after the (?:tone|beep)|see if this person is available|couldn't get to your call/i.test(transcript))return {outcome:"voicemail",answered:false,twoWay:false} as const;
  const customerSpeech = transcript?.split(/\n/).some(line=>/^(?:\d{1,2}:\d{2}:?\s*)?(?:customer|client|lead)\s*:\s*\S.{2}/i.test(line));
  const staffSpeech = transcript?.split(/\n/).some(line=>/^(?:\d{1,2}:\d{2}:?\s*)?(?:agent|representative|employee|zac|zach|tyler)\s*:\s*\S.{2}/i.test(line));
  if(customerSpeech&&staffSpeech)return {outcome:"human_connected",answered:true,twoWay:true} as const;
  return { outcome: "unknown", answered: null, twoWay: false } as const;
}

export type CommunicationEvidence = {
  direction: string; actorType: string; at: Date; type?: string; raw: Raw; transcript?: string | null;
};

export function communicationSummary(messages: CommunicationEvidence[], calls: CommunicationEvidence[]) {
  let lastHumanOutreachAt: Date | null = null;
  let lastCustomerResponseAt: Date | null = null;
  let lastHumanMessageAt: Date | null = null;
  let lastCustomerMessageAt: Date | null = null;
  let lastVerifiedCallAt: Date | null = null;
  const latest = (a: Date | null, b: Date) => !a || b > a ? b : a;
  for (const item of messages) {
    if (isCallMessage(item.type ?? "")) continue;
    const failed = ["failed", "undelivered", "cancelled"].includes(lower(item.raw.status));
    if (item.direction === "outbound" && item.actorType === "human") {
      lastHumanOutreachAt = latest(lastHumanOutreachAt, item.at);
      if (!failed) lastHumanMessageAt = latest(lastHumanMessageAt, item.at);
    }
    if (item.direction === "inbound" && item.actorType === "customer" && !failed) {
      lastCustomerResponseAt = latest(lastCustomerResponseAt, item.at);
      lastCustomerMessageAt = latest(lastCustomerMessageAt, item.at);
    }
  }
  for (const item of calls) {
    if (item.direction === "outbound" && item.actorType === "human") lastHumanOutreachAt = latest(lastHumanOutreachAt, item.at);
    if (callContactEvidence(item.raw,item.transcript).twoWay) {
      lastVerifiedCallAt = latest(lastVerifiedCallAt, item.at);
      lastCustomerResponseAt = latest(lastCustomerResponseAt, item.at);
    }
  }
  return { lastHumanOutreachAt, lastCustomerResponseAt,
    twoWayContactAt: lastHumanMessageAt && lastCustomerMessageAt ? latest(lastVerifiedCallAt,latest(lastHumanMessageAt,lastCustomerMessageAt)) : lastVerifiedCallAt,
    hasHumanOutreach: Boolean(lastHumanOutreachAt), hasCustomerResponse: Boolean(lastCustomerResponseAt) };
}
