"""STAFF-GATE: with EGC_STAFF_PAGE_GATE=on, signed-out visits to staff pages go to a sign-in page, signing in returns to the
refused page, and staff scripts answer 401. Runs the real middleware and /api/hub-auth through tests/browser/staff-gate-server.mjs.
Run: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome python3 tests/browser/test_staff_gate_ui.py"""
import datetime, json, os, pathlib, re, shutil, subprocess, threading, unittest
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
READY = re.compile(r'EGC staff gate server listening on (http://127\.0\.0\.1:\d+)')
NOW = datetime.datetime(2026, 9, 28, 16, tzinfo=datetime.timezone.utc)
OUT = ROOT / 'test-results' / 'staff-gate'
MANAGER = ('tylerg', 'synthetic-manager-password')
CREW = ('synthetic.crew', 'synthetic-crew-password')
PUBLIC_SHELL = ['/app-touch.css?v=20260930mobiletouch', '/crew/field-outbox.js?v=20260929crewtime2', '/crew/manifest-knock.webmanifest', '/crew/manifest.webmanifest', '/crew/offline.html']
STAFF_SHELL = ['/crew/field-expenses.css?v=20260928fun19', '/crew/field-expenses.js?v=20260929multiday', '/crew/field-payments.css?v=20260929fieldpay2', '/crew/field-payments.js?v=20260929fieldpay2', '/crew/job-photo-sharing.css?v=20260927photo', '/crew/job-photo-sharing.js?v=20260929editwipe', '/crew/job.css?v=20260930launchpolish2', '/crew/job.html', '/crew/job.js?v=20260929fieldpay2',
               # KNOCK: the canvassing page and its modules are gated and join the shell on a signed-in install.
               '/crew/knock-app.js?v=20261006knock', '/crew/knock-doors.js', '/crew/knock-leaflet.css?v=1.9.4', '/crew/knock-leaflet.js?v=1.9.4', '/crew/knock-map.js', '/crew/knock-money.js', '/crew/knock-outbox.js', '/crew/knock-rep.js', '/crew/knock-sale-rules.js', '/crew/knock-settings.js', '/crew/knock-stats.js', '/crew/knock-time.js', '/crew/knock-ui.js', '/crew/knock.css?v=20261006knock', '/crew/knock.html']
# Registers the crew worker (the job page's own registration is reused), waits until it is activated, and lists its shell cache.
WORKER_SHELL = """async () => {
  const registration = await navigator.serviceWorker.register('/crew/sw.js', { scope: '/crew/' });
  const worker = registration.installing || registration.waiting || registration.active;
  if (worker.state !== 'activated') await new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error(`The crew worker is still ${worker.state}.`)), 20000);
    worker.addEventListener('statechange', () => worker.state === 'activated' ? resolve() : worker.state === 'redundant' ? reject(new Error('The crew worker did not install.')) : null);
  });
  const names = (await caches.keys()).filter(name => name.startsWith('egc-crew-shell-')), keys = [];
  for (const name of names) for (const request of await (await caches.open(name)).keys()) { const url = new URL(request.url); keys.push(url.pathname + url.search); }
  return { names, keys: keys.sort() };
}"""
# Firebase compat SDK stand-in: EGCHubAuth.signIn only needs auth().signInWithCustomToken; Firestore stays unavailable.
FIREBASE = ("window.firebase={apps:[],initializeApp(options){const app={options};this.apps.push(app);return app},"
            "auth(){return{signInWithCustomToken:async()=>({user:{uid:'synthetic'}}),signOut:async()=>{},onAuthStateChanged(){return()=>{}},currentUser:null}}};")

class StaffGateBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which('node')
        if not node: raise RuntimeError('Node.js is required to start tests/browser/staff-gate-server.mjs.')
        cls.server = subprocess.Popen([node, str(ROOT / 'tests' / 'browser' / 'staff-gate-server.mjs')], cwd=ROOT, env={**os.environ, 'STAFF_GATE_PORT': '0'},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        timer = threading.Timer(30, cls.server.kill); timer.start()
        line = cls.server.stdout.readline(); timer.cancel()
        match = READY.search(line)
        if not match:
            cls.server.kill(); raise RuntimeError(f'staff-gate-server.mjs did not report ready: {line!r}')
        cls.url = match.group(1)
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        OUT.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.terminate(); cls.server.wait(10)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, device_scale_factor=2, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        self.page.clock.install(time=NOW)
        self.errors, self.signin_errors = [], []
        self.page.on('pageerror', lambda error: self.errors.append((urlparse(self.page.url).path, str(error))))
        self.context.route('**/*', self.route)
        self.requests = []
        self.page.on('response', lambda response: self.requests.append((urlparse(response.url).path, response.status)) if urlparse(response.url).hostname == '127.0.0.1' else None)

    def tearDown(self):
        self.assertEqual([error for path, error in self.errors if path in ('/staff-login', '/crew/')], [], 'the sign-in pages run without script errors')
        self.context.close()

    def route(self, route):
        url = urlparse(route.request.url)
        if url.hostname == 'www.gstatic.com' and url.path.startswith('/firebasejs/'):
            route.fulfill(status=200, content_type='text/javascript', body=FIREBASE if url.path.endswith('/firebase-app-compat.js') else ''); return
        if url.hostname == 'mail.example.invalid':
            route.fulfill(status=200, content_type='text/html', body=f'<!doctype html><title>Synthetic webmail</title><a id="hub" href="{self.url}/dispatch">Open dispatch</a>'); return
        if url.hostname != '127.0.0.1': route.abort(); return
        if url.path == '/api/firebase-session':
            route.fulfill(status=200, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps({'ok': True, 'token': 'synthetic-firebase-token'})); return
        route.continue_()

    def assert_mobile_form(self, page, user, password, button, targets=None):
        for width in (320, 390, 375):
            page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width, f'no horizontal scroll at {width}px')
        self.assertEqual(page.locator(user).get_attribute('autocomplete'), 'username')
        self.assertEqual(page.locator(password).get_attribute('autocomplete'), 'current-password')
        for field in (user, password):
            self.assertEqual(page.locator(field).evaluate('el => getComputedStyle(el).fontSize'), '16px', f'{field} keeps iOS from zooming')
        for target in page.locator(targets or button).all():
            self.assertGreaterEqual(target.bounding_box()['height'], 44, target.evaluate('el => el.outerHTML'))

    def sign_in(self, page, user, password, button, credentials):
        page.locator(user).fill(credentials[0]); page.locator(password).fill(credentials[1]); page.locator(button).click()

    def test_signed_out_walkthrough_goes_to_crew_sign_in_and_returns_after_sign_in(self):
        page = self.page
        page.goto(self.url + '/crew/gameplan')
        expect(page).to_have_url(self.url + '/crew/?next=%2Fcrew%2Fgameplan')
        expect(page.get_by_role('heading', name='Crew Sign-In')).to_be_visible()
        self.assert_mobile_form(page, '#gate-u', '#gate-p', '#egc-gate .gbtn')
        page.screenshot(path=str(OUT / 'crew-sign-in.png'), full_page=True)
        self.sign_in(page, '#gate-u', '#gate-p', '#egc-gate .gbtn', MANAGER)
        expect(page).to_have_url(self.url + '/crew/gameplan')
        expect(page).to_have_title('EGC · Walkthrough')
        expect(page.locator('#app')).to_be_visible()
        self.context.clear_cookies()
        page.reload()
        expect(page).to_have_url(self.url + '/crew/?next=%2Fcrew%2Fgameplan', timeout=8000)

    def test_signed_out_hub_goes_to_staff_login_and_lands_on_the_hub(self):
        page = self.page
        response = page.goto(self.url + '/employee')
        self.assertEqual(response.request.redirected_from.url, self.url + '/employee')
        self.assertEqual(response.request.redirected_from.response().status, 302)
        expect(page).to_have_url(self.url + '/staff-login?next=%2Femployee')
        expect(page.get_by_role('heading', name='Staff sign-in')).to_be_visible()
        expect(page.locator('#sl-next')).to_have_text('After signing in you will return to /employee.')
        expect(page.locator('#sl-submit')).to_be_enabled()
        self.assert_mobile_form(page, '#user', '#pass', '#sl-submit', '#staff-login button, #staff-login a, #staff-login input')
        page.screenshot(path=str(OUT / 'staff-login.png'), full_page=True)
        self.sign_in(page, '#user', '#pass', '#sl-submit', (MANAGER[0], 'not-the-password'))
        expect(page.get_by_role('alert')).to_have_text('Incorrect username or password')
        expect(page).to_have_url(self.url + '/staff-login?next=%2Femployee')
        self.sign_in(page, '#user', '#pass', '#sl-submit', CREW)
        expect(page).to_have_url(self.url + '/employee')
        self.assertIn('Employee', page.title())
        self.assertEqual(page.evaluate("fetch('/employee-suite.js').then(response => response.status)"), 200, 'the signed-in session unlocks staff scripts')
        self.context.clear_cookies()
        page.reload()
        expect(page).to_have_url(self.url + '/staff-login?next=%2Femployee')

    def test_staff_scripts_answer_401_signed_out(self):
        page = self.page
        page.goto(self.url + '/staff-login')
        status = page.evaluate("fetch('/employee-suite.js').then(response => [response.status, response.headers.get('cache-control')])")
        self.assertEqual(status, [401, 'private, no-store'])
        direct = self.context.request.get(self.url + '/employee-suite.js', max_redirects=0)
        self.assertEqual(direct.status, 401)
        self.assertEqual(direct.text(), 'Sign in required.\n')
        self.assertEqual(self.context.request.get(self.url + '/crew/gameplan-handoff.js', max_redirects=0).status, 401)

    def test_an_unsafe_next_falls_back_to_the_hub_and_the_crew_home(self):
        page = self.page
        page.goto(self.url + '/staff-login?next=' + 'https%3A%2F%2Fevil.example%2Femployee')
        expect(page.locator('#sl-next')).to_be_hidden()
        self.sign_in(page, '#user', '#pass', '#sl-submit', CREW)
        expect(page).to_have_url(self.url + '/employee')
        page.goto(self.url + '/crew/?next=%2F%2Fevil.example%2Fcrew%2Fgameplan')
        expect(page.get_by_role('heading', name='Crew Sign-In')).to_be_hidden()
        self.context.clear_cookies()
        page.goto(self.url + '/crew/?next=%2F%5Cevil.example')
        self.sign_in(page, '#gate-u', '#gate-p', '#egc-gate .gbtn', CREW)
        expect(page.locator('#egc-gate')).to_be_hidden()
        expect(page).to_have_url(self.url + '/crew/?next=%2F%5Cevil.example')

    def test_a_signed_in_viewer_following_a_link_from_another_site_continues_without_signing_in_again(self):
        page = self.page
        page.goto(self.url + '/staff-login')
        self.sign_in(page, '#user', '#pass', '#sl-submit', MANAGER)
        expect(page).to_have_url(self.url + '/employee')
        page.clock.fast_forward(11000)
        page.goto('http://mail.example.invalid/inbox')
        with page.expect_navigation(url=self.url + '/dispatch'):
            page.locator('#hub').click()
        expect(page).to_have_url(self.url + '/dispatch')
        refused = [request for request in self.requests if request[0] == '/dispatch' and request[1] == 302]
        self.assertEqual(len(refused), 1, 'the cross-site click arrived without the SameSite=Strict cookie and was sent to sign in once')

    def test_the_crew_home_explains_a_page_that_keeps_refusing_instead_of_dropping_it(self):
        page = self.page
        page.goto(self.url + '/crew/?next=%2Fcrew%2Fgameplan')
        self.sign_in(page, '#gate-u', '#gate-p', '#egc-gate .gbtn', MANAGER)
        expect(page).to_have_url(self.url + '/crew/gameplan')
        page.goto(self.url + '/crew/?next=%2Fcrew%2Fgameplan')
        expect(page.get_by_role('alert').filter(has_text='Your session could not open that page')).to_be_visible()
        expect(page).to_have_url(self.url + '/crew/?next=%2Fcrew%2Fgameplan')
        self.assertGreaterEqual(page.locator('#next-signin').bounding_box()['height'], 44)
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 375)
        page.screenshot(path=str(OUT / 'crew-next-refused.png'), full_page=True)
        page.locator('#next-signin').click()
        expect(page.get_by_role('heading', name='Crew Sign-In')).to_be_visible()
        self.sign_in(page, '#gate-u', '#gate-p', '#egc-gate .gbtn', MANAGER)
        expect(page).to_have_url(self.url + '/crew/gameplan')

    def test_the_crew_worker_installs_signed_out_with_the_public_shell_only(self):
        page = self.page
        page.goto(self.url + '/crew/offline')
        expect(page.get_by_role('heading', name='You are offline')).to_be_visible()
        self.assertEqual(page.locator('.field-header').evaluate('el => getComputedStyle(el).backgroundColor'), 'rgb(17, 29, 48)', 'the navy offline page is styled without the gated job.css')
        self.assertGreaterEqual(page.locator('.button').bounding_box()['height'], 44)
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 375)
        page.screenshot(path=str(OUT / 'crew-offline.png'), full_page=True)
        shell = page.evaluate(WORKER_SHELL)
        self.assertEqual(shell, {'names': ['egc-crew-shell-20261006knock'], 'keys': PUBLIC_SHELL}, 'the outbox import and the public shell load signed out; gated files are skipped, not fatal')
        self.assertEqual(self.context.request.get(self.url + '/crew/job.js?v=20260929fieldpay2', max_redirects=0).status, 401, 'the gated shell files were refused, not cached')

    def test_the_crew_worker_installs_signed_in_with_the_whole_shell_and_reloads_offline(self):
        page = self.page
        page.goto(self.url + '/crew/?next=%2Fcrew%2Fjob')
        self.sign_in(page, '#gate-u', '#gate-p', '#egc-gate .gbtn', CREW)
        expect(page).to_have_url(self.url + '/crew/job')
        expect(page).to_have_title("Today's work · Easy Garage Cleaning")
        shell = page.evaluate(WORKER_SHELL)
        self.assertEqual(shell, {'names': ['egc-crew-shell-20261006knock'], 'keys': sorted(PUBLIC_SHELL + STAFF_SHELL)})
        self.context.set_offline(True)
        page.reload()
        expect(page).to_have_title("Today's work · Easy Garage Cleaning")
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.field-header')).backgroundColor"), 'rgb(17, 29, 48)', 'the cached navy crew job.css loaded offline')
        self.context.set_offline(False)
        self.context.clear_cookies()
        page.goto(self.url + '/crew/job?jobId=synthetic-job-1')
        expect(page).to_have_url(self.url + '/crew/?next=%2Fcrew%2Fjob%3FjobId%3Dsynthetic-job-1')
        self.assertEqual(page.evaluate(WORKER_SHELL)['keys'], sorted(PUBLIC_SHELL + STAFF_SHELL), 'a sign-in redirect never replaces the cached job page')

if __name__ == '__main__':
    unittest.main()
