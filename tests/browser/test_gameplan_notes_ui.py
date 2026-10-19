"""EGC_WALKTHROUGH_NOTES: the walkthrough notes panel (crew/gameplan-notes.js) on the real crew/gameplan.html at 375x812 and
iPad 820x1180.

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
        self.conflict_next_confirm = False; self.dialogs = []
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
        done = [part for part in self.parts if part['status'] == 'done']
        return {'ok': True, 'enabled': True, 'visitId': 'wt-1', 'status': self.status, 'revision': f'n{self.rev}' if self.rev else '', 'canConfirm': self.can_confirm, 'canDraft': True,
                'outcome': {'outcome': self.outcome, 'recordingStatus': self.recording} if self.outcome else None, 'parts': copy.deepcopy(self.parts), 'expectedParts': self.expected,
                'complete': bool(done) and (not self.expected or len(done) >= self.expected), 'transcript': TRANSCRIPT if len(done) >= 2 else ('[Part 1]\nSynthetic first half of the walkthrough.' if done else ''),
                'transcriptMissing': 0, 'draft': copy.deepcopy(self.draft), 'draftedAt': self.drafted_at, 'draftStale': False, 'draftsLeft': 5, 'confirmed': copy.deepcopy(self.confirmed)}

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
        if body['action'] == 'draft':
            self.draft = copy.deepcopy(DRAFT); self.drafted_at = '2026-10-19T16:00:20.000Z'; self.status = 'drafted'; self.rev += 1
        elif body['action'] == 'confirm':
            if self.conflict_next_confirm:
                self.conflict_next_confirm = False; self.rev += 1
                return self.json(route, 409, {'ok': False, 'code': 'walkthrough_notes_changed', 'error': 'These notes changed since you opened them. Review them again before confirming.'})
            if body['expectedRevision'] != (f'n{self.rev}' if self.rev else ''):
                return self.json(route, 409, {'ok': False, 'code': 'walkthrough_notes_changed', 'error': 'These notes changed since you opened them. Review them again before confirming.'})
            self.confirmed = {**body['notes'], 'confirmedAt': '2026-10-19T16:05:00.000Z', 'confirmedBy': 'sales.rep'}; self.status = 'confirmed'; self.rev += 1
        elif body['action'] == 'withdraw':
            self.parts = []; self.expected = None; self.draft = None; self.status = 'withdrawn'; self.rev += 1
        return self.json(route, 200, self.view())

    def open(self):
        self.page.goto(self.url + '/crew/gameplan.html?walkthroughId=wt-1')
        expect(self.page.locator('#wt-recorder')).to_contain_text('Outcome recorded: Quote to follow')

    def panel(self):
        return self.page.locator('#wt-notes')

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
        expect(panel).to_contain_text('Transcribing: 1 of 2 parts done.')
        expect(panel.locator('progress')).to_be_visible()
        expect(panel.get_by_role('button', name='Write up notes now')).to_be_visible()
        self.assert_layout(width, f'gameplan-notes-{width}-transcribing.png')
        self.parts.append({'partIndex': 2, 'source': 'recorder', 'status': 'done', 'chars': 42}); self.status = 'ready'; self.rev = 2
        self.page.clock.run_for(10500)
        # Every part is in: the notes are written up on their own, once.
        self.until(lambda: [body['action'] for body in self.posts] == ['draft'], 'the draft is asked for once')
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
        expect(panel).to_contain_text('Sent to the crew lead and crew')
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
        expect(panel).to_contain_text('Sent to the crew lead and crew')
        self.assertEqual(self.posts[-1]['expectedRevision'], 'n4', 'the second try confirms against the notes as they are now')
        self.assertEqual(self.posts[-1]['notes']['jobNotes'], ['Only the left bay today.'])
        self.assert_layout(375)
        panel.get_by_role('button', name='Customer withdrew consent: delete the transcript').click()
        expect(panel).to_contain_text('The transcript was deleted.')
        self.assertEqual(len(self.dialogs), 1)
        self.assertEqual(self.posts[-1]['action'], 'withdraw')

    def test_without_a_recording_the_estimator_types_the_notes(self):
        self.start_page(PHONE); self.recording = 'declined'
        self.open()
        panel = self.panel()
        expect(panel).to_contain_text('This walkthrough has no recording.')
        panel.get_by_role('button', name='Type notes for the crew').click()
        panel.get_by_label(re.compile('^Job notes for the crew')).fill('Customer declined recording: clear the left bay only.')
        panel.get_by_role('button', name='Confirm notes for the crew').click()
        expect(panel).to_contain_text('Sent to the crew lead and crew')
        self.assertEqual([(body['action'], body['expectedRevision']) for body in self.posts], [('confirm', '')])
        self.assert_layout(375)

    def test_a_manager_reads_the_draft_but_only_the_estimator_confirms(self):
        self.start_page(IPAD); self.can_confirm = False
        self.parts = [{'partIndex': 1, 'source': 'recorder', 'status': 'done', 'chars': 41}, {'partIndex': 2, 'source': 'recorder', 'status': 'done', 'chars': 42}]
        self.expected = 2; self.status = 'drafted'; self.draft = copy.deepcopy(DRAFT); self.drafted_at = '2026-10-19T16:00:20.000Z'; self.rev = 3
        self.open()
        panel = self.panel()
        expect(panel.get_by_text('Only the estimator who did this walkthrough confirms its notes for the crew.')).to_be_visible()
        expect(panel.get_by_role('button', name=re.compile('^Confirm'))).to_have_count(0)
        self.assertEqual(self.posts, [], 'a ready draft is never written again')

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
