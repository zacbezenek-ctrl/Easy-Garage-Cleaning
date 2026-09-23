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
export type NormalizedCallMetadata={durationSeconds:number|null;recordingUrl:string|null;answered:boolean|null};

function supportedDuration(value:unknown):number|null {
  if(value===null||value===undefined||value==="")return null;
  const parsed=typeof value==="number"?value:typeof value==="string"&&/^\\d+(?:\\.\\d+)?$/.test(value.trim())?Number(value):NaN;
  if(!Number.isFinite(parsed)||parsed<0||parsed>86400)return null;
  return Math.round(parsed);
}
function safeRecordingReference(value:unknown):string|null {
  const raw=typeof value==="string"?value.trim():null;
  if(!raw||raw.length>4000)return null;
  try{
    const url=new URL(raw);
    if(!["https:","http:"].includes(url.protocol)||url.username||url.password)return null;
    for(const key of [...url.searchParams.keys()])if(/(?:token|secret|signature|credential|authorization|api.?key|x-amz-(?:credential|signature|security-token))/i.test(key))url.searchParams.delete(key);
    return url.toString();
  }catch{return null;}
}
function recordingFromAttachment(value:unknown):string|null {
  const row=record(value),type=lower(row.type??row.contentType??row.mimeType),name=lower(row.name??row.filename);
  if(typeof value==="string")return safeRecordingReference(value);
  if(type&&!/(?:audio|recording|voice)/.test(type)&&name&&!/\\.(?:wav|mp3|m4a|aac|ogg|webm)$/.test(name))return null;
  return safeRecordingReference(row.url??row.recordingUrl??row.downloadUrl??row.href);
}
/** Normalize only provider-supported call facts. Duration/recording never prove a
 * human answer; answered stays evidence-based and unknown when the payload does
 * not explicitly distinguish a person from screening/voicemail. */
export function normalizeCallMetadata(raw:Raw):NormalizedCallMetadata {
  const meta=record(raw.meta),call=record(meta.call);
  const durationCandidates=[raw.callDuration,raw.duration,raw.durationSeconds,meta.callDuration,meta.duration,call.callDuration,call.duration,call.durationSeconds];
  const durationSeconds=durationCandidates.map(supportedDuration).find(v=>v!==null)??null;
  const direct=[raw.recordingUrl,raw.recordingURL,raw.callRecordingUrl,raw.callRecordingURL,meta.recordingUrl,meta.recordingURL,call.recordingUrl,call.recordingURL].map(safeRecordingReference).find(Boolean)??null;
  const attachmentLists=[raw.attachments,raw.messageAttachments,meta.attachments,call.attachments].filter(Array.isArray) as unknown[][];
  const recordingUrl=direct??attachmentLists.flat().map(recordingFromAttachment).find(Boolean)??null;
  return {durationSeconds,recordingUrl,answered:callContactEvidence(raw).answered};
}

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
