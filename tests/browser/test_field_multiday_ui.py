"""Phone-sized multi-day visit flows on /crew/job.html against a routed field-jobs API fixture (FIELD_MULTIDAY_VISITS on)."""
import copy, datetime, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
D1, D2, D3 = '2026-09-22', '2026-09-23', '2026-09-24'

def day(date, status='not_started', **changes):
    value = {'date':date, 'scheduled':True, 'status':status, 'startedAt':None, 'endedAt':None, 'endedBy':'', 'notes':''}
    value.update(changes); return value

def visits(**changes):
    value = {'today':D1, 'finalDay':D3, 'multiDay':True, 'assignedToday':True, 'canEndDay':True, 'completionOpen':False, 'earlyCompletionReasonRequired':False,
        'days':[day(D1, 'in_progress', startedAt='2026-09-22T14:00:00.000Z'), day(D2), day(D3)]}
    value.update(changes); return value

def field_job(manager=False, **changes):
    check = {'id':'departure-address','stage':'departure','label':'Confirm the address, crew, truck and arrival time','detail':'','required':True,'completed':True,'completedAt':'2026-09-22T13:30:00.000Z','completedBy':'Crew One'}
    value = {'id':'job-1','expectedRevision':'rev-1','type':'job','customer':'Synthetic Multi-Day Garage','phone':'9705550100','address':'1 Synthetic Way, Fort Collins, CO','date':D1,'time':'08:00','endDate':D3,'endTime':'17:00','startAt':'','endAt':'','arrivalWindow':'',
        'status':'in_progress','fieldStatus':'in_progress','statusReason':'','serviceType':'Garage cleanout','assignedCrew':['Crew.One'],'crewMembers':[{'id':'Crew.One','name':'Crew One'}],'crewLead':'Crew.One','crewId':'','crewName':'','vehicleId':'','vehicleName':'','crewNeeded':1,
        'scope':'Synthetic three-day cleanout.','customerGoal':'','keepItems':'','removeItems':'','exclusions':'','hazards':[],'accessInstructions':'','access':[],'truckPlacement':'','customerInstructions':'','requiredEquipment':[],'materials':[],'checklist':[check],'photos':[],'history':[],'attention':None,'canAddManagementNote':manager,
        'jobTime':{'recorded':True,'estimatedMs':205200000,'asOf':'2026-09-22T22:00:00.000Z','needsReview':False,'partialHistory':False,'runningKind':'work','workMs':28800000,'pausedMs':0,'waitingMs':0,'delayedMs':0,'travelMs':0,'arrivalMs':0,'totalRecordedMs':28800000,'workVarianceMs':None},
        'completion':None,'completionSync':None,'startedAt':'2026-09-22T14:00:00.000Z','completedAt':None,'completionMissing':[],'canEdit':True,'canManageChecklist':manager,'allowedStatuses':['paused','waiting','delayed','in_progress'],'visits':visits()}
    value.update(changes); return value

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class FieldMultiDayBrowserTests(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={'width':375,'height':812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True, service_workers='block')
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        # 16:00 on day one in Denver; the phone itself is set to Tokyo.
        self.page.clock.install(time=datetime.datetime(2026,9,22,22,tzinfo=datetime.timezone.utc))
        self.errors = []; self.posts = []; self.dialogs = []; self.offline = False; self.manager = False; self.job = field_job(); self.job_costs = False; self.cost_posts = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if self.offline and parsed.path.startswith('/api/'): route.abort('internetdisconnected'); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/hub-auth':
            send({'ok':True,'user':'ZacB','displayName':'Owner','role':'owner','businessAccess':True} if self.manager else {'ok':True,'user':'Crew.One','displayName':'Crew One','role':'crew'}); return
        if parsed.path == '/api/employee-hub':
            query = parse_qs(parsed.query)
            if query.get('view') == ['job-labor']: send({'ok':True,'jobId':'job-1','employees':[],'asOf':'2026-09-22T22:00:00.000Z','legacyAssociationOnlyCount':0,'needsReviewCount':0}); return
            send({'ok':True,'user':'ZacB' if self.manager else 'Crew.One','entry':None}); return
        if parsed.path == '/api/field-expenses':
            if req.method == 'POST': self.cost_posts.append(req.post_data_json)
            send({'ok':True,'jobId':'job-1','scope':'own','entries':[],'totals':{'totalCents':0,'byKind':{},'complete':True},'canRecord':False,'notScheduledToday':True,'canManage':False,'receiptsAvailable':True,'limits':{'maxAmountCents':500000,'kinds':['material','dump_fee','other']},'timezone':'America/Denver'}); return
        if parsed.path != '/api/field-jobs': route.continue_(); return
        if req.method == 'GET':
            if parse_qs(parsed.query).get('view') == ['timer']: send({'ok':True,'jobTime':self.job['jobTime'],'expectedRevision':self.job['expectedRevision']}); return
            send({'ok':True,'job':copy.deepcopy(self.job),'historyCursor':None,'photosAvailable':True,'features':{'jobCosts':self.job_costs},'timezone':'America/Denver'}); return
        body = req.post_data_json; self.posts.append(copy.deepcopy(body))
        if body['action'] == 'end_day':
            job = copy.deepcopy(self.job); job['expectedRevision'] = f"rev-{len(self.posts) + 1}"
            job.update(fieldStatus='day_ended', statusReason=body['notes'], allowedStatuses=['waiting','delayed','in_progress'])
            job['jobTime'] = {**job['jobTime'], 'runningKind':None}
            job['visits'] = {**job['visits'], 'canEndDay':False, 'days':[day(D1, 'ended', startedAt='2026-09-22T14:00:00.000Z', endedAt='2026-09-22T22:00:00.000Z', endedBy='Crew One', notes=body['notes'].strip()), day(D2), day(D3)]}
            job['history'] = [{'id':body['requestId'],'action':'end_day','createdAt':'2026-09-22T22:00:00.000Z','actorId':'Crew.One','actorName':'Crew One','body':body['notes'].strip(),'summary':'Day ended','visibility':'crew'}]
            self.job = job
        elif body['action'] == 'complete':
            job = copy.deepcopy(self.job); job.update(status='completed', fieldStatus='completed', canEdit=False, allowedStatuses=[], completedAt='2026-09-22T22:00:00.000Z', expectedRevision='rev-done',
                completion={'completedAt':'2026-09-22T22:00:00.000Z','completedBy':'Owner','notes':body['notes'],'hasIssues':False,'issueNotes':''})
            job['visits'] = {**job['visits'], 'canEndDay':False, 'days':[day(D1, 'completed', endedAt='2026-09-22T22:00:00.000Z', endedBy='Owner', notes=body['notes']), day(D2), day(D3)]}
            self.job = job
        send({'ok':True,'alreadyApplied':False,'job':copy.deepcopy(self.job),'historyCursor':None,'photosAvailable':True,'features':{'jobCosts':False},'timezone':'America/Denver'})
    def open(self):
        self.page.goto(self.url + '/crew/job.html?jobId=job-1')
        expect(self.page.get_by_role('heading', name='Synthetic Multi-Day Garage', exact=True)).to_be_visible()
    def assert_phone_layout(self, scope='#visit-card'):
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', self.page.locator(scope).inner_text()))
        small = self.page.evaluate("""s=>[...document.querySelectorAll(s+' button, '+s+' textarea')].filter(el=>el.offsetParent).filter(el=>el.getBoundingClientRect().height<44).map(el=>el.outerHTML.slice(0,80))""", scope)
        self.assertEqual(small, [])
        fonts = self.page.evaluate("""[...document.querySelectorAll('#field-main input:not([type=checkbox]), #field-main select, #field-main textarea')].map(el=>parseFloat(getComputedStyle(el).fontSize))""")
        self.assertTrue(all(size >= 16 for size in fonts), fonts)
    def screenshot(self, name):
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/name), full_page=True)

    def test_crew_ends_day_one_and_completion_waits_for_the_final_day(self):
        self.open(); card = self.page.locator('#visit-card')
        expect(card.get_by_role('heading', name='Visits')).to_be_visible()
        expect(card.locator('.visit-days li')).to_have_count(3)
        expect(card.locator('.visit-days li.today')).to_contain_text('Tuesday, Sep 22 · Today')
        expect(card.locator('.visit-days li.today')).to_contain_text('In progress')
        expect(card).to_contain_text('Scheduled through Thursday, Sep 24')
        self.assertEqual(self.page.evaluate("document.querySelector('#visit-card').nextElementSibling.id"), 'job-time')
        complete = self.page.locator('#complete-card')
        expect(complete).to_contain_text('Completion opens on the final day')
        expect(complete.get_by_role('button', name='Review & complete job')).to_have_count(0)
        self.assert_phone_layout()
        notes = card.get_by_label('What was done today and what remains')
        expect(notes).to_have_attribute('minlength', '10'); expect(notes).to_have_attribute('maxlength', '4000')
        self.screenshot('field-multiday-day1-mobile.png')
        notes.fill('Too short'); self.page.evaluate("document.querySelector('#end-day-notes').removeAttribute('minlength')")
        card.get_by_role('button', name='End today’s visit').click()
        expect(self.page.locator('#feedback')).to_contain_text('at least 10 characters')
        self.assertEqual(self.posts, [])
        notes.fill('North wall cleared; shelving and floor prep remain for tomorrow.')
        card.get_by_role('button', name='End today’s visit').click()
        expect(card.locator('.visit-days li.today')).to_contain_text('Day ended')
        expect(card.locator('.visit-days li.today')).to_contain_text('North wall cleared; shelving and floor prep remain for tomorrow.')
        expect(card.locator('.visit-days li.today')).to_contain_text('Ended by Crew One')
        expect(card.locator('#end-day-form')).to_have_count(0)
        self.assertEqual(len(self.posts), 1); post = self.posts[0]
        self.assertTrue(UUID.match(post['requestId']))
        self.assertEqual({key: post[key] for key in ['action','jobId','notes','visitDate','expectedRevision','expectedUser']}, {'action':'end_day','jobId':'job-1','notes':'North wall cleared; shelving and floor prep remain for tomorrow.','visitDate':D1,'expectedRevision':'rev-1','expectedUser':'Crew.One'})
        self.assertTrue(any('End today’s visit?' in message for message in self.dialogs))
        expect(self.page.get_by_role('button', name='Start today’s work', exact=True)).to_be_visible()
        expect(self.page.get_by_role('button', name='Pause work', exact=True)).to_have_count(0)
        expect(self.page.locator('#job-time')).to_contain_text('Stopped')
        self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(k=>k.endsWith(':endDay')&&sessionStorage.getItem(k))"), [])
        self.assert_phone_layout(); self.screenshot('field-multiday-day-ended-mobile.png')

    def test_offline_end_of_day_is_saved_on_the_phone_and_syncs_once(self):
        self.open(); card = self.page.locator('#visit-card')
        self.offline = True; self.context.set_offline(True)
        card.get_by_label('What was done today and what remains').fill('Offline close: shelving remains and the dumpster is half full.')
        card.get_by_role('button', name='End today’s visit').click()
        expect(self.page.get_by_role('heading', name='1 action saved on this phone', exact=True)).to_be_visible()
        expect(card.locator('.visit-days li.today')).to_contain_text('Saved on this phone · waiting to sync')
        expect(card.locator('.visit-days li.today')).to_contain_text('Offline close: shelving remains')
        expect(card.locator('#end-day-form')).to_have_count(0)
        expect(self.page.locator('#outbox-card')).to_contain_text('End today’s visit: Offline close')
        self.assertEqual(self.posts, [])
        self.assert_phone_layout(); self.screenshot('field-multiday-offline-mobile.png')
        # The phone reconnects at 07:30 the next morning: the queued action still names day one.
        self.page.clock.set_system_time(datetime.datetime(2026,9,23,13,30,tzinfo=datetime.timezone.utc))
        self.offline = False; self.context.set_offline(False)
        expect(card.locator('.visit-days li.today')).to_contain_text('Ended by Crew One')
        expect(self.page.locator('#outbox-card li')).to_have_count(0)
        self.assertEqual([post['action'] for post in self.posts], ['end_day'])
        self.assertEqual([self.posts[0]['notes'], self.posts[0]['visitDate']], ['Offline close: shelving remains and the dumpster is half full.', D1])

    def test_reopened_and_late_synced_days_keep_every_end_of_day(self):
        self.job = field_job(visits=visits(days=[
            day(D1, 'ended', startedAt='2026-09-22T14:00:00.000Z', endedAt='2026-09-23T13:30:00.000Z', endedBy='Crew One', notes='Day one handoff synced the next morning.', endedLate=True),
            day(D2, 'in_progress', startedAt='2026-09-23T14:00:00.000Z', reopenedAt='2026-09-23T22:30:00.000Z', earlierEnds=[{'endedAt':'2026-09-23T22:00:00.000Z','endedBy':'Crew One','notes':'First close before the customer came back.'}]),
            day(D3)], today=D2))
        self.open(); card = self.page.locator('#visit-card')
        first, today = card.locator('.visit-days li').nth(0), card.locator('.visit-days li.today')
        expect(first).to_contain_text('(saved offline, synced after midnight)')
        expect(today).to_contain_text('In progress'); expect(today).to_contain_text('Reopened Sep 23, 4:30 PM')
        expect(today).to_contain_text('Earlier end of day by Crew One · Sep 23, 4:00 PM'); expect(today).to_contain_text('First close before the customer came back.')
        expect(today.get_by_text('Ended by', exact=False)).to_have_count(0)
        self.assert_phone_layout(); self.screenshot('field-multiday-reopened-mobile.png')

    def test_manager_completes_early_only_with_a_reason(self):
        self.manager = True
        self.job = field_job(True, visits=visits(earlyCompletionReasonRequired=True))
        self.open(); form = self.page.locator('#completion-form')
        reason = form.get_by_label('Reason for completing before Thursday, Sep 24')
        expect(reason).to_be_visible(); expect(reason).to_have_attribute('maxlength', '1000')
        form.get_by_label('Completion notes').fill('All three bays finished a day early with the customer walkthrough.')
        form.get_by_label('Does anything need follow-up?').select_option('no')
        reason.fill('Too short'); self.page.evaluate("document.querySelector('#completion-early-reason').removeAttribute('minlength')")
        form.get_by_role('button', name='Review & complete job').click()
        expect(self.page.locator('#feedback')).to_contain_text('reason for completing before the final scheduled day')
        self.assertEqual(self.posts, [])
        reason.fill('Customer added a second crew so the work finished early.')
        self.assert_phone_layout('#complete-card')
        form.get_by_role('button', name='Review & complete job').click()
        expect(self.page.get_by_text('Completed by Owner.', exact=True)).to_be_visible()
        self.assertEqual(len(self.posts), 1)
        self.assertEqual({key: self.posts[0][key] for key in ['action','notes','hasIssues','earlyCompletionReason']}, {'action':'complete','notes':'All three bays finished a day early with the customer walkthrough.','hasIssues':False,'earlyCompletionReason':'Customer added a second crew so the work finished early.'})
        self.assertTrue(any('before its final scheduled day' in message for message in self.dialogs))

    def test_crew_not_scheduled_today_can_review_but_not_record(self):
        self.job = field_job(visits=visits(assignedToday=False, canEndDay=False, days=[day(D2)]), date=D2, endDate=D2); self.job_costs = True
        self.open(); card = self.page.locator('#visit-card')
        expect(card.get_by_role('status')).to_contain_text('You are not scheduled on this job today')
        expect(card.get_by_role('status')).to_contain_text('status and job costs open on your scheduled days')
        costs = self.page.locator('#field-expenses-card')
        expect(costs).to_contain_text('You are not scheduled on this job today (Mountain Time). Record costs on a day you work this job')
        expect(costs.locator('form')).to_have_count(0); self.assertEqual(self.cost_posts, [])
        expect(card.locator('#end-day-form')).to_have_count(0)
        for locator in [self.page.locator('input[data-check]'), self.page.locator('[data-action="status"]'), self.page.get_by_role('button', name='Save note', exact=True)]:
            for index in range(locator.count()): expect(locator.nth(index)).to_be_disabled()
        self.assertGreater(self.page.locator('[data-action="status"]').count(), 0)
        expect(self.page.locator('#photo-camera')).to_have_count(0)
        expect(self.page.locator('#complete-card')).to_contain_text('You are not scheduled on this job today.')
        self.page.locator('input[data-check]').first.click(force=True)
        self.page.wait_for_timeout(200)
        self.assertEqual(self.posts, [])
        self.assert_phone_layout(); self.screenshot('field-multiday-not-today-mobile.png')

if __name__ == '__main__':
    unittest.main()
