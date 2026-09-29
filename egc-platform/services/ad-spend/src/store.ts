import { and, eq, gte, inArray, lte, min, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import type { AdSource, SpendSource } from "./config.js";
import { DENVER } from "./dates.js";
import type { DayState } from "./plan.js";
import { ProviderFailure, type SpendReport } from "./provider.js";

type Db = ReturnType<typeof getDb>;
export interface DayWrite { reportDate: string; denverDate: string; timeZoneAligned: boolean; settled: boolean }
export interface SpendWrite { source: SpendSource; accountId: string; timeZone: string; currency: string; days: DayWrite[]; report: SpendReport }
export interface LeadgenForm { formId: string; formName: string | null; byDate: ReadonlyMap<string, readonly string[]> }
export interface LeadgenWrite { pageId: string; days: DayWrite[]; forms: LeadgenForm[] }
export interface ReplaceResult { days: number; rows: number; restatedDays: number }
/** Persistence for the ingestion, injectable so the orchestration is tested without a database. */
export interface AdSpendStore {
  syncStates(source: AdSource, accountId: string, from: string, to: string): Promise<DayState[]>;
  earliestSyncDay(source: AdSource, accountId: string): Promise<string | null>;
  replaceSpend(write: SpendWrite, pulledAt: Date): Promise<ReplaceResult>;
  replaceLeadgen(write: LeadgenWrite, pulledAt: Date): Promise<ReplaceResult>;
  setCursor(key: string, value: string, at: Date): Promise<void>;
}

const BATCH = 500;
export function postgresAdSpendStore(db: Db = getDb()): AdSpendStore {
  const days = schema.adSyncDays, spend = schema.adSpendDaily, leads = schema.metaLeadgenDaily;
  // One writer per account at a time; the existing day rows are locked so a restatement
  // is detected against the committed previous pull, never a concurrent one.
  async function lockedDays(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], source: AdSource, accountId: string, dates: string[]) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ad-spend:${source}:${accountId}`},0))`);
    const rows = await tx.select().from(days).where(and(eq(days.source, source), eq(days.accountId, accountId), inArray(days.reportDate, dates))).for("update");
    return new Map(rows.map(row => [row.reportDate, row]));
  }
  return {
    async syncStates(source, accountId, from, to) {
      return db.select({ reportDate: days.reportDate, settled: days.settled }).from(days)
        .where(and(eq(days.source, source), eq(days.accountId, accountId), gte(days.reportDate, from), lte(days.reportDate, to)));
    },
    async earliestSyncDay(source, accountId) {
      const [row] = await db.select({ first: min(days.reportDate) }).from(days).where(and(eq(days.source, source), eq(days.accountId, accountId)));
      return row?.first ?? null;
    },
    async replaceSpend(write, pulledAt) {
      const dates = write.days.map(day => day.reportDate), byDate = new Map(write.days.map(day => [day.reportDate, day]));
      if (!dates.length) return { days: 0, rows: 0, restatedDays: 0 };
      return db.transaction(async tx => {
        const existing = await lockedDays(tx, write.source, write.accountId, dates);
        await tx.delete(spend).where(and(eq(spend.platform, write.source), eq(spend.accountId, write.accountId), inArray(spend.reportDate, dates)));
        const values = write.report.rows.map(row => {
          const day = byDate.get(row.reportDate);
          if (!day) throw new ProviderFailure("provider_row_out_of_range");
          return { platform: write.source, accountId: write.accountId, reportDate: row.reportDate, denverDate: day.denverDate, accountTimeZone: write.timeZone,
            level: row.level, campaignId: row.campaignId, campaignName: row.campaignName, adSetId: row.adSetId, adSetName: row.adSetName,
            currency: write.currency, spendCents: row.spendCents, impressions: row.impressions, clicks: row.clicks, pulledAt };
        });
        for (let i = 0; i < values.length; i += BATCH) await tx.insert(spend).values(values.slice(i, i + BATCH));
        let restatedDays = 0;
        for (const day of write.days) {
          const total = write.report.totals.get(day.reportDate) ?? { spendCents: 0, impressions: 0, clicks: 0 };
          const dayRows = write.report.rows.filter(row => row.reportDate === day.reportDate), prior = existing.get(day.reportDate);
          const restated = Boolean(prior && prior.totalCents !== total.spendCents);
          if (restated) restatedDays++;
          const row = { source: write.source, accountId: write.accountId, reportDate: day.reportDate, denverDate: day.denverDate, timeZone: write.timeZone,
            timeZoneAligned: day.timeZoneAligned, currency: write.currency, totalCents: total.spendCents, totalImpressions: total.impressions, totalClicks: total.clicks,
            leadCount: null, breakdownGapCents: total.spendCents - dayRows.reduce((sum, r) => sum + r.spendCents, 0), rowCount: dayRows.length,
            settled: day.settled, firstPulledAt: prior?.firstPulledAt ?? pulledAt, pulledAt, restatedAt: restated ? pulledAt : prior?.restatedAt ?? null };
          await tx.insert(days).values(row).onConflictDoUpdate({ target: [days.source, days.accountId, days.reportDate], set: row });
        }
        return { days: write.days.length, rows: values.length, restatedDays };
      });
    },
    async replaceLeadgen(write, pulledAt) {
      const dates = write.days.map(day => day.reportDate), wanted = new Set(dates);
      if (!dates.length) return { days: 0, rows: 0, restatedDays: 0 };
      return db.transaction(async tx => {
        const existing = await lockedDays(tx, "meta_leadgen", write.pageId, dates);
        await tx.delete(leads).where(and(eq(leads.pageId, write.pageId), inArray(leads.denverDate, dates)));
        const values = write.forms.flatMap(form => [...form.byDate].filter(([date, ids]) => wanted.has(date) && ids.length > 0)
          .map(([date, ids]) => ({ pageId: write.pageId, formId: form.formId, formName: form.formName, denverDate: date, leadCount: ids.length, leadIds: [...ids].sort(), pulledAt })));
        for (let i = 0; i < values.length; i += BATCH) await tx.insert(leads).values(values.slice(i, i + BATCH));
        let restatedDays = 0;
        for (const day of write.days) {
          const forms = values.filter(value => value.denverDate === day.reportDate), leadCount = forms.reduce((sum, form) => sum + form.leadCount, 0), prior = existing.get(day.reportDate);
          const restated = Boolean(prior && prior.leadCount !== leadCount);
          if (restated) restatedDays++;
          const row = { source: "meta_leadgen", accountId: write.pageId, reportDate: day.reportDate, denverDate: day.reportDate, timeZone: DENVER, timeZoneAligned: true,
            currency: null, totalCents: null, totalImpressions: null, totalClicks: null, leadCount, breakdownGapCents: null, rowCount: forms.length,
            settled: day.settled, firstPulledAt: prior?.firstPulledAt ?? pulledAt, pulledAt, restatedAt: restated ? pulledAt : prior?.restatedAt ?? null };
          await tx.insert(days).values(row).onConflictDoUpdate({ target: [days.source, days.accountId, days.reportDate], set: row });
        }
        return { days: write.days.length, rows: values.length, restatedDays };
      });
    },
    async setCursor(key, value, at) {
      await db.insert(schema.syncCursors).values({ key, cursor: value, updatedAt: at }).onConflictDoUpdate({ target: schema.syncCursors.key, set: { cursor: value, updatedAt: at } });
    }
  };
}
