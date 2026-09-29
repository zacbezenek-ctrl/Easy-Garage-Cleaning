import type { AdSpendStore, LeadgenWrite, SpendWrite } from "../src/store.js";

export interface MemoryDay {
  source: string; accountId: string; reportDate: string; denverDate: string; timeZone: string; timeZoneAligned: boolean; currency: string | null;
  totalCents: number | null; totalImpressions: number | null; totalClicks: number | null; leadCount: number | null; breakdownGapCents: number | null;
  rowCount: number; settled: boolean; firstPulledAt: Date; pulledAt: Date; restatedAt: Date | null;
}
/** In-memory twin of postgresAdSpendStore (same replace and restatement rules) for the
 * orchestration tests; the SQL version is exercised by test/postgres.check.mjs. */
export function memoryStore() {
  const days = new Map<string, MemoryDay>(), spend: Record<string, unknown>[] = [], leads: Record<string, unknown>[] = [], cursors = new Map<string, string>();
  const key = (source: string, accountId: string, date: string) => `${source}|${accountId}|${date}`;
  const store: AdSpendStore & { days: typeof days; spend: typeof spend; leads: typeof leads; cursors: typeof cursors; writes: number } = {
    days, spend, leads, cursors, writes: 0,
    async syncStates(source, accountId, from, to) {
      return [...days.values()].filter(d => d.source === source && d.accountId === accountId && d.reportDate >= from && d.reportDate <= to).map(d => ({ reportDate: d.reportDate, settled: d.settled }));
    },
    async earliestSyncDay(source, accountId) {
      return [...days.values()].filter(d => d.source === source && d.accountId === accountId).map(d => d.reportDate).sort()[0] ?? null;
    },
    async replaceSpend(write: SpendWrite, pulledAt: Date) {
      store.writes++;
      const dates = new Set(write.days.map(d => d.reportDate)), byDate = new Map(write.days.map(d => [d.reportDate, d]));
      for (let i = spend.length - 1; i >= 0; i--) if (spend[i]!.platform === write.source && spend[i]!.accountId === write.accountId && dates.has(String(spend[i]!.reportDate))) spend.splice(i, 1);
      for (const row of write.report.rows) spend.push({ ...row, platform: write.source, accountId: write.accountId, denverDate: byDate.get(row.reportDate)!.denverDate, currency: write.currency, pulledAt });
      let restatedDays = 0;
      for (const day of write.days) {
        const total = write.report.totals.get(day.reportDate) ?? { spendCents: 0, impressions: 0, clicks: 0 }, prior = days.get(key(write.source, write.accountId, day.reportDate));
        const dayRows = write.report.rows.filter(r => r.reportDate === day.reportDate), restated = Boolean(prior && prior.totalCents !== total.spendCents);
        if (restated) restatedDays++;
        days.set(key(write.source, write.accountId, day.reportDate), { source: write.source, accountId: write.accountId, reportDate: day.reportDate, denverDate: day.denverDate,
          timeZone: write.timeZone, timeZoneAligned: day.timeZoneAligned, currency: write.currency, totalCents: total.spendCents, totalImpressions: total.impressions,
          totalClicks: total.clicks, leadCount: null, breakdownGapCents: total.spendCents - dayRows.reduce((s, r) => s + r.spendCents, 0), rowCount: dayRows.length,
          settled: day.settled, firstPulledAt: prior?.firstPulledAt ?? pulledAt, pulledAt, restatedAt: restated ? pulledAt : prior?.restatedAt ?? null });
      }
      return { days: write.days.length, rows: write.report.rows.length, restatedDays };
    },
    async replaceLeadgen(write: LeadgenWrite, pulledAt: Date) {
      store.writes++;
      const dates = new Set(write.days.map(d => d.reportDate));
      for (let i = leads.length - 1; i >= 0; i--) if (leads[i]!.pageId === write.pageId && dates.has(String(leads[i]!.denverDate))) leads.splice(i, 1);
      const values = write.forms.flatMap(form => [...form.byDate].filter(([date, ids]) => dates.has(date) && ids.length)
        .map(([date, ids]) => ({ pageId: write.pageId, formId: form.formId, formName: form.formName, denverDate: date, leadCount: ids.length, leadIds: [...ids].sort(), pulledAt })));
      leads.push(...values);
      let restatedDays = 0;
      for (const day of write.days) {
        const leadCount = values.filter(v => v.denverDate === day.reportDate).reduce((s, v) => s + v.leadCount, 0), prior = days.get(key("meta_leadgen", write.pageId, day.reportDate));
        const restated = Boolean(prior && prior.leadCount !== leadCount);
        if (restated) restatedDays++;
        days.set(key("meta_leadgen", write.pageId, day.reportDate), { source: "meta_leadgen", accountId: write.pageId, reportDate: day.reportDate, denverDate: day.reportDate,
          timeZone: "America/Denver", timeZoneAligned: true, currency: null, totalCents: null, totalImpressions: null, totalClicks: null, leadCount, breakdownGapCents: null,
          rowCount: values.filter(v => v.denverDate === day.reportDate).length, settled: day.settled, firstPulledAt: prior?.firstPulledAt ?? pulledAt, pulledAt, restatedAt: restated ? pulledAt : prior?.restatedAt ?? null });
      }
      return { days: write.days.length, rows: values.length, restatedDays };
    },
    async setCursor(name, value) { cursors.set(name, value); }
  };
  return store;
}
