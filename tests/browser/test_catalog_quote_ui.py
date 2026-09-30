"""Catalog composer and the existing quote save/send UI, with synthetic API replies only."""
import copy, datetime, json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
OVERVIEW = {'enabled': True, 'publication': {'version': '2026-09-30.1'},
    'settings': {'readyForCustomers': True, 'settingsVersion': 'synthetic-approved'},
    'catalog': {'categories': [{'id': 'shelving', 'label': 'Shelving'}], 'items': [
        {'id': 'shelf', 'kind': 'product', 'availability': 'active', 'priceVerified': True, 'name': 'Synthetic heavy-duty storage shelf with a long name', 'category': 'shelving', 'priceUnit': 'per shelf'},
        {'id': 'unchecked', 'kind': 'product', 'availability': 'active', 'priceVerified': False, 'name': 'Unverified shelf', 'category': 'shelving', 'priceUnit': 'per shelf'},
        {'id': 'stale', 'kind': 'product', 'availability': 'active', 'priceVerified': True, 'name': 'Stale shelf', 'category': 'shelving', 'priceUnit': 'per shelf'}]},
    'prices': {'shelf': {'quotable': True, 'stale': False, 'unitCents': 25000}, 'unchecked': {'quotable': True, 'stale': True, 'unitCents': 10000}, 'stale': {'quotable': True, 'stale': True, 'unitCents': 10000}}}
PAGE = ('<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app-touch.css">'
        '<link rel="stylesheet" href="/crew/quote-draft.css"><link rel="stylesheet" href="/employee-catalog-quote.css"></head><body>'
        '<button id="open">Build catalog quote</button><script src="/crew/quote-draft.js"></script><script src="/employee-catalog-quote.js"></script>'
        '<script>const overview='+json.dumps(OVERVIEW)+';document.getElementById("open").onclick=()=>EGCCatalogQuote.open({overview,identity:"synthetic.owner",hubFetch:(...args)=>fetch(...args),reloadOverview:async()=>{const r=await fetch("/api/catalog");return r.json();}});</script></body></html>').encode()

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if urlparse(self.path).path == '/':
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(PAGE)
        else: super().do_GET()

class CatalogQuoteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT/'test-results').mkdir(exist_ok=True)
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever,daemon=True).start(); cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start(); kind=os.environ.get('EGC_TEST_BROWSER','chromium')
        cls.browser=getattr(cls.pw,kind).launch(headless=True)
    @classmethod
    def tearDownClass(cls): cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':375,'height':812},is_mobile=True,has_touch=True)
        self.page=self.context.new_page(); self.page.set_default_timeout(5000)
        self.page.clock.install(time=datetime.datetime(2026,9,30,16,tzinfo=datetime.timezone.utc))
        self.posts=[]; self.errors=[]; self.abort_saves=0; self.price_error=False; self.save_price_error=False; self.saved=None; self.last_price=None
        self.page.on('pageerror',lambda error:self.errors.append(str(error))); self.page.route('**/*',self.route)
    def tearDown(self): self.context.close(); self.assertEqual(self.errors,[])
    def job(self,status='draft'):
        draft=self.saved
        return {'id':'dispatch_catalog1','revision':'r1','customerId':'customer1','status':'unscheduled','quoteStatus':status,
            'estimate':{'number':'EST-CATALOG1','revision':1,'status':status,'amountCents':45000,'depositRequiredCents':13500,'validUntil':draft['valid_until'],'lineItems':draft['line_items']}}
    def route(self,route):
        req=route.request; path=urlparse(req.url)
        if path.hostname!='127.0.0.1': route.abort(); return
        send=lambda body,status=200:route.fulfill(status=status,content_type='application/json',body=json.dumps(body))
        if path.path=='/api/catalog':
            current=copy.deepcopy(OVERVIEW); current['settings']['settingsVersion']='synthetic-approved-v2'; send(current); return
        if path.path=='/api/walkthrough-handoff': send({'ok':True,'viewer':{'id':'synthetic.owner'},'customerId':'','jobId':'','sourceRevision':'','roster':[]}); return
        if path.path=='/api/customer-resolve': send({'ok':True,'customer':{'id':'customer1'}}); return
        if path.path!='/api/quote-draft': route.continue_(); return
        data=req.post_data_json; self.posts.append(copy.deepcopy(data))
        if data['action']=='catalog_preview':
            if self.price_error: send({'ok':False,'code':'quote_draft_catalog_version_changed','error':'Catalog pricing changed. Refresh the catalog and review again.'},409); return
            descriptor=data['catalogPricing']; lines=[]
            for selection in descriptor['items']:
                unit=10000 if selection['customerSupplied'] else 25000
                lines.append({'id':selection['id'],'kind':'product','name':OVERVIEW['catalog']['items'][0]['name'],'quantity':selection['quantity'],'unitCents':unit,'totalCents':unit*selection['quantity'],'customerSupplied':selection['customerSupplied'],'catalog':{'itemId':selection['itemId'],'version':descriptor['catalogVersion']}})
            subtotal=sum(line['totalCents'] for line in lines); adjustment=max(0,45000-subtotal)
            if adjustment: lines.append({'id':'catalog-minimum','kind':'fee','name':'Minimum installation charge','quantity':1,'unitCents':adjustment,'totalCents':adjustment})
            total=subtotal+adjustment
            self.last_price={'ok':True,'catalogPricing':descriptor,'lineItems':lines,'subtotalCents':subtotal,'minimumAdjustmentCents':adjustment,'totalCents':total,'depositCents':round(total*.3),'depositPct':30,'catalogVersion':descriptor['catalogVersion'],'settingsVersion':descriptor['settingsVersion']}
            send(self.last_price); return
        if data['action']=='save':
            if self.save_price_error: send({'ok':False,'code':'quote_draft_catalog_version_changed','error':'Catalog prices changed. Review updated prices.'},409); return
            if self.abort_saves: self.abort_saves-=1; route.abort('connectionreset'); return
            self.saved=data['draft']; send({'ok':True,'requestId':data['requestId'],'job':self.job(),'warnings':[]}); return
        if data['action']=='send_preview': send({'ok':True,'job':self.job(),'delivery':{'mode':'off'},'summary':'Review this synthetic customer quote','confirmToken':'synthetic-confirm-token','expiresAt':'2026-09-30T16:05:00Z'}); return
        send({'ok':True,'requestId':data['requestId'],'job':self.job('sent'),'delivery':{'status':'messaging_disabled'},'warnings':[]})
    def open(self):
        self.page.goto(self.url); self.page.get_by_role('button',name='Build catalog quote').click()
        self.dialog=self.page.get_by_role('dialog',name='Build a catalog quote'); expect(self.dialog).to_be_visible(); return self.dialog
    def prepare(self):
        self.open(); self.dialog.get_by_label('Customer name',exact=True).fill('Synthetic Customer')
        self.dialog.get_by_label('Phone',exact=True).fill('9705550100'); self.dialog.get_by_label('Service address',exact=True).fill('100 Synthetic Lane')
        self.dialog.get_by_role('button',name='Add',exact=True).click()
    def preview(self):
        self.dialog.get_by_role('button',name='Review exact price').click(); expect(self.dialog.get_by_role('heading',name='Price review')).to_be_visible()
    def handoff(self):
        self.dialog.get_by_role('button',name='Continue to save draft').click()
        self.review=self.page.get_by_role('dialog',name='Review catalog quote'); expect(self.review).to_be_visible()
    def layout(self,selector):
        for width in (320,375,390,1280):
            self.page.set_viewport_size({'width':width,'height':812})
            self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            self.assertEqual(self.page.locator(selector).evaluate("root=>[...root.querySelectorAll('button,input:not([type=checkbox]),select')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.height<44}).map(e=>e.outerHTML.slice(0,80))"),[])
            self.assertEqual(self.page.locator(selector).evaluate("root=>[...root.querySelectorAll('input:not([type=checkbox]),select')].filter(e=>parseFloat(getComputedStyle(e).fontSize)<16).length"),0)
            self.assertEqual(self.page.locator(selector).evaluate('root=>getComputedStyle(root).touchAction'),'manipulation')
        self.page.set_viewport_size({'width':375,'height':812})
    def test_verified_selection_exact_deposit_and_separate_send(self):
        self.prepare(); expect(self.dialog.get_by_text('Unverified shelf',exact=True)).to_have_count(0); expect(self.dialog.get_by_text('Stale shelf',exact=True)).to_have_count(0)
        self.dialog.get_by_label('Customer supplies product').check(); self.dialog.get_by_role('spinbutton').fill('2'); self.dialog.get_by_role('spinbutton').press('Tab')
        self.layout('.cq-dialog'); self.page.screenshot(path=str(ROOT/'test-results/catalog-quote-builder-375.png'))
        self.preview(); expect(self.dialog.get_by_text('Deposit due: $135.00')).to_be_visible(); self.layout('.cq-dialog')
        expect(self.dialog.get_by_label('Customer name',exact=True)).to_have_count(0); expect(self.dialog.get_by_role('heading',name='Synthetic Customer')).to_be_visible(); self.dialog.evaluate('e=>e.scrollTop=0'); self.page.screenshot(path=str(ROOT/'test-results/catalog-quote-price-375.png'))
        self.handoff(); self.review.get_by_role('button',name='Save draft',exact=True).click()
        expect(self.review.get_by_text('Deposit due: $135.00')).to_be_visible(); self.layout('.qd-dialog'); self.page.screenshot(path=str(ROOT/'test-results/catalog-quote-confirm-375.png'))
        self.assertEqual([row['action'] for row in self.posts],['catalog_preview','save','send_preview'])
        self.assertEqual(self.saved['catalog_pricing'],self.last_price['catalogPricing']); self.assertEqual(self.saved['line_items'],self.last_price['lineItems'])
        self.review.get_by_role('button',name='Mark as sent').click(); expect(self.review.get_by_role('button',name='Done')).to_be_visible()
    def test_uncertain_save_recovers_exact_original_after_reload(self):
        self.abort_saves=1; self.prepare(); self.preview(); self.handoff(); self.review.get_by_role('button',name='Save draft',exact=True).click()
        expect(self.review.get_by_role('button',name='Retry original save')).to_be_visible(); first=copy.deepcopy(next(row for row in self.posts if row['action']=='save'))
        self.open(); expect(self.dialog.get_by_text('The last save was not confirmed.',exact=False)).to_be_visible()
        self.dialog.get_by_role('button',name='Review original save').click(); self.review=self.page.get_by_role('dialog',name='Review catalog quote')
        self.review.get_by_role('button',name='Retry original save').click(); expect(self.review.get_by_role('button',name='Mark as sent')).to_be_visible()
        saves=[row for row in self.posts if row['action']=='save']; self.assertEqual(saves,[first,first]); self.assertEqual(len([row for row in self.posts if row['action']=='catalog_preview']),1)
    def test_price_refusal_keeps_customer_and_selections(self):
        self.prepare(); self.price_error=True; self.dialog.get_by_role('button',name='Review exact price').click()
        expect(self.dialog.get_by_role('alert')).to_contain_text('pricing changed'); expect(self.dialog.get_by_label('Customer name',exact=True)).to_have_value('Synthetic Customer')
        expect(self.dialog.get_by_role('spinbutton')).to_have_value('1'); self.assertEqual(len(self.posts),1)
        self.price_error=False; self.dialog.get_by_role('button',name='Review updated prices').click()
        self.dialog=self.page.get_by_role('dialog',name='Build a catalog quote'); expect(self.dialog.get_by_label('Customer name',exact=True)).to_have_value('Synthetic Customer')
        self.preview(); self.assertEqual(len(self.posts),2)
    def test_signout_clears_draft_and_closes_review(self):
        self.prepare(); self.preview(); self.handoff()
        self.page.evaluate("window.dispatchEvent(new CustomEvent('egc:signout'))")
        expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(k=>k.startsWith('egc.hub.draft.v1.catalogquote.'))"),[])
    def test_changed_prices_return_to_current_catalog_without_losing_selections(self):
        self.save_price_error=True; self.prepare(); self.preview(); self.handoff()
        self.review.get_by_role('button',name='Save draft',exact=True).click()
        expect(self.review.get_by_role('button',name='Review updated prices')).to_be_visible()
        old=next(row for row in self.posts if row['action']=='save')
        self.review.get_by_role('button',name='Review updated prices').click()
        self.dialog=self.page.get_by_role('dialog',name='Build a catalog quote')
        expect(self.dialog.get_by_label('Customer name',exact=True)).to_have_value('Synthetic Customer')
        expect(self.dialog.get_by_role('spinbutton')).to_have_value('1')
        self.save_price_error=False; self.preview(); self.handoff(); self.review.get_by_role('button',name='Save draft',exact=True).click()
        expect(self.review.get_by_role('button',name='Mark as sent')).to_be_visible()
        new=[row for row in self.posts if row['action']=='save'][-1]
        self.assertEqual(new['draft']['catalog_pricing']['settingsVersion'],'synthetic-approved-v2')
        self.assertNotEqual(new['requestId'],old['requestId'])
    def test_late_save_cannot_restore_customer_details_after_signout(self):
        self.prepare(); self.preview(); self.handoff(); held=[]
        def hold_save(route):
            if route.request.post_data_json['action']=='save': held.append(route)
            else: self.route(route)
        self.page.route('**/api/quote-draft',hold_save)
        self.review.get_by_role('button',name='Save draft',exact=True).click()
        expect(self.review.get_by_role('button',name='Saving draft…',exact=True)).to_be_visible()
        self.page.wait_for_timeout(100); self.assertEqual(len(held),1)
        self.page.evaluate("window.dispatchEvent(new CustomEvent('egc:signout'))")
        self.route(held[0]); self.page.wait_for_timeout(100)
        expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(k=>k.startsWith('egc.hub.draft.v1.catalogquote.'))"),[])

if __name__=='__main__': unittest.main()
