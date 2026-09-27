"""Owner message template screen against an isolated fake /api/message-templates."""
import copy, json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = '2026-09-22T18:00:00.000Z'
BASE = ['firstName', 'companyPhone']

def version(number, body, status='draft', channel='SMS', subject='', **extra):
    row = {'version': number, 'channel': channel, 'subject': subject, 'body': body, 'variables': [], 'hash': f'hash-{number}-{len(body)}', 'status': status, 'createdBy': 'egc-default' if number == 1 else 'tylerg', 'createdAt': '' if number == 1 else NOW, 'approvedBy': '', 'approvedAt': '', 'retiredAt': ''}
    row.update(extra); return row

def templates():
    return [
        {'kind': 'on_my_way', 'label': 'On my way', 'audience': 'customer', 'allowedVariables': BASE + ['crewLeadName', 'etaMinutes'], 'versions': [version(1, 'Hi {{firstName}}, this is {{crewLeadName}}. We arrive in about {{etaMinutes}} minutes.')], 'activeVersion': None, 'latestVersion': 1, 'automationEnabled': False, 'seeded': True, 'automatable': False},
        {'kind': 'payment_reminder', 'label': 'Payment reminder', 'audience': 'customer', 'allowedVariables': BASE + ['invoiceNumber', 'balance', 'dueDate', 'payLink'], 'versions': [version(1, 'Hi {{firstName}}, {{balance}} is due {{dueDate}}: {{payLink}}', 'approved', approvedBy='zacb', approvedAt=NOW), version(2, 'Hi {{firstName}}, a reminder that {{balance}} is due {{dueDate}}. Pay here: {{payLink}}')], 'activeVersion': 1, 'latestVersion': 2, 'automationEnabled': False, 'seeded': False, 'automatable': True},
        {'kind': 'invoice_send', 'label': 'Invoice with pay link', 'audience': 'customer', 'allowedVariables': BASE + ['invoiceNumber', 'balance', 'dueDate', 'payLink'], 'versions': [version(1, 'Hi {{firstName}},\n\nInvoice {{invoiceNumber}} is ready: {{payLink}}', 'approved', 'Email', 'Invoice {{invoiceNumber}}', approvedBy='zacb', approvedAt=NOW)], 'activeVersion': 1, 'latestVersion': 1, 'automationEnabled': False, 'seeded': False, 'automatable': False},
    ]

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class MessageTemplatesBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}/message-templates.html'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(5000)
        self.page.clock.install(time=NOW)
        self.rows = templates(); self.viewer = {'id': 'zacb', 'role': 'owner', 'canApprove': True}; self.delivery = {'enabled': False, 'dryRun': True}
        self.calls = []; self.errors = []; self.fail_once = None; self.lost_once = False; self.read_status = 200; self.completed = {}
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/message-templates': route.continue_(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if req.method == 'GET':
            if self.read_status != 200: send({'ok': False, 'code': 'messaging_sign_in_required', 'error': 'Sign in'}, self.read_status); return
            send({'ok': True, 'templates': self.rows, 'variables': [], 'linkVariables': [], 'smsLimit': 320, 'delivery': self.delivery, 'viewer': self.viewer}); return
        body = req.post_data_json; self.calls.append(copy.deepcopy(body))
        if self.fail_once:
            status, code, message = self.fail_once; self.fail_once = None; send({'ok': False, 'code': code, 'error': message}, status); return
        if body['requestId'] in self.completed: send(self.completed[body['requestId']]); return
        row = next(item for item in self.rows if item['kind'] == body['kind'])
        if body['expectedVersion'] != row['latestVersion']: send({'ok': False, 'code': 'messaging_template_revision_conflict', 'error': 'Someone changed this template.'}, 409); return
        if body['action'] == 'save_draft':
            if self.viewer['role'] not in ('owner', 'manager'): send({'ok': False, 'code': 'messaging_template_forbidden', 'error': 'No'}, 403); return
            row['latestVersion'] += 1; row['versions'].append(version(row['latestVersion'], body['body'], channel=body['channel'], subject=body['subject'], createdBy=self.viewer['id']))
        elif body['action'] == 'approve':
            target = next(item for item in row['versions'] if item['version'] == body['version'])
            assert target['hash'] == body['hash']
            for item in row['versions']:
                if item['version'] == row['activeVersion']: item['status'] = 'retired'
            target.update(status='approved', approvedBy=self.viewer['id'], approvedAt=NOW); row['activeVersion'] = target['version']
        elif body['action'] == 'set_automation':
            row['automationEnabled'] = body['enabled']
        elif body['action'] == 'retire':
            next(item for item in row['versions'] if item['version'] == body['version'])['status'] = 'retired'; row['activeVersion'] = None; row['automationEnabled'] = False
        response = {'ok': True, 'requestId': body['requestId'], 'template': copy.deepcopy(row)}; self.completed[body['requestId']] = response
        if self.lost_once: self.lost_once = False; route.abort('connectionfailed'); return
        send(response)
    def open(self, kind=None):
        self.page.goto(self.url); expect(self.page.get_by_role('heading', name='Message templates', exact=True)).to_be_visible(); expect(self.page.locator('.mt-card')).to_have_count(len(self.rows))
        if kind: self.page.locator(f'.mt-card[data-kind="{kind}"]').click(); expect(self.page.locator('#mt-editor-title')).to_be_visible()
    def editor(self): return self.page.get_by_label('Message', exact=True)
    def no_horizontal_scroll(self):
        for width in [320, 375, 390]:
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')

    def test_list_shows_approval_state_and_fits_phone_widths(self):
        self.open()
        expect(self.page.locator('.mt-card[data-kind="on_my_way"]')).to_contain_text('Not approved')
        expect(self.page.locator('.mt-card[data-kind="payment_reminder"]')).to_contain_text('Live v1')
        expect(self.page.locator('.mt-card[data-kind="payment_reminder"]')).to_contain_text('Draft v2 awaiting owner')
        expect(self.page.get_by_role('status')).to_contain_text('Messaging is off')
        for box in self.page.locator('.mt-card, .mt-btn').evaluate_all('nodes=>nodes.map(node=>node.getBoundingClientRect().height)'): self.assertGreaterEqual(box, 44)
        self.no_horizontal_scroll()
        self.page.locator('.mt-card[data-kind="invoice_send"]').click(); self.no_horizontal_scroll()
        self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('#mt-body')).fontSize"), '16px')
        self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('#mt-subject')).fontSize"), '16px')

    def test_live_preview_renders_samples_counts_sms_and_flags_bad_variables(self):
        self.open('on_my_way')
        expect(self.page.get_by_test_id('preview')).to_have_text('Hi Sam, this is Casey. We arrive in about 20 minutes.')
        self.assertNotIn('null', self.page.locator('.mt-preview').inner_text())
        save = self.page.get_by_role('button', name='Save draft', exact=True); expect(save).to_be_disabled()
        self.editor().fill('Hello {{firstName}}! Call {{companyPhone}}.')
        expect(self.page.get_by_test_id('preview')).to_have_text('Hello Sam! Call (970) 999-1818.')
        expect(self.page.locator('.mt-count')).to_have_text('31 / 320 characters'); expect(save).to_be_enabled()
        self.editor().fill('Hi {{password}} and {{payLink}} and {{firstName}')
        alert = self.page.locator('.mt-errors'); expect(alert).to_contain_text('{{password}} is not an approved variable'); expect(alert).to_contain_text('{{payLink}} cannot be used'); expect(alert).to_contain_text('missing a brace'); expect(save).to_be_disabled()
        self.editor().fill('x' * 321); expect(self.page.locator('.mt-count')).to_have_class('mt-count over'); expect(alert).to_contain_text('321 characters'); expect(save).to_be_disabled()
        self.editor().fill('Thanks '); self.editor().press('End'); self.page.get_by_role('button', name='Insert First name', exact=True).click()
        expect(self.editor()).to_have_value('Thanks {{firstName}}'); expect(self.page.get_by_test_id('preview')).to_have_text('Thanks Sam')
        self.assertFalse(self.page.evaluate('EGCMessageTemplates.canLeave()'))

    def test_manager_saves_a_draft_with_request_id_and_version_and_cannot_approve(self):
        self.viewer = {'id': 'tylerg', 'role': 'manager', 'canApprove': False}
        self.open('on_my_way')
        expect(self.page.get_by_role('button', name='Approve v1')).to_have_count(0); expect(self.page.get_by_role('region', name='Owner controls')).to_have_count(0)
        self.editor().fill('Hi {{firstName}}, {{crewLeadName}} is on the way!')
        expect(self.page.locator('.mt-hint')).to_contain_text('Saving creates version 2 as a draft. Nothing sends until the owner approves it.')
        self.page.get_by_role('button', name='Save draft', exact=True).click()
        expect(self.page.locator('.mt-notice')).to_contain_text('Draft v2 saved. The owner must approve it')
        call = self.calls[-1]
        self.assertEqual({key: call[key] for key in ['action', 'kind', 'expectedVersion', 'channel', 'subject', 'body']}, {'action': 'save_draft', 'kind': 'on_my_way', 'expectedVersion': 1, 'channel': 'SMS', 'subject': '', 'body': 'Hi {{firstName}}, {{crewLeadName}} is on the way!'})
        self.assertEqual(len(call['requestId']), 36)
        expect(self.page.locator('#mt-editor-title + .mt-card-pills')).to_contain_text('Draft v2 awaiting owner')
        self.assertTrue(self.page.evaluate('EGCMessageTemplates.canLeave()'))

    def test_owner_approves_the_exact_text_only_after_confirming(self):
        self.open('payment_reminder')
        approve = self.page.get_by_role('button', name='Approve v2', exact=True)
        original = self.editor().input_value(); self.editor().fill(original + ' edited'); expect(approve).to_be_hidden()
        self.editor().fill(original); expect(approve).to_be_visible(); approve.click()
        dialog = self.page.get_by_role('dialog', name='Approve version 2?'); expect(dialog).to_be_visible()
        expect(dialog.locator('.mt-exact')).to_contain_text('Hi {{firstName}}, a reminder that {{balance}} is due {{dueDate}}. Pay here: {{payLink}}')
        confirm = dialog.get_by_role('button', name='Approve wording', exact=True)
        self.assertNotEqual(confirm.evaluate('node=>getComputedStyle(node).backgroundColor'), confirm.evaluate('node=>getComputedStyle(node).color'), 'the confirm button must be visible')
        self.assertGreaterEqual(confirm.bounding_box()['height'], 44)
        dialog.get_by_role('button', name='Cancel', exact=True).click(); expect(dialog).to_have_count(0); self.assertEqual(self.calls, [])
        approve.click(); self.page.get_by_role('button', name='Approve wording', exact=True).click()
        expect(self.page.locator('.mt-notice')).to_contain_text('Version 2 approved')
        self.assertEqual({key: self.calls[-1][key] for key in ['action', 'version', 'hash', 'expectedVersion']}, {'action': 'approve', 'version': 2, 'hash': self.rows[1]['versions'][1]['hash'], 'expectedVersion': 2})
        expect(self.page.locator('#mt-editor-title + .mt-card-pills')).to_contain_text('Live v2')
        self.editor().fill('An edit hides approval {{firstName}}')
        expect(self.page.get_by_role('button', name='Approve v3')).to_have_count(0)

    def test_owner_turns_on_automation_and_retires_with_confirmation(self):
        self.open('payment_reminder')
        self.page.get_by_role('button', name='Turn on automatic sending', exact=True).click()
        expect(self.page.get_by_role('dialog')).to_contain_text('between 8 AM and 8 PM Denver time')
        self.page.get_by_role('button', name='Turn on', exact=True).click()
        expect(self.page.locator('#mt-editor-title + .mt-card-pills')).to_contain_text('Automatic sending on')
        self.assertEqual(self.calls[-1]['enabled'], True)
        self.page.get_by_role('button', name='Retire live wording', exact=True).click(); self.page.get_by_role('button', name='Retire wording', exact=True).click()
        expect(self.page.locator('#mt-editor-title + .mt-card-pills')).to_contain_text('Not approved')
        self.assertEqual(self.calls[-1]['action'], 'retire')

    def test_lost_save_keeps_the_original_request_across_reload(self):
        self.open('on_my_way'); self.editor().fill('Lost reply {{firstName}}'); self.lost_once = True
        self.page.get_by_role('button', name='Save draft', exact=True).click()
        retry = self.page.get_by_role('button', name='Retry original save', exact=True); expect(retry).to_be_visible()
        expect(self.editor()).to_be_disabled(); self.assertFalse(self.page.evaluate('EGCMessageTemplates.canLeave()'))
        self.page.reload(); expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        self.page.get_by_role('button', name='Retry original save', exact=True).click()
        expect(self.page.locator('.mt-notice')).to_contain_text('Draft v2 saved'); expect(self.page.get_by_role('alert')).to_have_count(0)
        self.assertEqual(self.calls[0], self.calls[1]); self.assertTrue(self.page.evaluate('EGCMessageTemplates.canLeave()'))
        self.assertEqual(len([row for row in self.rows[0]['versions'] if row['body'] == 'Lost reply {{firstName}}']), 1)

    def test_revision_conflict_keeps_the_draft_and_offers_latest(self):
        self.open('on_my_way'); self.editor().fill('My careful draft {{firstName}}')
        self.fail_once = (409, 'messaging_template_revision_conflict', 'Someone changed this template while you were editing.')
        self.page.get_by_role('button', name='Save draft', exact=True).click()
        expect(self.page.get_by_role('alert')).to_contain_text('Someone changed this template')
        self.page.get_by_role('button', name='Keep my draft and load latest', exact=True).click()
        expect(self.editor()).to_have_value('My careful draft {{firstName}}')
        self.page.get_by_role('button', name='Save draft', exact=True).click(); expect(self.page.locator('.mt-notice')).to_contain_text('Draft v2 saved')
        self.assertNotEqual(self.calls[0]['requestId'], self.calls[1]['requestId'])

    def test_history_uses_denver_time_and_untrusted_text_stays_text(self):
        self.rows[1]['versions'][1]['body'] = '<img src=x onerror="window.xss=1">{{firstName}}'
        self.open('payment_reminder'); self.page.locator('.mt-history summary').click()
        expect(self.page.locator('.mt-history')).to_contain_text('approved by zacb Sep 22, 12:00 PM')
        expect(self.page.locator('.mt-history')).to_contain_text('<img src=x')
        self.assertIsNone(self.page.evaluate('window.xss'))

    def test_expired_session_shows_unavailable_and_signout_clears_private_state(self):
        self.read_status = 401; self.page.goto(self.url)
        expect(self.page.get_by_role('alert')).to_contain_text('sign-in expired'); expect(self.page.locator('.mt-card')).to_have_count(0)
        expect(self.page.get_by_role('button', name='Retry', exact=True)).to_be_visible()
        self.read_status = 200; self.page.get_by_role('button', name='Retry', exact=True).click(); expect(self.page.locator('.mt-card')).to_have_count(3)
        self.page.locator('.mt-card[data-kind="on_my_way"]').click(); self.editor().fill('Unsaved private draft {{firstName}}')
        self.assertGreater(self.page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("egc.templates.v1.")).length'), 0)
        self.page.evaluate('window.dispatchEvent(new Event("egc:signout"))')
        expect(self.page.locator('#templates-root')).to_be_empty()
        self.assertEqual(self.page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("egc.templates.v1.")).length'), 0)

if __name__ == '__main__':
    unittest.main()
