import { and, asc, eq, gte, lt } from "drizzle-orm";
import { schema } from "@egc/database";
import { API_SOURCES, CONFIG_CURSOR, parsePublishedConfiguration, RESTATEMENT_DAYS, SOURCES, type PublishedConfiguration } from "./config.js";
import { addDays, dateRange, daysBetween, DENVER, denverDateReceivesDay, minDate, validDate, zonedDate } from "./dates.js";
import { sourceHealth } from "./health.js";
import { leadgenRetentionFloor } from "./plan.js";
import { requireSpendOwner, SpendLedgerError, type Queryable, type SpendActor } from "./ledger.js";

export type Status = "complete" | "partial" | "unknown";
export interface Part { value: number | null; status: Status; reasons: string[] }
export interface DayPart extends Part { date: string }
export interface SyncDayRecord {
  source: string; accountId: string; reportDate: string; denverDate: string; timeZone: string; timeZoneAligned: boolean;
  currency: string | null; totalCents: number | null; leadCount: number | null; settled: boolean; restatedAt: Date | null;
}
export interface EntryRecord { id: string; channel: string; amountCents: number; firstDate: string; lastDate: string }
export interface LeadFormDay { pageId: string; formId: string; formName: string | null; denverDate: string; leadCount: number }
export interface CoverageInput {
  from: string; to: string; now: Date; configuration: PublishedConfiguration | null; syncDays: SyncDayRecord[];
  entries: EntryRecord[]; entriesComplete: boolean; leadForms: LeadFormDay[]; cursors: ReadonlyMap<string, string>;
}
export const MAX_RANGE_DAYS = 400;
const ENTRY_LIMIT = 5000, GAP_LIMIT = 200;
const unique = (values: string[]) => [...new Set(values)].sort();

/** Known values add up; unknown stays null and turns the result partial, or unknown when
 * nothing is known. Reasons are kept even when complete (they carry disclosures). */
export function combine(parts: Part[]): Part {
  const known = parts.filter(part => part.value !== null);
  return { value: known.length ? known.reduce((sum, part) => sum + part.value!, 0) : null,
    status: !known.length ? "unknown" : parts.every(part => part.status === "complete") ? "complete" : "partial",
    reasons: unique(parts.flatMap(part => part.reasons)) };
}
/** Integer cents spread evenly over the entry's days; the first days take the remainder,
 * so the daily shares always sum to the attested amount exactly. */
export function allocateEntry(entry: Pick<EntryRecord, "amountCents" | "firstDate" | "lastDate">) {
  const days = daysBetween(entry.firstDate, entry.lastDate) + 1, base = Math.floor(entry.amountCents / days), extra = entry.amountCents - base * days;
  return (date: string) => { const i = daysBetween(entry.firstDate, date); return i < 0 || i >= days ? 0 : base + (i < extra ? 1 : 0); };
}

/** Per-Denver-day ad spend across API channels (provider clock) and owner-entered channels
 * (attested clock), plus Meta lead-form counts, with status and coverage on every number. */
export function computeSpendCoverage(input: CoverageInput) {
  const dates = dateRange(input.from, addDays(input.to, -1)), asOf = input.now.toISOString(), configuration = input.configuration;
  const notConnected = configuration ? "platform_not_connected" : "worker_configuration_missing";
  const gaps: { channel: string; accountId?: string; date: string; reason: string }[] = [];
  const channels: (Part & { channel: string; kind: "api" | "manual"; clockSource: "provider" | "attested"; days: DayPart[]; accounts?: unknown[]; blockers?: string[]; lastRestatedAt?: string | null; entryIds?: string[] })[] = [];
  // Keyed by account (or page) and Denver date; a non-Denver zone can map two provider days to one.
  const grouped = (source: string) => {
    const map = new Map<string, SyncDayRecord[]>();
    for (const row of input.syncDays) if (row.source === source) map.set(`${row.accountId}|${row.denverDate}`, [...(map.get(`${row.accountId}|${row.denverDate}`) ?? []), row]);
    return map;
  };
  const unknownDays = (reason: string): DayPart[] => dates.map(date => ({ date, value: null, status: "unknown", reasons: [reason] }));

  for (const source of API_SOURCES) {
    const publication = configuration?.sources[source];
    if (!publication?.active) {
      const days = unknownDays(notConnected);
      channels.push({ channel: source, kind: "api", clockSource: "provider", ...combine(days), days, accounts: [], blockers: publication?.blockers ?? [] });
      continue;
    }
    const rows = grouped(source);
    const accounts = publication.accountIds.map(accountId => {
      const zones = unique(input.syncDays.filter(row => row.source === source && row.accountId === accountId).map(row => row.timeZone));
      const days = dates.map((date): DayPart => {
        const list = rows.get(`${accountId}|${date}`) ?? [];
        // A Denver date no provider day maps to was pulled with its neighbour, not missed.
        if (!list.length) return { date, value: null, status: "unknown", reasons: [zones.length && zones.every(zone => !denverDateReceivesDay(date, zone)) ? "account_time_zone_not_denver" : "day_not_pulled"] };
        if (list.some(row => row.currency !== "USD" || row.totalCents === null)) return { date, value: null, status: "unknown", reasons: ["currency_not_usd"] };
        const reasons = [...(list.some(row => !row.settled) ? ["restatement_window"] : []), ...(list.some(row => !row.timeZoneAligned) ? ["account_time_zone_not_denver"] : [])];
        return { date, value: list.reduce((sum, row) => sum + row.totalCents!, 0), status: reasons.length ? "partial" : "complete", reasons };
      });
      for (const day of days) if (day.status === "unknown") gaps.push({ channel: source, accountId, date: day.date, reason: day.reasons[0]! });
      return { accountId, timeZones: zones, ...combine(days), days };
    });
    const days = dates.map((date, i): DayPart => ({ date, ...combine(accounts.map(account => account.days[i]!)) }));
    const restated = input.syncDays.filter(row => row.source === source && row.restatedAt).map(row => row.restatedAt!.toISOString()).sort().at(-1) ?? null;
    channels.push({ channel: source, kind: "api", clockSource: "provider", ...combine(days), days, lastRestatedAt: restated,
      accounts: accounts.map(({ days: _days, ...account }) => account) });
  }

  const byChannel = new Map<string, EntryRecord[]>();
  for (const entry of input.entries) byChannel.set(entry.channel, [...(byChannel.get(entry.channel) ?? []), entry]);
  for (const [channel, entries] of [...byChannel].sort(([a], [b]) => a.localeCompare(b))) {
    // A manual channel is expected between its first and last attested day; a hole there is
    // unknown. Outside that span the channel simply had no recorded activity.
    const first = entries.map(entry => entry.firstDate).sort()[0]!, last = entries.map(entry => entry.lastDate).sort().at(-1)!;
    const shares = entries.map(entry => ({ entry, share: allocateEntry(entry) }));
    const days = dates.filter(date => date >= first && date <= last).map((date): DayPart => {
      const covering = shares.filter(({ entry }) => entry.firstDate <= date && date <= entry.lastDate);
      if (!covering.length) { gaps.push({ channel, date, reason: "manual_entry_gap" }); return { date, value: null, status: "unknown", reasons: ["manual_entry_gap"] }; }
      return { date, value: covering.reduce((sum, { share }) => sum + share(date), 0), status: "complete", reasons: ["owner_attested"] };
    });
    if (!days.length) continue;
    const entryIds = shares.filter(({ entry }) => entry.lastDate >= input.from && entry.firstDate < input.to).map(({ entry }) => entry.id).sort();
    channels.push({ channel, kind: "manual", clockSource: "attested", ...combine(days), days, entryIds: entryIds.slice(0, 200) });
  }

  const index = channels.map(channel => new Map(channel.days.map(day => [day.date, day])));
  const days = dates.map((date): DayPart => ({ date, ...combine(index.flatMap(map => map.has(date) ? [map.get(date)!] : [])) }));
  const total = combine(days);
  if (!input.entriesComplete) { total.status = total.status === "complete" ? "partial" : total.status; total.reasons = unique([...total.reasons, "manual_entries_truncated"]); }
  const metric = { key: "ad_spend", label: "Ad spend", value: total.value, unit: "cents", currency: "USD", status: total.status, asOf,
    clockSources: unique(channels.filter(channel => channel.value !== null).map(channel => channel.clockSource)),
    coverage: { included: channels.filter(channel => channel.value !== null).map(channel => channel.channel),
      excluded: channels.filter(channel => channel.value === null).map(channel => ({ channel: channel.channel, reasons: channel.reasons })),
      reasons: total.reasons,
      disclosures: ["non_api_channels_count_only_owner_entries", "manual_spend_allocated_evenly_per_day", "ad_platform_restatements_after_settlement_not_reflected"] },
    gaps: gaps.slice(0, GAP_LIMIT), gapsTruncated: gaps.length > GAP_LIMIT };

  const lead = configuration?.sources.meta_leadgen;
  let leadgen;
  if (!lead?.active) {
    const leadDays = unknownDays(notConnected);
    leadgen = { key: "meta_leadgen_count", label: "Meta lead-form leads", unit: "count", ...combine(leadDays), asOf, pages: [], forms: [], days: leadDays };
  } else {
    const rows = grouped("meta_leadgen"), retained = leadgenRetentionFloor(zonedDate(input.now, DENVER));
    const pages = lead.accountIds.map(pageId => {
      const pageDays = dates.map((date): DayPart => {
        const row = rows.get(`${pageId}|${date}`)?.[0];
        if (!row || row.leadCount === null) return { date, value: null, status: "unknown", reasons: [date < retained ? "meta_lead_retention_exceeded" : "day_not_pulled"] };
        return { date, value: row.leadCount, status: row.settled ? "complete" : "partial", reasons: row.settled ? [] : ["restatement_window"] };
      });
      return { pageId, ...combine(pageDays), days: pageDays };
    });
    const leadDays = dates.map((date, i): DayPart => ({ date, ...combine(pages.map(page => page.days[i]!)) }));
    const forms = new Map<string, { formId: string; formName: string | null; pageId: string; count: number; days: { date: string; count: number }[] }>();
    for (const row of [...input.leadForms].sort((a, b) => a.denverDate.localeCompare(b.denverDate))) {
      const form = forms.get(row.formId) ?? { formId: row.formId, formName: row.formName, pageId: row.pageId, count: 0, days: [] };
      form.count += row.leadCount; form.days.push({ date: row.denverDate, count: row.leadCount });
      forms.set(row.formId, form);
    }
    leadgen = { key: "meta_leadgen_count", label: "Meta lead-form leads", unit: "count", ...combine(leadDays), asOf,
      pages: pages.map(({ days: _days, ...page }) => page), forms: [...forms.values()].sort((a, b) => a.formId.localeCompare(b.formId)), days: leadDays };
  }
  return { authority: "egc_platform_ad_spend", timeZone: DENVER, asOf,
    definitions: { restatementDays: RESTATEMENT_DAYS, dateBasis: "denver_date_of_provider_report_day", manualAllocation: "even_daily_integer_cents", unknown: "null_never_zero" },
    metric, channels, days, leadgen, sources: SOURCES.map(source => sourceHealth(source, configuration, input.cursors, input.now)) };
}

/** Reads one consistent snapshot (call inside a REPEATABLE READ transaction). `to` is an
 * exclusive Denver date; days after today are clipped, never reported as zero. */
export async function readSpendCoverage(tx: Queryable, actor: SpendActor, range: { from: string; to: string }, now: Date) {
  requireSpendOwner(actor);
  if (!validDate(range.from) || !validDate(range.to) || range.to <= range.from || daysBetween(range.from, range.to) > MAX_RANGE_DAYS) throw new SpendLedgerError("spend_range_invalid");
  const today = zonedDate(now, DENVER), end = minDate(range.to, addDays(today, 1))!;
  if (end <= range.from) throw new SpendLedgerError("spend_range_in_future");
  const d = schema.adSyncDays, e = schema.spendEntries, l = schema.metaLeadgenDaily, c = schema.syncCursors;
  const syncDays = await tx.select({ source: d.source, accountId: d.accountId, reportDate: d.reportDate, denverDate: d.denverDate, timeZone: d.timeZone, timeZoneAligned: d.timeZoneAligned,
    currency: d.currency, totalCents: d.totalCents, leadCount: d.leadCount, settled: d.settled, restatedAt: d.restatedAt }).from(d).where(and(gte(d.denverDate, range.from), lt(d.denverDate, end)));
  const entries = await tx.select({ id: e.id, channel: e.channel, amountCents: e.amountCents, firstDate: e.firstDate, lastDate: e.lastDate }).from(e)
    .where(and(eq(e.workspaceId, actor.workspace), eq(e.status, "active"))).orderBy(asc(e.firstDate), asc(e.id)).limit(ENTRY_LIMIT + 1);
  const leadForms = await tx.select({ pageId: l.pageId, formId: l.formId, formName: l.formName, denverDate: l.denverDate, leadCount: l.leadCount }).from(l)
    .where(and(gte(l.denverDate, range.from), lt(l.denverDate, end)));
  const cursors = new Map((await tx.select().from(c).where(and(gte(c.key, "ad_spend:"), lt(c.key, "ad_spend;")))).map(row => [row.key, row.cursor ?? ""]));
  const report = computeSpendCoverage({ from: range.from, to: end, now, configuration: parsePublishedConfiguration(cursors.get(CONFIG_CURSOR)), syncDays,
    entries: entries.slice(0, ENTRY_LIMIT), entriesComplete: entries.length <= ENTRY_LIMIT, leadForms, cursors });
  return { ok: true, ...report, period: { from: range.from, to: end, requestedTo: range.to, timeZone: DENVER, inProgress: end > today } };
}
