"""FIX-EDIT-WIPE: /crew/job.html keeps a Pause/Waiting/Delay reason and an unsaved checklist edit through a background
re-render. Background Sync's 'egc-field-outbox-changed' message (crew/sw.js posts it after replaying the outbox) makes
the page read the job again; that read is held in the route handler until more has been typed, then the normal save
still goes through the field outbox once, with the request it always had. A blank line just started or an emptied
checklist editor is kept as typed, and this phone's own queued statuses confirming on reconnect (the first save held
until more is typed) leave a new reason open. Phone widths, routed fake API."""
import copy, datetime, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DAY = '2026-09-22'
CUSTOMER = 'Synthetic Drafts Garage'
CHECKLIST = [
    {'id': 'departure-address', 'stage': 'departure', 'label': 'Confirm the address, crew, truck and arrival time', 'detail': '', 'required': True, 'completed': True, 'completedAt': DAY + 'T14:30:00.000Z', 'completedBy': 'Crew One'},
    {'id': 'arrival-protect', 'stage': 'arrival', 'label': 'Protect belongings and walk the scope', 'detail': '', 'required': True, 'completed': False},
]
SYNC_MESSAGE = "navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'egc-field-outbox-changed',applied:1}}))"


def field_job(manager=False):
    return {'id': 'job-1', 'expectedRevision': 'rev-1', 'type': 'job', 'customer': CUSTOMER, 'phone': '9705550100', 'address': '1 Synthetic Way, Fort Collins, CO', 'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '12:00',
            'startAt': '', 'endAt': '', 'arrivalWindow': '', 'status': 'in_progress', 'fieldStatus': 'in_progress', 'statusReason': '', 'serviceType': 'Garage cleanout', 'assignedCrew': ['Crew.One'],
            'crewMembers': [{'id': 'Crew.One', 'name': 'Crew One'}], 'crewLead': 'Crew.One', 'crewId': '', 'crewName': '', 'vehicleId': '', 'vehicleName': '', 'crewNeeded': 1, 'scope': 'Synthetic one-day cleanout.',
            'customerGoal': '', 'keepItems': '', 'removeItems': '', 'exclusions': '', 'hazards': [], 'accessInstructions': '', 'access': [], 'truckPlacement': '', 'customerInstructions': '', 'requiredEquipment': [],
            'materials': [], 'checklist': copy.deepcopy(CHECKLIST), 'photos': [], 'history': [], 'attention': None, 'canAddManagementNote': manager,
            'jobTime': {'recorded': True, 'estimatedMs': 14400000, 'asOf': DAY + 'T16:00:00.000Z', 'needsReview': False, 'partialHistory': False, 'runningKind': 'work', 'workMs': 3600000, 'pausedMs': 0, 'waitingMs': 0,
                        'delayedMs': 0, 'travelMs': 0, 'arrivalMs': 0, 'totalRecordedMs': 3600000, 'workVarianceMs': None},
            'completion': None, 'completionSync': None, 'startedAt': DAY + 'T15:00:00.000Z', 'completedAt': None, 'completionMissing': [], 'canEdit': True, 'canManageChecklist': manager,
            'allowedStatuses': ['paused', 'waiting', 'delayed', 'in_progress']}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


class CrewJobDraftsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.errors = []; self.posts = []; self.dialogs = []; self.hold_job = False; self.held = None; self.hold_post = False; self.held_post = None; self.context = None
    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def open(self, width, height=812, manager=False):
        self.manager = manager; self.job = field_job(manager)
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True, service_workers='block')
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        # 10:00 in Denver; the phone itself is set to Tokyo.
        self.page.clock.install(time=datetime.datetime(2026, 9, 22, 16, tzinfo=datetime.timezone.utc))
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.route('**/*', self.route)
        self.page.goto(self.url + '/crew/job.html?jobId=job-1')
        expect(self.page.get_by_role('heading', name=CUSTOMER, exact=True)).to_be_visible()
        return self.page

    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/hub-auth':
            send({'ok': True, 'user': 'ZacB', 'displayName': 'Owner', 'role': 'owner', 'businessAccess': True} if self.manager else {'ok': True, 'user': 'Crew.One', 'displayName': 'Crew One', 'role': 'crew'}); return
        if parsed.path == '/api/employee-hub':
            if parse_qs(parsed.query).get('view') == ['job-labor']: send({'ok': True, 'jobId': 'job-1', 'employees': [], 'asOf': DAY + 'T16:00:00.000Z', 'legacyAssociationOnlyCount': 0, 'needsReviewCount': 0}); return
            send({'ok': True, 'user': 'ZacB' if self.manager else 'Crew.One', 'entry': None}); return
        if parsed.path in ('/api/field-expenses', '/api/field-photo-sharing'): send({'ok': False, 'error': 'Not enabled.'}, 404); return
        if parsed.path != '/api/field-jobs': route.continue_(); return
        if req.method == 'GET':
            if parse_qs(parsed.query).get('view') == ['timer']: send({'ok': True, 'jobTime': self.job['jobTime'], 'expectedRevision': self.job['expectedRevision']}); return
            if self.hold_job: self.hold_job = False; self.held = route; return
            send(self.detail()); return
        if self.hold_post: self.hold_post = False; self.held_post = route; return
        self.answer_post(route)

    def answer_post(self, route):
        body = route.request.post_data_json; self.posts.append(copy.deepcopy(body)); job = copy.deepcopy(self.job)
        job['expectedRevision'] = f"rev-{len(self.posts) + 1}"
        # A job in progress offers the same statuses whatever its activity (paused, waiting, delayed or working), as the server does.
        if body['action'] == 'status': job.update(fieldStatus=body['status'], statusReason=body.get('reason', ''), allowedStatuses=['paused', 'waiting', 'delayed', 'in_progress'])
        elif body['action'] == 'configure_checklist': job['checklist'] = [{'id': item['id'], 'stage': item['stage'], 'label': item['label'], 'detail': item['detail'], 'required': item['required'], 'completed': False} for item in body['items']]
        self.job = job
        route.fulfill(status=200, content_type='application/json', body=json.dumps({**self.detail(), 'alreadyApplied': False}))

    def detail(self):
        return {'ok': True, 'job': copy.deepcopy(self.job), 'historyCursor': None, 'photosAvailable': True, 'features': {'jobCosts': False}, 'timezone': 'America/Denver'}

    def background_sync(self, count=1):
        """Background Sync confirmed a crew-mate's action: the page reads the job again, and that read is held here."""
        self.job = copy.deepcopy(self.job); self.job['expectedRevision'] = 'rev-synced'; self.synced = f'Synthetic crew-mate update {count} from the truck'
        self.job['history'] = [{'id': f'history-synced-{count}', 'action': 'note', 'createdAt': DAY + 'T16:00:00.000Z', 'actorId': 'Crew.Two', 'actorName': 'Crew Two', 'body': self.synced, 'summary': 'Note added', 'visibility': 'crew'}]
        self.hold_job = True
        with self.page.expect_request(lambda request: request.method == 'GET' and urlparse(request.url).path == '/api/field-jobs' and parse_qs(urlparse(request.url).query) == {'jobId': ['job-1']}):
            self.page.evaluate(SYNC_MESSAGE)

    def release(self):
        # Playwright reports a routed request and then hands it to the route handler in the same step, so one round trip
        # to the page after expect_request has run the handler that holds it.
        self.page.evaluate('0')
        self.assertIsNotNone(self.held, 'the job read is held until more has been typed')
        held, self.held = self.held, None
        held.fulfill(status=200, content_type='application/json', body=json.dumps(self.detail()))
        # The re-render has run once the crew-mate's update is on the page.
        expect(self.page.locator('#history-card')).to_contain_text(self.synced)

    def release_post(self):
        """Answers the save held in the route handler (hold_post), as the server would have."""
        self.page.evaluate('0')
        self.assertIsNotNone(self.held_post, 'the save is held until more has been typed')
        held, self.held_post = self.held_post, None
        self.answer_post(held)

    def caret(self, selector):
        return self.page.evaluate('s=>{const el=document.querySelector(s);return [document.activeElement===el,el.selectionStart,el.selectionEnd]}', selector)

    def assert_phone_layout(self):
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        fonts = self.page.evaluate("""[...document.querySelectorAll('#field-main input:not([type=checkbox]), #field-main select, #field-main textarea')].filter(el=>el.offsetParent).map(el=>parseFloat(getComputedStyle(el).fontSize))""")
        self.assertTrue(all(size >= 16 for size in fonts), fonts)

    def test_pause_reason_typed_during_a_background_sync_survives_and_saves_once(self):
        page = self.open(375)
        page.get_by_role('button', name='Pause work', exact=True).click()
        reason = page.get_by_label('Reason for paused')
        expect(reason).to_be_focused()
        reason.fill('Customer asked us to stop')
        self.background_sync()
        # Typed while the job is being read again.
        reason.press_sequentially(' until 2 PM')
        self.release()
        expect(reason).to_have_value('Customer asked us to stop until 2 PM')
        self.assertEqual(self.caret('#reason'), [True, 36, 36], 'the reason keeps focus and its caret')
        expect(page.get_by_role('button', name='Save paused')).to_be_enabled()
        self.assertEqual(self.posts, [], 'a re-render saves nothing')
        self.assert_phone_layout()
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); page.screenshot(path=str(out / 'crew-job-reason-kept-375.png'), full_page=True)
        # The normal save: one status action through the field outbox with the typed reason, and the form closes.
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/field-jobs'):
            page.get_by_role('button', name='Save paused').click()
        expect(page.locator('#feedback')).to_contain_text('Saved to the job.')
        expect(page.locator('#status-form')).to_have_count(0)
        expect(page.locator('.section-heading .badge').first).to_have_text('paused')
        self.assertEqual(len(self.posts), 1)
        post = self.posts[0]
        self.assertEqual(sorted(post), ['action', 'expectedRevision', 'expectedUser', 'jobId', 'reason', 'requestId', 'status'])
        self.assertEqual({key: post[key] for key in ['action', 'status', 'reason', 'jobId', 'expectedRevision', 'expectedUser']},
                         {'action': 'status', 'status': 'paused', 'reason': 'Customer asked us to stop until 2 PM', 'jobId': 'job-1', 'expectedRevision': 'rev-synced', 'expectedUser': 'Crew.One'})
        self.assertTrue(UUID.match(post['requestId']))
        # Another background read after the save draws no stale form.
        self.background_sync(2); self.release()
        expect(page.locator('#reason')).to_have_count(0)
        self.assertEqual(len(self.posts), 1)

    def test_unsaved_checklist_edit_stays_open_through_a_background_sync_and_saves(self):
        page = self.open(390, 844, manager=True)
        page.get_by_text('Manager: configure this job’s checklist', exact=True).click()
        lines = page.get_by_label('Job checklist', exact=True)
        expect(lines).to_be_visible()
        lines.fill('departure | required | Confirm the pressure washer is loaded\narrival | required | Protect belongings and walk the scope')
        self.background_sync()
        lines.press('End'); lines.press_sequentially('\nfinish | optional | Sweep the driveway')
        self.release()
        edited = 'departure | required | Confirm the pressure washer is loaded\narrival | required | Protect belongings and walk the scope\nfinish | optional | Sweep the driveway'
        expect(page.locator('details:has(#checklist-lines)')).to_have_attribute('open', '')
        expect(lines).to_have_value(edited)
        self.assertEqual(self.caret('#checklist-lines'), [True, len(edited), len(edited)], 'the editor keeps focus and its caret')
        self.assertEqual(self.posts, [], 'a re-render saves nothing')
        self.assert_phone_layout()
        # The normal save sends the edited lines; once the job confirms them the editor shows the saved checklist.
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/field-jobs'):
            page.get_by_role('button', name='Save checklist', exact=True).click()
        expect(page.locator('#feedback')).to_contain_text('Saved to the job.')
        expect(page.locator('#checklist-card')).to_contain_text('Sweep the driveway')
        self.assertEqual(len(self.posts), 1)
        post = self.posts[0]
        self.assertEqual((post['action'], post['expectedRevision'], post['expectedUser']), ('configure_checklist', 'rev-synced', 'ZacB'))
        self.assertEqual([(item['stage'], item['required'], item['label']) for item in post['items']],
                         [('departure', True, 'Confirm the pressure washer is loaded'), ('arrival', True, 'Protect belongings and walk the scope'), ('finish', False, 'Sweep the driveway')])
        self.assertEqual([item['id'] for item in post['items'][:2]], ['departure-address', 'arrival-protect'])
        self.assertTrue(UUID.match(post['requestId']))
        expect(lines).to_have_value(edited)
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(k=>k.endsWith(':checklistLines')&&sessionStorage.getItem(k))"), [], 'the confirmed edit is no longer kept as a draft')
        # Closing the editor is remembered through the next background read.
        page.get_by_text('Manager: configure this job’s checklist', exact=True).click()
        expect(page.locator('details:has(#checklist-lines)')).not_to_have_attribute('open', '')
        self.background_sync(2); self.release()
        expect(page.locator('details:has(#checklist-lines)')).not_to_have_attribute('open', '')

    def test_a_crew_mate_setting_the_same_status_closes_the_reason_form_and_keeps_what_was_typed(self):
        page = self.open(375)
        page.get_by_role('button', name='Pause work', exact=True).click()
        reason = page.get_by_label('Reason for paused'); reason.fill('Waiting on the customer')
        # A crew-mate paused the job with their own reason; Background Sync reads it while more is typed here.
        self.job = copy.deepcopy(self.job); self.job.update(fieldStatus='paused', statusReason='Synthetic crew-mate: dump run')
        self.background_sync()
        reason.press_sequentially(' to move the car')
        self.release()
        expect(page.locator('.section-heading .badge').first).to_have_text('paused')
        expect(page.get_by_role('button', name='Pause work', exact=True)).to_have_count(0)
        # The form for the status the job already has is gone, so the crew-mate's reason cannot be replaced.
        expect(page.locator('#status-form')).to_have_count(0); expect(page.get_by_role('button', name='Save paused')).to_have_count(0)
        notice = page.locator('#status-superseded')
        expect(notice).to_contain_text('This job was set to paused while you were typing, so your reason was not saved.')
        expect(notice.locator('.text-block')).to_have_text('Waiting on the customer to move the car')
        expect(page.locator('#field-main')).to_contain_text('paused: Synthetic crew-mate: dump run')
        self.assertEqual(self.posts, [], 'nothing was saved')
        self.assert_phone_layout()
        dismiss = notice.get_by_role('button', name='Dismiss'); self.assertGreaterEqual(dismiss.bounding_box()['height'], 44)
        # Another background read keeps the notice until it is dismissed.
        self.background_sync(2); self.release()
        expect(notice).to_be_visible()
        dismiss.click()
        expect(notice).to_have_count(0); expect(page.locator('#status-form')).to_have_count(0)
        self.assertEqual(self.posts, [])

    def test_a_checklist_edit_keeps_where_it_started_and_waits_when_the_checklist_changed(self):
        page = self.open(390, 844, manager=True)
        page.get_by_text('Manager: configure this job’s checklist', exact=True).click()
        lines = page.get_by_label('Job checklist', exact=True); save = page.get_by_role('button', name='Save checklist', exact=True)
        drafts = "Object.keys(sessionStorage).filter(k=>/:(checklistLines|checklistBase)$/.test(k)).sort()"
        # A character typed and deleted leaves no edit behind.
        lines.press('Control+End'); lines.press_sequentially('x'); lines.press('Backspace')
        self.assertEqual(page.evaluate(drafts), [], 'an edit back to where it started is not kept')
        # Another manager renamed a task: with no edit kept, the editor shows it.
        self.job = copy.deepcopy(self.job); self.job['checklist'][1]['label'] = 'Protect belongings, then walk the scope'
        self.background_sync(); self.release()
        expect(lines).to_have_value('departure | required | Confirm the address, crew, truck and arrival time\narrival | required | Protect belongings, then walk the scope')
        # A real edit, then another manager adds a task while it is open: Save waits until the edit is kept or discarded.
        lines.press('Control+End'); lines.press_sequentially('\nfinish | optional | Sweep the driveway')
        mine = 'departure | required | Confirm the address, crew, truck and arrival time\narrival | required | Protect belongings, then walk the scope\nfinish | optional | Sweep the driveway'
        self.assertEqual(len(page.evaluate(drafts)), 2, 'the edit and the checklist it started from are kept')
        self.job = copy.deepcopy(self.job); self.job['checklist'].append({'id': 'work-dumpster', 'stage': 'work', 'label': 'Load the dumpster', 'detail': '', 'required': False, 'completed': False})
        self.background_sync(2); self.release()
        changed = page.locator('#checklist-changed')
        expect(changed).to_contain_text('The checklist changed since you started editing.')
        expect(lines).to_have_value(mine); expect(save).to_be_disabled()
        expect(page.locator('#checklist-card')).to_contain_text('Load the dumpster')
        for name in ['Keep my edit', 'Discard edit']: self.assertGreaterEqual(changed.get_by_role('button', name=name).bounding_box()['height'], 44)
        self.assert_phone_layout()
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); page.screenshot(path=str(out / 'crew-job-checklist-changed-390.png'), full_page=True)
        # Discard shows the current checklist.
        changed.get_by_role('button', name='Discard edit').click()
        self.assertIn('Discard your checklist edit?', self.dialogs[-1])
        expect(changed).to_have_count(0); expect(save).to_be_enabled()
        current = 'departure | required | Confirm the address, crew, truck and arrival time\narrival | required | Protect belongings, then walk the scope\nwork | optional | Load the dumpster'
        expect(lines).to_have_value(current)
        self.assertEqual(page.evaluate(drafts), [])
        # Edited again, the checklist changes again; this time the manager keeps the edit and saves it.
        lines.press('Control+End'); lines.press_sequentially('\nfinish | optional | Sweep the driveway')
        self.job = copy.deepcopy(self.job); self.job['checklist'][2]['required'] = True
        self.background_sync(3); self.release()
        expect(changed).to_be_visible(); expect(save).to_be_disabled()
        changed.get_by_role('button', name='Keep my edit').click()
        expect(changed).to_have_count(0); expect(save).to_be_enabled(); expect(lines).to_be_focused()
        self.assertEqual(self.posts, [], 'nothing is saved before Save checklist')
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/field-jobs'): save.click()
        expect(page.locator('#feedback')).to_contain_text('Saved to the job.')
        self.assertEqual(len(self.posts), 1); post = self.posts[0]
        self.assertEqual((post['action'], post['expectedRevision']), ('configure_checklist', 'rev-synced'))
        self.assertEqual([(item['id'], item['stage'], item['required'], item['label']) for item in post['items']],
                         [('departure-address', 'departure', True, 'Confirm the address, crew, truck and arrival time'), ('arrival-protect', 'arrival', True, 'Protect belongings, then walk the scope'),
                          ('work-dumpster', 'work', False, 'Load the dumpster'), (post['items'][3]['id'], 'finish', False, 'Sweep the driveway')])
        self.assertTrue(post['items'][3]['id'].startswith('custom-'))
        self.assertEqual(page.evaluate(drafts), [], 'the confirmed edit is no longer kept')

    def test_a_new_line_started_in_the_checklist_editor_survives_background_syncs_and_the_intended_rows_save(self):
        page = self.open(390, 844, manager=True)
        page.get_by_text('Manager: configure this job’s checklist', exact=True).click()
        lines = page.get_by_label('Job checklist', exact=True); save = page.get_by_role('button', name='Save checklist', exact=True)
        rows = 'departure | required | Confirm the address, crew, truck and arrival time\narrival | required | Protect belongings and walk the scope'
        expect(lines).to_have_value(rows)
        # Enter at the end of the last task while the job is read again: the new line (blank so far) and the caret on it stay.
        lines.press('Control+End'); self.background_sync()
        lines.press('Enter')
        self.release()
        expect(lines).to_have_value(rows + '\n')
        self.assertEqual(self.caret('#checklist-lines'), [True, len(rows) + 1, len(rows) + 1], 'the caret stays on the new line')
        lines.press_sequentially('finish | optional | Sweep the driveway')
        # Enter at the start of the first task while the job is read again: the new first line stays, and so does the caret.
        lines.press('Control+Home'); self.background_sync(2)
        lines.press('Enter')
        self.release()
        expect(lines).to_have_value('\n' + rows + '\nfinish | optional | Sweep the driveway')
        self.assertEqual(self.caret('#checklist-lines'), [True, 1, 1])
        lines.press('ArrowUp'); lines.press_sequentially('departure | optional | Load the dolly')
        edited = 'departure | optional | Load the dolly\n' + rows + '\nfinish | optional | Sweep the driveway'
        expect(lines).to_have_value(edited)
        expect(page.locator('#checklist-changed')).to_have_count(0); expect(save).to_be_enabled()
        self.assertEqual(self.posts, [], 'a re-render saves nothing')
        self.assert_phone_layout()
        # The normal save sends each task on its own line. A new line started while it is confirmed stays as well.
        self.hold_post = True
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/field-jobs'): save.click()
        lines.press('Control+End'); lines.press('Enter')
        self.release_post()
        expect(page.locator('#feedback')).to_contain_text('Saved to the job.'); expect(save).to_be_enabled()
        self.assertEqual(len(self.posts), 1); post = self.posts[0]
        self.assertEqual((post['action'], post['expectedRevision'], post['expectedUser']), ('configure_checklist', 'rev-synced', 'ZacB'))
        self.assertEqual([(item['stage'], item['required'], item['label']) for item in post['items']],
                         [('departure', False, 'Load the dolly'), ('departure', True, 'Confirm the address, crew, truck and arrival time'), ('arrival', True, 'Protect belongings and walk the scope'), ('finish', False, 'Sweep the driveway')])
        self.assertTrue(UUID.match(post['requestId']))
        expect(page.locator('#checklist-card')).to_contain_text('Load the dolly')
        expect(lines).to_have_value(edited + '\n')
        self.assertEqual(self.caret('#checklist-lines'), [True, len(edited) + 1, len(edited) + 1])
        expect(page.locator('#checklist-changed')).to_have_count(0)
        lines.press_sequentially('work | optional | Haul the boxes')
        expect(lines).to_have_value(edited + '\nwork | optional | Haul the boxes')
        self.assertEqual(len(self.posts), 1)

    def test_an_emptied_checklist_editor_stays_empty_through_background_syncs_and_saves_what_is_typed(self):
        page = self.open(390, 844, manager=True)
        page.get_by_text('Manager: configure this job’s checklist', exact=True).click()
        lines = page.get_by_label('Job checklist', exact=True); save = page.get_by_role('button', name='Save checklist', exact=True)
        # Select all and Delete while the job is read again: the emptied editor is not refilled.
        lines.press('Control+a'); self.background_sync()
        lines.press('Delete')
        self.release()
        expect(lines).to_have_value('')
        expect(page.locator('details:has(#checklist-lines)')).to_have_attribute('open', '')
        self.assertEqual(self.caret('#checklist-lines'), [True, 0, 0], 'the editor keeps focus and its caret')
        self.background_sync(2); self.release()
        expect(lines).to_have_value('')
        expect(page.locator('#checklist-changed')).to_have_count(0)
        self.assertEqual(self.posts, [], 'a re-render saves nothing')
        self.assert_phone_layout()
        # What is typed into the emptied editor is what saves.
        lines.press_sequentially('work | required | Haul everything to the curb')
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/field-jobs'): save.click()
        expect(page.locator('#feedback')).to_contain_text('Saved to the job.')
        self.assertEqual(len(self.posts), 1); post = self.posts[0]
        self.assertEqual((post['action'], post['expectedRevision'], post['expectedUser']), ('configure_checklist', 'rev-synced', 'ZacB'))
        self.assertEqual([(item['stage'], item['required'], item['label']) for item in post['items']], [('work', True, 'Haul everything to the curb')])
        expect(lines).to_have_value('work | required | Haul everything to the curb')
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(k=>/:(checklistLines|checklistBase)$/.test(k))"), [], 'the confirmed edit is no longer kept')

    def test_a_reload_drops_a_kept_edit_that_only_adds_a_blank_line_and_keeps_a_real_one(self):
        page = self.open(390, 844, manager=True)
        page.get_by_text('Manager: configure this job’s checklist', exact=True).click()
        lines = page.get_by_label('Job checklist', exact=True); editor = page.locator('details:has(#checklist-lines)')
        drafts = "Object.keys(sessionStorage).filter(k=>/:(checklistLines|checklistBase)$/.test(k)).sort()"
        rows = 'departure | required | Confirm the address, crew, truck and arrival time\narrival | required | Protect belongings and walk the scope'
        lines.press('Control+End'); lines.press('Enter')
        self.assertEqual(len(page.evaluate(drafts)), 2, 'a new line is kept while the page is open')
        # Reopened, nothing is being typed: an edit that reads the same as the job's checklist is not brought back.
        page.reload(); expect(page.get_by_role('heading', name=CUSTOMER, exact=True)).to_be_visible()
        expect(lines).to_have_value(rows); expect(editor).not_to_have_attribute('open', '')
        self.assertEqual(page.evaluate(drafts), [])
        page.get_by_text('Manager: configure this job’s checklist', exact=True).click()
        lines.press('Control+End'); lines.press_sequentially('\nfinish | optional | Sweep the driveway'); lines.press('Enter')
        page.reload(); expect(page.get_by_role('heading', name=CUSTOMER, exact=True)).to_be_visible()
        expect(editor).to_have_attribute('open', '')
        expect(lines).to_have_value(rows + '\nfinish | optional | Sweep the driveway\n')
        self.assertEqual(self.posts, [])

    def test_this_phones_own_queued_pause_confirming_on_reconnect_leaves_a_new_reason_open(self):
        page = self.open(375)
        outbox, badge = page.locator('#outbox-card'), page.locator('.section-heading .badge').first
        self.context.set_offline(True)
        expect(page.locator('#connection')).to_contain_text('You are offline.')
        # Offline: paused with a reason, resumed, then paused again with a new reason being typed.
        page.get_by_role('button', name='Pause work', exact=True).click()
        page.get_by_label('Reason for paused').fill('Synthetic first pause')
        page.get_by_role('button', name='Save paused').click()
        expect(outbox).to_contain_text('1 action saved on this phone')
        page.get_by_role('button', name='Resume work', exact=True).click()
        expect(outbox).to_contain_text('2 actions saved on this phone')
        page.get_by_role('button', name='Pause work', exact=True).click()
        reason = page.get_by_label('Reason for paused'); expect(reason).to_have_value('')
        reason.fill('Back after the')
        # Reconnected: this phone's own pause replays first (held here while more is typed), then its resume.
        self.hold_post = True
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/field-jobs'): self.context.set_offline(False)
        reason.press_sequentially(' dump run')
        self.release_post()
        expect(page.locator('#feedback')).to_contain_text('2 saved actions are now confirmed.')
        expect(badge).to_have_text('in progress')
        # The pause confirmed on the way was this phone's own, so the new reason stays open as typed, with no notice.
        expect(page.locator('#status-superseded')).to_have_count(0)
        expect(reason).to_have_value('Back after the dump run')
        self.assertEqual(self.caret('#reason'), [True, 23, 23], 'the reason keeps focus and its caret')
        self.assertEqual([(post['action'], post['status'], post.get('reason')) for post in self.posts], [('status', 'paused', 'Synthetic first pause'), ('status', 'in_progress', None)])
        self.assert_phone_layout()
        # The normal save: one more status action through the field outbox with the typed reason, and the form closes.
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/field-jobs'):
            page.get_by_role('button', name='Save paused').click()
        expect(page.locator('#feedback')).to_contain_text('Saved to the job.')
        expect(page.locator('#status-form')).to_have_count(0); expect(badge).to_have_text('paused')
        self.assertEqual(len(self.posts), 3); post = self.posts[2]
        self.assertEqual(sorted(post), ['action', 'expectedRevision', 'expectedUser', 'jobId', 'reason', 'requestId', 'status'])
        self.assertEqual({key: post[key] for key in ['action', 'status', 'reason', 'jobId', 'expectedRevision', 'expectedUser']},
                         {'action': 'status', 'status': 'paused', 'reason': 'Back after the dump run', 'jobId': 'job-1', 'expectedRevision': 'rev-3', 'expectedUser': 'Crew.One'})
        self.assertTrue(UUID.match(post['requestId'])); self.assertNotIn(post['requestId'], [earlier['requestId'] for earlier in self.posts[:2]])
        expect(page.locator('#status-superseded')).to_have_count(0)


if __name__ == '__main__':
    unittest.main()
