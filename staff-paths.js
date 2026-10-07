/* The ONE list of staff-only static pages and scripts. functions/_middleware.js refuses these without a Hub staff session when
   EGC_STAFF_PAGE_GATE=on, and /staff-login and /crew/ only return to a `next` that is one of them. '*' stays inside one path
   segment. A new employee-* or crew/ file must be added here or to STAFF_PUBLIC_PATHS (tests/staff-page-gate.test.mjs). */
export const STAFF_GATED_PATHS = Object.freeze([
  '/employee', '/employee.html', '/employee/', '/employee-*.js', '/employee-*.css',
  '/dispatch', '/dispatch.html',
  '/message-templates', '/message-templates.html', '/message-templates.js', '/message-templates.css',
  '/copilot', '/copilot.html',
  // Also /crew/gameplan-handoff.js, /crew/job.js|css, any /crew/job-photo-sharing.* file and the job-cost capture tool.
  // PRICE-SCRUB's walkthrough price client is loaded only by the gated game plan.
  '/crew/gameplan*', '/crew/quote-draft*', '/crew/prejob*', '/crew/postjob*', '/crew/job*', '/crew/field-expenses*', '/crew/field-payments*', '/crew/walkthrough-pricing.js', '/crew/mounting-options.js', '/crew/mounting-options.css',
  // The crew photo page, its script and stylesheet (P4-07).
  '/crew/profile-photo*',
  // Door-to-door canvassing: the knock page, its scripts, stylesheets and the bundled map library.
  '/crew/knock*',
]);

// Staff-adjacent files that stay reachable signed out: the sign-in pages and their scripts, and the crew app shell. The
// crew service worker installs and updates signed out, so it, the outbox queue it imports (no prices or pay), the offline
// page and the manifest stay public; crew/offline.html loads nothing gated. Browsers fetch a web app manifest without
// cookies, so the Hub's (names and icons only) is public too; the Hub worker, /hub-sw.js, sits outside these families.
export const STAFF_PUBLIC_PATHS = Object.freeze([
  '/staff-login', '/staff-login.html', '/staff-login.js', '/staff-paths.js',
  '/crew', '/crew/', '/crew/index.html', '/crew/hub-auth.js', '/crew/crew-brand.css',
  '/crew/manifest.webmanifest', '/crew/sw.js', '/crew/field-outbox.js', '/crew/offline', '/crew/offline.html', '/crew/sw-config.json',
  '/crew/manifest-knock.webmanifest',
  '/employee-signup', '/employee-signup.html', '/hub-login-setup', '/hub-login-setup.html', '/hub-login-setup.js',
  '/employee.webmanifest',
]);

const glob = (flags) => path => new RegExp('^' + path.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$', flags);
const GATED = STAFF_GATED_PATHS.map(glob('i'));
const EXACT = STAFF_GATED_PATHS.map(glob(''));
const NEXT_PATH = /^\/[A-Za-z0-9._/-]{0,200}$/;
const NEXT_QUERY = /^[A-Za-z0-9._~=&-]{0,300}$/;

// The raw, decoded and dot-collapsed forms of a request path, so encoded letters, separators or dot segments cannot step
// around an entry. null when the path cannot be decoded.
export function staffPathForms(pathname) {
  const raw = String(pathname || '');
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const segments = [];
  for (const segment of decoded.split(/[\\/]+/)) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  return [raw, decoded, `/${segments.join('/')}`];
}

export function staffGatedPath(pathname) {
  const forms = staffPathForms(pathname);
  return !forms || forms.some(form => GATED.some(entry => entry.test(form)));
}

// A sign-in page returns only to an exact same-origin gated path (plus a plain query): never a scheme, //, backslash,
// encoded character, dot segment or any other page. '' means "use the page's own default".
export function safeStaffNext(value) {
  if (typeof value !== 'string' || value.length > 512) return '';
  const mark = value.indexOf('?'), path = mark < 0 ? value : value.slice(0, mark), query = mark < 0 ? '' : value.slice(mark + 1);
  if (!NEXT_PATH.test(path) || path.includes('//') || /(?:^|\/)\.\.?(?:\/|$)/.test(path) || !NEXT_QUERY.test(query)) return '';
  if (!EXACT.some(entry => entry.test(path))) return '';
  return query ? `${path}?${query}` : path;
}
