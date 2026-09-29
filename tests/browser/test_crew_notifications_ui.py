"""Schedule alerts screen (EGCCrewNotifications) mounted standalone with the Hub UI kit against a fake
/api/crew-notifications. Phone-first (375x812, Asia/Tokyo device clock), no external network."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
NOW = '2026-09-22T18:00:00.000Z'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
PAGE = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-crew-notifications.css"><title>Schedule alerts</title></head>
<body style="margin:0;background:#f1f0ec"><main id="host" style="padding:16px"></main>
<script src="/employee-ui-kit.js"></script><script src="/employee-crew-notifications.js"></script>
<script>sessionStorage.setItem('egc_u','synthetic.crew');window.EGCCrewNotifications.mount(document.getElementById('host'),__CTX__);</script></body></html>'''
CREW_CTX = "{identity:'Synthetic.Crew'}"
DISPATCHER_CTX = "{identity:'Synthetic.Crew',capabilities:['crew','business']}"


def slot(date, time, end, segment=''):
    return {'segmentId': segment, 'date': date, 'time': time, 'endDate': date, 'endTime': end}


def notices():
    return [
        {'id': 'crew_' + 'b' * 40, 'intent': 'time_changed', 'jobId': 'job-2', 'jobType': 'job', 'serviceType': 'Garage cleanout', 'slot': slot('2026-09-24', '13:00', '15:00'),
         'slots': [slot('2026-09-24', '13:00', '15:00')], 'previousSlots': [slot('2026-09-24', '09:00', '12:00')], 'createdAt': '2026-09-22T17:30:00.000Z', 'delivery': 'texted', 'acknowledged': False},
        {'id': 'crew_' + 'a' * 40, 'intent': 'assigned', 'jobId': 'job-1', 'jobType': 'job', 'serviceType': 'Garage organization with a long synthetic service name that must wrap on a phone', 'slot': slot('2026-09-23', '08:00', '10:00', 'a'),
         'slots': [slot('2026-09-23', '08:00', '10:00', 'a')], 'previousSlots': [], 'createdAt': '2026-09-22T17:00:00.000Z', 'delivery': 'queued', 'acknowledged': False},
        {'id': 'crew_' + 'c' * 40, 'intent': 'cancelled', 'jobId': 'job-3', 'jobType': 'walkthrough', 'serviceType': '', 'slot': slot('2026-09-25', '10:00', '11:00'),
         'slots': [], 'previousSlots': [slot('2026-09-25', '10:00', '11:00')], 'createdAt': '2026-09-22T16:00:00.000Z', 'delivery': 'not_texted', 'acknowledged': False},
    ]


def team():
    return {'ok': True, 'authority': 'employee_hub', 'timeZone': 'America/Denver', 'viewer': {'id': 'synthetic.crew'}, 'coverage': {'complete': True, 'asOf': NOW},
            'team': [{'id': 'crew1', 'name': 'Casey Crew', 'sms': True, 'smsUpdatedAt': NOW, 'staffContactId': 'staff-1', 'staffContactLinkedAt': NOW, 'revision': 'p1'},
                     {'id': 'crew2', 'name': 'Riley Other with a long synthetic surname', 'sms': False, 'smsUpdatedAt': '', 'staffContactId': '', 'staffContactLinkedAt': '', 'revision': ''}],
            'attention': [{'id': 'crew_' + 'e' * 40, 'intent': 'assigned', 'jobId': 'job-5', 'jobType': 'job', 'serviceType': '', 'slot': slot('2026-09-24', '09:00', '12:00'), 'slots': [slot('2026-09-24', '09:00', '12:00')],
                           'previousSlots': [], 'lostSlots': [], 'createdAt': NOW, 'delivery': 'not_texted', 'acknowledged': False, 'employeeId': 'crew2', 'employeeName': 'Riley Other with a long synthetic surname',
                           'status': 'needs_contact', 'reason': 'staff_contact_not_linked', 'attempts': 1, 'updatedAt': NOW, 'canRetry': True},
                          {'id': 'crew_' + 'f' * 40, 'intent': 'unassigned', 'jobId': 'job-6', 'jobType': 'job', 'serviceType': '', 'slot': slot('2026-09-25', '09:00', '12:00'), 'slots': [],
                           'previousSlots': [slot('2026-09-25', '09:00', '12:00')], 'lostSlots': [slot('2026-09-25', '09:00', '12:00')], 'createdAt': NOW, 'delivery': 'unconfirmed', 'acknowledged': False,
                           'employeeId': 'crew1', 'employeeName': 'Casey Crew', 'status': 'uncertain', 'reason': 'no_provider_response', 'attempts': 1, 'updatedAt': NOW, 'canRetry': False}]}


class Handler(SimpleHTTPRequestHandler):
    ctx = CREW_CTX
    def log_message(self, *args): pass
    def do_GET(self):
        path = urlparse(self.path).path
        if path not in ('/crew-alerts-test.html', '/crew-alerts-dispatcher.html'): return super().do_GET()
        page = PAGE.replace('__CTX__', DISPATCHER_CTX if path == '/crew-alerts-dispatcher.html' else CREW_CTX)
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(page.encode())


class CrewNotificationsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/crew-alerts-test.html'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        RESULTS.mkdir(exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.errors = []; self.posts = []; self.rows = notices(); self.completed = {}
        self.prefs = {'sms': False, 'revision': '', 'updatedAt': '', 'phone': '(•••) •••-0155', 'phoneStatus': 'on_file'}
        self.read_failures = []; self.lose_next_post = False
        self.team = team(); self.team_reads = 0; self.retry_replaced = False; self.retry_regrouped = []
        self.context = None

    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def open(self, width=375, height=812, page='crew-alerts-test.html'):
        if self.context: self.context.close()
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(6000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.clock.install(time=NOW)
        self.page.route('**/*', self.route)
        self.page.goto(self.url.replace('crew-alerts-test.html', page))
        return self.page

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/crew-notifications': route.continue_(); return
        def send(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        if request.method == 'GET' and parsed.query == 'view=team':
            self.team_reads += 1; send(copy.deepcopy(self.team)); return
        if request.method == 'GET':
            if self.read_failures:
                status, code = self.read_failures.pop(0); send({'ok': False, 'code': code, 'error': 'Synthetic failure for ' + code}, status); return
            send({'ok': True, 'authority': 'employee_hub', 'timeZone': 'America/Denver', 'viewer': {'id': 'synthetic.crew'}, 'notices': copy.deepcopy(self.rows),
                  'preferences': copy.deepcopy(self.prefs), 'coverage': {'complete': True, 'asOf': NOW}}); return
        body = request.post_data_json; self.posts.append(copy.deepcopy(body))
        if body['requestId'] in self.completed: send(self.completed[body['requestId']]); return
        if body['action'] == 'link_staff_contact':
            member = next(row for row in self.team['team'] if row['id'] == body['employeeId'])
            member.update(staffContactId=body['contactId'], revision='p9')
            response = {'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'member': copy.deepcopy(member)}
        elif body['action'] == 'retry':
            self.team['attention'] = [row for row in self.team['attention'] if row['id'] not in body['ids']]
            replaced = body['ids'] if self.retry_replaced else []
            response = {'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'retried': [value for value in body['ids'] if value not in replaced], 'superseded': replaced, 'regrouped': list(self.retry_regrouped), 'alreadyApplied': False}
        elif body['action'] == 'acknowledge':
            self.rows = [row for row in self.rows if row['id'] not in body['ids']]
            response = {'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'acknowledged': body['ids'], 'alreadyApplied': False}
        else:
            if body['expectedRevision'] != self.prefs['revision']:
                send({'ok': False, 'code': 'crew_notifications_revision_conflict', 'error': 'Your text settings changed on another device. Refresh and try again.'}, 409); return
            self.prefs.update(sms=body['sms'], revision=f'rev-{len(self.posts)}', updatedAt=NOW)
            response = {'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'preferences': copy.deepcopy(self.prefs)}
        self.completed[body['requestId']] = response
        if self.lose_next_post: self.lose_next_post = False; route.abort('connectionfailed'); return
        send(response)

    def fits(self, width):
        return self.page.evaluate('''()=>{const html=document.documentElement;html.style.overflowX='visible';document.body.style.overflowX='visible';
          return {width:html.scrollWidth,wide:[...document.querySelectorAll('#host *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>el.tagName+'.'+el.className).slice(0,5)}}''')

    def small_targets(self):
        return self.page.evaluate('''()=>[...document.querySelectorAll('#host button,#host input[type=checkbox]')].map(el=>el.matches('input')?el.closest('label'):el)
          .filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height<43.5}).map(el=>el.textContent.trim().slice(0,30)+' '+Math.round(el.getBoundingClientRect().height))''')

    def test_notices_show_denver_wall_times_and_fit_phone_widths(self):
        for width in (320, 375, 390):
            page = self.open(width)
            expect(page.get_by_role('heading', name='Schedule alerts', exact=True)).to_be_visible()
            cards = page.locator('.ca-notice')
            expect(cards).to_have_count(3)
            expect(cards.nth(0)).to_contain_text('Job moved')
            expect(cards.nth(0).locator('.ca-when')).to_have_text('Now: Thu, Sep 24 · 1:00 PM–3:00 PM')
            expect(cards.nth(0).locator('.ca-was')).to_have_text('Was: Thu, Sep 24 · 9:00 AM–12:00 PM')
            expect(cards.nth(0)).to_contain_text('Texted')
            expect(cards.nth(1)).to_contain_text('New job')
            expect(cards.nth(1).locator('.ca-when')).to_have_text('Wed, Sep 23 · 8:00 AM–10:00 AM')
            expect(cards.nth(1)).to_contain_text('Text queued')
            expect(cards.nth(2)).to_contain_text('Job cancelled')
            expect(cards.nth(2).locator('.ca-when')).to_have_text('Fri, Sep 25 · 10:00 AM–11:00 AM')
            expect(page.get_by_text('Texts go to (•••) •••-0155 from your employee account.')).to_be_visible()
            self.assertNotRegex(page.locator('#host').inner_text(), r'\b(null|undefined)\b', 'no empty slot renders as text')
            size = self.fits(width)
            self.assertLessEqual(size['width'], width, size['wide'])
            self.assertEqual(self.small_targets(), [])
            page.screenshot(path=str(RESULTS / f'crew-alerts-{width}.png'), full_page=True)
        self.assertEqual(self.posts, [], 'loading the screen never writes or sends anything')

    def test_got_it_and_mark_all_read_acknowledge_only_the_chosen_notices(self):
        page = self.open()
        page.locator('.ca-notice').nth(1).get_by_role('button', name=re.compile('^Clear notice: New job')).click()
        expect(page.locator('.ca-notice')).to_have_count(2)
        expect(page.locator('.ca-status')).to_have_text('Notice cleared.')
        self.assertEqual([post['action'] for post in self.posts], ['acknowledge'])
        self.assertEqual(self.posts[0]['ids'], ['crew_' + 'a' * 40])
        self.assertRegex(self.posts[0]['requestId'], UUID)
        page.get_by_role('button', name='Mark all read').click()
        expect(page.locator('.ca-empty')).to_have_text('No new schedule changes. Your jobs are in My Day.')
        self.assertEqual(sorted(self.posts[1]['ids']), ['crew_' + 'b' * 40, 'crew_' + 'c' * 40])

    def test_text_opt_in_saves_with_the_revision_and_a_lost_response_retries_the_same_request(self):
        page = self.open()
        box = page.get_by_label('Text me when my schedule changes')
        save = page.get_by_role('button', name='Save text setting')
        expect(save).to_be_disabled()
        box.check()
        expect(save).to_be_enabled()
        self.lose_next_post = True
        save.click()
        expect(page.get_by_role('button', name='Retry saved change')).to_be_visible()
        self.assertEqual(self.posts[0]['action'], 'set_preferences')
        self.assertEqual((self.posts[0]['sms'], self.posts[0]['expectedRevision']), (True, ''))
        page.get_by_role('button', name='Retry saved change').click()
        expect(page.locator('.ca-status')).to_have_text('Your saved change was confirmed.')
        self.assertEqual(self.posts[1]['requestId'], self.posts[0]['requestId'], 'the retry replays the original request')
        expect(page.get_by_label('Text me when my schedule changes')).to_be_checked()
        page.get_by_label('Text me when my schedule changes').uncheck()
        page.get_by_role('button', name='Save text setting').click()
        expect(page.locator('.ca-status')).to_have_text('Schedule texts are off.')
        self.assertEqual((self.posts[2]['sms'], self.posts[2]['expectedRevision']), (False, 'rev-1'))
        self.assertNotEqual(self.posts[2]['requestId'], self.posts[0]['requestId'])

    def test_a_failed_load_is_unavailable_with_retry_and_the_flag_off_says_so(self):
        self.read_failures = [(503, 'crew_notifications_unavailable')]
        page = self.open()
        alert = page.get_by_role('alert')
        expect(alert).to_contain_text('Schedule alerts are unavailable')
        expect(page.locator('.ca-notice')).to_have_count(0)
        alert.get_by_role('button', name='Retry').click()
        expect(page.locator('.ca-notice')).to_have_count(3)
        self.read_failures = [(503, 'crew_notifications_not_enabled')]
        page = self.open()
        expect(page.get_by_role('alert')).to_contain_text('Schedule alerts are off')
        expect(page.get_by_role('alert')).to_contain_text('Schedule alerts are not turned on for this Hub yet.')
        expect(page.get_by_role('alert').get_by_role('button')).to_have_count(0)

    def test_a_partial_removal_shows_the_lost_day_and_the_days_still_worked(self):
        self.rows = [{'id': 'crew_' + 'd' * 40, 'intent': 'unassigned', 'jobId': 'job-4', 'jobType': 'job', 'serviceType': '', 'slot': slot('2026-09-24', '13:00', '17:00', 'b'),
                      'slots': [slot('2026-09-23', '08:00', '12:00', 'a')], 'previousSlots': [slot('2026-09-23', '08:00', '12:00', 'a'), slot('2026-09-24', '13:00', '17:00', 'b')],
                      'lostSlots': [slot('2026-09-24', '13:00', '17:00', 'b')], 'createdAt': NOW, 'delivery': 'texted', 'acknowledged': False},
                     {'id': 'crew_' + '1' * 40, 'intent': 'assigned', 'jobId': 'job-7', 'jobType': 'job', 'serviceType': '', 'slot': slot('2026-10-01', '09:00', '12:00'),
                      'slots': [slot('2026-10-01', '09:00', '12:00')], 'previousSlots': [], 'lostSlots': [], 'createdAt': NOW, 'delivery': 'grouped', 'acknowledged': False}]
        page = self.open()
        card = page.locator('.ca-notice').nth(0)
        expect(card).to_contain_text('Removed from a day')
        expect(card.locator('.ca-when')).to_have_text('No longer: Thu, Sep 24 · 1:00 PM–5:00 PM')
        expect(card.locator('.ca-still')).to_have_text('Still scheduled: Wed, Sep 23 · 8:00 AM–12:00 PM')
        expect(page.locator('.ca-notice').nth(1)).to_contain_text('In one text with your other new visits')
        expect(page.get_by_role('heading', name='Crew texts')).to_have_count(0)
        self.assertEqual(self.team_reads, 0, 'crew never load the dispatcher view')

    def test_a_move_that_also_took_a_day_away_shows_both_and_a_replaced_notice_is_not_resent(self):
        self.rows = [{'id': 'crew_' + '2' * 40, 'intent': 'time_changed', 'jobId': 'job-8', 'jobType': 'job', 'serviceType': '', 'slot': slot('2026-09-23', '10:00', '12:00', 'a'),
                      'slots': [slot('2026-09-23', '10:00', '12:00', 'a')], 'previousSlots': [slot('2026-09-23', '09:00', '12:00', 'a'), slot('2026-09-24', '09:00', '12:00', 'b')],
                      'lostSlots': [slot('2026-09-24', '09:00', '12:00', 'b')], 'createdAt': NOW, 'delivery': 'texted', 'acknowledged': False}]
        self.retry_replaced = True
        for width in (320, 375):
            self.team = team(); self.posts = []
            page = self.open(width, page='crew-alerts-dispatcher.html')
            card = page.locator('.ca-notice').nth(0)
            expect(card).to_contain_text('Job moved')
            expect(card.locator('.ca-when')).to_have_text('Now: Wed, Sep 23 · 10:00 AM–12:00 PM')
            expect(card.locator('.ca-lost')).to_have_text('No longer: Thu, Sep 24 · 9:00 AM–12:00 PM')
            expect(card.locator('.ca-was')).to_have_text('Was: Wed, Sep 23 · 9:00 AM–12:00 PM; Thu, Sep 24 · 9:00 AM–12:00 PM')
            size = self.fits(width)
            self.assertLessEqual(size['width'], width, size['wide'])
            self.assertEqual(self.small_targets(), [])
        page.locator('[data-attention]').nth(0).get_by_role('button', name=re.compile('^Send again')).click()
        expect(page.locator('.ca-status')).to_have_text('A newer change for this job already replaced it, so it was closed instead of sent again.')
        self.assertEqual((self.posts[0]['action'], self.posts[0]['ids']), ('retry', ['crew_' + 'e' * 40]))
        page.screenshot(path=str(RESULTS / 'crew-alerts-moved-and-lost.png'), full_page=True)

    def test_a_text_that_carried_older_changes_shows_them_all_and_what_it_covered_says_so(self):
        was = [slot('2026-09-23', '09:00', '12:00', 'a'), slot('2026-09-24', '09:00', '12:00', 'b')]
        # Removed from Thursday (not texted: no contact yet), then Wednesday moved to 10:00: one text said both.
        carrier = {'id': 'crew_' + '3' * 40, 'intent': 'time_changed', 'jobId': 'job-9', 'jobType': 'job', 'serviceType': '', 'slot': slot('2026-09-23', '10:00', '12:00', 'a'),
                   'slots': [slot('2026-09-23', '10:00', '12:00', 'a')], 'previousSlots': [was[0]], 'heardSlots': was, 'lostSlots': [was[1]], 'createdAt': NOW, 'delivery': 'texted', 'acknowledged': False}
        covered = {'id': 'crew_' + '4' * 40, 'intent': 'unassigned', 'jobId': 'job-9', 'jobType': 'job', 'serviceType': '', 'slot': was[1], 'slots': [was[0]], 'previousSlots': was, 'heardSlots': None,
                   'lostSlots': [was[1]], 'createdAt': '2026-09-22T17:00:00.000Z', 'delivery': 'covered', 'acknowledged': False}
        self.rows = [carrier, covered]
        crew = {'employeeId': 'crew1', 'employeeName': 'Casey Crew', 'reason': 'staff_contact_not_linked', 'attempts': 1, 'updatedAt': NOW}
        self.team['attention'] = [{**carrier, **crew, 'id': 'crew_' + '5' * 40, 'delivery': 'not_texted', 'status': 'needs_contact', 'covered': False, 'canRetry': True},
                                  {**covered, **crew, 'id': 'crew_' + '6' * 40, 'delivery': 'covered', 'status': 'needs_contact', 'covered': True, 'canRetry': True}]
        base = copy.deepcopy(self.team)
        for width in (320, 375):
            self.team = copy.deepcopy(base)
            page = self.open(width, page='crew-alerts-dispatcher.html')
            card = page.locator('[data-notice="crew_' + '3' * 40 + '"]')
            expect(card.locator('.ca-when')).to_have_text('Now: Wed, Sep 23 · 10:00 AM–12:00 PM')
            expect(card.locator('.ca-lost')).to_have_text('No longer: Thu, Sep 24 · 9:00 AM–12:00 PM')
            expect(card.locator('.ca-was')).to_have_text('Was: Wed, Sep 23 · 9:00 AM–12:00 PM; Thu, Sep 24 · 9:00 AM–12:00 PM')
            expect(card).to_contain_text('Texted')
            expect(page.locator('[data-notice="crew_' + '4' * 40 + '"]')).to_contain_text('In a later text')
            unsent = page.locator('[data-attention]')
            expect(unsent.nth(0).locator('.ca-lost')).to_have_text('No longer: Thu, Sep 24 · 9:00 AM–12:00 PM')
            expect(unsent.nth(0)).to_contain_text('No HighLevel staff contact is linked for them.')
            expect(unsent.nth(1)).to_contain_text('A later text already told them about this change, so Send again only clears it.')
            size = self.fits(width)
            self.assertLessEqual(size['width'], width, size['wide'])
            self.assertEqual(self.small_targets(), [])
            page.screenshot(path=str(RESULTS / f'crew-alerts-carried-{width}.png'), full_page=True)
        self.assertEqual(self.posts, [])

    def test_a_change_read_in_the_hub_says_so_and_a_closed_grouped_text_queues_its_visits(self):
        was = [slot('2026-09-23', '09:00', '12:00', 'a'), slot('2026-09-24', '09:00', '12:00', 'b')]
        # Removed from Thursday (not texted), then the employee read the Wednesday move in the Hub instead of a text.
        read = {'id': 'crew_' + '7' * 40, 'intent': 'unassigned', 'jobId': 'job-9', 'jobType': 'job', 'serviceType': '', 'slot': was[1], 'slots': [was[0]], 'previousSlots': was, 'heardSlots': None,
                'lostSlots': [was[1]], 'createdAt': '2026-09-22T17:00:00.000Z', 'delivery': 'read_in_hub', 'acknowledged': False}
        grouped = {'id': 'crew_' + '8' * 40, 'intent': 'assigned', 'jobId': 'job-10', 'jobType': 'job', 'serviceType': '', 'slot': slot('2026-09-24', '09:00', '12:00'), 'slots': [slot('2026-09-24', '09:00', '12:00')],
                   'previousSlots': [], 'lostSlots': [], 'createdAt': NOW, 'delivery': 'not_texted', 'acknowledged': False}
        self.rows = [read]
        crew = {'employeeId': 'crew1', 'employeeName': 'Casey Crew', 'attempts': 1, 'updatedAt': NOW}
        self.team['attention'] = [{**grouped, **crew, 'status': 'needs_contact', 'reason': 'staff_contact_not_linked', 'covered': False, 'canRetry': True},
                                  {**read, **crew, 'status': 'needs_contact', 'reason': 'staff_contact_not_linked', 'covered': True, 'coveredVia': 'hub', 'canRetry': True},
                                  {**grouped, **crew, 'id': 'crew_' + '9' * 40, 'jobId': 'job-11', 'status': 'failed', 'reason': 'messaging_sms_too_long', 'covered': False, 'canRetry': True}]
        self.retry_replaced = True; self.retry_regrouped = ['crew_' + '0' * 40, 'crew_' + 'd' * 40]
        page = self.open(375, page='crew-alerts-dispatcher.html')
        expect(page.locator('[data-notice="crew_' + '7' * 40 + '"]')).to_contain_text('Read in the Hub')
        unsent = page.locator('[data-attention]')
        expect(unsent.nth(1)).to_contain_text('They read a later notice for this job in the Hub, so Send again only clears it.')
        expect(unsent.nth(2)).to_contain_text('Shorten it at Message templates, then send again.')
        size = self.fits(375)
        self.assertLessEqual(size['width'], 375, size['wide'])
        self.assertEqual(self.small_targets(), [])
        unsent.nth(0).get_by_role('button', name=re.compile('^Send again')).click()
        expect(page.locator('.ca-status')).to_have_text('A newer change for this job already replaced it, so it was closed. The other visits it stood for were queued to be texted.')
        self.assertEqual((self.posts[0]['action'], self.posts[0]['ids']), ('retry', ['crew_' + '8' * 40]))
        page.screenshot(path=str(RESULTS / 'crew-alerts-read-in-hub.png'), full_page=True)

    def test_dispatchers_link_staff_contacts_and_send_unsent_notices_again_on_a_phone(self):
        for width in (320, 375, 390):
            self.team = team(); self.posts = []
            page = self.open(width, page='crew-alerts-dispatcher.html')
            expect(page.get_by_role('heading', name='Crew texts')).to_be_visible()
            unsent = page.locator('[data-attention]')
            expect(unsent).to_have_count(2)
            expect(unsent.nth(0)).to_contain_text('No HighLevel staff contact is linked for them.')
            expect(unsent.nth(1)).to_contain_text('Not confirmed')
            expect(unsent.nth(1).get_by_role('button')).to_have_count(0)
            members = page.locator('[data-member]')
            expect(members.nth(0)).to_contain_text('Texts on')
            expect(members.nth(0)).to_contain_text('Staff contact linked')
            expect(members.nth(1)).to_contain_text('No staff contact')
            size = self.fits(width)
            self.assertLessEqual(size['width'], width, size['wide'])
            self.assertEqual(self.small_targets(), [])
            page.screenshot(path=str(RESULTS / f'crew-alerts-dispatcher-{width}.png'), full_page=True)
        members.nth(1).get_by_role('button', name=re.compile('^Link HighLevel contact for Riley')).click()
        box = page.get_by_label('HighLevel contact ID')
        expect(box).to_be_focused()
        self.assertEqual(box.evaluate('el=>getComputedStyle(el).fontSize'), '16px')
        box.fill('bad id!')
        page.get_by_role('button', name='Save contact').click()
        expect(page.get_by_role('alert').first).to_contain_text('letters, numbers')
        self.assertEqual(self.posts, [])
        box.fill(' staff-2 ')
        page.get_by_role('button', name='Save contact').click()
        expect(page.locator('.ca-status')).to_have_text('Staff contact linked for Riley Other with a long synthetic surname.')
        self.assertEqual((self.posts[0]['action'], self.posts[0]['employeeId'], self.posts[0]['contactId'], self.posts[0]['expectedRevision']), ('link_staff_contact', 'crew2', 'staff-2', ''))
        self.assertRegex(self.posts[0]['requestId'], UUID)
        expect(page.locator('[data-member]').nth(1)).to_contain_text('HighLevel contact staff-2')
        page.locator('[data-attention]').nth(0).get_by_role('button', name=re.compile('^Send again')).click()
        expect(page.locator('[data-attention]')).to_have_count(1)
        self.assertEqual((self.posts[1]['action'], self.posts[1]['ids']), ('retry', ['crew_' + 'e' * 40]))


if __name__ == '__main__':
    unittest.main()
