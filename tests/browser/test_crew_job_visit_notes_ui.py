"""EGC_WALKTHROUGH_NOTES: /crew/job.html shows the walkthrough notes the estimator confirmed (job.visitNotes) to the
assigned crew at phone 390x844 and iPad 1024x1366.

The job is the real crew projection (functions/_lib/field-execution.js fieldJobProjection, run in node) of a synthetic
Firestore job whose notes carry a spoken price and a phone number: neither reaches the page. Its materials card lists
the quote's goods and the stock kit, so the brief does not name them again. Routed fake API, synthetic data only."""
import datetime, json, os, pathlib, subprocess, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-10-21'
CUSTOMER = 'Synthetic Notes Garage'
RAW_JOB = {
    'id': 'job-1', 'revision': 'rev-1', 'type': 'job', 'status': 'scheduled', 'customer': CUSTOMER, 'phone': '9705550100', 'address': '1 Synthetic Way, Fort Collins, CO',
    'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '12:00', 'assignedCrew': ['Crew.One', 'Crew.Two'], 'crewLead': 'Crew.One', 'serviceType': 'Garage cleanout',
    'operationalScope': {'text': 'Synthetic one-day cleanout and shelving install.'},
    # The signed brief has its own keep list: the notes' keep line is not repeated.
    'jobInstructions': {'customerGoal': 'Park two cars', 'keepItems': 'Workbench and tool chest', 'bringList': ['Hand truck / dolly', 'Contractor bags'],
                        'materials': [{'id': 'quote-shelving', 'name': 'Metal shelving unit', 'quantity': 2}]},
    'materials': [{'id': 'quote-shelving', 'name': 'Metal shelving unit', 'quantity': 2, 'source': 'buy', 'purchaseState': 'purchased'},
                  {'id': 'material-0-hand-truck-dolly', 'name': 'Hand truck / dolly', 'quantity': 1, 'source': 'stock'}],
    'visitNotes': {'version': 1, 'jobNotes': ['Clear the left bay first; the customer parks there tonight.', 'Customer quoted $450 for the shelves; call 970-555-0100 if late.'],
                   'itemsNeeded': [{'name': 'Ladder', 'quantity': 1, 'reason': 'Overhead rack'}, {'name': 'Lag screws and anchors', 'quantity': None, 'reason': 'Shelving on the back wall'}],
                   'keepItems': ['Blue bicycle'], 'removeItems': ['Old couch (donate)'], 'access': ['Side door; park on the street'], 'hazards': ['Mouse droppings by the freezer'],
                   'openQuestions': ['Should never show'], 'confirmedAt': '2026-10-19T16:05:00.000Z', 'confirmedBy': 'rep.one', 'sourceVisitId': 'w1'},
}
PROJECT = """
import { fieldJobProjection } from './functions/_lib/field-execution.js';
process.stdout.write(JSON.stringify(fieldJobProjection(JSON.parse(process.argv[1]))));
"""


def projected():
    out = subprocess.run(['node', '--input-type=module', '-e', PROJECT, json.dumps(RAW_JOB)], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


class CrewJobVisitNotesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.job = projected()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.errors = []; self.context = None

    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/hub-auth': send({'ok': True, 'user': 'Crew.Two', 'displayName': 'Crew Two', 'role': 'crew'}); return
        if parsed.path == '/api/employee-hub': send({'ok': True, 'user': 'Crew.Two', 'entry': None}); return
        if parsed.path in ('/api/field-expenses', '/api/field-photo-sharing'): send({'ok': False, 'error': 'Not enabled.'}, 404); return
        if parsed.path != '/api/field-jobs': route.continue_(); return
        if parse_qs(parsed.query).get('view') == ['timer']: send({'ok': True, 'jobTime': self.job['jobTime'], 'expectedRevision': self.job['expectedRevision']}); return
        send({'ok': True, 'job': self.job, 'historyCursor': None, 'photosAvailable': True, 'features': {'jobCosts': False}, 'timezone': 'America/Denver'})

    def open(self, width, height):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='America/Denver', is_mobile=True, has_touch=True, service_workers='block')
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        self.page.clock.install(time=datetime.datetime(2026, 10, 21, 13, tzinfo=datetime.timezone.utc))
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
        self.page.goto(self.url + '/crew/job.html?jobId=job-1')
        expect(self.page.get_by_role('heading', name=CUSTOMER, exact=True)).to_be_visible()

    def check(self, width, height):
        self.open(width, height)
        scope = self.page.locator('section.card', has=self.page.get_by_role('heading', name='Scope & instructions'))
        notes = scope.locator('.scope-block', has=self.page.get_by_role('heading', name='Walkthrough notes (confirmed by the estimator: rep.one, Oct 19, 10:05 AM)'))
        expect(notes).to_be_visible()
        expect(notes.locator('.text-block')).to_have_text('Clear the left bay first; the customer parks there tonight.\nCustomer quoted for the shelves; call the number on file if late.')
        expect(scope.locator('.scope-block', has=self.page.get_by_role('heading', name='Items needed', exact=True)).locator('.text-block')).to_have_text('1 × Ladder – Overhead rack\nLag screws and anchors – Shelving on the back wall')
        for title, text in (('Remove (walkthrough notes)', 'Old couch (donate)'), ('Access (walkthrough notes)', 'Side door; park on the street'), ('Hazards (walkthrough notes)', 'Mouse droppings by the freezer')):
            expect(scope.locator('.scope-block', has=self.page.get_by_role('heading', name=title)).locator('.text-block')).to_have_text(text)
        # The signed brief's own keep list is shown; the notes' keep line is not repeated.
        expect(scope.get_by_role('heading', name='Keep and protect')).to_be_visible()
        expect(scope.get_by_role('heading', name='Keep (walkthrough notes)')).to_have_count(0)
        # The materials card lists the quote's goods and the stock kit, so the brief names neither again.
        expect(self.page.locator('#materials-card')).to_contain_text('Metal shelving unit')
        expect(self.page.locator('#materials-card')).to_contain_text('Hand truck / dolly')
        for title in ('Sold goods', 'Bring'): expect(scope.get_by_role('heading', name=title, exact=True)).to_have_count(0)
        text = scope.inner_text()
        for hidden in ('$', '450', '555-0100', 'Should never show'): self.assertNotIn(hidden, text)
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth > innerWidth'), f'{width}: no sideways scroll')
        wide = self.page.evaluate("""[...document.querySelectorAll('.scope-block')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).length""")
        self.assertEqual(wide, 0)
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); scope.screenshot(path=str(out / f'crew-job-visit-notes-{width}.png'))

    def test_phone_the_assigned_crew_reads_the_confirmed_notes_without_money_or_contacts(self):
        self.check(390, 844)

    def test_ipad_the_assigned_crew_reads_the_confirmed_notes_without_money_or_contacts(self):
        self.check(1024, 1366)


if __name__ == '__main__':
    unittest.main(verbosity=2)
