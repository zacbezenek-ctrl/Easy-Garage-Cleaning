import {asRecord,EXTRACTOR_VERSION} from './core.js';
import type {CustomerProjection} from './types.js';

const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'&&v.length>0):[];

/** Coverage is evidence about extraction, not a new booking, sale, or payment.
 * Old/missing extractor versions cannot certify a cached snapshot as current. */
export function extractionCoverageComplete(coverage:unknown):boolean {
  const sources=asRecord(coverage),extraction=asRecord(sources.extraction);
  return extraction.complete===true&&extraction.version===EXTRACTOR_VERSION
    &&strings(extraction.errors).length===0&&strings(extraction.partialSourceIds).length===0
    &&strings(asRecord(sources.calls).missingTranscriptIds).length===0;
}

/** Read-safe and idempotent: qualify legacy snapshots without rewriting their
 * stored facts, event identities, next action, or business totals. */
export function qualifyExtractionCoverage(customer:CustomerProjection,coverage:unknown):CustomerProjection {
  if(extractionCoverageComplete(coverage))return customer;
  const sources=asRecord(coverage),extraction=asRecord(sources.extraction);
  const errors=strings(extraction.errors),sourceIds=[...new Set([...strings(extraction.partialSourceIds),...strings(asRecord(sources.calls).missingTranscriptIds)])];
  const reason=extraction.version!==EXTRACTOR_VERSION?'Extraction coverage is missing or uses an older extractor version.':'Some customer evidence has not been fully extracted.';
  const detail=`${reason} Review source diagnostics before treating this customer as fully reconciled.${errors.length?` Extraction errors: ${errors.join(', ')}.`:''}`;
  return {...customer,reconciliationStatus:'reconciliation_needed',humanReviewNeeded:true,
    discrepancies:[...(Array.isArray(customer.discrepancies)?customer.discrepancies:[]).filter(d=>d.code!=='extraction_incomplete'),{code:'extraction_incomplete',detail,sourceIds}]};
}
