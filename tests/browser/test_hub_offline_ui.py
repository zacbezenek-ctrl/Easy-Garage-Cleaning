"""HUB-PWA: the real employee.html with HUB_OFFLINE_ENABLED on. A crew clock-out made offline is kept on the device,
shown as Pending sync, and reaches the Hub exactly once when the connection returns; the installable Hub registers its
worker and manifest, keeps its versioned files, and a switched-off setting removes both on the next load."""
import copy, json, os, re, unittest
from urllib.parse import urlparse
from playwright.sync_api import expect
from hub_shell_harness import HubShell, CREW, RESULTS, DAY, NOW, JOBS, collections

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
ACTIVE = {'id': 'time-syntheticcrew-1', 'employee': 'Synthetic.Crew', 'employeeName': 'Synthetic Crew', 'role': 'crew', 'status': 'active', 'approvalStatus': 'open',
          'clockInAt': DAY + 'T15:00:00Z', 'clockOutAt': '', 'hourlyRate': 20, 'breaks': [], 'locationTracking': False, 'locationStatus': 'stopped', 'jobLabel': 'Synthetic Johnson Garage'}


class HubOfflineBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self):
        self.errors = []; self.setting = True; self.offline = False; self.posts = []; self.entry = copy.deepcopy(ACTIVE); self.refuse_clock_out = False
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def open_hub(self, view, width=375, height=812, profile=CREW, service_workers='block'):
        mobile = width < 700
        self.profile = profile; self.calls = []; self.api_failures = {}; self.extra_team_messages = []
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=mobile, has_touch=mobile, bypass_csp=True, service_workers=service_workers)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.clock.install(time=NOW)
        self.page.add_init_script('window.__egcJobs=' + json.dumps(JOBS) + ';')
        self.page.route('**/*', self.route)
        self.page.goto(f'{self.url}/employee.html?view={view}')
        self.page.wait_for_function('document.querySelector("#ops-main")?.children.length>0 && window.EGCHubScreens && !document.querySelector(".hub-screen-loading")')
        return self.page

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path.startswith('/api/'):
            # Emulated offline: nothing reaches the Hub, whether or not the browser already refused the request.
            if self.offline: route.abort('internetdisconnected'); return
            def send(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
            if parsed.path == '/api/hub-offline':
                self.calls.append((request.method, parsed.path, parsed.query)); send({'ok': True, 'enabled': self.setting}); return
            if parsed.path == '/api/employee-hub' and request.method == 'POST':
                self.calls.append((request.method, parsed.path, parsed.query))
                body = request.post_data_json or {}; self.posts.append(body)
                if self.refuse_clock_out and body.get('collection') == 'timeEntries' and body.get('data', {}).get('clockOutAt'):
                    send({'ok': False, 'code': 'EMPLOYEE_TIMECARD_DEVICE_TIME', 'error': 'Offline clock times are not enabled. Record it again now or ask a manager for a time correction.'}, 409); return
                if self.entry and body.get('collection') == 'timeEntries' and body.get('id') == self.entry['id']:
                    self.entry.update({key: value for key, value in body.get('data', {}).items() if key != 'deviceCapturedAt'})
                    send({'ok': True, 'record': self.entry}); return
                send({'ok': True, 'record': body.get('data') or {}}); return
            if parsed.path == '/api/employee-hub' and request.method == 'GET':
                self.calls.append((request.method, parsed.path, parsed.query))
                data = collections(self.profile); data['timeEntries'] = [copy.deepcopy(self.entry)] if self.entry else []
                send({'ok': True, 'collections': data, 'accounts': []}); return
        super().route(route)

    def open_tab(self, view):
        # A second Hub tab in the same browser: it shares the device's IndexedDB queue (and Web Locks) with the first.
        page = self.context.new_page(); page.set_default_timeout(7000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.clock.install(time=NOW)
        page.add_init_script('window.__egcJobs=' + json.dumps(JOBS) + ';')
        page.route('**/*', self.route)
        page.goto(f'{self.url}/employee.html?view={view}')
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0 && window.EGCHubScreens && !document.querySelector(".hub-screen-loading")')
        return page

    def settle(self, quiet=500, limit=40):
        # The Hub's own load-time saves (chat read markers) and the refresh after them finish before the network changes.
        seen = -1
        for _ in range(limit):
            if len(self.calls) == seen: return
            seen = len(self.calls); self.page.wait_for_timeout(quiet)

    def employee_posts(self, collection='timeEntries'):
        return [body for body in self.posts if body.get('collection') == collection]

    def test_offline_clock_out_is_queued_then_sent_exactly_once_when_online(self):
        page = self.open_hub('my_day')
        page.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        clock_out = page.locator('.ops-clock-card button', has_text='Clock out')
        expect(clock_out).to_be_visible()
        self.settle()
        self.offline = True; self.context.set_offline(True)
        clock_out.click()
        chip = page.locator('.egc-hub-sync')
        expect(chip.locator('.hs-label')).to_have_text('Pending sync · 1')
        expect(page.locator('#toast')).to_contain_text('Clock-out saved on this device')
        self.assertEqual(self.employee_posts(), [], 'nothing reached the Hub while offline')
        expect(page.locator('.ops-clock-card')).to_contain_text('Ready when you are')
        box = chip.locator('button').bounding_box()
        self.assertGreaterEqual(box['height'], 44); self.assertLessEqual(box['x'] + box['width'], 375)
        scroll = self.no_horizontal_scroll(); self.assertLessEqual(scroll['width'], 375, scroll)
        page.wait_for_timeout(3000)  # let the confirmation toast leave before the chip screenshot
        page.screenshot(path=str(RESULTS / 'hub-offline-chip-375.png'))
        chip.locator('button').click()
        panel = page.get_by_role('dialog', name='Pending sync')
        expect(panel).to_be_visible()
        expect(panel).to_contain_text('You are offline')
        expect(panel.locator('.hs-list li')).to_have_count(1)
        expect(panel.locator('.hs-list li')).to_contain_text('Clock out')
        expect(panel.locator('.hs-list li')).to_contain_text('Waiting for a connection')
        expect(panel.get_by_role('button', name='Sync now')).to_be_disabled()
        panel_box = panel.bounding_box(); self.assertLessEqual(panel_box['x'] + panel_box['width'], 375)
        self.assertEqual([target for target in page.evaluate("[...document.querySelectorAll('.hs-panel button')].filter(b=>b.getBoundingClientRect().height<44).map(b=>b.textContent)")], [])
        page.screenshot(path=str(RESULTS / 'hub-offline-pending-375.png'))
        panel.get_by_role('button', name='Close').click()
        expect(panel).to_be_hidden()

        self.offline = False; self.context.set_offline(False)
        expect(chip).to_be_hidden()
        posts = self.employee_posts()
        self.assertEqual(len(posts), 1, posts)
        sent = posts[0]
        self.assertEqual(sent['id'], ACTIVE['id']); self.assertRegex(sent['requestId'], UUID)
        self.assertEqual(sent['data']['status'], 'submitted'); self.assertEqual(sent['data']['approvalStatus'], 'pending')
        self.assertEqual(sent['data']['deviceCapturedAt'], sent['data']['clockOutAt'], 'the crew clock-out carries the time it was recorded')
        self.assertTrue(sent['data']['clockOutAt'].startswith('2026-09-22T18:0'), sent['data']['clockOutAt'])
        # Every later trigger finds nothing waiting: the visible page, another online event and the periodic check.
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'))")
        page.clock.run_for(61000)
        page.wait_for_timeout(300)
        self.assertEqual(len(self.employee_posts()), 1, 'exactly one POST for the queued clock-out')
        self.assertEqual(page.evaluate('window.EGCHubOffline.state().pending.length'), 0)
        rows = page.evaluate("""new Promise(resolve=>{const open=indexedDB.open('egc-hub-offline');open.onsuccess=()=>{const tx=open.result.transaction('requests','readonly'),all=tx.objectStore('requests').getAll();all.onsuccess=()=>resolve(all.result.length);};})""")
        self.assertEqual(rows, 0, 'the device copy is removed once the Hub confirms it')

    def test_refused_offline_clock_out_says_not_saved_and_keeps_location_paused_until_resumed(self):
        page = self.open_hub('my_day')
        page.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        card = page.locator('.ops-clock-card')
        expect(card.locator('button', has_text='Clock out')).to_be_visible()
        self.settle()
        self.offline = True; self.context.set_offline(True)
        card.locator('button', has_text='Clock out').click()
        expect(page.locator('.egc-hub-sync .hs-label')).to_have_text('Pending sync · 1')
        expect(card).to_contain_text('Ready when you are')
        # The Hub refuses it when the connection returns: the shift is still open, and the card says so.
        self.refuse_clock_out = True
        self.offline = False; self.context.set_offline(False)
        expect(card).to_contain_text('Clock-out not saved — clock out again')
        expect(card).to_contain_text('Location paused')
        expect(page.locator('.egc-hub-sync .hs-label')).to_have_text('1 not saved')
        self.assertEqual(self.entry['status'], 'active')
        self.assertEqual(len([body for body in self.employee_posts() if body.get('data', {}).get('clockOutAt')]), 1, 'the refused clock-out was sent once and dropped')
        resume = card.get_by_role('button', name='Resume location')
        expect(resume).to_be_visible()
        expect(card.get_by_role('button', name='Clock out')).to_be_visible()
        heights = page.evaluate("[...document.querySelectorAll('.ops-clock-card button')].map(b=>Math.round(b.getBoundingClientRect().height))")
        self.assertTrue(heights and all(height >= 44 for height in heights), heights)
        scroll = self.no_horizontal_scroll(); self.assertLessEqual(scroll['width'], 375, scroll)
        page.wait_for_timeout(3000)  # let the refusal toast leave before the screenshot
        page.screenshot(path=str(RESULTS / 'hub-offline-clockout-not-saved-375.png'))
        # A reload of the Hub's records keeps it paused.
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        self.settle()
        expect(card).to_contain_text('Clock-out not saved — clock out again')
        resume.click()
        expect(page.locator('#toast')).to_contain_text('Shift location is on again')
        expect(card).not_to_contain_text('Clock-out not saved')
        expect(card).not_to_contain_text('Location paused')
        self.assertIsNone(page.evaluate("sessionStorage.getItem('egc_hub_location_paused')"))

    def test_a_hidden_tab_sends_no_position_after_another_tab_replays_its_clock_out(self):
        # Shift location is on in two Hub tabs. Tab A clocks out with no signal and, once the signal is back, sends it before
        # tab B (in the background, so it never polls) takes any position fix. Tab B's next fix sends nothing.
        self.entry.update({'locationTracking': True, 'locationStatus': 'tracking'})
        page = self.open_hub('my_day')
        self.context.grant_permissions(['geolocation']); self.context.set_geolocation({'latitude': 40.58, 'longitude': -105.08, 'accuracy': 5})
        page.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        other = self.open_tab('my_day')
        other.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        other.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true})")
        for tab in (page, other): expect(tab.locator('.ops-clock-card')).to_contain_text('Location sharing on')
        self.settle()
        self.assertTrue(any(body.get('data', {}).get('lastLocation') for body in self.posts), 'the watches send positions while the shift is open')
        self.offline = True; self.context.set_offline(True)
        page.locator('.ops-clock-card button', has_text='Clock out').click()
        expect(page.locator('#toast')).to_contain_text('Clock-out saved on this device')
        expect(other.locator('.ops-clock-card')).to_contain_text('CLOCKED IN')
        self.offline = False; self.context.set_offline(False)
        expect(page.locator('.egc-hub-sync')).to_be_hidden()
        self.settle()
        out = [index for index, body in enumerate(self.posts) if body.get('data', {}).get('clockOutAt')]
        self.assertEqual(len(out), 1, 'tab A sent the clock-out once')
        self.assertEqual(self.entry['status'], 'submitted')
        rows = other.evaluate("""new Promise(resolve=>{const open=indexedDB.open('egc-hub-offline');open.onsuccess=()=>{const tx=open.result.transaction('requests','readonly'),all=tx.objectStore('requests').getAll();all.onsuccess=()=>resolve(all.result.length);};})""")
        self.assertEqual(rows, 0, 'nothing is queued any more')
        # A minute later tab B's watch takes a position fix.
        other.clock.fast_forward(61000)
        self.context.set_geolocation({'latitude': 40.7, 'longitude': -105.2, 'accuracy': 5})
        expect(other.locator('.ops-clock-card')).to_contain_text('Ready when you are')
        other.clock.fast_forward(61000)
        self.context.set_geolocation({'latitude': 40.71, 'longitude': -105.21, 'accuracy': 5})
        self.settle()
        after = [body for body in self.posts[out[0] + 1:] if body.get('collection') == 'timeEntries']
        self.assertEqual(after, [], 'no position left the phone after the clock-out')

    def test_an_offline_shift_discarded_from_pending_sync_takes_its_clock_out_and_the_confirm_fits_a_phone(self):
        # No shift is open: the crew member clocks in and out with no signal, then discards the whole shift.
        self.entry = None
        page = self.open_hub('my_day')
        page.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        self.context.grant_permissions(['geolocation']); self.context.set_geolocation({'latitude': 40.58, 'longitude': -105.08, 'accuracy': 5})
        card = page.locator('.ops-clock-card')
        expect(card).to_contain_text('Ready when you are')
        self.settle()
        self.offline = True; self.context.set_offline(True)
        card.get_by_role('button', name='Clock in + start shift location').click()
        expect(page.locator('#toast')).to_contain_text('Clock-in saved on this device')
        card.locator('button', has_text='Clock out').click()
        chip = page.locator('.egc-hub-sync')
        expect(chip.locator('.hs-label')).to_have_text('Pending sync · 2')
        chip.locator('button').click()
        panel = page.get_by_role('dialog', name='Pending sync')
        rows = panel.locator('.hs-list li')
        expect(rows).to_have_count(2)
        expect(rows.nth(0)).to_contain_text('Clock in'); expect(rows.nth(1)).to_contain_text('Clock out')
        discard = rows.nth(0).locator('.hs-discard')
        before = discard.bounding_box()
        discard.click()
        expect(discard).to_have_text('Tap again to discard this shift')
        after = discard.bounding_box()
        # The longer confirm label wraps inside the button, which stays under the thumb, on the screen and 44px tall.
        tap = (before['x'] + before['width'] / 2, before['y'] + before['height'] / 2)
        self.assertTrue(after['x'] <= tap[0] <= after['x'] + after['width'] and after['y'] <= tap[1] <= after['y'] + after['height'], (before, after))
        self.assertGreaterEqual(after['height'], 44); self.assertLessEqual(after['x'] + after['width'], 375)
        self.assertGreaterEqual(rows.nth(0).locator('div').first.bounding_box()['width'], 120, 'the action and its time stay readable beside it')
        scroll = self.no_horizontal_scroll(); self.assertLessEqual(scroll['width'], 375, scroll)
        page.screenshot(path=str(RESULTS / 'hub-offline-discard-shift-375.png'))
        discard.click()
        expect(rows).to_have_count(0)
        expect(panel).to_contain_text('Nothing is waiting to send.')
        panel.get_by_role('button', name='Close').click()
        expect(chip).to_be_hidden()
        self.offline = False; self.context.set_offline(False)
        page.evaluate("window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))")
        self.settle()
        self.assertEqual(self.employee_posts(), [], 'nothing about the discarded shift reached the Hub')
        self.assertEqual(page.evaluate('window.EGCHubOffline.state().refused.length'), 0, 'and no notice about a clock-out for a shift the Hub never had')
        expect(card).to_contain_text('Ready when you are')

    def test_offline_chat_message_is_queued_and_replayed_once(self):
        page = self.open_hub('crew_chat')
        page.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        self.settle()
        self.offline = True; self.context.set_offline(True)
        compose = page.locator('.ops-chat-compose')
        compose.locator('textarea, input[name=body]').first.fill('Synthetic running ten minutes late')
        compose.get_by_role('button').last.click()
        expect(page.locator('.egc-hub-sync .hs-label')).to_have_text('Pending sync · 1')
        expect(page.locator('.ops-chat-messages')).to_contain_text('Synthetic running ten minutes late')
        self.assertEqual(self.employee_posts('teamMessages'), [])
        self.offline = False; self.context.set_offline(False)
        expect(page.locator('.egc-hub-sync')).to_be_hidden()
        posts = self.employee_posts('teamMessages')
        self.assertEqual(len(posts), 1); self.assertEqual(posts[0]['data']['body'], 'Synthetic running ten minutes late'); self.assertRegex(posts[0]['requestId'], UUID)
        self.assertNotIn('deviceCapturedAt', posts[0]['data'])

    def test_installable_hub_registers_its_worker_keeps_versioned_files_and_is_removed_when_switched_off(self):
        page = self.open_hub('my_day', service_workers='allow')
        page.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        expect(page.locator('link[rel="manifest"]')).to_have_attribute('href', '/employee.webmanifest')
        script = page.evaluate("""async()=>{for(let i=0;i<400;i++){const r=await navigator.serviceWorker.getRegistration('/');const w=r&&(r.active||r.waiting||r.installing);if(w&&r.active)return {script:r.active.scriptURL,scope:r.scope};await new Promise(res=>setTimeout(res,50));}return null;}""")
        self.assertIsNotNone(script)
        self.assertTrue(script['script'].endswith('/hub-sw.js')); self.assertEqual(urlparse(script['scope']).path, '/')
        page.reload()
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0 && navigator.serviceWorker.controller')
        kept = page.evaluate("""async()=>{for(let i=0;i<400;i++){const names=await caches.keys(),name=names.find(n=>n.startsWith('egc-hub-assets-'));if(name){const keys=(await (await caches.open(name)).keys()).map(r=>new URL(r.url).pathname+new URL(r.url).search);if(keys.some(k=>k.startsWith('/employee-suite.js?v=')))return {name,keys};}await new Promise(res=>setTimeout(res,50));}return null;}""")
        self.assertIsNotNone(kept, 'the worker keeps the versioned Hub files from a signed-in load')
        self.assertEqual(kept['name'], 'egc-hub-assets-20260929hubpwa')
        self.assertTrue(all(re.match(r'^/employee-[A-Za-z0-9_-]+\.(js|css)\?v=', key) for key in kept['keys']), kept['keys'])
        self.assertFalse(any(key.startswith('/employee.html') or key.startswith('/api/') for key in kept['keys']))

        self.setting = False
        page.reload()
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0')
        removed = page.evaluate("""async()=>{for(let i=0;i<400;i++){const regs=await navigator.serviceWorker.getRegistrations(),names=await caches.keys();if(!regs.length&&!names.some(n=>n.startsWith('egc-hub-assets-')))return true;await new Promise(res=>setTimeout(res,50));}return false;}""")
        self.assertTrue(removed, 'switching the setting off removes the worker and its file cache on the next load')
        expect(page.locator('link[rel="manifest"]')).to_have_count(0)
        self.assertFalse(page.evaluate('window.EGCHubOffline.state().enabled'))


    def test_signing_out_clears_the_device_copies_of_hub_files_and_keeps_the_worker(self):
        page = self.open_hub('my_day', service_workers='allow')
        page.wait_for_function('window.EGCHubOffline && window.EGCHubOffline.state().enabled')
        page.wait_for_function("navigator.serviceWorker.getRegistration('/').then(r=>Boolean(r&&r.active))")
        page.reload()
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0 && navigator.serviceWorker.controller')
        copies = """async()=>{const names=(await caches.keys()).filter(n=>n.startsWith('egc-hub-assets-'));let keys=[];for(const name of names)keys=keys.concat((await (await caches.open(name)).keys()).map(r=>new URL(r.url).pathname));return {names,keys};}"""
        kept = page.evaluate("""async()=>{for(let i=0;i<400;i++){const names=await caches.keys(),name=names.find(n=>n.startsWith('egc-hub-assets-'));if(name&&(await (await caches.open(name)).keys()).some(r=>new URL(r.url).pathname==='/employee-suite.js'))return true;await new Promise(res=>setTimeout(res,50));}return false;}""")
        self.assertTrue(kept, 'the signed-in load kept the Hub files')
        page.evaluate('doLogout()')
        cleared = page.evaluate("""async()=>{for(let i=0;i<400;i++){const c=await (%s)();if(c.names.length&&!c.keys.length)return c;await new Promise(res=>setTimeout(res,50));}return (%s)();}""" % (copies, copies))
        self.assertEqual(cleared['keys'], [], 'signing out clears every device copy of a Hub file')
        self.assertEqual(cleared['names'], ['egc-hub-assets-20260929hubpwa'], 'the file cache itself stays, so the next sign-in keeps copies again')
        self.assertTrue(page.evaluate("navigator.serviceWorker.getRegistration('/').then(r=>Boolean(r&&r.active))"), 'the worker stays installed')

if __name__ == '__main__':
    unittest.main()
