/**
 * Side-effect-free unified-operations rules over the EXISTING task records.
 * This is not a sender, authorization service, database, or production rollout.
 * Adapters must authenticate, persist revisions/snapshots and claim executions
 * transactionally before using these rules. No customer data is inferred here.
 */
export type Instant = string | Date;
export type TaskStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled" | "superseded";
export type WaitingOn = "EGC" | "customer" | "provider" | "none";
export type ExecutionStatus = "not_started" | "queued" | "in_flight" | "provider_accepted" | "succeeded" | "failed" | "unknown";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TaskInput {
  id: string;
  title: string;
  status: string;
  dueAt: Instant | null;
  assignedUserId: string | null;
  priority: string;
  contactId?: string | null;
  jobId?: string | null;
  revision?: number | null;
  waitingOn?: WaitingOn;
  reviewAt?: Instant | null;
}
export interface SourceCoverage {
  source: string;
  status: "fresh" | "stale" | "unavailable" | "unknown";
  complete: boolean;
  asOf: Instant | null;
}
export interface QueueIssue { taskId: string | null; code: string; }
export interface QueueItem {
  id: string;
  revision: number | null;
  title: string;
  status: TaskStatus;
  priority: string;
  owner: string | null;
  contactId: string | null;
  jobId: string | null;
  dueAt: string | null;
  reviewAt: string | null;
  attentionAt: string;
  waitingOn: WaitingOn;
  reason: "due" | "review";
  overdue: boolean;
}
export interface QueueSnapshot {
  id: string;
  generatedAt: string;
  dueBefore: string;
  timeZone: string;
  items: readonly Readonly<QueueItem>[];
  issues: readonly Readonly<QueueIssue>[];
  coverage: readonly Readonly<{source: string; status: SourceCoverage["status"]; complete: boolean; asOf: string | null}>[];
  counts: Readonly<{ observedDue: number; overdue: number; totalDue: number | null; exceptions: number }>;
}
const OPEN = new Set<string>(["open", "in_progress", "blocked"]);
const CLOSED = new Set<string>(["completed", "cancelled", "superseded"]);
const WAITING = new Set<string>(["EGC", "customer", "provider", "none"]);
const PRIORITY: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const nonempty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

function milliseconds(value: Instant, label: string): number {
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!m) throw new Error(`${label}: explicit ISO timestamp and offset required`);
    const [, y, mo, d, h, mi, s, tz] = m;
    const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > days ||
        Number(h) > 23 || Number(mi) > 59 || Number(s) > 59 ||
        (tz !== "Z" && (Number(tz!.slice(1, 3)) > 23 || Number(tz!.slice(4)) > 59))) {
      throw new Error(`${label}: invalid timestamp`);
    }
  } else if (!(value instanceof Date)) throw new Error(`${label}: invalid timestamp`);
  const n = value instanceof Date ? value.valueOf() : Date.parse(value);
  if (!Number.isFinite(n)) throw new Error(`${label}: invalid timestamp`);
  return n;
}
function iso(value: Instant, label: string): string { return new Date(milliseconds(value, label)).toISOString(); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** All pages must first be collected from one consistent source snapshot.
 * Never filter the input by lead age, booked status, or last outreach direction.
 * Incomplete source reads retain observed items but cannot claim a total of zero.
 */
export function buildDueWorkSnapshot(input: {
  id: string; generatedAt: Instant; dueBefore: Instant; timeZone: string;
  tasks: readonly TaskInput[]; coverage: readonly SourceCoverage[];
  requiredSources: readonly string[];
}): Readonly<QueueSnapshot> {
  if (!nonempty(input.id)) throw new Error("Snapshot ID required");
  if (!nonempty(input.timeZone)) throw new Error("Explicit timezone required");
  new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format();
  const now = milliseconds(input.generatedAt, "generatedAt");
  const before = milliseconds(input.dueBefore, "dueBefore");
  if (before <= now) throw new Error("dueBefore must be after generatedAt");
  const issues: QueueIssue[] = [];
  const items: QueueItem[] = [];
  const ids = new Set<string>();
  let structurallyComplete = true;
  for (const task of input.tasks) {
    if (!nonempty(task.id) || ids.has(task.id)) throw new Error("Missing or duplicate canonical task ID");
    ids.add(task.id);
    if (CLOSED.has(task.status)) continue;
    if (!OPEN.has(task.status)) {
      issues.push({ taskId: task.id, code: "unknown_task_status" });
      structurallyComplete = false;
      continue;
    }
    const owner = nonempty(task.assignedUserId) ? task.assignedUserId : null;
    if (!owner) issues.push({ taskId: task.id, code: "owner_missing" });
    if (!revision(task.revision)) issues.push({ taskId: task.id, code: "revision_missing" });
    const waitingOn = task.waitingOn ?? "none";
    if (!WAITING.has(waitingOn)) {
      issues.push({ taskId: task.id, code: "unknown_waiting_state" });
      structurallyComplete = false;
      continue;
    }
    const review = waitingOn === "customer" || waitingOn === "provider";
    let dueAt: string | null;
    let reviewAt: string | null;
    try {
      dueAt = task.dueAt == null ? null : iso(task.dueAt, "task.dueAt");
      reviewAt = task.reviewAt == null ? null : iso(task.reviewAt, "task.reviewAt");
    } catch {
      issues.push({ taskId: task.id, code: "invalid_task_time" });
      structurallyComplete = false;
      continue;
    }
    const attentionAt = review ? reviewAt : dueAt;
    if (!attentionAt) {
      issues.push({ taskId: task.id, code: review ? "review_time_missing" : "due_time_missing" });
      structurallyComplete = false;
      continue;
    }
    if (Date.parse(attentionAt) >= before) continue;
    items.push({
      id: task.id, revision: revision(task.revision) ? task.revision : null,
      title: task.title, status: task.status as TaskStatus, priority: task.priority,
      owner, contactId: task.contactId ?? null, jobId: task.jobId ?? null,
      dueAt, reviewAt, attentionAt, waitingOn, reason: review ? "review" : "due",
      overdue: Date.parse(attentionAt) < now
    });
  }
  items.sort((a, b) => compare(a.attentionAt, b.attentionAt) ||
    (PRIORITY[a.priority] ?? 4) - (PRIORITY[b.priority] ?? 4) || compare(a.id, b.id));
  const sources = new Set<string>();
  const coverage = input.coverage.map(source => {
    if (!nonempty(source.source) || sources.has(source.source)) throw new Error("Duplicate or missing source name");
    sources.add(source.source);
    let asOf: string | null = null;
    let status = source.status;
    try { asOf = source.asOf == null ? null : iso(source.asOf, "source.asOf"); }
    catch { status = "unknown"; }
    if (!asOf || Date.parse(asOf) > now || !["fresh", "stale", "unavailable", "unknown"].includes(status)) status = "unknown";
    if (status !== "fresh" || source.complete !== true) issues.push({ taskId: null, code: `source_incomplete:${source.source}` });
    return Object.freeze({ source: source.source, status, complete: source.complete === true, asOf });
  });
  if (!input.requiredSources.length) issues.push({ taskId: null, code: "required_sources_unspecified" });
  for (const source of new Set(input.requiredSources)) {
    if (!sources.has(source)) issues.push({ taskId: null, code: `source_missing:${source}` });
  }
  const complete = structurallyComplete && input.requiredSources.length > 0 &&
    input.requiredSources.every(name => coverage.some(c => c.source === name && c.status === "fresh" && c.complete));
  issues.sort((a, b) => compare(a.taskId ?? "", b.taskId ?? "") || compare(a.code, b.code));
  return Object.freeze({
    id: input.id, generatedAt: new Date(now).toISOString(), dueBefore: new Date(before).toISOString(),
    timeZone: input.timeZone, items: Object.freeze(items.map(item => Object.freeze(item))),
    issues: Object.freeze(issues.map(issue => Object.freeze(issue))), coverage: Object.freeze(coverage),
    counts: Object.freeze({ observedDue: items.length, overdue: items.filter(t => t.overdue).length,
      totalDue: complete ? items.length : null, exceptions: issues.length })
  });
}

/** Page a previously persisted snapshot; never rerun a live query for page 2. */
export function pageDueWork(snapshot: Readonly<QueueSnapshot>, offset = 0, limit = 100) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid page bounds");
  return { snapshotId: snapshot.id, generatedAt: snapshot.generatedAt, counts: snapshot.counts,
    items: snapshot.items.slice(offset, offset + limit),
    nextOffset: offset + limit < snapshot.items.length ? offset + limit : null,
    coverage: snapshot.coverage, issues: snapshot.issues };
}

export interface EntityRef { system: "employee_hub" | "platform" | "ghl"; kind: "customer" | "project" | "visit" | "job"; id: string; }
export interface JobLink { visit: EntityRef; customer: EntityRef; project: EntityRef; job: EntityRef; }
const refKey = (r: EntityRef) => JSON.stringify([r.system, r.kind, r.id]);
const validRef = (r: EntityRef, kind: EntityRef["kind"]) => Boolean(r &&
  ["employee_hub", "platform", "ghl"].includes(r.system) && r.kind === kind && nonempty(r.id));
/** A source-qualified ID is not interchangeable with a PostgreSQL UUID. */
export function resolveVisitJob(visit: Omit<JobLink, "job">, links: readonly JobLink[]) {
  if (!validRef(visit.visit, "visit") || !validRef(visit.customer, "customer") || !validRef(visit.project, "project"))
    return { job: null, exception: "visit_context_invalid" } as const;
  const matches = links.filter(link => validRef(link.visit, "visit") && refKey(link.visit) === refKey(visit.visit));
  if (matches.some(link => !validRef(link.job, "job") || !validRef(link.customer, "customer") || !validRef(link.project, "project")))
    return { job: null, exception: "job_link_invalid" } as const;
  if (!matches.length) return { job: null, exception: "job_link_missing" } as const;
  if (matches.some(link => refKey(link.customer) !== refKey(visit.customer) || refKey(link.project) !== refKey(visit.project)))
    return { job: null, exception: "job_link_context_conflict" } as const;
  const jobs = new Map(matches.map(link => [refKey(link.job), link.job]));
  if (jobs.size !== 1) return { job: null, exception: "job_link_ambiguous" } as const;
  return { job: Object.freeze({ ...jobs.values().next().value! }), exception: null } as const;
}

/** Deterministic JSON only. Reject values JSON.stringify would silently drop/change. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite payload number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length)
      throw new Error("Sparse or decorated payload array");
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error("Sparse or decorated payload array");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error("Payload must be plain JSON");
  if (Object.getOwnPropertySymbols(value).length) throw new Error("Symbol payload keys unsupported");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}
export interface ApprovalSubject {
  actionId: string; revision: number; recipient: string; channel: "sms" | "email";
  payload: Json; quoteRevision: string | null; jobRevision: string | null;
  conversationWatermark: string; policyRevision: string;
  sendWindowStart: string; sendWindowEnd: string;
}
export async function approvalFingerprint(subject: ApprovalSubject): Promise<string> {
  if (!revision(subject.revision) || !nonempty(subject.actionId) || !nonempty(subject.recipient) ||
      !nonempty(subject.conversationWatermark) || !nonempty(subject.policyRevision) || !["sms", "email"].includes(subject.channel))
    throw new Error("Incomplete approval subject");
  const windowStart = milliseconds(subject.sendWindowStart, "sendWindowStart");
  const windowEnd = milliseconds(subject.sendWindowEnd, "sendWindowEnd");
  if (windowEnd <= windowStart) throw new Error("Approval send window must have positive duration");
  const encoded = canonicalJson({ actionId: subject.actionId, revision: subject.revision,
    recipient: subject.recipient, channel: subject.channel, payload: subject.payload,
    quoteRevision: subject.quoteRevision, jobRevision: subject.jobRevision,
    conversationWatermark: subject.conversationWatermark, policyRevision: subject.policyRevision,
    sendWindowStart: iso(subject.sendWindowStart, "sendWindowStart"),
    sendWindowEnd: iso(subject.sendWindowEnd, "sendWindowEnd") });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
export interface StoredApproval {
  actionId: string; revision: number; fingerprint: string; status: string;
  authenticatedActorId: string; expiresAt: Instant;
}
/** Necessary checks only, NOT sufficient authorization to send. The service must
 * load these inputs itself, recheck inside its claim transaction, and use a
 * unique execution key/outbox. A successful return never calls a provider.
 */
export function evaluateDispatchPreconditions(input: {
  now: Instant; actionId: string; revision: number; fingerprint: string;
  approval: StoredApproval | null; taskStatus: TaskStatus; executionStatus: ExecutionStatus;
  authorizationGranted: boolean; contactAllowed: boolean | null; sourcesFresh: boolean;
  dependenciesSatisfied: boolean; sendWindowStart: Instant; sendWindowEnd: Instant;
}) {
  const reasons: string[] = [];
  let now: number, start: number, end: number;
  try {
    now = milliseconds(input.now, "now");
    start = milliseconds(input.sendWindowStart, "sendWindowStart");
    end = milliseconds(input.sendWindowEnd, "sendWindowEnd");
  } catch { return { readyForAtomicClaim: false, reasons: ["invalid_time_context"] }; }
  if (end <= start || now < start || now >= end) reasons.push("outside_send_window");
  if (input.authorizationGranted !== true) reasons.push("authorization_required");
  if (input.contactAllowed !== true) reasons.push("contact_restricted_or_unknown");
  if (input.sourcesFresh !== true) reasons.push("source_context_stale");
  if (input.dependenciesSatisfied !== true) reasons.push("dependencies_unresolved");
  if (!["open", "in_progress"].includes(input.taskStatus)) reasons.push("task_not_executable");
  if (!["not_started", "queued"].includes(input.executionStatus)) reasons.push("execution_requires_reconciliation_or_is_final");
  if (!nonempty(input.actionId) || !revision(input.revision) || !/^[a-f0-9]{64}$/.test(input.fingerprint)) reasons.push("invalid_action_revision");
  const a = input.approval;
  if (!a || a.status !== "approved" || !nonempty(a.authenticatedActorId)) reasons.push("exact_approval_required");
  else {
    if (a.actionId !== input.actionId || a.revision !== input.revision || a.fingerprint !== input.fingerprint) reasons.push("approval_invalidated");
    try { if (milliseconds(a.expiresAt, "expiresAt") <= now) reasons.push("approval_expired"); }
    catch { reasons.push("approval_expired"); }
  }
  return { readyForAtomicClaim: reasons.length === 0, reasons };
}

/** Source adapter must provide strictly ascending IDs inside ONE read snapshot. */
export async function collectTaskPages(
  fetchPage: (afterId: string | null, pageSize: number) => Promise<readonly TaskInput[]>,
  pageSize = 250
): Promise<TaskInput[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("Invalid source page size");
  const rows: TaskInput[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor, pageSize);
    if (page.length > pageSize) throw new Error("Source exceeded page size");
    for (const row of page) {
      if (!nonempty(row.id) || (cursor !== null && row.id <= cursor)) throw new Error("Source pagination did not advance");
      rows.push(row);
      cursor = row.id;
    }
    if (page.length < pageSize) return rows;
  }
}
