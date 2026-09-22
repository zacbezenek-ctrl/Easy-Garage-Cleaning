import { localInstant } from './operations-portal-records.js';
import { DISPATCH_TIME_ZONE } from './dispatch-contract.js';

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

// Calendar arithmetic intentionally uses UTC noon, never the process timezone.
export function addDays(date, amount) {
  if (!validDate(date) || !Number.isInteger(amount)) return null;
  return new Date(Date.parse(date + 'T12:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
}

export function denverToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: DISPATCH_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function scheduleInterval(job) {
  const date = job?.date || '', time = job?.time || '', endDate = job?.endDate || date, endTime = job?.endTime || '';
  const startAt = localInstant(date, time), endAt = localInstant(endDate, endTime);
  if (!startAt || !endAt || endAt <= startAt || Date.parse(endAt) - Date.parse(startAt) > 31 * 86400000) return null;
  return { date, time, endDate, endTime, startAt, endAt, start: Date.parse(startAt), end: Date.parse(endAt) };
}

export const overlaps = (left, right) => Boolean(left && right && left.start < right.end && right.start < left.end);

export function occupiedDays(job) {
  const interval = scheduleInterval(job);
  if (!interval) return [];
  const dates = [];
  for (let date = interval.date; date <= interval.endDate; date = addDays(date, 1)) {
    // An end at midnight releases that calendar day's capacity completely.
    if (date === interval.endDate && interval.endTime === '00:00') break;
    dates.push(date);
  }
  return dates;
}

export function availabilityInterval(block) {
  if (block?.allDay === true && validDate(block.date) && validDate(block.endDate || block.date)) {
    return scheduleInterval({ date: block.date, time: '00:00', endDate: addDays(block.endDate || block.date, 1), endTime: '00:00' });
  }
  return scheduleInterval(block);
}
