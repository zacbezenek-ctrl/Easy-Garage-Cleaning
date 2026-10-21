"""EGC_WALKTHROUGH_NOTES: the walkthrough notes panel (crew/gameplan-notes.js) on the real crew/gameplan.html at 375x812,
iPad 820x1180 and iPad 1024x1366. The panel is one line until it is opened (summary .wtn-summary).

Isolated fixtures only: a fake Firebase SDK, a FUN-05 walkthrough-visit stand-in with the outcome saved, and a
/api/walkthrough-notes stand-in that holds the parts, the draft and the confirmed notes the way the server answers them.
Playwright's clock drives the panel's 10-second look-again. Every other host is refused. Synthetic data only."""
import copy, datetime, json, os, pathlib, re, threading, time, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime.datetime(2026, 10, 19, 16, tzinfo=datetime.timezone.utc)  # 10:00 in Denver
PHONE = {'viewport': {'width': 375, 'height': 812}, 'is_mobile': True, 'has_touch': True}
IPAD = {'viewport': {'width': 820, 'height': 1180}, 'is_mobile': True, 'has_touch': True}
IPAD_PRO = {'viewport': {'width': 1024, 'height': 1366}, 'is_mobile': True, 'has_touch': True}
PHONE_390 = {'viewport': {'width': 390, 'height': 844}, 'is_mobile': True, 'has_touch': True}
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')

FAKE_FIREBASE = """
window.firebase = (() => {
  const doc = id => ({ async get() { return { exists: false, id, data: () => undefined }; } });
  const query = { async get() { return { docs: [] }; } };
  return { apps: [], initializeApp(config) { this.apps.push(config); return {}; },
    auth: () => ({ signInWithCustomToken: async () => ({}), signOut: async () => {} }),
    firestore: () => ({ collection: () => ({ doc, where: () => query }) }) };
})();
"""
WT = {'id': 'wt-1', 'type': 'walkthrough', 'status': 'scheduled', 'customer': 'Synthetic Customer', 'phone': '9705550100', 'address': '100 Synthetic Lane', 'date': '2026-10-19', 'time': '09:00'}
# What the server's draft looks like: already cleaned of money and contact details (functions/_lib/visit-notes.js).
DRAFT = {'jobNotes': ['Clear the left bay first; the customer parks there tonight.', 'Stage donations on the driveway.'],
         'itemsNeeded': [{'name': 'Metal shelving unit', 'quantity': 2, 'reason': 'Back wall'}, {'name': 'Ladder', 'quantity': None, 'reason': 'Overhead rack'}],
         'keepItems': ['Blue bicycle'], 'removeItems': ['Old couch (donate)'], 'access': ['Side door'], 'hazards': ['Mouse droppings by the freezer'], 'openQuestions': ['Does the treadmill go or stay?']}
TRANSCRIPT = '[Part 1]\nSynthetic first half of the walkthrough.\n\n[Part 2]\nSynthetic second half of the walkthrough.'


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class GameplanNotesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def start_page(self, device=IPAD):
        self.context = self.browser.new_context(timezone_id='America/Denver', **device)
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        self.errors = []; self.posts = []; self.gets = 0
        self.enabled = True; self.can_confirm = True; self.recording = 'recorded'; self.outcome = 'quote_to_follow'
        self.parts = []; self.expected = None; self.status = 'empty'; self.draft = None; self.drafted_at = None; self.confirmed = None; self.rev = 0
        self.conflict_next_confirm = False; self.dialogs = []; self.jobs = 1; self.confirmed_hash = None; self.tick = 0
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.clock.install(time=NOW)
        self.page.add_init_script(FAKE_FIREBASE)
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()

    def json(self, route, status, body):
        route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(body))

    def view(self):
        # As functions/_lib/walkthrough-notes.js answers: complete once a part named the count (sent after Finish) and that many
        # are transcribed or finally refused; confirmedStale when the transcript changed after the confirm.
        done = [part for part in self.parts if part['status'] == 'done']
        settled = [part for part in self.parts if part['status'] == 'done' or part.get('errorCode') in ('recording_audio_unreadable', 'recording_too_long')]
        transcript = TRANSCRIPT if len(done) >= 2 else ('[Part 1]\nSynthetic first half of the walkthrough.' if done else '')
        return {'ok': True, 'enabled': True, 'visitId': 'wt-1', 'status': self.status, 'revision': f'n{self.rev}' if self.rev else '', 'canConfirm': self.can_confirm, 'canDraft': True,
                'outcome': {'outcome': self.outcome, 'recordingStatus': self.recording} if self.outcome else None, 'parts': copy.deepcopy(self.parts), 'expectedParts': self.expected,
                'complete': bool(self.expected) and len(settled) >= self.expected, 'transcript': transcript,
                'transcriptMissing': 0, 'draft': copy.deepcopy(self.draft), 'draftedAt': self.drafted_at, 'draftStale': False, 'draftsLeft': 5, 'confirmed': copy.deepcopy(self.confirmed),
                'confirmedJobs': self.jobs if self.confirmed else 0, 'confirmedStale': bool(self.confirmed) and bool(done) and transcript != self.confirmed_hash}

    def route(self, route):
        request = route.request; url = urlparse(request.url)
        if url.hostname != '127.0.0.1':
            if url.hostname == 'www.gstatic.com' and url.path.startswith('/firebasejs/'):
                route.fulfill(status=200, content_type='text/javascript', body=FAKE_FIREBASE if url.path.endswith('firebase-app-compat.js') else '')
            else:
                route.abort()
            return
        if url.path == '/api/hub-auth':
            return self.json(route, 200, {'ok': True, 'user': 'sales.rep', 'displayName': 'Synthetic Rep', 'role': 'owner', 'businessAccess': True, 'capabilities': []})
        if url.path == '/api/firebase-session':
            return self.json(route, 200, {'ok': True, 'token': 'synthetic-token'})
        if url.path == '/api/walkthrough-handoff' and request.method == 'GET':
            return self.json(route, 200, {'ok': True, 'walkthroughs': [WT], 'requested': WT})
        if url.path == '/api/walkthrough-visit':
            visit = {'id': 'wt-1', 'revision': 'r3', 'type': 'walkthrough', 'customer': 'Synthetic Customer', 'date': '2026-10-19', 'time': '09:00', 'status': 'scheduled', 'rebookPending': False, 'previousOccurrences': 0,
                     'walkthroughVisit': {'startedAt': '2026-10-19T15:00:00.000Z', 'startedBy': 'sales.rep', 'recordingStatus': self.recording},
                     'walkthroughOutcome': {'outcome': self.outcome, 'recordingStatus': self.recording, 'finishedAt': '2026-10-19T15:45:00.000Z'} if self.outcome else None, 'walkthroughCompletedAt': None}
            return self.json(route, 200, {'ok': True, 'authority': 'employee_hub', 'enabled': True, 'visit': visit, 'openVisit': None, 'shift': {'available': True, 'clockedIn': True}, 'viewer': {'id': 'sales.rep', 'manager': True}})
        if url.path == '/api/walkthrough-notes':
            return self.notes_api(route, request, url)
        if url.path.startswith('/api/'):
            return self.json(route, 404, {'ok': False, 'error': 'Not part of this fixture.'})
        route.continue_()

    def notes_api(self, route, request, url):
        if request.method == 'GET':
            self.gets += 1
            if not self.enabled:
                return self.json(route, 200, {'ok': True, 'enabled': False})
            if not url.query:
                return self.json(route, 200, {'ok': True, 'enabled': True})
            self.assertEqual(parse_qs(url.query), {'visitId': ['wt-1']})
            return self.json(route, 200, self.view())
        self.assertEqual(request.headers.get('content-type'), 'application/json')
        body = request.post_data_json; self.posts.append(body)
        self.assertRegex(body['requestId'], UUID); self.assertEqual(body['visitId'], 'wt-1')
        # Each draft and confirm is stamped later than the one before, as the server's clock stamps them.
        self.tick += 1; stamp = f'2026-10-19T16:{10 + self.tick:02d}:00.000Z'
        if body['action'] == 'draft':
            self.draft = copy.deepcopy(DRAFT); self.drafted_at = stamp; self.status = 'drafted'; self.rev += 1
        elif body['action'] == 'confirm':
            if self.conflict_next_confirm:
                self.conflict_next_confirm = False; self.rev += 1
                return self.json(route, 409, {'ok': False, 'code': 'walkthrough_notes_changed', 'error': 'These notes changed since you opened them. Review them again before confirming.'})
            if body['expectedRevision'] != (f'n{self.rev}' if self.rev else ''):
                return self.json(route, 409, {'ok': False, 'code': 'walkthrough_notes_changed', 'error': 'These notes changed since you opened them. Review them again before confirming.'})
            self.confirmed = {**body['notes'], 'confirmedAt': stamp, 'confirmedBy': 'sales.rep'}; self.status = 'confirmed'; self.rev += 1
            self.confirmed_hash = self.view()['transcript']
        elif body['action'] == 'withdraw':
            self.parts = []; self.expected = None; self.draft = None; self.status = 'withdrawn'; self.rev += 1
        return self.json(route, 200, self.view())

    def open(self):
        self.page.goto(self.url + '/crew/gameplan.html?walkthroughId=wt-1')
        expect(self.page.locator('#wt-recorder')).to_contain_text('Outcome recorded: Quote to follow')

    def panel(self):
        return self.page.locator('#wt-notes')

    def open_panel(self):
        # Closed, the panel is its title and one status line; a tap on that line opens it.
        details = self.panel().locator('details.wtn-disclosure')
        expect(details).to_have_count(1)
        if details.get_attribute('open') is None:
            self.panel().locator('summary.wtn-summary').click()
        expect(details).to_have_attribute('open', '')
        return self.panel()

    def status_line(self):
        return self.panel().locator('summary.wtn-summary .wtn-status')

    def assert_layout(self, width, shot=None):
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
        if shot:
            out = ROOT / 'test-results'; out.mkdir(exist_ok=True); self.panel().screenshot(path=str(out / shot))
        small = self.page.evaluate("""[...document.querySelectorAll('#wt-notes button, #wt-notes input, #wt-notes textarea, #wt-notes summary')].filter(el => el.offsetParent).map(el => [el.textContent.trim() || el.tagName, Math.round(el.getBoundingClientRect().height)]).filter(([, height]) => height < 44)""")
        self.assertEqual(small, [], 'every notes control is at least 44px tall')
        stray = self.page.evaluate("""document.querySelector('#wt-notes').innerText.match(/\\b(null|undefined|NaN)\\b/g)""")
        self.assertIsNone(stray)

    def until(self, check, message, timeout=8):
        deadline = time.monotonic() + timeout
        while not check():
            if time.monotonic() > deadline:
                self.fail(message)
            self.page.wait_for_timeout(50)

    def draft_flow(self, width):
        # Part 1 is transcribed, part 2 is still on its way: the panel says so and looks again every 10 seconds.
        self.parts = [{'partIndex': 1, 'source': 'recorder', 'status': 'done', 'chars': 41}]; self.expected = 2; self.status = 'transcribing'; self.rev = 1
        self.open()
        panel = self.panel()
        expect(self.status_line()).to_have_text('Transcribing: 1 of 2 parts done')
        expect(panel.locator('progress')).to_be_hidden()
        self.open_panel()
        expect(panel).to_contain_text('Transcribing: 1 of 2 parts done.')
        expect(panel.locator('progress')).to_be_visible()
        expect(panel.get_by_role('button', name='Write up notes now')).to_be_visible()
        self.assert_layout(width, f'gameplan-notes-{width}-transcribing.png')
        self.parts.append({'partIndex': 2, 'source': 'recorder', 'status': 'done', 'chars': 42}); self.status = 'ready'; self.rev = 2
        self.page.clock.run_for(10500)
        # Every part is in: the notes are written up on their own, once.
        self.until(lambda: [body['action'] for body in self.posts] == ['draft'], 'the draft is asked for once')
        expect(self.status_line()).to_have_text('Notes ready to check and confirm')
        expect(panel.get_by_role('heading', name='Transcript and job notes')).to_be_visible()
        expect(panel.get_by_text('Check before confirming')).to_be_visible()
        expect(panel.get_by_text('Does the treadmill go or stay?')).to_be_visible()
        notes = panel.get_by_label(re.compile('^Job notes for the crew'))
        expect(notes).to_have_value('Clear the left bay first; the customer parks there tonight.\nStage donations on the driveway.')
        expect(panel.locator('.wtn-item')).to_have_count(2)
        panel.locator('summary', has_text='Transcript (2 parts)').click()
        expect(panel.locator('.wtn-transcript pre')).to_contain_text('Synthetic second half of the walkthrough.')
        self.assert_layout(width, f'gameplan-notes-{width}-draft.png')
        return panel

    def test_ipad_transcribing_then_the_draft_is_edited_and_confirmed_for_the_crew(self):
        self.start_page(IPAD)
        panel = self.draft_flow(820)
        # The estimator edits: one more note, the ladder count, a new item, and the couch line removed.
        notes = panel.get_by_label(re.compile('^Job notes for the crew'))
        notes.fill(notes.input_value() + '\nBring the long ladder for the rack.')
        panel.get_by_role('group', name='Item 2', exact=True).get_by_label('Qty').fill('1')
        panel.get_by_role('button', name='Add item').click()
        third = panel.get_by_role('group', name='Item 3', exact=True)
        third.get_by_label('Item', exact=True).fill('Lag screws and anchors'); third.get_by_label('What for').fill('Overhead rack')
        panel.get_by_label(re.compile('^Remove / donate')).fill('')
        # A background look while typing never replaces the edit.
        self.page.clock.run_for(10500)
        expect(notes).to_have_value(re.compile('Bring the long ladder for the rack.$'))
        panel.get_by_role('button', name='Confirm notes for the crew').click()
        expect(panel.get_by_role('status').filter(has_text='the crew lead and crew see these notes on the job.')).to_be_visible()
        expect(self.status_line()).to_have_text('Sent to the crew lead and crew')
        self.assertEqual(panel.inner_text().count('Sent to the crew lead and crew'), 1, 'said once, in the one-line status')
        confirm = self.posts[-1]
        self.assertEqual(confirm['action'], 'confirm'); self.assertEqual(confirm['expectedRevision'], 'n3')
        self.assertEqual(confirm['notes'], {'itemsNeeded': [{'name': 'Metal shelving unit', 'quantity': 2, 'reason': 'Back wall'}, {'name': 'Ladder', 'quantity': 1, 'reason': 'Overhead rack'}, {'name': 'Lag screws and anchors', 'quantity': None, 'reason': 'Overhead rack'}],
                                            'jobNotes': ['Clear the left bay first; the customer parks there tonight.', 'Stage donations on the driveway.', 'Bring the long ladder for the rack.'],
                                            'keepItems': ['Blue bicycle'], 'removeItems': [], 'access': ['Side door'], 'hazards': ['Mouse droppings by the freezer']})
        self.assertNotIn('openQuestions', confirm['notes'], 'open questions are for the estimator, never the crew')
        expect(panel.get_by_role('heading', name='Notes for the crew')).to_be_visible()
        expect(panel.get_by_text('2 × Metal shelving unit – Back wall')).to_be_visible()
        expect(panel.get_by_text('Lag screws and anchors – Overhead rack')).to_be_visible()
        self.assertIsNone(self.page.evaluate("localStorage.getItem('egc-wt-notes:confirm:wt-1')"), 'the confirm request leaves the iPad once answered')
        self.assert_layout(820, 'gameplan-notes-820-confirmed.png')
        # Edit and confirm again.
        panel.get_by_role('button', name='Edit notes').click()
        panel.get_by_label(re.compile('^Hazards')).fill('Mouse droppings by the freezer\nLoose shelf on the east wall')
        panel.get_by_role('button', name='Confirm changes for the crew').click()
        expect(panel.get_by_text('Loose shelf on the east wall')).to_be_visible()
        self.assertEqual([body['action'] for body in self.posts], ['draft', 'confirm', 'confirm'])
        self.assertNotEqual(self.posts[1]['requestId'], self.posts[2]['requestId'])

    def test_phone_a_changed_note_keeps_the_edit_and_asks_again_and_a_withdrawal_deletes_the_transcript(self):
        self.start_page(PHONE)
        panel = self.draft_flow(375)
        notes = panel.get_by_label(re.compile('^Job notes for the crew'))
        notes.fill('Only the left bay today.')
        self.conflict_next_confirm = True
        panel.get_by_role('button', name='Confirm notes for the crew').click()
        expect(panel.get_by_role('alert')).to_contain_text('These notes changed since you opened them')
        expect(notes).to_have_value('Only the left bay today.')
        saved = json.loads(self.page.evaluate("localStorage.getItem('egc-wt-notes:confirm:wt-1')"))
        self.assertEqual(saved['requestId'], self.posts[-1]['requestId'], 'an unanswered confirm keeps its request ID on the iPad')
        panel.get_by_role('button', name='Confirm notes for the crew').click()
        expect(self.status_line()).to_have_text('Sent to the crew lead and crew')
        self.assertEqual(self.posts[-1]['expectedRevision'], 'n4', 'the second try confirms against the notes as they are now')
        self.assertEqual(self.posts[-1]['notes']['jobNotes'], ['Only the left bay today.'])
        self.assert_layout(375)
        panel.get_by_role('button', name='Customer withdrew consent: delete the transcript').click()
        expect(panel).to_contain_text('The transcript was deleted.')
        self.assertEqual(len(self.dialogs), 1)
        self.assertEqual(self.posts[-1]['action'], 'withdraw')

    def test_without_a_recording_the_estimator_types_the_notes(self):
        self.start_page(PHONE); self.recording = 'declined'; self.jobs = 0
        self.open()
        expect(self.status_line()).to_have_text('No recording: type the notes for the crew')
        panel = self.open_panel()
        expect(panel).to_contain_text('This walkthrough has no recording.')
        panel.get_by_role('button', name='Type notes for the crew').click()
        panel.get_by_label(re.compile('^Job notes for the crew')).fill('Customer declined recording: clear the left bay only.')
        panel.get_by_role('button', name='Confirm notes for the crew').click()
        # Not booked yet (no job carries them): the panel says they go with the job, not that the crew sees them now.
        expect(panel.get_by_role('status').filter(has_text='They go to the crew lead and crew on the job when it is booked.')).to_be_visible()
        expect(self.status_line()).to_have_text('Confirmed: they go to the crew with the job')
        self.assertNotIn('Sent to the crew lead and crew', panel.inner_text())
        self.assertEqual([(body['action'], body['expectedRevision']) for body in self.posts], [('confirm', '')])
        self.assert_layout(375)

    def test_a_manager_reads_the_draft_but_only_the_estimator_confirms(self):
        self.start_page(IPAD); self.can_confirm = False
        self.parts = [{'partIndex': 1, 'source': 'recorder', 'status': 'done', 'chars': 41}, {'partIndex': 2, 'source': 'recorder', 'status': 'done', 'chars': 42}]
        self.expected = 2; self.status = 'drafted'; self.draft = copy.deepcopy(DRAFT); self.drafted_at = '2026-10-19T16:00:20.000Z'; self.rev = 3
        self.open()
        expect(self.status_line()).to_have_text('Draft notes: the estimator confirms them')
        panel = self.open_panel()
        expect(panel.get_by_text('Only the estimator who did this walkthrough confirms its notes for the crew.')).to_be_visible()
        expect(panel.get_by_role('button', name=re.compile('^Confirm'))).to_have_count(0)
        # Read-only: nothing to type into that could not be saved, and no rewrite that spends the estimator's write-ups.
        expect(panel.locator('textarea, input')).to_have_count(0)
        expect(panel.get_by_role('button', name=re.compile('Add item|Remove|Rewrite'))).to_have_count(0)
        expect(panel.get_by_text('2 × Metal shelving unit – Back wall')).to_be_visible()
        expect(panel.get_by_text('Clear the left bay first; the customer parks there tonight.')).to_be_visible()
        expect(panel.get_by_text('Does the treadmill go or stay?')).to_be_visible()
        self.assert_layout(820)
        self.assertEqual(self.posts, [], 'a ready draft is never written again')

    def test_the_panel_stays_one_line_so_the_next_step_starts_in_view_at_ipad_and_phone_sizes(self):
        for device, width in ((IPAD_PRO, 1024), (PHONE_390, 390)):
            self.start_page(device)
            self.parts = [{'partIndex': 1, 'source': 'recorder', 'status': 'done', 'chars': 41}, {'partIndex': 2, 'source': 'recorder', 'status': 'done', 'chars': 42}]
            self.expected = 2; self.status = 'drafted'; self.draft = copy.deepcopy(DRAFT); self.drafted_at = '2026-10-19T16:00:20.000Z'; self.rev = 3
            self.open()
            expect(self.status_line()).to_have_text('Notes ready to check and confirm')
            self.assertLess(self.panel().bounding_box()['height'], 100, f'{width}: closed, the panel is one line')
            # Opened, it shows the draft; moving to the next step closes it again so that step starts in view.
            self.open_panel()
            expect(self.panel().get_by_text('Check before confirming')).to_be_visible()
            self.page.evaluate("S.outcome = S.outcome || 'Park two cars'; S.whyNow = S.whyNow || 'Moving soon'; S.source = S.source || 'Referral'; S.name = S.name || 'Synthetic Customer'; S.phone = S.phone || '9705550100'; S.address = S.address || '100 Synthetic Lane'; render()")
            self.page.get_by_role('button', name='Continue').last.click()
            expect(self.page.locator('#screen h1')).to_have_text('Photograph the garage')
            self.page.clock.run_for(2000)
            self.until(lambda: self.page.evaluate('scrollY') == 0, f'{width}: the page is back at the top')
            expect(self.panel().locator('details.wtn-disclosure')).not_to_have_attribute('open', '')
            top = self.page.evaluate("Math.round(document.querySelector('#screen h1').getBoundingClientRect().bottom)")
            self.assertLess(top, self.page.evaluate('innerHeight') - 80, f'{width}: the step heading is in view after Continue')
            self.assert_layout(width, f'gameplan-notes-{width}-after-continue.png')
            self.context.close()
        self.start_page(IPAD)

    def test_audio_the_transcription_refused_says_why_instead_of_waiting_for_the_upload(self):
        self.start_page(IPAD)
        # OpenAI out of credits: the part is sent again from the iPad; the panel says so instead of "waiting for the upload".
        self.parts = [{'partIndex': 1, 'source': 'recorder', 'status': 'failed', 'chars': 0, 'errorCode': 'recording_unavailable'}]; self.expected = 1; self.status = 'transcribing'; self.rev = 1
        self.open()
        expect(self.status_line()).to_have_text('Transcribing: 0 of 1 part done')
        panel = self.open_panel()
        expect(panel).to_contain_text('Part 1: transcription is unavailable right now. The audio stays on the iPad and is sent again.')
        self.assertNotIn('Waiting for the walkthrough audio', panel.inner_text())
        # The audio could not be read: there is nothing to write up, so the estimator types the notes.
        self.parts = [{'partIndex': 1, 'source': 'recorder', 'status': 'failed', 'chars': 0, 'errorCode': 'recording_audio_unreadable'}]; self.status = 'failed'; self.rev = 2
        self.page.clock.run_for(10500)
        expect(self.status_line()).to_have_text('The audio could not be transcribed: type the notes')
        expect(panel).to_contain_text('Part 1 could not be transcribed: its audio could not be read for a transcript.')
        panel.get_by_role('button', name='Type notes for the crew').click()
        expect(panel.get_by_label(re.compile('^Job notes for the crew'))).to_be_visible()
        self.assertEqual(self.posts, [], 'nothing is written up from audio that was not transcribed')
        self.assert_layout(820)

    def test_new_audio_after_the_confirm_is_named_with_a_rewrite(self):
        self.start_page(IPAD)
        self.parts = [{'partIndex': 1, 'source': 'recorder', 'status': 'done', 'chars': 41}]; self.expected = 1; self.status = 'confirmed'; self.rev = 4
        self.draft = copy.deepcopy(DRAFT); self.drafted_at = '2026-10-19T16:00:20.000Z'
        self.confirmed = {**{key: value for key, value in DRAFT.items() if key != 'openQuestions'}, 'confirmedAt': '2026-10-19T16:05:00.000Z', 'confirmedBy': 'sales.rep'}
        self.confirmed_hash = '[Part 1]\nSynthetic first half of the walkthrough.'
        # A Voice Memos file lands after the confirm: the next read (the recorder's sync) shows it on the confirmed notes.
        self.parts.append({'partIndex': 2, 'source': 'import', 'status': 'done', 'chars': 42}); self.expected = 2
        self.open()
        expect(self.status_line()).to_have_text('New audio arrived after these notes were confirmed')
        panel = self.open_panel()
        expect(panel.get_by_text('New audio arrived after these notes were confirmed.', exact=False)).to_be_visible()
        panel.get_by_role('button', name='Rewrite from the transcript').click()
        self.until(lambda: [body['action'] for body in self.posts] == ['draft'], 'the rewrite is asked for')
        expect(panel.get_by_text('New notes were written from the latest audio. Confirm them to update what the crew sees.')).to_be_visible()
        panel.get_by_role('button', name='Confirm changes for the crew').click()
        expect(self.status_line()).to_have_text('Sent to the crew lead and crew')
        self.assert_layout(820)

    def test_switched_off_or_before_the_outcome_the_panel_stays_hidden(self):
        self.start_page(IPAD); self.enabled = False
        self.open()
        self.until(lambda: self.gets >= 1, 'the panel asked once')
        expect(self.panel()).to_be_hidden()
        self.context.close()
        self.start_page(IPAD); self.outcome = None
        self.page.goto(self.url + '/crew/gameplan.html?walkthroughId=wt-1')
        expect(self.page.locator('#wt-recorder')).to_contain_text('Started')
        self.until(lambda: self.gets >= 1, 'the panel asked')
        expect(self.panel()).to_be_hidden()
        self.page.wait_for_timeout(500)
        asked = self.gets
        self.page.clock.run_for(30000)
        self.assertEqual(self.gets, asked, 'no polling while nothing is on its way')


if __name__ == '__main__':
    unittest.main(verbosity=2)
