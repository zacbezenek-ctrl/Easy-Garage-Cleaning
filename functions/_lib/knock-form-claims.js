// Shared by native intake and the offline sale validator to prevent channel stacking.
export async function formDigest(value) {
  // Firestore map field ordering is not a semantic source revision.
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const nativeHouseClaimId = async houseId => `native_house_${await formDigest(houseId)}`;
export const nativeClaimActive = claim => Boolean(claim) && claim.state !== 'released';
export const nativeClaimGeneration = claim => Number.isSafeInteger(claim?.generation) && claim.generation >= 0 ? claim.generation : 0;
