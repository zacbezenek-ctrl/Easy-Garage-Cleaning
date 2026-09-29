/* HighLevel contact consent tags. The website lead intake writes them
   (web-lead-intake.js); the approved-send messenger only reads them: an SMS is
   never sent to a contact tagged egc-no-sms-consent (ghl-messenger.js). */
export const NO_SMS_CONSENT_TAG = 'egc-no-sms-consent';
