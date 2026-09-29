/* Seed wording in EGC's warm, professional voice. Seeds are drafts: the owner
   must approve each one in the template screen before anything can send. */
const common = ['firstName', 'companyPhone'];

export const TEMPLATE_KINDS = Object.freeze({
  on_my_way: {
    label: 'On my way', audience: 'customer', channel: 'SMS',
    variables: [...common, 'crewLeadName', 'etaMinutes'],
    body: 'Hi {{firstName}}, this is {{crewLeadName}} with Easy Garage Cleaning. Our crew is on the way and should arrive in about {{etaMinutes}} minutes. If anything has changed, just reply here. See you soon!',
  },
  day_before_reminder: {
    label: 'Day-before reminder', audience: 'customer', channel: 'SMS',
    variables: [...common, 'serviceDate', 'arrivalWindow', 'portalLink'],
    body: 'Hi {{firstName}}, a friendly reminder from Easy Garage Cleaning: we will see you {{serviceDate}} with an arrival window of {{arrivalWindow}}. Questions or changes? Call or text {{companyPhone}}.',
  },
  deposit_reminder: {
    label: 'Deposit reminder', audience: 'customer', channel: 'SMS',
    variables: [...common, 'balance', 'serviceDate', 'payLink'],
    body: 'Hi {{firstName}}, thanks again for choosing Easy Garage Cleaning! To hold your {{serviceDate}} appointment, your {{balance}} deposit can be paid securely here: {{payLink}} Questions? {{companyPhone}}',
  },
  estimate_expiring: {
    label: 'Estimate expiring', audience: 'customer', channel: 'SMS',
    variables: [...common, 'dueDate', 'portalLink'],
    body: 'Hi {{firstName}}, your Easy Garage Cleaning estimate is saved in your project portal and is good through {{dueDate}}. Review it anytime: {{portalLink}} We are happy to answer questions at {{companyPhone}}.',
  },
  review_request: {
    label: 'Review request', audience: 'customer', channel: 'SMS',
    variables: [...common, 'portalLink'],
    body: 'Hi {{firstName}}, thank you for trusting Easy Garage Cleaning with your garage! If you have a moment, a quick review would mean a lot to our local team: {{portalLink}}',
  },
  portal_magic_link: {
    label: 'Portal sign-in link', audience: 'customer', channel: 'SMS',
    variables: [...common, 'loginLink'],
    body: 'Hi {{firstName}}, here is your private Easy Garage Cleaning sign-in link: {{loginLink}} It expires soon. If you did not ask for it, you can ignore this message.',
  },
  // `required`: variables an approved version must contain (the invitation is useless without its link).
  b2b_invite: {
    label: 'Business hub invitation', audience: 'customer', channel: 'Email',
    variables: [...common, 'inviteLink'], required: ['inviteLink'],
    subject: 'Your Easy Garage Cleaning business hub invitation',
    body: 'Hi {{firstName}},\n\nYou have been invited to your company\'s Easy Garage Cleaning business hub, where you can request service, follow projects and review invoices in one place.\n\nAccept your invitation here: {{inviteLink}}\n\nThis private link expires in 48 hours. Questions? Call {{companyPhone}}.\n\nThe Easy Garage Cleaning team',
  },
  crew_assignment: {
    label: 'Crew assignment', audience: 'crew', channel: 'SMS',
    variables: ['firstName', 'serviceDate', 'arrivalWindow', 'loginLink', 'companyPhone'],
    body: 'Hi {{firstName}}, you are scheduled for an Easy Garage Cleaning job on {{serviceDate}} (arrival window {{arrivalWindow}}). Job details are in the Employee Hub: {{loginLink}}',
  },
  crew_unassignment: {
    label: 'Crew schedule removal', audience: 'crew', channel: 'SMS',
    variables: ['firstName', 'serviceDate', 'arrivalWindow', 'loginLink', 'companyPhone'],
    body: 'Hi {{firstName}}, you are no longer scheduled for the Easy Garage Cleaning job on {{serviceDate}}. Your current schedule is in the Employee Hub: {{loginLink}}',
  },
  // One text when a change both moves or adds work and takes days or hours away.
  crew_schedule_change: {
    label: 'Crew schedule change', audience: 'crew', channel: 'SMS',
    variables: ['firstName', 'serviceDate', 'arrivalWindow', 'removedDates', 'loginLink', 'companyPhone'],
    body: 'Hi {{firstName}}, your Easy Garage Cleaning schedule changed. Now: {{serviceDate}} (arrival window {{arrivalWindow}}). No longer: {{removedDates}}. Details are in the Employee Hub: {{loginLink}}',
  },
  followup: {
    label: 'Follow-up', audience: 'customer', channel: 'SMS',
    variables: [...common, 'portalLink'],
    body: 'Hi {{firstName}}, this is Easy Garage Cleaning following up on your garage project. Is there anything we can help with or any questions we can answer? Reply here or call {{companyPhone}} anytime.',
  },
});

export const TEMPLATE_KIND_IDS = Object.freeze(Object.keys(TEMPLATE_KINDS));
