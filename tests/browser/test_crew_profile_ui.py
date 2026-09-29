"""Crew photo page (employee upload, manager review) and the portal's crew card at phone size, against fixtures built by the real server code."""
import copy, json, os, pathlib, re, struct, subprocess, threading, unittest, zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = '2026-09-22T18:00:00.000Z'

# The staff overview and portal DTO come from the production modules, so these
# fixtures cannot drift from the server contract.
FIXTURE_SCRIPT = r"""
import { createCustomerPortalSessionToken } from './functions/_lib/customer-portal.js';
import { createCustomerPortalHandlers } from './functions/api/customer-portal.js';
import { crewProfileOverview, crewProfileView } from './functions/_lib/crew-public-profile.js';
const NOW = '2026-09-22T18:00:00.000Z', env = { CUSTOMER_PORTAL_SECRET: 'synthetic-browser-portal-secret', HUB_SESSION_SECRET: 'synthetic-browser-crew-profile-secret-000001', CREW_PUBLIC_PROFILES_ENABLED: 'true' };
const approved = requestId => ({ fileId: 'synthetic-drive-canary-1', requestId, mime: 'image/jpeg', bytes: 900, uploadedAt: '2026-09-20T15:00:00.000Z', uploadedBy: 'crew.one', approvedAt: '2026-09-20T16:00:00.000Z', approvedBy: 'tylerg' });
const pending = requestId => ({ fileId: 'synthetic-drive-canary-2', requestId, mime: 'image/jpeg', bytes: 900, uploadedAt: '2026-09-22T17:00:00.000Z', uploadedBy: 'crew.two' });
const roster = [{ id: 'crew.one', name: 'Dana Synthetic', role: 'crew' }, { id: 'crew.two', name: 'Riley Synthetic', role: 'crew' }, { id: 'tylerg', name: 'Synthetic Manager', role: 'manager' }];
const rows = {
  'crew.one': { id: 'crew.one', revision: '2026-09-22T12:00:00.000001Z', username: 'crew.one', firstName: 'Dana', active: true, photo: approved('10000000-0000-4000-8000-000000000001') },
  'crew.two': { id: 'crew.two', revision: '2026-09-22T12:00:00.000002Z', username: 'crew.two', firstName: '', active: false, photo: null, pendingPhoto: pending('20000000-0000-4000-8000-000000000002') },
  // Left the company: no longer on the roster, but still shown to customers until a manager hides them.
  'crew.gone': { id: 'crew.gone', revision: '2026-09-22T12:00:00.000003Z', username: 'crew.gone', firstName: 'Morgan', active: true, photo: approved('40000000-0000-4000-8000-000000000004') },
};
const store = source => ({ roster: async () => structuredClone(roster), readMany: async ids => ids.map(id => source[id]).filter(Boolean).map(row => structuredClone(row)), list: async () => Object.values(source).map(row => structuredClone(row)) });
const crew = { user: 'Crew.One', displayName: 'Dana Synthetic', role: 'crew', businessAccess: false };
const manager = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const uploaded = { ...rows['crew.one'], revision: '2026-09-22T18:00:01.000001Z', pendingPhoto: pending('30000000-0000-4000-8000-000000000003') };
const job = { id: 'job-1', __updateTime: '2026-09-22T17:00:00.000001Z', type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '123 Synthetic Way, Fort Collins', serviceType: 'Garage Turnaround', total: 900, status: 'dispatched', pipelineStatus: 'dispatched', date: '2026-09-22', time: '09:00', endTime: '12:00', assignedCrew: ['crew.one', 'crew.two'], crewLead: 'crew.two', fieldExecution: { activity: 'dispatched', activityAt: '2026-09-22T15:42:00.000Z' } };
const profiles = { 'crew.one': rows['crew.one'], 'crew.two': { ...rows['crew.two'], firstName: 'Riley', active: true } };
const token = await createCustomerPortalSessionToken(env, 'job-1', Date.parse(NOW), { linkVersion: 0 });
const handlers = createCustomerPortalHandlers({ now: () => new Date(NOW), read: async (_env, id) => id === 'job-1' ? structuredClone(job) : null, crewProfiles: async (_env, keys) => new Map(keys.filter(key => profiles[key]).map(key => [key, structuredClone(profiles[key])])) });
const portal = await (await handlers.onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/customer-portal', { headers: { Cookie: `egc_customer_portal=${token}` } }) })).json();
console.log(JSON.stringify({
  crewView: await crewProfileOverview(store(rows), crew, env), crewAfter: await crewProfileOverview(store({ ...rows, 'crew.one': uploaded }), crew, env),
  uploadedProfile: crewProfileView(uploaded, 'crew.one', { self: true }), managerView: await crewProfileOverview(store(rows), manager, env),
  crewChanged: await crewProfileOverview(store({ ...rows, 'crew.one': { ...rows['crew.one'], revision: '2026-09-22T17:59:00.000001Z' } }), crew, env),
  hiddenView: await crewProfileOverview(store({ ...rows, 'crew.gone': { ...rows['crew.gone'], revision: '2026-09-22T18:00:03.000001Z', active: false } }), manager, env),
  hiddenProfile: crewProfileView({ ...rows['crew.gone'], revision: '2026-09-22T18:00:03.000001Z', active: false }, 'crew.gone', { manager: true }),
  approvedProfile: crewProfileView({ ...rows['crew.two'], revision: '2026-09-22T18:00:02.000001Z', pendingPhoto: null, photo: { ...approved('20000000-0000-4000-8000-000000000002') } }, 'crew.two', { manager: true }),
  portal,
}));
"""
FIXTURES = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', FIXTURE_SCRIPT], cwd=ROOT))
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')

def png(width=64, height=48, rgb=(196, 116, 64)):
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
IMAGE = png()

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class CrewProfileBrowserTests(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.page.clock.install(time=NOW)
        self.errors = []; self.posts = []; self.post_status = []; self.photo_requests = []; self.broken_photos = False
        self.overview = copy.deepcopy(FIXTURES['crewView']); self.after = None; self.result_profile = None; self.conflict_overview = None; self.gets = 0
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
        self.context.close()
    def json(self, route, status, body):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
    def route(self, route):
        request = route.request; parsed = urlparse(request.url); query = parse_qs(parsed.query)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path == '/api/crew-public-profile':
            if 'photo' in query: self.photo_requests.append(parsed.query); return route.fulfill(status=200, content_type='image/png', body=IMAGE)
            if request.method == 'GET': self.gets += 1; return self.json(route, 200, self.overview)
            body = json.loads(request.post_data); self.posts.append(body)
            status = self.post_status.pop(0) if self.post_status else 200
            if status == 503: return self.json(route, 503, {'ok': False, 'code': 'crew_profile_outcome_unknown', 'error': 'The save could not be verified. Retry the same change to safely check whether it saved.'})
            if status == 409:
                if self.conflict_overview: self.overview = copy.deepcopy(self.conflict_overview)
                return self.json(route, 409, {'ok': False, 'code': 'crew_profile_revision_conflict', 'error': 'This crew profile changed. Refresh before uploading a new photo.', 'details': {'currentRevision': self.overview['profiles'][0]['revision']}})
            if self.after: self.overview = copy.deepcopy(self.after)
            return self.json(route, 200, {'ok': True, 'authority': 'employee_hub', 'action': body['action'], 'requestId': body['requestId'].lower(), 'replayed': False, 'profile': self.result_profile})
        if parsed.path == '/api/customer-portal': return self.json(route, 200, self.portal)
        if parsed.path == '/api/customer-crew-photo':
            self.photo_requests.append(parsed.query)
            if self.broken_photos: return self.json(route, 403, {'ok': False, 'code': 'CUSTOMER_PORTAL_CREW_PHOTO_LINK_INVALID', 'error': 'This photo link has expired. Refresh your project page.'})
            return route.fulfill(status=200, content_type='image/png', body=IMAGE)
        route.continue_()
    def phone_checks(self, selector):
        for width in (375, 320):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth > innerWidth'), f'no horizontal scroll at {width}px')
        self.page.set_viewport_size({'width': 375, 'height': 812})
        small = self.page.evaluate(f"""[...document.querySelectorAll({json.dumps(selector)})].filter(el => el.getClientRects().length && el.getBoundingClientRect().height < 44).map(el => el.textContent.trim() || el.outerHTML.slice(0, 80))""")
        self.assertEqual(small, [], 'every control is at least 44px tall')
    def wait_until(self, condition, message):
        for _ in range(150):
            if condition(): return
            self.page.wait_for_timeout(20)
        self.fail(message)
    def screenshot(self, name):
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out / name), full_page=True)
    def choose_photo(self, card):
        card.locator('label', has_text='Choose a photo').locator('input[type=file]').set_input_files({'name': 'synthetic-headshot.png', 'mimeType': 'image/png', 'buffer': IMAGE})

    def test_crew_member_uploads_a_headshot_that_waits_for_approval(self):
        self.after = FIXTURES['crewAfter']; self.result_profile = FIXTURES['uploadedProfile']
        self.page.goto(self.url + '/crew/profile-photo.html')
        own = self.page.get_by_role('region', name='Your crew photo')
        expect(own).to_be_visible()
        expect(own.get_by_text('Shown to customers')).to_be_visible()
        expect(own.get_by_role('img', name='Dana Synthetic crew photo')).to_be_visible()
        self.assertEqual(self.page.get_by_role('button', name='Approve photo').count(), 0, 'crew never see manager review tools')
        self.assertEqual(self.page.locator('input[type=text]').count(), 0, 'crew cannot edit what customers see')
        self.phone_checks('.cp-btn')
        self.choose_photo(own)
        self.wait_until(lambda: self.posts, 'the upload is sent')
        body = self.posts[0]
        self.assertEqual({key: body[key] for key in ('action', 'username', 'expectedRevision')}, {'action': 'upload_photo', 'username': 'crew.one', 'expectedRevision': '2026-09-22T12:00:00.000001Z'})
        self.assertRegex(body['requestId'], UUID)
        self.assertRegex(body['dataUrl'], r'^data:image/jpeg;base64,', 'the photo is re-encoded as a JPEG before upload')
        expect(self.page.get_by_role('status')).to_contain_text('Your photo: saved.')
        expect(own.get_by_text('Waiting for a manager to approve this photo')).to_be_visible()
        expect(own.get_by_text('Photo waiting for approval')).to_be_visible()
        self.assertTrue(any('state=pending' in item for item in self.photo_requests), 'the pending photo previews through the staff proxy')
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('egc.crew-profile.pending.v1.crew.one')"), 'a confirmed save clears the pending request')
        self.screenshot('crew-profile-upload-375.png')

    def test_an_unconfirmed_save_is_retried_with_the_same_request(self):
        self.after = FIXTURES['crewAfter']; self.result_profile = FIXTURES['uploadedProfile']; self.post_status = [503]
        self.page.goto(self.url + '/crew/profile-photo.html')
        own = self.page.get_by_role('region', name='Your crew photo'); expect(own).to_be_visible()
        self.choose_photo(own)
        retry = self.page.get_by_role('button', name='Retry original save'); expect(retry).to_be_visible()
        expect(self.page.get_by_role('alert').first).to_contain_text('The save could not be verified')
        stored = json.loads(self.page.evaluate("sessionStorage.getItem('egc.crew-profile.pending.v1.crew.one')"))
        self.assertEqual(stored['body']['requestId'], self.posts[0]['requestId'], 'the pending request is kept in this tab')
        retry.click()
        self.wait_until(lambda: len(self.posts) == 2, 'the retry is sent')
        self.assertEqual(self.posts[1], self.posts[0], 'the retry is byte-for-byte the original request')
        expect(self.page.get_by_role('button', name='Retry original save')).to_have_count(0)
        expect(own.get_by_text('Waiting for a manager to approve this photo')).to_be_visible()

    def test_a_photo_that_lost_a_revision_race_is_kept_and_sent_again_against_the_latest_profile(self):
        self.after = FIXTURES['crewAfter']; self.result_profile = FIXTURES['uploadedProfile']; self.post_status = [409]; self.conflict_overview = FIXTURES['crewChanged']
        self.page.goto(self.url + '/crew/profile-photo.html')
        own = self.page.get_by_role('region', name='Your crew photo'); expect(own).to_be_visible()
        self.choose_photo(own)
        draft = self.page.get_by_role('alert', name='Photo not saved yet'); expect(draft).to_be_visible()
        expect(draft.get_by_role('img', name='The photo you chose')).to_be_visible()
        expect(self.page.get_by_role('button', name='Retry original save')).to_have_count(0)
        stored = json.loads(self.page.evaluate("sessionStorage.getItem('egc.crew-profile.pending.v1.crew.one')"))
        self.assertTrue(stored['conflict']); self.assertEqual(stored['body']['dataUrl'], self.posts[0]['dataUrl'], 'the prepared photo is kept in this tab')
        self.phone_checks('.cp-btn')
        draft.get_by_role('button', name='Send this photo again').click()
        self.wait_until(lambda: len(self.posts) == 2, 'the draft is sent again')
        first, again = self.posts
        self.assertNotEqual(again['requestId'], first['requestId'], 'a new request, never a replay of the refused one'); self.assertRegex(again['requestId'], UUID)
        self.assertEqual(again['expectedRevision'], '2026-09-22T17:59:00.000001Z', 'sent against the refreshed profile')
        self.assertEqual({key: again[key] for key in ('action', 'username', 'dataUrl')}, {key: first[key] for key in ('action', 'username', 'dataUrl')}, 'the same photo, not re-encoded')
        expect(self.page.get_by_role('status')).to_contain_text('Your photo: saved.')
        expect(self.page.get_by_role('alert', name='Photo not saved yet')).to_have_count(0)
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('egc.crew-profile.pending.v1.crew.one')"))

    def test_a_conflicted_photo_draft_can_be_discarded_to_load_the_latest_profile(self):
        self.post_status = [409]; self.conflict_overview = FIXTURES['crewChanged']
        self.page.goto(self.url + '/crew/profile-photo.html')
        own = self.page.get_by_role('region', name='Your crew photo'); expect(own).to_be_visible()
        self.choose_photo(own)
        draft = self.page.get_by_role('alert', name='Photo not saved yet'); expect(draft).to_be_visible()
        gets = self.gets
        draft.get_by_role('button', name='Discard draft and load latest').click()
        expect(self.page.get_by_role('alert', name='Photo not saved yet')).to_have_count(0)
        self.wait_until(lambda: self.gets > gets, 'the latest profile is loaded')
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('egc.crew-profile.pending.v1.crew.one')"))
        self.assertEqual(len(self.posts), 1, 'discarding sends nothing')

    def test_manager_hides_and_clears_someone_who_left_the_roster(self):
        self.overview = copy.deepcopy(FIXTURES['managerView']); self.after = FIXTURES['hiddenView']; self.result_profile = FIXTURES['hiddenProfile']
        self.page.goto(self.url + '/crew/profile-photo.html')
        gone = self.page.get_by_role('region', name='Morgan crew profile')
        expect(gone).to_be_visible(); expect(gone.get_by_text('Not on the roster')).to_be_visible()
        expect(gone.get_by_text('no longer on the employee roster', exact=False)).to_be_visible()
        self.assertEqual(gone.locator('input').count(), 0, 'no new photo and no customer name for someone who left')
        expect(gone.get_by_role('button', name='Remove photo')).to_be_visible()
        self.phone_checks('.cp-btn')
        gone.get_by_role('button', name='Hide from customers').click()
        self.wait_until(lambda: self.posts, 'the profile is hidden')
        self.assertEqual({key: self.posts[0][key] for key in ('action', 'username', 'firstName', 'active', 'expectedRevision')}, {'action': 'set_profile', 'username': 'crew.gone', 'firstName': 'Morgan', 'active': False, 'expectedRevision': '2026-09-22T12:00:00.000003Z'})
        expect(self.page.get_by_role('status')).to_contain_text('Hide Morgan from customers: saved.')
        gone = self.page.get_by_role('region', name='Morgan crew profile')
        expect(gone.get_by_text('Hidden from customers')).to_be_visible()
        expect(gone.get_by_role('button', name='Hide from customers')).to_have_count(0)
        self.screenshot('crew-profile-departed-375.png')

    def test_manager_approves_a_pending_photo_and_sets_the_customer_first_name(self):
        self.overview = copy.deepcopy(FIXTURES['managerView']); self.result_profile = FIXTURES['approvedProfile']
        self.page.goto(self.url + '/crew/profile-photo.html')
        riley = self.page.get_by_role('region', name='Riley Synthetic crew profile')
        expect(riley).to_be_visible(); expect(riley.get_by_text('New photo to review')).to_be_visible()
        self.phone_checks('.cp-btn, .egc-crew-profile input[type=text], .cp-check')
        self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('.egc-crew-profile input[type=text]')).fontSize"), '16px', 'no iOS zoom on focus')
        riley.get_by_role('button', name='Approve photo').click()
        self.wait_until(lambda: self.posts, 'the approval is sent')
        self.assertEqual({key: self.posts[0][key] for key in ('action', 'username', 'photoRequestId', 'expectedRevision')}, {'action': 'approve_photo', 'username': 'crew.two', 'photoRequestId': '20000000-0000-4000-8000-000000000002', 'expectedRevision': '2026-09-22T12:00:00.000002Z'})
        expect(self.page.get_by_role('status')).to_contain_text('Approve photo for Riley Synthetic: saved.')
        riley = self.page.get_by_role('region', name='Riley Synthetic crew profile')
        riley.get_by_label('First name customers see (one word)').fill('Riley')
        riley.get_by_label('Show to customers on jobs this person is assigned to').check()
        riley.get_by_role('button', name='Save profile').click()
        self.wait_until(lambda: len(self.posts) == 2, 'the profile is saved')
        self.assertEqual({key: self.posts[1][key] for key in ('action', 'username', 'firstName', 'active')}, {'action': 'set_profile', 'username': 'crew.two', 'firstName': 'Riley', 'active': True})
        self.assertNotEqual(self.posts[1]['requestId'], self.posts[0]['requestId'])
        self.screenshot('crew-profile-manager-375.png')

    def test_portal_shows_first_names_lead_first_and_the_departure_on_the_denver_clock(self):
        self.portal = copy.deepcopy(FIXTURES['portal'])
        self.assertEqual([(item['firstName'], item['lead']) for item in self.portal['crew']], [('Riley', True), ('Dana', False)])
        self.assertNotIn('synthetic-drive', json.dumps(self.portal)); self.assertNotIn('crew.one', json.dumps(self.portal))
        self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#portal')).to_be_visible()
        card = self.page.locator('#crew-card'); expect(card).to_be_visible()
        expect(card.locator('.crew-member b')).to_have_text(['Riley', 'Dana'])
        expect(card.locator('.crew-member small')).to_have_text(['Crew lead', 'Crew'])
        expect(card.get_by_role('img', name='Dana, crew member')).to_be_visible()
        expect(self.page.locator('#crew-otw')).to_have_text('Riley and your crew are on the way — they left at 9:42 AM.')
        self.assertEqual(len([item for item in self.photo_requests if item.startswith('u=')]), 1, 'only the approved photo is requested, once')
        self.phone_checks('#crew-card .crew-member')
        self.page.evaluate('load(true)')
        self.page.wait_for_timeout(100)
        self.assertEqual(len([item for item in self.photo_requests if item.startswith('u=')]), 1, 'a portal refresh keeps the same image')
        self.screenshot('portal-crew-375.png')

    def test_portal_falls_back_to_an_initial_when_the_photo_link_is_refused_and_hides_an_empty_crew(self):
        self.portal = copy.deepcopy(FIXTURES['portal']); self.broken_photos = True
        self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#portal')).to_be_visible()
        card = self.page.locator('#crew-card'); expect(card).to_be_visible()
        expect(card.locator('img')).to_have_count(0)
        expect(card.locator('span.crew-avatar')).to_have_text(['R', 'D'])
        # The 20 s refresh re-renders the whole page: it must reach the crew card (it used to stop at the
        # payment card once the membership notice had removed #payment-due-now on the first render).
        self.portal['onTheWay'] = {'at': '2026-09-22T16:05:00.000Z', 'leadFirstName': 'Riley'}
        self.page.evaluate('load(true)')
        expect(self.page.locator('#crew-otw')).to_have_text('Riley and your crew are on the way — they left at 10:05 AM.')
        self.assertEqual(self.page.locator('#payment-due-now').count(), 1)
        self.portal.pop('crew'); self.portal.pop('onTheWay')
        self.page.evaluate('load(true)')
        expect(card).to_be_hidden()

if __name__ == '__main__':
    unittest.main()
