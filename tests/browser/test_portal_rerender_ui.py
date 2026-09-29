"""The customer portal survives re-renders and a failed Stripe verification (FIX-PORTAL-CRASH), on two phones and a tablet.
Every portal answer is produced by the real handlers (tests/browser/portal_rerender_fixture.mjs); the page runs on a paused clock."""
import copy, json, os, pathlib, subprocess, threading, unittest
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 22, 18, 0, tzinfo=timezone.utc)  # the fixture's clock; noon in Denver, 3 AM the next day in Tokyo
FIXTURES = json.loads(subprocess.run(['node', 'tests/browser/portal_rerender_fixture.mjs'], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
SESSION = FIXTURES['session']
CONFIRMING = 'Your payment is being confirmed. It will appear here shortly.'
UNCONFIRMED = 'We could not confirm this payment yet. If you were charged, it will appear once the team verifies it. Call (970) 999-1818 with questions.'
CONNECTION = 'Your project could not be opened right now. Check your connection and refresh the page.'
RENDER_NOTICE = 'Some details could not be shown. Refresh the page.'
RETURN = f'/customer-portal.html?payment=stripe-success&session_id={SESSION}'
# What used to reach the customer: raw exception text on the error screen.
RAW = ('Cannot set properties', 'Cannot read properties', 'TypeError', 'is not a function', 'Failed to fetch')
PAGE = {}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


def setUpModule():
    (ROOT / 'test-results').mkdir(exist_ok=True)
    PAGE['server'] = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=PAGE['server'].serve_forever, daemon=True).start()
    PAGE['url'] = f"http://127.0.0.1:{PAGE['server'].server_port}"
    PAGE['pw'] = sync_playwright().start()
    options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
    PAGE['browser'] = PAGE['pw'].chromium.launch(headless=True, args=['--no-sandbox'], **options)


def tearDownModule():
    PAGE['browser'].close(); PAGE['pw'].stop(); PAGE['server'].shutdown(); PAGE['server'].server_close()


class PortalRerender:
    VIEWPORT = (390, 844)

    def setUp(self):
        width, height = self.VIEWPORT
        self.context = PAGE['browser'].new_context(viewport={'width': width, 'height': height}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        # Paused: the 20-second refresh and the verify retries run only when a test moves the clock.
        self.page.clock.install(time=NOW); self.page.clock.pause_at(NOW + timedelta(seconds=1))
        self.errors = []; self.console = []; self.posts = []; self.unexpected = []; self.replies = []; self.get_failures = []
        self.view = FIXTURES['approved']['body']
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('console', lambda message: self.console.append(message.text) if message.type == 'error' else None)
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
        self.assertEqual(self.unexpected, [], 'every portal POST was expected')
        self.context.close()

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda status, body: route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        # Pages serves the portal at /customer-portal, where the Stripe return leaves the address bar.
        if parsed.path == '/customer-portal': route.fulfill(path=str(ROOT / 'customer-portal.html')); return
        if parsed.path == '/api/customer-portal':
            if request.method == 'GET':
                failure = self.get_failures.pop(0) if self.get_failures else None
                if failure == 'network': route.abort(); return
                # A proxy's own error page (not JSON), and the real answer once the browser's session has ended.
                if failure == 'html': route.fulfill(status=502, content_type='text/html', body='<!doctype html><title>502 Bad gateway</title><h1>Bad gateway</h1>'); return
                if failure == 'signed-out': send(FIXTURES['signedOut']['status'], FIXTURES['signedOut']['body']); return
                if failure: send(FIXTURES['down']['status'], FIXTURES['down']['body']); return
                send(200, self.view); return
            body = request.post_data_json; self.posts.append(body)
            if not self.replies: self.unexpected.append(body); send(500, {'ok': False, 'error': 'Unexpected request'}); return
            status, reply, view = self.replies.pop(0)
            if view: self.view = view
            send(status, reply); return
        if parsed.path == '/api/customer-portal-document': send(200, {'ok': True, 'kind': 'insurance', 'available': False}); return
        if parsed.path.startswith('/api/'): send(404, {'ok': False}); return
        route.continue_()

    # No fixed waits: the page marks what it has finished. <html data-portal-loading> counts its reads in flight, and #payment-notice
    # carries data-verify (verify answers handled) and data-retry-in (the retry scheduled, in seconds). The clock only moves once
    # the page is in the state the step needs, and requests are awaited as events.
    def open_portal(self, path='/customer-portal.html'):
        self.page.goto(PAGE['url'] + path); expect(self.page.locator('#portal')).to_be_visible(); self.settled()

    def settled(self):
        # Every read the page started, with its render and any Stripe return it began, has finished.
        expect(self.page.locator('html')).to_have_attribute('data-portal-loading', '0')

    def portal_request(self, method):
        return self.page.expect_request(lambda request: request.method == method and urlparse(request.url).path == '/api/customer-portal')

    def next_verify(self, count, wait, elapsed=0):
        notice = self.page.locator('#payment-notice')
        # The page has handled verify {count - 1}'s answer and scheduled this retry {wait} seconds out: only then does the clock move.
        expect(notice).to_have_attribute('data-verify', str(count - 1)); expect(notice).to_have_attribute('data-retry-in', str(wait))
        with self.portal_request('POST'): self.page.clock.run_for((wait - elapsed) * 1000)
        expect(notice).to_have_attribute('data-verify', str(count))
        self.assertEqual(len(self.posts), count, f'verify {count} is sent {wait} seconds after the one before')

    def no_retry_scheduled(self):
        self.assertIsNone(self.page.locator('#payment-notice').get_attribute('data-retry-in'), 'no verify retry is scheduled')

    def quiet_refresh(self, advance=20000):
        with self.portal_request('GET'): self.page.clock.run_for(advance)
        self.settled()

    def visible_placeholders(self):
        # Leaf nodes a customer can see that read '$0.00' (the static placeholders before a render fills them).
        return self.page.evaluate("""() => [...document.querySelectorAll('body *')].filter(node => !node.children.length && node.offsetParent && node.textContent.trim() === '$0.00')
            .map(node => node.id || node.className)""")

    def no_raw_errors(self):
        text = self.page.locator('body').inner_text()
        for raw in RAW: self.assertNotIn(raw, text)
        expect(self.page.locator('#error')).to_be_hidden()

    def phone_checks(self, name):
        width = self.VIEWPORT[0]
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        small = self.page.evaluate("""() => [...document.querySelectorAll('#pay-button, #approve-button, #render-refresh, .payment-numbers ~ button')].filter(node => node.offsetParent)
            .map(node => [node.id, node.getBoundingClientRect().height]).filter(([, height]) => height < 44)""")
        self.assertEqual(small, [], 'visible payment and notice controls are at least 44px tall')
        self.page.screenshot(path=str(ROOT / 'test-results' / f'portal-rerender-{name}-{width}.png'), full_page=True)

    def test_approving_the_estimate_keeps_the_portal_and_its_due_now_explanation(self):
        self.view = FIXTURES['pending']['body']; self.open_portal()
        shown = self.view['estimate']
        expect(self.page.locator('#payment-due-now')).to_have_text('$450.00 deposit due upfront. $450.00 remaining after your deposit, due on completion.')
        self.page.locator('#approval-name').fill('Synthetic Customer'); self.page.locator('#approval-confirm').check()
        self.replies.append((200, FIXTURES['approve']['body'], FIXTURES['approved']['body']))
        self.page.locator('#approve-button').click()
        expect(self.page.locator('#approval-done')).to_be_visible()
        expect(self.page.locator('#toast')).to_have_text('Estimate approved. Your deposit details are shown below.')
        posted = self.posts[0]
        self.assertEqual({key: posted[key] for key in ('action', 'estimate_revision', 'amount_cents', 'estimate_fingerprint', 'terms_version', 'confirmed')},
                         {'action': 'approve_estimate', 'estimate_revision': shown['revision'], 'amount_cents': 90000, 'estimate_fingerprint': shown['fingerprint'], 'terms_version': shown['termsVersion'], 'confirmed': True})
        # The approval re-rendered the whole page, and two quiet refreshes do it again: one due-now line, one closeout note.
        for refresh in range(3):
            if refresh: self.quiet_refresh()
            expect(self.page.locator('#portal')).to_be_visible(); self.no_raw_errors()
            expect(self.page.locator('#payment-due-now')).to_have_count(1)
            expect(self.page.locator('#payment-due-now')).to_have_text('$450.00 deposit due upfront. $450.00 remaining after your deposit, due on completion.')
            expect(self.page.locator('.closeout-rule')).to_have_count(1)
            expect(self.page.locator('#pay-button ~ .closeout-rule')).to_have_text('Payment is required before the crew closes this job.')
            expect(self.page.locator('#pay-button')).to_have_text('Pay $450.00 upfront deposit'); expect(self.page.locator('#pay-button')).to_be_enabled()
            expect(self.page.locator('#render-notice')).to_be_hidden()
        self.assertEqual([post['action'] for post in self.posts], ['approve_estimate'])
        self.assertFalse([line for line in self.console if 'CUSTOMER_PORTAL_RENDER_FAILED' in line])
        self.phone_checks('approved')

    def test_an_approval_whose_refresh_fails_says_to_refresh_instead_of_pointing_at_missing_details(self):
        self.view = FIXTURES['pending']['body']; self.open_portal()
        self.page.locator('#approval-name').fill('Synthetic Customer'); self.page.locator('#approval-confirm').check()
        self.replies.append((200, FIXTURES['approve']['body'], FIXTURES['approved']['body'])); self.get_failures = ['storage']
        self.page.locator('#approve-button').click()
        expect(self.page.locator('#toast')).to_have_text('Estimate approved. Refresh the page to see your deposit details.')
        expect(self.page.locator('#portal')).to_be_visible(); self.no_raw_errors()
        self.assertEqual([post['action'] for post in self.posts], ['approve_estimate'])
        self.phone_checks('approved-refresh-failed')
        # The next quiet refresh shows the approval and the deposit.
        self.quiet_refresh()
        expect(self.page.locator('#approval-done')).to_be_visible(); expect(self.page.locator('#pay-button')).to_have_text('Pay $450.00 upfront deposit')

    def test_a_revised_estimate_that_first_fails_to_render_still_clears_the_confirmation(self):
        self.view = FIXTURES['pending']['body']; self.open_portal()
        self.page.locator('#approval-name').fill('Synthetic Customer'); self.page.locator('#approval-confirm').check()
        expect(self.page.locator('#estimate-total')).to_have_text('$900.00')
        # Revision 2 ($1,200) arrives with a field the page cannot draw: the $900 page stays and approval is hidden.
        broken = copy.deepcopy(FIXTURES['revised']['body']); broken['appointment']['status'] = None
        self.view = broken; self.quiet_refresh()
        expect(self.page.locator('#render-notice')).to_be_visible(); expect(self.page.locator('#approval-form')).to_be_hidden()
        expect(self.page.locator('#estimate-total')).to_have_text('$900.00')
        # Drawn on the next refresh, it is compared with the $900 estimate the customer ticked: the tick is cleared and the change is called out.
        self.view = FIXTURES['revised']['body']; self.quiet_refresh()
        expect(self.page.locator('#render-notice')).to_be_hidden(); expect(self.page.locator('#estimate-total')).to_have_text('$1,200.00')
        expect(self.page.locator('#approval-form')).to_be_visible()
        expect(self.page.locator('#approval-confirm')).not_to_be_checked(); expect(self.page.locator('#approval-updated')).to_be_visible()
        self.assertEqual(self.posts, []); self.no_raw_errors()
        self.phone_checks('revised')

    def test_a_verification_that_runs_out_of_retries_says_it_could_not_confirm_yet(self):
        self.replies += [(FIXTURES['unsettled']['status'], FIXTURES['unsettled']['body'], None)] * 6
        self.open_portal(RETURN)
        notice = self.page.locator('#payment-notice'); expect(notice).to_have_text(CONFIRMING)
        for count, wait in enumerate([2, 4, 8, 16, 32], start=2): self.next_verify(count, wait)
        expect(notice).to_have_text(UNCONFIRMED); expect(notice).to_have_attribute('role', 'status')
        self.no_retry_scheduled(); self.page.clock.run_for(64000); self.settled()
        self.assertEqual(self.posts, [{'action': 'verify_payment', 'session_id': SESSION}] * 6, 'nothing is asked after the last retry')
        self.no_raw_errors(); self.assertNotIn('Stripe has not verified', self.page.locator('body').inner_text())
        self.phone_checks('unconfirmed')
        # The payment the webhook recorded reaches the page on a quiet refresh: the notice no longer says it could not be confirmed.
        self.view = FIXTURES['paid']['body']; self.quiet_refresh()
        expect(notice).to_have_text('Payment verified.'); expect(self.page.locator('#payment-paid')).to_have_text('$450.00')
        expect(self.page.locator('#receipt-link')).to_be_visible(); self.assertEqual(len(self.posts), 6)

    def test_a_first_read_answered_by_an_error_page_shows_the_connection_message(self):
        self.get_failures = ['html']
        self.page.goto(PAGE['url'] + '/customer-portal.html')
        expect(self.page.locator('#error')).to_be_visible(); expect(self.page.locator('#error-message')).to_have_text(CONNECTION)
        self.assertNotIn('valid private project link', self.page.locator('body').inner_text())
        self.page.reload(); expect(self.page.locator('#portal')).to_be_visible(); expect(self.page.locator('#error')).to_be_hidden()

    def test_signing_out_after_a_render_error_leaves_no_render_notice_above_the_sign_in_screen(self):
        self.open_portal()
        broken = copy.deepcopy(FIXTURES['approved']['body']); broken['appointment']['status'] = None
        self.view = broken; self.quiet_refresh(); expect(self.page.locator('#render-notice')).to_be_visible()
        self.get_failures = ['signed-out']; self.quiet_refresh()
        expect(self.page.locator('#error')).to_be_visible(); expect(self.page.locator('#portal')).to_be_hidden()
        expect(self.page.locator('#render-notice')).to_be_hidden()
        expect(self.page.locator('#error-message')).to_have_text('This browser does not have a valid private project link. Send the form below and the team will reconnect you.')

    def test_render_three_times_in_a_row_leaves_the_same_page(self):
        self.open_portal()
        shots = self.page.evaluate("""() => { const shot = () => ['portal', 'render-notice', 'payment-notice'].map(id => document.getElementById(id).outerHTML).join('|');
            const shots = [shot()]; for (let call = 0; call < 3; call++) { render(portalData); shots.push(shot()) } return shots }""")
        self.assertEqual(shots[2], shots[1], 'the second call changes nothing'); self.assertEqual(shots[3], shots[2], 'the third call changes nothing')
        self.assertEqual(shots[1], shots[0], 'a render of the same answer matches the page load')
        for selector in ('#payment-due-now', '.closeout-rule', '#estimate-terms-version', '#decision-list .decision', '#wallet-cards .credit-row', '#collaborator-list .person-row'):
            expect(self.page.locator(selector)).to_have_count(1)
        expect(self.page.locator('#payment-due-now')).to_have_text('$450.00 deposit due upfront. $450.00 remaining after your deposit, due on completion.')
        self.phone_checks('rerender')

    def test_a_stripe_return_stripe_has_not_settled_shows_the_portal_and_confirms_on_the_retry(self):
        self.replies += [(FIXTURES['unsettled']['status'], FIXTURES['unsettled']['body'], None), (FIXTURES['verified']['status'], FIXTURES['verified']['body'], FIXTURES['paid']['body'])]
        self.open_portal(RETURN)
        notice = self.page.locator('#payment-notice')
        expect(notice).to_have_text(CONFIRMING); expect(notice).to_have_attribute('role', 'status')
        self.no_raw_errors(); self.assertNotIn('Stripe has not verified', self.page.locator('body').inner_text())
        self.assertEqual(self.page.evaluate('location.pathname + location.search'), '/customer-portal')
        expect(self.page.locator('#pay-button')).to_have_text('Pay $450.00 upfront deposit')
        self.assertEqual(len(self.posts), 1)
        self.phone_checks('confirming')
        expect(notice).to_have_attribute('data-verify', '1'); expect(notice).to_have_attribute('data-retry-in', '2')
        # A retry that starts drops data-retry-in at once, so after 1.9 seconds it is still only scheduled.
        self.page.clock.run_for(1900)
        self.assertEqual(notice.get_attribute('data-retry-in'), '2', 'the first retry waits 2 seconds'); self.assertEqual(len(self.posts), 1)
        with self.portal_request('POST'): self.page.clock.run_for(100)
        expect(notice).to_have_attribute('data-verify', '2')
        expect(notice).to_have_text('Payment verified. $450.00 remaining.')
        expect(self.page.locator('#payment-paid')).to_have_text('$450.00'); expect(self.page.locator('#receipt-link')).to_be_visible()
        expect(self.page.locator('#pay-button')).to_be_hidden()
        self.assertEqual(self.posts, [{'action': 'verify_payment', 'session_id': SESSION}] * 2)
        # Verified: nothing is asked again.
        self.no_retry_scheduled(); self.page.clock.run_for(64000); self.settled()
        self.assertEqual(len(self.posts), 2)
        self.no_raw_errors()

    def test_a_quiet_refresh_that_draws_the_payment_settles_the_being_confirmed_notice(self):
        outage = (FIXTURES['outage']['status'], FIXTURES['outage']['body'], None)
        self.replies += [(FIXTURES['unsettled']['status'], FIXTURES['unsettled']['body'], None), outage, outage, outage]
        self.open_portal(RETURN); notice = self.page.locator('#payment-notice')
        for count, wait in enumerate([2, 4, 8], start=2): self.next_verify(count, wait)
        expect(notice).to_have_text(CONFIRMING)
        # The webhook recorded the payment. The quiet refresh 20 seconds after the page opened draws it, and the notice follows.
        self.view = FIXTURES['paid']['body']; self.quiet_refresh(advance=6000)
        expect(notice).to_have_text('Payment verified.'); expect(notice).to_have_attribute('role', 'status')
        expect(self.page.locator('#payment-paid')).to_have_text('$450.00'); expect(self.page.locator('#receipt-link')).to_be_visible()
        expect(self.page.locator('#pay-button')).to_be_hidden()
        self.phone_checks('verified-by-refresh')
        # The retries still run: one more that fails leaves the notice alone, and the last finds the recorded charge.
        self.replies += [outage, (FIXTURES['again']['status'], FIXTURES['again']['body'], None)]
        self.next_verify(5, 16, elapsed=6); expect(notice).to_have_text('Payment verified.')
        self.next_verify(6, 32)
        expect(notice).to_have_text('Payment verified. $450.00 remaining.')
        self.no_retry_scheduled(); self.page.clock.run_for(64000); self.settled()
        self.assertEqual(self.posts, [{'action': 'verify_payment', 'session_id': SESSION}] * 6, 'still at most six asks')
        self.no_raw_errors(); self.assertNotIn('Secure checkout could not be confirmed', self.page.locator('body').inner_text())

    def test_a_failed_verification_then_a_reload_never_shows_the_error_screen(self):
        self.replies.append((FIXTURES['outage']['status'], FIXTURES['outage']['body'], None))
        self.open_portal(RETURN)
        expect(self.page.locator('#payment-notice')).to_have_text(CONFIRMING)
        self.assertEqual(self.page.evaluate('location.pathname + location.search'), '/customer-portal')
        self.no_raw_errors(); self.assertNotIn('Secure checkout could not be confirmed', self.page.locator('body').inner_text())
        self.page.reload(); expect(self.page.locator('#portal')).to_be_visible(); self.settled()
        self.no_raw_errors(); expect(self.page.locator('#payment-notice')).to_be_hidden()
        self.assertEqual(self.page.evaluate('location.pathname + location.search'), '/customer-portal')
        self.assertIsNone(self.page.locator('#payment-notice').get_attribute('data-verify'), 'the reloaded page verifies nothing')
        self.no_retry_scheduled(); self.page.clock.run_for(5000); self.settled()
        self.assertEqual(len(self.posts), 1, 'the reload verifies nothing again')
        self.phone_checks('reloaded')

    def test_three_failed_quiet_refreshes_show_the_reconnecting_pill(self):
        self.open_portal(); pill = self.page.locator('#reconnect-pill')
        self.get_failures = ['storage', 'network', 'storage']
        for failure in range(3):
            expect(pill).to_be_hidden(); self.quiet_refresh()
        expect(pill).to_be_visible(); expect(pill).to_have_text('Reconnecting…')
        self.assertEqual(pill.evaluate('node => getComputedStyle(node).pointerEvents'), 'none', 'the pill never blocks a tap')
        expect(self.page.locator('#portal')).to_be_visible(); expect(self.page.locator('#toast')).to_be_hidden()
        expect(self.page.locator('#payment-due-now')).to_have_text('$450.00 deposit due upfront. $450.00 remaining after your deposit, due on completion.')
        self.no_raw_errors(); self.assertNotIn(FIXTURES['down']['body']['error'], self.page.locator('body').inner_text())
        self.phone_checks('reconnecting')
        self.quiet_refresh(); expect(pill).to_be_hidden()

    def test_a_render_error_keeps_the_last_good_page_and_asks_for_a_refresh(self):
        self.open_portal()
        broken = copy.deepcopy(FIXTURES['paid']['body']); broken['appointment']['status'] = None
        self.view = broken; self.quiet_refresh()
        notice = self.page.locator('#render-notice')
        expect(notice).to_be_visible(); expect(notice.locator('span')).to_have_text(RENDER_NOTICE)
        expect(self.page.locator('#portal')).to_be_visible(); self.no_raw_errors()
        expect(self.page.locator('#estimate-status')).to_have_text('approved')
        self.assertTrue([line for line in self.console if 'CUSTOMER_PORTAL_RENDER_FAILED' in line], 'the render error is logged with its code')
        self.phone_checks('render-error')
        self.view = FIXTURES['paid']['body']; self.quiet_refresh()
        expect(notice).to_be_hidden(); expect(self.page.locator('#payment-paid')).to_have_text('$450.00')

    def test_a_first_render_that_fails_shows_only_the_notice(self):
        broken = copy.deepcopy(FIXTURES['approved']['body']); broken['appointment']['status'] = None; self.view = broken
        self.page.goto(PAGE['url'] + '/customer-portal.html')
        expect(self.page.locator('#render-notice')).to_be_visible()
        for hidden in ('#portal', '#loading', '#error'): expect(self.page.locator(hidden)).to_be_hidden()
        self.no_raw_errors()
        self.assertTrue([line for line in self.console if 'CUSTOMER_PORTAL_RENDER_FAILED' in line])
        self.phone_checks('first-render-error')
        self.view = FIXTURES['approved']['body']; self.page.locator('#render-refresh').click()
        expect(self.page.locator('#portal')).to_be_visible(); expect(self.page.locator('#render-notice')).to_be_hidden()

    def test_a_first_render_that_fails_after_showing_the_portal_hides_it_again(self):
        # A malformed conversation entry throws in renderMessages, after renderPortalBase made #portal visible and before the
        # wallet, the closeout note and the viewer's permissions were drawn.
        for name in ('approved', 'partner'):
            good = FIXTURES[name]['body']; broken = copy.deepcopy(good); broken['conversation'] = [None]; self.view = broken
            self.page.goto(PAGE['url'] + '/customer-portal.html')
            expect(self.page.locator('#render-notice')).to_be_visible(); expect(self.page.locator('#render-notice span')).to_have_text(RENDER_NOTICE)
            for hidden in ('#portal', '#loading', '#error', '#pay-button', '#wallet-balance', '#approval-form'): expect(self.page.locator(hidden)).to_be_hidden()
            self.assertEqual(self.visible_placeholders(), [], f'{name}: no $0.00 placeholder is left on screen')
            self.no_raw_errors()
            self.assertTrue([line for line in self.console if 'CUSTOMER_PORTAL_RENDER_FAILED' in line])
            self.phone_checks(f'first-render-late-error-{name}')
            # Refresh draws the whole portal: the gift card balance, and Pay only for a viewer who may pay.
            self.view = good; self.page.locator('#render-refresh').click()
            expect(self.page.locator('#portal')).to_be_visible(); expect(self.page.locator('#render-notice')).to_be_hidden()
            expect(self.page.locator('#wallet-balance')).to_have_text('$50.00')
            if name == 'partner': expect(self.page.locator('#pay-button')).to_be_hidden()
            else: expect(self.page.locator('#pay-button')).to_have_text('Pay $450.00 upfront deposit')
            self.console.clear()
        self.assertEqual(self.posts, [])

    def test_a_tip_after_a_render_that_failed_past_the_tip_picker_is_added_to_the_due_on_screen(self):
        # Tips on: the job is complete and $450 is due. The $50 gift card is then applied from another device, so the next answer
        # is $400 due, with a documents block the page cannot draw (renderDocuments runs after the tip picker).
        self.view = FIXTURES['tipDue']['body']; self.open_portal()
        pay = self.page.locator('#pay-button'); picker = self.page.locator('#tip-picker')
        expect(picker).to_be_visible(); expect(pay).to_have_text('Pay $450.00 remaining balance')
        broken = copy.deepcopy(FIXTURES['credited']['body'])
        broken['documents'] = {**broken['documents'], 'termsVersion': 'synthetic-unreadable', 'guarantee': {'title': 'Synthetic guarantee', 'sections': 5}}
        self.view = broken; self.quiet_refresh()
        expect(self.page.locator('#render-notice')).to_be_visible()
        expect(pay).to_have_text('Pay $400.00 remaining balance')
        expect(self.page.locator('#payment-due-now')).to_have_text('$400.00 remaining balance due on completion. Your earlier payments are already applied.')
        picker.get_by_role('button', name='15% $60.00').click()
        expect(pay).to_have_text('Pay $460.00 · balance + $60.00 tip'); expect(pay).to_have_attribute('data-tip-cents', '6000')
        expect(picker.locator('.egc-tip-summary')).to_have_text('$60.00 tip for your crew, charged with $400.00 balance: $460.00 total.')
        self.phone_checks('tip-after-render-error')
        # The next good answer keeps the same tip on the same due.
        self.view = FIXTURES['credited']['body']; self.quiet_refresh()
        expect(self.page.locator('#render-notice')).to_be_hidden(); expect(pay).to_have_text('Pay $460.00 · balance + $60.00 tip')
        self.assertEqual(self.posts, []); self.no_raw_errors()


class PortalRerenderSmallPhone(PortalRerender, unittest.TestCase):
    VIEWPORT = (320, 568)


class PortalRerenderPhone(PortalRerender, unittest.TestCase):
    VIEWPORT = (390, 844)


class PortalRerenderTablet(PortalRerender, unittest.TestCase):
    VIEWPORT = (768, 1024)


if __name__ == '__main__':
    unittest.main(verbosity=2)
