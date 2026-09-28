"""FUN-13 website lead intake at 375x812: the ads landing page (whose own submit handler cancels the
native POST) now reaches the /api/web-lead relay exactly once per set of answers, book.html reports
its Meta Lead with the relayed inquiry id as the eventID, and the client hub help form tells a message
the Hub queued for a retry apart from one HighLevel already has. The relay and Web3Forms are routed fakes;
every other host is refused, so no lead, pixel or analytics call leaves the machine. Relay calls are
counted in the page as they start and settle, so every check waits on a condition, never a fixed delay."""
import json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / 'test-results'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
SITE_PIXEL = '970332989051988'
# FUN-13 leaves the paid-campaign pixel on the ads landing page until the owner confirms nothing optimizes on it.
ADS_PIXEL = '861741726934219'
PIXEL_CALLS = "() => (window.fbq && window.fbq.queue || []).map(args => Array.from(args))"
COUNT_RELAYS = """(() => {
  const relays = window.__relays = { started: 0, settled: 0 }, native = window.fetch;
  window.fetch = function (url) {
    const pending = native.apply(this, arguments);
    if (String(url).indexOf('/api/web-lead') !== -1) { relays.started += 1; pending.then(() => { relays.settled += 1; }, () => { relays.settled += 1; }); }
    return pending;
  };
})();"""
RELAYS_SETTLED = '() => window.__relays.settled === window.__relays.started'
# ads.html reports a failed Web3Forms POST with alert(); a real modal pauses the page until the test dismisses it,
# so the page records the message instead and the test checks it.
RECORD_ALERTS = "window.__alerts = []; window.alert = message => { window.__alerts.push(String(message)); };"
STEP_SHOWN = """n => !!document.querySelector('form.multi-step-form .form-panel.active[data-step="' + n + '"]')"""

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class LeadRelayBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever,daemon=True).start(); cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start(); options={'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':375,'height':812},is_mobile=True,has_touch=True,timezone_id='Asia/Tokyo')
        self.page=self.context.new_page(); self.page.set_default_timeout(20000); self.page.add_init_script(COUNT_RELAYS); self.page.add_init_script(RECORD_ALERTS); self.errors=[]; self.relayed=[]; self.web3forms=[]; self.web3forms_status=200; self.relay_status=200; self.relay_reply=None
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))
        self.page.on('dialog',lambda dialog:dialog.accept())
        def route(route):
            request=route.request; url=urlparse(request.url)
            if url.hostname=='127.0.0.1' and url.path=='/api/web-lead':
                self.relayed.append(json.loads(request.post_data or '{}'))
                if self.relay_reply: return route.fulfill(status=self.relay_reply[0],content_type='application/json',body=json.dumps(self.relay_reply[1]))
                return route.fulfill(status=self.relay_status,content_type='application/json',body='{"ok":true}' if self.relay_status<400 else '{"ok":false}')
            if url.hostname=='api.web3forms.com':
                self.web3forms.append(request.method)
                # 204 keeps a native form POST on the page, so its state can be read afterwards.
                return route.fulfill(status=self.web3forms_status,headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'},body='' if self.web3forms_status==204 else '{"success":true}')
            return route.continue_() if url.hostname=='127.0.0.1' else route.abort()
        self.page.route('**/*',route)
        self.page.clock.install(time='2026-09-22T18:00:00Z')
    def tearDown(self):
        self.assertEqual(self.errors,[]); self.context.close()
    def until(self,condition,message):
        for _ in range(800):
            if condition(): return
            self.page.wait_for_timeout(25)
        self.fail(message)
    def relays_settled(self):
        # Each /api/web-lead fetch the page started has been answered and handled; the route handler records
        # a request before fulfilling it, so self.relayed then holds exactly the relays the page sent.
        self.page.wait_for_function(RELAYS_SETTLED)
        return self.page.evaluate('window.__relays.started')
    def lead_events(self):
        return [call for call in self.page.evaluate(PIXEL_CALLS) if call[:2]==['track','Lead']]

    def test_ads_landing_page_relays_each_set_of_answers_once_with_its_meta_lead_event_id(self):
        self.page.goto(self.url+'/ads.html'); self.page.wait_for_function('() => !!window.EGCLeadCapture')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
        self.assertIn(['init',ADS_PIXEL],self.page.evaluate(PIXEL_CALLS),'the ads page keeps its paid-campaign pixel')
        self.page.fill('#fname','Synthetic Ads'); self.page.fill('#phone','(970) 555-0110'); self.page.fill('#zip','80525')
        self.page.check('input[name="sms_consent"]')
        # Web3Forms keeps failing, so the visitor retries: the relay failed too at first (resent with the
        # same inquiry id), then succeeded (never sent again); corrected answers are a new inquiry.
        submit=self.page.locator('#submitBtn')
        self.assertGreaterEqual(submit.bounding_box()['height'],44)
        def attempt(expected_relays):
            # The relay starts before the Web3Forms fetch, so once the button is back (or the success panel shows)
            # the page's count is final; the failed relay must also be settled before the next attempt resends it.
            submit.click(); self.page.wait_for_function('() => document.getElementById("formSuccess").style.display === "block" || !document.getElementById("submitBtn").disabled')
            self.assertEqual(self.relays_settled(),expected_relays); self.assertEqual(len(self.relayed),expected_relays,self.relayed)
        self.web3forms_status=500; self.relay_status=503
        attempt(1)
        self.relay_status=200
        attempt(2)
        attempt(2)
        self.web3forms_status=200
        self.page.fill('#phone','(970) 555-0111'); attempt(3)
        expect(self.page.locator('#formSuccess')).to_be_visible()
        self.assertEqual(len(self.web3forms),4)
        self.assertEqual(self.page.evaluate('window.__alerts'),['Something went wrong. Please call us at (970) 658-9454.']*3,'each failed attempt tells the visitor to call')
        first,resent,corrected=self.relayed
        self.assertRegex(first['inquiry_id'],UUID)
        self.assertEqual(resent,first,'after a failed relay the same answers are resent unchanged, as the same inquiry')
        self.assertNotEqual(corrected['inquiry_id'],first['inquiry_id'],'corrected answers are a new inquiry')
        self.assertEqual([first['name'],first['phone'],first['serviceZip'],first['sms_consent'],first['source'],first['items']],['Synthetic Ads','(970) 555-0110','80525','yes','Ads Landing Page','Ads landing lead (in service area)'])
        self.assertEqual(urlparse(first['page_url']).path,'/ads.html')
        leads=self.lead_events()
        self.assertEqual([lead[3] for lead in leads],[{'eventID':first['inquiry_id']}]*3+[{'eventID':corrected['inquiry_id']}],'every attempt reports its Lead under the inquiry id, so Meta counts it once')
        self.assertTrue(all(lead[2]=={'service_area':'in_area'} for lead in leads))
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
        SHOTS.mkdir(exist_ok=True); self.page.screenshot(path=str(SHOTS/'lead-relay-ads-375.png'))

    def test_book_page_relays_once_and_reports_its_lead_with_the_inquiry_id(self):
        self.web3forms_status=204
        self.page.goto(self.url+'/book.html'); self.page.wait_for_function('() => !!window.EGCLeadCapture')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
        form=self.page.locator('form.multi-step-form')
        self.assertEqual(form.get_attribute('data-meta-lead'),'walkthrough_request')
        # book.html focuses a new step's first field on an 80 ms timer. Under load that timer could fire mid-fill,
        # send the typed phone number into Name and leave the required Phone empty, so the native submit (and its
        # Lead) never happens; running the installed clock past it fires it before the next field is touched.
        def advance(step):
            form.locator(f'[data-step="{step}"] [data-next]').click(); self.page.wait_for_function(STEP_SHOWN,arg=step+1); self.page.clock.run_for(200)
        advance(1)
        form.locator('select[name="Job size"]').select_option('medium'); advance(2)
        form.locator('input[name="booking_slot_choice"][value="Tomorrow AM"]').check(); advance(3)
        form.locator('select[name="City"]').select_option('Fort Collins'); advance(4)
        advance(5)
        form.locator('input[name="Name"]').fill('Synthetic Booker'); form.locator('input[name="Phone"]').fill('(970) 555-0112')
        submit=form.locator('[data-submit-label]')
        self.assertGreaterEqual(submit.bounding_box()['height'],44)
        submit.click()
        self.page.wait_for_function('() => (window.fbq.queue || []).some(args => args[1] === "Lead")')
        self.until(lambda:self.web3forms,'the native Web3Forms POST was not sent')
        # The relay starts in the submit listener before the Lead is queued, so the page's count is final here.
        self.assertEqual(self.relays_settled(),1); self.assertEqual(len(self.relayed),1,self.relayed); self.assertEqual(self.web3forms,['POST'])
        body=self.relayed[0]
        self.assertRegex(body['inquiry_id'],UUID)
        self.assertEqual([body['name'],body['phone'],body['city'],body['booking_slot'],body['flow_type']],['Synthetic Booker','+19705550112','Fort Collins','Tomorrow AM','walkthrough'])
        self.assertEqual(self.lead_events(),[['track','Lead',{'content_name':'walkthrough_request'},{'eventID':body['inquiry_id']}]])
        self.assertIn(['init',SITE_PIXEL],self.page.evaluate(PIXEL_CALLS))

    def test_client_hub_help_tells_a_queued_message_from_a_delivered_one(self):
        # The help form is on the portal's no-access screen, so it needs no portal session.
        queued={'ok':True,'inquiryId':'00000000-0000-4000-8000-000000000001','accepted':True,'receipt':{'status':'failed'},'highlevel':{'configured':True,'synced':False,'retry':'scheduled'}}
        synced={'ok':True,'inquiryId':'00000000-0000-4000-8000-000000000002','receipt':{'status':'synced'},'highlevel':{'configured':True,'synced':True},'relay':{'configured':True,'sent':False}}
        legacy={'ok':True,'highlevel':{'configured':True,'synced':True},'relay':{'configured':True,'sent':False}}
        failed={'ok':False,'error':'HighLevel lead sync failed'}
        cases=[((202,queued),'Message received. It is still on its way to the team','Message received',True),
               ((200,synced),'Message sent. The team can see it in HighLevel','Message sent',True),
               ((200,legacy),'Message sent. The team can see it in HighLevel','Message sent',True),
               ((502,failed),'HighLevel lead sync failed','Send to the team',False)]
        for reply,text,label,done in cases:
            with self.subTest(status=reply[0],body=reply[1]):
                self.relay_reply=reply; sent=len(self.relayed)
                self.page.goto(self.url+'/customer-portal.html?error=expired'); expect(self.page.locator('#hub-help-form')).to_be_visible()
                self.page.fill('#hub-help-name','Synthetic Portal'); self.page.fill('#hub-help-phone','(970) 555-0130')
                self.page.fill('#hub-help-message','Please send me a fresh project link.')
                button=self.page.locator('#hub-help-form [type="submit"]')
                self.assertGreaterEqual(button.bounding_box()['height'],44)
                button.click()
                expect(self.page.locator('#hub-help-state')).to_contain_text(text)
                expect(button).to_have_text(label)
                self.assertEqual(len(self.relayed),sent+1)
                self.assertEqual([self.relayed[-1]['flow_type'],self.relayed[-1]['items']],['client_hub_help','Please send me a fresh project link.'])
                if done: expect(button).to_be_disabled(); expect(self.page.locator('#hub-help-message')).to_be_disabled()
                else: expect(button).to_be_enabled()
                if reply is cases[0][0]:
                    self.assertIn('call (970) 999-1818',self.page.locator('#hub-help-state').inner_text())
                    SHOTS.mkdir(exist_ok=True); self.page.locator('#hub-help-state').scroll_into_view_if_needed(); self.page.screenshot(path=str(SHOTS/'lead-relay-hub-help-queued-375.png'))
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)

if __name__ == '__main__':
    unittest.main()
