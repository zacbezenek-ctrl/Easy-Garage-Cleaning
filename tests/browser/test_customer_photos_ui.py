"""Customer before/after gallery and manager share toggles at phone size, against contract fixtures built by the real server code."""
import copy, json, os, pathlib, struct, subprocess, threading, unittest, zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = '2026-09-22T18:00:00.000Z'

# The portal DTO, crew projection and manager sharing view come from the
# production modules, so these fixtures cannot drift from the server contract.
FIXTURE_SCRIPT = r"""
import { createCustomerPortalSessionToken } from './functions/_lib/customer-portal.js';
import { createCustomerPortalHandlers } from './functions/api/customer-portal.js';
import { fieldJobProjection } from './functions/_lib/field-execution.js';
import { photoSharingView } from './functions/_lib/customer-photo-visibility.js';
const NOW = '2026-09-22T18:00:00.000Z', env = { CUSTOMER_PORTAL_SECRET: 'synthetic-browser-portal-secret', FIELD_CUSTOMER_PHOTOS_ENABLED: 'true' };
const ids = Array.from({ length: 6 }, (_, index) => `30000000-0000-4000-8000-00000000000${index + 1}`);
const stamp = { at: '2026-09-22T17:30:00.000Z', actorId: 'zacb', actorName: 'Synthetic Owner', requestId: '40000000-0000-4000-8000-000000000001' };
const photo = (index, category, createdAt, extra = {}) => ({ id: ids[index], fileId: `synthetic-drive-file-${index}`, category, caption: `Synthetic crew caption ${index}`, actorId: 'crew.one', actorName: 'Synthetic Crew', createdAt, verified: true, mime: 'image/png', bytes: 120, ...extra });
const job = { id: 'job-1', __updateTime: '2026-09-22T17:00:00.000001Z', type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '123 Synthetic Way, Fort Collins', serviceType: 'Garage Turnaround', total: 900, status: 'completed', pipelineStatus: 'completed', date: '2026-09-22', time: '08:00', endTime: '11:00', completedAt: '2026-09-23T04:00:00.000Z', assignedCrew: ['crew.one'], crewLead: 'crew.one',
  fieldExecution: { photos: [photo(0, 'before', '2026-09-22T14:10:00.000Z'), photo(1, 'before', '2026-09-22T14:12:00.000Z'), photo(2, 'after', '2026-09-23T03:30:00.000Z'), photo(3, 'after', '2026-09-23T03:40:00.000Z'), photo(4, 'damage', '2026-09-22T15:00:00.000Z', { customerVisible: { ...stamp, confirmed: true } }), photo(5, 'progress', '2026-09-22T16:00:00.000Z')] } };
const token = await createCustomerPortalSessionToken(env, 'job-1', Date.parse(NOW), { linkVersion: 0 });
const handlers = createCustomerPortalHandlers({ now: () => new Date(NOW), read: async (_env, id) => id === 'job-1' ? structuredClone(job) : null });
const response = await handlers.onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/customer-portal', { headers: { Cookie: `egc_customer_portal=${token}` } }) });
const active = { ...structuredClone(job), status: 'in_progress', pipelineStatus: 'in_progress', startedAt: '2026-09-22T14:00:00.000Z', completedAt: '' };
console.log(JSON.stringify({ portal: await response.json(), crew: fieldJobProjection(job, [], { manager: true, now: NOW }), sharing: { ok: true, viewer: 'zacb', ...photoSharingView(job) }, activeCrew: fieldJobProjection(active, [], { manager: true, now: NOW }), activeSharing: { ok: true, viewer: 'zacb', ...photoSharingView(active) }, ids }));
"""
FIXTURES = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', FIXTURE_SCRIPT], cwd=ROOT))
IDS = FIXTURES['ids']

def png(width=48, height=36, rgb=(196, 116, 64)):
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
IMAGE = png()

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class CustomerPhotosBrowserTests(unittest.TestCase):
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
        self.errors = []; self.photo_requests = []; self.photo_sizes = []; self.share_posts = []; self.share_gets = 0; self.job_gets = 0
        self.portal = copy.deepcopy(FIXTURES['portal']); self.sharing = copy.deepcopy(FIXTURES['sharing']); self.crew = FIXTURES['crew']; self.broken = set()
        self.share_status = 200; self.post_status = [200]
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
        if parsed.path == '/api/customer-portal': return self.json(route, 200, self.portal)
        if parsed.path == '/api/customer-portal-photo':
            photo_id = query.get('photoId', [''])[0]; self.photo_requests.append(photo_id); self.photo_sizes.append(query.get('size', ['full'])[0])
            if photo_id in self.broken: return self.json(route, 503, {'ok': False, 'code': 'CUSTOMER_PORTAL_PHOTO_UNAVAILABLE', 'error': 'This photo is temporarily unavailable.'})
            return route.fulfill(status=200, content_type='image/png', body=IMAGE)
        if parsed.path == '/api/hub-auth': return self.json(route, 200, {'ok': True, 'user': 'zacb', 'displayName': 'Synthetic Owner', 'role': 'owner', 'businessAccess': True})
        if parsed.path == '/api/field-jobs':
            if 'photoId' in query: return route.fulfill(status=200, content_type='image/png', body=IMAGE)
            if query.get('view') == ['timer']: return self.json(route, 200, {'ok': True, 'jobTime': self.crew['jobTime'], 'expectedRevision': self.crew['expectedRevision']})
            self.job_gets += 1
            return self.json(route, 200, {'ok': True, 'job': self.crew, 'historyCursor': None, 'photosAvailable': True, 'timezone': 'America/Denver'})
        if parsed.path == '/api/employee-hub':
            if query.get('view') == ['job-labor']: return self.json(route, 200, {'ok': True, 'jobId': 'job-1', 'employees': []})
            return self.json(route, 200, {'ok': True, 'user': 'zacb', 'entry': None})
        if parsed.path == '/api/field-photo-sharing':
            if request.method == 'GET':
                self.share_gets += 1
                if self.share_status != 200: return self.json(route, self.share_status, {'ok': False, 'code': 'FIELD_PHOTO_SHARING_FORBIDDEN', 'error': 'Only an operations manager or owner can choose customer-visible photos.'})
                return self.json(route, 200, self.sharing)
            body = json.loads(request.post_data); self.share_posts.append(body)
            status = self.post_status.pop(0) if self.post_status else 200
            if status == 503: return self.json(route, 503, {'ok': False, 'code': 'FIELD_STORAGE_UNAVAILABLE', 'error': 'The change could not be saved. Retry with the same action to check its result.'})
            if status == 409: return self.json(route, 409, {'ok': False, 'code': 'FIELD_REVISION_CONFLICT', 'error': 'This job changed.'})
            for photo in self.sharing['photos']:
                if photo['photoId'] == body['photoId']:
                    photo.update({'visible': body['customerVisible'], 'state': 'shared' if body['customerVisible'] else 'hidden', 'reason': 'shared' if body['customerVisible'] else 'hidden', 'sharedBy': 'Synthetic Owner' if body['customerVisible'] else '', 'hiddenBy': '' if body['customerVisible'] else 'Synthetic Owner'})
            self.sharing['expectedRevision'] = f"rev-{len(self.share_posts) + 1}"
            return self.json(route, 200, {**self.sharing, 'alreadyApplied': False})
        route.continue_()
    def no_horizontal_scroll(self):
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth > innerWidth'))
    def wait_until(self, condition, message):
        for _ in range(100):
            if condition(): return
            self.page.wait_for_timeout(20)
        self.fail(message)
    def settle_after_save(self, job_gets, share_gets):
        # A saved change reloads job.js, whose re-render re-reads the sharing
        # view; let both finish so no routed request is left open at close.
        self.wait_until(lambda: self.job_gets > job_gets, 'job.js reloads onto the new job version')
        self.wait_until(lambda: self.share_gets > share_gets, 'the re-rendered tiles re-read the sharing view')
        expect(self.page.get_by_role('heading', name='Job photos')).to_be_visible()
    def screenshot(self, name):
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out / name), full_page=True)

    # Customer portal gallery
    def open_portal(self):
        self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#portal')).to_be_visible()
    def test_portal_gallery_groups_photos_with_alt_text_and_denver_dates(self):
        # Chromium starts lazy images within a distance of the viewport that depends on its connection estimate
        # (1250px on 4G, up to 8000px on the slowest types) and the CI headless shell reports a slower one than a
        # local browser. Push the gallery beyond every threshold so "below the fold" means the same everywhere.
        self.page.add_init_script("""document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style'); style.textContent = '#gallery-card{margin-top:9000px}';
            document.head.appendChild(style); });""")
        self.open_portal()
        card = self.page.locator('#gallery-card'); expect(card).to_be_visible()
        expect(card.get_by_role('heading', name='Your project photos')).to_be_visible()
        expect(card.locator('.ba-group h3')).to_have_text(['Before2 photos', 'After2 photos', 'More project photos1 photo'])
        thumbs = card.locator('.ba-thumb'); expect(thumbs).to_have_count(5)
        expect(card.locator('#gallery-count')).to_have_text('5 photos')
        expect(thumbs.nth(0).locator('img')).to_have_attribute('alt', 'Before photo 1 of 2')
        expect(thumbs.nth(3).locator('img')).to_have_attribute('alt', 'After photo 2 of 2')
        expect(thumbs.nth(4).locator('img')).to_have_attribute('alt', 'Damage photo 1 of 1')
        expect(thumbs.nth(2)).to_contain_text('Added Sep 22, 2026')  # 03:30Z on Sep 23 is still Sep 22 in Denver (the browser is in Tokyo)
        self.assertLess(len(self.photo_requests), 5, 'photos below the fold wait for lazy loading')
        for index in range(5): thumbs.nth(index).scroll_into_view_if_needed(); expect(thumbs.nth(index)).to_have_class('ba-thumb loaded')
        sources = self.page.eval_on_selector_all('#gallery-card img', 'images => images.map(image => [image.getAttribute("src"), image.loading])')
        # Grid tiles ask for Drive's small rendition; the viewer below opens the full photo.
        self.assertEqual([source for source, _ in sources], [f'/api/customer-portal-photo?photoId={IDS[index]}&size=thumb' for index in (0, 1, 2, 3, 4)])
        self.assertEqual(set(self.photo_sizes), {'thumb'})
        self.assertEqual({loading for _, loading in sources}, {'lazy'})
        self.assertNotIn(IDS[5], self.photo_requests, 'the unshared progress photo is never requested')
        html = self.page.content()
        for secret in ['synthetic-drive-file', 'www.googleapis.com', 'drive/v3', 'drive.google', 'Synthetic crew caption']: self.assertNotIn(secret, html)  # fonts.googleapis.com is the page's own stylesheet
        for index in range(5): self.assertGreaterEqual(thumbs.nth(index).bounding_box()['height'], 44)
        self.no_horizontal_scroll(); self.screenshot('customer-photos-portal-mobile.png')
    def test_portal_viewer_is_keyboard_and_touch_accessible(self):
        self.open_portal()
        thumbs = self.page.locator('.ba-thumb'); thumbs.nth(0).tap()
        viewer = self.page.locator('#gallery-viewer'); expect(viewer).to_be_visible()
        expect(viewer.get_by_role('heading', name='Before photo')).to_be_visible()
        expect(self.page.locator('#gallery-position')).to_have_text('Photo 1 of 5 · Added Sep 22, 2026')
        expect(self.page.locator('#gallery-image')).to_have_attribute('alt', 'Before photo, added Sep 22, 2026')
        expect(self.page.locator('#gallery-image')).to_have_attribute('src', f'/api/customer-portal-photo?photoId={IDS[0]}')
        self.page.wait_for_function("document.getElementById('gallery-image').complete && document.getElementById('gallery-image').naturalWidth > 0")
        self.assertIn('full', self.photo_sizes, 'the viewer loads the full photo, not the grid thumbnail')
        self.page.keyboard.press('ArrowRight'); expect(self.page.locator('#gallery-position')).to_contain_text('Photo 2 of 5')
        self.page.get_by_role('button', name='Next photo').tap(); expect(self.page.locator('#gallery-position')).to_contain_text('Photo 3 of 5')
        self.page.get_by_role('button', name='Previous photo').tap(); self.page.get_by_role('button', name='Previous photo').tap(); self.page.get_by_role('button', name='Previous photo').tap()
        expect(self.page.locator('#gallery-position')).to_contain_text('Photo 5 of 5')
        for name in ['Close', 'Previous photo', 'Next photo']: self.assertGreaterEqual(viewer.get_by_role('button', name=name).bounding_box()['height'], 44)
        self.no_horizontal_scroll(); self.screenshot('customer-photos-viewer-mobile.png')
        self.page.keyboard.press('Escape'); expect(viewer).to_be_hidden()
        self.assertTrue(self.page.evaluate('document.activeElement === document.querySelectorAll(".ba-thumb")[0]'), 'focus returns to the photo that opened the viewer')
        thumbs.nth(3).focus(); self.page.keyboard.press('Enter'); expect(viewer).to_be_visible()
        expect(self.page.locator('#gallery-position')).to_contain_text('Photo 4 of 5')
        self.page.get_by_role('button', name='Close').tap(); expect(viewer).to_be_hidden()
    def test_a_late_close_event_never_steals_focus_or_blanks_a_reopened_photo(self):
        # The dialog's close event is queued, so it can arrive after the viewer is reopened or focus has moved on.
        self.open_portal()
        thumbs = self.page.locator('.ba-thumb'); viewer = self.page.locator('#gallery-viewer')
        thumbs.nth(0).tap(); expect(viewer).to_be_visible()
        self.page.get_by_role('button', name='Close').tap(); expect(viewer).to_be_hidden()
        thumbs.nth(3).focus()
        # Replay the queued close event of that session, while its opener is still recorded.
        self.page.evaluate("openGalleryPhoto.opener = document.querySelectorAll('.ba-thumb')[0]; document.getElementById('gallery-viewer').dispatchEvent(new Event('close'))")
        self.assertTrue(self.page.evaluate('document.activeElement === document.querySelectorAll(".ba-thumb")[3]'), 'a late close event keeps the focus the viewer already moved to')
        self.page.keyboard.press('Enter'); expect(viewer).to_be_visible()
        expect(self.page.locator('#gallery-position')).to_contain_text('Photo 4 of 5')
        self.page.evaluate("document.getElementById('gallery-viewer').dispatchEvent(new Event('close'))")
        expect(self.page.locator('#gallery-image')).to_have_attribute('src', f'/api/customer-portal-photo?photoId={IDS[3]}')
        self.page.get_by_role('button', name='Close').tap(); expect(viewer).to_be_hidden()
    def test_portal_marks_an_unavailable_photo_and_hides_the_gallery_without_photos(self):
        self.broken = {IDS[2]}; self.open_portal()
        self.page.locator('.ba-thumb').nth(2).scroll_into_view_if_needed()
        expect(self.page.locator('.ba-thumb').nth(2)).to_have_class('ba-thumb failed')
        expect(self.page.locator('.ba-thumb').nth(1)).to_have_class('ba-thumb loaded')
        self.portal.pop('beforeAfter'); self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#portal')).to_be_visible()
        expect(self.page.locator('#gallery-card')).to_be_hidden(); expect(self.page.locator('.ba-thumb')).to_have_count(0)
    def test_portal_offers_camera_capture_and_library_upload(self):
        self.open_portal()
        expect(self.page.locator('#photo-camera')).to_have_attribute('capture', 'environment')
        self.assertIsNone(self.page.locator('#photo-input').get_attribute('capture'))
        expect(self.page.get_by_text('Take a photo')).to_be_visible(); self.no_horizontal_scroll()

    # Manager share toggles on the field job page
    def open_job(self):
        self.page.goto(self.url + '/crew/job.html?jobId=job-1'); expect(self.page.get_by_role('heading', name='Job photos')).to_be_visible()
    def toggle(self, index):
        return self.page.locator(f'.ps-toggle[data-ps-photo="{IDS[index]}"]')
    def test_manager_hides_a_photo_and_the_job_page_reloads(self):
        self.open_job()
        expect(self.page.locator('.ps-toggle')).to_have_count(6)
        expect(self.page.locator('.ps-note')).to_contain_text('before and after photos now show')
        expect(self.toggle(0)).to_have_attribute('aria-pressed', 'true'); expect(self.toggle(0)).to_contain_text('Shown after completion')
        expect(self.toggle(4)).to_contain_text('Shared by Synthetic Owner'); expect(self.toggle(5)).to_contain_text('Internal only')
        for index in range(6): self.assertGreaterEqual(self.toggle(index).bounding_box()['height'], 44)
        self.no_horizontal_scroll(); self.screenshot('customer-photos-manager-mobile.png')
        gets, shares = self.job_gets, self.share_gets; self.toggle(0).tap()
        expect(self.toggle(0)).to_have_attribute('aria-pressed', 'false'); expect(self.toggle(0)).to_contain_text('Hidden by Synthetic Owner')
        body = self.share_posts[0]
        self.assertEqual({key: body[key] for key in ['jobId', 'photoId', 'customerVisible', 'expectedRevision', 'expectedUser']}, {'jobId': 'job-1', 'photoId': IDS[0], 'customerVisible': False, 'expectedRevision': FIXTURES['sharing']['expectedRevision'], 'expectedUser': 'zacb'})
        self.assertRegex(body['requestId'], r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'); self.assertNotIn('confirm', body)
        expect(self.page.locator('.ps-status')).to_have_text('Hidden from the customer.')
        self.settle_after_save(gets, shares); expect(self.toggle(0)).to_contain_text('Hidden by Synthetic Owner')
    def test_kept_edits_let_the_job_reload_and_other_unsaved_changes_block_it(self):
        self.crew = FIXTURES['activeCrew']; self.sharing = copy.deepcopy(FIXTURES['activeSharing']); self.open_job()
        expect(self.toggle(0)).to_contain_text('Shows when the job completes')
        self.page.get_by_text('Manager: configure this job’s checklist').tap()
        editor = self.page.locator('#checklist-lines'); editor.fill('work | required | Synthetic unsaved checklist edit')
        caption = self.page.locator('#photo-caption'); caption.fill('Synthetic unsaved caption')
        # FIX-EDIT-WIPE: job.js keeps a checklist edit (and its open panel) and the caption through a reload, so they no
        # longer hold back the reload after a sharing change.
        gets, shares = self.job_gets, self.share_gets; self.toggle(0).tap()
        expect(self.toggle(0)).to_have_attribute('aria-pressed', 'true')
        self.settle_after_save(gets, shares)
        expect(editor).to_have_value('work | required | Synthetic unsaved checklist edit'); expect(caption).to_have_value('Synthetic unsaved caption')
        expect(self.page.locator('#checklist-editor')).to_have_attribute('open', '')
        expect(self.page.get_by_role('button', name='Refresh job now')).to_have_count(0)
        expect(self.page.locator('.ps-status')).not_to_contain_text('Refresh job before')
        # A change job.js does not keep (the Add photos panel closed) still holds the reload back and asks first.
        self.page.locator('summary', has_text='Add photos').tap(); expect(self.page.locator('details:has(#photo-caption)')).not_to_have_attribute('open', '')
        gets, shares = self.job_gets, self.share_gets; self.toggle(0).tap()
        expect(self.toggle(0)).to_have_attribute('aria-pressed', 'false')
        expect(self.page.locator('.ps-status')).to_contain_text('not refreshed automatically because you have unsaved edits')
        self.page.wait_for_timeout(300)
        self.assertEqual(self.job_gets, gets, 'job.js is not reloaded over an unsaved change')
        refresh = self.page.get_by_role('button', name='Refresh job now'); expect(refresh).to_be_visible()
        self.assertGreaterEqual(refresh.bounding_box()['height'], 44); self.no_horizontal_scroll()
        prompts = []
        def answer(dialog):
            prompts.append(dialog.message); dialog.dismiss() if len(prompts) == 1 else dialog.accept()
        self.page.on('dialog', answer)
        refresh.tap(); self.wait_until(lambda: len(prompts) == 1, 'refreshing over an unsaved change asks first')
        self.assertEqual(prompts[0], 'Refresh the job now? Changes on this page that are not saved yet will be cleared. A checklist edit, a status reason and other drafts stay.')
        self.page.wait_for_timeout(200); self.assertEqual(self.job_gets, gets)
        refresh.tap(); self.settle_after_save(gets, shares)
        expect(self.page.get_by_role('button', name='Refresh job now')).to_have_count(0)
        expect(self.page.locator('.ps-status')).not_to_contain_text('Refresh job before')
        expect(editor).to_have_value('work | required | Synthetic unsaved checklist edit'); expect(caption).to_have_value('Synthetic unsaved caption')
    def test_sensitive_photo_needs_confirmation_before_sharing(self):
        self.open_job(); answers = [False, True]; prompts = []
        def answer(dialog):
            prompts.append(dialog.message)
            dialog.accept() if answers.pop(0) else dialog.dismiss()
        self.page.on('dialog', answer)
        self.toggle(5).tap(); self.wait_until(lambda: len(prompts) == 1, 'the manager is asked to confirm')
        expect(self.toggle(5)).to_have_attribute('aria-pressed', 'false')
        self.assertEqual(self.share_posts, [], 'dismissing the confirmation sends nothing')
        gets, shares = self.job_gets, self.share_gets
        self.toggle(5).tap(); expect(self.toggle(5)).to_have_attribute('aria-pressed', 'true')
        self.assertIn('progress photo', prompts[0]); self.assertEqual(self.share_posts[0]['confirm'], True); self.assertEqual(self.share_posts[0]['customerVisible'], True)
        self.settle_after_save(gets, shares)
    def test_unconfirmed_change_is_retried_with_the_same_request(self):
        self.post_status = [503, 200]; self.open_job()
        self.toggle(2).tap()
        expect(self.page.locator('.ps-status')).to_contain_text('Retry sends the same change')
        expect(self.toggle(2)).to_be_disabled()
        pending = self.page.evaluate('JSON.parse(sessionStorage.getItem("egc.photo-sharing.pending.v1.zacb.job-1"))')
        self.assertEqual(pending['requestId'], self.share_posts[0]['requestId'])
        gets, shares = self.job_gets, self.share_gets
        self.page.get_by_role('button', name='Retry sharing change').tap()
        expect(self.toggle(2)).to_contain_text('Hidden by Synthetic Owner')
        self.assertEqual(self.share_posts[1], self.share_posts[0], 'the retry is byte-for-byte the original request')
        self.settle_after_save(gets, shares)
        self.assertIsNone(self.page.evaluate('sessionStorage.getItem("egc.photo-sharing.pending.v1.zacb.job-1")'))
    def test_unconfirmed_change_survives_a_reload_until_retried_or_discarded(self):
        self.post_status = [503]; self.open_job()
        self.toggle(3).tap(); expect(self.page.locator('.ps-status')).to_contain_text('Retry sends the same change')
        self.page.reload(); expect(self.page.get_by_role('heading', name='Job photos')).to_be_visible()
        expect(self.page.get_by_role('button', name='Retry sharing change')).to_be_visible()
        for index in range(6): expect(self.toggle(index)).to_be_disabled()
        for name in ['Retry sharing change', 'Discard and load latest']: self.assertGreaterEqual(self.page.get_by_role('button', name=name).bounding_box()['height'], 44)
        self.no_horizontal_scroll()
        shares = self.share_gets; self.page.get_by_role('button', name='Discard and load latest').tap()
        self.wait_until(lambda: self.share_gets > shares, 'discarding loads the latest sharing')
        expect(self.toggle(3)).to_be_enabled(); expect(self.page.get_by_role('button', name='Retry sharing change')).to_have_count(0)
        self.assertIsNone(self.page.evaluate('sessionStorage.getItem("egc.photo-sharing.pending.v1.zacb.job-1")'))
        self.assertEqual(len(self.share_posts), 1, 'nothing was resent')
    def test_revision_conflict_reloads_the_latest_sharing(self):
        self.post_status = [409]; self.open_job(); gets = self.share_gets
        self.toggle(1).tap()
        expect(self.page.locator('.ps-status')).to_contain_text('This job changed on the server')
        expect(self.toggle(1)).to_be_enabled(); self.assertGreater(self.share_gets, gets)
        self.assertIsNone(self.page.evaluate('sessionStorage.getItem("egc.photo-sharing.pending.v1.zacb.job-1")'))
    def test_crew_and_disabled_flag_show_no_sharing_controls(self):
        for status in (403, 404):
            self.share_status = status; self.open_job()
            expect(self.page.locator('.photo-tile')).to_have_count(6)
            self.wait_until(lambda: self.share_gets >= 1, 'the module asks the server once'); self.share_gets = 0
            expect(self.page.locator('.ps-toggle')).to_have_count(0); expect(self.page.locator('.ps-panel')).to_have_count(0)
            self.assertEqual(self.share_posts, [])

if __name__ == '__main__':
    unittest.main(verbosity=2)
