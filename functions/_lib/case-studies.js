import { decodeFirestoreFields } from './firestore-job.js';
import { firestoreFetch } from './firebase-service-account.js';

const PROJECT_ID = 'egcw-1ec83';

export async function queryPublishedCaseStudies(env = {}, { slug = '', limit = 24 } = {}) {
  const fieldPath = slug ? 'caseStudy.slug' : 'caseStudy.status';
  const value = slug || 'published';
  const response = await firestoreFetch(
    env,
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'jobs' }],
          where: { fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: { stringValue: value } } },
          limit: Math.min(50, Math.max(1, Number(limit) || 24)),
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Case study lookup failed (${response.status})`);
  const rows = await response.json();
  return rows
    .filter(row => row.document?.fields)
    .map(row => ({
      id: String(row.document.name || '').split('/').pop() || '',
      ...decodeFirestoreFields(row.document.fields),
    }))
    .filter(job => job.caseStudy?.status === 'published' && job.caseStudy?.consentConfirmed === true);
}
