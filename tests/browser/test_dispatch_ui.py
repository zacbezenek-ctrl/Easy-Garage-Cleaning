"""Native dispatch browser workflows against isolated contract fixtures; no provider/customer writes."""
import copy, json, os, pathlib, threading, unittest
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
        self.crews = [{'id': 'crew-main', 'revision': 'crew-rev-1', 'name': 'North Crew', 'memberIds': ['crew.one', 'lead.one'], 'leadId': 'lead.one', 'status': 'active'}]
        self.vehicles = [{'id': 'truck-1', 'revision': 'truck-rev-1', 'name': 'Box Truck', 'status': 'available', 'notes': 'Check straps'}, {'id': 'truck-2', 'revision': 'truck-rev-2', 'name': 'Spare Truck', 'status': 'out_of_service', 'notes': 'Repair pending'}]
        self.availability = []; self.fail_once = None; self.read_status = 200; self.completed = {}; self.lost_once = False; self.malformed_once = False; self.viewer = 'manager.one'; self.bad_read = False
        self.opening_queries = []; self.opening_failure = None; self.opening_candidates = [{'date': DAY, 'time': '13:00', 'endDate': DAY, 'endTime': '15:00', 'startAt': DAY+'T19:00:00Z', 'endAt': DAY+'T21:00:00Z', 'gapMinutes': 240}]
        self.search_queries = []; self.search_results = []; self.search_failure = None; self.hang_once = False; self.hung_route = None
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
        if parsed.path == '/api/dispatch-openings':
            self.opening_queries.append(parse_qs(parsed.query))
            if self.opening_failure: route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'error': self.opening_failure})); return
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'coverage': {'complete': True, 'consistent': True}, 'candidates': self.opening_candidates, 'warnings': [{'code': 'working_availability_unconfirmed', 'message': 'Confirm these employees are working before booking.'}], 'total': len(self.opening_candidates), 'truncated': False})); return
        if parsed.path != '/api/dispatch': route.continue_(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if req.method == 'GET':
            params = parse_qs(parsed.query); self.gets.append(params)
            if self.read_status != 200: send({'ok': False, 'code': 'dispatch_forbidden', 'error': 'Sign in required'}, self.read_status); return
            if params.get('view') == ['customers']: send({'ok': True, 'customers': [CUSTOMER], 'total': 1}); return
            first = params.get('startDate', [DAY])[0]; last = params.get('endDate', ['2026-09-29'])[0]
            rows = [row for row in self.jobs if not row.get('date') or (row['date'] < last and (row.get('endDate') or row['date']) >= first)]
            if self.bad_read: send({'ok': True}); return
            send({'ok': True, 'viewer': {'id': self.viewer}, 'timeZone': 'America/Denver', 'jobs': rows, 'roster': ROSTER, 'crews': self.crews, 'vehicles': self.vehicles, 'availability': self.availability,
                  'warnings': [], 'coverage': {'complete': True, 'asOf': '2026-09-22T14:00:00Z'}, 'startDate': first, 'endDate': last}); return
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
    def card(self, name=CUSTOMER['name']): return self.page.locator('.dp-job').filter(has=self.page.get_by_role('heading', name=name, exact=True)).first
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
        self.page.get_by_role('button', name='Crew', exact=True).click(); expect(self.page.locator('.dp-crew-group')).to_contain_text('1 jobs · 2.0 reserved hours')
        self.assertEqual(self.gets[-1]['startDate'], [DAY]); self.assertEqual(self.gets[-1]['endDate'], ['2026-09-29'])
    def test_create_assign_lead_truck_duration_scope_and_reload(self):
        self.open(); self.create(); self.page.get_by_role('combobox', name='Saved crew', exact=True).select_option('crew-main'); self.page.get_by_role('combobox', name='Vehicle / truck', exact=True).select_option('truck-1')
        self.page.get_by_role('combobox', name='Expected duration', exact=True).select_option('180'); self.page.get_by_label('Scope of work', exact=True).fill('Keep the marked boxes; remove debris.'); self.submit('Create job'); self.closed()
        write = self.calls[-1]; self.assertEqual(write['customerId'], CUSTOMER['id']); self.assertEqual(write['changes']['assignedCrew'], ['crew.one', 'lead.one']); self.assertEqual(write['changes']['crewLead'], 'lead.one')
        self.assertEqual(write['changes']['endTime'], '16:00'); self.assertEqual(write['changes']['vehicleId'], 'truck-1'); self.assertEqual(write['changes']['jobInstructions'], 'Keep the marked boxes; remove debris.')
        self.page.reload(); expect(self.page.locator('.dp-job').filter(has_text='New synthetic service')).to_have_count(1)
    def test_unscheduled_create_and_filter(self):
        self.open(); self.create(); self.page.get_by_label('Keep unscheduled', exact=True).check(); expect(self.page.get_by_label('Start date', exact=True)).to_be_disabled(); self.submit('Create job'); self.closed()
        for key in ['date', 'time', 'endDate', 'endTime']: self.assertEqual(self.calls[-1]['changes'][key], '')
        self.page.get_by_label('Filter by status', exact=True).select_option('unscheduled'); expect(self.page.locator('.dp-job')).to_have_count(1); expect(self.page.locator('.dp-unscheduled')).to_contain_text('New synthetic service')
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
        self.page.clock.install(); self.open(); self.create(); self.hang_once = True; self.submit('Create job'); expect(self.page.get_by_role('status').filter(has_text='Saving and verifying')).to_be_visible(); self.page.clock.fast_forward(31000)
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

if __name__ == '__main__': unittest.main(verbosity=2)
