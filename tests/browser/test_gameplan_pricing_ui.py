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
# A quote built in the quote builder, as crew/gameplan-handoff.js keeps it on the page (builderQuoteOf): $994.56 of
# removal and 6 man-hours x $53.00 = $318.00 of labor (the owner's rate of 2026-10-19), $1,312.56.
BUILT_QUOTE = """() => { S.builderQuote = { compositePricing: { steps: ['removal'], labor: { manHours: 6 } }, totalCents: 131256, menuVersion: 'menu-v1', jobId: 'draft-1',
  lineItems: [{ id: 'removal', kind: 'service', name: 'Removal', description: '', quantity: 1, unitCents: 99456, totalCents: 99456 }, { id: 'labor', kind: 'labor', name: 'Labor', description: '', quantity: 1, unitCents: 31800, totalCents: 31800 }] }; render(); }"""
# The same quote as a builder draft saved before the pricing changes of 2026-10-18 (its Labor line named the man-hours, at
# that day's $40.00).
STALE_QUOTE = """() => { S.builderQuote.totalCents = 123456; S.builderQuote.lineItems[1] = { ...S.builderQuote.lineItems[1], name: 'Labor: 6 man-hours × $40.00', description: 'Crew time on site, billed per man-hour.', unitCents: 24000, totalCents: 24000 }; render(); }"""
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
        # LANE catalog: the builder menu exactly as GET /api/quote-draft?view=builder answers an estimator (no owner approvals).
        cls.menu = json.loads(subprocess.run(['node', '--input-type=module', '-e', "import {builderState} from './tests/helpers/estimator-fixture.mjs';import {builderMenu} from './functions/_lib/composite-quote.js';console.log(JSON.stringify({ok:true,authority:'employee_hub',enabled:true,...builderMenu(builderState())}))"], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
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
        self.fixture_port = None; self.handoff_posts = []; self.builder = False; self.menu_calls = 0; self.menu_down = False; self.menu_held = None
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
            send({'ok': True, 'authority': 'employee_hub', 'version': VERSION, 'parts': {'walkthrough': self.pricing}, **({'quoteBuilder': True} if self.builder else {})}); return
        if url.path == '/api/quote-draft' and url.query == 'view=builder' and self.builder:
            self.menu_calls += 1
            if not self.online or self.menu_down: route.abort('internetdisconnected'); return
            # A slow connection: the test answers the held request later.
            if self.menu_held is not None: self.menu_held.append(lambda: send(self.menu)); return
            send(self.menu); return
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

    def test_customer_request_is_readable_on_phone_without_replacing_staff_notes(self):
        page = self.open()
        page.evaluate("""() => {
            APPTS = [{id:'qa-walkthrough', customer:'Synthetic Customer', phone:'2025550150',
                customerInstructions:'Website inquiry\\nGarage size: 3-car or larger\\nRequested service: Organization <img src=x>'}];
            useAppointment(0);
            S.notes = 'Staff-only estimating note'; render();
        }""")
        panel = page.get_by_role('region', name='Customer request', exact=True)
        expect(panel).to_contain_text('3-car or larger')
        expect(panel).to_contain_text('Organization <img src=x>')
        expect(panel.locator('img')).to_have_count(0)
        expect(panel).not_to_contain_text('Staff-only estimating note')
        self.assertEqual(page.evaluate('S.notes'), 'Staff-only estimating note')
        self.assertEqual(page.evaluate('S.garageSize'), '2')
        self.audit(page, 'customer request')

    def test_prices_load_after_sign_in_render_from_the_tables_and_are_cached_for_this_user(self):
        page = self.open()
        page.wait_for_function('() => PRICING !== null')
        self.assertEqual(self.cached(page), [f'egc_walkthrough_pricing.v1.zacb.{VERSION}'])
        self.screen(page, 2)
        expect(page.locator('#screen')).to_contain_text('$950 per full truckload; partial loads are proportional.')
        expect(page.locator('#screen')).to_contain_text('Pest waste (+$300)')
        self.audit(page, 'scope')
        self.screen(page, 3)
        expect(page.locator('#screen')).to_contain_text('+$600 for a one-car garage floor.')
        expect(page.locator('#screen')).to_contain_text('+$375 · Add trap placement')
        self.screen(page, 5)
        expect(page.locator('.price-card .price')).to_have_text('$950')
        expect(page.locator('#screen')).not_to_contain_text('2,250')
        expect(page.locator('#signature')).to_be_visible()
        # D-DEPOSIT: 25% when the homeowner signs and 75% on the job day, with both amounts.
        expect(page.locator('#deposit-summary')).to_have_text('25% deposit due today: $237.50. Remaining 75% due on the job day: $712.50.')
        expect(page.locator('label[for=approved]')).to_contain_text('a 25% deposit due today with the remaining 75% due on the job day')
        self.audit(page, 'review')
        # Offline later on the same device: the saved copy still prices the walkthrough.
        self.online = False; page.reload(); expect(page.locator('#app')).to_be_visible()
        page.wait_for_function('() => PRICING !== null')
        self.screen(page, 5)
        expect(page.locator('.price-card .price')).to_have_text('$950')
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
        expect(page.locator('.price-card .price')).to_have_text('$950')
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
        expect(page.locator('.price-card .price')).to_have_text('$950')
        self.assertEqual(self.cached(page), [f'egc_walkthrough_pricing.v1.zacb.{VERSION}'])
        # With saved tables the same outage still prices from the device.
        self.pricing_failure = 'pricing_config_unavailable'; page.reload(); expect(page.locator('#app')).to_be_visible()
        page.wait_for_function('() => PRICING !== null')
        self.screen(page, 5)
        expect(page.locator('.price-card .price')).to_have_text('$950')

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
        # A walkthrough the homeowner signed with pest waste ($300), mouse trapping ($375) and a pressure wash ($600).
        self.screen(page, 5, {'sourceWalkthroughId': 'w1', 'name': 'Synthetic Customer', 'phone': '9705550100', 'email': 'test@example.invalid', 'address': '100 Fixture Lane', 'highlevelContactId': 'provider1',
            'whyNow': 'Moving soon', 'outcome': 'Park two cars', 'garageSize': '1', 'fill': 'medium', 'loads': '1', 'sortMethod': 'keep_donate_trash', 'truckPlacement': 'Driveway', 'hazards': ['Pest waste'],
            'finish': ['cleanout', 'pressure_wash', 'mouse_trapping'], 'keepNotes': 'Blue bicycle', 'jobDate': '2026-09-24', 'startTime': '08:00', 'endTime': '13:00', 'crewSize': '1', 'assignedTo': 'Crew One',
            'notes': 'Dog in the yard', 'signature': 'data:image/png;base64,iVBORw0KGgo=', 'approved': True, 'acceptanceAt': '2026-09-22T14:45:00.000Z', 'acceptanceBy': 'Synthetic Customer'})
        expect(page.locator('#screen')).to_contain_text('Pest waste (+$300)')
        expect(page.locator('#deposit-summary')).to_have_text('25% deposit due today: $556.25. Remaining 75% due on the job day (Thu, Sep 24): $1668.75.')
        page.get_by_role('button', name='Save brief + schedule').click()
        expect(page.locator('#send-status')).to_contain_text('Job and CRM schedule verified', timeout=20000)
        plan = self.handoff_posts[-1]['plan']
        # D-DEPOSIT: the real handoff accepted the 25% deposit on the current terms.
        self.assertEqual([plan['terms_version'], plan['acceptance']['terms_version'], plan['quote']['total'], plan['quote']['deposit']], ['2026-10-deposit25', '2026-10-deposit25', 2225, 556.25])
        for priced in ('Pest waste (+$300)', 'Non-toxic mouse trapping (+$375)', 'One-car garage pressure wash (+$600)'): self.assertIn(priced, plan['internal_notes'])
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

    def test_with_the_quote_builder_on_review_has_no_flat_rate_and_signing_waits_for_the_builder_total(self):
        # D-SIGN: the Hub says the quote builder is on (EGC_QUOTE_BUILDER_ENABLED: quoteBuilder in the pricing answer).
        self.builder = True
        page = self.open()
        page.wait_for_function('() => PRICING !== null && quoteBuilderOn()')
        self.screen(page, 5, {'name': 'Synthetic Customer', 'garageSize': '1', 'fill': 'medium', 'loads': '1', 'jobDate': '2026-09-24', 'startTime': '08:00', 'endTime': '11:00'})
        screen = page.locator('#screen')
        for hidden in ('Recommended flat rate', 'Final flat rate', 'Truckload pricing uses', '$950'): expect(screen).not_to_contain_text(hidden)
        for missing in ('#locked-price', '#approved', '#signature', '#deposit-summary'): expect(page.locator(missing)).to_have_count(0)
        expect(page.locator('.price-card .eyebrow')).to_have_text('Quote builder total')
        expect(page.locator('#builder-total-missing')).to_have_text('Not built')
        expect(page.get_by_role('button', name='Build the quote')).to_be_visible()
        expect(page.get_by_role('button', name='Save brief + schedule')).to_be_disabled()
        self.audit(page, 'review, builder on, not built')
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); page.screenshot(path=str(out / 'gameplan-review-builder-not-built-mobile.png'), full_page=True)
        # The estimator built the quote (Build the quote saves it and hands the page its total): the homeowner signs that total.
        page.evaluate(BUILT_QUOTE)
        expect(page.locator('.price-card .eyebrow')).to_have_text('Quote builder total')
        expect(page.locator('.price-card .price')).to_have_text('$1312.56')
        for hidden in ('Recommended flat rate', 'Final flat rate'): expect(screen).not_to_contain_text(hidden)
        expect(page.locator('#locked-price')).to_have_count(0)
        expect(page.locator('#signature')).to_be_visible()
        expect(page.locator('#deposit-summary')).to_have_text('25% deposit due today: $328.14. Remaining 75% due on the job day (Thu, Sep 24): $984.42.')
        expect(page.get_by_role('button', name='Save brief + schedule')).to_be_enabled()
        self.audit(page, 'review, builder on, built')
        page.screenshot(path=str(out / 'gameplan-review-builder-mobile.png'), full_page=True)
        # Review: a quote built before the pricing changes is not signed; the estimator edits and saves it again first.
        page.evaluate(STALE_QUOTE)
        expect(page.get_by_role('button', name='Edit the quote')).to_be_visible()
        expect(page.locator('#builder-sign-gate')).to_contain_text('built before the pricing changes of 2026-10-18')
        for missing in ('#approved', '#signature', '#deposit-summary'): expect(page.locator(missing)).to_have_count(0)
        expect(page.locator('#builder-total-blocked')).to_have_text('Not ready')
        expect(page.get_by_role('button', name='Save brief + schedule')).to_be_disabled()
        expect(screen).not_to_contain_text('man-hour')
        self.audit(page, 'review, builder on, stale quote')

    def test_with_the_quote_builder_on_scope_and_finish_show_the_builder_menu_and_finish_picks_its_products(self):
        # LANE catalog: the walkthrough shows the prices the quote is built and signed from, each with its chip.
        self.builder = True
        page = self.open()
        page.wait_for_function('() => PRICING !== null && quoteBuilderOn() && EGCGameplanCatalog.menu() !== null')
        self.assertEqual(self.menu_calls, 1, 'the builder menu is read once')
        self.screen(page, 2, {'name': 'Synthetic Customer', 'garageSize': '1', 'fill': 'medium', 'loads': '1.25', 'hazards': ['Pest waste'], 'special': ['Mattress'], 'access': ['Stairs']})
        screen = page.locator('#screen')
        for shown in ('Full truck load $1,000.00 Approved', 'Three-quarter load $750.00 Draft price', 'Half load $500.00 Draft price', 'Quarter load $250.00 Draft price',
                      'Mattress +$70.00 Draft price', 'Pest waste +$300.00 Draft price', 'Stairs +$190.00 Draft price', 'Long carry +$115.00 Draft price'):
            expect(screen).to_contain_text(shown)
        for legacy in ('$950', 'per full truckload', '(+$'): expect(screen).not_to_contain_text(legacy)
        loads = page.locator('#f-loads')
        self.assertEqual([loads.get_attribute('min'), loads.get_attribute('step')], ['0.25', '0.25'], 'quarter loads')
        loads.fill('0.75')
        self.assertEqual(page.evaluate('S.loads'), '0.75')
        self.assertTrue(page.evaluate("document.getElementById('f-loads').checkValidity()"), 'a quarter step is a valid entry')
        self.audit(page, 'scope, builder prices')
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); page.screenshot(path=str(out / 'gameplan-scope-builder-prices-mobile.png'), full_page=True)
        # Finish: the cleaning add-ons at the builder's prices, and the builder's own shelving, totes and storage.
        self.screen(page, 3, {'garageSize': '1', 'finish': ['cleanout', 'deep_clean', 'pressure_wash', 'mouse_trapping']})
        for shown in ('$190.00 Draft price', '+$600.00 Draft price', '+$375.00 Draft price'): expect(screen).to_contain_text(shown)
        for legacy in ('+$600 for a one-car', '+$375 ·', 'Add shelving', 'Add labeled totes'): expect(screen).not_to_contain_text(legacy)
        expect(page.locator('#mounting-options')).to_have_count(0)
        goods = page.locator('#finish-goods')
        expect(goods).to_contain_text('Shelving, totes and storage')
        expect(goods).to_contain_text('No shelving, totes or storage yet.')
        goods.get_by_label('Search shelving and storage products').fill('HDX plastic shelving')
        expect(goods.get_by_role('button', name='Add HDX plastic shelving, 36×72×24')).to_be_visible()
        expect(goods).to_contain_text('36 W × 72 H × 24 D in')
        goods.get_by_role('button', name='Add HDX plastic shelving, 36×72×24').click()
        expect(goods).to_contain_text('In this quote (1)')
        goods.get_by_role('button', name='One more: HDX plastic shelving, 36×72×24').click()
        goods.get_by_label('Search shelving and storage products').fill('')
        goods.get_by_label('Product group').select_option('bins-totes')
        first_tote = page.evaluate("EGCGameplanCatalog.menu().products.find(item => item.group === 'bins-totes').name")
        goods.get_by_role('button', name=f'Add {first_tote}').click()
        expect(goods).to_contain_text('In this quote (2)')
        expect(goods.locator('a')).to_have_count(0)
        picks = page.evaluate('S.builderGoods')
        self.assertEqual(picks['by'], 'finish')
        self.assertEqual([(row['id'], row['quantity'], row['group']) for row in picks['shelving']], [('hd-100006678', 2, 'shelving')])
        self.assertEqual([(row['quantity'], row['group']) for row in picks['storage']], [(1, 'bins-totes')])
        self.assertEqual(page.evaluate('EGCGameplanCatalog.selection()'), {'shelving': [{'id': 'hd-100006678', 'quantity': 2}], 'storage': [{'id': picks['storage'][0]['id'], 'quantity': 1}]})
        bring = page.evaluate('buildJobInstructions({}).bringList')
        for kit in ('Drill / driver', 'Stud finder', 'Level', 'Lag screws and anchors', 'Label maker'): self.assertIn(kit, bring)
        self.audit(page, 'finish, builder products')
        page.screenshot(path=str(out / 'gameplan-finish-builder-products-mobile.png'), full_page=True)
        # Review: before the quote is built, the summary names the Finish picks (LANE catalog review).
        self.screen(page, 5, {'jobDate': '2026-09-24', 'startTime': '08:00', 'endTime': '11:00'})
        expect(page.locator('#review-finish')).to_contain_text(f'HDX plastic shelving, 36×72×24 × 2, {first_tote} × 1')
        # A quote built without the Finish picks is not signed until it is edited and saved with them.
        page.evaluate(BUILT_QUOTE)
        expect(page.locator('#builder-sign-gate')).to_contain_text('The shelving, totes and storage chosen on Finish changed since this quote was built.')
        expect(page.get_by_role('button', name='Edit the quote')).to_be_visible()
        for missing in ('#approved', '#signature', '#deposit-summary'): expect(page.locator(missing)).to_have_count(0)
        expect(page.get_by_role('button', name='Save brief + schedule')).to_be_disabled()
        expect(screen).not_to_contain_text('(+$')
        # The same picks in the built quote: the homeowner signs it.
        page.evaluate("() => { S.builderQuote.compositePricing = { ...S.builderQuote.compositePricing, shelving: S.builderGoods.shelving.map(({id, quantity}) => ({id, quantity})), storage: S.builderGoods.storage.map(({id, quantity}) => ({id, quantity})) }; render(); }")
        expect(page.locator('#signature')).to_be_visible()
        self.audit(page, 'review, builder on, Finish picks in the quote')

    def test_with_the_quote_builder_on_the_parking_fit_check_counts_the_finish_picks_before_any_quote(self):
        # Integration review (2026-10-21): shelving and an overhead rack picked from the builder's products on Finish count
        # in the parking fit check right below them at once, not only after the quote is built and saved; and the product
        # list shows once searched or grouped, so the vehicles panel is not several phone screens down.
        self.builder = True
        page = self.open()
        page.wait_for_function('() => PRICING !== null && quoteBuilderOn() && EGCGameplanCatalog.menu() !== null && window.EGCGameplanVehicles')
        page.evaluate("""() => { Object.assign(S, { name: 'Synthetic Customer', garageSize: '2', fill: 'medium', loads: '1', garageMeasure: { width: '19 ft 6', depth: '21 ft' },
          customerVehicles: [EGCGameplanVehicles.fromMeasure({ name: 'Synthetic pickup', length: '232', width: '80', height: '76', basis: 'truck' }), EGCGameplanVehicles.fromMeasure({ name: 'Synthetic SUV', length: '190', width: '75', height: '70', basis: 'car' })] });
          index = 3; save(); render(); }""")
        goods, fit, vehicles = page.locator('#finish-goods'), page.locator('#veh-fit'), page.locator('#customer-vehicles')
        expect(fit).to_be_visible()
        expect(fit.locator('[data-check="racks"]')).to_have_count(0)
        expect(fit.locator('[data-check="width"]')).not_to_contain_text('shelving')
        expect(goods.locator('button.qb-add')).to_have_count(0)
        expect(goods.get_by_role('button', name=re.compile(r'^Browse all \d+ products$'))).to_be_visible()
        top = page.evaluate("() => document.getElementById('customer-vehicles').getBoundingClientRect().top + scrollY")
        self.assertLess(top, 844 * 3, f'the vehicles panel starts {top} px down Finish')
        goods.get_by_label('Product group').select_option('shelving')
        goods.get_by_role('button', name='Add HDX plastic shelving, 36×72×24').click()
        expect(fit.locator('[data-check="width"]')).to_contain_text('less 24 in of shelving on a side wall')
        expect(vehicles.locator('#veh-wall-side')).to_be_visible()
        goods.get_by_label('Product group').select_option('overhead')
        goods.locator('button.qb-add').first.click()
        expect(fit.locator('[data-check="racks"]')).to_be_visible()
        expect(vehicles).to_contain_text('Overhead storage is in the quote')
        expect(vehicles.locator('#veh-racks')).to_have_count(0)
        plan = page.evaluate('parkingInfo().text')
        self.assertIn('Keep overhead racks', plan); self.assertIn('Shelving counted 24 in deep on the side wall.', plan)
        self.assertEqual(page.evaluate('S.builderQuote || null'), None, 'no quote built yet')
        self.assertEqual(page.evaluate('payload().scope.parking_plan'), plan)
        # Taking the rack off again takes its row with it.
        rack = page.evaluate("S.builderGoods.storage[0].name")
        goods.get_by_role('button', name=f'One fewer: {rack}').click()
        expect(fit.locator('[data-check="racks"]')).to_have_count(0)
        expect(vehicles.locator('#veh-racks')).to_be_visible()
        self.audit(page, 'finish, builder picks and vehicles')

    def test_with_the_quote_builder_on_and_its_menu_unavailable_scope_shows_no_legacy_price(self):
        # The builder menu does not load (no connection to it): Scope and Finish say so and show no legacy amount.
        self.builder = True; self.menu_down = True
        page = self.open()
        page.wait_for_function('() => PRICING !== null && quoteBuilderOn()')
        self.screen(page, 2, {'name': 'Synthetic Customer', 'garageSize': '1', 'fill': 'medium', 'loads': '1', 'hazards': ['Pest waste']})
        screen = page.locator('#screen')
        expect(screen.locator('.gp-status')).to_contain_text('The quote builder prices could not load.')
        for legacy in ('$950', '(+$', 'per full truckload'): expect(screen).not_to_contain_text(legacy)
        self.screen(page, 3, {'finish': ['cleanout', 'mouse_trapping']})
        expect(page.locator('#finish-goods .gp-status')).to_contain_text('The quote builder prices could not load.')
        expect(screen).not_to_contain_text('+$375')
        # LANE catalog review: with no builder menu (a garage with poor signal) Finish still records shelving and totes with
        # the walkthrough's own unpriced cards; the dead mounting panel stays hidden while the builder is on.
        expect(page.locator('#finish-goods')).to_contain_text('Until the prices load, record shelving and totes with Add shelving and Add labeled totes above.')
        expect(page.locator('#mounting-options')).to_have_count(0)
        screen.get_by_role('button', name='Add shelving').click()
        screen.get_by_role('button', name='Add labeled totes').click()
        for _ in range(2): page.locator('.conditional').nth(0).get_by_role('button', name='+', exact=True).click()
        page.locator('.conditional').nth(1).get_by_role('button', name='+', exact=True).click()
        self.assertEqual(page.evaluate('[S.finish, S.shelfQty, S.toteQty]'), [['cleanout', 'mouse_trapping', 'shelving', 'totes'], 2, 1])
        expect(screen).not_to_contain_text('$')
        self.audit(page, 'finish, builder prices unavailable')
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); page.screenshot(path=str(out / 'gameplan-finish-builder-offline-mobile.png'), full_page=True)
        self.screen(page, 2)
        self.menu_down = False
        screen.get_by_role('button', name='Retry builder prices').click()
        expect(screen).to_contain_text('Full truck load $1,000.00 Approved')
        self.audit(page, 'scope, builder prices after retry')
        # Once the menu loads, Finish offers the products and shows the counts recorded meanwhile, to clear after choosing.
        self.screen(page, 3, {})
        expect(screen.get_by_role('button', name='Add shelving')).to_have_count(0)
        expect(page.locator('#finish-goods .gp-legacy')).to_contain_text('Recorded earlier on this walkthrough: 2 metal shelving units; 1 labeled tote.')
        expect(page.locator('#finish-goods').get_by_label('Search shelving and storage products')).to_be_visible()

    def test_the_builder_menu_arriving_does_not_take_the_field_being_typed_in(self):
        # LANE catalog review: on a slow connection the menu arrives while the estimator types the customer's name.
        self.builder = True; self.menu_held = []
        page = self.open()
        page.wait_for_function('() => PRICING !== null && quoteBuilderOn()')
        page.wait_for_function('() => document.querySelector("#f-name") !== null')
        self.assertEqual(page.evaluate('index'), 0)
        field = page.locator('#f-name')
        field.click(); page.keyboard.type('Synth')
        self.assertEqual(len(self.menu_held), 1, 'the menu request is held')
        self.menu_held.pop()()
        page.wait_for_function('() => EGCGameplanCatalog.menu() !== null')
        page.keyboard.type('etic Customer')
        self.assertEqual(page.evaluate('document.activeElement.id'), 'f-name')
        self.assertEqual(page.evaluate('S.name'), 'Synthetic Customer')
        expect(field).to_have_value('Synthetic Customer')

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
