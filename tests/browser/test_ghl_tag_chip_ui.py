"""GHL-TRACK-1: the dispatch card's HighLevel chip and the Cancel / No-show dialog copy at 390 px, on the real dispatch
module against a routed fake /api/dispatch and /api/ghl-tag-drain. The clock is fixed and the browser runs in
Asia/Tokyo to prove the Denver time on the chip. Every non-127.0.0.1 request is aborted."""
import copy, json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
DAY = '2026-09-22'
ROSTER = [{'id': 'crew.one', 'name': 'Crew One', 'role': 'crew'}]
FUNNEL = {'visitPurposes': ['service'], 'bookingChannels': ['hub_phone'], 'selfReportedChannels': ['other'], 'crmLinkReasons': ['other'], 'initiatedBy': ['customer', 'company'],
          'reasonCodes': {'cancel': ['customer_changed_plans', 'other'], 'reschedule': ['customer_request', 'other'], 'noShow': ['customer_not_home', 'other']}}
ENTRY = lambda n: {'id': 'gto_' + str(n) * 40, 'kind': 'scheduled', 'startAt': DAY + 'T14:00:00.000Z', 'requestId': '00000000-0000-4000-8000-00000000000' + str(n), 'queuedAt': DAY + 'T13:00:00.000Z'}
def job(id, customer, time, end, **changes):
    row = {'id': id, 'revision': id + '-r1', 'type': 'job', 'customerId': 'c-' + id, 'customer': customer, 'address': '1 Synthetic Way, Fort Collins, CO', 'date': DAY, 'time': time, 'endDate': DAY, 'endTime': end,
           'startAt': DAY + 'T' + time + ':00-06:00', 'endAt': DAY + 'T' + end + ':00-06:00', 'status': 'scheduled', 'assignedCrew': ['crew.one'], 'crewLead': 'crew.one', 'crewNeeded': 1,
           'serviceType': 'Garage cleanout', 'jobInstructions': 'Synthetic scope', 'syncStatus': 'pending'}
    row.update(changes)
    return row
def jobs():
    return [job('job-told', 'Synthetic Told Garage', '08:00', '09:00', ghlTagEntry=ENTRY(1), ghlTags={'status': 'done', 'doneAt': DAY + 'T20:14:00.000Z', 'skipped': None, 'attempts': 1, 'nextAttemptAt': None, 'lastError': None}),
            job('job-waiting', 'Synthetic Waiting Garage', '09:30', '10:30', ghlTagEntry=ENTRY(2), ghlTags={'status': 'pending', 'doneAt': None, 'skipped': None, 'attempts': 0, 'nextAttemptAt': DAY + 'T18:00:00.000Z', 'lastError': None}),
            job('job-stuck', 'Synthetic Stuck Garage With A Very Long Customer Name For Phones', '11:00', '12:00', ghlTagEntry=ENTRY(3), ghlTags={'status': 'parked', 'doneAt': None, 'skipped': None, 'attempts': 8, 'nextAttemptAt': None, 'lastError': 'highlevel_503'}),
            job('job-legacy', 'Synthetic Legacy Garage', '13:00', '14:00')]

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/widget':
            body = b'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated HighLevel tag widget</title><link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-ghl-tags.css"></head><body style="margin:0;background:#f4f3ef"><main style="padding:16px"><section id="host" class="hub-home-widget"></section></main><script src="/employee-ghl-tags.js"></script><script>EGCGhlTagsStuck.mount(document.querySelector("#host"),{})</script></body></html>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body); return
        if self.path == '/':
            body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated HighLevel chip test</title><link rel="stylesheet" href="/employee-dispatch.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main><script src="/employee-dispatch.js"></script><script>EGCDispatch.mount(document.querySelector("#host"))</script></body></html>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class GhlTagChipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        RESULTS.mkdir(exist_ok=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 390, 'height': 844}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.errors = []; self.retries = []; self.writes = []; self.jobs = jobs(); self.outbox = True
        self.page.clock.install(time=DAY + 'T18:00:00Z')
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
        self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/ghl-tag-drain':
            body = req.post_data_json; self.retries.append(body)
            for row in self.jobs:
                if row['id'] == body.get('jobId') and row.get('ghlTags', {}).get('status') == 'parked': row['ghlTags'] = {**row['ghlTags'], 'status': 'pending', 'attempts': 0, 'lastError': None}
            send({'ok': True, 'requestId': body['requestId'], 'requeued': 1, 'ids': [ENTRY(3)['id']]}); return
        if parsed.path != '/api/dispatch': route.continue_(); return
        if req.method == 'GET':
            params = parse_qs(parsed.query); first = params.get('startDate', [DAY])[0]; last = params.get('endDate', ['2026-09-29'])[0]
            send({'ok': True, 'viewer': {'id': 'manager.one'}, 'timeZone': 'America/Denver', 'jobs': copy.deepcopy(self.jobs), 'roster': ROSTER, 'crews': [], 'vehicles': [], 'availability': [], 'warnings': [],
                  'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'startDate': first, 'endDate': last, 'arrivalDefaults': {'enabled': False, 'minutes': 60}, 'funnel': FUNNEL, **({'ghlTagOutbox': True} if self.outbox else {})}); return
        self.writes.append(req.post_data_json); send({'ok': False, 'code': 'dispatch_unavailable', 'error': 'Synthetic: no write in this test'}, 503)
    def open(self):
        self.page.goto(self.url)
        self.page.get_by_label('Schedule date', exact=True).fill(DAY)
        expect(self.page.get_by_role('heading', name='Synthetic Told Garage', exact=True)).to_be_visible()
    def card(self, name): return self.page.locator('.dp-job').filter(has=self.page.get_by_role('heading', name=name, exact=True)).first
    def no_horizontal_scroll(self):
        return self.page.evaluate('''()=>{const html=document.documentElement;return{width:html.scrollWidth,viewport:innerWidth,wide:[...document.querySelectorAll('#host *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1}).slice(0,5).map(el=>el.tagName+'.'+String(el.className).slice(0,40))}}''')

    def test_the_card_chip_shows_told_waiting_and_stuck_with_retry_at_390(self):
        self.open()
        expect(self.card('Synthetic Told Garage').locator('.dp-ghl')).to_have_text('HighLevel told 2:14 PM')
        expect(self.card('Synthetic Waiting Garage').locator('.dp-ghl')).to_have_text('HighLevel waiting')
        stuck = self.card('Synthetic Stuck Garage With A Very Long Customer Name For Phones').locator('.dp-ghl')
        expect(stuck).to_contain_text('HighLevel stuck')
        expect(self.card('Synthetic Legacy Garage').locator('.dp-ghl')).to_have_count(0)
        retry = stuck.get_by_role('button', name='Retry telling HighLevel about Synthetic Stuck Garage With A Very Long Customer Name For Phones')
        self.assertGreaterEqual(retry.bounding_box()['height'], 44)
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 390, scroll); self.assertEqual(scroll['wide'], [])
        self.page.screenshot(path=str(RESULTS / 'ghl-tag-chip-390.png'), full_page=True)
        retry.click()
        expect(self.page.locator('.dp-notice').first).to_contain_text('HighLevel will be told again in a moment.')
        expect(self.card('Synthetic Stuck Garage With A Very Long Customer Name For Phones').locator('.dp-ghl')).to_have_text('HighLevel waiting')
        self.assertEqual(len(self.retries), 1)
        self.assertEqual({key: self.retries[0][key] for key in ('action', 'jobId')}, {'action': 'retry', 'jobId': 'job-stuck'})
        self.assertRegex(self.retries[0]['requestId'], r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        self.assertEqual(self.writes, [], 'the chip never saves the visit')

    def test_an_overdue_change_shows_stuck_with_retry_and_one_the_visit_moved_past_shows_nothing(self):
        # The tag worker stopped: a pending change well past its turn is stuck, not 'waiting'. A parked change the visit
        # has moved past (current false: its start passed) closes untold, so the card shows nothing for it.
        self.jobs += [job('job-overdue', 'Synthetic Overdue Garage', '14:30', '15:30', ghlTagEntry=ENTRY(4), ghlTags={'status': 'pending', 'doneAt': None, 'skipped': None, 'attempts': 0, 'nextAttemptAt': DAY + 'T15:00:00.000Z', 'lastError': None, 'overdue': True, 'current': True}),
                      job('job-past', 'Synthetic Past Garage', '06:00', '07:00', ghlTagEntry=ENTRY(5), ghlTags={'status': 'parked', 'doneAt': None, 'skipped': None, 'attempts': 8, 'nextAttemptAt': None, 'lastError': 'highlevel_503', 'overdue': False, 'current': False})]
        self.jobs[1]['ghlTags'].update({'overdue': False, 'current': True})
        self.open()
        overdue = self.card('Synthetic Overdue Garage').locator('.dp-ghl')
        expect(overdue).to_contain_text('HighLevel stuck')
        expect(overdue).to_have_attribute('data-ghl', 'overdue')
        expect(self.card('Synthetic Waiting Garage').locator('.dp-ghl')).to_have_text('HighLevel waiting')
        expect(self.card('Synthetic Past Garage').locator('.dp-ghl')).to_have_count(0)
        retry = overdue.get_by_role('button', name='Retry telling HighLevel about Synthetic Overdue Garage')
        self.assertGreaterEqual(retry.bounding_box()['height'], 44)
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 390, scroll); self.assertEqual(scroll['wide'], [])
        self.page.screenshot(path=str(RESULTS / 'ghl-tag-chip-overdue-390.png'), full_page=True)
        retry.click()
        expect(self.page.locator('.dp-notice').first).to_contain_text('HighLevel will be told again in a moment.')
        self.assertEqual([(row['action'], row['jobId']) for row in self.retries], [('retry', 'job-overdue')])
        self.assertEqual(self.writes, [])

    def test_cancel_and_no_show_dialogs_say_highlevel_will_be_told(self):
        self.open()
        self.card('Synthetic Told Garage').get_by_role('button', name='Cancel', exact=True).click()
        dialog = self.page.get_by_role('dialog')
        expect(dialog.locator('[data-ghl-note]')).to_have_text('HighLevel will be told (appointment marked cancelled). Your HighLevel workflow decides what the customer hears.')
        scroll = self.no_horizontal_scroll(); self.assertLessEqual(scroll['width'], 390, scroll)
        self.page.screenshot(path=str(RESULTS / 'ghl-tag-cancel-dialog-390.png'), full_page=True)
        dialog.get_by_role('button', name='Back', exact=True).click()
        expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.card('Synthetic Told Garage').get_by_role('button', name='No-show', exact=True).click()
        dialog = self.page.get_by_role('dialog')
        expect(dialog.locator('[data-ghl-note]')).to_have_text('HighLevel will be told (appointment marked no-show). Your HighLevel workflow decides what the customer hears.')
        expect(dialog).not_to_contain_text('does not message the customer or change the CRM appointment')
        self.assertEqual(self.writes, [])

    def test_flag_off_shows_no_chip_and_keeps_todays_dialog_copy(self):
        self.outbox = False
        self.open()
        expect(self.page.locator('.dp-ghl')).to_have_count(0)
        self.card('Synthetic Told Garage').get_by_role('button', name='No-show', exact=True).click()
        dialog = self.page.get_by_role('dialog')
        expect(dialog).to_contain_text('This does not message the customer or change the CRM appointment.')
        expect(dialog.locator('[data-ghl-note]')).to_have_count(0)


class GhlTagStuckWidgetTests(unittest.TestCase):
    """The Command center line 'HighLevel tags stuck for N visits' with Retry, mounted on its own page."""
    @classmethod
    def setUpClass(cls):
        GhlTagChipTests.setUpClass.__func__(cls)
    @classmethod
    def tearDownClass(cls):
        GhlTagChipTests.tearDownClass.__func__(cls)
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.errors = []; self.posts = []; self.answers = [(200, {'ok': True, 'enabled': True, 'visits': 2, 'entries': 3, 'jobIds': ['a', 'b'], 'asOf': DAY + 'T18:00:00Z', 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}})]
        self.page.clock.install(time=DAY + 'T18:00:00Z')
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('**/*', self.route)
    tearDown = GhlTagChipTests.tearDown
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/ghl-tag-drain': route.continue_(); return
        if req.method == 'POST':
            self.posts.append(req.post_data_json)
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'requestId': req.post_data_json['requestId'], 'requeued': 3, 'ids': []})); return
        status, body = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

    def test_stuck_visits_show_with_retry_and_clear_after_it(self):
        self.page.goto(self.url + '/widget')
        widget = self.page.locator('#host')
        expect(widget.get_by_role('heading', name='HighLevel tags stuck for 2 visits')).to_be_visible()
        retry = widget.get_by_role('button', name='Retry', exact=True)
        self.assertGreaterEqual(retry.bounding_box()['height'], 44)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.page.screenshot(path=str(RESULTS / 'ghl-tag-stuck-widget-375.png'), full_page=True)
        self.answers = [(200, {'ok': True, 'enabled': True, 'visits': 0, 'entries': 0, 'jobIds': [], 'asOf': DAY + 'T18:01:00Z', 'coverage': {'complete': True, 'asOf': DAY + 'T18:01:00Z'}})]
        retry.click()
        expect(widget).to_be_hidden()
        self.assertEqual([post['action'] for post in self.posts], ['retry'])
        self.assertNotIn('jobId', self.posts[0])

    def test_a_stopped_tag_worker_shows_even_with_nothing_stuck_and_beside_stuck_visits(self):
        stale = {'lastRunAt': DAY + 'T16:00:00.000Z', 'minutesSince': 120, 'stale': True}
        self.answers = [(200, {'ok': True, 'enabled': True, 'visits': 0, 'entries': 0, 'parked': 0, 'overdue': 0, 'jobIds': [], 'drain': stale, 'asOf': DAY + 'T18:00:00Z', 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}})]
        self.page.goto(self.url + '/widget')
        widget = self.page.locator('#host')
        expect(widget.get_by_role('heading', name='The HighLevel tag worker has not run for 2 hours')).to_be_visible()
        expect(widget).to_contain_text('Check egc-worker on Railway (EGC_GHL_TAG_DRAIN_ENABLED=true).')
        expect(widget.get_by_role('button', name='Retry', exact=True)).to_have_count(0)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.page.screenshot(path=str(RESULTS / 'ghl-tag-worker-stopped-375.png'), full_page=True)
        self.answers = [(200, {'ok': True, 'enabled': True, 'visits': 1, 'entries': 1, 'parked': 0, 'overdue': 1, 'jobIds': ['a'], 'drain': {'lastRunAt': None, 'minutesSince': None, 'stale': True}, 'asOf': DAY + 'T18:00:00Z', 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}})]
        self.page.evaluate('EGCGhlTagsStuck.refresh()')
        expect(widget.get_by_role('heading', name='HighLevel tags stuck for 1 visit')).to_be_visible()
        expect(widget.locator('[data-gt-worker]')).to_contain_text('The HighLevel tag worker has not run yet.')
        expect(widget.locator('[data-gt-worker]')).to_contain_text('Retry tells HighLevel up to 5 visits at a time.')
        expect(widget.get_by_role('button', name='Retry', exact=True)).to_be_visible()
        self.answers = [(200, {'ok': True, 'enabled': True, 'visits': 0, 'entries': 0, 'parked': 0, 'overdue': 0, 'jobIds': [], 'drain': {'lastRunAt': DAY + 'T17:58:00.000Z', 'minutesSince': 2, 'stale': False}, 'asOf': DAY + 'T18:00:00Z', 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}})]
        self.page.evaluate('EGCGhlTagsStuck.refresh()')
        expect(widget).to_be_hidden()
        self.assertEqual(self.posts, [])

    def test_switched_off_stays_hidden_and_a_failed_check_is_never_zero(self):
        self.answers = [(200, {'ok': True, 'enabled': False})]
        self.page.goto(self.url + '/widget')
        self.page.wait_for_function('document.querySelector("#host").hidden===true')
        expect(self.page.locator('#host')).to_be_hidden()
        self.answers = [(503, {'ok': False, 'code': 'ghl_tag_unavailable', 'error': 'Synthetic outage'}), (200, {'ok': True, 'enabled': True, 'visits': 1, 'entries': 1, 'jobIds': ['a'], 'asOf': DAY + 'T18:00:00Z', 'coverage': {'complete': False, 'asOf': DAY + 'T18:00:00Z'}})]
        self.page.evaluate('EGCGhlTagsStuck.refresh()')
        alert = self.page.get_by_role('alert')
        expect(alert).to_contain_text('HighLevel tag status is unavailable')
        expect(alert).to_contain_text('This is not a count of zero.')
        alert.get_by_role('button', name='Check again', exact=True).click()
        expect(self.page.get_by_role('heading', name='HighLevel tags stuck for 1 visit')).to_be_visible()
        expect(self.page.locator('#host')).to_contain_text('More stuck entries may exist than this count shows.')
        self.assertEqual(self.posts, [])

    def test_a_viewer_who_may_not_manage_dispatch_sees_nothing_not_a_failed_check(self):
        self.answers = [(403, {'ok': False, 'code': 'ghl_tag_forbidden', 'error': 'Only an operations manager or owner can see HighLevel tag status.'})]
        self.page.goto(self.url + '/widget')
        self.page.evaluate('EGCGhlTagsStuck.refresh()')  # resolves once the 403 answer has been rendered
        expect(self.page.locator('#host')).to_be_hidden()
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.assertEqual(self.page.evaluate('document.querySelector("#host").childElementCount'), 0)


if __name__ == '__main__':
    unittest.main()
