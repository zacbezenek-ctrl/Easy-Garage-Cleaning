/* HighLevel contact tags the approved-send messenger reads but never writes
   (ghl-messenger.js). The website lead intake writes the consent tags
   (web-lead-intake.js): an SMS is never sent to a contact tagged
   egc-no-sms-consent. The owner tags staff contacts by hand: crew messages go
   only to a contact tagged egc-staff (CREW-NOTIFY). */
export const NO_SMS_CONSENT_TAG = 'egc-no-sms-consent';
// Crew messages go only to a HighLevel contact the owner tagged as staff.
export const STAFF_CONTACT_TAG = 'egc-staff';
