"""P3-04 follow-up owner settings: the registered Hub screen mounted standalone with the UI kit, on a phone first.
Every API call is a routed synthetic fixture; nothing leaves 127.0.0.1."""
import copy, json, os, pathlib, re, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from hub_shell_harness import HubShell, MANAGER

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
NOW = datetime(2026, 9, 22, 5, 30, tzinfo=timezone.utc)  # 11:30 PM Sept 21 in Denver, 2:30 PM Sept 22 in Tokyo
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
WINDOW = {'startHour': 8, 'endHour': 19, 'timeZone': 'America/Denver'}
CANDIDATES = [{'id': 'ZacB', 'name': 'Synthetic Owner', 'role': 'owner', 'businessAccess': True}, {'id': 'TylerG', 'name': 'Synthetic Manager', 'role': 'manager', 'businessAccess': True},
              {'id': 'Zoe.Synthetic', 'name': 'Synthetic Zoe', 'role': 'sales', 'businessAccess': False}, {'id': 'Phone.Person', 'name': 'Synthetic Phone Person With A Long Display Name', 'role': 'phone', 'businessAccess': False}]
PAGE = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-followup-settings.css"></head>'
        '<body style="margin:0;padding:12px;background:#f1f0ec"><main id="host"></main><script src="/employee-ui-kit.js"></script><script src="/employee-followup-settings.js"></script>'
        '<script>window.__toasts=[];sessionStorage.setItem("egc_u","zacb");EGCFollowupSettings.mount(document.querySelector("#host"),{identity:"zacb",toast:t=>window.__toasts.push(t)});</script></body></html>').encode()


def view(settings=None, revision='', can_edit=True, followup=None, policy_enabled=True):
    blocked = {'enabled': False, 'ownerId': None, 'ownerRole': None, 'ownerSource': 'unresolved', 'dueMinutes': 240, 'dueSource': 'default', 'sendWindow': WINDOW, 'blockedReason': 'followup_owner_unresolved'}
    return {'ok': True, 'authority': 'employee_hub', 'timeZone': 'America/Denver', 'policyEnabled': policy_enabled, 'staffMembers': True, 'canEdit': can_edit, 'revision': revision,
            'settings': settings, 'fallback': {'ownerId': None, 'role': None}, 'followup': followup or blocked, 'candidates': copy.deepcopy(CANDIDATES),
            'limits': {'dueMinutes': {'min': 15, 'max': 10080, 'default': 240}, 'sendWindow': {'earliest': 8, 'latest': 21}}, 'coverage': {'complete': True, 'asOf': '2026-09-22T05:30:00.000Z'}}


def saved_view(body, revision='rev-2'):
    window = {**body['sendWindow'], 'timeZone': 'America/Denver'}
    settings = {'ownerId': body['ownerId'], 'dueMinutes': body['dueMinutes'], 'sendWindow': window, 'updatedBy': 'zacb', 'updatedAt': '2026-09-22T05:30:00.000Z'}
    followup = {'enabled': True, 'ownerId': body['ownerId'], 'ownerRole': 'sales', 'ownerSource': 'settings', 'dueMinutes': body['dueMinutes'], 'dueSource': 'settings', 'sendWindow': window, 'blockedReason': None}
    return {**view(settings, revision, followup=followup), 'requestId': body['requestId']}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/followups':
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(PAGE)
        else: super().do_GET()


class FollowupSettingsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.errors = []; self.gets = 0; self.posts = []; self.get_replies = []; self.post_replies = []; self.current = view()
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def open(self, width=375, height=812):
        mobile = width < 700
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(5000); self.page.clock.install(time=NOW)
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
        self.page.goto(self.url + '/followups')
        return self.page
    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/operations-followup-settings':
            if request.method == 'GET':
                self.gets += 1
                if self.get_replies: status, data = self.get_replies.pop(0); send(data, status); return
                send(self.current); return
            body = request.post_data_json; self.posts.append(body)
            if self.post_replies: status, data = self.post_replies.pop(0); send(data, status); return
            self.current = saved_view(body); send(self.current); return
        if parsed.path.startswith('/api/'): send({'ok': False, 'code': 'synthetic_unrouted', 'error': 'Synthetic unrouted API'}, 503); return
        route.continue_()
    def layout_problems(self, width):
        self.page.set_viewport_size({'width': width, 'height': 812})
        problems = []
        scroll = self.page.evaluate('document.documentElement.scrollWidth')
        if scroll > width: problems.append(f'{width}: page scrolls sideways to {scroll}px')
        problems += self.page.evaluate('''()=>[...document.querySelectorAll('.egc-followups button,.egc-followups select')].filter(el=>el.getBoundingClientRect().height>0&&el.getBoundingClientRect().height<43.5).map(el=>el.tagName+' '+el.textContent.trim().slice(0,30)+' '+el.getBoundingClientRect().height)''')
        problems += self.page.evaluate('''()=>[...document.querySelectorAll('.egc-followups input,.egc-followups select,.egc-followups textarea')].filter(el=>parseFloat(getComputedStyle(el).fontSize)<16).map(el=>el.name+' '+getComputedStyle(el).fontSize)''')
        return problems

    def test_phone_layout_shows_the_blocked_policy_and_eligible_owners(self):
        page = self.open()
        expect(page.locator('[data-fu-state=blocked]')).to_contain_text('Follow-ups have no owner yet')
        expect(page.locator('[data-fu-state=blocked]')).to_contain_text('No follow-up owner is set')
        owner = page.locator('select[name=ownerId]')
        self.assertEqual(owner.locator('option').all_text_contents(), ['Cloudflare fallback', 'Synthetic Owner · Owner', 'Synthetic Manager · Manager', 'Synthetic Zoe · Sales', 'Synthetic Phone Person With A Long Display Name · Phone'])
        due = page.locator('input[name=dueMinutes]')
        self.assertEqual([due.get_attribute('type'), due.get_attribute('inputmode'), due.input_value()], ['number', 'numeric', '240'])
        expect(page.locator('.fu-form')).to_contain_text('= 4 hours')
        self.assertEqual(page.locator('select[name=startHour] option').first.text_content(), '8 AM')
        self.assertEqual(page.locator('select[name=endHour] option').last.text_content(), '9 PM')
        expect(page.locator('button[type=submit]')).to_be_disabled()
        problems = []
        for width in (320, 375, 390): problems += self.layout_problems(width)
        self.assertEqual(problems, [])
        page.screenshot(path=str(RESULTS / 'followup-settings-375.png'), full_page=True)
        self.assertTrue(page.evaluate('EGCFollowupSettings.canLeave()'))

    def test_owner_saves_with_a_request_id_and_the_status_updates(self):
        page = self.open()
        page.locator('select[name=ownerId]').select_option('Zoe.Synthetic')
        page.locator('input[name=dueMinutes]').fill('90')
        expect(page.locator('.fu-form')).to_contain_text('= 1 hour 30 minutes')
        page.locator('select[name=startHour]').select_option('9'); page.locator('select[name=endHour]').select_option('18')
        page.locator('textarea[name=reason]').fill('Zoe covers walkthrough follow-ups')
        self.assertFalse(page.evaluate('EGCFollowupSettings.canLeave()'), 'an unsaved draft blocks leaving the screen')
        page.evaluate('EGCFollowupSettings.refresh()')
        self.assertEqual([self.gets, page.locator('select[name=ownerId]').input_value()], [1, 'Zoe.Synthetic'], 'a shell refresh never replaces an unsaved draft')
        page.locator('button[type=submit]').click()
        expect(page.locator('[data-fu-state=enabled]')).to_contain_text('Synthetic Zoe owns follow-ups')
        expect(page.locator('[data-fu-state=enabled]')).to_contain_text('Due 1 hour 30 minutes after the walkthrough or call, moved into 9 AM–6 PM Denver time.')
        self.assertEqual(len(self.posts), 1)
        body = self.posts[0]
        self.assertRegex(body['requestId'], UUID)
        self.assertEqual({k: v for k, v in body.items() if k != 'requestId'}, {'expectedRevision': '', 'ownerId': 'Zoe.Synthetic', 'dueMinutes': 90, 'sendWindow': {'startHour': 9, 'endHour': 18}, 'reason': 'Zoe covers walkthrough follow-ups'})
        self.assertEqual(page.evaluate('window.__toasts'), ['Follow-up settings saved.'])
        expect(page.locator('.fu-status')).to_contain_text('Last changed by zacb · Sep 21, 2026, 11:30 PM')
        self.assertTrue(page.evaluate('EGCFollowupSettings.canLeave()'))
        expect(page.locator('button[type=submit]')).to_be_disabled()
        page.evaluate('EGCFollowupSettings.refresh()')
        expect(page.locator('[data-fu-state=enabled]')).to_contain_text('Synthetic Zoe owns follow-ups')
        self.assertEqual(self.gets, 2)
        self.assertEqual(self.layout_problems(375), [])
        page.screenshot(path=str(RESULTS / 'followup-settings-saved-375.png'), full_page=True)

    def test_a_lost_save_is_retried_with_the_same_request_id(self):
        page = self.open()
        self.post_replies = [(503, {'ok': False, 'code': 'followup_settings_outcome_unknown', 'error': 'The save could not be verified. Retry the same save to safely check whether it applied.'})]
        page.locator('select[name=ownerId]').select_option('Zoe.Synthetic')
        page.locator('button[type=submit]').click()
        pending = page.locator('[data-fu-pending]')
        expect(pending).to_contain_text('A save is waiting to be confirmed')
        expect(page.locator('select[name=ownerId]')).to_be_disabled()
        pending.get_by_role('button', name='Retry original save').click()
        expect(page.locator('[data-fu-state=enabled]')).to_contain_text('Synthetic Zoe owns follow-ups')
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(self.posts[0], self.posts[1], 'the retry is byte-identical, same requestId')
        expect(page.locator('[data-fu-pending]')).to_have_count(0)

    def test_a_revision_conflict_keeps_the_draft_until_the_owner_loads_the_latest(self):
        page = self.open()
        self.post_replies = [(409, {'ok': False, 'code': 'followup_settings_revision_conflict', 'error': 'The follow-up settings changed since you opened them. Load the latest before saving.', 'details': {'currentRevision': 'rev-9'}})]
        page.locator('select[name=ownerId]').select_option('Phone.Person')
        page.locator('button[type=submit]').click()
        conflict = page.locator('[data-fu-conflict]')
        expect(conflict).to_contain_text('These settings changed while you were editing')
        self.assertEqual(page.locator('select[name=ownerId]').input_value(), 'Phone.Person', 'the draft stays on screen')
        self.current = view({'ownerId': 'TylerG', 'dueMinutes': 60, 'sendWindow': WINDOW, 'updatedBy': 'zacb', 'updatedAt': '2026-09-22T05:00:00.000Z'}, 'rev-9',
                            followup={'enabled': True, 'ownerId': 'TylerG', 'ownerRole': 'manager', 'ownerSource': 'settings', 'dueMinutes': 60, 'dueSource': 'settings', 'sendWindow': WINDOW, 'blockedReason': None})
        conflict.get_by_role('button', name='Discard draft and load latest').click()
        expect(page.locator('[data-fu-state=enabled]')).to_contain_text('Synthetic Manager owns follow-ups')
        self.assertEqual(page.locator('select[name=ownerId]').input_value(), 'TylerG')
        self.assertEqual(page.locator('input[name=dueMinutes]').input_value(), '60')
        self.assertEqual(len(self.posts), 1)

    def test_an_unavailable_or_unverified_load_shows_retry_never_an_empty_policy(self):
        self.get_replies = [(503, {'ok': False, 'code': 'followup_settings_unavailable', 'error': 'The follow-up settings could not be verified. Keep your change and retry the same save.'}),
                            (200, {**view(), 'coverage': {'complete': False}})]
        page = self.open()
        alert = page.locator('.egc-followups [role=alert]')
        expect(alert).to_contain_text('Follow-up settings are unavailable')
        expect(alert).to_contain_text('could not be verified')
        expect(page.locator('select[name=ownerId]')).to_have_count(0)
        alert.get_by_role('button', name='Retry').click()
        expect(page.locator('.egc-followups [role=alert]')).to_contain_text('The Hub response was incomplete')
        expect(page.locator('select[name=ownerId]')).to_have_count(0)
        page.locator('.egc-followups [role=alert]').get_by_role('button', name='Retry').click()
        expect(page.locator('[data-fu-state=blocked]')).to_be_visible()
        self.assertEqual(self.gets, 3)

    def test_a_manager_sees_the_policy_read_only(self):
        self.current = view(can_edit=False, policy_enabled=False)
        page = self.open()
        expect(page.locator('.egc-followups')).to_contain_text('Only the owner can change these settings.')
        expect(page.locator('.egc-followups')).to_contain_text('Policy is off')
        for name in ('ownerId', 'dueMinutes', 'startHour', 'endHour', 'reason'): expect(page.locator(f'[name={name}]')).to_be_disabled()
        expect(page.locator('button[type=submit]')).to_be_disabled()

    def test_the_blocked_heading_names_the_cause_and_the_staff_flag(self):
        blocked = lambda reason, owner=None: {'enabled': False, 'ownerId': owner, 'ownerRole': None, 'ownerSource': 'settings', 'dueMinutes': 240, 'dueSource': 'default', 'sendWindow': WINDOW, 'blockedReason': reason}
        self.get_replies = [(200, {**view({'ownerId': 'Zoe.Synthetic', 'dueMinutes': 5, 'sendWindow': WINDOW}, 'rev-1', followup=blocked('followup_due_rule_invalid')), 'staffMembers': False}),
                            (200, {**view({'ownerId': 'Pat.Phone', 'dueMinutes': 240, 'sendWindow': WINDOW}, 'rev-2', followup=blocked('followup_owner_staff_disabled')), 'staffMembers': False})]
        page = self.open()
        state = page.locator('[data-fu-state=blocked]')
        expect(state).to_contain_text('Follow-up policy is blocked')
        expect(state).to_contain_text('The saved due time is out of range')
        expect(state).not_to_contain_text('no owner yet')
        page.evaluate('EGCFollowupSettings.refresh()')
        expect(state).to_contain_text('Follow-ups have no owner yet')
        expect(state).to_contain_text('staff owners are off. Set EGC_OPERATIONS_STAFF_MEMBERS to true in Cloudflare')
        self.assertIn('Pat.Phone (not assignable)', page.locator('select[name=ownerId] option').all_text_contents())
        self.assertEqual(self.layout_problems(375), [])

    def test_desktop_layout(self):
        page = self.open(1280, 900)
        expect(page.locator('[data-fu-state=blocked]')).to_be_visible()
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 1280)
        page.screenshot(path=str(RESULTS / 'followup-settings-desktop.png'), full_page=True)



class FollowupSettingsInHubShellTests(HubShell, unittest.TestCase):
    """The real employee.html shell loads the screen through the registry MANIFEST, for the owner only."""
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])
    def route(self, route):
        parsed = urlparse(route.request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/operations-followup-settings':
            route.fulfill(status=200, content_type='application/json', body=json.dumps(view())); return
        super().route(route)

    def test_the_owner_opens_it_from_the_system_group_on_a_phone(self):
        page = self.open('followup_settings', width=375, height=812, profile={**MANAGER, 'owner': True})
        views = self.nav_views()
        self.assertIn('followup_settings', views)
        self.assertEqual(views[views.index('followup_settings') - 1], 'settings', 'listed after Integrations in SYSTEM')
        expect(page.locator('#ops-title')).to_have_text('Follow-up owner')
        expect(page.locator('#ops-main [data-fu-state=blocked]')).to_be_visible()
        self.assertEqual(page.locator('script[data-egc-hub-asset="employee-followup-settings.js"]').count(), 1, 'loaded lazily by the registry')
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll)
        self.assertEqual(self.small_targets('.egc-followups') + self.small_inputs('.egc-followups'), [])
        page.screenshot(path=str(RESULTS / 'followup-settings-shell-375.png'))

    def test_a_manager_without_the_owner_flag_never_gets_the_screen(self):
        page = self.open('followup_settings', width=375, height=812, profile=MANAGER)
        self.assertNotIn('followup_settings', self.nav_views())
        self.assertNotEqual(page.evaluate('new URLSearchParams(location.search).get("view")'), 'followup_settings', 'the deep link falls back to a permitted view')
        self.assertEqual(page.locator('.egc-followups').count(), 0)
        self.assertNotIn(('GET', '/api/operations-followup-settings', ''), self.calls)

if __name__ == '__main__':
    unittest.main()
