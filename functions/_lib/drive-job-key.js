// Google Drive limits each appProperties entry to 124 bytes of UTF-8, key and
// value together. Job ids may be up to 180 characters (fieldId), so job folders
// and files are keyed by a short digest of the exact id. The exact id is still
// stamped as egcJobId when it fits, so folders made before job keys existed
// (which carry only egcJobId) keep being found.
export const DRIVE_APP_PROPERTY_BYTES = 124;

export const driveAppPropertyFits = (key, value) =>
  new TextEncoder().encode(String(key) + String(value)).length <= DRIVE_APP_PROPERTY_BYTES;

// First 32 hex characters (128 bits) of sha256(jobId).
export async function driveJobKey(jobId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(jobId)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// appProperties for a job's Drive folder or file: always egcJobKey, plus the
// legacy egcJobId only when Drive would accept it.
export async function driveJobProperties(jobId) {
  const properties = { egcJobKey: await driveJobKey(jobId) };
  if (driveAppPropertyFits('egcJobId', jobId)) properties.egcJobId = String(jobId);
  return properties;
}
