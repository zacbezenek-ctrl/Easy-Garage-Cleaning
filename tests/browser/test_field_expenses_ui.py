"""Phone-sized job-cost capture flows against an isolated field-expenses API fixture."""
import copy, datetime, json, os, pathlib, re, struct, threading, unittest, zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
def png(width=24, height=32):
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\x00' + b'\xf0\xe0\xd0' * width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
PNG = png()
PAGE = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/crew/job.css"><link rel="stylesheet" href="/crew/field-expenses.css"></head><body><main id="field-main"><section class="card" id="host"></section></main><script src="/crew/field-expenses.js"></script><script>const p=new URLSearchParams(location.search);EGCFieldExpenses.mount(document.querySelector("#host"),{jobId:"job-1",user:p.get("user")||"Crew.One",manager:p.get("manager")==="1"})</script></body></html>'

def row(id, **changes):
    value = {'id':id, 'kind':'dump_fee', 'amountCents':8450, 'currency':'USD', 'vendor':'Synthetic County Landfill', 'note':'', 'createdAt':'2026-09-22T17:00:00.000Z', 'incurredOn':'2026-09-22',
        'status':'recorded', 'state':'applied', 'needsReview':False, 'hasReceipt':False, 'receiptVerified':False, 'edited':False}
    value.update(changes); return value

def field_job(completed=False):
    check = {'id':'departure-address','stage':'departure','label':'Confirm the address, crew, truck and arrival time','detail':'','required':True,'completed':completed,'completedAt':None,'completedBy':None}
    return {'id':'job-1','expectedRevision':'rev-2' if completed else 'rev-1','type':'job','customer':'Synthetic Garage','phone':'9705550100','address':'123 Synthetic Way, Fort Collins, CO','date':'2026-09-22','time':'08:00','endDate':'2026-09-22','endTime':'11:00','startAt':'','endAt':'','arrivalWindow':'',
        'status':'in_progress','fieldStatus':'in_progress','statusReason':'','serviceType':'Garage cleanout','assignedCrew':['Crew.One'],'crewMembers':[{'id':'Crew.One','name':'Crew One'}],'crewLead':'Crew.One','crewId':'','crewName':'','vehicleId':'','vehicleName':'','crewNeeded':1,
        'scope':'Clear the garage.','customerGoal':'','keepItems':'','removeItems':'','exclusions':'','hazards':[],'accessInstructions':'','access':[],'truckPlacement':'','customerInstructions':'','requiredEquipment':[],'materials':[],'checklist':[check],'photos':[],'history':[],'attention':None,'canAddManagementNote':False,
        'jobTime':{'recorded':False,'estimatedMs':10800000,'asOf':'2026-09-22T18:00:00.000Z','needsReview':False,'partialHistory':False,'runningKind':None,'message':'Job time will be recorded from the next field status action.'},
        'completion':None,'completionSync':None,'startedAt':None,'completedAt':None,'completionMissing':['Upload at least one after photo.'],'canEdit':True,'canManageChecklist':False,'allowedStatuses':['paused','waiting','delayed','in_progress']}

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if urlparse(self.path).path == '/':
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(PAGE)
        else: super().do_GET()

class FieldExpensesBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1',0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width':375,'height':812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(5000)
        self.page.clock.install(time=datetime.datetime(2026,9,22,18,tzinfo=datetime.timezone.utc))
        self.entries = []; self.posts = []; self.errors = []; self.held = []; self.job_posts = []; self.expense_reads = 0
        self.manager = False; self.read_status = 200; self.malformed = False; self.hold_reads = False; self.abort_posts = 0; self.receipts = True
        self.features = {'jobCosts':True}; self.post_error = None; self.entry_status = None
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def listing(self):
        visible = [copy.deepcopy(item) for item in self.entries]
        counted = [item for item in visible if item['state'] == 'applied' and item['status'] != 'void']
        by_kind = {kind: sum(item['amountCents'] for item in counted if item['kind'] == kind) for kind in ['material','dump_fee','other']}
        totals = {'currency':'USD','totalCents':sum(by_kind.values()),'byKind':by_kind,'count':len(counted),'voidCount':0,'pendingCount':0,'invalidCount':0,'receiptCount':0,'complete':True}
        return {'ok':True,'jobId':'job-1','scope':'job' if self.manager else 'own','entries':visible,'totals':totals,'canRecord':True,'canManage':self.manager,'receiptsAvailable':self.receipts,'limits':{'maxAmountCents':500000,'kinds':['material','dump_fee','other']}}
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/hub-auth': send({'ok':True,'user':'Crew.One','displayName':'Crew One','role':'crew'}); return
        if parsed.path == '/api/employee-hub': send({'ok':True,'user':'Crew.One','entry':None}); return
        if parsed.path == '/api/field-jobs':
            if req.method == 'POST': self.job_posts.append(req.post_data_json); send({'ok':True,'alreadyApplied':False,'job':field_job(True),'historyCursor':None}); return
            detail = {'ok':True,'job':field_job(bool(self.job_posts)),'historyCursor':None,'photosAvailable':True,'timezone':'America/Denver'}
            if self.features is not None: detail['features'] = self.features
            send(detail); return
        if parsed.path != '/api/field-expenses': route.continue_(); return
        self.expense_reads += req.method == 'GET'
        if req.method == 'GET':
            self.assertEqual(parse_qs(parsed.query), {'jobId':['job-1']})
            if self.hold_reads: self.held.append(route); return
            if self.read_status == 404: send({'ok':False,'code':'FIELD_EXPENSES_DISABLED','error':'Job-cost capture is not enabled.'}, 404); return
            send({'ok':True} if self.malformed else self.listing()); return
        body = req.post_data_json; self.posts.append(copy.deepcopy(body))
        if self.abort_posts: self.abort_posts -= 1; route.abort('connectionreset'); return
        if self.post_error: status, code, message = self.post_error; send({'ok':False,'code':code,'error':message}, status); return
        if body['action'] == 'create':
            if not any(item['id'] == body['requestId'] for item in self.entries):
                self.entries.insert(0, row(body['requestId'], kind=body['kind'], amountCents=body['amountCents'], vendor=body['vendor'], note=body['note'], hasReceipt='receiptDataUrl' in body, receiptVerified='receiptDataUrl' in body))
        else:
            item = next(item for item in self.entries if item['id'] == body['expenseId'])
            if body['action'] == 'void': item.update(status='void', canEdit=False, canVoid=False, voided={'at':'2026-09-22T18:00:00.000Z','by':{'id':'ZacB','name':'Owner'},'reason':body['reason']})
            else: item.update({key: body[key] for key in ['kind','amountCents','vendor','note','incurredOn'] if key in body}, edited=True, audit=[{'action':'edit','at':'2026-09-22T18:00:00.000Z','by':{'id':'ZacB','name':'Owner'},'reason':body['reason'],'before':{'amountCents':8450},'after':{'amountCents':body.get('amountCents')}}])
            item['expectedRevision'] = item['expectedRevision'] + '-next'
        reply = {**self.listing(), 'alreadyApplied':self.entry_status is not None}
        if body['action'] == 'create': reply['entryStatus'] = self.entry_status or 'recorded'
        send(reply)
    def open(self, query=''):
        self.page.goto(self.url + '/' + query)
    def assert_phone_layout(self):
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', self.page.locator('#host').inner_text()))
        small = self.page.evaluate("""[...document.querySelectorAll('#host button, #host input:not([type=file]), #host select, #host .button')].filter(el=>el.offsetParent).filter(el=>el.getBoundingClientRect().height<44).map(el=>el.outerHTML.slice(0,80))""")
        self.assertEqual(small, [])
        fonts = self.page.evaluate("""[...document.querySelectorAll('#host input, #host select, #host textarea')].map(el=>parseFloat(getComputedStyle(el).fontSize))""")
        self.assertTrue(all(size >= 16 for size in fonts), fonts)
    def test_crew_records_a_dump_fee_with_exact_cents_on_a_phone(self):
        self.open(); form = self.page.locator('.expense-form')
        expect(self.page.get_by_role('heading', name='Job costs')).to_be_visible()
        amount = self.page.get_by_label('Amount paid (USD)')
        expect(amount).to_have_attribute('inputmode', 'decimal'); expect(amount).to_have_attribute('type', 'text')
        expect(self.page.get_by_label('Take a receipt photo')).to_have_attribute('capture', 'environment')
        expect(self.page.get_by_label('Take a receipt photo')).to_have_attribute('accept', 'image/*')
        self.assert_phone_layout()
        self.page.get_by_label('Type of cost').select_option('dump_fee')
        amount.fill('84.50'); self.page.get_by_label('Store, landfill or vendor').fill('Synthetic County Landfill')
        form.get_by_role('button', name='Save cost').click()
        expect(self.page.get_by_role('status').filter(has_text='Cost saved to the job.')).to_be_visible()
        self.assertEqual(len(self.posts), 1); post = self.posts[0]
        self.assertTrue(UUID.match(post['requestId'])); self.assertEqual(post['amountCents'], 8450); self.assertIsInstance(post['amountCents'], int)
        self.assertEqual({key: post[key] for key in ['action','jobId','kind','vendor','note','expectedUser']}, {'action':'create','jobId':'job-1','kind':'dump_fee','vendor':'Synthetic County Landfill','note':'','expectedUser':'Crew.One'})
        self.assertNotIn('receiptDataUrl', post)
        item = self.page.locator('.expense-item'); expect(item).to_have_count(1); expect(item).to_contain_text('$84.50'); expect(item).to_contain_text('Dump / disposal fee')
        expect(self.page.locator('.expense-totals')).to_contain_text('Your recorded total')
        expect(amount).to_have_value('')
        self.assert_phone_layout()
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'field-expenses-mobile.png'), full_page=True)
    def test_invalid_amount_is_explained_without_a_request(self):
        self.open()
        self.page.get_by_label('Amount paid (USD)').fill('12.345'); self.page.get_by_label('Store, landfill or vendor').fill('Synthetic Hardware')
        self.page.get_by_role('button', name='Save cost').click()
        expect(self.page.get_by_role('alert')).to_contain_text('Enter an amount'); expect(self.page.get_by_label('Amount paid (USD)')).to_have_attribute('aria-invalid', 'true')
        self.page.get_by_label('Amount paid (USD)').fill('12.34'); self.page.get_by_label('Type of cost').select_option('other')
        self.page.get_by_role('button', name='Save cost').click(); expect(self.page.get_by_role('alert')).to_contain_text('other cost')
        self.assertEqual(self.posts, [])
    def test_lost_response_retries_the_same_request_after_reload(self):
        self.abort_posts = 1; self.open()
        self.page.get_by_label('Amount paid (USD)').fill('19.99'); self.page.get_by_label('Store, landfill or vendor').fill('Synthetic Lumber')
        self.page.get_by_role('button', name='Save cost').click()
        expect(self.page.get_by_text('Cost awaiting confirmation')).to_be_visible()
        expect(self.page.get_by_role('button', name='Save cost')).to_be_disabled()
        self.page.reload(); expect(self.page.get_by_text('Cost awaiting confirmation')).to_be_visible()
        self.page.get_by_role('button', name='Retry cost').click()
        expect(self.page.get_by_text('Cost awaiting confirmation')).to_have_count(0)
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.posts[0], self.posts[1]); self.assertEqual(self.posts[1]['amountCents'], 1999)
        expect(self.page.locator('.expense-item')).to_have_count(1)
        self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(k=>k.endsWith(':expense-pending'))"), [])
    def test_receipt_photo_is_compressed_to_jpeg_before_upload(self):
        self.open()
        self.page.get_by_label('Take a receipt photo').set_input_files(files=[{'name':'receipt.png','mimeType':'image/png','buffer':PNG}])
        expect(self.page.get_by_role('img', name='Receipt ready to upload')).to_be_visible()
        self.page.get_by_label('Amount paid (USD)').fill('$1,234.56'); self.page.get_by_label('Type of cost').select_option('material'); self.page.get_by_label('Store, landfill or vendor').fill('Synthetic Supply')
        self.page.get_by_role('button', name='Save cost').click()
        expect(self.page.locator('.expense-item')).to_contain_text('Receipt saved')
        self.assertTrue(self.posts[0]['receiptDataUrl'].startswith('data:image/jpeg;base64,')); self.assertEqual(self.posts[0]['amountCents'], 123456)
    def test_unavailable_receipt_storage_still_allows_the_amount(self):
        self.receipts = False; self.open()
        expect(self.page.get_by_text('Receipt photos are unavailable')).to_be_visible(); expect(self.page.get_by_label('Take a receipt photo')).to_have_count(0)
    def test_disabled_capture_hides_the_section(self):
        self.read_status = 404; self.open()
        expect(self.page.locator('#host')).to_be_hidden(); self.assertEqual(self.page.locator('#host').inner_text(), '')
    def test_loading_skeleton_then_unverifiable_response_is_an_error_not_empty(self):
        self.hold_reads = True; self.malformed = True; self.open()
        expect(self.page.get_by_role('status', name='Loading job costs')).to_be_visible()
        self.page.wait_for_timeout(50); route = self.held.pop(); route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok':True}))
        expect(self.page.get_by_role('alert')).to_contain_text('could not be verified')
        expect(self.page.get_by_text('You have not recorded any costs')).to_have_count(0)
    def test_manager_corrects_and_voids_with_reasons(self):
        self.manager = True
        self.entries = [row('11111111-1111-4111-8111-111111111111', expectedRevision='r1', recordedBy={'id':'Crew.One','name':'Crew One'}, receiptUrl='/api/field-expenses?jobId=job-1&expenseId=11111111-1111-4111-8111-111111111111&view=receipt', hasReceipt=True, receiptVerified=True, audit=[], voided=None, canEdit=True, canVoid=True),
            row('22222222-2222-4222-8222-222222222222', kind='material', amountCents=2500, vendor='Synthetic Hardware', expectedRevision='r2', recordedBy={'id':'Crew.Two','name':'Crew Two'}, receiptUrl=None, audit=[], voided=None, canEdit=True, canVoid=True)]
        self.open('?manager=1&user=ZacB')
        expect(self.page.locator('.expense-totals')).to_contain_text('Job total'); expect(self.page.locator('.expense-totals')).to_contain_text('$109.50')
        first = self.page.locator('.expense-item').nth(0)
        expect(first).to_contain_text('by Crew One'); expect(first.get_by_role('link', name='View receipt')).to_have_attribute('href', self.entries[0]['receiptUrl'])
        first.get_by_role('button', name='Correct').click()
        self.page.get_by_label('Corrected amount (USD)').fill('80.45'); self.page.get_by_role('button', name='Save correction').click()
        expect(self.page.get_by_role('alert')).to_contain_text('reason'); self.assertEqual(self.posts, [])
        self.page.get_by_label('Reason for correction (kept in audit trail)').fill('Receipt shows $80.45'); self.page.get_by_role('button', name='Save correction').click()
        expect(self.page.get_by_role('status').filter(has_text='Correction saved')).to_be_visible()
        self.assertEqual({key: self.posts[0][key] for key in ['action','expenseId','expectedRevision','amountCents','reason']}, {'action':'edit','expenseId':'11111111-1111-4111-8111-111111111111','expectedRevision':'r1','amountCents':8045,'reason':'Receipt shows $80.45'})
        self.assertNotIn('vendor', self.posts[0])
        expect(first).to_contain_text('Corrected'); expect(first.locator('summary')).to_contain_text('Audit trail · 1')
        second = self.page.locator('.expense-item').nth(1); second.get_by_role('button', name='Void').click()
        self.page.get_by_label('Reason for voiding (kept in audit trail)').fill('Duplicate entry'); self.page.get_by_role('button', name='Void cost').click()
        expect(second).to_contain_text('Void'); expect(second).to_contain_text('Duplicate entry')
        self.assertEqual({key: self.posts[1][key] for key in ['action','expenseId','expectedRevision','reason']}, {'action':'void','expenseId':'22222222-2222-4222-8222-222222222222','expectedRevision':'r2','reason':'Duplicate entry'})
        self.assertNotEqual(self.posts[0]['requestId'], self.posts[1]['requestId'])
        self.assert_phone_layout()
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'field-expenses-manager-mobile.png'), full_page=True)

    def test_job_page_mounts_costs_after_photos_and_keeps_the_draft_across_rerenders(self):
        self.page.goto(self.url + '/crew/job.html?jobId=job-1')
        expect(self.page.get_by_role('heading', name='Synthetic Garage', exact=True)).to_be_visible()
        card = self.page.locator('#field-expenses-card'); expect(card.get_by_role('heading', name='Job costs')).to_be_visible()
        self.assertEqual(self.page.evaluate("document.querySelector('#field-expenses-card').previousElementSibling.id"), 'photos-card')
        card.get_by_label('Amount paid (USD)').fill('12.00'); card.get_by_label('Store, landfill or vendor').fill('Synthetic Hardware')
        self.page.locator('[data-check="departure-address"]').check()
        expect(self.page.locator('[data-check="departure-address"]')).to_be_checked()
        self.assertEqual(len(self.job_posts), 1)
        expect(card.get_by_label('Amount paid (USD)')).to_have_value('12.00'); expect(card.get_by_label('Store, landfill or vendor')).to_have_value('Synthetic Hardware')
        self.assertEqual(self.expense_reads, 1, 'job re-renders reuse the loaded costs')
        card.get_by_role('button', name='Save cost').click()
        expect(card.locator('.expense-item')).to_contain_text('$12.00'); self.assertEqual(self.posts[0]['amountCents'], 1200)
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))

    def test_disabled_flag_skips_the_card_and_the_cost_api_on_the_job_page(self):
        for features in [{'jobCosts':False}, None]:
            self.features = features; self.expense_reads = 0
            self.page.goto(self.url + '/crew/job.html?jobId=job-1')
            expect(self.page.get_by_role('heading', name='Synthetic Garage', exact=True)).to_be_visible()
            expect(self.page.locator('#photos-card')).to_be_visible()
            self.page.wait_for_timeout(100)
            expect(self.page.locator('#field-expenses-card')).to_have_count(0)
            expect(self.page.get_by_role('heading', name='Job costs')).to_have_count(0)
            self.assertEqual(self.expense_reads, 0, f'no cost request when features={features}')
        self.assertEqual(self.posts, [])
    def test_choosing_other_marks_the_note_required_immediately(self):
        self.open()
        expect(self.page.get_by_label('Note (optional)')).to_be_visible()
        self.page.get_by_label('Store, landfill or vendor').fill('Synthetic Rental Yard')
        self.page.get_by_label('Type of cost').select_option('other')
        note = self.page.get_by_label('What was it for? (required)')
        expect(note).to_be_visible(); expect(note).to_have_attribute('required', '')
        expect(self.page.get_by_label('Type of cost')).to_be_focused()
        expect(self.page.get_by_label('Store, landfill or vendor')).to_have_value('Synthetic Rental Yard')
        self.page.get_by_label('Type of cost').select_option('material')
        expect(self.page.get_by_label('Note (optional)')).to_be_visible(); self.assertEqual(self.posts, [])
        self.assert_phone_layout()
    def test_manager_corrects_the_purchase_date_in_mountain_time(self):
        self.manager = True
        self.entries = [row('11111111-1111-4111-8111-111111111111', expectedRevision='r1', recordedBy={'id':'Crew.One','name':'Crew One'}, receiptUrl=None, audit=[], voided=None, canEdit=True, canVoid=True)]
        self.open('?manager=1&user=ZacB')
        self.page.locator('.expense-item').get_by_role('button', name='Correct').click()
        date = self.page.get_by_label('Purchase date (Mountain Time)')
        expect(date).to_have_value('2026-09-22'); expect(date).to_have_attribute('type', 'date')
        expect(date).to_have_attribute('max', '2026-09-22'); expect(date).to_have_attribute('min', '2025-09-21')
        self.page.get_by_label('Reason for correction (kept in audit trail)').fill('Dump run was the day before')
        date.fill('2026-09-23'); self.page.get_by_role('button', name='Save correction').click()
        expect(self.page.get_by_role('alert')).to_contain_text('purchase date within the last year'); self.assertEqual(self.posts, [])
        edit = self.page.locator('.expense-edit')
        edit.get_by_label('Type of cost').select_option('other')
        expect(edit.get_by_label('What was it for? (required)')).to_be_visible(); expect(edit.get_by_label('Type of cost')).to_be_focused()
        expect(self.page.get_by_label('Purchase date (Mountain Time)')).to_have_value('2026-09-23')
        edit.get_by_label('Type of cost').select_option('dump_fee')
        self.page.get_by_label('Purchase date (Mountain Time)').fill('2026-09-21'); self.page.get_by_role('button', name='Save correction').click()
        expect(self.page.get_by_role('status').filter(has_text='Correction saved')).to_be_visible()
        self.assertEqual({key: self.posts[0].get(key) for key in ['action','expenseId','incurredOn','reason']}, {'action':'edit','expenseId':'11111111-1111-4111-8111-111111111111','incurredOn':'2026-09-21','reason':'Dump run was the day before'})
        for key in ['amountCents','kind','vendor','note']: self.assertNotIn(key, self.posts[0])
        expect(self.page.locator('.expense-item')).to_contain_text('purchased Sep 21, 2026')
        self.assert_phone_layout()
    def test_a_voided_retry_is_reported_as_void_not_saved(self):
        self.abort_posts = 1; self.open()
        self.page.get_by_label('Amount paid (USD)').fill('25.00'); self.page.get_by_label('Store, landfill or vendor').fill('Synthetic Lumber')
        self.page.get_by_role('button', name='Save cost').click()
        expect(self.page.get_by_text('Cost awaiting confirmation')).to_be_visible()
        reads = self.expense_reads
        self.post_error = (409, 'FIELD_EXPENSE_VOID', 'Operations voided this cost before its receipt was confirmed, so it does not count toward the job. Record it again only if operations asks.')
        self.page.get_by_role('button', name='Retry cost').click()
        expect(self.page.get_by_role('alert').filter(has_text='Operations voided this cost')).to_be_visible()
        expect(self.page.get_by_text('Cost awaiting confirmation')).to_have_count(0)
        expect(self.page.get_by_text('Cost saved to the job.')).to_have_count(0)
        expect(self.page.get_by_label('Amount paid (USD)')).to_have_value('')
        self.assertGreater(self.expense_reads, reads, 'the list is reloaded from the server')
        self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(k=>k.endsWith(':expense-pending'))"), [])
    def test_an_applied_replay_of_a_voided_cost_says_it_was_voided(self):
        self.entry_status = 'void'; self.open()
        self.page.get_by_label('Amount paid (USD)').fill('9.00'); self.page.get_by_label('Store, landfill or vendor').fill('Synthetic Hardware')
        self.page.get_by_role('button', name='Save cost').click()
        expect(self.page.get_by_role('alert')).to_contain_text('operations has since voided it')
        expect(self.page.get_by_text('Cost saved to the job.')).to_have_count(0)
    def test_closed_job_reply_reloads_the_list(self):
        self.open(); reads = self.expense_reads
        self.post_error = (409, 'FIELD_JOB_CLOSED', 'This job is cancelled. Ask operations before recording costs.')
        self.page.get_by_label('Amount paid (USD)').fill('9.00'); self.page.get_by_label('Store, landfill or vendor').fill('Synthetic Hardware')
        self.page.get_by_role('button', name='Save cost').click()
        expect(self.page.get_by_role('alert').first).to_contain_text('This job is cancelled')
        expect(self.page.get_by_text('Cost awaiting confirmation')).to_have_count(0)
        self.assertGreater(self.expense_reads, reads)

if __name__ == '__main__':
    unittest.main(verbosity=2)
