"""Owner dispatch rules screen and the dispatch Rules view, skill pickers and 'any qualified' openings against routed
fake /api/dispatch-settings, /api/dispatch and /api/dispatch-openings; no production service is reached."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect
from hub_shell_harness import HubShell, MANAGER, CREW

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
DAY = '2026-09-22'
DEFAULTS = {'defaultTravelBufferMinutes': 20, 'defaultArrivalWindowMinutes': None, 'workdayStart': '08:00', 'workdayEnd': '17:00', 'blockCrewShort': False, 'blockSkillMissing': False,
            'blockTravelShort': False, 'blockOverCapacity': False, 'blockOutsideHours': False, 'maxJobsPerEmployeePerDay': None, 'maxHoursPerEmployeePerDay': None}
SKILLS = [{'id': 'shelving', 'label': 'Shelving install'}, {'id': 'truck_driving', 'label': 'Truck driving'}, {'id': 'heavy_lifting', 'label': 'Heavy lifting'}]
ROSTER = [{'id': 'crew.one', 'name': 'Crew One', 'role': 'crew'}, {'id': 'crew.two', 'name': 'Crew Two', 'role': 'crew'}]
PAGES = {
    '/settings': b'<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-dispatch-settings.css"></head><body style="margin:0;padding:12px;background:#f1f0ec"><main id="host"></main>'
                 b'<script>sessionStorage.setItem("egc_u","zacb")</script><script src="/employee-ui-kit.js"></script><script src="/employee-dispatch-settings.js"></script><script>EGCDispatchSettings.mount(document.querySelector("#host"),{identity:"zacb"})</script>',
    '/dispatch': b'<link rel="stylesheet" href="/employee-dispatch.css"><link rel="stylesheet" href="/employee-dispatch-rules.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main>'
                 b'<script src="/employee-dispatch.js"></script><script src="/employee-dispatch-rules.js"></script><script>EGCDispatch.mount(document.querySelector("#host"))</script>',
}

def job(**changes):
    row = {'id': 'job-1', 'revision': 'rev-1', 'type': 'job', 'customerId': 'customer-1', 'customer': 'Synthetic Johnson Garage', 'address': '123 Synthetic Way, Fort Collins, CO', 'date': DAY, 'time': '08:00', 'endDate': DAY,
           'endTime': '10:00', 'startAt': DAY + 'T08:00:00-06:00', 'endAt': DAY + 'T10:00:00-06:00', 'status': 'scheduled', 'assignedCrew': ['crew.one'], 'crewLead': None, 'crewId': None, 'vehicleId': None, 'crewNeeded': 1,
           'travelBufferMinutes': 20, 'serviceType': 'Garage cleanout', 'jobInstructions': 'Synthetic scope', 'requiredEquipment': [], 'materials': [], 'requiredSkills': ['shelving'], 'syncStatus': 'not_needed'}
    row.update(changes)
    return row

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        page = PAGES.get(urlparse(self.path).path)
        if page is None: return super().do_GET()
        body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated dispatch rules test</title>' + page + b'</body></html>'
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)

class DispatchRulesBrowserTests(unittest.TestCase):
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
        self.errors = []; self.posts = []; self.gets = 0; self.context = None
        self.settings = {'revision': None, 'source': 'defaults', 'values': dict(DEFAULTS), 'invalidFields': [], 'updatedAt': None, 'updatedBy': None}
        self.lose_post = False; self.conflict_post = False; self.busy_post = False; self.busy_posts = []; self.fail_get = False; self.hold_get = False; self.held = None; self.revision = 0
        self.openings = []; self.opening_queries = []; self.roster = ROSTER; self.jobs = [job()]
        self.warnings = [{'code': 'skill_missing', 'jobId': 'job-1', 'message': 'No assigned employee is qualified for Shelving install.', 'missingSkills': ['shelving'], 'blocking': True},
                         {'code': 'employee_daily_capacity', 'jobId': 'job-1', 'employeeId': 'crew.one', 'date': DAY, 'message': 'Crew One would have 4 jobs (9 hours) on 2026-09-22; the daily limit is 3 jobs.'},
                         {'code': 'missing_scope', 'jobId': 'job-1', 'message': 'Not a rule warning.'}]
    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')

    def open(self, path, width=375, height=812):
        mobile = width < 700
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=mobile, has_touch=mobile)
        page = self.page = self.context.new_page(); page.set_default_timeout(8000)
        page.clock.install(time=DAY + 'T18:00:00Z')
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', self.route)
        page.goto(self.url + path)
        return page

    def body(self, extra={}):
        return {'ok': True, 'authority': 'employee_hub', 'settings': copy.deepcopy(self.settings), 'defaults': DEFAULTS, 'skills': SKILLS, 'viewer': {'id': 'zacb'},
                'environment': {'arrival': {'enabled': False, 'minutes': 60}, 'envArrivalMinutes': 60, 'travelEstimates': 'off', 'envBlockTravelShort': False, 'staffDirectory': True}, **extra}

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/dispatch-settings':
            if request.method == 'GET':
                self.gets += 1
                if self.fail_get: self.fail_get = False; send({'ok': False, 'code': 'dispatch_settings_unavailable', 'error': 'Dispatch settings could not be verified. Retry.'}, 503); return
                if self.hold_get: self.hold_get = False; self.held = route; return
                send(self.body()); return
            data = request.post_data_json
            if self.busy_post:
                self.busy_post = False; self.busy_posts.append(copy.deepcopy(data))
                send({'ok': False, 'code': 'dispatch_settings_busy', 'error': 'The schedule was being saved at the same moment, so the dispatch settings were not saved. Your changes are kept; retry the same save.'}, 503); return
            self.posts.append(copy.deepcopy(data))
            if self.conflict_post:
                self.conflict_post = False
                send({'ok': False, 'code': 'dispatch_settings_revision_conflict', 'error': 'The dispatch settings changed since you opened them. Reload and review the latest settings.', 'details': {'currentRevision': 'r-other'}}, 409); return
            if len([post for post in self.posts if post['requestId'] == data['requestId']]) == 1:
                self.revision += 1; self.settings['values'].update(data['changes']); self.settings.update({'revision': f'r{self.revision}', 'source': 'firestore', 'updatedAt': DAY + 'T18:00:00.000Z', 'updatedBy': 'zacb'})
            if self.lose_post: self.lose_post = False; route.abort(); return
            send(self.body({'requestId': data['requestId'], 'replayed': False})); return
        if parsed.path == '/api/dispatch':
            if request.method == 'GET':
                query = parse_qs(parsed.query)
                send({'ok': True, 'viewer': {'id': 'zacb'}, 'timeZone': 'America/Denver', 'jobs': copy.deepcopy(self.jobs), 'roster': self.roster, 'crews': [], 'vehicles': [], 'availability': [], 'warnings': self.warnings,
                      'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'startDate': query['startDate'][0], 'endDate': query['endDate'][0], 'arrivalDefaults': {'enabled': False, 'minutes': 60},
                      'dispatchRules': {'skills': SKILLS, 'workdayStart': '07:00', 'workdayEnd': '24:00', 'defaultTravelBufferMinutes': 35, 'maxJobsPerEmployeePerDay': 3, 'maxHoursPerEmployeePerDay': None,
                                        'blocking': {'crewShort': False, 'skillMissing': True, 'travelShort': False, 'overCapacity': False, 'outsideHours': False}}}); return
            data = request.post_data_json; self.posts.append(copy.deepcopy(data))
            saved = job(id=data.get('jobId', 'job-1'), revision='rev-2', **{key: value for key, value in data.get('changes', {}).items() if key in ('requiredSkills', 'assignedCrew')})
            send({'ok': True, 'requestId': data['requestId'], 'job': saved, 'warnings': [], 'providerSync': 'not_needed'}); return
        if parsed.path == '/api/dispatch-openings':
            self.opening_queries.append(parse_qs(parsed.query, keep_blank_values=True))
            send({'ok': True, 'coverage': {'complete': True, 'consistent': True}, 'candidates': self.openings, 'warnings': [], 'total': len(self.openings), 'truncated': False}); return
        route.continue_()

    def fits_phone(self, page, width):
        page.set_viewport_size({'width': width, 'height': 812})
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width, f'no sideways scroll at {width}px')
        small = page.evaluate('''()=>[...document.querySelectorAll('button,input[type=checkbox],select,a[href]')].map(el=>el.matches('input')?el.closest('label')||el:el)
          .filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.height<43.5}).map(el=>el.tagName+' '+el.textContent.trim().slice(0,30))''')
        self.assertEqual(small, [], f'44px targets at {width}px')
        fonts = page.evaluate('''()=>[...document.querySelectorAll('input:not([type=checkbox]),select,textarea')].filter(el=>el.getBoundingClientRect().width>0&&parseFloat(getComputedStyle(el).fontSize)<16).map(el=>el.name)''')
        self.assertEqual(fonts, [], f'16px inputs at {width}px')

    def test_owner_saves_rules_on_a_phone_and_retries_a_lost_save_with_the_same_request(self):
        page = self.open('/settings')
        expect(page.get_by_role('heading', name='Dispatch rules')).to_be_visible()
        save = page.get_by_role('button', name='Save dispatch rules')
        expect(save).to_be_disabled()
        expect(page.get_by_text('Using the standard rules: nothing has been saved yet.')).to_be_visible()
        for width in (320, 375, 390): self.fits_phone(page, width)
        self.assertEqual(page.get_by_label('Jobs per employee per day').get_attribute('inputmode'), 'numeric')
        self.assertEqual(page.get_by_label('Scheduled hours per employee per day').get_attribute('inputmode'), 'decimal')
        page.get_by_label('Block saves: Required skills').check()
        page.get_by_label('Jobs per employee per day').fill('3')
        page.get_by_label('Scheduled hours per employee per day').fill('9.5')
        page.get_by_label('Ends at midnight').check()
        expect(page.get_by_label('Workday ends')).to_be_disabled()
        expect(save).to_be_enabled()
        self.assertEqual(page.evaluate('EGCDispatchSettings.canLeave()'), False, 'unsaved edits block navigation')
        self.lose_post = True
        save.click()
        retry = page.get_by_role('button', name='Retry original save')
        expect(retry.first).to_be_visible()
        expect(page.get_by_label('Jobs per employee per day')).to_be_disabled()
        kept = page.evaluate('JSON.parse(sessionStorage.getItem("egc.hub.pending.v1.dispatch_rules.zacb"))')
        self.assertEqual(kept['body']['requestId'], self.posts[0]['requestId'])
        retry.first.click()
        expect(page.get_by_text('Dispatch rules saved.')).to_be_visible()
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.posts[0], self.posts[1], 'the retry resends the identical request')
        self.assertEqual(self.posts[0]['action'], 'settings.update'); self.assertIsNone(self.posts[0]['expectedRevision'])
        self.assertEqual(self.posts[0]['changes'], {'blockSkillMissing': True, 'maxJobsPerEmployeePerDay': 3, 'maxHoursPerEmployeePerDay': 9.5, 'workdayEnd': '24:00'})
        self.assertIsNone(page.evaluate('sessionStorage.getItem("egc.hub.pending.v1.dispatch_rules.zacb")'))
        expect(page.get_by_label('Block saves: Required skills')).to_be_checked()
        expect(save).to_be_disabled()
        page.screenshot(path=str(RESULTS / 'dispatch-rules-settings-375.png'), full_page=True)
        # A newer save elsewhere: the draft stays and the owner chooses to load the latest rules.
        page.get_by_label('Workday starts').fill('07:30')
        self.conflict_post = True
        save.click()
        expect(page.get_by_role('button', name='Discard draft and load latest')).to_be_visible()
        self.assertEqual(self.posts[-1]['expectedRevision'], 'r1')
        expect(page.get_by_label('Workday starts')).to_have_value('07:30')
        self.assertIsNone(page.evaluate('sessionStorage.getItem("egc.hub.pending.v1.dispatch_rules.zacb")'), 'a conflict is final; the request is not kept')
        # Nothing is editable until the latest rules arrive, so nothing typed meanwhile is replaced; the form is drawn once from them.
        self.hold_get = True
        with page.expect_request(lambda request: request.method == 'GET' and urlparse(request.url).path == '/api/dispatch-settings'):
            page.get_by_role('button', name='Discard draft and load latest').click()
        expect(page.get_by_role('status').filter(has_text='Loading dispatch rules')).to_have_count(1)
        expect(page.get_by_label('Jobs per employee per day')).to_have_count(0)
        self.assertEqual(self.gets, 2)
        self.held.fulfill(status=200, content_type='application/json', body=json.dumps(self.body())); self.held = None
        expect(page.get_by_label('Workday starts')).to_have_value('08:00')
        # Client checks run before any request.
        page.get_by_label('Jobs per employee per day').fill('25')
        save.click()
        expect(page.get_by_text('Jobs per employee per day must be a whole number from 1 to 20.')).to_be_visible()
        self.assertEqual(len(self.posts), 3)

    def test_a_save_that_loses_to_a_schedule_save_keeps_the_draft_for_the_same_retry(self):
        page = self.open('/settings')
        expect(page.get_by_text('Hub dispatch saves and crew shift pickups')).to_be_visible()
        expect(page.get_by_text('signed walkthrough handoffs and recurring visits are checked too, and a refused save names the rule', exact=False)).to_be_visible()
        expect(page.get_by_text('neither does a signed walkthrough saved with no crew or by a sales account (Dispatch staffs it)', exact=False)).to_be_visible()
        expect(page.get_by_text('operations platform or MCP tools are not checked yet', exact=False)).to_be_visible()
        page.get_by_label('Block saves: Working hours').check()
        self.busy_post = True
        page.get_by_role('button', name='Save dispatch rules').click()
        expect(page.get_by_text('The schedule was being saved at the same moment', exact=False)).to_be_visible()
        expect(page.get_by_role('button', name='Discard draft and load latest')).to_have_count(0)
        self.assertEqual(page.evaluate('JSON.parse(sessionStorage.getItem("egc.hub.pending.v1.dispatch_rules.zacb"))')['requestId'], self.busy_posts[0]['requestId'])
        page.get_by_role('button', name='Retry original save').first.click()
        expect(page.get_by_text('Dispatch rules saved.')).to_be_visible()
        self.assertEqual(self.posts, self.busy_posts, 'the retry resends the identical request')
        self.assertEqual(self.posts[0]['changes'], {'blockOutsideHours': True})
        expect(page.get_by_label('Block saves: Working hours')).to_be_checked()

    def test_a_failed_load_is_unavailable_with_retry_never_the_default_rules(self):
        self.fail_get = True
        page = self.open('/settings', width=390)
        expect(page.get_by_role('alert')).to_contain_text('Nothing is shown until the rules can be verified.')
        expect(page.get_by_role('button', name='Save dispatch rules')).to_have_count(0)
        page.get_by_role('button', name='Retry').click()
        expect(page.get_by_role('button', name='Save dispatch rules')).to_be_visible()
        self.assertEqual(self.gets, 2)

    def test_rules_view_skill_picker_and_any_qualified_openings(self):
        page = self.open('/dispatch', width=390)
        expect(page.get_by_role('button', name='Rules', exact=True)).to_be_visible()
        page.get_by_role('button', name='Rules', exact=True).click()
        expect(page.get_by_text('Saves are blocked for: skills.')).to_be_visible()
        expect(page.get_by_text('Daily limit per employee: 3 jobs.')).to_be_visible()
        expect(page.get_by_role('region', name='Skills')).to_contain_text('Blocks changes')
        expect(page.get_by_role('region', name='Daily limit')).to_contain_text('Crew One')
        expect(page.get_by_text('Not a rule warning.')).to_have_count(0)
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 390)
        page.get_by_role('region', name='Skills').get_by_role('button', name='Edit Synthetic Johnson Garage').click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('checkbox', name='Shelving install')).to_be_checked()
        dialog.get_by_role('checkbox', name='Truck driving').check()
        dialog.get_by_role('button', name='Save changes').click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(self.posts[-1]['changes']['requiredSkills'], ['shelving', 'truck_driving'])
        # Openings: no employees, one skill, and the owner defaults in the form.
        self.openings = [{'date': '2026-09-23', 'time': '09:00', 'endDate': '2026-09-23', 'endTime': '10:00', 'startAt': '2026-09-23T15:00:00.000Z', 'endAt': '2026-09-23T16:00:00.000Z', 'gapMinutes': 480, 'employeeIds': ['crew.two']}]
        page.get_by_role('button', name='Find opening').click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_label('Travel buffer (minutes)')).to_have_value('35')
        expect(dialog.get_by_label('Workday starts')).to_have_value('07:00')
        dialog.get_by_role('button', name='Check openings').click()
        expect(dialog.get_by_text('Choose the employees who need an opening together, or the required skills')).to_be_visible()
        dialog.get_by_role('checkbox', name='Shelving install').check()
        dialog.get_by_role('button', name='Check openings').click()
        expect(dialog.locator('.dp-openings-results small')).to_have_text('Crew Two')
        query = self.opening_queries[-1]
        self.assertEqual(query['requiredSkills'], ['shelving']); self.assertEqual(query['employeeIds'], [''])
        # The owner's midnight end shows as 23:59 and is left to the server, so the day's last minute is searched.
        expect(dialog.get_by_label('Workday ends')).to_have_value('23:59')
        self.assertNotIn('workdayEnd', query)
        dialog.get_by_label('Workday ends').fill('18:00')
        dialog.get_by_role('button', name='Check openings').click()
        expect(dialog.locator('.dp-openings-results small')).to_have_text('Crew Two')
        self.assertEqual(self.opening_queries[-1]['workdayEnd'], ['18:00'], 'a changed end is sent')
        dialog.get_by_role('button', name='Use this opening').click()
        dialog = page.get_by_role('dialog', name='Create job')
        expect(dialog.get_by_role('checkbox', name='Crew Two')).to_be_checked()
        expect(dialog.get_by_role('checkbox', name='Crew One')).not_to_be_checked()
        expect(dialog.get_by_role('checkbox', name='Shelving install')).to_be_checked()
        page.screenshot(path=str(RESULTS / 'dispatch-rules-openings-390.png'), full_page=True)

    def test_office_staff_join_assignment_lists_only_when_they_take_field_work(self):
        # Owner decision F19: the server marks an office-only owner or manager fieldWork:false (staff directory on).
        # A manager whose roles include crew work carries no marker and stays listed.
        self.roster = ROSTER + [{'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner', 'fieldWork': False}, {'id': 'field.manager', 'name': 'Field Manager', 'role': 'manager', 'staffRoles': ['manager', 'crew']}]
        self.jobs = [job(), job(id='job-owner', revision='rev-9', customer='Synthetic Owner Visit', time='12:00', endTime='13:00', startAt=DAY + 'T12:00:00-06:00', endAt=DAY + 'T13:00:00-06:00', assignedCrew=['zacb'], crewLead='zacb', requiredSkills=[])]
        page = self.open('/dispatch', width=375)
        page.get_by_role('button', name='Find opening').click()
        dialog = page.get_by_role('dialog')
        for name in ('Crew One', 'Crew Two', 'Field Manager'): expect(dialog.get_by_role('checkbox', name=name, exact=True)).to_have_count(1)
        expect(dialog.get_by_role('checkbox', name='Synthetic Owner')).to_have_count(0)
        dialog.get_by_role('button', name='Back').click()
        page.get_by_role('button', name='Create job').first.click()
        dialog = page.get_by_role('dialog', name='Create job')
        expect(dialog.get_by_role('checkbox', name='Field Manager')).to_have_count(1)
        expect(dialog.get_by_role('checkbox', name='Synthetic Owner')).to_have_count(0)
        self.assertNotIn('Synthetic Owner', dialog.get_by_label('Crew lead').inner_text())
        dialog.get_by_role('button', name='Back').click()
        # Work already assigned to the owner still shows them as assigned, and as its lead.
        page.locator('article.dp-job', has_text='Synthetic Owner Visit').get_by_role('button', name='Edit / assign').click()
        dialog = page.get_by_role('dialog', name='Edit / assign job')
        expect(dialog.get_by_role('checkbox', name='Synthetic Owner')).to_be_checked()
        self.assertEqual(dialog.get_by_label('Crew lead').input_value(), 'zacb')
        dialog.get_by_role('button', name='Save changes').click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(self.posts[-1]['changes']['assignedCrew'], ['zacb'], 'saving keeps the existing assignment')
        page.get_by_role('button', name='Crews & vehicles').click()
        page.get_by_role('dialog').get_by_role('button', name='Add crew').click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('checkbox', name='Field Manager')).to_have_count(1)
        expect(dialog.get_by_role('checkbox', name='Synthetic Owner')).to_have_count(0)

class DispatchRulesHubShellTests(HubShell, unittest.TestCase):
    """The registered screen inside the real employee.html shell: owner only, lazily loaded, phone-sized."""
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []; self.claims = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])
    def route(self, route):
        request = route.request
        if urlparse(request.url).path == '/api/crew-jobs' and request.method == 'POST':
            # The response /api/crew-jobs gives when the claimer's own daily limit blocks the pickup.
            self.claims.append(request.post_data_json)
            route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'dispatch_conflict', 'error': 'This shift cannot be added to your schedule.', 'details': {'conflicts': [
                {'code': 'employee_daily_capacity', 'jobId': 'synthetic-open-seat', 'employeeId': 'synthetic.crew', 'date': DAY, 'jobCount': 2, 'message': 'Synthetic Crew would have 2 jobs (3 hours) on 2026-09-22; the daily limit is 1 job.', 'blocking': True},
                {'code': 'legacy_blocked_day', 'jobId': 'synthetic-open-seat', 'date': DAY, 'message': 'Not repeated: the calendar block has its own top-level message.'}]}}))
            return
        HubShell.route(self, route)

    def test_a_refused_shift_pickup_names_the_rule_that_blocked_it(self):
        page = self.open('open_shifts', width=375, height=812, profile=CREW)
        page.evaluate("opsClaimShift('synthetic-open-seat')")
        expect(page.locator('#toast')).to_have_text('This shift cannot be added to your schedule. Synthetic Crew would have 2 jobs (3 hours) on 2026-09-22; the daily limit is 1 job.')
        self.assertEqual([claim['action'] for claim in self.claims], ['claim'])
        # A refusal is final: the next tap sends a new request, never a retry of the refused one.
        page.evaluate("opsClaimShift('synthetic-open-seat')")
        expect(page.locator('#toast')).to_contain_text('the daily limit is 1 job.')
        self.assertEqual(len(self.claims), 2); self.assertNotEqual(self.claims[0]['requestId'], self.claims[1]['requestId'])

    def test_only_the_owner_gets_the_dispatch_rules_screen(self):
        for width in (320, 375, 390):
            page = self.open('today', width=width, height=812, profile={**MANAGER, 'owner': True})
            self.assertIn('dispatch_rules', self.nav_views())
            self.go('dispatch_rules')
            expect(page.get_by_role('heading', name='Dispatch rules')).to_be_visible()
            expect(page.get_by_label('Block saves: Required skills')).to_be_checked()
            expect(page.get_by_label('Jobs per employee per day')).to_have_value('4')
            self.assertTrue(any(path == '/api/dispatch-settings' for _, path, _ in self.calls))
            self.assertLessEqual(self.no_horizontal_scroll()['width'], width)
            self.assertEqual(self.small_targets() + self.small_inputs(), [])
            self.close_page()
        page = self.open('today', width=375, height=812)
        self.assertNotIn('dispatch_rules', self.nav_views(), 'business access without the owner flag')
        page.evaluate("opsGo('dispatch_rules')")
        page.wait_for_function('new URLSearchParams(location.search).get("view")!=="dispatch_rules"')
        self.assertFalse(any(path == '/api/dispatch-settings' for _, path, _ in self.calls))

if __name__ == '__main__':
    unittest.main()
