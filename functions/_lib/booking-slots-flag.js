/* SALES-BOOKING (BOOK-25): EGC_BOOKING_EXPLICIT_SLOTS, on only for exactly "true", gates the public explicit
   walkthrough windows. On: the root middleware marks /book's time choices so booking-slots.js renders the next
   open Denver windows, /api/web-lead stores the chosen window as an explicit 'YYYY-MM-DD AM|PM' in the lead, its
   receipt and the HighLevel note, and the Zapier text-back relay gets it in words plus booking_slot_date.
   Anything else: /book keeps its static choices, and /api/web-lead, the HighLevel note and the relay are exactly
   as before. The Hub's staff booking tools do not read it (they ride EGC_STAFF_ROLE_ACCESS). */
export const bookingExplicitSlotsEnabled = env => env?.EGC_BOOKING_EXPLICIT_SLOTS === 'true';

// The attribute the middleware puts on /book's fieldset.booking-slots; booking-slots.js renders only a marked fieldset.
export const BOOKING_SLOTS_MARKER = 'data-explicit-slots';
export const BOOKING_SLOTS_PAGE = /^\/book(?:\.html)?\/?$/;

/** Whether the middleware should mark this request's page: the flag on, a GET or HEAD of /book. */
export const bookingSlotsPageRequest = (env, request, pathname) => bookingExplicitSlotsEnabled(env) && BOOKING_SLOTS_PAGE.test(pathname) && ['GET', 'HEAD'].includes(request.method);
