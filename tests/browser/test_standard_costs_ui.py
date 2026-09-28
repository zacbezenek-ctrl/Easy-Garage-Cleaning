"""Phone-sized Stocked item costs screen (FUN-19) against an isolated /api/standard-costs fixture."""
import copy, datetime, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
PAGE = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-standard-costs.css"></head><body style="margin:0;padding:12px;background:#f1f0ec"><main id="host"></main><script src="/employee-ui-kit.js"></script><script src="/employee-standard-costs.js"></script><script>sessionStorage.setItem("egc_u", new URLSearchParams(location.search).get("user")||"zacb");EGCStandardCosts.mount(document.querySelector("#host"),{})</script></body></html>'
CATEGORIES = [{'id':'shelving','label':'Shelving'},{'id':'small-items','label':'Small items, totes and hooks'},{'id':'overhead','label':'Overhead storage'}]
ITEMS = [
    {'id':'shelving-husky-5tier','name':'Husky 5-Tier Steel Garage Shelving Unit, 48 in. W x 24 in. D x 78 in. H','category':'shelving','priceUnit':'each'},
    {'id':'tote-hdx-27-gallon','name':'HDX 27 Gallon Tough Storage Tote with Snap Lid','category':'small-items','priceUnit':'each'},
    {'id':'rack-fleximounts-4x8','name':'FLEXIMOUNTS 4x8 Overhead Garage Storage Rack','category':'overhead','priceUnit':'each'},
] + [{'id':f'synthetic-hook-{index:02d}','name':f'Synthetic wall hook {index:02d}','category':'small-items','priceUnit':'per 2-pack'} for index in range(50)]

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if urlparse(self.path).path == '/':
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(PAGE)
        else: super().do_GET()

class StandardCostsBrowserTests(unittest.TestCase):
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
        self.errors = []; self.posts = []; self.costs = {'rack-fleximounts-4x8':16550}; self.revision = 'rev-1'; self.can_edit = True
        self.abort_posts = 0; self.post_error = None; self.malformed = False; self.gets = 0; self.receipts = {}
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def overview(self):
        items = [{**item, 'standardUnitCostCents':self.costs.get(item['id']), 'updatedAt':'2026-09-20T16:00:00.000Z' if item['id'] in self.costs else None, 'updatedBy':'zacb' if item['id'] in self.costs else None} for item in ITEMS]
        return {'ok':True,'authority':'employee_hub','basis':'standard_unit_cost','asOf':'2026-09-22T18:00:00.000Z','catalogVersion':'2026-09-27.1','revision':self.revision,'updatedAt':None,'updatedBy':None,'categories':CATEGORIES,'items':items,'retired':[],'coverage':{'set':sum(1 for item in items if item['standardUnitCostCents'] is not None),'total':len(items)},'canEdit':self.can_edit}
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/standard-costs': route.continue_(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if req.method == 'GET':
            self.gets += 1; self.assertEqual(parsed.query, ''); send({'ok':True} if self.malformed else self.overview()); return
        body = req.post_data_json; self.posts.append(copy.deepcopy(body))
        if self.abort_posts: self.abort_posts -= 1; route.abort('connectionreset'); return
        if self.post_error: status, code, message = self.post_error; self.post_error = None; send({'ok':False,'code':code,'error':message}, status); return
        if body['requestId'] in self.receipts: send({**self.overview(), 'requestId':body['requestId'], 'replayed':True}); return
        self.assertEqual(body['expectedRevision'], self.revision)
        for change in body['changes']:
            if change['standardUnitCostCents'] is None: self.costs.pop(change['itemId'], None)
            else: self.costs[change['itemId']] = change['standardUnitCostCents']
        self.revision = self.revision + '-next'; self.receipts[body['requestId']] = True
        send({**self.overview(), 'requestId':body['requestId'], 'replayed':False})
    def open(self, user='zacb'):
        self.page.goto(f'{self.url}/?user={user}')
        expect(self.page.get_by_role('heading', name='Stocked item costs')).to_be_visible()
    def cost(self, name):
        return self.page.get_by_label(re.compile(f'^Cost per .* for {re.escape(name)}'))
    def assert_phone_layout(self):
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', self.page.locator('#host').inner_text()))
        small = self.page.evaluate("""[...document.querySelectorAll('#host button, #host input, #host select')].filter(el=>el.offsetParent).filter(el=>el.getBoundingClientRect().height<44).map(el=>el.outerHTML.slice(0,80))""")
        self.assertEqual(small, [])
        fonts = self.page.evaluate("""[...document.querySelectorAll('#host input, #host select, #host textarea')].map(el=>parseFloat(getComputedStyle(el).fontSize))""")
        self.assertTrue(all(size >= 16 for size in fonts), fonts)

    def test_owner_sets_and_clears_costs_in_exact_cents_on_a_phone(self):
        self.open()
        expect(self.page.get_by_text('1 of 53 catalog items have a standard cost.')).to_be_visible()
        shelf = self.cost('Husky 5-Tier Steel Garage Shelving Unit, 48 in. W x 24 in. D x 78 in. H')
        expect(shelf).to_have_attribute('inputmode', 'decimal'); expect(shelf).to_have_attribute('placeholder', 'Not set')
        expect(self.cost('FLEXIMOUNTS 4x8 Overhead Garage Storage Rack')).to_have_value('165.50')
        self.assert_phone_layout()
        shelf.fill('$1,089.99'); self.cost('HDX 27 Gallon Tough Storage Tote with Snap Lid').fill('12.5'); self.cost('FLEXIMOUNTS 4x8 Overhead Garage Storage Rack').fill('')
        bar = self.page.get_by_role('region', name='Unsaved stocked item costs')
        expect(bar).to_contain_text('3 unsaved changes')
        bar.get_by_label('Note for the audit log (optional)').fill('Supplier invoice, September')
        self.assert_phone_layout()
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'standard-costs-mobile.png'), full_page=True)
        bar.get_by_role('button', name='Save costs').click()
        expect(self.page.get_by_role('status').filter(has_text='Saved 3 costs.')).to_be_visible()
        self.assertEqual(len(self.posts), 1); post = self.posts[0]
        self.assertTrue(UUID.match(post['requestId']))
        self.assertEqual({key: post[key] for key in ['action','expectedRevision','changes','reason']}, {'action':'standard_costs.set','expectedRevision':'rev-1','reason':'Supplier invoice, September','changes':[
            {'itemId':'shelving-husky-5tier','standardUnitCostCents':108999},{'itemId':'tote-hdx-27-gallon','standardUnitCostCents':1250},{'itemId':'rack-fleximounts-4x8','standardUnitCostCents':None}]})
        expect(self.page.get_by_text('2 of 53 catalog items have a standard cost.')).to_be_visible()
        expect(shelf).to_have_value('1089.99'); expect(bar).to_have_count(0)
        self.assert_phone_layout()
    def test_invalid_costs_are_flagged_and_never_sent(self):
        self.open()
        tote = self.cost('HDX 27 Gallon Tough Storage Tote with Snap Lid'); tote.fill('12.345')
        expect(tote).to_have_attribute('aria-invalid', 'true')
        bar = self.page.get_by_role('region', name='Unsaved stocked item costs'); expect(bar).to_contain_text('1 to fix')
        expect(bar.get_by_role('button', name='Save costs')).to_be_disabled()
        tote.fill('0'); expect(tote).to_have_attribute('aria-invalid', 'true')
        tote.fill('12.34'); expect(tote).not_to_have_attribute('aria-invalid', 'true'); expect(bar.get_by_role('button', name='Save costs')).to_be_enabled()
        bar.get_by_role('button', name='Discard changes').click(); expect(tote).to_have_value('')
        self.assertEqual(self.posts, [])
    def test_lost_response_keeps_the_save_and_retries_it_unchanged(self):
        self.abort_posts = 1; self.open()
        self.cost('HDX 27 Gallon Tough Storage Tote with Snap Lid').fill('9.99')
        self.page.get_by_role('button', name='Save costs').click()
        expect(self.page.get_by_text('A save was not confirmed')).to_be_visible()
        expect(self.page.get_by_role('button', name='Save costs')).to_be_disabled()
        self.page.reload(); expect(self.page.get_by_text('A save was not confirmed')).to_be_visible()
        self.page.get_by_role('button', name='Retry original save').click()
        expect(self.page.get_by_role('status').filter(has_text='Saved')).to_be_visible()
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.posts[0], self.posts[1])
        expect(self.page.get_by_text('A save was not confirmed')).to_have_count(0)
        self.assertEqual(self.costs['tote-hdx-27-gallon'], 999)
    def test_a_revision_conflict_keeps_edits_and_loads_the_latest(self):
        self.open()
        self.cost('HDX 27 Gallon Tough Storage Tote with Snap Lid').fill('14.00')
        self.revision = 'rev-2'; self.costs['shelving-husky-5tier'] = 9900
        self.post_error = (409, 'standard_cost_revision_conflict', 'Standard costs changed while you were editing. Your changes are kept; load the latest costs and save again.')
        self.page.get_by_role('button', name='Save costs').click()
        expect(self.page.get_by_role('alert').filter(has_text='Your edits are kept')).to_be_visible()
        self.page.get_by_role('button', name='Load latest costs (keeps your edits)').click()
        expect(self.cost('Husky 5-Tier Steel Garage Shelving Unit, 48 in. W x 24 in. D x 78 in. H')).to_have_value('99.00')
        expect(self.cost('HDX 27 Gallon Tough Storage Tote with Snap Lid')).to_have_value('14.00')
        self.page.get_by_role('button', name='Save costs').click()
        expect(self.page.get_by_role('status').filter(has_text='Saved 1 cost.')).to_be_visible()
        self.assertEqual(self.posts[1]['expectedRevision'], 'rev-2'); self.assertNotEqual(self.posts[0]['requestId'], self.posts[1]['requestId'])
    def test_search_category_and_paging_on_a_phone(self):
        self.open()
        expect(self.page.locator('.sc-item')).to_have_count(40)
        self.page.get_by_role('button', name=re.compile('^Show 13 more of 13')).click(); expect(self.page.locator('.sc-item')).to_have_count(53)
        self.page.get_by_label('Search items').fill('tote'); expect(self.page.locator('.sc-item')).to_have_count(1)
        expect(self.page.get_by_label('Search items')).to_be_focused()
        self.page.get_by_label('Search items').fill(''); self.page.get_by_label('Category').select_option('overhead'); expect(self.page.locator('.sc-item')).to_have_count(1)
        self.page.get_by_label('Category').select_option(''); only = self.page.get_by_role('button', name='Only items with a cost'); only.click()
        expect(self.page.get_by_role('button', name='✓ Only items with a cost')).to_have_attribute('aria-pressed', 'true'); expect(self.page.locator('.sc-item')).to_have_count(1)
        self.page.get_by_label('Search items').fill('zzz'); expect(self.page.get_by_text('No catalog items match')).to_be_visible()
        self.assert_phone_layout()
    def test_managers_see_costs_read_only(self):
        self.can_edit = False; self.open('tylerg')
        expect(self.page.get_by_text('Only the owner can change them.')).to_be_visible()
        expect(self.page.locator('.sc-cost input')).to_have_count(0); expect(self.page.get_by_role('button', name='Save costs')).to_have_count(0)
        expect(self.page.locator('[data-item="rack-fleximounts-4x8"]')).to_contain_text('$165.50')
        expect(self.page.locator('[data-item="tote-hdx-27-gallon"]')).to_contain_text('Not set')
        self.assert_phone_layout()
    def test_an_unverifiable_load_is_an_error_with_retry_not_an_empty_list(self):
        self.malformed = True; self.page.goto(f'{self.url}/?user=zacb')
        expect(self.page.get_by_role('alert')).to_contain_text('Stocked item costs are unavailable')
        expect(self.page.locator('.sc-item')).to_have_count(0)
        self.malformed = False; self.page.get_by_role('button', name='Retry').click()
        expect(self.page.locator('.sc-item')).to_have_count(40)

if __name__ == '__main__':
    unittest.main(verbosity=2)
