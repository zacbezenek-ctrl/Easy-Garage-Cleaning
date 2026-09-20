import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { classifyAttribution, detectConversions, sha256, toConversionPreview, type ConversionCandidate, type ConversionLead } from "./core.js";
import { configurationHealth, conversionConfig, productionBlockers, type ConversionConfig } from "./config.js";
import { retrySafety, sendToMeta } from "./sender.js";

export interface ConversionOptions {
  days?: number; from?: string; to?: string; limit?: number;
  dryRun?: boolean; eventIds?: string[];
}
const ledger = schema.metaConversionEvents;
const DAY = 86_400_000;

function bounds(options: ConversionOptions, now = new Date()) {
  const days = options.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("invalid_lookback");
  const from = options.from ? new Date(options.from) : new Date(now.valueOf() - days * DAY);
  const to = options.to ? new Date(options.to) : now;
  const limit = options.limit ?? 100;
  if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf()) || from > to || to > now || to.valueOf() - from.valueOf() > 90 * DAY) throw new Error("invalid_date_range");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid_limit");
  if (options.eventIds && (options.eventIds.length > 100 || options.eventIds.some(id => !/^egc_[a-f0-9]{64}$/.test(id)))) throw new Error("invalid_event_ids");
  return { from, to, limit };
}

function grouped<T extends { contactId: string }>(rows: T[]) {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(row.contactId, [...(result.get(row.contactId) ?? []), row]);
  return result;
}

async function discover(options: ConversionOptions, config: ConversionConfig, now = new Date()) {
  const db = getDb();
  const range = bounds(options, now);
  // Do not restrict by lead creation: a months-old lead can legitimately book today.
  const [rows, appointments, opportunities, jobs] = await Promise.all([
    db.select({ lead: schema.leads, contact: schema.contacts }).from(schema.leads)
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.leads.contactId)),
    db.select().from(schema.appointments), db.select().from(schema.opportunities), db.select().from(schema.jobs)
  ]);
  const appointmentsByContact = grouped(appointments), opportunitiesByContact = grouped(opportunities), jobsByContact = grouped(jobs);
  const leads: ConversionLead[] = rows.map(({ lead, contact }) => ({
    leadId: lead.id, contactId: contact.id, source: lead.source, contactSource: contact.source,
    email: contact.email, phone: contact.phone, raw: contact.raw,
    country: typeof contact.raw.country === "string" ? contact.raw.country : "US",
    createdAt: lead.createdAt, providerCreatedAt: contact.providerCreatedAt, firstBookedAt: lead.firstBookedAt
  }));
  const allCandidates = leads.flatMap(lead => detectConversions({
    lead, appointments: appointmentsByContact.get(lead.contactId) ?? [],
    opportunities: opportunitiesByContact.get(lead.contactId) ?? [], jobs: jobsByContact.get(lead.contactId) ?? []
  }, { now, walkthroughCalendarIds: config.walkthroughCalendarIds, jobCalendarIds: config.jobCalendarIds,
    ...(config.startAt ? { notBefore: config.startAt } : {}) }));
  const candidates = allCandidates.filter(candidate => {
    if (options.eventIds && !options.eventIds.includes(candidate.eventId)) return false;
    if (!candidate.eventTime) return true; // Explain missing transition history instead of concealing it.
    const time = new Date(candidate.eventTime);
    return time >= range.from && time <= range.to;
  }).sort((a, b) => (a.eventTime ?? "").localeCompare(b.eventTime ?? "") || a.eventId.localeCompare(b.eventId));
  return { candidates, allCandidates, leads, range };
}

async function readiness(config: ConversionConfig) {
  const [test] = await getDb().select({ id: schema.metaConversionTests.id }).from(schema.metaConversionTests)
    .where(and(eq(schema.metaConversionTests.datasetId, config.datasetId), eq(schema.metaConversionTests.accepted, true))).limit(1);
  return productionBlockers(config, Boolean(test));
}

function publicLedger(row: typeof ledger.$inferSelect) {
  return { eventId: row.id, contactId: row.contactId, leadId: row.leadId, stage: row.eventType,
    appointmentId: row.appointmentId, jobId: row.jobId, opportunityId: row.opportunityId,
    eventTime: row.eventTime, datasetId: row.datasetId, status: row.status,
    valueCents: row.valueCents, currency: row.currency, payloadVersion: row.payloadVersion,
    attemptCount: row.attemptCount, lastAttemptAt: row.lastAttemptAt, nextAttemptAt: row.nextAttemptAt,
    acceptedAt: row.acceptedAt, error: row.error, retryable: row.retryable,
    response: row.response, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function previewConversions(options: ConversionOptions = {}) {
  const config = conversionConfig();
  const { candidates, range, leads } = await discover(options, config);
  const records = await getDb().select().from(ledger);
  const byId = new Map(records.map(row => [row.id, row]));
  const health: Record<string, number> = {};
  for (const lead of leads) {
    const created = new Date(lead.providerCreatedAt ?? lead.createdAt ?? 0);
    if (created < range.from || created > range.to) continue;
    const classification = classifyAttribution(lead).classification;
    health[classification] = (health[classification] ?? 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(), configuration: configurationHealth(config), productionBlockers: await readiness(config),
    from: range.from.toISOString(), to: range.to.toISOString(), attributionHealth: health,
    total: candidates.length, eligible: candidates.filter(c => c.eligible).length,
    alreadySynced: candidates.filter(c => byId.get(c.eventId)?.status === "accepted").length,
    truncated: candidates.length > range.limit,
    leads: leads.filter(lead => { const created = new Date(lead.providerCreatedAt ?? lead.createdAt ?? 0); return created >= range.from && created <= range.to; })
      .slice(0, range.limit).map(lead => { const { userData: _private, ...attribution } = classifyAttribution(lead); return { leadId: lead.leadId, contactId: lead.contactId, ...attribution }; }),
    events: candidates.slice(0, range.limit).map(candidate => ({ ...toConversionPreview(candidate),
      ledger: byId.has(candidate.eventId) ? publicLedger(byId.get(candidate.eventId)!) : null }))
  };
}

async function queueCandidate(candidate: ConversionCandidate, config: ConversionConfig) {
  const values = {
    id: candidate.eventId, contactId: candidate.contactId, leadId: candidate.leadId,
    appointmentId: candidate.appointmentId ?? null, jobId: candidate.jobId ?? null, opportunityId: candidate.opportunityId ?? null,
    eventType: candidate.stage, eventTime: candidate.eventTime ? new Date(candidate.eventTime) : null,
    datasetId: config.datasetId, attribution: { ...candidate.attribution }, valueCents: candidate.valueCents ?? null,
    currency: candidate.currency ?? null, payloadVersion: candidate.payloadVersion,
    payload: candidate.payload ? { ...candidate.payload } : null,
    status: candidate.eligible ? "pending" : "skipped", error: candidate.eligible ? null : candidate.reasons.join(","),
    retryable: candidate.eligible, updatedAt: new Date()
  };
  await getDb().insert(ledger).values(values).onConflictDoUpdate({
    target: ledger.id, set: values,
    setWhere: and(eq(ledger.attemptCount, 0), inArray(ledger.status, ["pending", "skipped"]))!
  });
}

/** Durable lease and immutable snapshot commit BEFORE the external request. */
async function transmit(eventId: string, config: ConversionConfig, now: Date) {
  const db = getDb();
  const claimToken = randomUUID();
  const claimed = await db.transaction(async tx => {
    const [row] = await tx.update(ledger).set({
      status: "processing", leaseToken: claimToken, leaseUntil: new Date(now.valueOf() + 120_000),
      attemptCount: sql`${ledger.attemptCount} + 1`, firstAttemptAt: sql`coalesce(${ledger.firstAttemptAt}, ${now.toISOString()}::timestamptz)`,
      lastAttemptAt: now, updatedAt: now
    }).where(and(eq(ledger.id, eventId), eq(ledger.datasetId, config.datasetId), eq(ledger.retryable, true),
      or(eq(ledger.status, "pending"), and(eq(ledger.status, "failed"), or(isNull(ledger.nextAttemptAt), lte(ledger.nextAttemptAt, now))),
        and(eq(ledger.status, "processing"), lte(ledger.leaseUntil, now))),
      or(isNull(ledger.firstAttemptAt), gte(ledger.firstAttemptAt, new Date(now.valueOf() - 47 * 3_600_000))),
      gte(ledger.eventTime, new Date(now.valueOf() - 7 * DAY)), lte(ledger.eventTime, now),
      gte(ledger.eventTime, config.startAt!)
    )).returning();
    if (row) await tx.insert(schema.metaConversionAttempts).values({ eventId, attemptNumber: row.attemptCount, startedAt: now });
    return row;
  });
  if (!claimed) return "unclaimed" as const;
  const result = await sendToMeta(claimed.payload!, config);
  const finishedAt = new Date();
  const retryable = result.retryable && claimed.attemptCount < 12;
  await db.transaction(async tx => {
    await tx.update(schema.metaConversionAttempts).set({
      finishedAt, outcome: result.accepted ? "accepted" : result.ambiguous ? "unknown" : "rejected",
      error: result.error, response: result.response
    }).where(and(eq(schema.metaConversionAttempts.eventId, eventId), eq(schema.metaConversionAttempts.attemptNumber, claimed.attemptCount)));
    await tx.update(ledger).set({
      status: result.accepted ? "accepted" : "failed", acceptedAt: result.accepted ? finishedAt : null,
      retryable, response: result.response, error: result.error,
      nextAttemptAt: retryable ? new Date(finishedAt.valueOf() + Math.min(3_600_000, 30_000 * 2 ** Math.min(claimed.attemptCount - 1, 7))) : null,
      leaseUntil: null, leaseToken: null, updatedAt: finishedAt
    }).where(result.accepted
      ? and(eq(ledger.id, eventId), eq(ledger.datasetId, config.datasetId), sql`${ledger.status} <> 'accepted'`)
      : and(eq(ledger.id, eventId), eq(ledger.leaseToken, claimToken), eq(ledger.status, "processing")));
  });
  return result.accepted ? "accepted" as const : "failed" as const;
}

async function runSync(options: ConversionOptions, retryOnly: boolean) {
  if (options.dryRun !== false) {
    const preview = await previewConversions(options);
    if (!retryOnly) return { dryRun: true, ...preview, accepted: 0, failed: 0 };
    const events = preview.events.filter(event => event.ledger?.retryable && ["failed", "processing"].includes(event.ledger.status));
    return { ...preview, dryRun: true, retryPreview: true, total: events.length, eligible: events.filter(event => event.eligible).length,
      events, accepted: 0, failed: 0, alreadySynced: 0 };
  }
  const config = conversionConfig();
  const { candidates, allCandidates, range } = await discover(options, config);
  const blockers = await readiness(config);
  // Shared DB boundary configuration lets existing API/MCP writers capture valid
  // job transitions without importing the sender or seeing any Meta credentials.
  await getDb().insert(schema.syncCursors).values({ key: "meta.conversions.job_calendar_ids", cursor: JSON.stringify(config.jobCalendarIds) })
    .onConflictDoUpdate({ target: schema.syncCursors.key, set: { cursor: JSON.stringify(config.jobCalendarIds), updatedAt: new Date() } });
  await getDb().insert(schema.syncCursors).values({ key: "meta.conversions.walkthrough_calendar_ids", cursor: JSON.stringify(config.walkthroughCalendarIds) })
    .onConflictDoUpdate({ target: schema.syncCursors.key, set: { cursor: JSON.stringify(config.walkthroughCalendarIds), updatedAt: new Date() } });
  const [run] = await getDb().insert(schema.metaConversionRuns).values({ mode: retryOnly ? "retry" : config.mode }).returning();
  try {
  const counts = { accepted: 0, skipped: 0, failed: 0, alreadySynced: 0, pending: 0 };
  if (!retryOnly) for (const candidate of candidates) await queueCandidate(candidate, config);
  const currentById = new Map(allCandidates.map(c => [c.eventId, c]));
  let rows = await getDb().select().from(ledger).orderBy(asc(ledger.createdAt));
  if (options.eventIds) rows = rows.filter(row => options.eventIds!.includes(row.id));
  rows = rows.filter(row => !row.eventTime || row.eventTime >= range.from && row.eventTime <= range.to
    || (["pending", "failed", "processing"].includes(row.status) && retrySafety(row.firstAttemptAt, row.eventTime, new Date()) !== null));
  let sent = 0;
  for (const row of rows) {
    if (row.status === "accepted") { counts.alreadySynced++; continue; }
    if (retryOnly && !["failed", "processing"].includes(row.status)) continue;
    if (row.status === "processing" && row.leaseUntil && row.leaseUntil > new Date()) { counts.pending++; continue; }
    const current = currentById.get(row.id);
    const reason = retrySafety(row.firstAttemptAt, row.eventTime, new Date())
      ?? (row.datasetId !== config.datasetId ? "destination_changed_manual_review" : null)
      ?? (!current?.eligible ? "source_no_longer_eligible" : null)
      ?? (config.startAt && row.eventTime && row.eventTime < config.startAt ? "before_production_activation" : null);
    if (reason) {
      await getDb().update(ledger).set({ status: "skipped", retryable: false, error: reason, updatedAt: new Date() })
        .where(and(eq(ledger.id, row.id), inArray(ledger.status, ["pending", "failed", "skipped", "processing"]),
          or(isNull(ledger.leaseUntil), lte(ledger.leaseUntil, new Date()))));
      counts.skipped++; continue;
    }
    if (row.status === "skipped" || !row.retryable) { counts.skipped++; continue; }
    if (blockers.length || sent >= range.limit || (row.nextAttemptAt && row.nextAttemptAt > new Date())) { counts.pending++; continue; }
    const outcome = await transmit(row.id, config, new Date());
    if (outcome === "unclaimed") counts.pending++; else { counts[outcome]++; sent++; }
  }
  const summary = { dryRun: false, mode: config.mode, productionBlockers: blockers, ...counts };
  await getDb().update(schema.metaConversionRuns).set({ finishedAt: new Date(), summary }).where(eq(schema.metaConversionRuns.id, run!.id));
  return summary;
  } catch {
    await getDb().update(schema.metaConversionRuns).set({ finishedAt: new Date(), summary: { error: "conversion_sync_incomplete" } })
      .where(eq(schema.metaConversionRuns.id, run!.id)).catch(() => undefined);
    throw new Error("conversion_sync_incomplete");
  }
}

export async function syncConversions(options: ConversionOptions = {}) { return runSync(options, false); }
export async function retryConversions(options: ConversionOptions = {}) { return runSync(options, true); }

export async function conversionStatus(options: ConversionOptions = {}) {
  const config = conversionConfig();
  const now = new Date();
  const discovery = await discover({ ...options, days: options.days ?? 30 }, config, now);
  const [records, runs, tests] = await Promise.all([
    getDb().select().from(ledger).orderBy(desc(ledger.updatedAt)),
    getDb().select().from(schema.metaConversionRuns).orderBy(desc(schema.metaConversionRuns.startedAt)).limit(1),
    getDb().select().from(schema.metaConversionTests).orderBy(desc(schema.metaConversionTests.createdAt)).limit(1)
  ]);
  const cohort = discovery.leads.filter(lead => {
    const createdAt = new Date(lead.providerCreatedAt ?? lead.createdAt ?? 0);
    return createdAt >= discovery.range.from && createdAt <= discovery.range.to;
  });
  const eligible = cohort.filter(lead => classifyAttribution(lead).classification === "eligible_meta_paid");
  const eligibleIds = new Set(eligible.map(lead => lead.leadId));
  const observed = discovery.allCandidates.filter(c => eligibleIds.has(c.leadId) && c.eventTime &&
    c.reasons.every(reason => ["verified_meta_paid_origin", "event_outside_meta_age_window", "before_production_activation"].includes(reason)));
  const booked = new Set(observed.filter(c => c.stage === "WALKTHROUGH_BOOKED").map(c => c.leadId)).size;
  const customers = new Set(observed.filter(c => c.stage === "JOB_WON").map(c => c.leadId)).size;
  const attributionHealth: Record<string, number> = {}, matchingHealth: Record<string, number> = {};
  for (const lead of cohort) {
    const a = classifyAttribution(lead);
    attributionHealth[a.classification] = (attributionHealth[a.classification] ?? 0) + 1;
    if (a.classification !== "non_meta") for (const field of a.matching.fields) matchingHealth[field] = (matchingHealth[field] ?? 0) + 1;
  }
  const counts: Record<string, number> = {};
  for (const row of records) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const accepted = records.filter(row => row.status === "accepted" && row.acceptedAt && row.acceptedAt >= discovery.range.from && row.acceptedAt <= discovery.range.to);
  return {
    generatedAt: now.toISOString(), configuration: configurationHealth(config), productionBlockers: await readiness(config),
    lastSync: runs[0] ?? null, lastTest: tests[0] ?? null, counts,
    pending: records.filter(row => ["pending", "processing"].includes(row.status)).slice(0, discovery.range.limit).map(publicLedger),
    failures: records.filter(row => row.status === "failed" || row.error?.includes("manual_review")).slice(0, discovery.range.limit).map(publicLedger),
    recentAccepted: accepted.slice(0, discovery.range.limit).map(publicLedger), attributionHealth, matchingHealth,
    cohort: { from: discovery.range.from.toISOString(), to: discovery.range.to.toISOString(), allLeads: cohort.length,
      eligibleMetaLeads: eligible.length, booked, customers, stillUnqualified: Math.max(0, eligible.length - new Set(observed.map(c => c.leadId)).size),
      walkthroughRate: eligible.length ? booked / eligible.length : null, customerRate: eligible.length ? customers / eligible.length : null,
      qualification: "Observed current legitimate stages; missing historical win timestamps are excluded." },
    transmissions: { walkthroughs: accepted.filter(r => r.eventType === "WALKTHROUGH_BOOKED").length,
      wonJobs: accepted.filter(r => r.eventType === "JOB_WON").length,
      wonValueCents: accepted.filter(r => r.eventType === "JOB_WON").reduce((sum, r) => sum + (r.valueCents ?? 0), 0), currency: "USD" }
  };
}

export async function sendTestEvent() {
  const config = conversionConfig();
  if (!config.verified || !config.accessToken || !config.testEventCode) return { accepted: false, error: "test_configuration_incomplete", configuration: configurationHealth(config) };
  const id = `egc_test_${randomUUID()}`;
  const results = [];
  for (const stage of ["WALKTHROUGH_BOOKED", "JOB_WON"]) {
    const result = await sendToMeta({
      event_name: stage, event_time: Math.floor(Date.now() / 1000), event_id: `${id}_${stage}`,
      action_source: "system_generated", user_data: { em: [sha256("egc-capi-test@example.invalid")] },
      custom_data: { event_source: "crm", lead_event_source: "EGC", ...(stage === "JOB_WON" ? { value: 1, currency: "USD" } : {}) }
    }, config, true);
    results.push({ stage, ...result });
  }
  const accepted = results.every(r => r.accepted);
  const response = { events: results.map(r => ({ stage: r.stage, ...r.response })) };
  await getDb().insert(schema.metaConversionTests).values({ id, datasetId: config.datasetId, accepted, response, error: accepted ? null : "test_event_rejected" });
  return { id, datasetId: config.datasetId, accepted, response, error: accepted ? null : "test_event_rejected", note: "Verify both events in Events Manager Test Events before enabling production." };
}
