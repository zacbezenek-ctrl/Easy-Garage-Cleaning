// Owner-recorded visits are snapshots. No background writer may turn them into
// provider bookings, even when a contact is linked or reminders are toggled.
export const providerWritesBlocked = job => job?.ownerWalkthrough?.providerWrites === 'blocked';

export function requireProviderWritable(job) {
  if (providerWritesBlocked(job)) throw Object.assign(new Error('This walkthrough is recorded without provider writes. Review its source in Dispatch.'), {code:'schedule_owner_recording_read_only',status:409});
}
