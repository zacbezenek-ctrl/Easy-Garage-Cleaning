"""FUN-06: the gameplan walkthrough recorder on the real crew/gameplan.html at 375x812 and iPad 820x1180.

Isolated fixtures only: a fake Firebase SDK, a FUN-05 walkthrough-visit stand-in, a recording-upload stand-in,
a fake MediaRecorder and microphone, and Playwright's installed clock. Every other host is refused. Like FUN-05 with
EGC_OFFLINE_CLOCK_ENABLED unset, the stand-in refuses a Start without the timecard skip when the rep is clocked out,
or when its device time is more than two minutes older than the server clock (which follows run_for)."""
import datetime, json, os, pathlib, re, threading, time, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime.datetime(2026, 9, 22, 15, tzinfo=datetime.timezone.utc)  # 09:00 in Denver
PHONE = {'viewport': {'width': 375, 'height': 812}, 'is_mobile': True, 'has_touch': True}
IPAD = {'viewport': {'width': 820, 'height': 1180}, 'is_mobile': True, 'has_touch': True}
LANDSCAPE = {'viewport': {'width': 1180, 'height': 820}, 'is_mobile': True, 'has_touch': True}

FAKE_FIREBASE = """
window.firebase = (() => {
  const rows = () => window.__wtRows || [];
  const doc = id => ({ async get() { const row = rows().find(item => item.id === id); return { exists: Boolean(row), id, data: () => row ? { ...row } : undefined }; } });
  const query = { async get() { return { docs: rows().map(row => ({ id: row.id, data: () => ({ ...row }) })) }; } };
  return { apps: [], initializeApp(config) { this.apps.push(config); return {}; },
    auth: () => ({ signInWithCustomToken: async () => ({}), signOut: async () => {} }),
    firestore: () => ({ collection: () => ({ doc, where: () => query }) }) };
})();
"""

# Runs before the page: a MediaRecorder that emits a chunk per timeslice on the page clock, a microphone,
# a wake lock, a controllable visibility state, and a log of every upload's form fields.
FAKES = """
(() => {
  window.__wtRows = [{ id: 'wt-1', type: 'walkthrough', status: 'scheduled', customer: 'Synthetic Customer', phone: '9705550100', address: '100 Synthetic Lane', date: '2026-09-22', time: '09:00' }];
  const rec = window.__rec = { recorders: [], gum: 0, deny: false, chunkBytes: 1000, wake: 0, uploads: [] };
  class FakeMediaRecorder {
    static isTypeSupported(type) { return type === 'audio/mp4'; }
    constructor(stream, options = {}) { Object.assign(this, { stream, options, mimeType: options.mimeType || 'audio/mp4', state: 'inactive' }); rec.recorders.push(this); }
    start(slice) { this.state = 'recording'; this.slice = slice; this.timer = setInterval(() => this.emit(rec.chunkBytes), slice); }
    emit(bytes) { const data = new Blob([new Uint8Array(bytes).fill(rec.recorders.indexOf(this) + 1)], { type: this.mimeType }); if (this.ondataavailable) this.ondataavailable({ data }); }
    requestData() {}
    stop() { if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError'); this.state = 'inactive'; clearInterval(this.timer); setTimeout(() => { this.emit(100); if (this.onstop) this.onstop(); }, 0); }
  }
  window.MediaRecorder = FakeMediaRecorder;
  const track = () => { const item = new EventTarget(); Object.assign(item, { kind: 'audio', readyState: 'live', muted: false, stop() { item.readyState = 'ended'; } }); return item; };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { async getUserMedia() { rec.gum++; if (rec.deny) throw new DOMException('Synthetic refusal', 'NotAllowedError'); const audio = track(); return { getAudioTracks: () => [audio], getTracks: () => [audio] }; } } });
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { async request() { rec.wake++; const lock = new EventTarget(); lock.release = async () => {}; return lock; } } });
  let hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  window.__setHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (body instanceof FormData) { const audio = body.get('audio'); rec.uploads.push({ requestId: body.get('requestId'), portalJobId: body.get('portalJobId'), name: audio && audio.name, type: audio && audio.type, size: audio && audio.size }); }
    return send.call(this, body);
  };
  window.__chunkCount = () => new Promise(resolve => { const open = indexedDB.open('egc-walkthrough-recorder'); open.onsuccess = () => { const db = open.result; if (!db.objectStoreNames.contains('chunks')) { resolve(0); return; } const count = db.transaction('chunks').objectStore('chunks').count(); count.onsuccess = () => resolve(count.result); }; open.onerror = () => resolve(-1); });
})();
"""

SECOND = "window.__wtRows.push({ id: 'wt-2', type: 'walkthrough', status: 'scheduled', customer: 'Synthetic Neighbour', phone: '9705550101', address: '102 Synthetic Lane', date: '2026-09-22', time: '11:00' })"

# At the bottom of the page: the plan controls the fixed footer (with the recording bar) covers.
COVERED = """() => {
  window.scrollTo(0, document.documentElement.scrollHeight);
  const footer = document.querySelector('footer.bottom').getBoundingClientRect();
  const controls = [...document.querySelectorAll('#screen button, #screen input, #screen select, #screen textarea, #screen a[href]')].filter(el => el.offsetParent);
  const covered = controls.filter(el => el.getBoundingClientRect().bottom > footer.top + 1).map(el => (el.textContent || el.name || el.id || el.type || '').trim().slice(0, 40));
  return { viewport: innerHeight, footer: Math.round(footer.height), covered, controls: controls.length };
}"""

# Records every moment #wt-recorder is shown, so a skeleton or error that flashes and hides again is caught.
WATCH_RECORDER = """
window.__wtShown = [];
new MutationObserver(records => { for (const record of records) { const node = record.target; if (node.id === 'wt-recorder' && !node.hidden) window.__wtShown.push(node.textContent.slice(0, 120)); } })
  .observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
"""

# Safari before iPadOS 15.4: no Web Locks.
NO_WEB_LOCKS = "Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });"
UPDATE_TEXT = 'Recording in the Hub needs iPadOS 15.4 or later. Update this iPad in Settings > General > Software Update, or record in Voice Memos and add the file here.'

# Counts what the recorder takes from the browser: the tab's Web Lock, persistent storage, a BroadcastChannel and the
# leave-page prompt (a beforeunload listener).
COUNT_ENGAGED = """
window.__wtEngaged = { locks: 0, persist: 0, channels: 0, leave: 0 };
{ const add = window.addEventListener.bind(window); window.addEventListener = (type, ...rest) => { if (type === 'beforeunload') window.__wtEngaged.leave++; return add(type, ...rest); }; }
if (navigator.locks) { const request = navigator.locks.request.bind(navigator.locks); navigator.locks.request = (...args) => { window.__wtEngaged.locks++; return request(...args); }; }
if (navigator.storage) for (const name of ['persist', 'persisted']) { const fn = navigator.storage[name] && navigator.storage[name].bind(navigator.storage); if (fn) navigator.storage[name] = () => { window.__wtEngaged.persist++; return fn(); }; }
if (window.BroadcastChannel) { const Base = window.BroadcastChannel; window.BroadcastChannel = class extends Base { constructor(name) { super(name); window.__wtEngaged.channels++; } }; }
"""


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class GameplanRecorderTests(unittest.TestCase):
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

    def start_page(self, device=PHONE):
        self.context = self.browser.new_context(timezone_id='Asia/Tokyo', **device)
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        self.errors = []; self.posts = []; self.gets = 0; self.upload_calls = 0; self.upload_refused = False
        self.post_offline = False; self.upload_offline = False; self.get_offline = False; self.get_status = None
        self.enabled = True; self.revision = 1; self.receipts = {}; self.accepted = []; self.server_now = NOW
        self.shift = {'available': True, 'clockedIn': True, 'onBreak': False, 'needsReview': False, 'current': None}
        self.visit = {'id': 'wt-1', 'revision': 'r1', 'type': 'walkthrough', 'customer': 'Synthetic Customer', 'date': '2026-09-22', 'time': '09:00', 'status': 'scheduled',
                      'walkthroughVisit': None, 'walkthroughOutcome': None, 'walkthroughCompletedAt': None, 'rebookPending': False, 'previousOccurrences': 0}
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.clock.install(time=NOW)
        self.page.add_init_script(FAKES)
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()

    def json(self, route, status, body):
        route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(body))

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
        if url.path == '/api/walkthrough-visit':
            return self.visit_api(route, request, url)
        if url.path == '/api/operations-recordings':
            self.upload_calls += 1
            if self.upload_offline:
                return route.abort('internetdisconnected')
            if self.upload_refused:
                return self.json(route, 409, {'error': 'recording_customer_link_missing'})
            return self.json(route, 202, {'ok': True, 'recording': {'id': f'recording-{self.upload_calls}', 'status': 'uploaded'}})
        if url.path.startswith('/api/'):
            return self.json(route, 404, {'ok': False, 'error': 'Not part of this fixture.'})
        route.continue_()

    def run_for(self, ms):
        self.page.clock.run_for(ms); self.server_now += datetime.timedelta(milliseconds=ms)

    def visit_api(self, route, request, url):
        if request.method == 'GET':
            self.gets += 1
            if self.get_offline:
                return route.abort('internetdisconnected')
            if self.get_status:
                return self.json(route, self.get_status, {'ok': False, 'code': 'walkthrough_visit_not_found', 'error': 'This walkthrough visit could not be found. Refresh your schedule.'})
            query = parse_qs(url.query); self.assertEqual(list(query), ['visitId'])
            if not self.enabled:  # like FUN-05: switched off, the GET reads and returns nothing else
                return self.json(route, 200, {'ok': True, 'enabled': False})
            visit = self.visit if query['visitId'] == ['wt-1'] else {**self.visit, 'id': query['visitId'][0], 'revision': 'r1', 'walkthroughVisit': None, 'walkthroughOutcome': None}
            return self.json(route, 200, {'ok': True, 'authority': 'employee_hub', 'enabled': self.enabled, 'visit': visit, 'openVisit': None, 'shift': self.shift, 'viewer': {'id': 'sales.rep', 'manager': True}})
        body = request.post_data_json; self.posts.append(body)
        self.assertEqual(request.headers.get('content-type'), 'application/json')
        if self.post_offline:
            return route.abort('internetdisconnected')
        saved = self.receipts.get(body['requestId'])
        if saved is not None:
            self.assertEqual(saved, body, 'a retried request is sent unchanged')
            return self.json(route, 200, {'ok': True, 'requestId': body['requestId'], 'replayed': True, 'visit': self.visit})
        if body['expectedRevision'] != self.visit['revision']:
            return self.json(route, 409, {'ok': False, 'code': 'walkthrough_visit_revision_conflict', 'error': 'This walkthrough changed.'})
        if body['action'] == 'start' and not body.get('skipTimecard'):
            if not self.shift['clockedIn']:
                return self.json(route, 409, {'ok': False, 'code': 'walkthrough_visit_clock_in_required', 'error': 'Clock in before starting this walkthrough so its time is recorded, or start it without a timecard.', 'details': {'clockInRequired': True, 'timecard': True}})
            if datetime.datetime.fromisoformat(body['deviceAt'].replace('Z', '+00:00')) < self.server_now - datetime.timedelta(minutes=2):
                return self.json(route, 409, {'ok': False, 'code': 'walkthrough_visit_time_invalid', 'error': 'Offline clock times are not enabled for this timecard. You can also record this walkthrough without changing your timecard.', 'details': {'timecard': True, 'deviceTime': True}})
        if body['action'] == 'start':
            self.visit['walkthroughVisit'] = {'startedAt': body['deviceAt'], 'startedBy': 'sales.rep', 'recordingStatus': body['recordingStatus']}
        else:
            self.visit['walkthroughOutcome'] = {'outcome': body.get('outcome', 'customer_no_show'), 'recordingStatus': body.get('recordingStatus'), 'finishedAt': body['deviceAt']}
        self.revision += 1; self.visit['revision'] = f'r{self.revision}'; self.receipts[body['requestId']] = body; self.accepted.append(body)
        return self.json(route, 200, {'ok': True, 'requestId': body['requestId'], 'replayed': False, 'visit': self.visit})

    def open(self):
        self.page.goto(self.url + '/crew/gameplan.html?walkthroughId=wt-1')
        expect(self.page.locator('#wt-recorder').get_by_role('heading', name='Synthetic Customer')).to_be_visible()

    def uploads(self):
        return self.page.evaluate('window.__rec.uploads')

    def until(self, check, message, timeout=8, page=None):
        deadline = time.monotonic() + timeout
        while not check():
            if time.monotonic() > deadline:
                self.fail(message)
            (page or self.page).wait_for_timeout(50)

    def until_page(self, page, expression, message, arg=None, timeout=8):
        # For a check that returns a promise (IndexedDB, Web Locks). page.wait_for_function never waits for one: a promise is
        # truthy, so its first poll returns whatever the promise resolves to, even false. page.evaluate awaits the promise.
        self.until(lambda: page.evaluate(expression, arg), message, timeout, page)

    def start_recording(self):
        recorder = self.page.locator('#wt-recorder')
        recorder.get_by_role('button', name='Start walkthrough').click()
        expect(recorder.get_by_text('Is it OK if I record our walkthrough')).to_be_visible()
        recorder.get_by_role('button', name='Recording OK').click()
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Recording')

    def finish(self, outcome='Quote to follow'):
        self.page.locator('.wt-bar').get_by_role('button', name='Finish').click()
        panel = self.page.locator('#wt-recorder')
        expect(panel.get_by_role('heading', name='Finish walkthrough')).to_be_visible()
        panel.get_by_role('radio', name=outcome).click()
        return panel

    def assert_layout(self, width, shot):
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
        small = self.page.evaluate("""[...document.querySelectorAll('#wt-recorder button, #wt-recorder a.wt-btn, .wt-bar button')].filter(el => el.offsetParent).map(el => [el.textContent.trim(), Math.round(el.getBoundingClientRect().height)]).filter(([, height]) => height < 44)""")
        self.assertEqual(small, [], 'every recorder control is at least 44px tall')
        stray = self.page.evaluate("""[...document.querySelectorAll('#wt-recorder, .wt-bar')].map(el => el.innerText).join(' ').match(/\\b(null|undefined|NaN)\\b/g)""")
        self.assertIsNone(stray, 'no stray null/undefined text in the recorder')
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out / shot), full_page=True)

    def test_ipad_recording_rolls_over_at_twenty_minutes_and_uploads_parts_in_order(self):
        self.start_page(IPAD); self.open()
        self.assert_layout(820, 'gameplan-recorder-ipad-start.png')
        self.start_recording()
        expect(self.page.locator('.wt-dot.on')).to_be_visible()
        self.page.wait_for_function('window.__rec.recorders.length === 1 && window.__rec.wake >= 1')
        # The Start goes out after the recorder starts (and a fresh GET): wait for it rather than race it.
        self.until(lambda: self.posts, 'the Start is sent')
        self.assertEqual([body['action'] for body in self.posts], ['start'])
        self.assertEqual(self.posts[0]['recordingStatus'], 'recorded')
        tapped = datetime.datetime.fromisoformat(self.posts[0]['deviceAt'].replace('Z', '+00:00'))
        self.assertTrue(NOW <= tapped < NOW + datetime.timedelta(minutes=1), 'Start carries the tap time from the page clock')
        self.assertEqual(self.posts[0]['actorId'], 'sales.rep'); self.assertNotIn('skipTimecard', self.posts[0])
        self.run_for(20 * 60 * 1000 + 5000)
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Part 2')
        self.assertEqual(self.page.evaluate('window.__rec.gum'), 1, 'one microphone stream across parts')
        self.assert_layout(820, 'gameplan-recorder-ipad-recording.png')
        panel = self.finish()
        panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        self.page.wait_for_function('window.__rec.uploads.length === 2')
        self.assertEqual([body['action'] for body in self.posts], ['start', 'finish'])
        self.assertEqual(self.posts[1]['outcome'], 'quote_to_follow'); self.assertEqual(self.posts[1]['recordingStatus'], 'recorded'); self.assertNotIn('typedNotes', self.posts[1])
        first, second = self.uploads()
        self.assertEqual([first['name'], second['name']], ['walkthrough-wt-1-part-1.m4a', 'walkthrough-wt-1-part-2.m4a'])
        self.assertTrue(all(item['type'] == 'audio/mp4' and item['portalJobId'] == 'wt-1' for item in (first, second)))
        self.assertNotEqual(first['requestId'], second['requestId'])
        self.assertGreater(first['size'], 1_000_000); self.assertLess(first['size'], 24 * 1024 * 1024)
        self.until_page(self.page, 'window.__chunkCount().then(count => count === 0)', 'the uploaded audio left the iPad')
        expect(self.page.locator('.wt-badge')).to_have_count(0)
        expect(self.page.locator('.wt-bar')).to_be_hidden()

    def test_phone_lost_connection_keeps_audio_and_sends_the_same_request_ids_when_the_signal_returns(self):
        self.start_page(PHONE); self.open()
        self.post_offline = True; self.upload_offline = True
        self.start_recording()
        self.run_for(10000)
        panel = self.finish()
        panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_role('status')).to_contain_text('Outcome saved on this iPad')
        badge = self.page.get_by_role('button', name='Unsent recordings on this iPad · 1')
        expect(badge).to_be_visible()
        badge.click()
        expect(self.page.locator('.wt-unsent-list')).to_contain_text('Start: saved on this iPad, sending when the signal allows')
        expect(self.page.locator('.wt-part-state').first).to_have_text('Waiting for signal')
        self.until(lambda: self.posts, 'the Start is tried while the connection is down')
        lost_start = self.posts[0]['requestId']
        self.assertEqual(self.upload_calls, 0, 'audio waits until the saved outcome is sent in order')
        self.assertGreater(self.page.evaluate('window.__chunkCount()'), 0)
        self.assert_layout(375, 'gameplan-recorder-phone-offline.png')
        # The visit API comes back; the upload drops mid-way once.
        self.post_offline = False
        self.page.evaluate("dispatchEvent(new Event('online'))")
        self.page.wait_for_function('window.__rec.uploads.length >= 1')
        expect(self.page.locator('.wt-unsent-list')).to_contain_text('Waiting for signal')
        starts = [body for body in self.posts if body['action'] == 'start']
        self.assertEqual({body['requestId'] for body in starts}, {lost_start}, 'the Start keeps its request ID')
        lost_upload = self.uploads()[0]['requestId']
        self.upload_offline = False
        self.page.evaluate("dispatchEvent(new Event('online'))")
        expect(self.page.locator('.wt-badge')).to_have_count(0)
        expect(self.page.locator('#wt-recorder').get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        self.assertEqual({item['requestId'] for item in self.uploads()}, {lost_upload}, 'the upload retry keeps the request ID')
        self.assertEqual(len(self.receipts), 2)
        self.until_page(self.page, 'window.__chunkCount().then(count => count === 0)', 'the uploaded audio left the iPad')

    def test_declined_consent_records_nothing_uploads_nothing_and_requires_three_typed_notes(self):
        self.start_page(PHONE); self.open()
        recorder = self.page.locator('#wt-recorder')
        recorder.get_by_role('button', name='Start walkthrough').click()
        recorder.get_by_role('button', name='Customer declined recording').click()
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Walkthrough (not recorded)')
        self.until(lambda: len(self.posts) == 1, 'the declined Start is sent')
        self.assertEqual(self.page.evaluate('window.__rec.gum'), 0, 'the microphone is never opened')
        panel = self.finish()
        expect(panel.get_by_role('group', name='Three short notes (no recording)')).to_be_visible()
        expect(panel.get_by_text('Customer withdrew consent')).to_have_count(0)
        panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_role('alert')).to_contain_text('type the three short notes')
        sizes = self.page.evaluate("[...document.querySelectorAll('#wt-recorder textarea, #wt-recorder select')].map(el => getComputedStyle(el).fontSize)")
        self.assertTrue(sizes and all(size == '16px' for size in sizes), sizes)
        notes = ['Synthetic: wants the two-car garage back', 'Synthetic: keep the workbench', 'Synthetic: side gate code from the office']
        for label, note in zip(['What the customer wants done', 'What stays, what goes, and anything to protect', 'Access, hazards and anything special'], notes):
            panel.get_by_label(label).fill(note)
        self.assert_layout(375, 'gameplan-recorder-phone-declined.png')
        panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        self.assertEqual([(body['action'], body['recordingStatus']) for body in self.posts], [('start', 'declined'), ('finish', 'declined')])
        self.assertEqual(self.posts[1]['typedNotes'], notes)
        self.run_for(5000)
        self.assertEqual(self.upload_calls, 0, 'nothing is uploaded for a customer who declined')
        self.assertEqual(self.uploads(), [])

    def test_screen_lock_warns_and_the_recording_continues_in_a_new_part(self):
        self.start_page(IPAD); self.open(); self.start_recording()
        self.run_for(30000)
        self.page.evaluate('window.__setHidden(true)')
        self.run_for(90000)
        self.page.evaluate('window.__setHidden(false)')
        warning = self.page.locator('.wt-warn')
        expect(warning).to_contain_text('The screen locked or Safari left the foreground')
        expect(warning).to_contain_text('away 1:30')
        expect(warning).to_contain_text('9:02')  # Denver wall time, on a Tokyo iPad clock
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Part 2')
        self.assertEqual(self.page.evaluate('window.__rec.wake'), 2, 'the wake lock is taken again on return')
        self.assert_layout(820, 'gameplan-recorder-ipad-interrupted.png')

    def test_a_reload_mid_recording_keeps_the_saved_audio_and_resumes_in_a_new_part(self):
        self.start_page(PHONE); self.open(); self.start_recording()
        self.run_for(6000)
        self.until_page(self.page, 'window.__chunkCount().then(count => count >= 5)', 'five seconds of audio are saved on the iPad')
        self.page.on('dialog', lambda dialog: dialog.accept())  # the recording page asks before it is closed
        self.page.reload()
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Recording paused')
        expect(self.page.locator('.wt-warn')).to_contain_text('The page closed while recording')
        self.page.locator('.wt-bar').get_by_role('button', name='Resume').click()
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Part 2')
        self.run_for(3000)
        panel = self.finish(); panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        self.page.wait_for_function('window.__rec.uploads.length === 2')
        self.assertEqual([item['name'] for item in self.uploads()], ['walkthrough-wt-1-part-1.m4a', 'walkthrough-wt-1-part-2.m4a'])
        self.assertGreaterEqual(self.uploads()[0]['size'], 5000, 'the audio saved before the reload is uploaded')
        self.assertEqual([body['action'] for body in self.posts], ['start', 'finish'], 'the reload did not start the walkthrough twice')
        self.until_page(self.page, 'window.__chunkCount().then(count => count === 0)', 'the uploaded audio left the iPad')

    def test_without_web_locks_the_hub_records_nothing_and_a_voice_memo_is_added_here(self):
        # Safari before iPadOS 15.4 (no Web Locks): the recorder takes nothing (no tab lock, persistent storage or leave
        # prompt) and never opens the microphone. The card says to update the iPad or record in Voice Memos; the walkthrough
        # starts without Hub audio and belongs to no tab, so a reload keeps it this page's to finish, and its Voice Memos file
        # is added at Finish and uploaded.
        self.start_page(IPAD); self.page.add_init_script(NO_WEB_LOCKS); self.page.add_init_script(COUNT_ENGAGED); self.open()
        self.assertFalse(self.page.evaluate('Boolean(navigator.locks)'), 'no Web Locks, as before iPadOS 15.4')
        recorder = self.page.locator('#wt-recorder')
        expect(recorder.get_by_role('note')).to_have_text(UPDATE_TEXT)
        self.assert_layout(820, 'gameplan-recorder-ipad-no-web-locks.png')
        recorder.get_by_role('button', name='Start walkthrough').click()
        expect(recorder.get_by_role('button', name='Recording OK', exact=True)).to_have_count(0)
        recorder.get_by_role('button', name='Recording OK: record in Voice Memos').click()
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Walkthrough (not recorded)')
        self.until(lambda: len(self.posts) == 1, 'the Start is sent')
        self.assertEqual(self.posts[0]['recordingStatus'], 'failed_device')
        self.assertEqual(self.page.evaluate('window.__rec.gum'), 0, 'the microphone is never opened')
        self.assertEqual(self.page.evaluate('window.__wtEngaged'), {'locks': 0, 'persist': 0, 'channels': 0, 'leave': 0})
        # Pull to refresh: no leave prompt, and the walkthrough is still this page's to finish (never "Open in another tab").
        dialogs = []
        self.page.on('dialog', lambda dialog: (dialogs.append(dialog.type), dialog.accept()))
        self.page.reload()
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Walkthrough (not recorded)')
        expect(self.page.locator('.wt-bar')).not_to_contain_text('Open in another tab')
        self.assertEqual(dialogs, [])
        self.run_for(10 * 60 * 1000)
        panel = self.finish()
        panel.locator('input[type=file]').set_input_files(files=[{'name': 'New Recording 8.m4a', 'mimeType': 'audio/x-m4a', 'buffer': b'\x00\x00\x00\x20ftypM4A synthetic audio'}])
        expect(panel.get_by_role('status')).to_contain_text('New Recording 8.m4a added')
        panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        self.page.wait_for_function('window.__rec.uploads.length === 1')
        memo = self.uploads()[0]
        self.assertEqual((memo['name'], memo['type'], memo['portalJobId']), ('walkthrough-wt-1-part-1.m4a', 'audio/mp4', 'wt-1'))
        self.assertEqual([(body['action'], body['recordingStatus']) for body in self.posts], [('start', 'failed_device'), ('finish', 'recorded')])
        self.until_page(self.page, 'window.__chunkCount().then(count => count === 0)', 'the uploaded audio left the iPad')
        self.assertEqual(self.page.evaluate('window.__rec.gum'), 0)
        self.assertEqual(self.page.evaluate('window.__wtEngaged'), {'locks': 0, 'persist': 0, 'channels': 0, 'leave': 0})

    def test_clock_in_prompt_microphone_refusal_and_a_voice_memo_after_the_outcome(self):
        self.start_page(PHONE); self.shift['clockedIn'] = False
        self.open()
        self.page.evaluate('window.__rec.deny = true')
        recorder = self.page.locator('#wt-recorder')
        recorder.get_by_role('button', name='Start walkthrough').click()
        expect(recorder.get_by_role('alert')).to_contain_text('You are not clocked in')
        expect(recorder.get_by_role('link', name='Open time clock')).to_have_attribute('href', '/employee?view=my_day')
        recorder.get_by_role('button', name='Start without timecard').click()
        recorder.get_by_role('button', name='Recording OK').click()
        expect(recorder.get_by_role('alert')).to_contain_text('Microphone access is blocked')
        recorder.get_by_role('button', name='Continue without recording').click()
        expect(self.page.locator('.wt-bar-text')).to_contain_text('not recorded')
        self.until(lambda: len(self.posts) == 1, 'the Start is sent')
        self.assertEqual(self.page.evaluate('window.__rec.gum'), 1)
        self.assertEqual(self.posts[0]['recordingStatus'], 'failed_device'); self.assertIs(self.posts[0]['skipTimecard'], True)
        panel = self.finish('Not interested')
        panel.get_by_label('Reason').select_option('price')
        panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_text('Outcome recorded: Not interested')).to_be_visible()
        self.assertEqual({key: self.posts[1].get(key) for key in ('outcome', 'reasonCode', 'recordingStatus')}, {'outcome': 'not_interested', 'reasonCode': 'price', 'recordingStatus': 'failed_device'})
        # Recorded in Voice Memos instead: the .m4a uploads for this walkthrough as audio/mp4.
        self.page.locator('#wt-recorder input[type=file]').set_input_files(files=[{'name': 'New Recording 7.m4a', 'mimeType': 'audio/x-m4a', 'buffer': b'\x00\x00\x00\x20ftypM4A synthetic audio'}])
        self.page.wait_for_function('window.__rec.uploads.length === 1')
        memo = self.uploads()[0]
        self.assertEqual((memo['name'], memo['type'], memo['portalJobId']), ('walkthrough-wt-1-part-1.m4a', 'audio/mp4', 'wt-1'))
        expect(self.page.locator('.wt-badge')).to_have_count(0)
        self.assertIn('.m4a', self.page.locator('#wt-recorder input[type=file]').get_attribute('accept'))

    def test_a_refused_upload_keeps_the_audio_with_retry_and_save_a_copy(self):
        self.start_page(PHONE); self.open(); self.upload_refused = True
        self.start_recording(); self.run_for(5000)
        panel = self.finish(); panel.get_by_role('button', name='Save outcome').click()
        badge = self.page.get_by_role('button', name='Unsent recordings on this iPad · 1')
        expect(badge).to_be_visible(); badge.click()
        expect(self.page.locator('.wt-unsent-list')).to_contain_text('needs an exact customer link')
        expect(self.page.get_by_role('button', name='Save a copy')).to_be_visible()
        self.assertGreater(self.page.evaluate('window.__chunkCount()'), 0, 'refused audio stays on the iPad')
        self.upload_refused = False
        self.page.get_by_role('button', name='Retry upload').click()
        expect(self.page.locator('.wt-badge')).to_have_count(0)
        self.assertEqual(len({item['requestId'] for item in self.uploads()}), 1)
        self.assert_layout(375, 'gameplan-recorder-phone-retry.png')

    def test_an_offline_start_the_timecard_refuses_shows_the_choice_then_start_and_finish_go_out(self):
        self.start_page(PHONE); self.open()
        self.post_offline = True
        self.start_recording()
        self.run_for(5 * 60 * 1000)  # five minutes in a garage without signal
        panel = self.finish(); panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_role('status')).to_contain_text('Outcome saved on this iPad')
        self.until(lambda: self.posts, 'the Start is tried while the connection is down')
        self.post_offline = False
        self.page.evaluate("dispatchEvent(new Event('online'))")
        card = self.page.locator('#wt-recorder')
        expect(card).to_contain_text('It needs your decision before it can be sent')
        expect(card).to_contain_text('Start needs your decision: Offline clock times are not enabled')
        choice = card.locator('.wt-attention').get_by_role('button', name='Start without timecard')
        expect(choice).to_be_visible()
        self.assertNotIn('sent when the signal allows', card.inner_text())
        self.assertEqual(self.accepted, [])
        self.assertEqual({body['action'] for body in self.posts}, {'start'}, 'the Finish waits behind the refused Start')
        self.assertEqual(len({body['requestId'] for body in self.posts}), 1)
        self.assert_layout(375, 'gameplan-recorder-phone-timecard-choice.png')
        choice.click()
        expect(card.get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        self.assertEqual([body['action'] for body in self.accepted], ['start', 'finish'])
        start = self.accepted[0]
        self.assertIs(start['skipTimecard'], True); self.assertNotIn(start['requestId'], {body['requestId'] for body in self.posts[:-2]})
        tapped = datetime.datetime.fromisoformat(start['deviceAt'].replace('Z', '+00:00'))
        self.assertTrue(NOW <= tapped < NOW + datetime.timedelta(minutes=1), 'the visit keeps the real start time')
        self.page.wait_for_function('window.__rec.uploads.length === 1')
        self.until_page(self.page, 'window.__chunkCount().then(count => count === 0)', 'the uploaded audio left the iPad')
        expect(self.page.locator('.wt-badge')).to_have_count(0)

    def test_the_bar_finish_switches_back_to_the_recorded_appointment(self):
        self.start_page(PHONE)
        self.page.add_init_script("window.__wtRows.push({ id: 'wt-2', type: 'walkthrough', status: 'scheduled', customer: 'Synthetic Neighbour', phone: '9705550101', address: '102 Synthetic Lane', date: '2026-09-22', time: '11:00' })")
        self.open(); self.start_recording()
        # Still recording, the rep opens the next appointment from today's list.
        self.page.locator('#appointments').get_by_role('button', name=re.compile('Synthetic Neighbour')).click()
        recorder, bar = self.page.locator('#wt-recorder'), self.page.locator('.wt-bar')
        expect(recorder.get_by_role('heading', name='Synthetic Neighbour')).to_be_visible()
        expect(recorder).to_contain_text('Finish the walkthrough for Synthetic Customer before starting this one')
        expect(bar).to_contain_text('This walkthrough is for Synthetic Customer, not the one on screen')
        self.assert_layout(375, 'gameplan-recorder-phone-other-appointment.png')
        bar.get_by_role('link', name='Finish').click()
        expect(recorder.get_by_role('heading', name='Finish walkthrough')).to_be_visible()
        expect(recorder.locator('#wt-finish-customer')).to_have_text('Synthetic Customer')
        self.assertIn('walkthroughId=wt-1', self.page.url)
        expect(self.page.locator('.wt-bar-text')).to_contain_text('Recording')
        recorder.get_by_role('radio', name='Quote to follow').click()
        recorder.get_by_role('button', name='Save outcome').click()
        expect(recorder.get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        self.assertEqual([(body['action'], body['visitId']) for body in self.accepted], [('start', 'wt-1'), ('finish', 'wt-1')])

    def test_an_offline_start_refused_after_switching_appointments_shows_its_choice_there(self):
        self.start_page(PHONE); self.page.add_init_script(SECOND)
        self.open()
        self.post_offline = True
        self.start_recording(); self.run_for(5 * 60 * 1000)
        panel = self.finish(); panel.get_by_role('button', name='Save outcome').click()
        expect(panel.get_by_role('status')).to_contain_text('Outcome saved on this iPad')
        # The rep drives to the next appointment; the signal returns there.
        self.page.locator('#appointments').get_by_role('button', name=re.compile('Synthetic Neighbour')).click()
        recorder = self.page.locator('#wt-recorder')
        expect(recorder.get_by_role('heading', name='Synthetic Neighbour')).to_be_visible()
        self.post_offline = False
        self.page.evaluate("dispatchEvent(new Event('online'))")
        strip = recorder.locator('.wt-decide')
        expect(strip.get_by_role('alert')).to_have_text(re.compile(r'^The walkthrough for Synthetic Customer \(Sep 22, 9:00 AM\) needs your decision\.$'))
        expect(strip).to_contain_text('Start needs your decision: Offline clock times are not enabled')
        expect(strip.get_by_role('button', name='Retry', exact=True)).to_have_count(0)
        expect(self.page.locator('.wt-bar')).to_be_hidden()
        expect(recorder.get_by_role('button', name='Start walkthrough')).to_be_visible()
        self.assertEqual(self.accepted, [])
        self.assert_layout(375, 'gameplan-recorder-phone-decision-elsewhere.png')
        strip.get_by_role('button', name='Start without timecard').click()
        expect(strip).to_have_count(0)
        self.until(lambda: [body['action'] for body in self.accepted] == ['start', 'finish'], 'Start and Finish of the first walkthrough are accepted')
        self.assertIs(self.accepted[0]['skipTimecard'], True); self.assertEqual({body['visitId'] for body in self.accepted}, {'wt-1'})
        tapped = datetime.datetime.fromisoformat(self.accepted[0]['deviceAt'].replace('Z', '+00:00'))
        self.assertTrue(NOW <= tapped < NOW + datetime.timedelta(minutes=1), 'the visit keeps the real start time')
        expect(self.page.locator('.wt-badge')).to_have_count(0)

    def bar_leaves_the_plan_clear(self, device, width, shot):
        self.start_page(device); self.page.add_init_script(SECOND)
        self.open()
        # The default-config worst case: an offline Start refused while still recording, a screen lock, and another
        # appointment on screen (the "not the one on screen" note), on the Review step with its signature pad.
        self.post_offline = True
        self.start_recording(); self.run_for(5 * 60 * 1000)
        self.post_offline = False
        self.page.evaluate("dispatchEvent(new Event('online'))")
        bar = self.page.locator('.wt-bar')
        expect(bar.get_by_role('alert').filter(has_text='Start needs your decision.')).to_be_visible()
        expect(bar.get_by_role('button', name='Start without timecard')).to_have_count(0)
        self.page.evaluate('window.__setHidden(true)'); self.run_for(5000); self.page.evaluate('window.__setHidden(false)')
        expect(bar.locator('.wt-warn')).to_be_visible()
        self.page.locator('#appointments').get_by_role('button', name=re.compile('Synthetic Neighbour')).click()
        expect(bar).to_contain_text('not the one on screen')
        self.page.evaluate('index=5; render()')
        self.page.wait_for_timeout(200)
        result = self.page.evaluate(COVERED)
        self.assertGreater(result['controls'], 0)
        self.assertEqual(result['covered'], [], f'no plan control sits under the footer at the bottom of the page: {result}')
        self.assert_layout(width, shot)
        # Decide brings the choice on the card into view; the warning can be dismissed.
        bar.get_by_role('button', name='Decide').click()
        expect(self.page.locator('#wt-recorder .wt-decide').get_by_role('button', name='Start without timecard')).to_be_focused()
        bar.get_by_role('button', name='Dismiss this warning').click()
        expect(bar.locator('.wt-warn')).to_have_count(0)
        self.assertEqual(self.page.evaluate(COVERED)['covered'], [])
        return result

    def test_phone_the_recording_bar_never_covers_the_plan(self):
        result = self.bar_leaves_the_plan_clear(PHONE, 375, 'gameplan-recorder-phone-bar-review.png')
        self.assertLess(result['footer'], result['viewport'] * 0.5, result)

    def test_ipad_the_recording_bar_never_covers_the_plan(self):
        self.bar_leaves_the_plan_clear(IPAD, 820, 'gameplan-recorder-ipad-bar-review.png')

    def test_ipad_landscape_the_recording_bar_never_covers_the_plan(self):
        self.bar_leaves_the_plan_clear(LANDSCAPE, 1180, 'gameplan-recorder-ipad-landscape-bar-review.png')

    def test_two_tabs_the_second_is_told_to_use_the_first_and_takes_the_walkthrough_back_once_it_closes(self):
        self.start_page(IPAD); self.page.add_init_script(COUNT_ENGAGED); self.open(); self.start_recording()
        self.run_for(10000)
        first, second = self.page, self.context.new_page()
        self.until_page(first, 'window.__chunkCount().then(count => count >= 10)', 'ten seconds of audio are saved on the iPad')
        second.set_default_timeout(8000)
        second.on('pageerror', lambda error: self.errors.append(str(error)))
        second.clock.install(time=self.server_now)
        second.add_init_script(FAKES); second.add_init_script(COUNT_ENGAGED)
        second.route('**/*', self.route)
        # The same walkthrough opened again in a second tab (from the Hub schedule): one tab holds it.
        second.goto(self.url + '/crew/gameplan.html?walkthroughId=wt-1')
        elsewhere = 'This walkthrough is open in another tab on this iPad \u2014 use that tab.'
        bar, card = second.locator('.wt-bar'), second.locator('#wt-recorder')
        expect(bar.locator('.wt-bar-text')).to_contain_text('Open in another tab')
        expect(bar).to_contain_text(elsewhere)
        expect(card).to_contain_text(elsewhere)
        for name in ('Finish', 'Resume', 'Decide'):
            expect(bar.get_by_role('button', name=name, exact=True)).to_have_count(0)
        expect(card.get_by_role('button', name='Finish walkthrough')).to_have_count(0)
        expect(card.get_by_role('button', name=re.compile('Customer withdrew consent'))).to_have_count(0)
        self.assertEqual(second.evaluate('window.__rec.gum'), 0, 'the second tab never opens the microphone')
        self.assertEqual(second.evaluate('window.__wtEngaged.channels'), 0, 'no BroadcastChannel')
        self.assertGreaterEqual(second.evaluate('window.__wtEngaged.locks'), 1, 'its own tab lock')
        expect(first.locator('.wt-bar-text')).to_contain_text('Recording \u00b7')
        self.assertLessEqual(second.evaluate('document.documentElement.scrollWidth'), 820)
        # Safari closes the first tab: its Web Lock goes, and within a few seconds the second tab takes the walkthrough back.
        own = 'egc-wt-tab:' + second.evaluate('EGCWalkthroughRecorder.page.recorder.tab')
        first.close()
        # Chromium releases a closed page's locks a moment later, in real time (seconds on a loaded machine): wait until only the
        # second tab's own is held, so the look the clock runs next finds the first tab gone. (A look that still found it had
        # finished by then: this read answers after it on the same lock manager, and its next look is due within 5 s.)
        self.until_page(second, 'own => navigator.locks.query().then(q => q.held.length === 1 && q.held[0].name === own)', "the closed tab's Web Lock is released", own, timeout=30)
        second.clock.run_for(6000)
        expect(bar.locator('.wt-bar-text')).to_contain_text('Recording paused')
        expect(bar.locator('.wt-warn')).to_contain_text('The page closed while recording. The audio saved on this iPad is kept.')
        bar.get_by_role('button', name='Finish', exact=True).click()
        expect(card.get_by_role('heading', name='Finish walkthrough')).to_be_visible()
        card.get_by_role('radio', name='Quote to follow').click()
        card.get_by_role('button', name='Save outcome').click()
        expect(card.get_by_text('Outcome recorded: Quote to follow')).to_be_visible()
        second.wait_for_function('window.__rec.uploads.length === 1')
        uploads = second.evaluate('window.__rec.uploads')
        self.assertEqual([item['name'] for item in uploads], ['walkthrough-wt-1-part-1.m4a'])
        self.assertGreaterEqual(uploads[0]['size'], 10 * 1000, 'every second the first tab saved is uploaded')
        self.assertEqual([body['action'] for body in self.accepted], ['start', 'finish'])
        self.assertEqual(self.accepted[1]['recordingStatus'], 'recorded')
        self.until_page(second, 'window.__chunkCount().then(count => count === 0)', 'the uploaded audio left the iPad')

    def switched_off(self, status=None):
        self.start_page(PHONE); self.enabled = False; self.get_status = status
        self.page.add_init_script(WATCH_RECORDER); self.page.add_init_script(COUNT_ENGAGED)
        self.page.goto(self.url + '/crew/gameplan.html?walkthroughId=wt-1')
        expect(self.page.locator('#screen')).to_contain_text('Customer and goal')
        self.until(lambda: self.gets >= 1, 'the recorder asks whether Start and Finish are switched on')
        self.run_for(2000); self.page.wait_for_timeout(300)
        expect(self.page.locator('#wt-recorder')).to_be_hidden()
        expect(self.page.locator('.wt-bar')).to_be_hidden()
        self.assertEqual(self.page.evaluate('window.__wtShown'), [], 'the recorder never showed itself, not even a skeleton')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        # Behaviour-identical: no Web Lock or BroadcastChannel (both keep a page out of the back/forward cache), no
        # persistent-storage request (a permission prompt in Firefox) and no leave-page prompt.
        self.assertEqual(self.page.evaluate('window.__wtEngaged'), {'locks': 0, 'persist': 0, 'channels': 0, 'leave': 0})

    def test_switched_off_the_gameplan_is_unchanged(self):
        self.switched_off()

    def test_switched_off_a_missing_visit_shows_no_panel(self):
        self.switched_off(404)  # a restored draft whose walkthrough was deleted


if __name__ == '__main__':
    unittest.main(verbosity=2)
