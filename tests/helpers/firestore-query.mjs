import { isDeepStrictEqual } from 'node:util';

// Evaluates the runQuery `where` subset the Hub issues (field EQUAL filters,
// optionally joined with AND) so REST fixtures honor filters as Firestore does.
export function matchesWhere(document, where) {
  if (!where) return true;
  if (where.compositeFilter) {
    if (where.compositeFilter.op !== 'AND') throw new Error(`Unsupported composite filter: ${where.compositeFilter.op}`);
    return where.compositeFilter.filters.every(filter => matchesWhere(document, filter));
  }
  const filter = where.fieldFilter;
  if (filter?.op !== 'EQUAL') throw new Error('Unsupported field filter');
  return isDeepStrictEqual(document.fields?.[filter.field.fieldPath], filter.value);
}
