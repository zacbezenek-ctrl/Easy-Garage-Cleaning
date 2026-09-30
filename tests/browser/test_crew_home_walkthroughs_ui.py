"""WT-OUTCOME: the crew home (/crew/) on a phone. A rep who holds walkthrough.perform sees their own walkthroughs with a
tel: link and the outcome badge; a crew member without it never sees walkthroughs; the crew nav wraps instead of scrolling.
Static files come from the worktree; /api/hub-auth, /api/firebase-session, /api/crew-jobs and /api/employee-hub are
isolated contract fixtures. Nothing is written.
Run: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome python3 -m unittest tests/browser/test_crew_home_walkthroughs_ui.py"""
import datetime, json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime.datetime(2026, 9, 22, 15, tzinfo=datetime.timezone.utc)  # 09:00 in Denver
DAY = '2026-09-22'
# Firebase compat SDK stand-in: EGCHubAuth only needs auth().signInWithCustomToken; Firestore stays unavailable.
FIREBASE = ("window.firebase={apps:[],initializeApp(options){const app={options};this.apps.push(app);return app},"
            "auth(){return{signInWithCustomToken:async()=>({user:{uid:'synthetic'}}),signOut:async()=>{},onAuthStateChanged(){return()=>{}},currentUser:null}}};")
REP = {'ok': True, 'user': 'synthetic.rep', 'displayName': 'Synthetic Rep', 'role': 'sales', 'payType': 'hourly', 'hourlyRate': 0, 'businessAccess': False, 'owner': False,
       'capabilities': ['walkthrough.perform', 'schedule.book'], 'capabilityMode': 'staff_roles', 'roleAccess': True}
CREW = {**REP, 'user': 'synthetic.crew', 'displayName': 'Synthetic Crew', 'role': 'crew', 'capabilities': ['field.execute']}

def walk(id, customer, time, end, **extra):
    row = {'id': id, 'type': 'walkthrough', 'customer': customer, 'phone': '(970) 555-0144', 'address': '12 Synthetic Loop, Fort Collins, CO', 'date': DAY, 'time': time, 'endTime': end,
           'status': 'scheduled', 'assignedCrew': ['synthetic.rep'], 'serviceType': 'Free walkthrough'}
    row.update(extra)
    return row

def rows():
    return [
        walk('walk-noshow', 'Synthetic Missed Garage', '07:00', '08:00', walkthroughState='no_show', walkthroughClosed=False, walkthroughBadge='No-show · rebook',
             walkthroughOutcome={'outcome': 'customer_no_show', 'reasonCode': 'customer_not_home', 'finishedAt': DAY + 'T13:40:00Z'}),
        walk('walk-open', 'Synthetic Walkthrough Garage', '13:00', '14:00'),
        {'id': 'job-1', 'type': 'job', 'customer': 'Synthetic Crew Job', 'address': '5 Synthetic Way, Fort Collins, CO', 'date': DAY, 'time': '10:00', 'endTime': '12:00', 'status': 'scheduled',
         'assignedCrew': ['synthetic.crew'], 'serviceType': 'Garage cleanout', 'phone': '(970) 555-0199'},
    ]

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class CrewHomeWalkthroughBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(7000); self.page.clock.install(time=NOW)
        self.errors = []; self.writes = []; self.viewer = REP; self.jobs = rows()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.context.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}'); self.assertEqual(self.writes, [], 'the crew home only reads')
        self.context.close()
    def route(self, route):
        req = route.request; url = urlparse(req.url)
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(data))
        if url.hostname == 'www.gstatic.com' and url.path.startswith('/firebasejs/'):
            route.fulfill(status=200, content_type='text/javascript', body=FIREBASE if url.path.endswith('/firebase-app-compat.js') else ''); return
        if url.hostname != '127.0.0.1': route.abort(); return
        if req.method != 'GET' and url.path.startswith('/api/'): self.writes.append((req.method, url.path)); send({'ok': False}, 405); return
        if url.path == '/api/hub-auth': send(self.viewer); return
        if url.path == '/api/firebase-session': send({'ok': True, 'token': 'synthetic-firebase-token'}); return
        if url.path == '/api/crew-jobs': send({'ok': True, 'jobs': self.jobs}); return
        if url.path == '/api/employee-hub': send({'ok': True, 'collections': {'timeEntries': []}}); return
        if url.path.startswith('/api/'): send({'ok': False, 'error': 'Not in this fixture.'}, 404); return
        route.continue_()
    def open(self):
        self.page.goto(self.url + '/crew/')
        expect(self.page.locator('#hello')).to_have_text('Hi, ' + self.viewer['displayName'])
        expect(self.page.locator('#assigned-jobs .job-row').first).to_be_visible()
    def fits(self):
        for width in (375, 320, 390):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'no horizontal scroll at {width}px')
        self.page.set_viewport_size({'width': 375, 'height': 812})

    def test_rep_sees_their_walkthroughs_with_a_call_link_and_the_outcome(self):
        self.open(); page = self.page
        card = page.locator('#next-work')
        expect(card.get_by_role('heading', name='Synthetic Walkthrough Garage')).to_be_visible()
        expect(card.get_by_role('link', name='Start walkthrough', exact=True)).to_have_attribute('href', '/crew/gameplan?walkthroughId=walk-open')
        expect(card.get_by_role('link', name='Call customer', exact=True)).to_have_attribute('href', 'tel:9705550144')
        rows_ = page.locator('#assigned-jobs .job-row'); expect(rows_).to_have_count(2)
        expect(rows_.nth(0)).to_have_attribute('href', '/crew/gameplan?walkthroughId=walk-noshow')
        expect(rows_.nth(0).locator('.row-badge')).to_have_text('No-show · rebook')
        expect(rows_.nth(1)).to_have_attribute('href', '/crew/gameplan?walkthroughId=walk-open'); expect(rows_.nth(1).locator('.row-badge')).to_have_count(0)
        expect(page.locator('#assigned-jobs')).not_to_contain_text('Synthetic Crew Job')
        expect(page.locator('#walkthrough-tool')).to_be_visible()
        nav = page.get_by_role('navigation', name='Crew workflow')
        for label in ['Crew home', 'Walkthrough', 'Pre-job', 'Closeout', 'My Hub']:
            link = nav.get_by_role('link', name=label, exact=True); expect(link).to_be_visible()
            self.assertGreaterEqual(link.bounding_box()['height'], 44, label)
        for target in card.locator('.next-actions a').all(): self.assertGreaterEqual(target.bounding_box()['height'], 44)
        self.fits()
        for width in (375, 320):
            page.set_viewport_size({'width': width, 'height': 812}); box = nav.bounding_box()
            for label in ['Crew home', 'My Hub']:
                link = nav.get_by_role('link', name=label, exact=True).bounding_box()
                self.assertGreaterEqual(link['x'], box['x'] - 0.5, f'{label} starts inside the nav at {width}px')
                self.assertLessEqual(link['x'] + link['width'], box['x'] + box['width'] + 0.5, f'{label} is fully visible without scrolling at {width}px')
        page.set_viewport_size({'width': 375, 'height': 812})
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); page.screenshot(path=str(out / 'crew-home-rep-375.png'), full_page=True)

    def test_crew_without_walkthrough_perform_never_sees_walkthroughs(self):
        self.viewer = CREW; self.jobs = [{**row, 'assignedCrew': ['synthetic.crew']} for row in rows()]
        self.open(); page = self.page
        expect(page.locator('#next-work').get_by_role('heading', name='Synthetic Crew Job')).to_be_visible()
        expect(page.locator('#assigned-jobs .job-row')).to_have_count(1)
        expect(page.locator('body')).not_to_contain_text('Synthetic Walkthrough Garage'); expect(page.locator('body')).not_to_contain_text('Synthetic Missed Garage')
        expect(page.locator('#walkthrough-tool')).to_be_hidden()
        nav = page.get_by_role('navigation', name='Crew workflow')
        expect(nav.get_by_role('link', name='Walkthrough', exact=True)).to_have_count(0)
        self.fits()
        for width in (320, 390):
            page.set_viewport_size({'width': width, 'height': 812})
            links = nav.locator('a')
            expect(links).to_have_count(4)
            boxes = [link.bounding_box() for link in links.all()]
            self.assertTrue(all(box['height'] >= 44 for box in boxes))
            self.assertAlmostEqual(boxes[0]['y'], boxes[1]['y'], delta=1)
            self.assertAlmostEqual(boxes[2]['y'], boxes[3]['y'], delta=1)
            self.assertGreater(boxes[2]['y'], boxes[0]['y'], 'four crew links form two balanced rows')
            self.assertAlmostEqual(boxes[0]['width'], boxes[3]['width'], delta=1)
            self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True)
        page.set_viewport_size({'width': 320, 'height': 812})
        brand = page.locator('#brand').bounding_box(); chip = page.locator('#chip').bounding_box()
        self.assertLessEqual(brand['x'] + brand['width'], chip['x'] + 0.5, 'the logo and crew-tools chip do not overlap on a narrow phone')
        page.screenshot(path=str(out / 'crew-home-no-walkthrough-320.png'), full_page=True)

if __name__ == '__main__': unittest.main(verbosity=2)
