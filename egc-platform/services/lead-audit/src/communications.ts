type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
const lower = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

export function isCallMessage(type: string) {
  return /call|voicemail/i.test(type) || ["1", "10"].includes(type);
}

/** Preserve uncertainty: completed alone proves neither a human nor a conversation.
 * HighLevel documents completed status + completed callStatus + positive duration as a human-connected call.
 * Explicit voicemail/screening evidence always wins over generic completion.
 */
export function callContactEvidence(raw: Raw) {
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
  const duration = Number(raw.callDuration ?? raw.duration ?? meta.callDuration ?? call.duration);
  const human = answeredBy === "human" && duration > 0;
  const direction = lower(raw.direction);
  const documentedConnectedCall =
    ["inbound", "outbound"].includes(direction) &&
    status === "completed" &&
    callStatus === "completed" &&
    typeof raw.userId === "string" &&
    raw.userId.length > 0 &&
    duration > 0;
  if (human || documentedConnectedCall) return { outcome: "human_connected", answered: true, twoWay: true } as const;
  return { outcome: "unknown", answered: null, twoWay: false } as const;
}

export type CommunicationEvidence = {
  direction: string; actorType: string; at: Date; type?: string; raw: Raw;
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
    if (callContactEvidence(item.raw).twoWay) {
      lastVerifiedCallAt = latest(lastVerifiedCallAt, item.at);
      lastCustomerResponseAt = latest(lastCustomerResponseAt, item.at);
    }
  }
  return { lastHumanOutreachAt, lastCustomerResponseAt,
    twoWayContactAt: lastVerifiedCallAt ?? (lastHumanMessageAt && lastCustomerMessageAt ? latest(lastHumanMessageAt, lastCustomerMessageAt) : null),
    hasHumanOutreach: Boolean(lastHumanOutreachAt), hasCustomerResponse: Boolean(lastCustomerResponseAt) };
}
