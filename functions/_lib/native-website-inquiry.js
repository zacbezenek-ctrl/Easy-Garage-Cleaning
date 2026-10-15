// Verified native website form fields. Read only: this does not import leads,
// create jobs, infer consent or enable a provider workflow.
export const WEBSITE_INQUIRY_SOURCE = 'Website-EasyGarageCleaning';
const FIELDS = {
  garageSize: ['QHj6fV2cJQXHL2PNOXr1', 'egc_website_garage_size'],
  service: ['LFY6ICXlG2RKhlg0vgTT', 'egc_website_requested_service']
};
export function nativeWebsiteInquiry(contact) {
  if (contact?.source !== WEBSITE_INQUIRY_SOURCE) return null;
  const fields = Array.isArray(contact.customFields) ? contact.customFields : [];
  const result = { source: WEBSITE_INQUIRY_SOURCE };
  for (const [name, [id, key]] of Object.entries(FIELDS)) {
    const values = [...new Set(fields.filter(field => field && (field.id === id || field.key === key))
      .map(field => [field.value, field.fieldValue, field.field_value].find(value => typeof value === 'string'))
      .filter(value => typeof value === 'string' && value.trim() && value.trim().length <= 200)
      .map(value => value.trim()))];
    // Ambiguous/malformed provider values stay unfilled for staff review.
    result[name] = values.length === 1 ? values[0] : '';
  }
  return result;
}
