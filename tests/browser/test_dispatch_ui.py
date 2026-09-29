"""Native dispatch browser workflows against isolated contract fixtures; no provider/customer writes."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-22'
CUSTOMER = {'id': 'customer-1', 'name': 'Synthetic Johnson Garage', 'phone': '(970) 555-0100', 'email': 'synthetic@example.invalid', 'address': '123 Synthetic Way, Fort Collins, CO'}
ROSTER = [{'id': 'crew.one', 'name': 'Crew One', 'role': 'crew'}, {'id': 'crew.two', 'name': 'Crew Two', 'role': 'crew'}, {'id': 'lead.one', 'name': 'Lead One', 'role': 'crew_lead'}]
def job(**changes):
    result = {'id': 'job-1', 'revision': 'rev-1', 'type': 'job', 'customerId': CUSTOMER['id'], 'customer': CUSTOMER['name'], 'phone': CUSTOMER['phone'], 'address': CUSTOMER['address'],
              'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '10:00', 'startAt': DAY+'T08:00:00-06:00', 'endAt': DAY+'T10:00:00-06:00', 'status': 'scheduled',
              'assignedCrew': ['crew.one', 'lead.one'], 'crewLead': 'lead.one', 'crewId': 'crew-main', 'vehicleId': 'truck-1', 'crewNeeded': 2, 'travelBufferMinutes': 20,
              'serviceType': 'Garage cleanout', 'jobInstructions': 'Clear the garage; preserve the workbench.', 'requiredEquipment': ['Dolly', 'Brooms'], 'materials': [{'id': 'shelves', 'name': 'Shelving', 'quantity': 2}], 'syncStatus': 'not_needed'}
    result.update(changes)
    return result

def stop(id, time, end, customer, address=''):
    return {'id': id, 'type': 'job', 'customer': customer, 'title': '', 'address': address, 'date': DAY, 'time': time, 'endDate': DAY, 'endTime': end, 'startAt': DAY+'T'+time+':00-06:00', 'endAt': DAY+'T'+end+':00-06:00', 'status': 'scheduled', 'travelBufferMinutes': 20}
TRAVEL = {'ok': True, 'timeZone': 'America/Denver', 'date': DAY, 'asOf': '2026-09-22T14:00:00Z', 'travel': {'mode': 'offline', 'requestedMode': 'offline', 'blockTravelShort': False}, 'coverage': {'complete': True, 'asOf': '2026-09-22T14:00:00Z'},
          'employees': [{'employeeId': 'crew.one', 'name': 'Crew One', 'active': True, 'complete': True,
                         'jobs': [stop('job-1', '08:00', '10:00', CUSTOMER['name'], '123 Synthetic Way, Fort Collins, CO 80525'), stop('job-2', '10:15', '11:00', '<img src=x onerror="window.injected=true">'), stop('job-3', '12:00', '13:00', 'Second Synthetic Garage', '200 Synthetic Ave, Loveland, CO 80537')],
                         'legs': [{'fromJobId': 'job-1', 'toJobId': 'job-2', 'gapMinutes': 15, 'bufferMinutes': 20, 'estimatedMinutes': 30, 'estimateSource': 'offline_zip', 'requiredMinutes': 30, 'shortByMinutes': 15, 'status': 'short'},
                                  {'fromJobId': 'job-2', 'toJobId': 'job-3', 'gapMinutes': 60, 'bufferMinutes': 20, 'estimatedMinutes': None, 'estimateSource': None, 'requiredMinutes': 20, 'shortByMinutes': 0, 'status': 'ok'}],
                         'totals': {'stops': 3, 'legs': 2, 'shortLegs': 1, 'estimatedDriveMinutes': 30, 'unestimatedLegs': 1}},
                        {'employeeId': 'lead.one', 'name': 'Lead One', 'active': True, 'complete': False, 'jobs': [], 'legs': [], 'totals': {'stops': 0, 'legs': 0, 'shortLegs': 0, 'estimatedDriveMinutes': 0, 'unestimatedLegs': 0}}],
          'warnings': [{'code': 'travel_estimate_unavailable', 'count': 1, 'message': '1 leg has no drive estimate (unknown ZIP or address). The manual travel buffer applies.'}]}

# FUN-02 code lists as GET /api/dispatch returns them from the shared funnel definitions.
FUNNEL = {'visitPurposes': ['service', 'install', 'return', 'rework', 'member_visit'], 'bookingChannels': ['hub_phone', 'hub_in_person'], 'selfReportedChannels': ['google_search', 'referral', 'other'],
          'crmLinkReasons': ['crm_sync_pending', 'other'], 'initiatedBy': ['customer', 'company'],
          'reasonCodes': {'cancel': ['customer_changed_plans', 'weather', 'other'], 'reschedule': ['customer_request', 'weather', 'other'], 'noShow': ['customer_not_home', 'no_access', 'other']}}
# FUN-29 adds the service-line and funnel-path lists.
FUNNEL29 = {**FUNNEL, 'serviceLines': ['garage_transformation', 'junk_removal', 'garage_guard_visit', 'commercial_b2b', 'unknown'],
            'funnelPaths': ['walkthrough', 'remote_photo_video_quote', 'direct_phone_booking', 'b2b_request', 'rebook', 'member_visit', 'recurring']}
def prefill(query):
    # Mirrors GET /api/funnel-dimensions: a walkthrough is on the walkthrough path; a junk service name decides the line.
    kind, service = query.get('kind', [''])[0], query.get('serviceType', [''])[0]
    line = 'junk_removal' if 'junk' in service.lower() and kind == 'job' else None
    path = 'walkthrough' if kind == 'walkthrough' else None
    return {'ok': True, 'customerId': query.get('customerId', [''])[0], 'kind': kind, 'projectId': None, 'rulesVersion': 1, 'ghl': 'disabled',
            'serviceLine': {'value': line, 'source': 'salesExitService' if line else None, 'required': line is None, 'suggestion': None},
            'funnelPath': {'value': path, 'source': 'walkthrough' if path else None, 'required': path is None}}

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated EGC dispatch test</title><link rel="stylesheet" href="/employee-dispatch.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main><script src="/employee-dispatch.js"></script><script>EGCDispatch.mount(document.querySelector("#host"))</script></body></html>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class DispatchBrowserTests(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={'width': 1360, 'height': 950}, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(7000); self.errors = []; self.calls = []; self.gets = []; self.jobs = [job()]
        self.page.clock.install(time=DAY + 'T18:00:00Z')
        self.crews = [{'id': 'crew-main', 'revision': 'crew-rev-1', 'name': 'North Crew', 'memberIds': ['crew.one', 'lead.one'], 'leadId': 'lead.one', 'status': 'active'}]
        self.vehicles = [{'id': 'truck-1', 'revision': 'truck-rev-1', 'name': 'Box Truck', 'status': 'available', 'notes': 'Check straps'}, {'id': 'truck-2', 'revision': 'truck-rev-2', 'name': 'Spare Truck', 'status': 'out_of_service', 'notes': 'Repair pending'}]
        self.availability = []; self.fail_once = None; self.read_status = 200; self.completed = {}; self.lost_once = False; self.malformed_once = False; self.viewer = 'manager.one'; self.booker = False; self.can_perform_walkthrough = None; self.bad_read = False
        self.opening_queries = []; self.opening_failure = None; self.opening_candidates = [{'date': DAY, 'time': '13:00', 'endDate': DAY, 'endTime': '15:00', 'startAt': DAY+'T19:00:00Z', 'endAt': DAY+'T21:00:00Z', 'gapMinutes': 240}]
        self.search_queries = []; self.search_results = []; self.search_failure = None; self.hang_once = False; self.hung_route = None
        self.arrival_defaults = {'enabled': False, 'minutes': 60}
        self.travel_queries = []; self.travel_failure = None
        self.segments = None; self.funnel = None; self.customers = [CUSTOMER]; self.prefill = prefill; self.prefill_queries = []
        self.read_warnings = []; self.read_extra = {}
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('dialog', lambda dialog: dialog.accept())
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
        self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path == '/api/dispatch-search':
            self.search_queries.append(parse_qs(parsed.query))
            if self.search_failure: route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'error': self.search_failure})); return
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'coverage': {'complete': True}, 'results': self.search_results, 'total': len(self.search_results), 'truncated': False})); return
        if parsed.path == '/api/dispatch-travel':
            params = parse_qs(parsed.query); self.travel_queries.append(params)
            if self.travel_failure: route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'code': 'dispatch_travel_unavailable', 'error': self.travel_failure})); return
            route.fulfill(status=200, content_type='application/json', body=json.dumps({**copy.deepcopy(TRAVEL), 'date': params.get('date', [DAY])[0]})); return
        if parsed.path == '/api/dispatch-openings':
            self.opening_queries.append(parse_qs(parsed.query))
            if self.opening_failure: route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'error': self.opening_failure})); return
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'coverage': {'complete': True, 'consistent': True}, 'candidates': self.opening_candidates, 'warnings': [{'code': 'working_availability_unconfirmed', 'message': 'Confirm these employees are working before booking.'}], 'total': len(self.opening_candidates), 'truncated': False})); return
        if parsed.path == '/api/funnel-dimensions':
            query = parse_qs(parsed.query); self.prefill_queries.append(query); result = self.prefill(query)
            route.fulfill(status=result.get('status', 200), content_type='application/json', body=json.dumps(result)); return
        if parsed.path != '/api/dispatch': route.continue_(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if req.method == 'GET':
            params = parse_qs(parsed.query); self.gets.append(params)
            if self.read_status != 200: send({'ok': False, 'code': 'dispatch_forbidden', 'error': 'Sign in required'}, self.read_status); return
            if params.get('view') == ['customers']: send({'ok': True, 'customers': self.customers, 'total': len(self.customers)}); return
            first = params.get('startDate', [DAY])[0]; last = params.get('endDate', ['2026-09-29'])[0]
            rows = [row for row in self.jobs if not row.get('date') or (row['date'] < last and (row.get('endDate') or row['date']) >= first)]
            if self.bad_read: send({'ok': True}); return
            viewer = {'id': self.viewer, **({'booker': True} if self.booker else {}), **({'canPerformWalkthrough': self.can_perform_walkthrough} if self.can_perform_walkthrough is not None else {})}
            send({'ok': True, 'viewer': viewer, 'timeZone': 'America/Denver', 'jobs': rows, 'roster': ROSTER, 'crews': self.crews, 'vehicles': self.vehicles, 'availability': self.availability,
                  'warnings': copy.deepcopy(self.read_warnings), 'coverage': {'complete': True, 'asOf': '2026-09-22T14:00:00Z'}, 'startDate': first, 'endDate': last, 'arrivalDefaults': self.arrival_defaults, **({'segments': self.segments} if self.segments else {}), **({'funnel': self.funnel} if self.funnel else {}), **self.read_extra}); return
        body = req.post_data_json; self.calls.append(copy.deepcopy(body))
        if self.fail_once:
            status, code, error, details = self.fail_once; self.fail_once = None
            send({'ok': False, 'code': code, 'error': error, 'details': details}, status); return
        if body['requestId'] in self.completed: send({**self.completed[body['requestId']], 'replayed': True}); return
        action = body['action']; changes = body.get('changes', {})
        if action == 'schedule.create':
            row = job(id='created-'+str(len(self.jobs)), revision='new-rev-1', type=body['kind'], **changes)
            row['startAt'] = row['date']+'T'+row['time']+':00-06:00' if row['date'] else None
            row['endAt'] = row['endDate']+'T'+row['endTime']+':00-06:00' if row['date'] else None
            self.jobs.append(row); response = {'ok': True, 'job': row, 'warnings': [], 'providerSync': 'pending'}
        elif action.startswith('schedule.'):
            row = next(row for row in self.jobs if row['id'] == body['jobId'])
            if body['expectedRevision'] != row['revision']: send({'ok': False, 'code': 'dispatch_revision_conflict', 'error': 'Record changed'}, 409); return
            row.update(changes); row['revision'] += '-next'
            if action == 'schedule.cancel': row['status'] = 'cancelled'
            if action == 'schedule.restore': row['status'] = 'scheduled'
            if action == 'schedule.no_show': row['status'] = 'no_show'
            response = {'ok': True, 'job': row, 'warnings': [], 'providerSync': 'pending'}
        else:
            group = {'crew.save': self.crews, 'vehicle.save': self.vehicles, 'availability.save': self.availability}[action]
            resource = next((row for row in group if row['id'] == body.get('id')), None)
            if resource: resource.update(changes); resource['revision'] += '-next'
            else: resource = {'id': 'new-'+action, 'revision': 'new-resource-rev', **changes}; group.append(resource)
            response = {'ok': True, 'resource': resource, 'warnings': []}
        response['requestId'] = body['requestId']
        self.completed[body['requestId']] = copy.deepcopy(response)
        if self.lost_once: self.lost_once = False; route.abort('connectionfailed'); return
        if self.malformed_once: self.malformed_once = False; send({'ok': True}); return
        if self.hang_once: self.hang_once = False; self.hung_route = route; return
        send(response)
    def open(self):
        self.page.goto(self.url)
        self.page.get_by_label('Schedule date', exact=True).fill(DAY)
        expect(self.page.get_by_role('heading', name=CUSTOMER['name'], exact=True)).to_be_visible()
    def split_job(self):
        segment = lambda id, date, time, end, crew, lead=None, truck=None, notes='': {'id': id, 'date': date, 'time': time, 'endDate': date, 'endTime': end, 'startAt': date+'T'+time+':00-06:00', 'endAt': date+'T'+end+':00-06:00', 'assignedCrew': crew, 'crewLead': lead, 'crewId': None, 'vehicleId': truck, 'notes': notes}
        return job(id='job-split', revision='split-rev-1', customer='Synthetic Split Garage', endDate='2026-09-24', endTime='12:00', endAt='2026-09-24T12:00:00-06:00', assignedCrew=['crew.one', 'crew.two'], crewLead='crew.one', crewId=None, vehicleId=None,
                   assignmentSegments=[segment('s1', DAY, '08:00', '17:00', ['crew.one'], 'crew.one', 'truck-1', 'Synthetic front bay'), segment('s2', DAY, '08:00', '17:00', ['crew.two']), segment('s3', '2026-09-24', '08:00', '12:00', ['crew.two'])])
    def card(self, name=CUSTOMER['name']): return self.page.locator('.dp-job').filter(has=self.page.get_by_role('heading', name=name, exact=True)).first
    # FIX-DISPATCH-QUEUE: undated work waits in the To schedule view, one compact row each, not as cards under the board.
    def to_schedule(self): self.page.get_by_role('button', name=re.compile(r'^To schedule \(')).click(); expect(self.page.locator('.dp-queue-row').first).to_be_visible()
    def queued(self, name): return self.page.locator('.dp-queue-row').filter(has=self.page.get_by_role('heading', name=name, exact=True)).first
    def schedule(self, name): self.to_schedule(); self.queued(name).get_by_role('button', name='Schedule '+name, exact=True).click()
    def create(self):
        self.page.get_by_role('button', name='Create job', exact=True).first.click()
        self.page.locator('input[name=customerSearch]').fill('Johnson')
        self.page.get_by_role('button', name=CUSTOMER['name']+' · '+CUSTOMER['phone'], exact=True).click()
        self.page.get_by_label('Service', exact=True).fill('New synthetic service')
        self.page.get_by_label('Start time', exact=True).fill('13:00')
        self.page.get_by_label('End time', exact=True).fill('15:00')
    def submit(self, label): self.page.get_by_role('dialog').get_by_role('button', name=label, exact=True).click()
    def closed(self): expect(self.page.get_by_role('dialog')).to_have_count(0)

    def test_day_crew_navigation_and_timezone_are_real_record_values(self):
        self.open(); card = self.card(); expect(card).to_contain_text('8:00 AM – 10:00 AM'); expect(card).to_contain_text('North Crew'); expect(card).to_contain_text('Lead One'); expect(card).to_contain_text('Box Truck')
        expect(card.get_by_role('link', name='Open job', exact=True)).to_have_attribute('href', '/crew/job.html?jobId=job-1')
        expect(card.get_by_role('link', name=CUSTOMER['address'], exact=True)).to_have_attribute('href', 'https://www.google.com/maps/dir/?api=1&destination=123%20Synthetic%20Way%2C%20Fort%20Collins%2C%20CO')
        # The crew view first redraws from the previous read, so wait for its own read rather than the last one recorded.
        with self.page.expect_request(lambda request: urlparse(request.url).path == '/api/dispatch' and request.method == 'GET') as read:
            self.page.get_by_role('button', name='Crew', exact=True).click()
        params = parse_qs(urlparse(read.value.url).query); self.assertEqual(params['startDate'], [DAY]); self.assertEqual(params['endDate'], ['2026-09-29'])
        expect(self.page.locator('.dp-crew-group')).to_contain_text('1 jobs · 2.0 reserved hours')
    def test_field_links_follow_server_walkthrough_capability_and_dispatch_access(self):
        self.jobs = [job(), job(id='walk-assigned', type='walkthrough', customer='Assigned Walkthrough', assignedCrew=['Synthetic.Sales']),
                     job(id='walk-other', type='walkthrough', customer='Other Walkthrough', assignedCrew=['crew.one']),
                     job(id='walk-sold', type='walkthrough', customer='Sold Walkthrough', walkthroughState='sold', walkthroughBadge='Sold → open job', convertedJobId='job-converted', walkthroughClosed=True),
                     job(id='job-queued', customer='Queued Job', date='', time='', endDate='', endTime='', startAt=None, endAt=None, status='unscheduled')]
        self.viewer = 'Synthetic.Phone'; self.booker = True; self.can_perform_walkthrough = False; self.open()
        self.page.get_by_role('combobox', name='Filter by status').select_option('all')
        for name in [CUSTOMER['name'], 'Assigned Walkthrough', 'Other Walkthrough']:
            expect(self.card(name).get_by_role('link', name=re.compile(r'^Open (job|walkthrough)$'))).to_have_count(0)
        expect(self.card('Sold Walkthrough').locator('.dp-outcome-link')).to_have_count(0)
        self.to_schedule(); expect(self.queued('Queued Job').get_by_role('link', name='Open Queued Job', exact=True)).to_have_count(0)

        self.viewer = 'Synthetic.Sales'; self.can_perform_walkthrough = True; self.page.reload()
        self.page.get_by_role('combobox', name='Filter by status').select_option('all')
        expect(self.card('Assigned Walkthrough').get_by_role('link', name='Open walkthrough', exact=True)).to_have_attribute('href', '/crew/gameplan.html?walkthroughId=walk-assigned')
        expect(self.card('Other Walkthrough').get_by_role('link', name='Open walkthrough', exact=True)).to_have_count(0)
        expect(self.card().get_by_role('link', name='Open job', exact=True)).to_have_count(0)
        expect(self.card('Sold Walkthrough').locator('.dp-outcome-link')).to_have_count(0)

        self.viewer = 'manager.one'; self.booker = False; self.can_perform_walkthrough = True; self.page.reload()
        self.page.get_by_role('combobox', name='Filter by status').select_option('all')
        expect(self.card().get_by_role('link', name='Open job', exact=True)).to_have_attribute('href', '/crew/job.html?jobId=job-1')
        expect(self.card('Sold Walkthrough').locator('.dp-outcome-link')).to_have_attribute('href', '/crew/job.html?jobId=job-converted')
    def test_create_assign_lead_truck_duration_scope_and_reload(self):
        self.open(); self.create(); self.page.get_by_role('combobox', name='Saved crew', exact=True).select_option('crew-main'); self.page.get_by_role('combobox', name='Vehicle / truck', exact=True).select_option('truck-1')
        self.page.get_by_role('combobox', name='Expected duration', exact=True).select_option('180'); self.page.get_by_label('Scope of work', exact=True).fill('Keep the marked boxes; remove debris.'); self.submit('Create job'); self.closed()
        write = self.calls[-1]; self.assertEqual(write['customerId'], CUSTOMER['id']); self.assertEqual(write['changes']['assignedCrew'], ['crew.one', 'lead.one']); self.assertEqual(write['changes']['crewLead'], 'lead.one')
        self.assertEqual(write['changes']['endTime'], '16:00'); self.assertEqual(write['changes']['vehicleId'], 'truck-1'); self.assertEqual(write['changes']['jobInstructions'], 'Keep the marked boxes; remove debris.')
        self.page.reload(); expect(self.page.locator('.dp-job').filter(has_text='New synthetic service')).to_have_count(1)
    def test_unscheduled_create_and_filter(self):
        self.open(); self.create(); self.page.get_by_label('Keep unscheduled', exact=True).check(); expect(self.page.get_by_label('Start date', exact=True)).to_be_disabled(); self.submit('Create job'); self.closed()
        for key in ['date', 'time', 'endDate', 'endTime']: self.assertEqual(self.calls[-1]['changes'][key], '')
        self.page.get_by_label('Filter by status', exact=True).select_option('unscheduled'); expect(self.page.locator('.dp-queue-row')).to_have_count(1); expect(self.page.locator('.dp-queue-row')).to_contain_text('New synthetic service'); expect(self.page.locator('.dp-job')).to_have_count(0)
    def test_customer_search_waits_for_typing_to_pause_on_a_phone(self):
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); self.page.get_by_role('button', name='Create job', exact=True).first.click()
        searches = lambda: [params['q'] for params in self.gets if params.get('view') == ['customers']]
        search = self.page.locator('input[name=customerSearch]'); self.page.clock.pause_at(self.page.evaluate('Date.now()') + 50)
        search.press_sequentially('Johnson'); expect(self.page.locator('.dp-customer-results')).to_contain_text('Searching')
        self.page.clock.run_for(299); self.assertEqual(searches(), [], 'no request while the manager is still typing')
        self.page.clock.run_for(2); expect(self.page.get_by_role('button', name=CUSTOMER['name']+' · '+CUSTOMER['phone'], exact=True)).to_be_visible()
        self.assertEqual(searches(), [['Johnson']])
        search.fill('Jo'); search.fill('J'); expect(self.page.locator('.dp-customer-results')).to_contain_text('Type at least 2 characters.')
        self.page.clock.run_for(1000); self.assertEqual(searches(), [['Johnson']], 'a pending search is dropped once the text is too short')
        self.page.clock.resume(); self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('input[name=customerSearch]')).fontSize"), '16px')
    def test_edit_legacy_unlinked_customer_preserves_identity_and_material_quantity(self):
        self.jobs[0]['customerId'] = ''; self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); self.page.get_by_label('Access instructions', exact=True).fill('Use the side gate'); self.submit('Save changes'); self.closed()
        write = self.calls[-1]; self.assertEqual(write['action'], 'schedule.update'); self.assertEqual(write['jobId'], 'job-1'); self.assertNotIn('customerId', write)
        self.assertEqual(write['changes']['materials'][0]['quantity'], 2); self.assertEqual(write['changes']['accessInstructions'], 'Use the side gate')
    def test_multi_day_drag_reviews_new_dates_before_saving(self):
        self.jobs[0]['endDate'] = '2026-09-23'; self.open(); self.page.get_by_role('button', name='Week', exact=True).click()
        self.page.locator('.dp-job').first.drag_to(self.page.locator('.dp-day').nth(3)); expect(self.page.get_by_role('dialog')).to_be_visible()
        expect(self.page.get_by_label('Start date', exact=True)).to_have_value('2026-09-25'); expect(self.page.get_by_label('End date', exact=True)).to_have_value('2026-09-26')
        self.assertEqual(self.calls, []); self.submit('Save changes'); self.closed(); self.assertEqual(self.calls[-1]['changes']['date'], '2026-09-25')
    def test_conflict_error_preserves_draft_and_edit_work_type_constraint(self):
        self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); self.page.get_by_label('Start time', exact=True).fill('09:00')
        self.fail_once = (409, 'dispatch_conflict', 'Overlap', {'conflicts': [{'code': 'employee_overlap', 'employeeId': 'crew.one', 'message': 'Crew One is assigned to another job from 09:00 to 11:00.'}]})
        self.submit('Save changes'); expect(self.page.get_by_role('alert')).to_contain_text('Crew One is assigned'); expect(self.page.get_by_label('Start time', exact=True)).to_have_value('09:00'); expect(self.page.get_by_role('combobox', name='Work type', exact=True)).to_be_disabled()
        self.page.get_by_label('Start time', exact=True).fill('13:00'); self.page.get_by_label('End time', exact=True).fill('15:00'); self.submit('Save changes'); self.closed(); self.assertEqual(len(self.calls), 2)
    def test_ambiguous_customer_history_requires_explicit_prior_visit_selection(self):
        self.open(); self.create(); self.fail_once=(409,'dispatch_lineage_selection_required','Choose the previous customer account.',{'candidates':[{'jobId':'prior-visit','customerId':CUSTOMER['id'],'customer':CUSTOMER['name'],'address':CUSTOMER['address'],'date':'2025-02-03'},{'jobId':'wrong-customer','customerId':'different','customer':'Not this customer'}]})
        self.submit('Create job'); select=self.page.get_by_role('combobox',name='Previous customer visit',exact=True); expect(select).to_be_visible(); self.assertEqual(select.locator('option').count(),2); expect(self.page.get_by_label('Service',exact=True)).to_have_value('New synthetic service')
        select.select_option('prior-visit'); self.submit('Create job'); self.closed(); self.assertEqual(self.calls[-1]['sourceJobId'],'prior-visit'); self.assertNotEqual(self.calls[0]['requestId'],self.calls[1]['requestId'])
    def test_unscheduled_controls_stay_disabled_after_validation_failure(self):
        self.open(); self.create(); self.page.get_by_label('Keep unscheduled', exact=True).check(); self.fail_once = (400, 'dispatch_validation', 'Review scope', {})
        self.submit('Create job'); expect(self.page.get_by_role('alert')).to_contain_text('Review scope'); expect(self.page.get_by_label('Start date', exact=True)).to_be_disabled()
        self.submit('Create job'); self.closed(); self.assertEqual(self.calls[-1]['changes']['date'], '')
    def test_unknown_outcome_retries_same_request_and_cannot_discard_identity(self):
        self.open(); self.create(); self.lost_once = True; self.submit('Create job'); expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        self.page.get_by_role('button', name='Back', exact=True).click(); expect(self.page.get_by_role('dialog')).to_be_visible(); expect(self.page.get_by_label('Service', exact=True)).to_be_disabled()
        self.page.get_by_role('button', name='Retry original save', exact=True).click(); self.closed(); self.assertEqual(len(self.calls), 2); self.assertEqual(self.calls[0], self.calls[1]); self.assertEqual(len(self.jobs), 2)
    def test_lost_committed_save_survives_reload_and_recovers_same_receipt(self):
        self.open(); self.create(); self.lost_once = True; self.submit('Create job'); expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        original = copy.deepcopy(self.calls[-1]); self.page.reload(); self.page.get_by_role('button', name='Review unverified save', exact=True).click()
        expect(self.page.get_by_role('dialog')).to_contain_text('New synthetic service'); self.page.get_by_role('dialog').get_by_role('button', name='Retry original save', exact=True).click(); self.closed()
        self.assertEqual(self.calls[-1], original); self.assertEqual(len(self.jobs), 2); self.assertIsNone(self.page.evaluate("sessionStorage.getItem('egc.dispatch.pending.v1.manager.one')"))
    def test_success_without_receipt_is_unknown_and_recovers_without_duplicate(self):
        self.open(); self.create(); self.malformed_once = True; self.submit('Create job'); expect(self.page.get_by_role('alert')).to_contain_text('incomplete')
        self.page.get_by_role('button', name='Retry original save', exact=True).click(); self.closed(); self.assertEqual(self.calls[0], self.calls[1]); self.assertEqual(len(self.jobs), 2)
    def test_stalled_save_becomes_retryable_and_does_not_duplicate_committed_job(self):
        self.open(); self.create(); self.hang_once = True; self.submit('Create job'); expect(self.page.get_by_role('status').filter(has_text='Saving and verifying')).to_be_visible(); self.page.clock.fast_forward(31000)
        expect(self.page.get_by_role('alert')).to_contain_text('30 seconds'); self.hung_route.abort('timedout'); self.hung_route=None; self.page.get_by_role('button', name='Retry original save', exact=True).click(); self.closed(); self.assertEqual(self.calls[0], self.calls[1]); self.assertEqual(len(self.jobs), 2)
    def test_expired_auth_after_lost_write_retains_receipt(self):
        self.open(); self.create(); self.lost_once = True; self.submit('Create job'); expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        self.read_status = 401; self.page.get_by_role('button', name='Retry original save', exact=True).click(); expect(self.page.get_by_role('alert')).to_contain_text('sign-in expired')
        self.assertEqual(len(self.calls), 1); self.assertIsNotNone(self.page.evaluate("sessionStorage.getItem('egc.dispatch.pending.v1.manager.one')"))
        self.read_status = 200; self.page.get_by_role('button', name='Retry original save', exact=True).click(); self.closed(); self.assertEqual(len(self.jobs), 2)
    def test_account_switch_cannot_retry_another_managers_request(self):
        self.open(); self.create(); self.lost_once = True; self.submit('Create job'); expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        self.viewer = 'manager.two'; self.page.get_by_role('button', name='Retry original save', exact=True).click(); expect(self.page.get_by_role('alert')).to_contain_text('manager account that started')
        self.assertEqual(len(self.calls), 1); self.page.reload(); expect(self.card()).to_be_visible(); expect(self.page.get_by_role('button', name='Review unverified save', exact=True)).to_have_count(0)
        self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))"); self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(key=>key.startsWith('egc.dispatch.pending.')).length"), 0)
    def test_incomplete_read_does_not_present_fake_empty_schedule(self):
        self.bad_read = True; self.page.goto(self.url); expect(self.page.get_by_role('alert')).to_contain_text('incomplete'); expect(self.page.get_by_role('heading', name='No jobs match these filters.', exact=True)).to_have_count(0)
    def test_openings_require_explicit_employees_and_seed_a_reviewable_booking(self):
        self.open(); self.page.get_by_role('button', name='Find opening', exact=True).click(); self.submit('Check openings'); expect(self.page.get_by_role('alert')).to_contain_text('Choose the employees'); self.assertEqual(self.opening_queries, [])
        self.page.get_by_role('combobox', name='Saved crew to check', exact=True).select_option('crew-main'); self.page.get_by_role('combobox', name='Vehicle to check', exact=True).select_option('truck-1'); self.submit('Check openings')
        expect(self.page.get_by_role('dialog')).to_contain_text('Confirm these employees are working'); query = self.opening_queries[-1]; self.assertEqual(query['employeeIds'], ['crew.one,lead.one']); self.assertEqual(query['vehicleId'], ['truck-1']); self.assertEqual(query['endDate'], ['2026-09-29'])
        self.page.get_by_role('button', name='Use this opening', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_attribute('aria-label', 'Create job')
        expect(self.page.get_by_label('Start time', exact=True)).to_have_value('13:00'); expect(self.page.get_by_label('End time', exact=True)).to_have_value('15:00'); expect(self.page.get_by_role('combobox', name='Crew lead', exact=True)).to_have_value('lead.one'); expect(self.page.get_by_role('combobox', name='Vehicle / truck', exact=True)).to_have_value('truck-1'); expect(self.page.get_by_label('Required crew size', exact=True)).to_have_value('2'); self.assertEqual(self.calls, [])
        self.page.locator('input[name=customerSearch]').fill('Johnson'); self.page.get_by_role('button', name=CUSTOMER['name']+' · '+CUSTOMER['phone'], exact=True).click(); self.page.get_by_label('Service', exact=True).fill('From verified opening'); self.submit('Create job'); self.closed(); self.assertEqual(self.calls[-1]['changes']['time'], '13:00')
    def test_openings_clear_stale_suggestions_and_report_backend_failure(self):
        self.open(); self.page.get_by_role('button', name='Find opening', exact=True).click(); self.page.get_by_label('Crew One', exact=True).check(); self.submit('Check openings'); expect(self.page.get_by_role('button', name='Use this opening', exact=True)).to_be_visible()
        self.page.get_by_label('Job duration (minutes)', exact=True).fill('180'); expect(self.page.get_by_role('button', name='Use this opening', exact=True)).to_have_count(0)
        self.opening_failure = 'The schedule changed while checking. Retry the search.'; self.submit('Check openings'); expect(self.page.get_by_role('alert')).to_contain_text('schedule changed'); expect(self.page.get_by_role('heading', name='No matching openings', exact=True)).to_have_count(0)
    def test_openings_empty_and_mobile_layout(self):
        self.open(); self.page.set_viewport_size({'width': 320, 'height': 850}); self.page.get_by_role('button', name='Find opening', exact=True).click(); self.page.get_by_label('Crew Two', exact=True).check(); self.opening_candidates = []; self.submit('Check openings'); expect(self.page.get_by_role('heading', name='No matching openings', exact=True)).to_be_visible()
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 321); self.assertLessEqual(self.page.get_by_role('dialog').evaluate('(el)=>el.scrollWidth'), self.page.get_by_role('dialog').evaluate('(el)=>el.clientWidth')+1)
    def test_openings_send_an_optional_job_zip_or_address_for_drive_estimates(self):
        self.open(); self.page.get_by_role('button', name='Find opening', exact=True).click(); self.page.get_by_label('Crew One', exact=True).check(); self.submit('Check openings'); expect(self.page.get_by_role('button', name='Use this opening', exact=True)).to_be_visible()
        self.assertNotIn('zip', self.opening_queries[-1]); self.assertNotIn('address', self.opening_queries[-1])
        place = self.page.get_by_role('textbox', name='New job ZIP or address (optional)', exact=True); self.assertEqual(place.evaluate('el=>el.type'), 'text')
        place.fill('80525'); expect(self.page.get_by_role('button', name='Use this opening', exact=True)).to_have_count(0); self.submit('Check openings'); expect(self.page.get_by_role('button', name='Use this opening', exact=True)).to_be_visible()
        self.assertEqual(self.opening_queries[-1]['zip'], ['80525']); self.assertNotIn('address', self.opening_queries[-1])
        place.fill('  200 Synthetic Ave, Loveland, CO 80537 '); self.submit('Check openings'); expect(self.page.get_by_role('button', name='Use this opening', exact=True)).to_be_visible()
        self.assertEqual(self.opening_queries[-1]['address'], ['200 Synthetic Ave, Loveland, CO 80537']); self.assertNotIn('zip', self.opening_queries[-1]); self.assertEqual(self.calls, [])
    def quoted_backlog(self, **changes):
        return job(**{'id': 'job-quoted', 'revision': 'quoted-rev-1', 'customer': 'Synthetic Quoted Garage', 'date': '', 'time': '', 'endDate': '', 'endTime': '', 'startAt': None, 'endAt': None, 'status': 'unscheduled',
                      'assignedCrew': ['crew.one', 'crew.two'], 'crewLead': 'crew.one', 'crewId': None, 'vehicleId': None, 'crewNeeded': 3, 'travelBufferMinutes': 35, 'suggestedDurationMin': 165, 'durationSource': 'line_items', **changes})
    def test_quote_duration_prefills_unscheduled_work_and_keeps_the_end_with_the_start(self):
        self.jobs = [job(), self.quoted_backlog()]; self.open(); self.schedule('Synthetic Quoted Garage')
        length = self.page.get_by_role('combobox', name='Expected duration', exact=True); end_date = self.page.get_by_label('End date', exact=True); end = self.page.get_by_label('End time', exact=True); start = self.page.get_by_label('Start time', exact=True)
        expect(length).to_have_value('165'); expect(length.locator('option:checked')).to_have_text('2 hr 45 min · suggested'); expect(end).to_have_value('10:45')
        self.assertEqual(length.evaluate("el=>document.getElementById(el.getAttribute('aria-describedby')).textContent"), 'Suggested from the sold quote: 2 hr 45 min for a crew of 3.')
        self.page.get_by_label('Keep unscheduled', exact=True).uncheck(); self.page.get_by_label('Start date', exact=True).fill('2026-09-24'); start.fill('22:30')
        expect(end_date).to_have_value('2026-09-25'); expect(end).to_have_value('01:15')
        start.fill('13:00'); expect(end_date).to_have_value('2026-09-24'); expect(end).to_have_value('15:45'); self.assertEqual(self.calls, [])
        self.submit('Save changes'); self.closed(); write = self.calls[-1]
        self.assertEqual((write['action'], write['jobId'], write['expectedRevision']), ('schedule.update', 'job-quoted', 'quoted-rev-1'))
        self.assertEqual([write['changes'][key] for key in ['date', 'time', 'endDate', 'endTime']], ['2026-09-24', '13:00', '2026-09-24', '15:45']); self.assertNotIn('estimatedDurationMin', write['changes'])
    def test_scheduled_work_keeps_its_end_until_a_length_is_chosen_and_a_hand_edited_end_stops_following(self):
        self.jobs = [job(suggestedDurationMin=180, durationSource='line_items')]; self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click()
        length = self.page.get_by_role('combobox', name='Expected duration', exact=True); end = self.page.get_by_label('End time', exact=True); start = self.page.get_by_label('Start time', exact=True)
        expect(length).to_have_value(''); expect(length.locator('option[value="180"]')).to_have_text('3 hours · suggested'); expect(end).to_have_value('10:00')
        expect(self.page.get_by_role('dialog')).to_contain_text('Suggested from the sold quote: 3 hr for a crew of 2.')
        length.select_option('180'); expect(end).to_have_value('11:00'); start.fill('09:00'); expect(end).to_have_value('12:00')
        end.fill('12:30'); expect(length).to_have_value(''); start.fill('09:30'); expect(end).to_have_value('12:30')
        self.submit('Save changes'); self.closed(); self.assertEqual([self.calls[-1]['changes'][key] for key in ['time', 'endTime']], ['09:30', '12:30'])
    def test_span_and_default_lengths_are_not_offered_as_suggestions(self):
        self.jobs = [job(suggestedDurationMin=120, durationSource='schedule_span'), self.quoted_backlog(suggestedDurationMin=120, durationSource='default')]; self.open()
        expect(self.page.get_by_role('button', name='Find a time for '+CUSTOMER['name'], exact=True)).to_have_count(0)
        for name in [CUSTOMER['name'], 'Synthetic Quoted Garage']:
            if name == CUSTOMER['name']: self.card(name).get_by_role('button', name='Edit / assign', exact=True).click()
            else: self.schedule(name)
            dialog = self.page.get_by_role('dialog')
            expect(self.page.get_by_role('combobox', name='Expected duration', exact=True)).to_have_value(''); expect(dialog).not_to_contain_text('suggested'); expect(dialog).not_to_contain_text('Suggested from')
            expect(self.page.get_by_label('End time', exact=True)).to_have_value('10:00'); self.page.get_by_role('button', name='Back', exact=True).click(); self.closed()
    def test_find_a_time_searches_with_the_quote_length_and_books_the_same_unscheduled_job(self):
        self.jobs = [job(), self.quoted_backlog()]; self.open(); self.page.set_viewport_size({'width': 375, 'height': 812}); self.to_schedule()
        find = self.queued('Synthetic Quoted Garage').get_by_role('button', name='Find a time for Synthetic Quoted Garage', exact=True)
        expect(find).to_be_visible(); self.assertGreaterEqual(find.bounding_box()['height'], 44); find.click()
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_have_attribute('aria-label', 'Find a time for Synthetic Quoted Garage')
        expect(self.page.get_by_label('Job duration (minutes)', exact=True)).to_have_value('165'); expect(self.page.get_by_label('Travel buffer (minutes)', exact=True)).to_have_value('35')
        expect(dialog).to_contain_text('Suggested from the sold quote: 2 hr 45 min for a crew of 3.')
        for name, checked in [('Crew One', True), ('Crew Two', True), ('Lead One', False)]: self.assertEqual(self.page.get_by_label(name, exact=True).is_checked(), checked, name)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375); self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth')+1)
        self.submit('Check openings'); expect(self.page.get_by_role('button', name='Use this opening', exact=True)).to_be_visible(); query = self.opening_queries[-1]
        self.assertEqual((query['durationMinutes'], query['employeeIds'], query['travelBufferMinutes']), (['165'], ['crew.one,crew.two'], ['35']))
        self.page.get_by_role('button', name='Use this opening', exact=True).click(); expect(dialog).to_have_attribute('aria-label', 'Edit / assign job')
        expect(self.page.get_by_label('Keep unscheduled', exact=True)).not_to_be_checked(); expect(self.page.get_by_label('Start date', exact=True)).to_have_value(DAY)
        expect(self.page.get_by_label('Start time', exact=True)).to_have_value('13:00'); expect(self.page.get_by_label('End time', exact=True)).to_have_value('15:00'); self.assertEqual(self.calls, [])
        self.submit('Save changes'); self.closed(); write = self.calls[-1]
        self.assertEqual((write['action'], write['jobId'], write['expectedRevision']), ('schedule.update', 'job-quoted', 'quoted-rev-1'))
        self.assertEqual([write['changes'][key] for key in ['date', 'time', 'endDate', 'endTime']], [DAY, '13:00', DAY, '15:00']); self.assertEqual(write['changes']['assignedCrew'], ['crew.one', 'crew.two'])
    def test_a_suggestion_longer_than_a_workday_is_listed_but_never_applied_as_one_overnight_block(self):
        self.jobs = [job(), self.quoted_backlog(suggestedDurationMin=2010, durationSource='estimated_duration')]; self.open(); self.page.set_viewport_size({'width': 375, 'height': 812}); self.to_schedule()
        self.page.get_by_role('button', name='Find a time for Synthetic Quoted Garage', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(self.page.get_by_label('Job duration (minutes)', exact=True)).to_have_value('120'); expect(dialog).to_contain_text('Suggested from the saved estimate: 33 hr 30 min. Openings cover one day at a time')
        self.page.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.queued('Synthetic Quoted Garage').get_by_role('button', name='Schedule Synthetic Quoted Garage', exact=True).click()
        length = self.page.get_by_role('combobox', name='Expected duration', exact=True); expect(length).to_have_value(''); expect(length.locator('option[value="2010"]')).to_have_text('33 hr 30 min · suggested')
        expect(self.page.get_by_label('End date', exact=True)).to_have_value(DAY); expect(self.page.get_by_label('End time', exact=True)).to_have_value('10:00')
        self.assertEqual(length.evaluate("el=>document.getElementById(el.getAttribute('aria-describedby')).textContent"), 'Suggested from the saved estimate: 33 hr 30 min. That is longer than one workday, so split it across days rather than one overnight block.')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375); self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth')+1)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); length.scroll_into_view_if_needed(); self.page.screenshot(path=str(out/'dispatch-duration-mobile.png'))
        self.page.get_by_role('button', name='Back', exact=True).click(); self.closed()
        self.jobs[1].update({'suggestedDurationMin': 1440, 'durationSource': 'line_items', 'durationCoverage': 'partial', 'durationCapped': True}); self.page.reload(); self.schedule('Synthetic Quoted Garage')
        expect(self.page.get_by_role('combobox', name='Expected duration', exact=True)).to_have_value(''); expect(self.page.get_by_label('End time', exact=True)).to_have_value('10:00')
        expect(self.page.locator('.dp-duration-hint')).to_have_text('Suggested from the sold quote: 24 hr for a crew of 3. Some sold lines have no time estimate, so allow extra time. The lines add up to more than 24 hr, so plan the work across days.')
    def test_changing_the_crew_size_drops_an_applied_suggestion_until_the_server_recalculates_it(self):
        self.jobs = [job(), self.quoted_backlog()]; self.open(); self.schedule('Synthetic Quoted Garage')
        length = self.page.get_by_role('combobox', name='Expected duration', exact=True); crew = self.page.get_by_label('Required crew size', exact=True); hint = self.page.locator('.dp-duration-hint'); end = self.page.get_by_label('End time', exact=True)
        expect(length).to_have_value('165'); expect(end).to_have_value('10:45'); expect(hint).to_have_attribute('aria-live', 'polite')
        crew.fill('4'); expect(length).to_have_value(''); expect(hint).to_have_text('Suggested from the sold quote: 2 hr 45 min for a crew of 3. The crew size changed, so check the end time; the suggestion is recalculated after you save.')
        crew.fill('3'); expect(hint).to_have_text('Suggested from the sold quote: 2 hr 45 min for a crew of 3.'); expect(length).to_have_value('')
        self.page.get_by_label('Keep unscheduled', exact=True).uncheck(); self.page.get_by_label('Start time', exact=True).fill('13:00'); expect(end).to_have_value('10:45'); self.assertEqual(self.calls, [])
    def test_an_opening_is_booked_with_the_buffer_employees_and_lead_it_was_checked_with(self):
        self.jobs = [job(), self.quoted_backlog()]; self.open(); self.to_schedule(); self.page.get_by_role('button', name='Find a time for Synthetic Quoted Garage', exact=True).click()
        self.page.get_by_label('Travel buffer (minutes)', exact=True).fill('50'); self.page.get_by_label('Crew One', exact=True).uncheck(); self.submit('Check openings')
        query = self.opening_queries[-1]; self.assertEqual((query['travelBufferMinutes'], query['employeeIds']), (['50'], ['crew.two']))
        self.page.get_by_role('button', name='Use this opening', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_attribute('aria-label', 'Edit / assign job')
        expect(self.page.get_by_label('Travel buffer (minutes)', exact=True)).to_have_value('50'); expect(self.page.get_by_role('combobox', name='Crew lead', exact=True)).to_have_value('')
        self.submit('Save changes'); self.closed(); changes = self.calls[-1]['changes']
        self.assertEqual((changes['travelBufferMinutes'], changes['assignedCrew'], changes['crewLead']), (50, ['crew.two'], None))
    def test_drive_times_show_ordered_legs_without_writes_and_fit_phones(self):
        self.open(); self.page.set_viewport_size({'width': 375, 'height': 812}); self.page.get_by_role('button', name='Drive times', exact=True).click()
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_have_attribute('aria-label', 'Drive times'); expect(dialog).to_contain_text('Crew One'); self.assertEqual(self.travel_queries[-1]['date'], [DAY])
        expect(dialog).to_contain_text('3 stops · about 30 min estimated driving · 1 tight gap')
        expect(dialog.locator('.dp-warning')).to_have_text('15 min gap · about 30 min drive (ZIP estimate) · buffer 20 min · short by 15 min')
        expect(dialog.locator('p.dp-muted').filter(has_text='60 min gap')).to_have_text('60 min gap · no drive estimate · buffer 20 min · enough time')
        expect(dialog.get_by_text('Address needed', exact=True)).to_be_visible(); expect(dialog.get_by_role('alert')).to_contain_text('route is incomplete'); expect(dialog).to_contain_text('1 leg has no drive estimate')
        self.assertEqual(self.page.locator('img').count(), 0); self.assertIsNone(self.page.evaluate('window.injected'))
        for width in [375, 320]:
            self.page.set_viewport_size({'width': width, 'height': 812}); self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width+1); self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth')+1)
            for name in ['Back', 'Show drive times']: self.assertGreaterEqual(dialog.get_by_role('button', name=name, exact=True).bounding_box()['height'], 44)
        self.assertEqual(self.page.get_by_label('Route date', exact=True).evaluate('el=>parseFloat(getComputedStyle(el).fontSize)'), 16)
        self.page.get_by_label('Route date', exact=True).fill('2026-09-23'); expect(dialog.locator('.dp-search-result')).to_have_count(0); self.submit('Show drive times')
        expect(dialog.get_by_role('heading', name='Wednesday, September 23', exact=True)).to_be_visible(); self.assertEqual(self.travel_queries[-1]['date'], ['2026-09-23'])
        self.travel_failure = 'Drive times are unavailable. Retry.'; self.submit('Show drive times'); expect(dialog.get_by_role('alert')).to_contain_text('Drive times are unavailable'); expect(dialog.locator('.dp-search-result')).to_have_count(0)
        self.page.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.assertEqual(self.calls, [])
    def test_attention_counts_jobs_and_includes_completed_handoff_failures(self):
        self.jobs[0].update({'activity': 'delayed', 'activityReason': 'Truck repair is delaying departure.', 'attention': {'status': 'open', 'reason': 'Customer requested a manager callback.'}})
        self.jobs.append(job(id='done-job', customer='Completed customer', status='completed', activity='completed', completionSync={'status': 'blocked', 'message': 'CRM completion configuration needs review.'}))
        self.jobs.append(job(id='cancelled-job', customer='Cancelled customer', status='cancelled'))
        self.open(); expect(self.card()).to_contain_text('Delayed'); expect(self.card().get_by_role('link', name='Review job issue', exact=True)).to_have_attribute('href', '/crew/job.html?jobId=job-1')
        expect(self.page.locator('.dp-stats article').filter(has_text='Needs attention').locator('strong')).to_have_text('2'); expect(self.page.locator('.dp-stats article').filter(has_text='Scheduled').locator('strong')).to_have_text('2')
        self.page.get_by_role('button', name='Review jobs needing attention', exact=True).click(); expect(self.page.get_by_label('Filter by status', exact=True)).to_have_value('attention'); expect(self.page.locator('.dp-job')).to_have_count(2); expect(self.page.locator('.dp-job').filter(has_text='Completed customer')).to_contain_text('configuration needs review')
    def test_company_time_block_has_a_real_editor_and_no_field_job_dead_link(self):
        self.open(); self.page.get_by_role('button', name='Block time', exact=True).click(); self.page.get_by_label('Reason / title', exact=True).fill('Company safety training'); self.page.get_by_label('Start time', exact=True).fill('16:00'); self.page.get_by_label('End time', exact=True).fill('17:00'); self.submit('Save time block'); self.closed()
        write = self.calls[-1]; self.assertEqual(write['kind'], 'blocked'); self.assertNotIn('customerId', write); block = self.page.locator('.dp-job').filter(has_text='Company safety training'); expect(block.get_by_role('link', name='Open job', exact=True)).to_have_count(0); expect(block).not_to_contain_text('Address needed')
        block.get_by_role('button', name='Edit / assign', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_attribute('aria-label', 'Edit company time block'); self.page.get_by_label('Internal notes', exact=True).fill('Bring gloves'); self.submit('Save time block'); self.closed(); self.assertEqual(self.calls[-1]['changes']['opsNotes'], 'Bring gloves')
    def test_midnight_ending_assignment_is_not_shown_on_the_next_day(self):
        self.jobs[0].update({'endDate': '2026-09-23', 'endTime': '00:00', 'endAt': '2026-09-23T00:00:00-06:00'}); self.open(); self.page.get_by_role('button', name='Tomorrow', exact=True).click(); expect(self.page.locator('.dp-job')).to_have_count(0); expect(self.page.locator('.dp-stats article').filter(has_text='Scheduled').locator('strong')).to_have_text('0')
    def test_global_search_finds_history_outside_the_board_range_and_opens_its_day(self):
        historical=job(id='old-job', customer='Historical Customer', date='2025-02-03', endDate='2025-02-03', status='completed'); self.jobs.append(historical); self.search_results=[{'job': historical, 'canonicalCustomerName': 'Current Customer Name'}]
        self.open(); expect(self.page.locator('.dp-job').filter(has_text='Historical Customer')).to_have_count(0); self.page.get_by_role('button', name='Search all jobs', exact=True).click(); self.page.get_by_label('Search all dates', exact=True).fill('Historical'); self.submit('Search history')
        expect(self.page.locator('.dp-search-result')).to_contain_text('2025-02-03'); expect(self.page.locator('.dp-search-result')).to_contain_text('Current Customer Name'); expect(self.page.locator('.dp-search-result').get_by_role('link', name='Open job', exact=True)).to_have_attribute('href','/crew/job.html?jobId=old-job'); self.assertEqual(self.search_queries[-1]['q'], ['Historical'])
        self.page.get_by_role('button', name='Show in dispatch', exact=True).click(); self.closed(); expect(self.page.get_by_label('Schedule date', exact=True)).to_have_value('2025-02-03'); expect(self.page.locator('.dp-job')).to_contain_text('Historical Customer'); expect(self.page.get_by_label('Filter by status', exact=True)).to_have_value('all')
    def test_global_search_failure_is_explicit_and_does_not_show_false_zero_results(self):
        self.open(); self.page.set_viewport_size({'width': 320, 'height': 850}); self.page.get_by_role('button', name='Search all jobs', exact=True).click(); self.page.get_by_label('Search all dates', exact=True).fill('customer'); self.search_failure='History storage unavailable. Retry.'; self.submit('Search history'); expect(self.page.get_by_role('alert')).to_contain_text('storage unavailable'); expect(self.page.get_by_text('No Hub jobs match.', exact=False)).to_have_count(0)
        self.search_failure=None; self.submit('Search history'); expect(self.page.get_by_text('No Hub jobs match.', exact=False)).to_be_visible(); self.assertLessEqual(self.page.get_by_role('dialog').evaluate('(el)=>el.scrollWidth'),self.page.get_by_role('dialog').evaluate('(el)=>el.clientWidth')+1)
    def test_revision_conflict_preserves_text_until_explicit_draft_discard(self):
        self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); self.page.get_by_label('Scope of work', exact=True).fill('My retained draft')
        self.jobs[0]['revision'] = 'changed-on-server'; self.submit('Save changes'); expect(self.page.get_by_label('Scope of work', exact=True)).to_have_value('My retained draft')
        self.page.get_by_role('button', name='Discard draft and load latest', exact=True).click(); self.closed(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); self.submit('Save changes'); self.closed(); self.assertEqual(self.calls[-1]['expectedRevision'], 'changed-on-server')
    def test_unknown_save_then_definite_rejection_unlocks_original_form_controls(self):
        self.open(); self.create(); self.fail_once = (503, 'dispatch_unavailable', 'Save not confirmed', {}); self.submit('Create job')
        expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible(); self.fail_once = (400, 'dispatch_validation', 'Select a valid service', {})
        self.page.get_by_role('button', name='Retry original save', exact=True).click(); expect(self.page.get_by_role('alert')).to_contain_text('Select a valid service')
        expect(self.page.get_by_label('Service', exact=True)).to_be_enabled(); self.page.get_by_label('Service', exact=True).fill('Corrected service'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[0], self.calls[1]); self.assertNotEqual(self.calls[1]['requestId'], self.calls[2]['requestId'])
    def test_inactive_assigned_employee_requires_explicit_removal(self):
        self.jobs[0]['assignedCrew'].append('inactive.employee'); self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click()
        unavailable = self.page.get_by_role('checkbox', name='inactive.employee Unavailable employee — reassign before saving', exact=True)
        expect(unavailable).to_be_checked(); unavailable.uncheck(); self.submit('Save changes'); self.closed(); self.assertNotIn('inactive.employee', self.calls[-1]['changes']['assignedCrew'])
    def test_cancel_and_restore_record(self):
        self.open(); self.card().get_by_role('button', name='Cancel', exact=True).click(); self.submit('Cancel job'); self.closed(); self.page.get_by_label('Filter by status', exact=True).select_option('cancelled')
        self.card().get_by_role('button', name='Restore', exact=True).click(); self.submit('Restore job'); self.closed(); self.page.get_by_label('Filter by status', exact=True).select_option('active'); expect(self.card()).to_be_visible()
        self.assertEqual([row['action'] for row in self.calls], ['schedule.cancel', 'schedule.restore'])
    def test_customer_phone_employee_search_and_filters(self):
        self.jobs.append(job(id='other', customer='Second customer', phone='(970) 555-0199', assignedCrew=['crew.two'], crewId=None)); self.open()
        self.page.get_by_role('searchbox', name='Search jobs', exact=True).fill('9705550100'); expect(self.page.locator('.dp-job')).to_have_count(1)
        self.page.get_by_role('searchbox', name='Search jobs', exact=True).fill(''); self.page.get_by_label('Filter by employee', exact=True).select_option('crew.two'); expect(self.page.locator('.dp-job')).to_have_count(1); expect(self.page.locator('.dp-job')).to_contain_text('Second customer')
        self.page.get_by_label('Filter by work type', exact=True).select_option('walkthrough'); expect(self.page.get_by_role('heading', name='No jobs match these filters.', exact=True)).to_be_visible()
    def test_crews_vehicle_and_availability_forms_use_resource_contract(self):
        self.open(); self.page.get_by_role('button', name='Crews & vehicles', exact=True).click(); self.page.get_by_role('button', name='Add crew', exact=True).click()
        self.page.get_by_label('Crew name', exact=True).fill('New crew'); self.page.get_by_label('Crew Two', exact=True).check(); self.page.get_by_role('combobox', name='Crew lead', exact=True).select_option('crew.two'); self.submit('Save crew'); self.closed()
        self.assertEqual(self.calls[-1]['changes']['memberIds'], ['crew.two']); self.assertEqual(self.calls[-1]['changes']['leadId'], 'crew.two')
        self.page.get_by_role('button', name='Crews & vehicles', exact=True).click(); self.page.get_by_role('button', name='Add vehicle', exact=True).click(); self.page.get_by_label('Vehicle name', exact=True).fill('Trailer'); self.submit('Save vehicle'); self.closed()
        self.assertEqual(self.calls[-1]['action'], 'vehicle.save'); self.assertEqual(self.calls[-1]['changes']['status'], 'available')
        self.page.get_by_role('button', name='Crews & vehicles', exact=True).click(); self.page.get_by_role('button', name='Add time off', exact=True).click(); self.page.get_by_role('combobox', name='Employee', exact=True).select_option('crew.two'); self.page.get_by_label('All day', exact=True).uncheck(); self.submit('Save availability'); self.closed()
        self.assertEqual(self.calls[-1]['changes']['allDay'], False); self.assertEqual(self.calls[-1]['action'], 'availability.save')
    def test_signout_and_expired_session_clear_loaded_customer_data(self):
        self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))")
        expect(self.page.locator('#host')).to_be_empty(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.page.evaluate('EGCDispatch.mount(document.querySelector("#host"))'); expect(self.card()).to_be_visible(); self.read_status = 401
        self.page.get_by_role('button', name='Refresh', exact=True).click(); expect(self.page.get_by_role('alert')).to_contain_text('sign-in expired'); expect(self.page.locator('.dp-job')).to_have_count(0)
    def test_mobile_views_forms_and_untrusted_text_have_no_overflow(self):
        self.jobs[0]['jobInstructions'] = '<img src=x onerror="window.injected=true">'; self.open()
        for width in [1360, 390, 320]:
            self.page.set_viewport_size({'width': width, 'height': 850})
            for view in ['Day', 'Week', 'Crew', 'Jobs']:
                self.page.get_by_role('button', name=view, exact=True).click(); expect(self.card()).to_be_visible(); self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width+1)
        self.assertEqual(self.page.locator('img').count(), 0); self.assertIsNone(self.page.evaluate('window.injected'))
        self.create(); self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 321); self.assertLessEqual(self.page.get_by_role('dialog').evaluate('(el)=>el.scrollWidth'), self.page.get_by_role('dialog').evaluate('(el)=>el.clientWidth')+1)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'dispatch-mobile-create.png'), full_page=True)
        self.page.get_by_role('button', name='Back', exact=True).click(); self.page.screenshot(path=str(out/'dispatch-mobile.png'), full_page=True)
    def test_arrival_window_inputs_fit_phone_move_with_start_and_send_contained_range(self):
        self.jobs[0].update({'arrivalWindowStart': '07:30', 'arrivalWindowEnd': '09:00', 'arrivalWindow': '7:30 AM – 9:00 AM'})
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); expect(self.card()).to_contain_text('Arrival window: 7:30 AM – 9:00 AM')
        self.card().get_by_role('button', name='Edit / assign', exact=True).click()
        arrive_from = self.page.get_by_label('Arrival from', exact=True); arrive_to = self.page.get_by_label('Arrival to', exact=True)
        expect(arrive_from).to_have_value('07:30'); expect(arrive_to).to_have_value('09:00'); expect(arrive_from).to_have_accessible_description(re.compile('must include the start time; leave both blank for none'))
        for control in [arrive_from, arrive_to]:
            self.assertEqual(control.get_attribute('type'), 'time'); self.assertEqual(control.evaluate('(el)=>getComputedStyle(el).fontSize'), '16px'); self.assertGreaterEqual(control.bounding_box()['height'], 44)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376); self.assertLessEqual(self.page.get_by_role('dialog').evaluate('(el)=>el.scrollWidth'), self.page.get_by_role('dialog').evaluate('(el)=>el.clientWidth')+1)
        self.page.get_by_label('Start time', exact=True).fill('10:00'); expect(arrive_from).to_have_value('09:30'); expect(arrive_to).to_have_value('11:00')
        self.page.get_by_label('End time', exact=True).fill('12:00'); arrive_to.fill('09:45'); self.submit('Save changes')
        expect(self.page.get_by_role('alert')).to_contain_text('arrival times'); self.assertEqual(self.calls, [])
        arrive_to.fill('11:00'); self.submit('Save changes'); self.closed(); changes = self.calls[-1]['changes']
        self.assertEqual((changes['time'], changes['arrivalWindowStart'], changes['arrivalWindowEnd']), ('10:00', '09:30', '11:00'))
    def test_arrival_window_is_optional_and_never_sent_for_unscheduled_work(self):
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); expect(self.card()).not_to_contain_text('Arrival window')
        self.create(); expect(self.page.get_by_label('Arrival from', exact=True)).to_have_value(''); self.submit('Create job'); self.closed()
        self.assertIsNone(self.calls[-1]['changes']['arrivalWindowStart']); self.assertIsNone(self.calls[-1]['changes']['arrivalWindowEnd'])
        self.create(); self.page.get_by_label('Arrival from', exact=True).fill('12:30'); self.page.get_by_label('Arrival to', exact=True).fill('13:30')
        self.page.get_by_label('Keep unscheduled', exact=True).check(); expect(self.page.get_by_label('Arrival from', exact=True)).to_be_disabled(); expect(self.page.get_by_label('Arrival to', exact=True)).to_be_disabled()
        self.submit('Create job'); self.closed(); self.assertEqual(self.calls[-1]['changes']['date'], ''); self.assertIsNone(self.calls[-1]['changes']['arrivalWindowStart'])
    def test_arrival_help_follows_default_setting_and_midnight_shift_is_explained(self):
        self.arrival_defaults = {'enabled': True, 'minutes': 90}
        self.jobs[0].update({'time': '20:00', 'endTime': '22:00', 'arrivalWindowStart': '19:30', 'arrivalWindowEnd': '21:00', 'arrivalWindow': '7:30 PM – 9:00 PM'})
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click()
        arrive_from = self.page.get_by_label('Arrival from', exact=True); arrive_to = self.page.get_by_label('Arrival to', exact=True)
        expect(arrive_from).to_have_accessible_description(re.compile('leave both blank to use the default 90-minute window from the start time'))
        note = self.page.get_by_role('dialog').locator('.dp-arrival-note [role=status]'); expect(note).to_have_count(0)
        self.page.get_by_label('Start time', exact=True).fill('23:30')
        expect(arrive_from).to_have_value(''); expect(arrive_to).to_have_value('')
        expect(note).to_be_visible(); expect(note).to_contain_text('would cross midnight'); expect(note).to_contain_text('default 90-minute window')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376); self.assertLessEqual(self.page.get_by_role('dialog').evaluate('(el)=>el.scrollWidth'), self.page.get_by_role('dialog').evaluate('(el)=>el.clientWidth')+1)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); note.scroll_into_view_if_needed(); self.page.screenshot(path=str(out/'dispatch-arrival-midnight.png'))
        arrive_from.fill('23:00'); expect(note).to_have_count(0); self.assertEqual(self.calls, [])

    def test_segment_editor_is_absent_while_the_server_flag_is_off(self):
        self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_role('button', name='Add crew segment', exact=True)).to_have_count(0); expect(dialog.get_by_role('heading', name='Crew segments', exact=True)).to_have_count(0)
        self.submit('Save changes'); self.closed(); self.assertNotIn('assignmentSegments', self.calls[-1]['changes']); self.assertEqual(self.calls[-1]['changes']['assignedCrew'], ['crew.one', 'lead.one'])
    def test_calendar_shows_each_segment_on_its_own_day_and_crew(self):
        self.segments = {'enabled': True, 'max': 31}; self.jobs.append(self.split_job()); self.open()
        card = self.card('Synthetic Split Garage'); expect(card.locator('.dp-segment-list li')).to_have_count(2); expect(card).to_contain_text('By segment')
        expect(card.locator('.dp-segment-list li').first).to_contain_text('8:00 AM – 5:00 PM · Crew One · Lead Crew One · Box Truck · Synthetic front bay')
        self.page.get_by_role('button', name='Week', exact=True).click(); days = self.page.locator('.dp-day')
        split_on = lambda index: days.nth(index).locator('.dp-job').filter(has=self.page.get_by_role('heading', name='Synthetic Split Garage', exact=True))
        expect(split_on(0)).to_have_count(1); expect(split_on(1)).to_have_count(0); expect(split_on(2).locator('.dp-segment-list li')).to_have_count(1); expect(split_on(2)).to_contain_text('8:00 AM – 12:00 PM · Crew Two')
        self.page.get_by_label('Filter by employee', exact=True).select_option('crew.one'); expect(split_on(0)).to_have_count(1); expect(split_on(2)).to_have_count(0)
        self.page.get_by_label('Filter by employee', exact=True).select_option(''); self.page.get_by_role('button', name='Crew', exact=True).click()
        group = self.page.locator('.dp-crew-group').filter(has=self.page.get_by_role('heading', name='Crew Two', exact=True))
        expect(group).to_contain_text('2 jobs · 13.0 reserved hours'); expect(group.locator('.dp-segment-list li')).to_have_count(2); expect(group).not_to_contain_text('Synthetic front bay')
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.page.get_by_role('button', name='Week', exact=True).click(); expect(split_on(0)).to_have_count(1)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376); self.assertEqual(self.calls, [])
    def test_phone_manager_adds_a_parallel_crew_segment(self):
        self.segments = {'enabled': True, 'max': 31}; self.vehicles.append({'id': 'van-1', 'revision': 'van-rev-1', 'name': 'Synthetic Van', 'status': 'available', 'notes': ''})
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_role('heading', name='Crew segments', exact=True)).to_be_visible(); add = dialog.get_by_role('button', name='Add crew segment', exact=True); add.click()
        expect(dialog.locator('.dp-segment-card')).to_have_count(2); expect(dialog.get_by_label('Start time', exact=True)).to_be_hidden(); expect(dialog.get_by_role('button', name='Split across days', exact=True)).to_have_count(0)
        second = dialog.get_by_role('region', name='Segment 2'); expect(second.get_by_label('Segment start', exact=True)).to_have_value('08:00')
        second.get_by_label('Crew Two', exact=True).check(); second.get_by_role('combobox', name='Segment vehicle', exact=True).select_option('van-1'); second.get_by_label('Segment notes', exact=True).fill('Synthetic back shelving')
        for control in [add, second.get_by_role('button', name='Remove segment 2', exact=True), second.get_by_label('Segment start', exact=True), second.get_by_role('combobox', name='Segment vehicle', exact=True), second.locator('label.dp-check').first]:
            self.assertGreaterEqual(control.bounding_box()['height'], 44)
        self.assertEqual(second.get_by_label('Segment date', exact=True).evaluate('(el)=>getComputedStyle(el).fontSize'), '16px')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376); self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth')+1)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); second.scroll_into_view_if_needed(); self.page.screenshot(path=str(out/'dispatch-segments-phone.png'))
        self.submit('Save changes'); self.closed(); changes = self.calls[-1]['changes']
        for name in ['date', 'time', 'endDate', 'endTime', 'assignedCrew', 'crewId', 'crewLead', 'vehicleId']: self.assertNotIn(name, changes)
        segments = changes['assignmentSegments']; self.assertEqual(len(segments), 2); self.assertNotEqual(segments[0]['id'], segments[1]['id']); self.assertTrue(all(re.fullmatch(r'[A-Za-z0-9_-]{1,19}', row['id']) for row in segments))
        pick = lambda row, names: {name: row.get(name) for name in names}
        self.assertEqual(pick(segments[0], ['date', 'time', 'endDate', 'endTime', 'assignedCrew', 'crewLead', 'crewId', 'vehicleId']), {'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '10:00', 'assignedCrew': ['crew.one', 'lead.one'], 'crewLead': 'lead.one', 'crewId': 'crew-main', 'vehicleId': 'truck-1'})
        self.assertEqual(pick(segments[1], ['date', 'time', 'endTime', 'assignedCrew', 'crewLead', 'vehicleId', 'notes']), {'date': DAY, 'time': '08:00', 'endTime': '10:00', 'assignedCrew': ['crew.two'], 'crewLead': None, 'vehicleId': 'van-1', 'notes': 'Synthetic back shelving'})
    def test_split_across_days_makes_daily_windows_with_a_crew_per_day(self):
        self.segments = {'enabled': True, 'max': 31}; self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); self.card().get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        split = dialog.get_by_role('button', name='Split across days', exact=True); split.click(); expect(dialog.get_by_role('alert')).to_contain_text('later end date'); expect(dialog.locator('.dp-segment-card')).to_have_count(0)
        dialog.get_by_label('End date', exact=True).fill('2026-09-24'); dialog.get_by_label('End time', exact=True).fill('17:00'); split.click()
        expect(dialog.locator('.dp-segment-card')).to_have_count(3); expect(dialog.get_by_role('alert')).to_have_count(0)
        third = dialog.get_by_role('region', name='Segment 3'); expect(third.get_by_label('Segment date', exact=True)).to_have_value('2026-09-24'); expect(third.get_by_label('Segment end', exact=True)).to_have_value('17:00')
        third.get_by_label('Crew One', exact=True).uncheck(); third.get_by_label('Crew Two', exact=True).check(); third.get_by_role('combobox', name='Segment lead', exact=True).select_option('crew.two')
        dialog.get_by_role('region', name='Segment 2').get_by_role('button', name='Remove segment 2', exact=True).click(); expect(dialog.locator('.dp-segment-card')).to_have_count(2)
        expect(dialog.get_by_role('region', name='Segment 2').get_by_label('Segment date', exact=True)).to_have_value('2026-09-24')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376)
        self.submit('Save changes'); self.closed(); segments = self.calls[-1]['changes']['assignmentSegments']
        self.assertEqual([(row['date'], row['time'], row['endDate'], row['endTime'], row['assignedCrew'], row['crewLead']) for row in segments], [(DAY, '08:00', DAY, '17:00', ['crew.one', 'lead.one'], 'lead.one'), ('2026-09-24', '08:00', '2026-09-24', '17:00', ['lead.one', 'crew.two'], 'crew.two')])
    def test_segmented_job_with_the_flag_off_keeps_its_segments_or_clears_them(self):
        self.jobs.append(self.split_job()); self.open(); split = self.card('Synthetic Split Garage'); split.get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog).to_contain_text('Crew segments are turned off'); expect(dialog.get_by_role('button', name='Add crew segment', exact=True)).to_have_count(0)
        expect(dialog.get_by_role('region', name='Segment 1').get_by_label('Segment start', exact=True)).to_be_disabled(); expect(dialog.get_by_label('Start time', exact=True)).to_be_hidden()
        dialog.get_by_label('Scope of work', exact=True).fill('Synthetic updated scope'); self.submit('Save changes'); self.closed()
        changes = self.calls[-1]['changes']
        for name in ['assignmentSegments', 'date', 'time', 'assignedCrew', 'crewLead', 'vehicleId']: self.assertNotIn(name, changes)
        self.card('Synthetic Split Garage').get_by_role('button', name='Edit / assign', exact=True).click(); dialog.get_by_role('button', name='Remove all segments', exact=True).click()
        expect(dialog.get_by_label('Start time', exact=True)).to_be_visible(); expect(dialog.locator('.dp-segment-card')).to_have_count(0); self.submit('Save changes'); self.closed()
        changes = self.calls[-1]['changes']; self.assertEqual(changes['assignmentSegments'], []); self.assertEqual((changes['date'], changes['endDate'], changes['time'], changes['endTime']), (DAY, '2026-09-24', '08:00', '12:00')); self.assertEqual(changes['assignedCrew'], ['crew.one', 'crew.two'])
    def test_split_job_drag_is_refused_while_segments_are_off(self):
        # The split job alone, so the drag starts on its card.
        self.jobs = [self.split_job()]; self.page.goto(self.url); self.page.get_by_label('Schedule date', exact=True).fill(DAY); self.page.get_by_role('button', name='Week', exact=True).click(); days = self.page.locator('.dp-day')
        split_on = lambda index: days.nth(index).locator('.dp-job').filter(has=self.page.get_by_role('heading', name='Synthetic Split Garage', exact=True))
        expect(split_on(0)).to_have_count(1); split_on(0).drag_to(days.nth(3)); expect(self.page.get_by_role('dialog')).to_have_count(0)
        expect(self.page.locator('.dp-notice')).to_contain_text('Remove all segments to move this job while segments are off.'); expect(split_on(0)).to_have_count(1); self.assertEqual(self.calls, [])
        self.segments = {'enabled': True, 'max': 31}; self.page.get_by_role('button', name='Refresh', exact=True).click(); expect(self.page.get_by_role('button', name='Refresh', exact=True)).to_be_enabled()
        split_on(0).drag_to(days.nth(3)); dialog = self.page.get_by_role('dialog'); expect(dialog).to_be_visible()
        expect(dialog.get_by_role('region', name='Segment 1').get_by_label('Segment date', exact=True)).to_have_value('2026-09-25'); expect(dialog.get_by_role('region', name='Segment 3').get_by_label('Segment date', exact=True)).to_have_value('2026-09-27')
        self.submit('Save changes'); self.closed(); self.assertEqual([row['date'] for row in self.calls[-1]['changes']['assignmentSegments']], ['2026-09-25', '2026-09-25', '2026-09-27'])
    def test_unreadable_saved_segments_are_replaced_by_the_job_level_schedule(self):
        self.jobs.append(job(id='job-broken', revision='broken-rev-1', customer='Synthetic Broken Split', assignedCrew=['crew.one', 'crew.two'], crewLead='crew.one', crewId=None, vehicleId=None, assignmentSegments=[], segmentsInvalid=True))
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); self.card('Synthetic Broken Split').get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_role('alert')).to_contain_text('could not be read'); expect(dialog.get_by_label('Start time', exact=True)).to_be_visible(); expect(dialog.get_by_role('button', name='Add crew segment', exact=True)).to_have_count(0)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376)
        dialog.get_by_label('Start time', exact=True).fill('09:00'); dialog.get_by_label('End time', exact=True).fill('11:00'); self.submit('Save changes'); self.closed()
        changes = self.calls[-1]['changes']; self.assertEqual(changes['assignmentSegments'], []); self.assertEqual((changes['date'], changes['time'], changes['endDate'], changes['endTime']), (DAY, '09:00', DAY, '11:00')); self.assertEqual(changes['assignedCrew'], ['crew.one', 'crew.two'])
    def test_repeat_is_offered_only_for_jobs_without_segments(self):
        self.page.add_init_script('window.EGCRecurring={open(){window.repeatOpened=true;}}')
        self.jobs += [self.split_job(), job(id='job-broken', revision='broken-rev-1', customer='Synthetic Broken Split', assignmentSegments=[], segmentsInvalid=True)]; self.open()
        expect(self.card().locator('.dp-repeat')).to_have_count(1)
        for name in ['Synthetic Split Garage', 'Synthetic Broken Split']: expect(self.card(name).get_by_role('button', name='Edit / assign', exact=True)).to_be_visible(); expect(self.card(name).locator('.dp-repeat')).to_have_count(0)
    def test_booking_facts_and_reschedule_reason_come_from_the_shared_codes(self):
        self.funnel = FUNNEL; self.open(); self.create(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_role('combobox', name='Visit purpose', exact=True)).to_have_value('service')
        self.submit('Create job'); self.assertEqual(self.calls, [], 'the booking channel is one required tap')
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone'); dialog.get_by_role('combobox', name='Visit purpose', exact=True).select_option('return')
        dialog.get_by_role('combobox', name='How did they hear about us?', exact=True).select_option('referral'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'visitPurpose': 'return', 'channelSelfReported': 'referral'})
        self.page.get_by_role('button', name='Create job', exact=True).first.click(); dialog.get_by_role('combobox', name='Work type', exact=True).select_option('walkthrough')
        expect(dialog.get_by_role('combobox', name='Visit purpose', exact=True)).to_be_hidden(); self.page.get_by_role('button', name='Back', exact=True).click(); self.closed()
        self.card().get_by_role('button', name='Edit / assign', exact=True).click(); expect(dialog.get_by_role('group', name='Why is this visit moving?')).to_be_hidden()
        dialog.get_by_label('Access instructions', exact=True).fill('Use the side gate'); self.submit('Save changes'); self.closed(); self.assertNotIn('reasonCode', self.calls[-1])
        self.card().get_by_role('button', name='Edit / assign', exact=True).click(); dialog.get_by_label('Start time', exact=True).fill('09:00'); dialog.get_by_label('End time', exact=True).fill('11:00')
        moving = dialog.get_by_role('group', name='Why is this visit moving?'); expect(moving).to_be_visible(); calls = len(self.calls); self.submit('Save changes'); self.assertEqual(len(self.calls), calls, 'a move needs its reason')
        moving.get_by_role('combobox', name='Reason', exact=True).select_option('weather'); moving.get_by_role('combobox', name='Who asked for it?', exact=True).select_option('company'); self.submit('Save changes'); self.closed()
        self.assertEqual((self.calls[-1]['reasonCode'], self.calls[-1]['initiatedBy'], self.calls[-1]['changes']['time']), ('weather', 'company', '09:00'))
    def test_phone_cancel_reason_and_no_show_are_recorded_with_codes(self):
        self.funnel = FUNNEL; self.jobs.append(job(id='later', revision='later-rev', customer='Synthetic Later Garage', time='17:00', endTime='18:00', startAt=DAY+'T17:00:00-06:00', endAt=DAY+'T18:00:00-06:00', assignedCrew=['crew.two'], crewId=None, crewLead=None, vehicleId=None))
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); dialog = self.page.get_by_role('dialog')
        expect(self.card('Synthetic Later Garage').get_by_role('button', name='No-show', exact=True)).to_have_count(0)
        self.card('Synthetic Later Garage').get_by_role('button', name='Cancel', exact=True).click(); self.submit('Cancel job'); self.assertEqual(self.calls, [])
        dialog.get_by_role('combobox', name='Reason', exact=True).select_option('customer_changed_plans'); dialog.get_by_role('combobox', name='Who asked for it?', exact=True).select_option('customer')
        dialog.get_by_label('Cancellation note (optional)', exact=True).fill('Synthetic: moving out of state')
        for width in [375, 320]:
            self.page.set_viewport_size({'width': width, 'height': 812}); self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width+1); self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth')+1)
        for control in [dialog.get_by_role('combobox', name='Reason', exact=True), dialog.get_by_role('button', name='Cancel job', exact=True)]: self.assertGreaterEqual(control.bounding_box()['height'], 44)
        self.assertEqual(dialog.get_by_role('combobox', name='Reason', exact=True).evaluate('(el)=>getComputedStyle(el).fontSize'), '16px')
        self.submit('Cancel job'); self.closed()
        self.assertEqual({key: self.calls[-1][key] for key in ['action', 'reasonCode', 'initiatedBy', 'cancellationReason']}, {'action': 'schedule.cancel', 'reasonCode': 'customer_changed_plans', 'initiatedBy': 'customer', 'cancellationReason': 'Synthetic: moving out of state'})
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.card().get_by_role('button', name='No-show', exact=True).click(); expect(dialog).to_contain_text('does not message the customer')
        self.submit('Record no-show'); self.assertEqual(len(self.calls), 1, 'a no-show needs its reason')
        dialog.get_by_role('combobox', name='Reason', exact=True).select_option('customer_not_home'); expect(dialog.get_by_role('combobox', name='Who asked for it?', exact=True)).to_have_count(0)
        self.submit('Record no-show'); self.closed()
        self.assertEqual({key: self.calls[-1][key] for key in ['action', 'jobId', 'expectedRevision', 'reasonCode', 'changes']}, {'action': 'schedule.no_show', 'jobId': 'job-1', 'expectedRevision': 'rev-1', 'reasonCode': 'customer_not_home', 'changes': {}})
        expect(self.page.get_by_role('heading', name=CUSTOMER['name'], exact=True)).to_have_count(0); self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376)
    def test_rework_names_its_original_job_and_an_unlinked_customer_gives_the_crm_reason(self):
        self.funnel = FUNNEL; self.customers = [{**CUSTOMER, 'crmLinked': False}]
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); self.create(); dialog = self.page.get_by_role('dialog')
        crm = dialog.get_by_role('combobox', name='Why is there no CRM contact?', exact=True); original = dialog.locator('input[name=reworkOfJobId]')
        expect(crm).to_be_visible(); expect(original).to_be_hidden()
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone'); dialog.get_by_role('combobox', name='Visit purpose', exact=True).select_option('rework')
        expect(original).to_be_visible(); self.assertEqual(original.evaluate('(el)=>getComputedStyle(el).fontSize'), '16px'); self.assertGreaterEqual(original.bounding_box()['height'], 44)
        self.submit('Create job'); self.assertEqual(self.calls, [], 'a rework needs its original job and the CRM reason')
        original.fill(' job-original '); self.submit('Create job'); self.assertEqual(self.calls, [], 'the CRM reason is one required tap for an unlinked customer')
        crm.select_option('crm_sync_pending')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 376); self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth')+1)
        self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'visitPurpose': 'rework', 'reworkOfJobId': 'job-original', 'crmLinkReason': 'crm_sync_pending'})
        self.page.get_by_role('button', name='Create job', exact=True).first.click(); self.page.locator('input[name=customerSearch]').fill('Johnson')
        self.customers = [{**CUSTOMER, 'crmLinked': True}]; self.page.locator('input[name=customerSearch]').fill('Johnso')
        self.page.get_by_role('button', name=CUSTOMER['name']+' · '+CUSTOMER['phone'], exact=True).click()
        expect(crm).to_be_hidden(); dialog.get_by_role('combobox', name='Visit purpose', exact=True).select_option('rework'); dialog.get_by_role('combobox', name='Work type', exact=True).select_option('walkthrough')
        expect(original).to_be_hidden(); self.assertEqual(original.evaluate('(el)=>el.required'), False)
    def test_no_show_is_offered_for_jobs_only_a_walkthrough_records_its_own(self):
        self.funnel = FUNNEL
        self.jobs = [job(), job(id='walk-1', revision='walk-rev', type='walkthrough', customer='Synthetic Walkthrough Garage', assignedCrew=['crew.two'], crewId=None, crewLead=None, vehicleId=None, time='07:00', endTime='07:30', startAt=DAY+'T07:00:00-06:00', endAt=DAY+'T07:30:00-06:00')]
        self.open(); expect(self.card().get_by_role('button', name='No-show', exact=True)).to_have_count(1)
        walk = self.card('Synthetic Walkthrough Garage'); expect(walk.get_by_role('button', name='Cancel', exact=True)).to_have_count(1); expect(walk.get_by_role('button', name='No-show', exact=True)).to_have_count(0)
    def test_no_show_is_not_offered_without_the_shared_reason_codes(self):
        self.open(); expect(self.card().get_by_role('button', name='No-show', exact=True)).to_have_count(0)
        self.card().get_by_role('button', name='Cancel', exact=True).click(); expect(self.page.get_by_role('dialog').get_by_role('combobox', name='Reason', exact=True)).to_have_count(0); self.submit('Cancel job'); self.closed()
        self.assertNotIn('reasonCode', self.calls[-1])

    def test_service_line_and_path_are_prefilled_and_one_tap_is_required_only_when_nothing_decides(self):
        self.funnel = FUNNEL29; self.open(); self.create(); dialog = self.page.get_by_role('dialog')
        line = dialog.get_by_role('combobox', name='Service line', exact=True); path = dialog.get_by_role('combobox', name='How this project reached us', exact=True)
        expect(dialog).to_contain_text('Required: nothing on file decides this. Choose one.')
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone')
        self.submit('Create job'); self.assertEqual(self.calls, [], 'an undecided line and path are one required tap each')
        dialog.get_by_label('Service', exact=True).fill('Junk removal')
        expect(line).to_have_value('junk_removal'); expect(dialog).to_contain_text('Set from the service name. Change it only if it is wrong.')
        self.assertEqual(self.prefill_queries[-1]['serviceType'], ['Junk removal']); self.assertEqual(self.prefill_queries[-1]['customerId'], [CUSTOMER['id']])
        path.select_option('direct_phone_booking'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'visitPurpose': 'service', 'funnelPath': 'direct_phone_booking'}, 'an untouched pre-fill is left for the server to derive')
        # A walkthrough is on the walkthrough path; "Not sure yet" is a valid one-tap answer for its line.
        self.page.get_by_role('button', name='Create job', exact=True).first.click(); self.page.locator('input[name=customerSearch]').fill('Johnson')
        self.page.get_by_role('button', name=CUSTOMER['name']+' · '+CUSTOMER['phone'], exact=True).click()
        dialog.get_by_role('combobox', name='Work type', exact=True).select_option('walkthrough'); expect(path).to_have_value('walkthrough')
        self.assertEqual(self.prefill_queries[-1]['kind'], ['walkthrough'])
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_in_person'); dialog.get_by_label('Service', exact=True).fill('Walkthrough')
        line.select_option('unknown'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_in_person', 'serviceLine': 'unknown'})
        # A staff change of a pre-filled value is sent as their pick.
        self.page.get_by_role('button', name='Create job', exact=True).first.click(); self.page.locator('input[name=customerSearch]').fill('Johnson')
        self.page.get_by_role('button', name=CUSTOMER['name']+' · '+CUSTOMER['phone'], exact=True).click()
        dialog.get_by_role('combobox', name='Work type', exact=True).select_option('walkthrough'); expect(path).to_have_value('walkthrough')
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone'); dialog.get_by_label('Service', exact=True).fill('Walkthrough')
        path.select_option('rebook'); line.select_option('garage_transformation'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'serviceLine': 'garage_transformation', 'funnelPath': 'rebook'})
    def test_prefill_failure_and_lead_form_suggestion_fit_a_phone(self):
        self.funnel = FUNNEL29; self.prefill = lambda query: {'status': 503, 'ok': False, 'code': 'funnel_dimensions_unavailable', 'error': 'Unavailable'}
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.open(); self.create(); dialog = self.page.get_by_role('dialog')
        line = dialog.get_by_role('combobox', name='Service line', exact=True); path = dialog.get_by_role('combobox', name='How this project reached us', exact=True)
        expect(dialog.get_by_text('The suggestion could not be loaded. Choose one.').first).to_be_visible()
        for width in [375, 320]:
            self.page.set_viewport_size({'width': width, 'height': 812}); self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width+1); self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth')+1)
        for control in [line, path]: self.assertGreaterEqual(control.bounding_box()['height'], 44); self.assertEqual(control.evaluate('(el)=>getComputedStyle(el).fontSize'), '16px')
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone')
        self.submit('Create job'); self.assertEqual(self.calls, [], 'an unverified pre-fill never skips the pick')
        line.select_option('garage_transformation'); path.select_option('remote_photo_video_quote'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'visitPurpose': 'service', 'serviceLine': 'garage_transformation', 'funnelPath': 'remote_photo_video_quote'})
        # The Facebook lead form only suggests: an untouched suggestion is sent marked as one, never as the staff member's pick.
        self.prefill = lambda query: {**prefill(query), 'serviceLine': {'value': None, 'source': None, 'required': True, 'suggestion': 'junk_removal' if 'suggest' not in query else None}, 'ghl': 'skipped' if 'suggest' in query else 'ok'}
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.create()
        expect(line).to_have_value('junk_removal'); expect(dialog).to_contain_text('Suggested by the Facebook lead form. Confirm or change it.')
        # The lead form is read once per customer: later refreshes skip the GHL read and keep the suggestion.
        asked = len(self.prefill_queries); dialog.get_by_label('Service', exact=True).fill('Garage help')
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone'); path.select_option('direct_phone_booking')
        for _ in range(50):
            if len(self.prefill_queries) > asked: break
            self.page.wait_for_timeout(100)
        self.assertGreater(len(self.prefill_queries), asked); self.assertTrue(all(query.get('suggest') == ['false'] for query in self.prefill_queries[asked:]), self.prefill_queries[asked:])
        expect(line).to_have_value('junk_removal'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'visitPurpose': 'service', 'serviceLine': 'junk_removal', 'serviceLineSuggested': True, 'funnelPath': 'direct_phone_booking'})
        # Choosing a value is the staff pick, even the suggested one.
        self.create(); expect(line).to_have_value('junk_removal'); line.select_option('garage_transformation'); line.select_option('junk_removal')
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone'); path.select_option('direct_phone_booking'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'visitPurpose': 'service', 'serviceLine': 'junk_removal', 'funnelPath': 'direct_phone_booking'})
        # A project that holds "Not sure yet" is asked again: the select starts empty and blocks the save until answered.
        self.prefill = lambda query: {**prefill(query), 'serviceLine': {'value': 'unknown', 'source': 'explicit', 'required': True, 'suggestion': None}, 'ghl': 'not_needed'}
        self.create(); expect(dialog).to_contain_text('Earlier marked Not sure yet. Choose the service line, or Not sure yet again.'); expect(line).to_have_value('')
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone'); path.select_option('direct_phone_booking')
        calls = len(self.calls); self.submit('Create job'); self.assertEqual(len(self.calls), calls, 'the earlier "Not sure yet" needs a new tap')
        line.select_option('unknown'); self.submit('Create job'); self.closed()
        self.assertEqual(self.calls[-1]['booking'], {'channel': 'hub_phone', 'visitPurpose': 'service', 'funnelPath': 'direct_phone_booking'}, 'a reconfirmed "Not sure yet" is what the project holds')
        # A response for another customer is never applied.
        self.prefill = lambda query: {**prefill(query), 'customerId': 'someone-else', 'funnelPath': {'value': 'walkthrough', 'source': 'walkthrough', 'required': False}}
        self.create(); expect(dialog.get_by_text('The suggestion could not be loaded. Choose one.').first).to_be_visible(); expect(path).to_have_value('')

    # FIX-DISPATCH-READY: reminder, price and deposit readiness chips (functions/_lib/dispatch-readiness.js) and the Notify customer toggle.
    def readiness_board(self):
        money = lambda **values: {'checked': True, 'hasApprovedPrice': True, 'priceStatus': 'approved', 'depositRequiredCents': 50000, 'depositPaidCents': 50000, 'depositDueCents': 0, 'depositVerified': True, **values}
        self.jobs[0].update({'notify': False, 'reminder': {'state': 'off', 'source': 'calendar_sync'}, 'moneyReady': money(hasApprovedPrice=False, priceStatus='missing', depositRequiredCents=None, depositPaidCents=None, depositDueCents=None, depositVerified=None)})
        later = lambda start, end, **values: job(time=start, endTime=end, startAt=DAY+'T'+start+':00-06:00', endAt=DAY+'T'+end+':00-06:00', **values)
        self.jobs += [later('13:00', '14:00', id='ready-job', customer='Synthetic Ready Garage', reminder={'state': 'set', 'source': 'ghl_outbox'}, moneyReady=money()),
                      later('14:30', '15:30', id='due-job', customer='Synthetic Deposit Garage', reminder={'state': 'not_told', 'source': 'calendar_sync'}, moneyReady=money(depositPaidCents=0, depositDueCents=50000, depositVerified=None)),
                      later('16:00', '17:00', id='unknown-job', customer='Synthetic Unknown Garage', reminder={'state': 'unknown', 'source': 'ghl_outbox'}, moneyReady={'checked': False, 'hasApprovedPrice': None, 'priceStatus': 'unknown', 'depositRequiredCents': None, 'depositPaidCents': None, 'depositDueCents': None, 'depositVerified': None}),
                      later('17:30', '18:00', id='walk-job', type='walkthrough', customer='Synthetic Walkthrough Garage', reminder={'state': 'pending', 'source': 'calendar_sync'}),
                      later('18:30', '19:00', id='plan-job', customer='Synthetic Plan Garage', recurringPlanId='plan-1', reminder={'state': 'not_told', 'source': 'calendar_sync'}, moneyReady=money(hasApprovedPrice=False, priceStatus='plan', depositRequiredCents=0, depositPaidCents=0, depositDueCents=0, depositVerified=None))]
        self.read_warnings = [{'code': 'no_price', 'jobId': 'job-1', 'message': 'No approved price: price it before the job'},
                              {'code': 'deposit_unpaid', 'jobId': 'due-job', 'message': 'Deposit unpaid: $500.00 is still due before this job.', 'depositDueCents': 50000}]
    def test_readiness_badges_and_money_chips_at_phone_and_desktop_widths(self):
        self.readiness_board(); self.open()
        for width in (390, 1440):
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 900}); self.page.get_by_role('button', name='Day', exact=True).click()
                off = self.card().locator('.dp-ready'); expect(off.locator('.dp-reminders-off')).to_have_text('Reminders off')
                price = off.get_by_role('link', name=re.compile('^Price this job for ' + CUSTOMER['name']))
                expect(price).to_have_attribute('href', '/employee.html?view=finance&job=job-1'); expect(price).to_have_text('Price this job')
                expect(self.card()).not_to_contain_text('No approved price: price it before the job')
                ready = self.card('Synthetic Ready Garage').locator('.dp-ready')
                expect(ready.locator('[data-reminder]')).to_have_text('Reminder set · HighLevel tag outbox'); expect(ready).to_contain_text('Price approved'); expect(ready).to_contain_text('Deposit paid'); expect(ready.get_by_role('link')).to_have_count(0)
                due = self.card('Synthetic Deposit Garage').locator('.dp-ready')
                expect(due.locator('[data-reminder]')).to_have_text('Reminder on, HighLevel not told yet · calendar sync')
                deposit = due.get_by_role('link', name=re.compile('^Deposit unpaid · \\$500\\.00 for Synthetic Deposit Garage'))
                expect(deposit).to_have_text('Deposit unpaid · $500.00'); expect(deposit).to_have_class(re.compile('warn')); expect(deposit).to_have_attribute('href', '/employee.html?view=finance&job=due-job')
                expect(self.card('Synthetic Deposit Garage')).not_to_contain_text('is still due before this job')
                # Unknown never reads as confirmed: no "set", no "approved", no "paid".
                unknown = self.card('Synthetic Unknown Garage').locator('.dp-ready')
                expect(unknown).to_contain_text('Reminder not confirmed · HighLevel tag outbox'); expect(unknown).to_contain_text('Price and deposit not checked')
                for claim in ('Reminder set', 'Price approved', 'Deposit paid', 'Price this job'): expect(unknown).not_to_contain_text(claim)
                # A recurring plan's visit at the plan price: priced, nothing to fix.
                plan = self.card('Synthetic Plan Garage').locator('.dp-ready')
                expect(plan).to_contain_text('Plan price'); expect(plan).to_contain_text('No deposit'); expect(plan.get_by_role('link')).to_have_count(0); expect(plan).not_to_contain_text('Price this job')
                walk = self.card('Synthetic Walkthrough Garage').locator('.dp-ready')
                expect(walk).to_contain_text('Reminder waiting on HighLevel'); expect(walk.get_by_role('link')).to_have_count(0); expect(walk).not_to_contain_text('Price')
                heights = self.page.evaluate("[...document.querySelectorAll('.dp-ready-link')].map(a=>a.getBoundingClientRect().height)")
                self.assertTrue(heights and min(heights) >= 44, heights)
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width + 1)
                out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/f'dispatch-readiness-{width}.png'), full_page=True)
        # Money warnings still count toward Needs attention (the first job also ended before now), and inside the Hub a chip opens that job's finance row.
        expect(self.page.locator('.dp-stats article').filter(has_text='Needs attention').locator('strong')).to_have_text('2')
        self.page.evaluate("()=>{window.opsGo=name=>{window.wentTo=name;const row=document.createElement('article');row.dataset.financeJob='due-job';row.append(Object.assign(document.createElement('button'),{textContent:'Record deposit'}));document.body.append(row);};}")
        self.card('Synthetic Deposit Garage').locator('.dp-ready-link').click()
        self.assertEqual(self.page.evaluate('window.wentTo'), 'finance'); expect(self.page.locator('[data-finance-job="due-job"]')).to_have_class(re.compile('dp-finance-focus'))
        self.assertEqual(self.page.evaluate('location.pathname'), '/'); self.assertEqual(self.calls, [], 'readiness never writes')
    def test_reminder_toggle_is_saved_on_create_and_edit_at_phone_and_desktop_widths(self):
        self.open()
        for width in (390, 1440):
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 900})
                self.create(); toggle = self.page.get_by_role('dialog').get_by_label('HighLevel confirmation and reminders', exact=True)
                expect(toggle).to_be_checked(); toggle.uncheck(); self.submit('Create job'); self.closed()
                self.assertIs(self.calls[-1]['changes']['notify'], False, 'a new visit can start with reminders off')
                self.card().get_by_role('button', name='Edit / assign', exact=True).click(); toggle = self.page.get_by_role('dialog').get_by_label('HighLevel confirmation and reminders', exact=True)
                expect(toggle).to_be_checked(); self.submit('Save changes'); self.closed(); self.assertNotIn('notify', self.calls[-1]['changes'], 'an untouched toggle sends nothing')
                self.card().get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
                dialog.get_by_label('HighLevel confirmation and reminders', exact=True).uncheck(); expect(dialog).to_contain_text('HighLevel is told with the next change to this visit\u2019s date or time.')
                box = dialog.get_by_label('HighLevel confirmation and reminders', exact=True).locator('xpath=..').bounding_box(); self.assertGreaterEqual(box['height'], 44)
                self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth') + 1)
                self.submit('Save changes'); self.closed(); self.assertIs(self.calls[-1]['changes']['notify'], False)
                expect(self.card().locator('.dp-reminders-off')).to_have_text('Reminders off')
                self.jobs[0]['notify'] = True; self.page.get_by_role('button', name='Refresh', exact=True).click(); expect(self.card().locator('.dp-reminders-off')).to_have_count(0)
    def test_imported_jobber_job_preselects_reminders_only_with_the_server_flag(self):
        imported = lambda: job(id='jobber_job_7', revision='imp-1', customer='Synthetic Imported Garage', date='', time='', endDate='', endTime='', startAt=None, endAt=None, status='unscheduled', assignedCrew=[], crewLead=None, crewId=None, vehicleId=None,
                               notify=False, reminder={'state': 'off', 'source': 'none', 'jobberImport': True})
        self.page.set_viewport_size({'width': 390, 'height': 900})
        for flag in (True, False):
            with self.subTest(flag=flag):
                self.jobs = [job(), imported()]; self.read_extra = {'notifyImportedOn': True} if flag else {}; self.page.goto(self.url)
                self.page.get_by_label('Filter by status', exact=True).select_option('unscheduled')
                card = self.queued('Synthetic Imported Garage'); expect(card.locator('.dp-reminders-off')).to_have_text('Reminders off')
                card.get_by_role('button', name='Schedule Synthetic Imported Garage', exact=True).click(); dialog = self.page.get_by_role('dialog'); toggle = dialog.get_by_label('HighLevel confirmation and reminders', exact=True)
                expect(dialog.get_by_text('Imported from Jobber: reminders were off', exact=True)).to_be_visible()
                (expect(toggle).to_be_checked if flag else expect(toggle).not_to_be_checked)()
                # Saving it still unscheduled sends no choice; booking it sends the shown one.
                self.submit('Save changes'); self.closed(); self.assertNotIn('notify', self.calls[-1]['changes'])
                self.page.get_by_role('button', name='Refresh', exact=True).click()
                self.queued('Synthetic Imported Garage').get_by_role('button', name='Schedule Synthetic Imported Garage', exact=True).click(); dialog = self.page.get_by_role('dialog')
                dialog.get_by_label('Keep unscheduled', exact=True).uncheck(); dialog.get_by_label('Start date', exact=True).fill('2026-09-24'); dialog.get_by_label('End date', exact=True).fill('2026-09-24')
                dialog.get_by_label('Start time', exact=True).fill('09:00'); dialog.get_by_label('End time', exact=True).fill('11:00'); self.submit('Save changes'); self.closed()
                self.assertIs(self.calls[-1]['changes']['notify'], flag); self.assertEqual(self.calls[-1]['changes']['date'], '2026-09-24')
        # An imported job whose reminder choice was recorded, then unscheduled: the server no longer marks it jobberImport,
        # so the dialog shows the saved choice (off), proposes nothing, and booking it sends no notify change.
        self.calls.clear(); decided = imported(); decided['reminder'] = {'state': 'off', 'source': 'none'}
        self.jobs = [job(), decided]; self.read_extra = {'notifyImportedOn': True}; self.page.goto(self.url)
        self.page.get_by_label('Filter by status', exact=True).select_option('unscheduled')
        self.queued('Synthetic Imported Garage').get_by_role('button', name='Schedule Synthetic Imported Garage', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_label('HighLevel confirmation and reminders', exact=True)).not_to_be_checked(); expect(dialog).not_to_contain_text('Imported from Jobber')
        dialog.get_by_label('Keep unscheduled', exact=True).uncheck(); dialog.get_by_label('Start date', exact=True).fill('2026-09-24'); dialog.get_by_label('End date', exact=True).fill('2026-09-24')
        dialog.get_by_label('Start time', exact=True).fill('09:00'); dialog.get_by_label('End time', exact=True).fill('11:00'); self.submit('Save changes'); self.closed()
        self.assertEqual(self.calls[-1]['changes']['date'], '2026-09-24'); self.assertNotIn('notify', self.calls[-1]['changes'], 'the recorded choice is never re-sent as on')
    def test_reminder_toggle_says_a_reminder_highlevel_has_is_not_taken_back(self):
        later = lambda start, end, **values: job(time=start, endTime=end, startAt=DAY+'T'+start+':00-06:00', endAt=DAY+'T'+end+':00-06:00', **values)
        self.jobs = [job(), later('13:00', '14:00', id='set-job', customer='Synthetic Reminded Garage', reminder={'state': 'set', 'source': 'calendar_sync'}),
                     later('14:30', '15:30', id='told-off-job', customer='Synthetic Told Garage', notify=False, reminder={'state': 'off_told', 'source': 'ghl_outbox'}),
                     later('16:00', '17:00', id='fresh-job', customer='Synthetic Fresh Garage', reminder={'state': 'not_told', 'source': 'calendar_sync'})]
        self.page.set_viewport_size({'width': 390, 'height': 900}); self.open(); self.page.get_by_role('button', name='Day', exact=True).click()
        kept = 'HighLevel may still send the reminder it already has for this visit. To stop it, remove it in HighLevel.'
        self.card('Synthetic Reminded Garage').get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog).to_contain_text('it does not take back one HighLevel already has'); expect(dialog).not_to_contain_text('hears nothing about this visit')
        dialog.get_by_label('HighLevel confirmation and reminders', exact=True).uncheck(); expect(dialog).to_contain_text(kept)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 391)
        self.submit('Save changes'); self.closed(); self.assertIs(self.calls[-1]['changes']['notify'], False)
        self.card('Synthetic Told Garage').get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_label('HighLevel confirmation and reminders', exact=True)).not_to_be_checked(); expect(dialog).to_contain_text(kept)
        dialog.get_by_label('HighLevel confirmation and reminders', exact=True).check(); expect(dialog).to_contain_text('HighLevel is told with the next change to this visit\u2019s date or time.')
        dialog.get_by_role('button', name='Close dialog', exact=True).click(); self.closed()
        self.card('Synthetic Fresh Garage').get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog).to_contain_text('Turn off so this customer hears nothing about this visit.'); dialog.get_by_label('HighLevel confirmation and reminders', exact=True).uncheck()
        expect(dialog).to_contain_text('HighLevel is told with the next change to this visit\u2019s date or time.'); expect(dialog).not_to_contain_text(kept)

    def test_reminders_off_that_highlevel_may_still_have_are_never_a_plain_off_at_390(self):
        # Second review: notify off with an unknown reminder (an unreadable outbox chain, or a page sync the tag outbox owned)
        # says HighLevel may still remind, and the Edit dialog says turning it off takes nothing back. A deposit with an
        # unreconciled refund or conflicting receipts (depositVerified false) reads "Deposit not verified".
        later = lambda start, end, **values: job(time=start, endTime=end, startAt=DAY+'T'+start+':00-06:00', endAt=DAY+'T'+end+':00-06:00', **values)
        refunded = {'checked': True, 'hasApprovedPrice': True, 'priceStatus': 'approved', 'depositRequiredCents': 50000, 'depositPaidCents': 50000, 'depositDueCents': 0, 'depositVerified': False}
        self.jobs = [job(notify=False, reminder={'state': 'off', 'source': 'calendar_sync'}),
                     later('13:00', '14:00', id='maybe-job', customer='Synthetic Maybe Garage', notify=False, reminder={'state': 'unknown', 'source': 'calendar_sync'}, moneyReady=refunded),
                     later('14:30', '15:30', id='unknown-on-job', customer='Synthetic Unconfirmed Garage', reminder={'state': 'unknown', 'source': 'ghl_outbox'})]
        self.page.set_viewport_size({'width': 390, 'height': 900}); self.open(); self.page.get_by_role('button', name='Day', exact=True).click()
        expect(self.card().locator('.dp-reminders-off')).to_have_text('Reminders off')
        maybe = self.card('Synthetic Maybe Garage').locator('.dp-ready')
        expect(maybe.locator('.dp-reminders-off')).to_have_text('Reminders off · HighLevel may still remind (not confirmed)')
        expect(maybe.locator('.dp-reminders-off')).to_have_attribute('data-reminder', 'unknown')
        expect(maybe).to_contain_text('Deposit not verified'); expect(maybe).not_to_contain_text('Deposit paid')
        expect(self.card('Synthetic Unconfirmed Garage').locator('[data-reminder]')).to_have_text('Reminder not confirmed · HighLevel tag outbox')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 391)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'dispatch-reminders-maybe-390.png'), full_page=True)
        kept = 'HighLevel may still send the reminder it already has for this visit. To stop it, remove it in HighLevel.'
        self.card('Synthetic Maybe Garage').get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_label('HighLevel confirmation and reminders', exact=True)).not_to_be_checked()
        expect(dialog).to_contain_text('it does not take back one HighLevel already has'); expect(dialog).to_contain_text(kept); expect(dialog).not_to_contain_text('hears nothing about this visit')
        self.assertLessEqual(dialog.evaluate('(el)=>el.scrollWidth'), dialog.evaluate('(el)=>el.clientWidth') + 1)
        dialog.get_by_role('button', name='Close dialog', exact=True).click(); self.closed()
        self.card('Synthetic Unconfirmed Garage').get_by_role('button', name='Edit / assign', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog).to_contain_text('it does not take back one HighLevel already has')
        dialog.get_by_label('HighLevel confirmation and reminders', exact=True).uncheck(); expect(dialog).to_contain_text(kept)
        dialog.get_by_role('button', name='Close dialog', exact=True).click(); self.closed()
        self.assertEqual(self.calls, [], 'reading and closing writes nothing')

    # WT-OUTCOME: the server's walkthrough outcome fields (walkthrough-state.js) as GET /api/dispatch projects them.
    def outcome_rows(self):
        def walk(id, customer, time, state, badge, closed, **extra):
            end = '%02d:00' % (int(time[:2]) + 1)
            return job(id=id, revision=id+'-rev', type='walkthrough', customer=customer, serviceType=extra.pop('serviceType', 'Free walkthrough'), time=time, endTime=end, startAt=DAY+'T'+time+':00-06:00', endAt=DAY+'T'+end+':00-06:00',
                       assignedCrew=['crew.one'], crewLead=None, crewId=None, vehicleId=None, crewNeeded=1, requiredEquipment=[], materials=[], jobInstructions='',
                       walkthroughState=state, walkthroughBadge=badge, walkthroughClosed=closed, rebookPending=False, convertedJobId=extra.pop('convertedJobId', None), **extra)
        return [
            # Booked outside Dispatch with no service name: the rebook still saves.
            walk('walk-noshow', 'Synthetic No-show Garage', '07:00', 'no_show', 'No-show \u00b7 rebook', False, serviceType='', walkthroughOutcome={'outcome': 'customer_no_show', 'reasonCode': 'customer_not_home', 'finishedAt': DAY+'T13:40:00Z'},
                 rebook={'reasonCode': 'customer_request', 'initiatedBy': 'customer', 'label': 'Customer not home', 'missedOn': DAY}),
            walk('walk-lost', 'Synthetic Lost Garage', '09:00', 'lost', 'Lost: Price', True, walkthroughOutcome={'outcome': 'not_interested', 'reasonCode': 'price', 'finishedAt': DAY+'T15:40:00Z'}),
            walk('walk-quote', 'Synthetic Quote Garage', '10:00', 'quote', 'Quote to follow', True, walkthroughOutcome={'outcome': 'quote_to_follow', 'reasonCode': None, 'finishedAt': DAY+'T16:40:00Z'}),
            walk('walk-sold', 'Synthetic Sold Garage', '11:00', 'sold', 'Sold \u2192 open job', True, convertedJobId='job-sold', walkthroughOutcome={'outcome': 'sold_on_site', 'reasonCode': None, 'finishedAt': DAY+'T17:40:00Z'}),
            job(id='job-missed', revision='missed-rev', customer='Synthetic Missed Job', time='06:00', endTime='07:00', startAt=DAY+'T06:00:00-06:00', endAt=DAY+'T07:00:00-06:00', status='no_show', noShowReasonCode='no_access',
                assignedCrew=[], crewLead=None, crewId=None, vehicleId=None, rebook={'reasonCode': None, 'initiatedBy': None, 'label': 'No access', 'missedOn': DAY}),
        ]
    def no_overflow(self, *widths):
        for width in widths:
            self.page.set_viewport_size({'width': width, 'height': 844})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, width)
    def test_walkthrough_outcome_badges_and_a_prefilled_rebook_on_a_phone(self):
        self.funnel = FUNNEL; self.jobs = [job()] + self.outcome_rows()
        self.page.set_viewport_size({'width': 390, 'height': 844}); self.open()
        noshow = self.card('Synthetic No-show Garage')
        expect(noshow.locator('.dp-outcome')).to_have_text('No-show \u00b7 rebook')
        expect(noshow).not_to_contain_text('Scheduled finish has passed')
        for name in ['Synthetic Lost Garage', 'Synthetic Quote Garage', 'Synthetic Sold Garage']: expect(self.card(name)).to_have_count(0)
        self.page.get_by_role('combobox', name='Filter by status', exact=True).select_option('all')
        expect(self.card('Synthetic Lost Garage').locator('.dp-outcome')).to_have_text('Lost: Price')
        expect(self.card('Synthetic Quote Garage').locator('.dp-outcome')).to_have_text('Quote to follow')
        sold = self.card('Synthetic Sold Garage').get_by_role('link', name='Sold \u2192 open job', exact=True)
        expect(sold).to_have_attribute('href', '/crew/job.html?jobId=job-sold')
        for name in ['Synthetic Lost Garage', 'Synthetic Quote Garage', 'Synthetic Sold Garage']:
            closed = self.card(name); expect(closed).to_have_class(re.compile('dp-terminal'))
            expect(closed.get_by_role('button', name='Edit / assign', exact=True)).to_have_count(0); expect(closed.get_by_role('button', name=re.compile('^Rebook'))).to_have_count(0)
        self.assertNotIn('Start walkthrough', self.page.locator('[data-dp-body]').inner_text())
        rebook = noshow.get_by_role('button', name='Rebook the walkthrough for Synthetic No-show Garage', exact=True)
        for target in [rebook, sold]: self.assertGreaterEqual(target.bounding_box()['height'], 44)
        self.no_overflow(390, 320); self.page.set_viewport_size({'width': 390, 'height': 844})
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'dispatch-walkthrough-outcomes-390.png'), full_page=True)
        rebook.click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_role('heading', name='Rebook walkthrough', exact=True)).to_be_visible()
        expect(dialog.locator('[data-rebook]')).to_contain_text('No-show on Tue, Sep 22 (Customer not home)')
        dialog.get_by_label('Start date', exact=True).fill('2026-09-24')
        expect(dialog.get_by_role('combobox', name='Reason', exact=True)).to_have_value('customer_request')
        expect(dialog.get_by_role('combobox', name='Who asked for it?', exact=True)).to_have_value('customer')
        self.no_overflow(390, 320); self.page.set_viewport_size({'width': 390, 'height': 844})
        self.submit('Save new time'); self.closed()
        write = self.calls[-1]
        self.assertEqual([write['action'], write['jobId'], write['expectedRevision'], write['reasonCode'], write['initiatedBy'], write['changes']['date']], ['schedule.update', 'walk-noshow', 'walk-noshow-rev', 'customer_request', 'customer', '2026-09-24'])
        self.assertNotIn('sourceJobId', write); self.assertEqual(len([call for call in self.calls if call['action'] == 'schedule.create']), 0, 'the same visit moves; no second walkthrough')
        expect(self.page.get_by_role('status').filter(has_text='Walkthrough moved to its new time.')).to_be_visible()
    def test_service_job_no_show_rebooks_as_a_new_visit_from_that_job(self):
        self.funnel = FUNNEL; self.jobs = [job()] + self.outcome_rows()
        self.page.set_viewport_size({'width': 390, 'height': 844}); self.open()
        self.page.get_by_role('combobox', name='Filter by status', exact=True).select_option('no_show')
        missed = self.card('Synthetic Missed Job')
        expect(self.card('Synthetic No-show Garage')).to_have_count(1)
        for name in ['Synthetic Lost Garage', 'Synthetic Quote Garage', 'Synthetic Sold Garage']: expect(self.card(name)).to_have_count(0)
        expect(missed.get_by_role('button', name='Restore', exact=True)).to_have_count(0)
        missed.get_by_role('button', name='Rebook Synthetic Missed Job', exact=True).click(); dialog = self.page.get_by_role('dialog')
        expect(dialog.get_by_role('heading', name='Rebook job', exact=True)).to_be_visible()
        expect(dialog.locator('[data-rebook]')).to_contain_text('Books the no-show on Tue, Sep 22 (No access) again as a new visit for Synthetic Missed Job')
        customer = dialog.locator('input[name=customerSearch]'); expect(customer).to_have_value('Synthetic Missed Job'); expect(customer).to_have_attribute('readonly', '')
        expect(dialog.get_by_role('combobox', name='Work type', exact=True)).to_be_disabled()
        expect(dialog.get_by_label('Service', exact=True)).to_have_value('Garage cleanout')
        expect(dialog.get_by_label('Internal dispatch notes', exact=True)).to_have_value(re.compile('No access'))
        dialog.get_by_role('combobox', name='How was this booked?', exact=True).select_option('hub_phone')
        dialog.get_by_label('Start date', exact=True).fill('2026-09-25'); dialog.get_by_label('Start time', exact=True).fill('09:00'); dialog.get_by_label('End time', exact=True).fill('11:00')
        self.no_overflow(390, 320); self.page.set_viewport_size({'width': 390, 'height': 844})
        self.submit('Book again'); self.closed()
        write = self.calls[-1]
        self.assertEqual([write['action'], write['kind'], write['customerId'], write['sourceJobId'], write['booking']['channel'], write['changes']['date'], write['changes']['serviceType']], ['schedule.create', 'job', CUSTOMER['id'], 'job-missed', 'hub_phone', '2026-09-25', 'Garage cleanout'])
        self.assertIn('No access', write['changes']['opsNotes']); self.assertEqual(write['changes']['assignedCrew'], [])

if __name__ == '__main__': unittest.main(verbosity=2)
