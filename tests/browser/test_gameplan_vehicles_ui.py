"""crew/gameplan.html: vehicles to park after the job, the optional garage measurements and the parking fit check
(crew/gameplan-vehicles.js) on an iPad (1024 x 1366) and a phone (390 x 844), against a routed fake API.

The estimator measures the garage depth on Photos (20 ft), searches "f150" on Finish, adds a SuperCrew and a typical
midsize SUV, sees the fit check say the truck won't fit, reloads and keeps both, and the payload and both briefs carry
them (scope.customer_vehicles, scope.parking_plan and a PARKING line). The vehicle catalog loads only once Finish opens.
Removing the vehicles and the measurement leaves the payload exactly as it was. A signed walkthrough with a vehicle goes
through the real /api/walkthrough-handoff, and the crew job page shows "Parking after the job" (crew_scope_fixture.mjs).
No production service is contacted. Screenshots: test-results/gameplan-vehicles-*.png (VEHICLES_SHOTS overrides the folder).
"""
import json, os, pathlib, re, subprocess, threading, unittest, urllib.error, urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = pathlib.Path(os.environ.get('VEHICLES_SHOTS') or ROOT / 'test-results')
VERSION = 'pc_5555555555555555'
PROFILE = {'ok': True, 'user': 'zacb', 'displayName': 'Synthetic Owner', 'role': 'owner', 'businessAccess': True, 'owner': True, 'capabilities': ['quotes.author']}
CREW = {'ok': True, 'user': 'crew.one', 'displayName': 'Crew One', 'role': 'crew'}
DEVICES = {'ipad': {'viewport': {'width': 1024, 'height': 1366}, 'is_mobile': True, 'has_touch': True, 'device_scale_factor': 2},
           'phone': {'viewport': {'width': 390, 'height': 844}, 'is_mobile': True, 'has_touch': True, 'device_scale_factor': 2}}
FIREBASE_STUB = """
window.firebase = window.firebase || {
  apps: [], initializeApp() { this.apps.push({}); },
  auth() { return { signInWithCustomToken: async () => ({}), signOut: async () => {} }; },
  firestore() { return { collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }), doc: id => ({ get: async () => ({ id, exists: false }) }) }) }; },
};
"""
STATE = {'name': 'Synthetic Customer', 'garageSize': '2', 'fill': 'medium', 'loads': '1'}
# No horizontal scroll, and every control in the vehicles section and the measurements is a 44 px tap target.
AUDIT = """() => ({
  scroll: document.documentElement.scrollWidth, width: innerWidth,
  small: [...document.querySelectorAll('#customer-vehicles button, #customer-vehicles input, #customer-vehicles select, #customer-vehicles summary, #garage-measurements input')]
    .filter(el => el.offsetParent !== null && el.type !== 'checkbox').map(el => [el.id || el.textContent.trim().slice(0, 40), Math.round(el.getBoundingClientRect().height)]).filter(([, h]) => h < 44),
  overflow: [...document.querySelectorAll('#customer-vehicles *, #garage-measurements *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => el.className || el.tagName).slice(0, 5),
})"""


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


class GameplanVehiclesBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pricing = json.loads(subprocess.run(['node', '--input-type=module', '-e', "import {servedPricing} from './tests/helpers/walkthrough-pricing.mjs';console.log(JSON.stringify(servedPricing()))"], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        SHOTS.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.errors = []; self.requests = []; self.fixture_port = None; self.handoff_posts = []; self.context = None

    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')

    def start(self, device):
        self.context = self.browser.new_context(timezone_id='America/Denver', **DEVICES[device])
        self.context.add_init_script(FIREBASE_STUB)
        self.context.route('**/*', self.route)
        page = self.context.new_page(); page.set_default_timeout(10000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.on('request', lambda request: self.requests.append(urlparse(request.url).path))
        page.clock.install(time='2026-09-22T15:00:00Z')
        page.goto(self.url + '/crew/gameplan.html'); expect(page.locator('#app')).to_be_visible()
        page.wait_for_function('() => PRICING !== null && window.EGCGameplanVehicles')
        return page

    def route(self, route):
        url = urlparse(route.request.url)
        if url.hostname != '127.0.0.1': route.abort(); return
        send = lambda body, status=200: route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(body))
        if url.path == '/api/hub-auth': send(PROFILE); return
        if url.path == '/api/firebase-session': send({'ok': True, 'token': 'synthetic-custom-token'}); return
        if url.path == '/api/pricing-config': send({'ok': True, 'authority': 'employee_hub', 'version': VERSION, 'parts': {'walkthrough': self.pricing}}); return
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

    def screen(self, page, index, state=None):
        page.evaluate('([i, s]) => { Object.assign(S, s || {}); index = i; save(); render(); }', [index, state or {}])

    def audit(self, page, where):
        result = page.evaluate(AUDIT)
        self.assertLessEqual(result['scroll'], result['width'], f'{where}: horizontal scroll')
        self.assertEqual(result['small'], [], f'{where}: tap targets under 44 px')
        self.assertEqual(result['overflow'], [], f'{where}: content wider than the screen')

    def shot(self, page, name):
        page.screenshot(path=str(SHOTS / f'gameplan-vehicles-{name}.png'), full_page=True)

    def flow(self, device):
        page = self.start(device)
        # Photos: the Quick size check says measurements are optional and reads feet and inches.
        self.screen(page, 1, STATE)
        before = page.evaluate('() => [JSON.stringify(payload().scope), Object.keys(payload().raw).sort()]')
        expect(page.locator('#screen')).to_contain_text('Measurements are optional; the fit check uses typical sizes until you add them.')
        expect(page.locator('#screen')).not_to_contain_text('No dimensions or diagram needed')
        expect(page.locator('#gm-depth-hint')).to_contain_text('Typical 264 in (22 ft) — measure if tight')
        page.locator('#gm-width').fill('20\' 4"')
        expect(page.locator('#gm-width-hint')).to_have_text('= 244 in (20 ft 4 in)')
        page.locator('#gm-width').fill('20.3 ft')
        expect(page.locator('#gm-width-hint')).to_have_text('= 243.6 in (20 ft 3.6 in)')
        page.locator('#gm-width').fill('twenty')
        expect(page.locator('#gm-width-hint')).to_contain_text('Not understood')
        page.locator('#gm-width').fill('')
        expect(page.locator('#gm-width-hint')).to_contain_text('Typical 240 in (20 ft)')
        page.locator('#gm-depth').fill('20 ft')
        expect(page.locator('#gm-depth-hint')).to_have_text('= 240 in (20 ft)')
        self.assertEqual(page.evaluate('S.garageMeasure'), {'depth': '20 ft'})
        self.assertEqual(page.evaluate('validateStep(1)'), ['at least 3 photos'], 'measurements are never required')
        self.audit(page, f'{device} photos')
        self.shot(page, f'{device}-photos')
        # The catalog is not loaded until Finish opens.
        self.assertFalse(page.evaluate('Boolean(window.EGCGameplanVehicleData)'))
        self.assertNotIn('/crew/gameplan-vehicles-data.js', self.requests)
        self.screen(page, 3)
        section = page.locator('#customer-vehicles')
        expect(section.get_by_role('heading', name='Vehicles to park after the job')).to_be_visible()
        page.wait_for_function('() => Boolean(window.EGCGameplanVehicleData)')
        self.assertEqual(self.requests.count('/crew/gameplan-vehicles-data.js'), 1)
        # Search "f150" and pick a SuperCrew.
        page.locator('#veh-search').fill('f150')
        expect(section.locator('.veh-group-head').first).to_contain_text('Ford F-150')
        expect(section.locator('.veh-result').first).to_contain_text('(approx ±2 in)')
        self.shot(page, f'{device}-search')
        section.locator('.veh-result', has_text='SuperCrew, 5.5 ft bed').first.click()
        card = section.locator('.veh-card').first
        expect(card).to_contain_text('Ford F-150 SuperCrew, 5.5 ft bed')
        expect(card).to_contain_text('Catalog')
        expect(card).to_contain_text('232 × 80 × 76 in (approx ±2 in)')
        # 232 in + a 36 in walkway needs 268 in; the measured 240 in depth is short even with a 24 in walkway.
        fit = section.locator('#veh-fit')
        expect(fit.locator('.veh-fit-head .veh-badge')).to_have_text(re.compile('Won.t fit'))
        expect(fit.locator('[data-check=depth]')).to_contain_text('needs 268 in; garage is 240 in (measured)')
        expect(fit.locator('[data-check=depth] .veh-badge')).to_have_text(re.compile('Won.t fit'))
        # Not in the list: a typical midsize SUV.
        section.locator('summary', has_text='Not in the list?').click()
        section.locator('.veh-type', has_text='Midsize SUV').click()
        expect(section.locator('.veh-card')).to_have_count(2)
        expect(section.locator('.veh-card').nth(1)).to_contain_text('Midsize SUV, typical size')
        expect(section.locator('.veh-card').nth(1)).to_contain_text('Typical size')
        expect(fit.locator('[data-check=width]')).to_contain_text('garage is 240 in (typical)')
        expect(fit.locator('[data-check=width] .veh-badge')).to_have_text('Tight')
        page.get_by_label('Overhead racks planned').check()
        expect(fit.locator('[data-check=racks]')).to_contain_text('racks hang no lower than 80 in')
        self.audit(page, f'{device} finish')
        self.shot(page, f'{device}-finish')
        # A reload keeps both vehicles (the walkthrough draft in localStorage).
        page.reload(); expect(page.locator('#app')).to_be_visible(); page.wait_for_function('() => PRICING !== null && window.EGCGameplanVehicles')
        self.screen(page, 3)
        expect(page.locator('#customer-vehicles .veh-card')).to_have_count(2)
        expect(page.locator('#customer-vehicles .veh-card').first).to_contain_text('Ford F-150 SuperCrew, 5.5 ft bed')
        expect(page.locator('#veh-fit .veh-fit-head .veh-badge')).to_have_text(re.compile('Won.t fit'))
        # The payload and both briefs carry them.
        sent = page.evaluate('() => payload()')
        vehicles = sent['scope']['customer_vehicles']
        self.assertEqual([v['source'] for v in vehicles], ['catalog', 'typical'])
        self.assertEqual(sorted(vehicles[0]), ['confidence', 'height_in', 'label', 'length_in', 'source', 'width_in', 'width_mirrors_in'])
        self.assertEqual(sent['scope']['garage_measurements'], {'depth_in': 240})
        plan = sent['scope']['parking_plan']
        self.assertRegex(plan, r'^Ford F-150 SuperCrew, 5\.5 ft bed \(\d{4}–\d{4}\) \(232×80×76 in\) \+ Midsize SUV, typical size \(197×78×70 in\)\. ')
        self.assertIn('Depth won’t fit (needs 268 in, has 240 in)', plan)
        self.assertIn('Keep overhead racks ≥ 80 in off the floor.', plan)
        self.assertLessEqual(len(plan), 1000)
        for brief in (sent['internal_notes'], sent['crew_brief']):
            lines = brief.split('\n')
            self.assertEqual(lines[lines.index(next(l for l in lines if l.startswith('MATERIALS: '))) + 1], f'PARKING: {plan}')
        self.assertIn('Check the customer can park as planned', [row['label'] for row in sent['client_checklists']['postJob']])
        self.screen(page, 5)
        expect(page.locator('#review-parking')).to_contain_text(re.compile('2 vehicles · Won.t fit — depth needs 268 in, has 240 in'))
        self.shot(page, f'{device}-review')
        # Removing the vehicles and the measurement leaves the payload exactly as it was.
        self.screen(page, 3)
        for _ in range(2): page.locator('#customer-vehicles .veh-card').first.get_by_role('button', name=re.compile('^Remove')).click()
        expect(page.locator('#customer-vehicles .veh-card')).to_have_count(0)
        self.assertEqual(page.evaluate('() => payload().scope.garage_measurements'), {'depth_in': 240})
        self.assertNotIn('PARKING', page.evaluate('() => payload().crew_brief'))
        self.screen(page, 1)
        page.locator('#gm-depth').fill('')
        self.assertEqual(page.evaluate('() => [JSON.stringify(payload().scope), Object.keys(payload().raw).sort()]'), before)
        self.assertEqual(page.evaluate("() => ['customerVehicles', 'garageMeasure', 'parkingRacks', 'parkingShelfWall'].filter(key => key in S)"), [])

    def test_ipad_vehicles_fit_check_and_brief(self):
        self.flow('ipad')

    def test_phone_vehicles_fit_check_and_brief(self):
        self.flow('phone')

    def test_measured_vehicle_and_a_dually_in_a_nine_foot_door(self):
        page = self.start('phone')
        self.screen(page, 3, {**STATE, 'garageSize': '1'})
        section = page.locator('#customer-vehicles')
        page.wait_for_function('() => Boolean(window.EGCGameplanVehicleData)')
        page.locator('#veh-search').fill('ram 3500 drw 2015')
        section.locator('.veh-result').first.click()
        card = section.locator('.veh-card').first
        expect(card).to_contain_text('2015 Ram 3500 DRW')
        expect(card).to_contain_text('Measure to be sure')
        expect(section.locator('[data-check=door_width]')).to_contain_text('fold the mirrors')
        expect(section.locator('[data-check=door_width] .veh-badge')).to_have_text(re.compile('Won.t fit'))
        # "Measure it": feet and inches, read back as inches.
        section.locator('summary', has_text='Not in the list?').click()
        page.locator('#veh-m-name').fill('Boat on trailer')
        page.locator('#veh-m-length').fill('19\' 6"')
        expect(page.locator('#veh-m-length-hint')).to_have_text('= 234 in (19 ft 6 in)')
        page.locator('#veh-m-width').fill('96')
        page.locator('#veh-m-height').fill('6 ft')
        page.locator('#veh-m-basis').select_option('mirrors')
        page.get_by_role('button', name='Add measured vehicle').click()
        expect(section.locator('.veh-card')).to_have_count(2)
        expect(section.locator('.veh-card').nth(1)).to_contain_text('Boat on trailer')
        expect(section.locator('.veh-card').nth(1)).to_contain_text('Measured')
        expect(section.locator('.veh-card').nth(1)).to_contain_text('234 × 96 × 72 in · 96 in across the mirrors')
        self.audit(page, 'phone measured')
        # Four vehicles is the most.
        for name in ('Compact car', 'Motorcycle'): section.locator('.veh-type', has_text=name).first.click()
        expect(section.locator('.veh-card')).to_have_count(4)
        expect(page.locator('#veh-search')).to_have_count(0)
        expect(section).to_contain_text('4 vehicles is the most')
        self.shot(page, 'phone-four-vehicles')

    def test_a_signed_walkthrough_with_a_vehicle_reaches_the_crew_job_page(self):
        fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'crew_scope_fixture.mjs')], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (fixture.kill(), fixture.wait(), fixture.stdout.close(), fixture.stderr.close()))
        ready = fixture.stdout.readline()
        self.assertTrue(ready.startswith('READY '), ready or fixture.stderr.read())
        self.fixture_port = int(ready.split()[1])
        page = self.start('phone')
        count = page.evaluate("""async () => { S.jobId = S.jobId || 'synthetic-draft'; const db = await dbOpen();
          await new Promise(done => { const tx = db.transaction('p', 'readwrite'); for (let i = 0; i < 3; i++) tx.objectStore('p').put({ id: 'synthetic-photo-' + i, job: S.photoDraftJobId || S.jobId, tag: 'before', dataUrl: 'data:image/jpeg;base64,/9j/', at: i }); tx.oncomplete = done; });
          await refreshPhotoCount(); return PHOTO_COUNT; }""")
        self.assertEqual(count, 3)
        self.screen(page, 3, {'sourceWalkthroughId': 'w1', 'name': 'Synthetic Customer', 'phone': '9705550100', 'email': 'test@example.invalid', 'address': '100 Fixture Lane', 'highlevelContactId': 'provider1',
            'whyNow': 'Moving soon', 'outcome': 'Park two cars', 'garageSize': '2', 'fill': 'medium', 'loads': '1', 'sortMethod': 'remove_all', 'truckPlacement': 'Driveway', 'hazards': ['No visible hazards'],
            'finish': ['cleanout'], 'jobDate': '2026-09-24', 'startTime': '08:00', 'endTime': '13:00', 'crewSize': '1', 'assignedTo': 'Crew One', 'garageMeasure': {'depth': '22 ft 6'}})
        page.wait_for_function('() => Boolean(window.EGCGameplanVehicleData)')
        page.locator('#veh-search').fill('2019 f150 supercrew')
        page.locator('#customer-vehicles .veh-result', has_text='SuperCrew, 5.5 ft bed').first.click()
        expect(page.locator('#customer-vehicles .veh-card')).to_contain_text('2019 Ford F-150 SuperCrew, 5.5 ft bed')
        self.screen(page, 5, {'signature': 'data:image/png;base64,iVBORw0KGgo=', 'approved': True, 'acceptanceAt': '2026-09-22T14:45:00.000Z', 'acceptanceBy': 'Synthetic Customer'})
        expect(page.locator('#review-parking')).to_contain_text('1 vehicle · Fits')
        page.get_by_role('button', name='Save brief + schedule').click()
        expect(page.locator('#send-status')).to_contain_text('Job and CRM schedule verified', timeout=20000)
        plan = self.handoff_posts[-1]['plan']
        self.assertEqual(plan['scope']['customer_vehicles'][0]['label'], '2019 Ford F-150 SuperCrew, 5.5 ft bed')
        self.assertEqual(plan['scope']['garage_measurements'], {'depth_in': 270})
        self.assertIn('PARKING: 2019 Ford F-150 SuperCrew, 5.5 ft bed (232×80×76 in).', plan['crew_brief'])
        job_id = page.evaluate('S.handoffJobId')
        crew = self.browser.new_context(viewport={'width': 390, 'height': 844}, timezone_id='America/Denver', is_mobile=True, has_touch=True, device_scale_factor=2, service_workers='block')
        self.addCleanup(crew.close)
        crew.route('**/*', self.crew_route)
        job = crew.new_page(); job.on('pageerror', lambda error: self.errors.append(str(error)))
        job.clock.install(time='2026-09-22T15:00:00Z')
        job.goto(f'{self.url}/crew/job.html?jobId={job_id}')
        expect(job.get_by_role('heading', name='Synthetic Customer', exact=True)).to_be_visible()
        block = job.locator('#scope-card .scope-block', has=job.get_by_role('heading', name='Parking after the job'))
        expect(block).to_contain_text('2019 Ford F-150 SuperCrew, 5.5 ft bed (232×80×76 in)')
        expect(block).to_contain_text('Hang nothing lower than 80 in over the parked vehicles.')
        expect(job.locator('#scope-card')).to_contain_text('PARKING: 2019 Ford F-150')
        self.assertEqual(job.evaluate("() => [...document.querySelectorAll('#scope-card, #scope-card *')].filter(el => el.getBoundingClientRect().right > 391).length"), 0, 'crew brief: horizontal overflow')
        job.screenshot(path=str(SHOTS / 'gameplan-vehicles-crew-job-phone.png'), full_page=True)

    def crew_route(self, route):
        url = urlparse(route.request.url)
        if url.hostname != '127.0.0.1': route.abort(); return
        send = lambda body, status=200: route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(body))
        if url.path == '/api/hub-auth': send(CREW); return
        if url.path == '/api/field-jobs': self.forward(route, 'crew.one'); return
        if url.path == '/api/employee-hub': send({'ok': True, 'user': 'crew.one', 'entry': None}); return
        if url.path.startswith('/api/'): send({'ok': False, 'error': 'Synthetic service unavailable'}, 503); return
        route.continue_()


if __name__ == '__main__':
    unittest.main()
