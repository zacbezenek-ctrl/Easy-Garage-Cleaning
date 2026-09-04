import { decodeFirestoreFields } from './firestore-job.js';

const PROJECT_ID = 'egcw-1ec83';
const DEFAULT_FIREBASE_API_KEY = 'AIzaSyA8g4UAW4P4bsCrQNZhUe81CbC7BvjJbNc';

function firebaseKey(env = {}) {
  return String(env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY);
}

export async function queryPublishedCaseStudies(env = {}, { slug = '', limit = 24 } = {}) {
  const fieldPath = slug ? 'caseStudy.slug' : 'caseStudy.status';
  const value = slug || 'published';
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery?key=${encodeURIComponent(firebaseKey(env))}`,
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
