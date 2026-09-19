"""Actual Action Center browser tests with isolated HTTP fixtures; no customer/provider access."""
import json, pathlib, threading, unittest, uuid, datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=pathlib.Path(__file__).resolve().parents[2]
NOW=datetime.datetime.now(datetime.timezone.utc)
def at(hours=1): return (NOW+datetime.timedelta(hours=hours)).isoformat().replace('+00:00','Z')
def task(**extra):
    return {'id':str(uuid.uuid4()),'revision':1,'title':'Call synthetic customer','description':'An explicit commitment','kind':'callback','status':'open','priority':'high','assignedUserId':'test-owner','dueAt':at(),'waitingOn':'none','reviewAt':None,'approvalStatus':'not_required','completionCondition':'Record the call result','sourceEvidence':[],'completionEvidence':[],**extra}
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path=='/':
            body=b'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated EGC UI</title><link rel="stylesheet" href="/employee-operations.css"></head><body><main id="host"></main><script src="/employee-operations.js"></script><script>EGCActionCenter.mount(document.querySelector("#host"))</script></body></html>'
            self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(body)
        else: super().do_GET()
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'])
    @classmethod
    def tearDownClass(cls): cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':1360,'height':1000});self.page=self.context.new_page()
        self.items=[task()];self.calls=[];self.enabled=True;self.fail_once=False;self.stale=False;self.errors=[]
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.route('**/*',self.route)
    def tearDown(self):
        self.assertEqual(self.errors,[],f'Browser console errors: {self.errors}')
        self.context.close()
    def route(self,route):
        req=route.request;p=urlparse(req.url)
        if p.hostname!='127.0.0.1': route.abort();return
        if p.path!='/api/operations': route.continue_();return
        def send(body,status=200):route.fulfill(status=status,content_type='application/json',body=json.dumps(body))
        if req.method=='GET':send({'ok':True,'enabled':self.enabled,'actor':{'id':'test-owner','role':'owner','kind':'human'},'owners':[{'id':'test-owner','name':'Test owner','role':'owner'}]});return
        r=req.post_data_json;self.calls.append(r);c=r['body'];name=c['command']
        if name=='queue':
            rows=[t for t in self.items if t['status'] in ['open','in_progress','blocked']]
            if c['view']=='approvals':rows=[t for t in rows if t['approvalStatus'] in ['pending','invalidated']]
            if c['view']=='blocked':rows=[t for t in rows if t['status']=='blocked']
            if c['view']=='waiting':rows=[t for t in rows if t['waitingOn'] in ['customer','provider']]
            if c['view']=='ownerless':rows=[t for t in rows if not t['assignedUserId']]
            send({'ok':True,'items':rows,'total':len(rows),'nextOffset':None,'coverage':{'registeredTasks':'complete','inferredCommitments':'not_complete'}})
        elif name=='task.get':
            t=next(t for t in self.items if t['id']==c['taskId']);send({'ok':True,'task':t,'previewHash':'a'*64,'effectiveApproval':t['approvalStatus'],'history':[],'approvals':[],'externalExecution':False})
        elif name in ['task.create','task.edit']:
            if self.fail_once:self.fail_once=False;send({'error':'operations_unavailable'},503);return
            if self.stale:send({'error':'task_revision_conflict','currentRevision':2},409);return
            if name=='task.create':t=task(**{k:v for k,v in c['task'].items() if k!='draft'});self.items.append(t)
            else:t=next(t for t in self.items if t['id']==c['taskId']);t.update(c['changes']);t['revision']+=1
            send({'ok':True,'task':t})
        elif name=='tasks.approve':
            for a in c['items']:next(t for t in self.items if t['id']==a['taskId'])['approvalStatus']='approved'
            send({'ok':True,'externalExecution':False,'scope':'draft_review'})
        elif name=='brief.latest':send({'ok':True,'brief':None})
        elif name=='calendar':send({'error':'portal_authority_unavailable'},503)
        else:send({'ok':True})
    def open(self):
        self.page.goto(self.url);expect(self.page.locator('[data-ac-content]')).not_to_contain_text('Checking your signed-in account')
        if self.enabled:expect(self.page.locator('[data-ac-content]')).to_contain_text(self.items[0]['title'])
    def detail(self):self.page.locator('.ac-row').filter(has_text=self.items[0]['title']).first.click();expect(self.page.get_by_role('dialog')).to_contain_text('Completion condition')
    def fill_create(self):
        self.page.get_by_role('button',name='New action',exact=True).click();self.page.get_by_label('Action',exact=True).fill('New synthetic commitment');self.page.get_by_label('What proves completion?',exact=True).fill('A recorded callback outcome')
    def test_disabled_is_not_a_fake_empty_queue(self):
        self.enabled=False;self.open();expect(self.page.locator('[data-ac-content]')).to_contain_text('not an empty work queue');self.assertEqual([r for r in self.calls if r['body']['command']=='queue'],[])
    def test_desktop_and_mobile_have_no_horizontal_overflow(self):
        self.open()
        for width in [1360,390]:
            self.page.set_viewport_size({'width':width,'height':900});self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width+1)
        out=ROOT/'test-results';out.mkdir(exist_ok=True);self.page.screenshot(path=str(out/'action-center-mobile.png'),full_page=True)
    def test_untrusted_customer_text_is_not_html(self):
        self.items[0]['title']='<img src=x onerror="window.injected=true">';self.open();self.assertEqual(self.page.locator('img').count(),0);self.assertIsNone(self.page.evaluate('window.injected'))
    def test_hub_refresh_preserves_open_unsaved_draft(self):
        self.open();self.fill_create();self.page.evaluate('EGCActionCenter.mount(document.querySelector("#host"))');expect(self.page.get_by_label('Action',exact=True)).to_have_value('New synthetic commitment')
    def test_unknown_save_retries_exact_payload_and_request_id(self):
        self.open();self.fill_create();self.fail_once=True;self.page.get_by_role('button',name='Save',exact=True).click();expect(self.page.get_by_role('button',name='Retry original request')).to_be_visible();expect(self.page.get_by_label('Action',exact=True)).to_be_disabled();self.page.get_by_role('button',name='Retry original request').click();expect(self.page.get_by_role('dialog')).to_have_count(0)
        writes=[r for r in self.calls if r['body']['command']=='task.create'];self.assertEqual(len(writes),2);self.assertEqual(writes[0],writes[1])
    def test_stale_edit_keeps_user_draft_and_does_not_overwrite(self):
        self.open();self.detail();self.page.get_by_role('button',name='Edit',exact=True).click();self.page.get_by_label('Action',exact=True).fill('My unsaved change');self.stale=True;self.page.get_by_role('button',name='Save',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('Nothing was overwritten');expect(self.page.get_by_label('Action',exact=True)).to_have_value('My unsaved change');expect(self.page.get_by_label('Type',exact=True)).to_be_disabled()
    def test_approval_requires_exact_visible_payload_and_checkbox(self):
        self.items=[task(kind='followup_message',approvalStatus='pending',draftPayload={'channel':'sms','recipient':'+15555550100','subject':'','body':'Exact synthetic quote text','sendWindowStart':at(),'sendWindowEnd':at(12)})];self.open();self.detail();self.page.get_by_role('button',name='Review approval').click();expect(self.page.get_by_role('dialog')).to_contain_text('+15555550100');expect(self.page.get_by_role('dialog')).to_contain_text('Exact synthetic quote text');self.page.get_by_label('I reviewed the exact recipient, message, and revision').check();self.page.get_by_role('button',name='Approve draft — does not send').click();expect(self.page.get_by_role('dialog')).to_have_count(0);writes=[r['body'] for r in self.calls if r['body']['command']=='tasks.approve'];self.assertEqual(writes[0]['items'],[{'taskId':self.items[0]['id'],'revision':1,'previewHash':'a'*64}]);self.assertFalse(any('send' in r['body']['command'] for r in self.calls))
    def test_dst_invalid_or_ambiguous_times_are_rejected(self):
        self.open();self.assertTrue(self.page.evaluate("(()=>{try{EGCActionCenter.localToIso('2026-11-01T01:30');return false}catch{return true}})()"));self.assertTrue(self.page.evaluate("(()=>{try{EGCActionCenter.localToIso('2026-03-08T02:30');return false}catch{return true}})()"))
    def test_signout_removes_loaded_customer_data(self):
        self.open();self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))");expect(self.page.locator('#host')).to_be_empty()
    def test_no_fake_portal_calendar_on_source_outage(self):
        self.open();self.page.get_by_role('tab',name='Portal schedule',exact=True).click();expect(self.page.locator('[data-ac-content]')).to_contain_text('No other calendar was substituted')
if __name__=='__main__':unittest.main(verbosity=2)
