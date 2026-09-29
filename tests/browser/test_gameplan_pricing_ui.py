"""Phone-sized crew/gameplan.html pricing checks (PRICE-SCRUB) against a routed fake API.

The page ships no prices. It loads the walkthrough tables from /api/pricing-config after
sign-in, keeps them on the device per signed-in user and config version for an offline
walkthrough, drops them on sign-out, and shows "Pricing unavailable offline" instead of
guessing when it has neither. No production service is contacted.

FIX-CREW-PRICE-LEAK: a walkthrough signed with priced add-ons is saved through the real
/api/walkthrough-handoff and read back by crew through the real /api/field-jobs
(tests/browser/crew_scope_fixture.mjs), and the crew job page shows no amount.
"""
import json, os, pathlib, re, subprocess, threading, unittest, urllib.error, urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
VERSION = 'pc_5555555555555555'
OFFLINE = 'Pricing unavailable offline — connect once to load prices'
UNAVAILABLE = 'Prices could not be loaded from the Hub. Retry shortly or tell the office.'
CREW = {'ok': True, 'user': 'crew.one', 'displayName': 'Crew One', 'role': 'crew'}
MONEY = re.compile(r'\$\s?\d')
PROFILE = {'ok': True, 'user': 'zacb', 'displayName': 'Synthetic Owner', 'role': 'owner', 'businessAccess': True, 'owner': True, 'capabilities': ['quotes.author']}
# Stands in for the gstatic Firebase compat scripts (every external host is aborted):
# sign-in succeeds and today's walkthrough list is empty.
FIREBASE_STUB = """
window.firebase = window.firebase || {
  apps: [], initializeApp() { this.apps.push({}); },
  auth() { return { signInWithCustomToken: async () => ({}), signOut: async () => {} }; },
  firestore() { return { collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }), doc: id => ({ get: async () => ({ id, exists: false }) }) }) }; },
};
"""
AUDIT = """() => ({
  scroll: document.documentElement.scrollWidth, width: innerWidth,
  retry: [...document.querySelectorAll('button')].filter(b => /Retry loading prices/.test(b.textContent)).map(b => b.getBoundingClientRect().height),
})"""


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


class GameplanPricingBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The tables exactly as functions/_lib/pricing-config.js builds them from the catalog.
        cls.pricing = json.loads(subprocess.run(['node', '--input-type=module', '-e', "import {servedPricing} from './tests/helpers/walkthrough-pricing.mjs';console.log(JSON.stringify(servedPricing()))"], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.errors = []; self.online = True; self.signed_in = True; self.pricing_calls = 0; self.pricing_failure = None
        self.fixture_port = None; self.handoff_posts = []
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True, device_scale_factor=2)
        self.context.add_init_script(FIREBASE_STUB)
        self.context.route('**/*', self.route)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')

    def route(self, route):
        url = urlparse(route.request.url)
        if url.hostname != '127.0.0.1': route.abort(); return
        send = lambda body, status=200: route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(body))
        if url.path == '/api/hub-auth':
            if route.request.method == 'DELETE': self.signed_in = False; send({'ok': True}); return
            send(PROFILE) if self.signed_in else send({'ok': False, 'error': 'Sign in required'}, 401); return
        if url.path == '/api/firebase-session': send({'ok': True, 'token': 'synthetic-custom-token'}); return
        if url.path == '/api/pricing-config':
            self.pricing_calls += 1
            if not self.online: route.abort('internetdisconnected'); return
            if self.pricing_failure: send({'ok': False, 'code': self.pricing_failure, 'error': 'Synthetic pricing outage'}, 503); return
            self.assertEqual(url.query, 'parts=walkthrough')
            send({'ok': True, 'authority': 'employee_hub', 'version': VERSION, 'parts': {'walkthrough': self.pricing}}); return
        if self.fixture_port and url.path in ('/api/walkthrough-handoff', '/api/field-jobs'): self.forward(route, 'zacb'); return
        if self.fixture_port and url.path == '/api/highlevel': send({'ok': True, 'handoffSync': {'status': 'synced'}, 'portalInvitation': {'status': 'suppressed'}}); return
        if url.path.startswith('/api/'): send({'ok': False, 'error': 'Synthetic service unavailable'}, 503); return
        route.continue_()

    def forward(self, route, user):
        """Answers from the real Hub handlers in crew_scope_fixture.mjs as the named employee."""
        request, url = route.request, urlparse(route.request.url)
        body = request.post_data_buffer if request.method == 'POST' else None
        if body and url.path == '/api/walkthrough-handoff': self.handoff_posts.append(json.loads(body))
        target = urllib.request.Request(f'http://127.0.0.1:{self.fixture_port}{url.path}' + (f'?{url.query}' if url.query else ''), data=body, method=request.method,
            headers={'X-Fixture-User': user, 'Content-Type': request.headers.get('content-type', 'application/json')})
        try:
            with urllib.request.urlopen(target, timeout=30) as response: status, payload = response.status, response.read()
        except urllib.error.HTTPError as error: status, payload = error.code, error.read()
        route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=payload)

    def crew_route(self, route):
        url = urlparse(route.request.url)
        if url.hostname != '127.0.0.1': route.abort(); return
        send = lambda body, status=200: route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(body))
        if url.path == '/api/hub-auth': send(CREW); return
        if url.path == '/api/field-jobs': self.forward(route, 'crew.one'); return
        if url.path == '/api/employee-hub': send({'ok': True, 'user': 'crew.one', 'entry': None}); return
        if url.path.startswith('/api/'): send({'ok': False, 'error': 'Synthetic service unavailable'}, 503); return
        route.continue_()

    def open(self):
        page = self.context.new_page(); page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.clock.install(time='2026-09-22T15:00:00Z')
        page.goto(self.url + '/crew/gameplan.html'); expect(page.locator('#app')).to_be_visible()
        return page

    def screen(self, page, index, state=None):
        page.evaluate('([i, s]) => { Object.assign(S, s || {}); index = i; render(); }', [index, state or {'name': 'Synthetic Customer', 'garageSize': '1', 'fill': 'medium', 'loads': '1'}])

    def cached(self, page):
        return page.evaluate("() => Object.keys(localStorage).filter(k => k.startsWith('egc_walkthrough_pricing'))")

    def audit(self, page, where):
        result = page.evaluate(AUDIT)
        self.assertLessEqual(result['scroll'], result['width'], f'{where}: horizontal scroll')
        for height in result['retry']: self.assertGreaterEqual(height, 44, f'{where}: retry tap target')

    def test_prices_load_after_sign_in_render_from_the_tables_and_are_cached_for_this_user(self):
        page = self.open()
        page.wait_for_function('() => PRICING !== null')
        self.assertEqual(self.cached(page), [f'egc_walkthrough_pricing.v1.zacb.{VERSION}'])
        self.screen(page, 2)
        expect(page.locator('#screen')).to_contain_text('$1,000 per full truckload; partial loads are proportional.')
        expect(page.locator('#screen')).to_contain_text('Pest waste (+$200)')
        self.audit(page, 'scope')
        self.screen(page, 3)
        expect(page.locator('#screen')).to_contain_text('+$400 for a one-car garage floor.')
        expect(page.locator('#screen')).to_contain_text('+$250 · Add trap placement')
        self.screen(page, 5)
        expect(page.locator('.price-card .price')).to_have_text('$1,000')
        expect(page.locator('#screen')).not_to_contain_text('2,250')
        expect(page.locator('#signature')).to_be_visible()
        self.audit(page, 'review')
        # Offline later on the same device: the saved copy still prices the walkthrough.
        self.online = False; page.reload(); expect(page.locator('#app')).to_be_visible()
        page.wait_for_function('() => PRICING !== null')
        self.screen(page, 5)
        expect(page.locator('.price-card .price')).to_have_text('$1,000')
        # Lock (sign-out) removes the saved tables from the device.
        page.get_by_role('button', name='Lock').click()
        expect(page.locator('#gate')).to_be_visible()
        self.assertEqual(self.cached(page), [])

    def test_offline_without_saved_tables_shows_unavailable_and_recovers_when_back_online(self):
        self.online = False
        page = self.open()
        page.wait_for_function("() => PRICING_ERROR !== ''")
        self.screen(page, 5)
        expect(page.locator('.price-card [role=status]')).to_have_text(OFFLINE)
        expect(page.locator('#signature')).to_have_count(0)
        expect(page.locator('.price-card .price')).to_have_count(0)
        self.audit(page, 'review offline')
        self.screen(page, 4)
        expect(page.locator('.duration-card')).to_contain_text('Unavailable')
        expect(page.locator('.duration-card')).to_contain_text(OFFLINE)
        self.audit(page, 'schedule offline')
        self.screen(page, 2)
        expect(page.locator('#screen')).to_contain_text(OFFLINE)
        expect(page.locator('#screen')).not_to_contain_text('(+$')
        self.assertEqual(self.cached(page), [])
        self.online = True
        self.screen(page, 5)
        page.get_by_role('button', name='Retry loading prices').click()
        expect(page.locator('.price-card .price')).to_have_text('$1,000')
        self.assertEqual(self.cached(page), [f'egc_walkthrough_pricing.v1.zacb.{VERSION}'])

    def test_a_hub_outage_while_online_says_so_instead_of_claiming_the_device_is_offline(self):
        for code in ('pricing_config_unavailable', 'pricing_config_catalog_mismatch'):
            self.pricing_failure = code
            page = self.open()
            page.wait_for_function("() => PRICING_ERROR !== ''")
            self.screen(page, 5)
            expect(page.locator('.price-card [role=status]')).to_have_text(UNAVAILABLE)
            expect(page.locator('#screen')).not_to_contain_text('offline')
            expect(page.locator('#signature')).to_have_count(0)
            self.audit(page, 'review hub outage ' + code)
            self.screen(page, 4)
            expect(page.locator('.duration-card')).to_contain_text(UNAVAILABLE)
            self.assertEqual(self.cached(page), [])
        # Once the Hub recovers, a retry prices the walkthrough and caches the tables.
        self.pricing_failure = None
        self.screen(page, 5)
        page.get_by_role('button', name='Retry loading prices').click()
        expect(page.locator('.price-card .price')).to_have_text('$1,000')
        self.assertEqual(self.cached(page), [f'egc_walkthrough_pricing.v1.zacb.{VERSION}'])
        # With saved tables the same outage still prices from the device.
        self.pricing_failure = 'pricing_config_unavailable'; page.reload(); expect(page.locator('#app')).to_be_visible()
        page.wait_for_function('() => PRICING !== null')
        self.screen(page, 5)
        expect(page.locator('.price-card .price')).to_have_text('$1,000')

    def test_a_signed_walkthrough_reaches_the_crew_job_page_without_any_price(self):
        fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'crew_scope_fixture.mjs')], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (fixture.kill(), fixture.wait(), fixture.stdout.close(), fixture.stderr.close()))
        ready = fixture.stdout.readline()
        self.assertTrue(ready.startswith('READY '), ready or fixture.stderr.read())
        self.fixture_port = int(ready.split()[1])
        page = self.open()
        page.wait_for_function('() => PRICING !== null')
        # Three walkthrough photos stored on this device exactly as the Photos step keeps them.
        count = page.evaluate("""async () => { S.jobId = S.jobId || 'synthetic-draft'; const db = await dbOpen();
          await new Promise(done => { const tx = db.transaction('p', 'readwrite'); for (let i = 0; i < 3; i++) tx.objectStore('p').put({ id: 'synthetic-photo-' + i, job: S.photoDraftJobId || S.jobId, tag: 'before', dataUrl: 'data:image/jpeg;base64,/9j/', at: i }); tx.oncomplete = done; });
          await refreshPhotoCount(); return PHOTO_COUNT; }""")
        self.assertEqual(count, 3)
        # A walkthrough the homeowner signed with pest waste ($200), mouse trapping ($250) and a pressure wash ($400).
        self.screen(page, 5, {'sourceWalkthroughId': 'w1', 'name': 'Synthetic Customer', 'phone': '9705550100', 'email': 'test@example.invalid', 'address': '100 Fixture Lane', 'highlevelContactId': 'provider1',
            'whyNow': 'Moving soon', 'outcome': 'Park two cars', 'garageSize': '1', 'fill': 'medium', 'loads': '1', 'sortMethod': 'keep_donate_trash', 'truckPlacement': 'Driveway', 'hazards': ['Pest waste'],
            'finish': ['cleanout', 'pressure_wash', 'mouse_trapping'], 'keepNotes': 'Blue bicycle', 'jobDate': '2026-09-24', 'startTime': '08:00', 'endTime': '13:00', 'crewSize': '1', 'assignedTo': 'Crew One',
            'notes': 'Dog in the yard', 'signature': 'data:image/png;base64,iVBORw0KGgo=', 'approved': True, 'acceptanceAt': '2026-09-22T14:45:00.000Z', 'acceptanceBy': 'Synthetic Customer'})
        expect(page.locator('#screen')).to_contain_text('Pest waste (+$200)')
        page.get_by_role('button', name='Save brief + schedule').click()
        expect(page.locator('#send-status')).to_contain_text('Job and CRM schedule verified', timeout=20000)
        plan = self.handoff_posts[-1]['plan']
        for priced in ('Pest waste (+$200)', 'Non-toxic mouse trapping (+$250)', 'One-car garage pressure wash (+$400)'): self.assertIn(priced, plan['internal_notes'])
        self.assertTrue(plan['crew_brief'].startswith('EGC CREW JOB BRIEF'))
        self.assertIsNone(MONEY.search(plan['crew_brief']))
        job_id = page.evaluate('S.handoffJobId')
        self.assertTrue(job_id)
        # The assigned crew member opens the saved job on a phone.
        crew = self.browser.new_context(viewport={'width': 390, 'height': 844}, timezone_id='America/Los_Angeles', is_mobile=True, has_touch=True, device_scale_factor=2, service_workers='block')
        self.addCleanup(crew.close)
        crew.route('**/*', self.crew_route)
        job = crew.new_page(); job.on('pageerror', lambda error: self.errors.append(str(error)))
        job.clock.install(time='2026-09-22T15:00:00Z')
        job.goto(f'{self.url}/crew/job.html?jobId={job_id}')
        expect(job.get_by_role('heading', name='Synthetic Customer', exact=True)).to_be_visible()
        scope = job.locator('#scope-card')
        for label in ('HAZARDS: Pest waste', 'Non-toxic mouse trapping', 'One-car garage pressure wash'): expect(scope).to_contain_text(label)
        text = job.evaluate('document.body.innerText')
        self.assertIsNone(MONEY.search(text), MONEY.search(text) and text[max(0, MONEY.search(text).start() - 80):MONEY.search(text).end() + 40])
        self.assertIsNone(MONEY.search(job.evaluate('document.body.textContent')))
        # The brief wraps inside the phone (the header's long job ID is a separate, older layout issue).
        self.assertEqual(job.evaluate("() => [...document.querySelectorAll('#scope-card, #scope-card *')].filter(el => el.getBoundingClientRect().right > 391).length"), 0, 'crew brief: horizontal overflow')
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); job.screenshot(path=str(out / 'crew-job-no-prices-mobile.png'), full_page=True)

    def test_an_expired_session_removes_the_saved_tables_without_a_sign_out(self):
        page = self.open()
        page.wait_for_function('() => PRICING !== null')
        self.assertEqual(self.cached(page), [f'egc_walkthrough_pricing.v1.zacb.{VERSION}'])
        # The manager walks away without locking; the session later expires on the shared device.
        self.signed_in = False
        page.reload()
        expect(page.locator('#gate')).to_be_visible()
        self.assertEqual(self.cached(page), [])
        self.audit(page, 'gate after expiry')


if __name__ == '__main__':
    unittest.main()
