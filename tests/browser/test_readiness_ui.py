"""Tomorrow's crew readiness widget (READINESS, employee-readiness.js) in a real browser: an isolated mount with the UI kit
and a routed /api/dispatch answer, at 1280 px and 390 px. The clock is fixed late in the Denver evening and the browser
runs in Asia/Tokyo, so "tomorrow" must be the next Denver day. Synthetic jobs only; every other request is aborted."""
import json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
# 2026-10-22 03:30 UTC is 2026-10-21 21:30 in Denver: tomorrow is 2026-10-22 there (already the 22nd in Tokyo and UTC).
NOW = '2026-10-22T03:30:00.000Z'
PAGE = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Readiness widget</title>'
        '<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-readiness.css"></head>'
        '<body style="margin:0;background:#f4f3ef"><main id="host" style="padding:16px"></main><script src="/employee-readiness.js"></script>'
        f'<script>EGCReadiness.mount(document.querySelector("#host"),{{now:()=>new Date("{NOW}")}})</script></body></html>').encode()
ROSTER = [{'id': 'crew.one', 'name': 'Synthetic Crew One'}, {'id': 'crew.two', 'name': 'Synthetic Crew Two With A Long Name'}]
VEHICLES = [{'id': 'truck-1', 'name': 'Synthetic Truck A', 'status': 'available'}]
def job(job_id, **extra):
    return {'id': job_id, 'type': 'job', 'status': 'scheduled', 'date': '2026-10-22', 'time': '09:00', 'customer': 'Synthetic Johnson Family', 'serviceType': 'Garage cleanout',
            'assignedCrew': ['crew.one', 'crew.two'], 'crewLead': 'crew.one', 'vehicleId': 'truck-1', 'crewNeeded': 2, 'accessInstructions': 'Side gate', **extra}
BOARD = {'ok': True, 'jobs': [job('ready'), job('short', time='11:30', assignedCrew=['crew.one'], crewLead=None, customer='Synthetic Short Garage'),
                              job('bare', time='14:00', vehicleId='', accessInstructions='', customer='Synthetic Bare Garage'), job('walk', type='walkthrough')],
         'warnings': [{'jobId': 'short', 'code': 'crew_size_short'}, {'jobId': 'short', 'code': 'employee_unavailable'}], 'roster': ROSTER, 'vehicles': VEHICLES}


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if urlparse(self.path).path == '/widget':
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(PAGE); return
        super().do_GET()


class ReadinessWidgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        RESULTS.mkdir(exist_ok=True)
    @classmethod
    def tearDownClass(cls): cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self): self.errors = []; self.asked = []; self.answer = (200, BOARD); self.context = None
    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        url = route.request.url
        if '/api/dispatch' in url:
            self.asked.append(parse_qs(urlparse(url).query)); status, body = self.answer
            route.fulfill(status=status, content_type='application/json', body=json.dumps(body)); return
        route.continue_() if url.startswith(self.url) else route.abort()

    def open(self, width, height=900):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo')
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', self.route)
        page.goto(self.url + '/widget')
        return page

    def test_tomorrow_jobs_show_what_blocks_them_with_the_next_denver_day(self):
        page = self.open(1280)
        widget = page.locator('.egc-readiness')
        expect(widget).to_contain_text('1 ready · 1 not ready · 1 to check')
        self.assertEqual(self.asked, [{'startDate': ['2026-10-22'], 'endDate': ['2026-10-23']}])
        expect(widget).to_contain_text('Thursday, Oct 22')
        short = page.locator('[data-rd-job="short"]')
        expect(short).to_contain_text('11:30 AM · Synthetic'); expect(short).to_contain_text('Not ready')
        expect(short).to_contain_text('Fewer crew than needed'); expect(short).to_contain_text('Someone assigned is off or unavailable')
        expect(short).to_contain_text('1 of 2 crew · Lead: Synthetic Crew One')
        bare = page.locator('[data-rd-job="bare"]')
        expect(bare).to_contain_text('No truck assigned'); expect(bare).to_contain_text('No access or gate notes')
        expect(page.locator('[data-rd-job="walk"]')).to_have_count(0)
        expect(widget).not_to_contain_text('Johnson Family')
        page.screenshot(path=str(RESULTS / 'readiness-1280.png'), full_page=True)

    def test_phone_layout_fits_and_a_failed_load_is_never_all_ready(self):
        page = self.open(390, 844)
        expect(page.locator('[data-rd-job]')).to_have_count(3)
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        small = page.evaluate("""[...document.querySelectorAll('.egc-readiness button')].filter(el => el.getBoundingClientRect().height < 44).length""")
        self.assertEqual(small, 0)
        page.screenshot(path=str(RESULTS / 'readiness-390.png'), full_page=True)
        self.answer = (503, {'ok': False, 'code': 'dispatch_unavailable'})
        page.get_by_role('button', name='Refresh').click()
        alert = page.get_by_role('alert')
        expect(alert).to_contain_text('Readiness is unavailable'); expect(alert).to_contain_text('does not mean every job is ready')
        self.answer = (200, {**BOARD, 'jobs': []})
        page.get_by_role('button', name='Retry').click()
        expect(page.locator('.egc-readiness')).to_contain_text('No customer jobs are scheduled for Thursday, Oct 22.')


if __name__ == '__main__':
    unittest.main(verbosity=2)
