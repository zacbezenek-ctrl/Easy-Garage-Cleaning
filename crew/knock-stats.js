/* Shift clock, scoreboard, plan comparison, the go/fix/stop gate and coverage.
   Pure functions over plain records so the phone and the server compute the same numbers. */
import { ANSWERED, LOOKED, isDoor } from './knock-doors.js';
import { zonedDate } from './knock-time.js';

const HOUR = 3600000;
const ms = value => (value == null ? NaN : typeof value === 'number' ? value : Date.parse(value));
const round = (value, places = 2) => Math.round(Number(value || 0) * 10 ** places) / 10 ** places;

/* A shift's effective clock at `now`. Breaks are excluded from knocking time. A shift left idle
   for idleAutoEndHours ends automatically at its last door (or its last activity if no doors). */
export function shiftTiming(shift, now = Date.now(), idleAutoEndHours = 4) {
  const startAt = ms(shift?.startedAt);
  if (!Number.isFinite(startAt)) return null;
  const breaks = (shift.breaks || [])
    .map(b => ({ startAt: ms(b.startAt), endAt: b.endAt ? ms(b.endAt) : null }))
    .filter(b => Number.isFinite(b.startAt))
    .sort((a, b) => a.startAt - b.startAt);
  const lastDoorAt = ms(shift.lastDoorAt);
  let endAt = ms(shift.endedAt), ended = Number.isFinite(endAt), autoEnded = shift.endReason === 'idle';
  if (!ended) {
    const activity = Math.max(startAt, Number.isFinite(lastDoorAt) ? lastDoorAt : startAt,
      ...breaks.map(b => b.endAt ?? b.startAt));
    if (now - activity >= idleAutoEndHours * HOUR) {
      endAt = Number.isFinite(lastDoorAt) ? lastDoorAt : activity;
      ended = true;
      autoEnded = true;
    } else {
      endAt = now;
    }
  }
  let breakMs = 0;
  for (const b of breaks) {
    const from = Math.max(b.startAt, startAt);
    const to = Math.min(b.endAt ?? endAt, endAt);
    if (to > from) breakMs += to - from;
  }
  const openBreak = !ended && breaks.some(b => b.endAt == null);
  return {
    startAt, endAt, ended, autoEnded, onBreak: openBreak, breakMs,
    knockingMs: Math.max(0, endAt - startAt - breakMs),
  };
}

/* A shift record rebuilt from its append-only events (shift.start, shift.break_start, shift.break_end,
   shift.end and knock events, any order). Voided knocks do not count as doors. */
export function deriveShift(events, shiftId) {
  const list = (events || []).filter(e => e && e.shiftId === shiftId).sort((a, b) => (ms(a.at) - ms(b.at)) || String(a.id).localeCompare(String(b.id)));
  const start = list.find(e => e.type === 'shift.start');
  if (!start) return null;
  const voided = new Set((events || []).filter(e => e.type === 'knock.void').map(e => e.target));
  const shift = {
    repKey: start.repKey, startedAt: start.at, cityKey: start.cityKey || 'fort-collins', day: start.day || '',
    breaks: [], endedAt: null, endReason: null, lastDoorAt: null, lastHouseId: null, lastNeighborhoodId: null,
    lastStreet: null, doors: 0, flags: [...(start.flags || [])],
  };
  for (const event of list) {
    if (event.type === 'shift.break_start' && !shift.breaks.some(b => !b.endAt)) shift.breaks.push({ startAt: event.at, endAt: null });
    if (event.type === 'shift.break_end') { const open = shift.breaks.find(b => !b.endAt); if (open) open.endAt = event.at; }
    if (event.type === 'shift.end' && !shift.endedAt) { shift.endedAt = event.at; shift.endReason = event.reason || 'manual'; }
    if (event.type === 'knock' && !voided.has(event.id)) {
      if (isDoor(event.outcome)) shift.doors += 1;
      shift.lastDoorAt = event.at; shift.lastHouseId = event.houseId;
      shift.lastNeighborhoodId = event.neighborhoodId || null; shift.lastStreet = event.street || null;
    }
  }
  return shift;
}

/* Counts from effective knocks: doors exclude skipped (sign) houses; answers are doors where someone
   came to the door; looks include sales (a sale needs the garage look and price first). */
export function countKnocks(knocks) {
  const totals = {
    doors: 0, answers: 0, looks: 0, sales: 0, skipped: 0, afterEnd: 0,
    car: { answers: 0, looks: 0 }, noCar: { answers: 0, looks: 0 },
  };
  for (const knock of knocks || []) {
    if (!isDoor(knock.outcome)) { totals.skipped += 1; continue; }
    totals.doors += 1;
    if (knock.afterEnd) totals.afterEnd += 1;
    if (ANSWERED.has(knock.outcome)) {
      totals.answers += 1;
      if (knock.carOutside === true) totals.car.answers += 1;
      if (knock.carOutside === false) totals.noCar.answers += 1;
    }
    if (LOOKED.has(knock.outcome)) {
      totals.looks += 1;
      if (knock.carOutside === true) totals.car.looks += 1;
      if (knock.carOutside === false) totals.noCar.looks += 1;
    }
    if (knock.outcome === 'sold') totals.sales += 1;
  }
  return totals;
}

export function emptyTotals() {
  return { knockingMs: 0, doors: 0, answers: 0, looks: 0, sales: 0, bookedRevenue: 0, skipped: 0, afterEnd: 0, car: { answers: 0, looks: 0 }, noCar: { answers: 0, looks: 0 } };
}

export function addTotals(into, more) {
  for (const key of ['knockingMs', 'doors', 'answers', 'looks', 'sales', 'bookedRevenue', 'skipped', 'afterEnd']) into[key] = (into[key] || 0) + Number(more?.[key] || 0);
  for (const side of ['car', 'noCar']) for (const key of ['answers', 'looks']) into[side][key] += Number(more?.[side]?.[key] || 0);
  return into;
}

const ratio = (a, b) => (b > 0 ? a / b : null);

export function metrics(totals) {
  const hours = (totals.knockingMs || 0) / HOUR;
  return {
    knockingHours: round(hours, 2),
    doors: totals.doors, answers: totals.answers, looks: totals.looks, sales: totals.sales,
    bookedRevenue: round(totals.bookedRevenue),
    doorsPerHour: ratio(totals.doors, hours),
    answerRate: ratio(totals.answers, totals.doors),
    lookRate: ratio(totals.looks, totals.answers),
    closeRate: ratio(totals.sales, totals.looks),
    averageTicket: ratio(totals.bookedRevenue, totals.sales),
    revenuePerHour: ratio(totals.bookedRevenue, hours),
    carLookRate: ratio(totals.car?.looks || 0, totals.car?.answers || 0),
    noCarLookRate: ratio(totals.noCar?.looks || 0, totals.noCar?.answers || 0),
  };
}

// Each metric next to the plan: { key, actual, plan, ratio } where ratio = actual / plan.
export function planComparison(m, plan) {
  return ['doorsPerHour', 'answerRate', 'lookRate', 'closeRate', 'averageTicket', 'revenuePerHour'].map(key => ({
    key, actual: m[key], plan: plan?.[key] ?? null,
    ratio: m[key] == null || !plan?.[key] ? null : m[key] / plan[key],
  }));
}

/* The gate on booked revenue per knocking hour.
   Under minimumHours: too early. Between minimumHours and decisionHours the band is provisional. */
export function gateStatus(knockingHours, revenuePerHour, gate) {
  const minimum = Number(gate?.minimumHours ?? 40);
  const decision = Number(gate?.decisionHours ?? 150);
  const go = Number(gate?.goPerHour ?? 100), fix = Number(gate?.fixPerHour ?? 70);
  if (!(knockingHours >= minimum)) return { status: 'too_early', final: false, label: 'Too early' };
  const perHour = Number(revenuePerHour || 0);
  const status = perHour >= go ? 'go' : perHour >= fix ? 'fix' : 'stop';
  const final = knockingHours >= decision;
  const label = { go: 'Go', fix: 'Fix', stop: 'Stop' }[status];
  return { status, final, label: final ? label : `${label} (provisional, under ${decision} h)` };
}

/* Scoreboard rows from day summaries ({ repKey, date, knockingMs, ...counts, byNeighborhood }).
   groupBy: 'rep' | 'team' | 'neighborhood' | 'day'. reps supply names and leads (team = lead). */
export function scoreboard(days, { groupBy = 'rep', reps = [], neighborhoods = [] } = {}) {
  const groups = new Map();
  const add = (key, label, totals) => {
    if (!groups.has(key)) groups.set(key, { key, label, totals: emptyTotals() });
    addTotals(groups.get(key).totals, totals);
  };
  const repName = key => reps.find(r => r.repKey === key)?.displayName || key;
  const leadOf = key => reps.find(r => r.repKey === key)?.leadKey || '';
  for (const day of days || []) {
    if (groupBy === 'neighborhood') {
      for (const [id, totals] of Object.entries(day.byNeighborhood || {})) {
        add(id, neighborhoods.find(n => n.id === id)?.name || id, totals);
      }
    } else if (groupBy === 'day') {
      add(day.date, day.date, day);
    } else if (groupBy === 'team') {
      const lead = leadOf(day.repKey) || (reps.find(r => r.repKey === day.repKey)?.role === 'lead' ? day.repKey : '');
      add(lead || 'no-team', lead ? `${repName(lead)}'s team` : 'No team', day);
    } else {
      add(day.repKey, repName(day.repKey), day);
    }
  }
  return [...groups.values()]
    .map(group => ({ ...group, metrics: metrics(group.totals) }))
    .sort((a, b) => groupBy === 'day' ? b.key.localeCompare(a.key) : (b.metrics.bookedRevenue - a.metrics.bookedRevenue) || a.label.localeCompare(b.label));
}

export function teamTotals(days) {
  const totals = emptyTotals();
  for (const day of days || []) addTotals(totals, day);
  return { totals, metrics: metrics(totals) };
}

/* One rep-day summary from that day's shifts, effective knocks and sales.
   Knocking time is split across neighborhoods by each shift's share of doors there. */
export function daySummary({ repKey, date, shifts = [], knocks = [], sales = [], now = Date.now(), idleAutoEndHours = 4, houses = new Map() }) {
  const summary = { repKey, date, ...emptyTotals(), byNeighborhood: {} };
  const nbhd = id => {
    if (!summary.byNeighborhood[id]) summary.byNeighborhood[id] = emptyTotals();
    return summary.byNeighborhood[id];
  };
  for (const shift of shifts) {
    const timing = shiftTiming(shift, now, idleAutoEndHours);
    if (!timing) continue;
    summary.knockingMs += timing.knockingMs;
    const shiftDoors = knocks.filter(k => k.shiftId === shift.id && isDoor(k.outcome));
    if (!shiftDoors.length) continue;
    const perNbhd = new Map();
    for (const k of shiftDoors) perNbhd.set(k.neighborhoodId || 'unknown', (perNbhd.get(k.neighborhoodId || 'unknown') || 0) + 1);
    for (const [id, count] of perNbhd) nbhd(id).knockingMs += Math.round(timing.knockingMs * count / shiftDoors.length);
  }
  const counts = countKnocks(knocks);
  addTotals(summary, { ...counts, knockingMs: 0 });
  const byId = new Map();
  for (const k of knocks) {
    const id = k.neighborhoodId || houses.get(k.houseId)?.neighborhoodId || 'unknown';
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(k);
  }
  for (const [id, list] of byId) addTotals(nbhd(id), { ...countKnocks(list), knockingMs: 0 });
  for (const sale of sales) {
    if (sale.status === 'cancelled') continue;
    summary.bookedRevenue += Number(sale.ticket || 0);
    nbhd(sale.neighborhoodId || 'unknown').bookedRevenue += Number(sale.ticket || 0);
  }
  summary.bookedRevenue = round(summary.bookedRevenue);
  return summary;
}

/* Coverage for neighborhoods and streets.
   houses: [{ id, neighborhoodId, street, excluded, noKnock, summary }]; active shifts carry
   lastNeighborhoodId/lastStreet/lastDoorAt so "here now" means a door within hereNowMinutes. */
export function coverage({ houses = [], neighborhoods = [], activeShifts = [], reps = [], now = Date.now(), hereNowMinutes = 30 }) {
  const fresh = activeShifts.filter(s => !s.endedAt && Number.isFinite(ms(s.lastDoorAt)) && now - ms(s.lastDoorAt) <= hereNowMinutes * 60000);
  const name = key => reps.find(r => r.repKey === key)?.displayName || key;
  const blank = () => ({ total: 0, knocked: 0, looks: 0, sales: 0, lastKnockedAt: null, hereNow: [] });
  const byNbhd = new Map(neighborhoods.map(n => [n.id, { id: n.id, name: n.name, ...blank(), streets: new Map() }]));
  for (const house of houses) {
    if (house.excluded || house.jurisdictionHold || house.noKnock?.source === 'city') continue;
    if (!byNbhd.has(house.neighborhoodId)) byNbhd.set(house.neighborhoodId, { id: house.neighborhoodId, name: house.neighborhoodId, ...blank(), streets: new Map() });
    const n = byNbhd.get(house.neighborhoodId);
    if (!n.streets.has(house.street)) n.streets.set(house.street, { street: house.street, ...blank() });
    const s = n.streets.get(house.street);
    for (const bucket of [n, s]) {
      bucket.total += 1;
      const summary = house.summary || {};
      if (summary.lastOutcome) bucket.knocked += 1;
      bucket.looks += Number(summary.looks || 0);
      if (summary.sold) bucket.sales += 1;
      if (summary.lastAt && (!bucket.lastKnockedAt || summary.lastAt > bucket.lastKnockedAt)) bucket.lastKnockedAt = summary.lastAt;
    }
  }
  for (const shift of fresh) {
    const n = byNbhd.get(shift.lastNeighborhoodId);
    if (!n) continue;
    if (!n.hereNow.includes(name(shift.repKey))) n.hereNow.push(name(shift.repKey));
    const s = n.streets.get(shift.lastStreet);
    if (s && !s.hereNow.includes(name(shift.repKey))) s.hereNow.push(name(shift.repKey));
  }
  return [...byNbhd.values()].map(n => ({
    ...n,
    percent: n.total ? round(n.knocked / n.total * 100, 1) : 0,
    streets: [...n.streets.values()].map(s => ({ ...s, percent: s.total ? round(s.knocked / s.total * 100, 1) : 0 }))
      .sort((a, b) => a.street.localeCompare(b.street)),
  }));
}

export const dayOf = (at, timeZone = 'America/Denver') => zonedDate(at, timeZone);
