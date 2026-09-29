// STAFF-ACCESS: which payroll weeks were exported. With EGC_STAFF_PASSWORD_RESET on, every payroll CSV and Gusto hours
// download records its week in the server-only payrollWeekExports collection (default-deny rules) before the file is
// handed over, and 'Apply rate to open weeks' never changes a timecard in a week recorded here as exported. The download
// reads the week's record BEFORE it reads the timecards and records the export on exactly that revision (exists:false
// when there was none), while Apply rate writes the record with the timecards in one commit fenced on the revision its
// preview saw. So whichever of the two commits second is refused: an export never lands on rates it did not read, and a
// rate never lands in a week exported from the old rates. Downloads made before the flag was on are not recorded.
export const PAYROLL_WEEK_EXPORTS = 'payrollWeekExports';
const FORMATS = ['csv', 'gusto'];

export const weekExported = row => Boolean(row) && typeof row.exportedAt === 'string' && Boolean(row.exportedAt);

/** store: {read(collection, id), commit(writes)} (dispatchStorage shape). Records one download of `format` for the week
 * starting weekStart; the first export time and who made it are kept. `current` is the week's record as read before the
 * file's timecards were (null: none yet); undefined reads it now, for a caller with nothing to fence. One attempt: a
 * record changed since `current` throws the store's dispatch_revision_conflict and the caller refuses the file. */
export async function recordPayrollWeekExport(store, { weekStart, weekEnd, format, actor, now }, current) {
  if (!FORMATS.includes(format)) throw new TypeError('Unknown payroll export format');
  if (current === undefined) current = await store.read(PAYROLL_WEEK_EXPORTS, weekStart);
  const formats = [...new Set([...(Array.isArray(current?.formats) ? current.formats.filter(item => FORMATS.includes(item)) : []), format])].sort();
  const patch = { weekStart, weekEnd, formats, exportedAt: weekExported(current) ? current.exportedAt : now, exportedBy: weekExported(current) && typeof current.exportedBy === 'string' ? current.exportedBy : actor,
    lastExportedAt: now, lastExportedBy: actor, exportCount: (Number.isInteger(current?.exportCount) ? current.exportCount : 0) + 1 };
  await store.commit([{ collection: PAYROLL_WEEK_EXPORTS, id: weekStart, ...(current ? { revision: current.revision } : {}), patch }]);
  return patch;
}
