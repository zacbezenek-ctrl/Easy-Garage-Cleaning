"""FIX-DISPATCH-QUEUE: Dispatch's To schedule view against an isolated contract fixture; no provider or customer writes."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-22'
ROSTER = [{'id': 'crew.one', 'name': 'Crew One', 'role': 'crew'}, {'id': 'crew.two', 'name': 'Crew Two', 'role': 'crew'}, {'id': 'lead.one', 'name': 'Lead One', 'role': 'crew_lead'}]
QUEUED = 36
# The three lines every undated job used to carry (dispatch-service.js jobWarnings); the queue leaves them out.
GENERIC = [('unscheduled', 'This job has no scheduled time.'), ('unassigned', 'No employees are assigned.'), ('crew_size_short', 'Requires 1 crew members; 0 assigned.')]

def scheduled(id, time, end, customer):
    return {'id': id, 'revision': id + '-r1', 'type': 'job', 'customerId': 'c-' + id, 'customer': customer, 'phone': '(970) 555-0100', 'address': '1 Synthetic Way, Fort Collins, CO',
            'date': DAY, 'time': time, 'endDate': DAY, 'endTime': end, 'startAt': DAY + 'T' + time + ':00-06:00', 'endAt': DAY + 'T' + end + ':00-06:00', 'status': 'scheduled',
            'assignedCrew': ['crew.one', 'lead.one'], 'crewLead': 'lead.one', 'crewId': None, 'vehicleId': None, 'crewNeeded': 2, 'travelBufferMinutes': 20, 'serviceType': 'Garage cleanout',
            'jobInstructions': 'Synthetic scope.', 'requiredEquipment': [], 'materials': [], 'syncStatus': 'not_needed'}

def queued(index, queue, **extra):
    # Names run opposite to the queue order, so a sort by name would show.
    row = {'id': 'q%02d' % index, 'revision': 'q%02d-r1' % index, 'type': 'job', 'customerId': 'c-q%02d' % index, 'customer': 'Synthetic Queue %02d' % (QUEUED - index), 'phone': '(970) 555-0101',
           'address': '%d Synthetic Lane, Loveland, CO' % index, 'date': '', 'time': '', 'endDate': '', 'endTime': '', 'startAt': None, 'endAt': None, 'status': 'unscheduled', 'assignedCrew': [],
           'crewLead': None, 'crewId': None, 'vehicleId': None, 'crewNeeded': 1, 'travelBufferMinutes': 20, 'serviceType': 'Garage transformation', 'jobInstructions': 'Synthetic scope.',
           'requiredEquipment': [], 'materials': [], 'syncStatus': 'not_needed', 'queue': queue}
    row.update(extra)
    return row

def board():
    rows = [queued(1, {'since': '2026-09-02T16:00:00.000Z', 'sinceKind': 'sold', 'ageDays': 20, 'source': 'walkthrough'},
                   moneyReady={'checked': True, 'hasApprovedPrice': True, 'priceStatus': 'approved', 'depositRequiredCents': 45000, 'depositPaidCents': 0, 'depositDueCents': 45000, 'depositVerified': None}),
            queued(2, {'since': '2026-09-10T18:00:00.000Z', 'sinceKind': 'approved', 'ageDays': 12, 'source': 'portal'}, needsDispatchReview=True, dispatchReviewReason='portal_approval', serviceType='Garage organization',
                   moneyReady={'checked': True, 'hasApprovedPrice': True, 'priceStatus': 'approved', 'depositRequiredCents': 30000, 'depositPaidCents': 30000, 'depositDueCents': 0, 'depositVerified': True}),
            queued(3, {'since': '2026-09-15T15:00:00.000Z', 'sinceKind': 'created', 'ageDays': 7, 'source': 'jobber', 'jobber': {'date': '2026-10-08', 'time': '09:00', 'endDate': '2026-10-08', 'endTime': '12:00', 'usable': True, 'past': False}},
                   needsDispatchReview=True, dispatchReviewReason='jobber_import', notify=False, scheduleSource='jobber_import'),
            queued(4, {'since': '2026-09-15T15:00:00.000Z', 'sinceKind': 'created', 'ageDays': 7, 'source': 'jobber', 'jobber': {'date': '2026-09-10', 'time': '13:00', 'endDate': '2026-09-10', 'endTime': '15:00', 'usable': True, 'past': True}},
                   needsDispatchReview=True, dispatchReviewReason='jobber_import', notify=False, scheduleSource='jobber_import', address='')]
    for index in range(5, QUEUED + 1):
        rows.append(queued(index, {'since': '2026-09-%02dT15:00:00.000Z' % min(21, index - 4 + 15), 'sinceKind': 'created', 'ageDays': max(1, 22 - min(21, index - 4 + 15)), 'source': 'hub'}))
    # A sent quote from a walkthrough, not approved yet: undated and active, so it waits here too, marked as unsold work.
    rows[4].update(queue={**rows[4]['queue'], 'source': 'walkthrough'}, sourceWalkthroughId='walk-5',
                   moneyReady={'checked': True, 'hasApprovedPrice': False, 'priceStatus': 'not_approved', 'depositRequiredCents': None, 'depositPaidCents': 0, 'depositDueCents': None, 'depositVerified': None})
    closed = queued(99, {'since': '2026-01-01T15:00:00.000Z', 'sinceKind': 'created', 'ageDays': 264, 'source': 'hub'}, id='closed-undated', customer='Synthetic Closed Garage', status='cancelled')
    del closed['queue']
    # Closed under another spelling: the server sent no queue facts for it, so the page neither counts nor lists it.
    spelled = queued(98, {}, id='closed-spelled', customer='Synthetic Spelled Garage', status='Cancelled')
    del spelled['queue']
    return [scheduled('day-1', '08:00', '10:00', 'Synthetic Morning Garage'), scheduled('day-2', '13:00', '15:00', 'Synthetic Afternoon Garage'), *rows, closed, spelled]

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = (b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated EGC dispatch queue test</title>'
                    b'<link rel="stylesheet" href="/employee-dispatch.css"><link rel="stylesheet" href="/employee-dispatch-calendar.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main>'
                    b'<script src="/employee-dispatch.js"></script><script src="/employee-dispatch-calendar.js"></script><script>EGCDispatch.mount(document.querySelector("#host"))</script></body></html>')
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class DispatchQueueBrowserTests(unittest.TestCase):
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
    def start(self, width=390, height=844, mobile=True):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(10000); self.errors = []; self.calls = []; self.gets = []
        self.page.clock.install(time=DAY + 'T18:00:00Z')
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('**/*', self.route)
    def setUp(self):
        self.jobs = board(); self.money = True; self.context = None
    def tearDown(self):
        if self.context:
            self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
            self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path == '/api/funnel-dimensions': route.fulfill(status=503, content_type='application/json', body='{"ok":false}'); return
        if parsed.path != '/api/dispatch': route.continue_(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if req.method == 'GET':
            params = parse_qs(parsed.query); self.gets.append(params)
            first = params.get('startDate', [DAY])[0]; last = params.get('endDate', ['2026-09-23'])[0]
            rows = [copy.deepcopy(row) for row in self.jobs if not row.get('date') or (row['date'] < last and (row.get('endDate') or row['date']) >= first)]
            if not self.money:
                for row in rows: row.pop('moneyReady', None)
            warnings = [{'code': code, 'jobId': row['id'], 'message': message} for row in rows if not row.get('date') for code, message in GENERIC]
            warnings += [{'code': 'missing_address', 'jobId': row['id'], 'message': 'Add the job address before dispatching the crew.'} for row in rows if not row.get('address')]
            send({'ok': True, 'queueFacts': True, 'viewer': {'id': 'manager.one'}, 'timeZone': 'America/Denver', 'jobs': rows, 'roster': ROSTER, 'crews': [], 'vehicles': [], 'availability': [], 'warnings': warnings,
                  'coverage': {'complete': True, 'asOf': '2026-09-22T14:00:00Z'}, 'startDate': first, 'endDate': last, 'arrivalDefaults': {'enabled': False, 'minutes': 60}}); return
        body = req.post_data_json; self.calls.append(copy.deepcopy(body))
        row = next(row for row in self.jobs if row['id'] == body['jobId'])
        row.update(body.get('changes', {})); row['revision'] += '-next'
        if row.get('date'): row.pop('queue', None); row.pop('needsDispatchReview', None); row['status'] = 'scheduled'
        send({'ok': True, 'requestId': body['requestId'], 'job': row, 'warnings': [], 'providerSync': 'not_needed'})
    def open(self, **viewport):
        self.start(**viewport); self.page.goto(self.url)
        expect(self.page.get_by_role('heading', name='Synthetic Morning Garage', exact=True)).to_be_visible()
    def queue_button(self): return self.page.get_by_role('button', name=re.compile(r'^To schedule \('))
    def rows(self): return self.page.locator('.dp-queue-row')
    def row(self, name): return self.rows().filter(has=self.page.get_by_role('heading', name=name, exact=True)).first
    def no_sideways_scroll(self, width): self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
    def tall(self, locator):
        for box in [item.bounding_box() for item in locator.all() if item.is_visible()]: self.assertGreaterEqual(round(box['height']), 44, box)

    def test_day_view_links_to_the_queue_and_stays_under_three_screens_at_390(self):
        self.open()
        expect(self.queue_button()).to_have_attribute('aria-label', 'To schedule (36)')
        expect(self.page.locator('[data-dp-queue-count]')).to_have_text('36')
        badge = self.page.locator('[data-dp-queue-badge]')
        expect(badge).to_have_text('36 to schedule · 3 new')
        # The old bottom-of-page block is gone: only the day's two jobs are cards, and one line links to the queue.
        expect(self.page.locator('.dp-job')).to_have_count(2); expect(self.page.locator('.dp-unscheduled')).to_have_count(0)
        link = self.page.get_by_role('button', name='36 to schedule →', exact=True); expect(link).to_be_visible()
        height = self.page.evaluate('document.documentElement.scrollHeight')
        self.assertLess(height, 3 * 844, f'Day view is {height}px tall')
        self.no_sideways_scroll(390); self.tall(self.page.locator('.dp-modes .dp-btn, [data-dp-queue-badge], .dp-queue-link button'))
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out / 'dispatch-queue-day-390.png'), full_page=True)
        # Every other view links the same way and shows no queued job as a card.
        for view in ['Week', 'Crew', 'Jobs', 'Month', 'Lanes']:
            with self.subTest(view=view):
                self.page.get_by_role('button', name=view, exact=True).click()
                expect(self.page.get_by_role('button', name='36 to schedule →', exact=True)).to_be_visible()
                expect(self.page.locator('.dp-job').filter(has_text='Synthetic Queue')).to_have_count(0)
                self.no_sideways_scroll(390)
        self.page.get_by_role('button', name='36 to schedule →', exact=True).click()
        expect(self.rows()).to_have_count(36)

    def test_queue_rows_are_oldest_first_compact_and_start_on_the_first_screen(self):
        for width, height, mobile in [(390, 844, True), (1440, 900, False)]:
            with self.subTest(width=width):
                self.open(width=width, height=height, mobile=mobile)
                self.queue_button().click()
                expect(self.rows()).to_have_count(36)
                heading = self.page.get_by_role('heading', name='To schedule · 36', exact=True)
                expect(heading).to_be_focused()
                box = self.rows().first.bounding_box()
                self.assertGreaterEqual(box['y'], 0); self.assertLessEqual(box['y'] + box['height'], height, f'first row at {box} on a {width}x{height} screen')
                # The server's oldest-first order is kept (the names run the other way).
                names = self.page.locator('.dp-queue-row h3').all_text_contents()
                self.assertEqual(names[:4], ['Synthetic Queue 35', 'Synthetic Queue 34', 'Synthetic Queue 33', 'Synthetic Queue 32'])
                self.assertEqual(names, ['Synthetic Queue %02d' % (QUEUED - index) for index in range(1, QUEUED + 1)])
                first = self.row('Synthetic Queue 35')
                expect(first.locator('.dp-queue-age')).to_have_text('20 days'); expect(first).to_contain_text('Sold Sep 2'); expect(first).to_contain_text('Walkthrough')
                expect(first.get_by_role('link', name='Deposit unpaid · $450.00', exact=False)).to_be_visible(); expect(first).to_contain_text('Price approved')
                # The unapproved quote reads as work to price, not as sold work.
                quote = self.row('Synthetic Queue 31')
                expect(quote).to_contain_text('Added Sep 16'); expect(quote.get_by_role('link', name=re.compile('^Price this job for Synthetic Queue 31'))).to_be_visible()
                expect(quote).not_to_contain_text('Not sold yet'); expect(quote).not_to_contain_text('Price approved')
                expect(self.page.locator('.dp-queue-list')).not_to_contain_text('Synthetic Spelled Garage')
                portal = self.row('Synthetic Queue 34')
                expect(portal).to_contain_text('Approved online: needs review'); expect(portal).to_contain_text('Portal approval'); expect(portal).to_contain_text('Approved Sep 10'); expect(portal).to_contain_text('Deposit paid')
                expect(portal.locator('.dp-queue-age')).to_have_text('12 days')
                # The three generic lines are gone from every row; a real problem still shows.
                for _, message in GENERIC: expect(self.page.locator('.dp-queue-list')).not_to_contain_text(message)
                expect(self.row('Synthetic Queue 32')).to_contain_text('Add the job address before dispatching the crew.')
                expect(self.page.locator('.dp-warning')).to_have_count(0)
                self.no_sideways_scroll(width)
                self.tall(self.page.locator('.dp-queue-row button, .dp-queue-row a'))
                out = ROOT / 'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out / f'dispatch-queue-{width}.png'))
                self.context.close(); self.context = None
                self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')

    def test_jobber_rows_show_what_jobber_had_and_use_this_time_prefills_the_editor(self):
        for width, height, mobile in [(390, 844, True), (1440, 900, False)]:
            with self.subTest(width=width):
                self.jobs = board(); self.open(width=width, height=height, mobile=mobile); self.queue_button().click()
                jobber = self.row('Synthetic Queue 33')
                expect(jobber).to_contain_text('Jobber had: Thu, Oct 8 · 9:00 AM – 12:00 PM'); expect(jobber).to_contain_text('From Jobber: needs review'); expect(jobber.locator('.dp-reminders-off')).to_have_text('Reminders off')
                passed = self.row('Synthetic Queue 32')
                expect(passed).to_contain_text('Jobber had: Thu, Sep 10 · 1:00 PM – 3:00 PM · already passed')
                expect(passed.get_by_role('button', name=re.compile('^Use Jobber'))).to_have_count(0)
                jobber.get_by_role('button', name='Use Jobber’s time for Synthetic Queue 33', exact=True).click()
                dialog = self.page.get_by_role('dialog'); expect(dialog).to_have_attribute('aria-label', 'Edit / assign job')
                expect(dialog.get_by_label('Keep unscheduled', exact=True)).not_to_be_checked()
                for label, value in [('Start date', '2026-10-08'), ('Start time', '09:00'), ('End date', '2026-10-08'), ('End time', '12:00')]: expect(dialog.get_by_label(label, exact=True)).to_have_value(value)
                self.assertEqual(self.calls, [], 'nothing is saved until the dispatcher saves')
                self.no_sideways_scroll(width)
                dialog.locator('button[type=submit]').click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
                write = self.calls[-1]
                self.assertEqual((write['action'], write['jobId'], write['expectedRevision']), ('schedule.update', 'q03', 'q03-r1'))
                self.assertEqual([write['changes'][key] for key in ['date', 'time', 'endDate', 'endTime']], ['2026-10-08', '09:00', '2026-10-08', '12:00'])
                expect(self.rows()).to_have_count(35); expect(self.queue_button()).to_have_attribute('aria-label', 'To schedule (35)')
                self.context.close(); self.context = None
                self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')

    def test_schedule_and_find_a_time_open_the_same_dialogs_and_the_status_filter_opens_the_queue(self):
        self.open(width=320, height=700)
        self.page.get_by_label('Filter by status', exact=True).select_option('unscheduled')
        expect(self.rows()).to_have_count(36); expect(self.page.get_by_label('Filter by status', exact=True)).to_have_value('active')
        self.no_sideways_scroll(320)
        self.row('Synthetic Queue 34').get_by_role('button', name='Schedule Synthetic Queue 34', exact=True).click()
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_have_attribute('aria-label', 'Edit / assign job'); expect(dialog.get_by_label('Keep unscheduled', exact=True)).to_be_checked()
        dialog.get_by_role('button', name='Back', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.row('Synthetic Queue 34').get_by_role('button', name='Find a time for Synthetic Queue 34', exact=True).click()
        expect(self.page.get_by_role('dialog')).to_have_attribute('aria-label', 'Find a time for Synthetic Queue 34')
        self.page.get_by_role('button', name='Back', exact=True).click()
        # Search narrows the queue; the header badge reopens it from any view.
        self.page.get_by_role('searchbox', name='Search jobs', exact=True).fill('Queue 34'); expect(self.rows()).to_have_count(1)
        self.page.get_by_role('searchbox', name='Search jobs', exact=True).fill('')
        self.page.get_by_role('button', name='Day', exact=True).click(); expect(self.rows()).to_have_count(0)
        self.page.locator('[data-dp-queue-badge]').click(); expect(self.rows()).to_have_count(36)
        self.assertEqual(self.calls, [])

    def test_a_viewer_without_money_sees_the_queue_without_deposit_chips(self):
        self.money = False; self.open(width=1440, height=900, mobile=False); self.queue_button().click()
        expect(self.rows()).to_have_count(36)
        expect(self.page.locator('.dp-queue-list')).not_to_contain_text('Deposit')
        expect(self.page.locator('.dp-queue-list')).not_to_contain_text('$')
        expect(self.page.locator('.dp-queue-list')).not_to_contain_text('Price')
        # Without prices, unsold quote work is still told apart from sold work; Hub and Jobber work is not labelled.
        expect(self.row('Synthetic Queue 31').locator('.dp-queue-unsold')).to_have_text('Not sold yet')
        expect(self.page.locator('.dp-queue-unsold')).to_have_count(1)

if __name__ == '__main__': unittest.main()
