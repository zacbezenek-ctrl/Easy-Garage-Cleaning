"""Mobile shell pass on the real employee.html: every nav view for manager and crew fixtures at 320, 375 and 390
fits without horizontal scroll (body overflow clipping disabled), keeps 44px tap targets and 16px inputs; the
drawer scrim swallows the outside tap; the toast wraps inside the viewport."""
import re, unittest
from playwright.sync_api import expect
from hub_shell_harness import HubShell, MANAGER, CREW, RESULTS

WIDTHS = (320, 375, 390)


class HubMobileBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def sweep(self, profile, first):
        problems = []
        for width in WIDTHS:
            page = self.open(first, width=width, height=812, profile=profile)
            views = self.nav_views()
            self.assertIn('fixture_screen', views)
            for view in views:
                self.go(view)
                page.wait_for_timeout(150)
                scroll = self.no_horizontal_scroll()
                if scroll['width'] > width: problems.append(f'{width} {view}: page scrolls sideways to {scroll["width"]}px {scroll["wide"]}')
                problems += [f'{width} {view}: {item}' for item in self.small_targets() + self.small_inputs()]
            page.screenshot(path=str(RESULTS / f'hub-mobile-{profile["role"]}-{width}.png'))
            page.locator('.ops-menu').click()
            expect(page.locator('#ops-rail')).to_have_class(re.compile(r'\bopen\b'))
            problems += [f'{width} drawer: {item}' for item in self.small_targets('.ops-rail')]
            page.keyboard.press('Escape')
            if profile is MANAGER:
                self.go('today')
                page.evaluate("opsOpenBooking('2026-09-22')")
                problems += [f'{width} booking: {item}' for item in self.small_targets('.ops-modal') + self.small_inputs('.ops-modal')]
                phone = page.locator('.ops-booking input[name=phone]')
                self.assertEqual([phone.get_attribute(name) for name in ('type', 'inputmode', 'autocomplete')], ['tel', 'tel', 'tel'])
                page.evaluate('opsCloseBooking()')
                page.evaluate('()=>{opsNewAnnouncement()}')
                problems += [f'{width} announcement: {item}' for item in self.small_targets('.ops-modal') + self.small_inputs('.ops-modal')]
                page.evaluate('opsActionClose()')
            self.close_page()
        self.assertEqual(problems, [])

    def test_every_manager_view_fits_phone_widths_with_44px_targets(self):
        self.sweep(MANAGER, 'today')

    def test_every_crew_view_fits_phone_widths_with_44px_targets(self):
        self.sweep(CREW, 'my_day')

    def test_drawer_scrim_swallows_the_outside_tap_and_escape_closes(self):
        page = self.open('customers', width=375, height=812)
        rail, menu, scrim = page.locator('#ops-rail'), page.locator('.ops-menu'), page.locator('.ops-scrim')
        expect(menu).to_have_attribute('aria-expanded', 'false')
        expect(menu).to_have_attribute('aria-controls', 'ops-rail')
        expect(rail).to_be_hidden()
        expect(rail).to_have_js_property('inert', True)
        point = {'x': 340, 'y': 420}
        beneath = page.evaluate('({x,y})=>{const el=document.elementFromPoint(x,y);return el?el.closest("button,a,input,article,section")?.tagName||el.tagName:null}', point)
        self.assertIsNotNone(beneath)
        page.evaluate("window.__throughClicks=0;document.addEventListener('click',event=>{if(!event.target.closest('.ops-scrim,.ops-rail,.ops-menu'))window.__throughClicks++},true)")
        menu.click()
        expect(menu).to_have_attribute('aria-expanded', 'true')
        expect(rail).to_be_visible()
        expect(scrim).to_be_visible()
        expect(rail).to_have_js_property('inert', False)
        expect(page.locator('.ops-nav button.active')).to_be_focused()
        self.assertEqual(page.evaluate('({x,y})=>document.elementFromPoint(x,y).className', point), 'ops-scrim')
        page.touchscreen.tap(point['x'], point['y'])
        expect(menu).to_have_attribute('aria-expanded', 'false')
        expect(scrim).to_be_hidden()
        expect(menu).to_be_focused()
        self.assertEqual(page.evaluate('window.__throughClicks'), 0, 'the tap that closes the drawer never reaches the page beneath')
        expect(page.locator('#ops-title')).to_have_text('Customers')
        menu.click()
        expect(rail).to_be_visible()
        page.keyboard.press('Escape')
        expect(menu).to_be_focused()
        expect(menu).to_have_attribute('aria-expanded', 'false')
        expect(rail).to_have_js_property('inert', True)
        menu.click()
        page.locator('.ops-nav [data-ops-tab="finance"]').click()
        expect(page.locator('#ops-title')).to_have_text('Estimates & payments')
        expect(menu).to_have_attribute('aria-expanded', 'false')
        expect(menu).to_be_focused()
        expect(rail).to_have_js_property('inert', True)
        menu.click()
        expect(page.locator('.ops-nav button.active')).to_be_focused()
        page.keyboard.press('Tab')
        page.keyboard.press('Enter')
        expect(menu).to_have_attribute('aria-expanded', 'false')
        expect(menu).to_be_focused()
        page.set_viewport_size({'width': 1100, 'height': 812})
        expect(rail).to_be_visible()
        # The shell clears inert from its matchMedia change listener, which fires after the resize.
        expect(rail, 'the desktop rail is always usable').to_have_js_property('inert', False)

    def test_sign_in_cycles_reuse_one_set_of_shell_listeners(self):
        page = self.open_page(375, 812)
        page.add_init_script('''(()=>{const add=EventTarget.prototype.addEventListener;window.__shellListeners={document:0,media:0};
          EventTarget.prototype.addEventListener=function(type,listener,options){if(this===document&&['click','keydown','visibilitychange'].includes(type))window.__shellListeners.document++;
            if(typeof MediaQueryList!=='undefined'&&this instanceof MediaQueryList&&type==='change')window.__shellListeners.media++;return add.call(this,type,listener,options)};})()''')
        page.goto(f'{self.url}/employee.html?view=customers')
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0')
        first = page.evaluate('({...window.__shellListeners})')
        self.assertGreaterEqual(first['media'], 1)
        menu = page.locator('.ops-menu')
        for cycle in range(2):
            page.evaluate('doLogout()')
            page.wait_for_function('!document.querySelector(".ops-shell")')
            page.fill('#l-user', 'ZacB')
            page.fill('#l-pass', 'synthetic-password')
            page.evaluate('doLogin()')
            page.wait_for_function('document.querySelector("#ops-main")?.children.length>0')
            self.assertEqual(page.evaluate('({...window.__shellListeners})'), first, f'cycle {cycle}: signing in again adds no shell listeners')
            self.assertEqual(page.locator('.ops-scrim').count(), 1)
            menu.click()
            expect(page.locator('#ops-rail')).to_be_visible()
            expect(page.locator('.ops-scrim')).to_be_visible()
            page.touchscreen.tap(340, 420)
            expect(menu).to_have_attribute('aria-expanded', 'false')
            expect(menu).to_be_focused()
        self.assertEqual(self.errors, [])

    def test_toast_wraps_inside_the_viewport(self):
        for width in (320, 375):
            page = self.open('today', width=width, height=812)
            page.evaluate("document.getElementById('toast').style.transition='none'")
            page.evaluate("showToast('Saved in Hub. The HighLevel mirror is queued and retries automatically when the connection returns.')")
            box = page.locator('#toast').bounding_box()
            self.assertGreaterEqual(box['x'], 0)
            self.assertLessEqual(box['x'] + box['width'], width)
            self.assertLessEqual(box['width'], width - 32 + 0.5)
            self.assertGreater(box['height'], 40, 'long messages wrap instead of running off screen')
            self.assertLessEqual(box['y'] + box['height'], 812)
            page.screenshot(path=str(RESULTS / f'hub-mobile-toast-{width}.png'))
            self.close_page()


if __name__ == '__main__':
    unittest.main(verbosity=2)
