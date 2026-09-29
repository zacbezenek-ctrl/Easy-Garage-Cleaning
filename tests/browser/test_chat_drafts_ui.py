"""FIX-EDIT-WIPE: crew chat and the customer thread in the real employee.html keep what is typed while a message is
sending. The reload after a chat save and the customer-thread send are held in the route handler until the next
message has been typed; then the normal send still goes out once, with the request it always had."""
import copy, json, re, unittest
from urllib.parse import urlparse
from playwright.sync_api import expect
from hub_shell_harness import HubShell, CREW, JOBS, DAY, RESULTS

REQUEST_ID = re.compile(r'^crew-\d+-[a-z0-9]{1,7}$')


class ChatDraftsBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self):
        self.errors = []; self.hold_get = False; self.hold_send = False; self.held = None; self.chat_posts = []; self.sends = []
        self.conversation = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/employee-hub':
            if request.method == 'POST' and (request.post_data_json or {}).get('collection') == 'teamMessages':
                body = request.post_data_json; self.chat_posts.append(copy.deepcopy(body)); self.extra_team_messages.append(copy.deepcopy(body['data']))
                self.hold_get = True
            elif request.method == 'GET' and self.hold_get:
                self.hold_get = False; self.held = route; return
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/crew-jobs' and request.method == 'POST':
            self.sends.append({'body': request.post_data_json, 'headers': request.headers})
            if self.hold_send: self.hold_send = False; self.held = route; return
            return self.send_reply(route)
        return super().route(route)

    def send_reply(self, route):
        body = self.sends[-1]['body']
        self.conversation.append({'id': body['requestId'], 'direction': 'to_customer', 'body': body['body'], 'authorName': 'Synthetic Crew', 'createdAt': DAY + 'T18:00:00Z', 'delivery': {'channel': 'portal', 'status': 'not_configured'}})
        job = {**copy.deepcopy(JOBS[0]), 'customerConversation': copy.deepcopy(self.conversation)}
        route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'job': job, 'message': self.conversation[-1]}))

    def release(self, reply):
        # Playwright reports a routed request and then hands it to the route handler in the same step, so one round trip
        # to the page after expect_request has run the handler that holds it.
        self.page.evaluate('0')
        self.assertIsNotNone(self.held, 'the request is held until the next message is typed')
        held, self.held = self.held, None
        reply(held)

    def caret(self, selector):
        return self.page.evaluate('s=>{const el=document.querySelector(s);return [document.activeElement===el,el.selectionStart,el.selectionEnd]}', selector)

    def test_text_typed_while_a_chat_message_sends_survives_the_reload_and_sends_next(self):
        page = self.open('crew_chat', width=390, profile=CREW)
        box = page.locator('.ops-chat-compose textarea')
        box.fill('Synthetic first update from the truck')
        # The save goes out, then the Hub reads the records again; that read is held here until the next message is typed.
        with page.expect_request(lambda request: request.method == 'GET' and urlparse(request.url).path == '/api/employee-hub'):
            page.locator('.ops-chat-compose button').click()
        self.assertEqual([post['data']['body'] for post in self.chat_posts], ['Synthetic first update from the truck'])
        box.click()
        box.fill('Synthetic second note typed while sending')
        page.evaluate("document.querySelector('.ops-chat-compose textarea').setSelectionRange(10,16)")
        self.release(lambda held: HubShell.route(self, held))
        expect(page.locator('.ops-chat-messages')).to_contain_text('Synthetic first update from the truck')
        expect(box).to_have_value('Synthetic second note typed while sending')
        self.assertEqual(self.caret('.ops-chat-compose textarea'), [True, 10, 16], 'the kept text keeps its caret')
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 390, scroll)
        # The normal send still works and clears exactly what it sent.
        with page.expect_request(lambda request: request.method == 'GET' and urlparse(request.url).path == '/api/employee-hub'):
            page.locator('.ops-chat-compose button').click()
        self.release(lambda held: HubShell.route(self, held))
        expect(page.locator('.ops-chat-messages')).to_contain_text('Synthetic second note typed while sending')
        expect(box).to_have_value('')
        self.assertEqual([post['data']['body'] for post in self.chat_posts], ['Synthetic first update from the truck', 'Synthetic second note typed while sending'])
        self.go('my_day'); self.go('crew_chat')
        expect(page.locator('.ops-chat-compose textarea')).to_have_value('')
        page.screenshot(path=str(RESULTS / 'chat-drafts-390.png'), full_page=True)

    def test_text_typed_while_a_customer_message_sends_survives_and_each_tap_sends_once(self):
        page = self.open('crew_chat', width=375, profile=CREW)
        page.evaluate("opsSelectChat('job:job-today')")
        thread = page.locator('.ops-customer-thread form')
        box = thread.locator('textarea')
        expect(thread).to_have_attribute('data-job-id', 'job-today')
        box.fill('Synthetic arrival in twenty minutes')
        # The send (through HighLevel on the server) is held here until the next message is typed.
        self.hold_send = True
        with page.expect_request(lambda request: request.method == 'POST' and urlparse(request.url).path == '/api/crew-jobs'):
            thread.get_by_role('button', name='Send to customer').click()
        expect(thread.get_by_role('button', name='Sending…')).to_be_disabled()
        box.click()
        box.fill('Synthetic question about the side door')
        page.evaluate("document.querySelector('.ops-customer-thread form textarea').setSelectionRange(4,12)")
        self.release(self.send_reply)
        expect(page.locator('.ops-customer-thread-messages')).to_contain_text('Synthetic arrival in twenty minutes')
        expect(box).to_have_value('Synthetic question about the side door')
        self.assertEqual(self.caret('.ops-customer-thread form textarea'), [True, 4, 12], 'the kept text keeps its caret')
        expect(thread.get_by_role('button', name='Send to customer')).to_be_enabled()
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll)
        # The send's request is unchanged: one POST per tap, its action, job, body and a fresh crew request ID.
        self.assertEqual(len(self.sends), 1)
        first = self.sends[0]['body']
        self.assertEqual(sorted(first), ['action', 'body', 'jobId', 'requestId'])
        self.assertEqual((first['action'], first['jobId'], first['body']), ('send_customer_message', 'job-today', 'Synthetic arrival in twenty minutes'))
        self.assertRegex(first['requestId'], REQUEST_ID)
        self.assertEqual(self.sends[0]['headers'].get('content-type'), 'application/json')
        thread.get_by_role('button', name='Send to customer').click()
        expect(page.locator('.ops-customer-thread-messages')).to_contain_text('Synthetic question about the side door')
        expect(box).to_have_value('')
        self.assertEqual([send['body']['body'] for send in self.sends], ['Synthetic arrival in twenty minutes', 'Synthetic question about the side door'])
        self.assertRegex(self.sends[1]['body']['requestId'], REQUEST_ID)
        self.assertNotEqual(self.sends[1]['body']['requestId'], first['requestId'])
        page.screenshot(path=str(RESULTS / 'chat-drafts-thread-375.png'), full_page=True)


if __name__ == '__main__':
    unittest.main()
