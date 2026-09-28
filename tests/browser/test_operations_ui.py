"""Actual Action Center browser tests with isolated HTTP fixtures; no customer/provider access."""
import json, pathlib, threading, unittest, uuid, datetime, os
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
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**({'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}))
    @classmethod
    def tearDownClass(cls): cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':1360,'height':1000});self.page=self.context.new_page()
        self.items=[task()];self.calls=[];self.enabled=True;self.fail_once=False;self.stale=False;self.errors=[];self.calendar_available=False
        self.sold_revenue={'valueCents':None,'knownSubtotalCents':0,'unknownOccurrenceCount':1,'unknownValueCount':1,'missingValue':['confirmed-undated-sale'],'coverageIncomplete':True,'qualification':'Confirmed outcome has no verified occurrence date.','unknownOccurrenceEvents':[{'eventId':'confirmed-undated-sale','contactId':'synthetic-contact','valueCents':None,'currency':None}]}
        self.collected_revenue={'valueCents':None,'knownSubtotalCents':13900,'unknownOccurrenceCount':0,'unknownValueCount':0,'missingValue':[],'coverageIncomplete':True,'qualification':'Payment history is incomplete; the dated subtotal is not a complete total.','unknownOccurrenceEvents':[]}
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.route('**/*',self.route)
    def tearDown(self):
        self.assertEqual(self.errors,[],f'Browser console errors: {self.errors}')
        self.context.close()
    def route(self,route):
        req=route.request;p=urlparse(req.url)
        if p.hostname!='127.0.0.1': route.abort();return
        if p.path!='/api/operations': route.continue_();return
        def send(body,status=200):
            if body.get('authority')=='canonical_customer_event_ledger':body={**body,'soldRevenue':self.sold_revenue,'collectedRevenue':self.collected_revenue}
            route.fulfill(status=status,content_type='application/json',body=json.dumps(body))
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
        elif name=='calendar':
            if self.calendar_available:send({'items':[{'id':'exact-fixture-visit','customer':'Synthetic visit','kind':'walkthrough','localDate':'2026-09-20','localStart':'09:00','status':'scheduled'}],'total':1,'nextOffset':None})
            else:send({'error':'portal_authority_unavailable'},503)
        elif name=='portal.job':send({'authority':'employee_hub','job':{'id':'exact-fixture-visit','projectId':'project-fixture','operationalScope':{'text':'Protect shelving <img src=x onerror="window.injected=true">','updatedAt':at(),'updatedBy':'test-owner'},'operationNotes':[{'id':'old','body':'Old note'},{'id':'current','body':'Reviewed note','supersedes':'old','createdAt':at(),'actorId':'test-owner'}]}})
        elif name=='intelligence.report':send({'authority':'canonical_customer_event_ledger','generatedAt':at(),'periodActivity':{'walkthroughsVerballyBooked':{'count':2},'videoQuoteOpportunities':{'count':3}},'cohort':{'observedThrough':at(),'metrics':{'walkthroughsVerballyBooked':{'numerator':1,'denominator':8,'rate':0.125}}},'soldRevenue':{'valueCents':0,'missingValue':['verified-sale-unpriced']},'pipelines':{'walkthrough':[{'contactId':'synthetic-contact','customerName':'Synthetic booked customer','state':'WALKTHROUGH_VERBALLY_BOOKED','intentStage':'high_intent','nextRequiredAction':'Save agreed visit in EGC Hub','reconciliationStatus':'verbally_booked_provider_pending','supportingEvidence':[{'sourceType':'call_transcript','sourceRecordId':'synthetic-call','occurredAt':at(),'excerpt':'Tuesday at 2:15 works <img src=x onerror="window.injected=true">'}]}],'videoQuote':[{'contactId':'synthetic-video','customerName':'Synthetic video customer','state':'VIDEO_QUOTE_RECEIVED','intentStage':'high_intent','videoQuoteStage':'media_received','nextRequiredAction':'Prepare quote','reconciliationStatus':'fully_reconciled','supportingEvidence':[]}],'directJob':[]}})
        elif name=='intelligence.diagnostics':send({'verballyBookedProviderMissing':[{'contactId':'synthetic-contact','code':'provider_pending'}],'meta':{'accepted':3,'pending':2,'failed':0}})
        elif name=='intelligence.customer':send({'events':[{'eventType':'walkthrough_verbally_booked','occurredAt':at(),'source':'call_transcript','evidence':[{'sourceType':'call_transcript','sourceRecordId':'synthetic-call','excerpt':'Tuesday at 2:15 works'}]}]})
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
    def test_authoritative_instructions_show_current_notes_and_escape_untrusted_content(self):
        self.calendar_available=True;self.open();self.page.get_by_role('tab',name='Portal schedule',exact=True).click();self.page.get_by_role('button',name='Instructions',exact=True).click();dialog=self.page.get_by_role('dialog');expect(dialog).to_contain_text('Protect shelving <img');expect(dialog).to_contain_text('Reviewed note');expect(dialog).not_to_contain_text('Old note');self.assertEqual(dialog.locator('img').count(),0);self.assertIsNone(self.page.evaluate('window.injected'));reads=[r['body'] for r in self.calls if r['body']['command']=='portal.job'];self.assertEqual(reads,[{'command':'portal.job','jobId':'exact-fixture-visit'}])
    def test_sales_evidence_separates_activity_cohort_and_pipeline_with_safe_transcripts(self):
        self.open();self.page.get_by_role('tab',name='Sales evidence',exact=True).click();view=self.page.locator('[data-ac-content]');expect(view).to_contain_text('Activity in this period');expect(view).to_contain_text('1 / 8');expect(view).to_contain_text('12.5%');expect(view).to_contain_text('Walkthrough pipeline · 1');expect(view).to_contain_text('Video quote pipeline · 1');expect(view).to_contain_text('Tuesday at 2:15 works <img');expect(view).to_contain_text('Amount unverified: 1');self.assertEqual(view.locator('img').count(),0);self.assertIsNone(self.page.evaluate('window.injected'))
        self.page.get_by_role('button',name='Customer evidence',exact=True).first.click();expect(self.page.get_by_role('dialog')).to_contain_text('Tuesday at 2:15 works');self.page.get_by_role('button',name='Close',exact=True).click();self.page.get_by_label('Sales evidence reporting window').select_option('7');expect(view).to_contain_text('Synthetic booked customer');reads=[r['body'] for r in self.calls if r['body']['command']=='intelligence.report'];self.assertEqual(len(reads),2);self.assertNotEqual(reads[0]['since'],reads[1]['since']);self.assertEqual(reads[1]['cohortSince'],reads[1]['since'])
        self.page.set_viewport_size({'width':390,'height':900});self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),391);out=ROOT/'test-results';out.mkdir(exist_ok=True);self.page.screenshot(path=str(out/'sales-evidence-mobile.png'),full_page=True)
    def test_partial_revenue_keeps_known_subtotal_and_undated_outcomes_out_of_total(self):
        self.open();self.page.get_by_role('tab',name='Sales evidence',exact=True).click()
        sold=self.page.locator('[data-revenue-kind="Sold revenue"]');collected=self.page.locator('[data-revenue-kind="Collected revenue"]')
        expect(sold.locator('strong')).to_have_text('Total unavailable');expect(sold).to_contain_text('Verified dated subtotal: $0.00');expect(sold).to_contain_text('Date unknown: 1 · Amount unverified: 1');expect(sold).to_contain_text('Confirmed outcome has no verified occurrence date.')
        expect(collected.locator('strong')).to_have_text('Total unavailable');expect(collected).to_contain_text('Verified dated subtotal: $139.00');expect(collected).to_contain_text('Payment history is incomplete')
        sold.get_by_text('Review outcomes without dates',exact=True).click();expect(sold).to_contain_text('Not assigned to this period');sold.get_by_role('button',name='Customer evidence',exact=True).click();expect(self.page.get_by_role('dialog')).to_contain_text('Tuesday at 2:15 works')
    def test_verified_zero_is_distinct_from_unknown_total_and_qualifications_are_escaped(self):
        self.sold_revenue={'valueCents':0,'knownSubtotalCents':0,'unknownOccurrenceCount':0,'unknownValueCount':0,'coverageIncomplete':False,'qualification':'Verified dated outcomes in this period.','unknownOccurrenceEvents':[]}
        self.collected_revenue['qualification']='<img src=x onerror="window.injected=true">'
        self.open();self.page.get_by_role('tab',name='Sales evidence',exact=True).click();sold=self.page.locator('[data-revenue-kind="Sold revenue"]');expect(sold.locator('strong')).to_have_text('$0.00');expect(sold).not_to_contain_text('Total unavailable');self.assertEqual(self.page.locator('img').count(),0);self.assertIsNone(self.page.evaluate('window.injected'))
    # Message kinds v2: every attachment link is visible and verifiable before approval, and
    # Edit keeps the exact draft. Fixed clock and a non-Denver browser zone prove Denver times.
    FIXED=datetime.datetime(2026,10,1,15,0,tzinfo=datetime.timezone.utc)
    def fixed(self,hours=0): return (self.FIXED+datetime.timedelta(hours=hours)).isoformat().replace('+00:00','Z')
    def fixed_context(self,width=1360):
        self.context.close();self.context=self.browser.new_context(viewport={'width':width,'height':900},timezone_id='Asia/Tokyo',is_mobile=width<500,has_touch=width<500);self.page=self.context.new_page()
        self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',self.route);self.page.clock.install(time=self.FIXED)
    def message_task(self,kind='send_quote',links=None,**extra):
        draft={'channel':'email','recipient':'synthetic@example.invalid','subject':'Your synthetic quote','body':'Exact synthetic quote text','sendWindowStart':self.fixed(0),'sendWindowEnd':self.fixed(12)}
        if links is not None:draft['attachments']=links
        return task(kind=kind,title='Synthetic '+kind,approvalStatus='pending',dueAt=self.fixed(1),draftPayload=draft,**extra)
    LINKS=[{'kind':'portal_quote','url':'https://easygaragecleaning.com/portal/quote/synthetic-1?view=full','label':'Your quote <img src=x onerror="window.injected=true">','refId':'quote:synthetic-1'},{'kind':'payment_link','url':'https://pay.example.com/'+'synthetic-long-segment-'*12+'end','label':'Pay the deposit','refId':None}]
    def open_task(self,title):self.page.locator('.ac-row').filter(has_text=title).first.click();expect(self.page.get_by_role('dialog')).to_contain_text('Completion condition')
    def test_every_attachment_link_is_shown_and_fingerprinted_before_approval(self):
        self.fixed_context(375);self.items=[self.message_task(links=self.LINKS)];self.open();self.open_task('Synthetic send_quote');dialog=self.page.get_by_role('dialog')
        for text in ['Attachment links · 2','Portal quote · Your quote <img','Payment link · Pay the deposit','Opens easygaragecleaning.com','Opens pay.example.com',self.LINKS[0]['url'],self.LINKS[1]['url'],'Reference: quote:synthetic-1']:expect(dialog).to_contain_text(text)
        expect(dialog.get_by_role('button',name='Complete',exact=True)).to_have_count(0);expect(dialog.get_by_role('button',name='Edit',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='Review approval').click();dialog=self.page.get_by_role('dialog')
        for text in ['Subject: Your synthetic quote','Exact synthetic quote text',self.LINKS[0]['url'],self.LINKS[1]['url'],'Review fingerprint '+'a'*16,'2 attachment links and revision 1']:expect(dialog).to_contain_text(text)
        links=dialog.get_by_role('link',name='Open link to verify');expect(links).to_have_count(2)
        for i,link in enumerate(self.LINKS):
            anchor=links.nth(i);self.assertEqual(anchor.get_attribute('href'),link['url']);self.assertEqual(anchor.get_attribute('target'),'_blank');self.assertEqual(set(anchor.get_attribute('rel').split()),{'noopener','noreferrer'})
        self.assertEqual(self.page.locator('img').count(),0);self.assertIsNone(self.page.evaluate('window.injected'))
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375);out=ROOT/'test-results';out.mkdir(exist_ok=True);self.page.screenshot(path=str(out/'action-center-attachments-mobile.png'),full_page=True)
        expect(self.page.get_by_label('I reviewed the exact recipient, message, and revision',exact=True)).to_have_count(0)
        approve=self.page.get_by_role('button',name='Approve draft — does not send');approve.click();expect(dialog).to_be_visible();self.assertEqual([r for r in self.calls if r['body']['command']=='tasks.approve'],[])
        self.page.get_by_label('I reviewed the exact recipient, message, every attachment link, and revision').check();approve.click();expect(self.page.get_by_role('dialog')).to_have_count(0)
        writes=[r['body'] for r in self.calls if r['body']['command']=='tasks.approve'];self.assertEqual(len(writes),1);self.assertEqual(writes[0]['items'],[{'taskId':self.items[0]['id'],'revision':1,'previewHash':'a'*64}]);self.assertRegex(writes[0]['expiresAt'],r'^2026-10-02T14:00:[0-5]\d\.\d{3}Z$')
        self.assertFalse(any('send' in r['body']['command'] for r in self.calls))
    def test_a_draft_with_links_the_hub_cannot_show_is_not_approvable(self):
        self.fixed_context();bad=[{**self.LINKS[0],'url':'http://easygaragecleaning.com/portal/quote/synthetic-1'},{**self.LINKS[1],'signedUrl':'https://pay.example.com/secret'}];self.items=[self.message_task(kind='deposit_reminder',links=bad)];self.open();self.open_task('Synthetic deposit_reminder');dialog=self.page.get_by_role('dialog')
        alert=dialog.get_by_role('alert').filter(has_text='cannot be approved');expect(alert).to_contain_text('Attachment 1 does not have a canonical https link.');expect(alert).to_contain_text('Attachment 2 has a field this screen cannot show: signedUrl.')
        expect(dialog).to_contain_text('This link cannot be verified here.');expect(dialog.get_by_role('link',name='Open link to verify')).to_have_count(1)
        expect(dialog.get_by_role('button',name='Review approval')).to_have_count(0);expect(dialog.get_by_role('button',name='Reject',exact=True)).to_be_visible();expect(dialog.get_by_role('button',name='Complete',exact=True)).to_have_count(0)
        self.assertEqual([r for r in self.calls if r['body']['command']=='tasks.approve'],[])
    def test_edit_sends_the_exact_draft_for_every_message_kind_and_keeps_links(self):
        self.fixed_context();self.items=[self.message_task(links=self.LINKS),self.message_task(kind='answer_question',links=None),self.message_task(kind='send_before_afters',links=[])];self.open()
        expected={'channel':'email','recipient':'synthetic@example.invalid','subject':'Your synthetic quote','body':'Exact synthetic quote text','sendWindowStart':'2026-10-01T15:00:00.000Z','sendWindowEnd':'2026-10-02T03:00:00.000Z'}
        for item,links in [(self.items[0],self.LINKS),(self.items[1],[]),(self.items[2],[])]:
            title=item['title'];self.open_task(title);expect(self.page.get_by_role('dialog').get_by_role('button',name='Complete',exact=True)).to_have_count(0);self.page.get_by_role('button',name='Edit',exact=True).click()
            form=self.page.get_by_role('dialog');expect(form.get_by_label('Exact recipient',exact=True)).to_be_visible();expect(form.get_by_label('Exact recipient',exact=True)).to_have_value('synthetic@example.invalid')
            if links:expect(form).to_contain_text(links[0]['url']);expect(form).to_contain_text('Links stay exactly as proposed')
            form.get_by_label('Action',exact=True).fill('Edited '+title);form.get_by_role('button',name='Save',exact=True).click();expect(self.page.get_by_role('dialog')).to_have_count(0)
            edit=[r['body'] for r in self.calls if r['body']['command']=='task.edit'][-1];self.assertEqual(edit['taskId'],item['id']);self.assertEqual(edit['changes']['title'],'Edited '+title);self.assertEqual(edit['changes']['draft'],{**expected,'attachments':links})
        self.assertEqual(len([r for r in self.calls if r['body']['command']=='task.edit']),3)
if __name__=='__main__':unittest.main(verbosity=2)
