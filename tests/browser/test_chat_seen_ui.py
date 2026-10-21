"""CHAT-SEEN in the real employee.html with the real CSS: a read marker covers only messages actually on screen. A long
room opens at its newest message; a reader who scrolls up and gets a new message by poll has not seen it, so nothing new
is marked until they scroll down to it. Synthetic messages only."""
import copy, json, unittest
from urllib.parse import urlparse
from hub_shell_harness import HubShell, CREW, DAY

def message(index):
    at = f'{DAY}T{16 + index // 12:02d}:{(index % 12) * 5:02d}:00.000Z'
    return {'id': f'message-seen-{index:02d}', 'body': f'Synthetic update number {index} with a little more text to take up a line', 'sender': 'ZacB', 'senderName': 'Synthetic Owner', 'createdAt': at, 'updatedAt': at, 'status': 'active'}


class ChatSeenBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []; self.reads = []; self.saved = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/employee-hub':
            if request.method == 'POST' and (request.post_data_json or {}).get('collection') == 'messageReads':
                data = request.post_data_json['data']; self.reads.append(copy.deepcopy(data))
                record = {'id': 'read-syntheticcrew-team', 'employee': 'Synthetic.Crew', 'channel': data['channel'], 'lastReadAt': data['seenThrough']}
                self.saved = [record]
                route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'record': record})); return
            if request.method == 'GET':
                self.extra_team_messages[:] = self.messages
        return super().route(route)

    def box(self, script): return self.page.evaluate(f"(()=>{{const box=document.querySelector('.ops-chat-messages');{script}}})()")

    def test_only_messages_on_screen_are_marked_seen(self):
        self.messages = [message(index) for index in range(1, 21)]
        # Tall enough that the whole message box is inside the window; only the box's own scrolling decides.
        page = self.open('crew_chat', width=390, height=1400, profile=CREW)
        page.wait_for_function("document.querySelectorAll('.ops-chat-messages article[data-at]').length >= 20")
        page.wait_for_timeout(300)
        self.assertGreater(self.box('return box.scrollHeight - box.clientHeight'), 200, 'the room is longer than its box')
        self.assertTrue(self.box('return box.scrollTop + box.clientHeight >= box.scrollHeight - 2'), 'the room opens at its newest message')
        self.assertTrue(self.reads, 'opening the room marks what is on screen')
        self.assertEqual(self.reads[-1]['seenThrough'], message(20)['createdAt'])
        # The reader scrolls up; a new message arrives by poll and is drawn below, out of view.
        self.box('box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); return 0')
        page.wait_for_timeout(200)
        marked = len(self.reads)
        self.messages.append(message(21))
        page.evaluate('opsRefresh()')
        page.wait_for_function("[...document.querySelectorAll('.ops-chat-messages article[data-at]')].some(item => item.textContent.includes('number 21'))")
        page.wait_for_timeout(300)
        self.assertTrue(self.box('return box.scrollTop < 50'), 'a background render keeps the reader where they were')
        self.assertEqual(len(self.reads), marked, 'a message off screen is not marked seen: ' + json.dumps(self.reads))
        # Scrolling down to it marks it.
        self.box('box.scrollTop = box.scrollHeight; box.dispatchEvent(new Event("scroll")); return 0')
        page.wait_for_timeout(300)
        self.assertEqual(self.reads[-1]['seenThrough'], message(21)['createdAt'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
