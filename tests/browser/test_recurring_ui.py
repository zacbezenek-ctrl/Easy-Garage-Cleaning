"""Recurring plan UI launched from native dispatch, against an isolated contract fixture; no provider/customer writes."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-22'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
CUSTOMER = 'Synthetic Johnson Garage'
ROSTER = [{'id': 'crew.one', 'name': 'Crew One', 'role': 'crew'}, {'id': 'crew.two', 'name': 'Crew Two', 'role': 'crew'}, {'id': 'lead.one', 'name': 'Lead One', 'role': 'crew_lead'}]
CREWS = [{'id': 'crew-main', 'revision': 'crew-rev-1', 'name': 'North Crew', 'memberIds': ['crew.one', 'lead.one'], 'leadId': 'lead.one', 'status': 'active'}]
VEHICLES = [{'id': 'truck-1', 'revision': 'truck-rev-1', 'name': 'Box Truck', 'status': 'available', 'notes': ''}]
JOB = {'id': 'job-1', 'revision': 'rev-1', 'type': 'job', 'customerId': 'customer-1', 'customer': CUSTOMER, 'address': '123 Synthetic Way, Fort Collins, CO', 'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '10:00',
       'startAt': DAY + 'T14:00:00Z', 'endAt': DAY + 'T16:00:00Z', 'status': 'scheduled', 'assignedCrew': ['crew.one', 'lead.one'], 'crewLead': 'lead.one', 'crewId': 'crew-main', 'vehicleId': 'truck-1', 'crewNeeded': 2, 'serviceType': 'Garage cleanout', 'syncStatus': 'not_needed'}

def plan(**changes):
    row = {'id': 'plan-1', 'revision': 'plan-rev-1', 'status': 'active', 'customerId': 'customer-1', 'customer': CUSTOMER, 'address': JOB['address'], 'templateJobId': 'job-1',
           'cadence': {'frequency': 'weekly'}, 'cadenceLabel': 'Every week', 'startDate': '2026-09-23', 'time': '08:00', 'endTime': '10:00', 'spanDays': 0, 'endsOn': None, 'count': None, 'skipDates': [], 'horizonDays': 56,
           'assignment': {'assignedCrew': ['crew.one', 'lead.one'], 'crewLead': 'lead.one', 'crewId': 'crew-main', 'vehicleId': 'truck-1'}, 'occurrences': [],
           'upcoming': [{'date': '2026-09-23', 'state': 'template', 'jobId': 'job-1'}, {'date': '2026-09-30', 'state': 'scheduled', 'jobId': 'occ-1'}, {'date': '2026-10-07', 'state': 'conflict', 'jobId': 'occ-2'}, {'date': '2026-10-14', 'state': 'not_generated', 'jobId': None}],
           'attention': [{'date': '2026-10-07', 'jobId': 'occ-2', 'state': 'conflict'}], 'finished': False, 'warnings': [], 'lastRun': None, 'timeZone': 'America/Denver'}
    row.update(changes)
    return row

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated EGC recurring test</title><link rel="stylesheet" href="/employee-dispatch.css"><link rel="stylesheet" href="/employee-recurring.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main><script src="/employee-dispatch.js"></script><script src="/employee-recurring.js"></script><script>EGCDispatch.mount(document.querySelector("#host"))</script></body></html>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class RecurringBrowserTests(unittest.TestCase):
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
    def start(self, width=1360, height=950):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', has_touch=width < 700, is_mobile=width < 700)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000); self.errors = []
        self.page.clock.install(time=DAY + 'T18:00:00Z')
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('**/*', self.route)
    def setUp(self):
        self.calls = []; self.receipts = {}; self.plans = []; self.enabled = True; self.lost_once = False; self.fail_once = None; self.revision = 1
        self.extend_script = []; self.update_warnings = []; self.context = None
    def tearDown(self):
        if self.context:
            self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
            self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/dispatch':
            send({'ok': True, 'viewer': {'id': 'manager.one'}, 'timeZone': 'America/Denver', 'jobs': [JOB], 'roster': ROSTER, 'crews': CREWS, 'vehicles': VEHICLES, 'availability': [], 'warnings': [], 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'startDate': DAY, 'endDate': '2026-09-29'}); return
        if parsed.path != '/api/recurring-plans': route.continue_(); return
        if req.method == 'GET':
            if parse_qs(parsed.query).get('view') == ['status']: send({'ok': True, 'enabled': self.enabled}); return
            send({'ok': True, 'enabled': self.enabled, 'timeZone': 'America/Denver', 'plans': self.plans, 'roster': ROSTER, 'crews': CREWS, 'vehicles': VEHICLES, 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'viewer': {'id': 'manager.one'}}); return
        body = req.post_data_json; self.calls.append(copy.deepcopy(body))
        if self.fail_once:
            status, code, error = self.fail_once; self.fail_once = None
            send({'ok': False, 'code': code, 'error': error}, status); return
        if body['requestId'] in self.receipts: send({**self.receipts[body['requestId']], 'replayed': True}); return
        action = body['action']; response = {'ok': True, 'requestId': body['requestId'], 'warnings': [], 'created': [], 'conflicts': [], 'blocked': None, 'complete': True, 'retryable': False}
        def bump(row): self.revision += 1; row['revision'] = f'plan-rev-{self.revision}'
        if action == 'create':
            fields = body['plan']; row = plan(status='active', cadence=fields['cadence'], cadenceLabel='Every 2 weeks' if fields['cadence']['frequency'] == 'biweekly' else 'Every week', count=fields.get('count'), endsOn=fields.get('endsOn'), skipDates=fields.get('skipDates', []), horizonDays=fields.get('horizonDays'), assignment=fields['assignment'], upcoming=[], attention=[], pricePerVisitCents=fields.get('pricePerVisitCents'))
            self.plans = [row]; response['plan'] = row
        else:
            row = next(item for item in self.plans if item['id'] == body['planId'])
            if body['expectedRevision'] != row['revision']: send({'ok': False, 'code': 'recurring_revision_conflict', 'error': 'This recurring plan changed while you were editing.'}, 409); return
            if action == 'extend':
                step = self.extend_script.pop(0) if self.extend_script else {'created': [], 'conflicts': [], 'complete': True}
                bump(row); response.update(step)
            elif action in ('pause', 'resume', 'end'):
                row['status'] = {'pause': 'paused', 'resume': 'active', 'end': 'ended'}[action]; bump(row)
                response['warnings'] = [{'code': 'generated_visits_unchanged', 'message': 'Visits already on the schedule were not cancelled.'}]
            else:
                row.update({key: value for key, value in body['plan'].items() if key != 'assignment'}); row['assignment'] = body['plan']['assignment']; bump(row)
                response['warnings'] = copy.deepcopy(self.update_warnings)
            response['plan'] = row
        self.receipts[body['requestId']] = copy.deepcopy(response)
        if self.lost_once: self.lost_once = False; route.abort('connectionfailed'); return
        send(response)
    def open_dispatch(self):
        self.page.goto(self.url)
        expect(self.page.get_by_role('heading', name=CUSTOMER, exact=True)).to_be_visible()
    def dialog(self): return self.page.locator('dialog.rp-dialog')
    def open_plans(self):
        self.page.get_by_role('button', name='Recurring plans', exact=True).click()
        expect(self.dialog().get_by_role('heading', name='Recurring plans', exact=True)).to_be_visible()

    def test_repeat_from_dispatch_creates_plan_and_adds_rolling_visits(self):
        self.start()
        occurrence = lambda i, date: {**JOB, 'id': f'occ-{i}', 'revision': 'o1', 'date': date, 'endDate': date}
        self.extend_script = [{'created': [occurrence(1, '2026-10-07'), occurrence(2, '2026-10-21')], 'conflicts': [], 'complete': False},
                              {'created': [occurrence(3, '2026-11-04'), {**JOB, 'id': 'occ-4', 'revision': 'o1', 'date': '', 'endDate': '', 'time': '', 'endTime': '', 'status': 'unscheduled'}], 'conflicts': [{'date': '2026-11-18', 'jobId': 'occ-4', 'code': 'dispatch_conflict', 'message': 'Crew busy'}], 'complete': True}]
        self.open_dispatch()
        self.page.get_by_role('button', name='Repeat ' + CUSTOMER + ' on a schedule').click()
        dialog = self.dialog()
        expect(dialog.get_by_role('heading', name='Repeat this job', exact=True)).to_be_visible()
        expect(dialog.get_by_label('First visit', exact=True)).to_have_value(DAY)
        expect(dialog.get_by_label('Start time', exact=True)).to_have_value('08:00')
        expect(dialog.get_by_label('Crew One', exact=True)).to_be_checked(); expect(dialog.get_by_label('Crew Two', exact=True)).not_to_be_checked()
        dialog.get_by_label('Repeats', exact=True).select_option('biweekly')
        expect(dialog.get_by_label('Monthly pattern', exact=True)).to_be_hidden()
        dialog.get_by_label('Ends', exact=True).select_option('after')
        dialog.get_by_label('Number of visits', exact=True).fill('6')
        dialog.get_by_label('Skip a date', exact=True).fill('2026-11-25')
        dialog.get_by_role('button', name='Add skipped date', exact=True).click()
        expect(dialog.get_by_role('button', name='Remove skipped date Wed, Nov 25, 2026')).to_be_visible()
        dialog.get_by_role('button', name='Start recurring plan', exact=True).click()
        expect(dialog.get_by_role('status').filter(has_text='3 visits added to the schedule')).to_be_visible()
        expect(dialog.get_by_role('status').filter(has_text='1 visit conflicted with other work')).to_be_visible()
        expect(dialog.locator('[data-plan="plan-1"]')).to_contain_text('Every 2 weeks')
        self.assertEqual([call['action'] for call in self.calls], ['create', 'extend', 'extend'])
        create = self.calls[0]
        self.assertTrue(UUID.match(create['requestId']))
        self.assertEqual(create['plan'], {'templateJobId': 'job-1', 'cadence': {'frequency': 'biweekly'}, 'startDate': DAY, 'time': '08:00', 'endTime': '10:00', 'endsOn': None, 'count': 6, 'skipDates': ['2026-11-25'], 'horizonDays': 56, 'notifyCustomer': False,
                                          'assignment': {'assignedCrew': ['crew.one', 'lead.one'], 'crewLead': 'lead.one', 'crewId': 'crew-main', 'vehicleId': 'truck-1'}})
        self.assertEqual(self.calls[1]['expectedRevision'], 'plan-rev-1'); self.assertEqual(self.calls[2]['expectedRevision'], 'plan-rev-2')
        self.assertEqual({call['limit'] for call in self.calls[1:]}, {4})
        dialog.get_by_role('button', name='Close recurring plans').click()
        expect(dialog).to_have_count(0)

    def test_phone_layout_touch_targets_and_edit_inputs(self):
        self.start(375, 812); self.plans = [plan()]
        self.open_dispatch(); self.open_plans()
        card = self.dialog().locator('[data-plan="plan-1"]')
        expect(card).to_contain_text('Every week · 8:00 AM – 10:00 AM')
        expect(card.get_by_role('list', name='Next visits')).to_contain_text('Wed, Sep 23')
        expect(card).to_contain_text('Wed, Oct 7 conflicted with other work')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.assertEqual(self.page.evaluate("(()=>{const d=document.querySelector('dialog.rp-dialog');return d.scrollWidth-d.clientWidth})()"), 0)
        small = self.page.evaluate("[...document.querySelectorAll('dialog.rp-dialog button')].filter(b=>b.offsetParent).map(b=>[b.textContent,b.getBoundingClientRect().height]).filter(([,h])=>h<44)")
        self.assertEqual(small, [])
        card.get_by_role('button', name='Edit', exact=True).click()
        dialog = self.dialog()
        expect(dialog.get_by_role('heading', name='Edit recurring plan', exact=True)).to_be_visible()
        sizes = self.page.evaluate("[...document.querySelectorAll('dialog.rp-dialog input:not([type=checkbox]),dialog.rp-dialog select')].map(e=>getComputedStyle(e).fontSize)")
        self.assertTrue(sizes and all(size == '16px' for size in sizes), sizes)
        dialog.get_by_label('Repeats', exact=True).select_option('every_n_weeks')
        weeks = dialog.get_by_label('Weeks between visits', exact=True)
        self.assertEqual(weeks.get_attribute('inputmode'), 'numeric')
        weeks.fill('3')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        submit = dialog.get_by_role('button', name='Save plan changes', exact=True)
        box = submit.bounding_box(); self.assertIsNotNone(box); self.assertLessEqual(box['y'] + box['height'], 812); self.assertGreaterEqual(box['height'], 44)
        submit.click()
        expect(dialog.get_by_role('status').filter(has_text='Plan updated.')).to_be_visible()
        self.assertEqual(self.calls[-1]['action'], 'update'); self.assertEqual(self.calls[-1]['expectedRevision'], 'plan-rev-1')
        self.assertEqual(self.calls[-1]['plan']['cadence'], {'frequency': 'every_n_weeks', 'intervalWeeks': 3})

    def test_dispatch_changes_and_off_pattern_visits_are_listed_on_a_phone(self):
        self.start(375, 812)
        self.plans = [plan(upcoming=[{'date': '2026-09-23', 'state': 'template', 'jobId': 'job-1'}, {'date': '2026-09-30', 'state': 'cancelled', 'recorded': 'scheduled', 'jobId': 'occ-1'}, {'date': '2026-10-07', 'state': 'moved', 'recorded': 'scheduled', 'movedTo': '2026-10-08', 'jobId': 'occ-2'}],
                           attention=[{'date': '2026-09-30', 'state': 'cancelled', 'jobId': 'occ-1'}, {'date': '2026-10-14', 'state': 'conflict', 'code': 'recurring_slot_taken', 'jobId': 'occ-3'}, {'date': '2026-10-21', 'state': 'off_pattern', 'jobId': 'occ-4'}])]
        self.update_warnings = [{'code': 'generated_visits_off_pattern', 'visits': [{'date': '2026-09-30', 'jobId': 'occ-1'}, {'date': '2026-10-07', 'jobId': 'occ-2'}], 'message': '2 visits already on the schedule no longer match this plan and were NOT removed: 2026-09-30, 2026-10-07.'},
                                {'code': 'generated_visits_unchanged', 'message': 'Visits already on the schedule keep their current time and crew.'}]
        self.open_dispatch(); self.open_plans()
        card = self.dialog().locator('[data-plan="plan-1"]')
        upcoming = card.get_by_role('list', name='Next visits')
        expect(upcoming).to_contain_text('Cancelled in Dispatch'); expect(upcoming).to_contain_text('Moved to Thu, Oct 8')
        expect(card).to_contain_text('Wed, Sep 30 was cancelled in Dispatch, so the customer has no visit that day.')
        expect(card).to_contain_text('Wed, Oct 14 is unscheduled in Dispatch because a cancelled or moved booking still holds that time.')
        expect(card).to_contain_text('Wed, Oct 21 is still on the schedule but no longer matches this plan.')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        card.get_by_role('button', name='Edit', exact=True).click()
        dialog = self.dialog()
        expect(dialog).to_contain_text('if the new pattern leaves any out, you will be shown which ones to cancel in Dispatch')
        dialog.get_by_label('First visit', exact=True).fill('2026-09-24')
        dialog.get_by_role('button', name='Save plan changes', exact=True).click()
        expect(dialog.get_by_role('status').filter(has_text='no longer match this plan and were NOT removed')).to_be_visible()
        stale = dialog.get_by_role('list', name='Visits that no longer match the plan')
        expect(stale.get_by_role('listitem')).to_have_text(['Wed, Sep 30, 2026', 'Wed, Oct 7, 2026'])
        self.assertEqual(self.calls[-1]['plan']['startDate'], '2026-09-24')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        dialog.locator('[data-plan="plan-1"]').get_by_role('button', name='Pause', exact=True).click()
        expect(dialog.locator('[data-plan="plan-1"]')).to_contain_text('Paused')
        expect(stale).to_have_count(0)

    def test_lost_response_is_retried_with_the_same_request_after_reload(self):
        self.start(); self.plans = [plan()]; self.lost_once = True
        self.open_dispatch(); self.open_plans()
        self.dialog().get_by_role('button', name='Pause', exact=True).click()
        expect(self.dialog().get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        expect(self.dialog().locator('[data-plan="plan-1"]')).to_have_count(0)
        self.page.reload()
        expect(self.page.get_by_role('heading', name=CUSTOMER, exact=True)).to_be_visible()
        self.open_plans()
        self.dialog().get_by_role('button', name='Retry original save', exact=True).click()
        expect(self.dialog().get_by_role('status').filter(has_text='Plan paused.')).to_be_visible()
        expect(self.dialog().locator('[data-plan="plan-1"]')).to_contain_text('Paused')
        self.assertEqual(len(self.calls), 2); self.assertEqual(self.calls[0], self.calls[1])
        self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(k=>k.startsWith('egc.recurring.pending'))"), [])

    def test_end_needs_confirmation_and_revision_conflicts_are_definite(self):
        self.start(); self.plans = [plan()]
        self.open_dispatch(); self.open_plans()
        card = self.dialog().locator('[data-plan="plan-1"]')
        card.get_by_role('button', name='End', exact=True).click()
        expect(card).to_contain_text('No more visits will be added')
        card.get_by_role('button', name='Keep plan', exact=True).click()
        self.assertEqual(self.calls, [])
        self.fail_once = (409, 'recurring_revision_conflict', 'This recurring plan changed while you were editing.')
        card.get_by_role('button', name='End', exact=True).click(); card.get_by_role('button', name='End plan', exact=True).click()
        expect(self.dialog().get_by_role('alert').filter(has_text='changed while you were editing')).to_be_visible()
        expect(self.dialog().get_by_role('button', name='Retry original save', exact=True)).to_have_count(0)
        card.get_by_role('button', name='End', exact=True).click(); card.get_by_role('button', name='End plan', exact=True).click()
        expect(card).to_contain_text('Ended')
        self.assertEqual([call['action'] for call in self.calls], ['end', 'end']); self.assertNotEqual(self.calls[0]['requestId'], self.calls[1]['requestId'])

    def test_disabled_flag_blocks_new_plans_but_allows_pausing(self):
        self.start(); self.enabled = False; self.plans = [plan()]
        self.open_dispatch(); self.open_plans()
        dialog = self.dialog()
        expect(dialog).to_contain_text('Recurring plans are turned off')
        expect(dialog.get_by_role('button', name='Add upcoming visits', exact=True)).to_be_disabled()
        expect(dialog.get_by_role('button', name='Edit', exact=True)).to_be_disabled()
        dialog.get_by_role('button', name='Pause', exact=True).click()
        expect(dialog.locator('[data-plan="plan-1"]')).to_contain_text('Paused')
        expect(dialog.get_by_role('button', name='Resume', exact=True)).to_be_disabled()
        dialog.get_by_role('button', name='Close recurring plans').click()
        self.page.get_by_role('button', name='Repeat ' + CUSTOMER + ' on a schedule').click()
        expect(self.dialog().get_by_role('button', name='Start recurring plan', exact=True)).to_be_disabled()

    def test_price_per_visit_is_sent_in_cents_when_starting_a_plan(self):
        self.start()
        self.open_dispatch()
        self.page.get_by_role('button', name='Repeat ' + CUSTOMER + ' on a schedule').click()
        dialog = self.dialog()
        price = dialog.get_by_label('Price per visit (USD)', exact=True)
        self.assertEqual(price.get_attribute('inputmode'), 'decimal'); expect(price).to_have_value('')
        price.fill('145.555')
        dialog.get_by_role('button', name='Start recurring plan', exact=True).click()
        expect(dialog.get_by_role('alert').filter(has_text='Enter the price per visit like 145 or 145.50')).to_be_visible()
        self.assertEqual(self.calls, [])
        price.fill('145.5')
        dialog.get_by_role('button', name='Start recurring plan', exact=True).click()
        expect(dialog.locator('[data-plan="plan-1"]')).to_contain_text('$145.50 per visit')
        self.assertEqual(self.calls[0]['action'], 'create'); self.assertEqual(self.calls[0]['plan']['pricePerVisitCents'], 14550)
        self.assertNotIn('applyToBooked', self.calls[0])

    def test_edit_can_move_booked_visits_and_change_the_price_on_a_phone(self):
        self.start(375, 812)
        self.plans = [plan(pricePerVisitCents=14500, lineItems=[{'id': 'recurring-visit', 'kind': 'service', 'name': 'Garage cleanout (recurring visit)', 'quantity': 1, 'unitCents': 14500, 'totalCents': 14500}])]
        self.extend_script = [{'created': [], 'conflicts': [], 'updated': [{'date': '2026-09-30', 'jobId': 'occ-1', 'from': '2026-09-30'}], 'priced': [{'date': '2026-09-30', 'jobId': 'occ-1', 'status': 'applied'}], 'complete': True}]
        self.update_warnings = [{'code': 'booked_visits_updating', 'visits': [{'date': '2026-09-30', 'from': '2026-09-30', 'jobId': 'occ-1'}], 'message': '1 booked visit that has not started is being updated to match this plan.'}]
        self.open_dispatch(); self.open_plans()
        card = self.dialog().locator('[data-plan="plan-1"]')
        expect(card).to_contain_text('$145.00 per visit')
        card.get_by_role('button', name='Edit', exact=True).click()
        dialog = self.dialog()
        price = dialog.get_by_label('Price per visit (USD)', exact=True)
        expect(price).to_have_value('145.00'); self.assertEqual(price.get_attribute('inputmode'), 'decimal')
        self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('dialog.rp-dialog input[name=pricePerVisit]')).fontSize"), '16px')
        move = dialog.get_by_label('Also move booked visits that have not started to the new time, crew and price', exact=True)
        expect(move).not_to_be_checked()
        box = self.page.evaluate("document.querySelector('dialog.rp-dialog input[name=applyToBooked]').closest('label').getBoundingClientRect().height")
        self.assertGreaterEqual(box, 44)
        dialog.get_by_label('Start time', exact=True).fill('09:00'); dialog.get_by_label('End time', exact=True).fill('11:00')
        price.fill('160'); move.check()
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        dialog.get_by_role('button', name='Save plan changes', exact=True).click()
        expect(dialog.get_by_role('status').filter(has_text='1 booked visit moved to match the plan.')).to_be_visible()
        self.assertEqual([call['action'] for call in self.calls], ['update', 'extend'])
        update = self.calls[0]
        self.assertEqual(update['applyToBooked'], True); self.assertEqual(update['plan']['pricePerVisitCents'], 16000); self.assertEqual(update['plan']['time'], '09:00')
        self.assertEqual(self.calls[1]['expectedRevision'], 'plan-rev-2')
        expect(dialog.locator('[data-plan="plan-1"]')).to_contain_text('$160.00 per visit')
        # An edit that leaves the price and booked visits alone sends neither field.
        dialog.locator('[data-plan="plan-1"]').get_by_role('button', name='Edit', exact=True).click()
        self.dialog().get_by_role('button', name='Save plan changes', exact=True).click()
        expect(self.dialog().get_by_role('status').filter(has_text='Plan updated.')).to_be_visible()
        self.assertNotIn('pricePerVisitCents', self.calls[-1]['plan']); self.assertNotIn('applyToBooked', self.calls[-1])

    def test_booked_visit_moves_continue_through_every_bounded_round(self):
        self.start(375, 812)
        self.plans = [plan(occurrences=[{'date': '2026-10-28', 'jobId': 'occ-7', 'state': 'updating', 'recorded': 'scheduled'}])]
        moved = lambda *days: [{'date': day, 'jobId': 'occ-' + day[-2:], 'from': day} for day in days]
        # Rounds that only move booked visits (nothing created, not complete, not retryable) are still progress.
        self.extend_script = [{'created': [], 'conflicts': [], 'updated': moved('2026-09-30', '2026-10-07', '2026-10-14', '2026-10-21'), 'complete': False},
                              {'created': [], 'conflicts': [], 'updated': moved('2026-10-28', '2026-11-04'), 'complete': False},
                              {'created': [], 'conflicts': [], 'updated': moved('2026-11-11'), 'complete': True}]
        self.update_warnings = [{'code': 'booked_visits_updating', 'visits': [], 'message': '7 booked visits that have not started are being updated to match this plan.'}]
        self.open_dispatch(); self.open_plans()
        dialog = self.dialog()
        dialog.locator('[data-plan="plan-1"]').get_by_role('button', name='Edit', exact=True).click()
        dialog.get_by_label('Start time', exact=True).fill('09:00'); dialog.get_by_label('End time', exact=True).fill('11:00')
        dialog.get_by_label('Also move booked visits that have not started to the new time, crew and price', exact=True).check()
        dialog.get_by_role('button', name='Save plan changes', exact=True).click()
        status = dialog.get_by_role('status').filter(has_text='7 booked visits moved to match the plan.')
        expect(status).to_be_visible()
        expect(status).not_to_contain_text('still being updated')
        self.assertEqual([call['action'] for call in self.calls], ['update', 'extend', 'extend', 'extend'])
        self.assertEqual([call['expectedRevision'] for call in self.calls[1:]], ['plan-rev-2', 'plan-rev-3', 'plan-rev-4'])
        self.assertEqual(len({call['requestId'] for call in self.calls}), 4)
        # A round that changes nothing ends the loop early, and the manager is told the plan is not finished.
        self.extend_script = [{'created': [], 'conflicts': [], 'updated': moved('2026-10-28'), 'complete': False}, {'created': [], 'conflicts': [], 'complete': False}]
        dialog.locator('[data-plan="plan-1"]').get_by_role('button', name='Add upcoming visits', exact=True).click()
        unfinished = dialog.get_by_role('status').filter(has_text='Some booked visits are still being updated to match the plan. Press Add upcoming visits to finish.')
        expect(unfinished).to_be_visible()
        expect(unfinished).to_contain_text('1 booked visit moved to match the plan.')
        expect(unfinished).not_to_contain_text('No new visits were needed')
        self.assertEqual([call['action'] for call in self.calls[4:]], ['extend', 'extend'])
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)

    def test_rounds_that_only_keep_booked_visits_continue_and_name_each_visit(self):
        self.start(375, 812)
        message = 'The 2026-10-14 visit could not be saved (dispatch_lock_unavailable). Each run retries it, and later visits wait for it. If this continues, add 2026-10-14 as a skipped date so later visits are added.'
        self.plans = [plan(lastRun={'at': DAY + 'T17:00:00Z', 'status': 'error', 'stage': 'create', 'code': 'dispatch_lock_unavailable', 'date': '2026-10-14', 'message': message})]
        kept = lambda *rows: [{'date': day, 'jobId': 'occ-' + day[-2:], 'reason': reason} for day, reason in rows]
        # A round in which every booked-visit change drops (nothing created, moved or priced; not retryable) is still progress.
        self.extend_script = [{'created': [], 'conflicts': [], 'kept': kept(('2026-09-30', 'changed_in_dispatch'), ('2026-10-07', 'started'), ('2026-10-14', 'slot_taken'), ('2026-10-21', 'changed_in_dispatch')), 'complete': False},
                              {'created': [], 'conflicts': [], 'kept': kept(('2026-10-28', 'time_passed')), 'complete': True}]
        self.open_dispatch(); self.open_plans()
        card = self.dialog().locator('[data-plan="plan-1"]')
        expect(card).to_contain_text('Visits stopped being added: ' + message)
        card.get_by_role('button', name='Add upcoming visits', exact=True).click()
        status = self.dialog().get_by_role('status').filter(has_text='5 booked visits kept their current time:')
        expect(status).to_be_visible()
        expect(status).to_contain_text('Wed, Oct 14 (the customer already has another booking at the new time)')
        expect(status).to_contain_text('Wed, Oct 7 (it has started)')
        expect(status).to_contain_text('Wed, Oct 28 (the new time has passed)')
        expect(status).not_to_contain_text('Press Add upcoming visits to finish')
        self.assertEqual([call['action'] for call in self.calls], ['extend', 'extend'])
        self.assertEqual(len({call['requestId'] for call in self.calls}), 2)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        # A failed price names what stopped; the card reloads after the next action.
        self.plans[0]['lastRun'] = {'status': 'error', 'stage': 'price', 'code': 'dispatch_storage_unavailable', 'date': '2026-09-30', 'message': 'The 2026-09-30 visit could not be priced (dispatch_storage_unavailable). Each run retries it.'}
        card.get_by_role('button', name='Add upcoming visits', exact=True).click()
        expect(card).to_contain_text('Visit prices stopped being saved: The 2026-09-30 visit could not be priced')
        expect(card).not_to_contain_text('Visits stopped being added')

if __name__ == '__main__':
    unittest.main(verbosity=2)
