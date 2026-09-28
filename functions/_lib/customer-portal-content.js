// Customer-facing guarantee and terms shown in the private portal. Every
// sentence is copied verbatim from what the business already publishes (the
// source is named per block) and nothing here is new legal or guarantee copy.
// Changing any text MUST bump CUSTOMER_PORTAL_TERMS_VERSION: estimate
// approvals record the version the customer was shown (P4-09), and
// tests/customer-documents.test.mjs pins the copy to this version. It is the
// portal's own version: in-person walkthrough acceptance keeps the Game Plan's
// terms_version ('2026-09-deposit50', walkthrough-handoff.js) and the Hub
// estimate keeps estimate.termsVersion; approvals add acceptedTermsVersion.
export const CUSTOMER_PORTAL_TERMS_VERSION = '2026-09-portal';
// Portal pages served before versioning send no terms_version. They showed only
// the estimate terms line (identical to 2026-09-portal's estimateTerms), never
// the guarantee or the service terms, so their approvals are recorded under
// this marker instead of the bundle version, and only while 2026-09-portal is
// current; after that a stale page must reload. Never change these values.
export const UNVERSIONED_PAGE_TERMS_VERSION = '2026-09-estimate-terms-unversioned';
const UNVERSIONED_PAGE_SHOWED = '2026-09-portal';

/** The terms version to record for a portal approval, or '' when the page showed outdated terms. */
export function approvalTermsVersion(sent, current = CUSTOMER_PORTAL_TERMS_VERSION) {
  if (sent === undefined) return current === UNVERSIONED_PAGE_SHOWED ? UNVERSIONED_PAGE_TERMS_VERSION : '';
  return typeof sent === 'string' && sent === current ? sent : '';
}

const freeze = value => Object.freeze(Array.isArray(value) ? value.map(freeze) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])) : value);

export const CUSTOMER_PORTAL_CONTENT = freeze({
  version: CUSTOMER_PORTAL_TERMS_VERSION,
  // Unchanged from the estimate terms the portal already displayed.
  estimateTerms: 'This flat-rate estimate covers the scope shown. The displayed deposit is due upfront after approval and is applied to your total. The remaining balance is due on completion. Any material change requires your approval before additional work or charges.',
  guarantee: {
    title: 'No-Surprise Quote Guarantee',
    sections: [
      { heading: 'Your quoted price', source: '/ (Our guarantee)', body: 'If the job matches the scope approved during the walkthrough, your quoted price is locked. No hourly add-ons, no "we found more than expected" fees at the end. If something unexpected comes up, we talk to you first.' },
      { heading: 'Before we leave', source: '/faq (Do you offer a guarantee?)', body: 'If you\'re not satisfied with the cleanout, tell us before we leave and we\'ll make it right on the spot. We want you to look at a cleared garage and feel good about the job — that\'s the measure of whether we did our work. If you don\'t feel that way, we haven\'t finished.' },
    ],
  },
  terms: {
    title: 'Service terms',
    url: '/terms-of-service',
    updated: '2026-09-04',
    source: '/terms-of-service',
    sections: [
      { heading: 'Quotes & Pricing', body: 'Quotes are provided as flat-rate estimates after an on-site walkthrough of the property. A final price is confirmed on site before work begins, and you only pay after approving that quote. If the actual volume, weight, access, or contents differ materially from what was described, we may adjust the quote and will review any change with you before continuing.' },
      { heading: 'Scheduling & Cancellation', body: 'We schedule service by appointment. Please give us as much notice as possible if you need to reschedule or cancel. We reserve the right to reschedule due to weather, safety conditions, crew availability, or other circumstances outside our control. You agree to provide safe and lawful access to the service location at the scheduled time.' },
      { heading: 'Payment', body: 'Payment is due upon completion of the job unless otherwise agreed in writing. We accept the payment methods communicated to you at the time of booking. You are responsible for any fees or charges associated with returned or failed payments.' },
      { heading: 'Customer Responsibilities', body: 'You represent that you own the items to be removed, or that you are authorized to have them removed and disposed of. You agree to identify anything you wish to keep before we begin — please double-check for personal documents, valuables, and keepsakes beforehand. We are not responsible for items you fail to identify as items to keep.' },
      { heading: 'Items We Do Not Accept', body: 'For safety and legal reasons, we do not haul hazardous materials, including but not limited to paint, solvents, chemicals, fuel, oil, asbestos, ammunition, or biohazardous waste. If such items are present, we may decline to remove them and will let you know how they can be disposed of properly. See our What We Take page for details.' },
      { heading: 'Donation & Disposal', body: 'Where practical, we donate or recycle usable items — including through partners such as the Habitat for Humanity ReStore — and dispose of the remainder at appropriate facilities. Once items are removed with your authorization, they become our property to donate, recycle, or dispose of at our discretion, and cannot be returned.' },
      { heading: 'Property & Liability', body: 'We take reasonable care while working on your property, and Easy Garage Cleaning is insured. To the fullest extent permitted by law, we are not liable for pre-existing conditions, damage arising from unsafe or concealed conditions, or indirect, incidental, or consequential damages. Our total liability for any claim is limited to the amount you paid for the specific service giving rise to the claim.' },
    ],
  },
});

// The portal DTO copy (sources stay server-side documentation only).
export function customerPortalDocuments() {
  const { guarantee, terms } = CUSTOMER_PORTAL_CONTENT;
  return {
    termsVersion: CUSTOMER_PORTAL_TERMS_VERSION,
    guarantee: { title: guarantee.title, sections: guarantee.sections.map(({ heading, body }) => ({ heading, body })) },
    terms: { title: terms.title, url: terms.url, updated: terms.updated, sections: terms.sections.map(({ heading, body }) => ({ heading, body })) },
    insurance: { url: '/api/customer-portal-document?kind=insurance', statusUrl: '/api/customer-portal-document?kind=insurance&view=status' },
  };
}
