"""The real employee.html shell with a registered fixture screen: lazy loading, the shared action dialog,
?view= history, draft safety during background refreshes, and layout at phone and desktop widths."""
import re, unittest
from playwright.sync_api import expect
from hub_shell_harness import HubShell, MANAGER, CREW, RESULTS


class HubShellBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def test_registered_screen_loads_lazily_and_fits_phone_and_desktop(self):
        for width in (390, 1360):
            with self.subTest(width=width):
                page = self.open('fixture_screen', width=width, height=900)
                expect(page.locator('.fixture-screen h1')).to_have_text('Fixture screen')
                expect(page.locator('#mode-screen')).to_be_hidden()
                expect(page.locator('#ops-title')).to_have_text('Fixture screen')
                expect(page.locator('#ops-kicker')).to_have_text('SYSTEM')
                assets = page.evaluate("[...document.querySelectorAll('[data-egc-hub-asset]')].map(node=>node.getAttribute('src')||node.getAttribute('href')).sort()")
                self.assertEqual(assets, ['employee-ui-kit.css?v=20260929mobilehub', 'employee-ui-kit.js?v=20260929mobilehub', 'fixture-screen.js?v=test'])
                self.assertGreaterEqual(page.locator('.fixture-screen .hub-btn').first.bounding_box()['height'], 44)
                font = page.locator('.fixture-screen input[name=phone]').evaluate('el=>getComputedStyle(el).fontSize')
                # MOBILE-HUB (TABLET-01): 16px at every width, not only phones; iOS zooms into anything smaller on an iPad too.
                self.assertEqual(font, '16px')
                scroll = self.no_horizontal_scroll()
                self.assertLessEqual(scroll['width'], width, scroll)
                table = page.locator('.fixture-screen .hub-table-scroll')
                self.assertLessEqual(table.bounding_box()['x'] + table.bounding_box()['width'], width)
                if width < 700:
                    self.assertEqual(self.small_targets('.fixture-screen'), [])
                    page.locator('.ops-menu').click()
                expect(page.locator('.ops-nav [data-ops-tab="fixture_screen"]')).to_be_visible()
                expect(page.locator('.ops-nav [data-ops-tab="fixture_screen"]')).to_have_class(re.compile('active'))
                page.screenshot(path=str(RESULTS / f'hub-shell-fixture-{width}.png'), full_page=True)
                self.close_page()

    def test_back_and_forward_move_between_views_and_reload_keeps_the_view(self):
        page = self.open('today', width=390)
        expect(page.locator('#ops-title')).to_have_text('Command center')
        expect(page.locator('.ops-nav [data-ops-tab="safety"] span')).to_have_text('Safety & equipment')
        expect(page.locator('.ops-nav [data-ops-tab="finance"] span')).to_have_text('Estimates & payments')
        self.go('customers')
        self.go('fixture_screen')
        expect(page.locator('.fixture-screen')).to_be_visible()
        page.go_back()
        expect(page).to_have_url(re.compile(r'\?view=customers$'))
        expect(page.locator('#ops-title')).to_have_text('Customers')
        expect(page.locator('.fixture-screen')).to_have_count(0)
        page.go_back()
        expect(page.locator('#ops-title')).to_have_text('Command center')
        page.go_forward()
        expect(page.locator('#ops-title')).to_have_text('Customers')
        self.assertEqual(page.evaluate('history.length'), 4, 'about:blank, the entry view (replaced, not pushed) and two views')
        page.reload()
        expect(page.locator('#ops-title')).to_have_text('Customers')
        expect(page.locator('#mode-screen')).to_be_hidden()

    def test_unsaved_screen_blocks_navigation_and_the_back_gesture(self):
        page = self.open('today', width=390)
        self.go('fixture_screen')
        page.locator('.fixture-screen input[name=phone]').fill('9705550100')
        page.evaluate("opsGo('customers')")
        expect(page.locator('#toast')).to_contain_text('Finish or save the changes')
        expect(page.locator('#ops-title')).to_have_text('Fixture screen')
        page.go_back()
        expect(page).to_have_url(re.compile(r'\?view=fixture_screen$'))
        expect(page.locator('.fixture-screen input[name=phone]')).to_have_value('9705550100')
        page.locator('.fixture-screen input[name=phone]').fill('')
        self.go('customers')
        expect(page.locator('.fixture-screen')).to_have_count(0)

    def test_screen_uses_the_shell_action_dialog_without_remounting(self):
        page = self.open('fixture_screen', width=375)
        page.get_by_role('button', name='Confirm with dialog').click()
        dialog = page.get_by_role('dialog', name='Synthetic confirmation')
        expect(dialog).to_be_visible()
        field = dialog.locator('input[name=phone]')
        expect(field).to_have_attribute('type', 'tel')
        expect(field).to_have_attribute('inputmode', 'tel')
        expect(field).to_have_attribute('autocomplete', 'tel')
        expect(field).to_be_focused()
        field.fill('9705550100')
        self.assertEqual(self.small_targets('#ops-hub-layer'), [])
        page.clock.run_for(61000)
        expect(field).to_have_value('9705550100')
        dialog.get_by_role('button', name='Confirm').click()
        expect(page.locator('[data-fixture-result]')).to_have_text('Confirmed 9705550100')
        expect(page.locator('.ops-action-dialog')).to_have_count(0)
        expect(page.locator('[data-fixture-mounts]')).to_have_text('Mounts: 1')

    def test_background_refreshes_keep_a_typed_chat_draft_and_its_caret(self):
        page = self.open('crew_chat', width=390, profile=CREW)
        box = page.locator('.ops-chat-compose textarea')
        box.fill('Running ten minutes late to the synthetic job')
        # One page task finds the live field and moves its caret: a background render between a separate lookup and the
        # call would move the caret of a field already replaced (a race in the test, not in the Hub).
        page.evaluate("document.querySelector('.ops-chat-compose textarea').setSelectionRange(8,11)")
        node = box.element_handle()
        page.clock.run_for(61000)
        page.evaluate('refresh()')
        self.assertEqual(node.evaluate('el=>[el.isConnected,document.activeElement===el,el.selectionStart,el.selectionEnd]'), [True, True, 8, 11])
        page.locator('#ops-title').click()
        self.extra_team_messages.append({'id': 'message-2', 'body': 'Synthetic office update', 'sender': 'ZacB', 'senderName': 'Synthetic Owner', 'createdAt': '2026-09-22T17:59:00Z', 'updatedAt': '2026-09-22T17:59:00Z', 'status': 'active'})
        page.evaluate('refresh()')
        page.clock.run_for(61000)
        expect(page.locator('.ops-chat-messages')).to_contain_text('Synthetic office update')
        self.assertFalse(node.evaluate('el=>el.isConnected'), 'once focus leaves, an unsent draft no longer holds back new messages')
        expect(box).to_have_value('Running ten minutes late to the synthetic job')
        self.go('my_day')
        self.go('crew_chat')
        expect(page.locator('.ops-chat-compose textarea')).to_have_value('Running ten minutes late to the synthetic job')
        box.fill('')
        self.go('my_day')
        self.go('crew_chat')
        expect(page.locator('.ops-chat-compose textarea')).to_have_value('')

    def test_customer_search_filter_never_blocks_refreshes_or_explicit_actions(self):
        page = self.open('customers', width=390)
        search = page.locator('.ops-customer-tools input[type=search]')
        search.fill('johnson')
        page.evaluate("document.querySelector('.ops-customer-tools input[type=search]').setSelectionRange(3,3)")
        node = search.element_handle()
        expect(page.locator('#ops-customer-count')).to_have_text('1 customer shown')
        page.evaluate('refresh()')
        page.clock.run_for(61000)
        self.assertFalse(node.evaluate('el=>el.isConnected'), 'a typed filter does not freeze the view')
        expect(search).to_have_value('johnson')
        expect(search).to_be_focused()
        self.assertEqual(search.evaluate('el=>[el.selectionStart,el.selectionEnd]'), [3, 3])
        expect(page.locator('#ops-customer-count')).to_have_text('1 customer shown')
        self.assertEqual(page.locator('.ops-customer-list>article:not([hidden])').count(), 1)
        page.locator('#ops-title').click()
        rendered = page.evaluate('()=>{window.__renders=0;new MutationObserver(()=>window.__renders++).observe(document.getElementById("ops-main"),{childList:true});return true}')
        self.assertTrue(rendered)
        page.evaluate("opsRetryCloseout('job-done')")
        page.wait_for_function('window.__renders>0')
        expect(search).to_have_value('johnson')
        expect(page.locator('#ops-customer-count')).to_have_text('1 customer shown')

    def test_kit_links_follow_the_browser_url_parser(self):
        page = self.open('fixture_screen', width=390)
        result = page.evaluate('''()=>{const {h}=window.EGCHubKit,refused=['javascript:alert(1)','java\\tscript:alert(1)','java\\nscript:alert(1)','\\u0001javascript:alert(1)',' JAVASCRIPT:alert(1)','data:text/html,x','vbscript:x','blob:'+location.origin+'/x'];
          const kept=['https://example.invalid/a','http://example.invalid/b','mailto:synthetic@example.invalid','tel:+19705550100','/employee?view=today','?view=customers','#ops-main'];
          const leaked=refused.filter(url=>{const a=h('a',{href:url});return a.hasAttribute('href')||a.protocol==='javascript:'});
          const parsed=kept.map(url=>{const a=h('a',{href:url});return [a.getAttribute('href'),a.protocol,a.origin===location.origin]});
          return {leaked,parsed,browserSeesScript:(()=>{const a=document.createElement('a');a.href='java\\tscript:alert(1)';return a.protocol})()};}''')
        self.assertEqual(result['browserSeesScript'], 'javascript:', 'the browser itself strips the tab, which is why the kit parses URLs')
        self.assertEqual(result['leaked'], [])
        self.assertEqual([row[0] for row in result['parsed']], ['https://example.invalid/a', 'http://example.invalid/b', 'mailto:synthetic@example.invalid', 'tel:+19705550100', '/employee?view=today', '?view=customers', '#ops-main'])
        self.assertEqual([row[1] for row in result['parsed']], ['https:', 'http:', 'mailto:', 'tel:', 'http:', 'http:', 'http:'])
        self.assertEqual([row[2] for row in result['parsed']][-3:], [True, True, True], 'relative links stay on this origin')

    def test_crew_member_cannot_open_a_business_view_by_url(self):
        page = self.open('finance', width=390, profile=CREW)
        expect(page.locator('#ops-title')).to_have_text('My day')
        expect(page).to_have_url(re.compile(r'\?view=my_day$'))
        self.assertNotIn('finance', self.nav_views())
        self.assertIn('fixture_screen', self.nav_views())


if __name__ == '__main__':
    unittest.main(verbosity=2)
