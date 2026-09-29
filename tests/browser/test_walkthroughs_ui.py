"""Hub Walkthroughs (WT-OUTCOME) on a phone against isolated /api/dispatch contract fixtures; no provider or customer writes.
The screen mounts alone with the real dispatch module, whose dialogs it reuses for Book, Reschedule, Rebook and Cancel."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-22'
ROSTER = [{'id': 'sales.rep', 'name': 'Synthetic Sales Rep', 'role': 'sales'}, {'id': 'crew.one', 'name': 'Crew One', 'role': 'crew'}]
FUNNEL = {'visitPurposes': ['service', 'install', 'return', 'rework'], 'bookingChannels': ['hub_phone', 'hub_in_person'], 'selfReportedChannels': ['google_search', 'referral', 'other'],
          'crmLinkReasons': ['crm_sync_pending', 'other'], 'initiatedBy': ['customer', 'company'],
          'reasonCodes': {'cancel': ['customer_changed_plans', 'weather', 'other'], 'reschedule': ['customer_request', 'weather', 'crew_unavailable', 'previous_job_overran', 'access_issue', 'vehicle_or_equipment', 'other'], 'noShow': ['customer_not_home', 'no_access', 'unreachable', 'wrong_address', 'other']}}

def walk(id, customer, date, time, end, **extra):
    row = {'id': id, 'revision': id+'-rev', 'type': 'walkthrough', 'customerId': 'customer-'+id, 'customer': customer, 'phone': '(970) 555-0101', 'address': '100 Synthetic Lane, Fort Collins, CO',
           'date': date, 'time': time, 'endDate': date, 'endTime': end, 'startAt': date+'T'+time+':00-06:00' if date else None, 'endAt': date+'T'+end+':00-06:00' if date else None,
           'status': 'scheduled', 'assignedCrew': ['sales.rep'], 'crewLead': None, 'crewId': None, 'vehicleId': None, 'crewNeeded': 1, 'travelBufferMinutes': 20, 'serviceType': 'Free walkthrough',
           'jobInstructions': '', 'requiredEquipment': [], 'materials': [], 'arrivalWindowStart': None, 'arrivalWindowEnd': None, 'arrivalWindow': ''}
    row.update(extra)
    return row

def rows():
    return [
        walk('w-upcoming', 'Synthetic Upcoming Garage', '2026-09-23', '14:00', '15:00', arrivalWindowStart='13:30', arrivalWindowEnd='14:30', arrivalWindow='1:30 PM - 2:30 PM', syncStatus='synced'),
        walk('w-overdue', 'Synthetic Overdue Garage', DAY, '08:00', '09:00', syncStatus='error'),
        walk('w-noshow', 'Synthetic No-show Garage', DAY, '10:00', '11:00', walkthroughOutcome={'outcome': 'customer_no_show', 'reasonCode': 'no_access', 'finishedAt': DAY+'T16:30:00Z'}, rebookPending=False,
             walkthroughState='no_show', walkthroughClosed=False, walkthroughBadge='No-show · rebook', convertedJobId=None, rebook={'reasonCode': 'access_issue', 'initiatedBy': 'customer', 'label': 'No access', 'missedOn': DAY}),
        walk('w-lost', 'Synthetic Lost Garage', '2026-09-18', '09:00', '10:00', walkthroughOutcome={'outcome': 'not_interested', 'reasonCode': 'price', 'finishedAt': '2026-09-18T16:00:00Z'}, rebookPending=False,
             walkthroughState='lost', walkthroughClosed=True, walkthroughBadge='Lost: Price', convertedJobId=None),
        walk('w-sold', 'Synthetic Sold Garage', '2026-09-19', '09:00', '10:00', walkthroughOutcome={'outcome': 'sold_on_site', 'reasonCode': None, 'finishedAt': '2026-09-19T16:00:00Z'}, rebookPending=False,
             walkthroughState='sold', walkthroughClosed=True, walkthroughBadge='Sold → open job', convertedJobId='job-sold'),
        walk('w-unscheduled', 'Synthetic Unscheduled Lead', '', '', '', assignedCrew=[]),
        walk('w-cancelled', 'Synthetic Cancelled Garage', DAY, '15:00', '16:00', status='cancelled'),
        walk('w-old', 'Synthetic Old Garage', '2026-08-20', '09:00', '10:00'),
        {'id': 'job-1', 'revision': 'job-rev', 'type': 'job', 'customer': 'Synthetic Service Job', 'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '10:00', 'status': 'scheduled', 'assignedCrew': ['crew.one']},
    ]

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = (b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated Hub walkthroughs test</title>'
                    b'<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-dispatch.css"><link rel="stylesheet" href="/employee-walkthroughs.css"></head>'
                    b'<body style="margin:0;padding:12px;background:#f1f0ec"><main id="host"></main><script src="/employee-dispatch.js"></script><script src="/employee-walkthroughs.js"></script>'
                    b'<script>EGCWalkthroughs.mount(document.querySelector("#host"))</script></body></html>')
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class WalkthroughsBrowserTests(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000); self.errors = []; self.gets = []; self.calls = []; self.jobs = rows(); self.read_status = 200
        self.page.clock.install(time=DAY + 'T18:00:00Z')
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
        self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/dispatch': route.continue_(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if req.method == 'GET':
            params = parse_qs(parsed.query); self.gets.append(params)
            if self.read_status != 200: send({'ok': False, 'code': 'dispatch_unavailable', 'error': 'Dispatch could not complete this request. Keep your changes and retry.'}, self.read_status); return
            first = params.get('startDate', [DAY])[0]; last = params.get('endDate', ['2026-09-23'])[0]
            listed = [row for row in self.jobs if not row.get('date') or first <= row['date'] < last]
            send({'ok': True, 'viewer': {'id': 'zacb'}, 'timeZone': 'America/Denver', 'jobs': copy.deepcopy(listed), 'roster': ROSTER, 'crews': [], 'vehicles': [], 'availability': [], 'warnings': [],
                  'coverage': {'complete': True, 'asOf': DAY+'T18:00:00Z'}, 'startDate': first, 'endDate': last, 'arrivalDefaults': {'enabled': False}, 'funnel': FUNNEL}); return
        body = req.post_data_json; self.calls.append(copy.deepcopy(body)); action = body['action']
        if action == 'schedule.create':
            row = walk('w-new', 'Synthetic Booked Garage', body['changes']['date'], body['changes']['time'], body['changes']['endTime']); self.jobs.append(row)
        else:
            row = next(row for row in self.jobs if row['id'] == body['jobId']); row.update(body.get('changes', {})); row['revision'] += '-next'
            if action == 'schedule.cancel': row['status'] = 'cancelled'
        send({'ok': True, 'requestId': body['requestId'], 'job': row, 'warnings': [], 'providerSync': 'not_needed'})
    def open(self):
        self.page.goto(self.url); expect(self.page.get_by_role('heading', name='Walkthroughs', exact=True)).to_be_visible()
        expect(self.card('Synthetic Upcoming Garage')).to_be_visible()
    def card(self, name): return self.page.locator('.wt-card').filter(has=self.page.get_by_role('heading', name=name, exact=True))
    def fits(self, *widths):
        for width in widths:
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, width)
            small = self.page.evaluate("""()=>[...document.querySelectorAll('.egc-walkthroughs a.hub-btn,.egc-walkthroughs button,.wt-address')].filter(n=>n.offsetParent).map(n=>[n.textContent.trim(),n.getBoundingClientRect().height]).filter(([,h])=>h<44)""")
            self.assertEqual(small, [], f'tap targets under 44px at {width}px')

    def test_rep_12_hour_time_arrival_window_and_tel_link_on_a_phone(self):
        self.open()
        self.assertEqual([self.gets[0]['startDate'], self.gets[0]['endDate'], self.gets[0]['includeUnscheduled']], [['2026-09-08'], ['2026-11-22'], ['true']])
        header = self.page.locator('.wt-head')
        expect(header.get_by_role('button').first).to_have_text('Book walkthrough'); expect(header.get_by_role('button', name='Book walkthrough', exact=True)).to_have_class(re.compile('primary'))
        upcoming = self.card('Synthetic Upcoming Garage')
        for text in ['Wed, Sep 23', '2:00 PM – 3:00 PM', 'Arrival 1:30 PM – 2:30 PM', 'Rep: Synthetic Sales Rep']: expect(upcoming).to_contain_text(text)
        expect(upcoming.get_by_role('link', name='Call Synthetic Upcoming Garage', exact=True)).to_have_attribute('href', 'tel:9705550101')
        expect(upcoming.get_by_role('link', name='Start walkthrough', exact=True)).to_have_attribute('href', '/crew/gameplan.html?walkthroughId=w-upcoming')
        overdue = self.card('Synthetic Overdue Garage'); expect(overdue.locator('.wt-badge')).to_have_text('Overdue: record outcome')
        expect(overdue.get_by_role('link', name='Record outcome', exact=True)).to_have_attribute('href', '/crew/gameplan.html?walkthroughId=w-overdue')
        noshow = self.card('Synthetic No-show Garage'); expect(noshow.locator('.wt-badge')).to_have_text('No-show · rebook')
        expect(noshow.get_by_role('button', name='Rebook Synthetic No-show Garage', exact=True)).to_be_visible(); expect(noshow.get_by_text('Start walkthrough')).to_have_count(0)
        attention = self.page.locator('[data-group=attention]'); expect(attention.locator('.wt-card')).to_have_count(2)
        outcomes = self.page.locator('[data-group=outcomes]')
        expect(outcomes.locator('.wt-card')).to_have_count(2)
        expect(self.card('Synthetic Lost Garage').locator('.wt-badge')).to_have_text('Lost: Price')
        expect(self.card('Synthetic Sold Garage').get_by_role('link', name='Open job', exact=True)).to_have_attribute('href', '/crew/job.html?jobId=job-sold')
        for closed in ['Synthetic Lost Garage', 'Synthetic Sold Garage']:
            expect(self.card(closed).get_by_text('Start walkthrough')).to_have_count(0); expect(self.card(closed).get_by_role('button', name=re.compile('^(Reschedule|Cancel)'))).to_have_count(0)
        expect(self.card('Synthetic Unscheduled Lead')).to_contain_text('Needs a time'); expect(self.card('Synthetic Unscheduled Lead')).to_contain_text('Rep not assigned')
        for hidden in ['Synthetic Cancelled Garage', 'Synthetic Old Garage', 'Synthetic Service Job']: expect(self.page.get_by_text(hidden)).to_have_count(0)
        self.fits(375, 320, 390)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.set_viewport_size({'width': 375, 'height': 812}); self.page.screenshot(path=str(out/'hub-walkthroughs-375.png'), full_page=True)

    def test_reschedule_and_cancel_reuse_the_dispatch_dialogs(self):
        self.open(); before = len(self.gets)
        self.card('Synthetic Upcoming Garage').get_by_role('button', name='Reschedule Synthetic Upcoming Garage', exact=True).click()
        dialog = self.page.get_by_role('dialog'); expect(dialog.get_by_role('heading', name='Edit / assign job', exact=True)).to_be_visible()
        self.fits(375, 320); self.page.set_viewport_size({'width': 375, 'height': 812})
        dialog.get_by_label('Start date', exact=True).fill('2026-09-24')
        dialog.get_by_role('combobox', name='Reason', exact=True).select_option('customer_request'); dialog.get_by_role('combobox', name='Who asked for it?', exact=True).select_option('customer')
        dialog.get_by_role('button', name='Save changes', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        write = self.calls[-1]
        self.assertEqual([write['action'], write['jobId'], write['expectedRevision'], write['changes']['date'], write['reasonCode']], ['schedule.update', 'w-upcoming', 'w-upcoming-rev', '2026-09-24', 'customer_request'])
        expect(self.page.get_by_role('status').filter(has_text='Job updated.')).to_be_visible(); self.assertGreater(len(self.gets), before + 1, 'the list reloads after the save')
        self.card('Synthetic Overdue Garage').get_by_role('button', name='Cancel the walkthrough for Synthetic Overdue Garage', exact=True).click()
        dialog = self.page.get_by_role('dialog'); expect(dialog.get_by_role('heading', name='Cancel job', exact=True)).to_be_visible()
        dialog.get_by_role('combobox', name='Reason', exact=True).select_option('customer_changed_plans'); dialog.get_by_role('combobox', name='Who asked for it?', exact=True).select_option('customer')
        dialog.get_by_role('button', name='Cancel job', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual([self.calls[-1]['action'], self.calls[-1]['jobId'], self.calls[-1]['reasonCode']], ['schedule.cancel', 'w-overdue', 'customer_changed_plans'])
        expect(self.card('Synthetic Overdue Garage')).to_have_count(0)

    def test_rebook_prefills_the_move_and_book_walkthrough_opens_a_walkthrough_booking(self):
        self.open()
        self.card('Synthetic No-show Garage').get_by_role('button', name='Rebook Synthetic No-show Garage', exact=True).click()
        dialog = self.page.get_by_role('dialog'); expect(dialog.get_by_role('heading', name='Rebook walkthrough', exact=True)).to_be_visible()
        expect(dialog.locator('[data-rebook]')).to_contain_text('No-show on Tue, Sep 22 (No access)')
        dialog.get_by_label('Start date', exact=True).fill('2026-09-25')
        expect(dialog.get_by_role('combobox', name='Reason', exact=True)).to_have_value('access_issue'); expect(dialog.get_by_role('combobox', name='Who asked for it?', exact=True)).to_have_value('customer')
        dialog.get_by_role('button', name='Save new time', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual([self.calls[-1]['action'], self.calls[-1]['jobId'], self.calls[-1]['reasonCode'], self.calls[-1]['initiatedBy']], ['schedule.update', 'w-noshow', 'access_issue', 'customer'])
        self.page.locator('.wt-head').get_by_role('button', name='Book walkthrough', exact=True).click()
        dialog = self.page.get_by_role('dialog'); expect(dialog.get_by_role('heading', name='Create job', exact=True)).to_be_visible()
        expect(dialog.get_by_role('combobox', name='Work type', exact=True)).to_have_value('walkthrough')
        dialog.get_by_role('button', name='Back', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(len([call for call in self.calls if call['action'] == 'schedule.create']), 0, 'closing the booking form saves nothing')

    def test_unavailable_list_is_an_error_with_retry_never_an_empty_list(self):
        self.read_status = 503; self.page.goto(self.url)
        expect(self.page.get_by_role('alert')).to_contain_text('Dispatch could not complete this request')
        expect(self.page.get_by_text('No walkthroughs booked')).to_have_count(0)
        self.read_status = 200; self.page.get_by_role('button', name='Retry', exact=True).click()
        expect(self.card('Synthetic Upcoming Garage')).to_be_visible(); expect(self.page.get_by_role('alert')).to_have_count(0)

    # WT-OUTCOME review: the HighLevel sync the built-in view showed, with the Hub's own retry when the suite is loaded.
    def test_cards_show_the_highlevel_sync_and_retry_it_inside_the_hub(self):
        self.page.add_init_script('window.opsRetrySync=async id=>{(window.retried||=[]).push(id)}')
        self.open()
        upcoming = self.card('Synthetic Upcoming Garage'); expect(upcoming.locator('.wt-sync')).to_have_text('HighLevel synced')
        expect(upcoming.get_by_role('button', name=re.compile('^Retry the HighLevel sync'))).to_have_count(0)
        overdue = self.card('Synthetic Overdue Garage'); expect(overdue.locator('.wt-sync-state')).to_have_text('HighLevel sync failed')
        expect(self.card('Synthetic No-show Garage').locator('.wt-sync')).to_have_count(0)
        self.fits(375, 320); self.page.set_viewport_size({'width': 375, 'height': 812}); before = len(self.gets)
        overdue.get_by_role('button', name='Retry the HighLevel sync for Synthetic Overdue Garage', exact=True).click()
        self.page.wait_for_function('window.retried?.length===1'); self.assertEqual(self.page.evaluate('window.retried'), ['w-overdue'])
        expect(overdue.get_by_role('button', name='Retry the HighLevel sync for Synthetic Overdue Garage', exact=True)).to_be_enabled()
        self.assertGreater(len(self.gets), before, 'the list reloads after the retry')
        self.assertEqual(self.calls, [], 'no dispatch write')

    def test_standalone_screen_shows_the_sync_without_a_retry(self):
        self.open()
        expect(self.card('Synthetic Overdue Garage').locator('.wt-sync-state')).to_have_text('HighLevel sync failed')
        expect(self.page.get_by_role('button', name=re.compile('^Retry the HighLevel sync'))).to_have_count(0)

    def test_an_unreadable_saved_dispatch_request_says_why_nothing_opened(self):
        self.page.add_init_script("sessionStorage.setItem('egc.dispatch.pending.v1.zacb','{not json')")
        self.open()
        reschedule = self.card('Synthetic Upcoming Garage').get_by_role('button', name='Reschedule Synthetic Upcoming Garage', exact=True); reschedule.click()
        expect(self.page.get_by_role('alert')).to_contain_text('A saved dispatch request in this browser could not be read')
        expect(self.page.get_by_role('dialog')).to_have_count(0); expect(reschedule).to_be_enabled()
        self.assertEqual(self.calls, [])

    def test_the_dialog_stays_open_when_the_hub_unmounts_the_board_and_closes_on_sign_out(self):
        # employee-suite.js render() calls EGCDispatch.unmount() on every redraw while another screen is showing.
        self.open()
        self.card('Synthetic Upcoming Garage').get_by_role('button', name='Reschedule Synthetic Upcoming Garage', exact=True).click()
        dialog = self.page.get_by_role('dialog'); expect(dialog.get_by_role('heading', name='Edit / assign job', exact=True)).to_be_visible()
        self.page.evaluate('EGCDispatch.unmount()'); expect(dialog).to_be_visible()
        dialog.get_by_label('Start date', exact=True).fill('2026-09-24')
        dialog.get_by_role('combobox', name='Reason', exact=True).select_option('weather'); dialog.get_by_role('combobox', name='Who asked for it?', exact=True).select_option('company')
        dialog.get_by_role('button', name='Save changes', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual([self.calls[-1]['action'], self.calls[-1]['jobId'], self.calls[-1]['changes']['date']], ['schedule.update', 'w-upcoming', '2026-09-24'])
        expect(self.page.get_by_role('status').filter(has_text='Job updated.')).to_be_visible()
        self.card('Synthetic Overdue Garage').get_by_role('button', name='Reschedule Synthetic Overdue Garage', exact=True).click()
        expect(self.page.get_by_role('dialog')).to_be_visible()
        self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))"); expect(self.page.get_by_role('dialog')).to_have_count(0)

if __name__ == '__main__': unittest.main(verbosity=2)
