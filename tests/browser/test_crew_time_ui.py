"""CREW-TIME on /crew/job.html at phone sizes (360x740 and 390x844) against routed field-jobs and employee-hub fixtures.
Clock-in is the only time the page reads the phone's position: one read, one retry at lower accuracy on a timeout or no
position, a denied permission never retried, and a clock-in without a position only when EGC_CLOCK_IN_WITHOUT_FIX is on
(flagged for a manager). With EGC_JOB_STATUS_MOVES_TIME on, the job status moves the crew member's own time (en route is
travel, arrived and working are work, completing asks before ending it) and the lead is offered to move crew-mates. Only
someone on the job's crew has their own time moved, and a status's move the server refuses as not theirs is dropped with a
notice instead of blocking their clock."""
import copy, datetime, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DAY = '2026-09-22'
CUSTOMER = 'Synthetic Crew-Time Garage'
SIZES = [(360, 740), (390, 844)]
FIRST = {'enableHighAccuracy': True, 'maximumAge': 60000, 'timeout': 15000}
RETRY = {'enableHighAccuracy': False, 'maximumAge': 300000, 'timeout': 10000}
# navigator.geolocation for the page: each read takes the next planned outcome (success, denied, unavailable, timeout, or
# hold, answered by window.__geo.held[0]()). Reads keep their options; a watch would be counted.
GEO = """(()=>{const plan=window.__geoPlan||['success'];const state=window.__geo={reads:[],watches:0,held:[]};
const fix=()=>({coords:{latitude:40.585123,longitude:-105.084987,accuracy:7},timestamp:Date.now()});
const codes={denied:1,unavailable:2,timeout:3};
const geo={getCurrentPosition(success,failure,options){const outcome=plan[Math.min(state.reads.length,plan.length-1)];state.reads.push(options||null);
  if(outcome==='hold'){state.held.push(()=>success(fix()));return;}
  Promise.resolve().then(()=>outcome in codes?failure({code:codes[outcome],message:'Synthetic '+outcome}):success(fix()));},
  watchPosition(){state.watches++;return 1;},clearWatch(){}};
Object.defineProperty(Navigator.prototype,'geolocation',{configurable:true,get:()=>geo});})();"""
NEXT = {'scheduled': ['dispatched', 'arrived', 'delayed'], 'dispatched': ['arrived', 'delayed'], 'arrived': ['in_progress', 'waiting', 'delayed'], 'in_progress': ['paused', 'waiting', 'delayed']}

def field_job(**changes):
    value = {'id':'job-1','expectedRevision':'rev-1','type':'job','customer':CUSTOMER,'phone':'9705550100','address':'1 Synthetic Way, Fort Collins, CO','date':DAY,'time':'08:00','endDate':DAY,'endTime':'11:00','startAt':'','endAt':'','arrivalWindow':'',
        'status':'scheduled','fieldStatus':'scheduled','statusReason':'','serviceType':'Garage cleanout','assignedCrew':['Crew.One','Crew.Two','Crew.Three'],
        'crewMembers':[{'id':'Crew.One','name':'Crew One'},{'id':'Crew.Two','name':'Crew Two'},{'id':'Crew.Three','name':'Crew Three'}],'crewLead':'Crew.One','crewId':'','crewName':'','vehicleId':'','vehicleName':'','crewNeeded':3,
        'scope':'Clear the garage.','customerGoal':'','keepItems':'','removeItems':'','exclusions':'','hazards':[],'accessInstructions':'','access':[],'truckPlacement':'','customerInstructions':'','requiredEquipment':[],'materials':[],'checklist':[],'photos':[],'history':[],'attention':None,'canAddManagementNote':False,
        'jobTime':{'recorded':False,'estimatedMs':10800000,'asOf':DAY + 'T15:00:00.000Z','needsReview':False,'partialHistory':False,'runningKind':None,'message':'Job time will be recorded from the next field status action.'},
        'completion':None,'completionSync':None,'startedAt':None,'completedAt':None,'completionMissing':[],'canEdit':True,'canManageChecklist':False,'allowedStatuses':NEXT['scheduled'],'capabilities':{'lead':True,'assigned':True,'complete':True}}
    value.update(changes); return value

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address): pass  # a closed test page may drop a static request mid-response

class CrewTimeBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(('127.0.0.1',0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context = None
    def tearDown(self):
        if self.context: self.context.close()

    def start(self, size=SIZES[0], plan=('success',), moves=True, without_fix=False, job=None):
        if self.context: self.context.close()
        width, height = size
        self.context = self.browser.new_context(viewport={'width':width,'height':height}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True, service_workers='block')
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        # 09:00 in Denver; the phone itself is set to Tokyo.
        self.page.clock.install(time=datetime.datetime(2026,9,22,15,tzinfo=datetime.timezone.utc))
        self.errors = []; self.field_posts = []; self.hub_posts = []; self.dialogs = []
        self.job = job or field_job(); self.shift = None; self.shift_reads = 0; self.crew_refusal = None; self.time_refusal = None; self.features = {'jobCosts':False, **({'statusMovesTime':True} if moves else {}), **({'clockInWithoutFix':True} if without_fix else {})}
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.add_init_script('window.__geoPlan=' + json.dumps(list(plan)) + ';'); self.page.add_init_script(GEO)
        self.page.route('**/*', self.route)
        self.page.goto(self.url + '/crew/job.html?jobId=job-1')
        expect(self.page.get_by_role('heading', name=CUSTOMER, exact=True)).to_be_visible()
        expect(self.time_card()).to_contain_text('Clocking in shares your location once. Nothing tracks your location during your shift.')
        return self.page

    # ── Fixtures ──
    def shift_view(self):
        # What /api/employee-hub?view=own-job-time returns (ownJobTimeProjection), from the fixture's segments.
        if not self.shift: return None
        segments = self.shift['segments']; current = next((segment for segment in segments if not segment.get('endedAt')), None)
        return {'id':self.shift['id'],'employee':'Crew.One','clockInAt':self.shift['clockInAt'],'onBreak':False,'breaks':[],'deviceTime':False,'clockInLocation':self.shift['clockInLocation'],
            'currentSegmentId':current['id'] if current else '','current':{key: current[key] for key in ['id','kind','jobId','jobLabel','startedAt']} if current else None,
            'summary':{'recorded':True,'partialHistory':False,'needsReview':False,'jobs':[],'generalMs':0,'untrackedMs':0}}
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/hub-auth': send({'ok':True,'user':'Crew.One','displayName':'Crew One','role':'crew'}); return
        if parsed.path == '/api/employee-hub':
            if req.method == 'GET': self.shift_reads += 1; send({'ok':True,'user':'Crew.One','entry':self.shift_view(),'clockInWithoutFix':self.features.get('clockInWithoutFix', False)}); return
            body = req.post_data_json; self.hub_posts.append(copy.deepcopy(body)); data = body['data']
            if 'crewJobAction' in data and self.crew_refusal: send(self.crew_refusal, 409); return
            if 'jobAction' in data and self.time_refusal: send(self.time_refusal, 403); return
            if 'crewJobAction' in data:
                send({'ok':True,'jobId':'job-1','moved':[{'employee':'crew.two','name':'Crew Two','alreadyApplied':False}],'skipped':[{'employee':'crew.three','name':'Crew Three','reason':'on_another_job'},{'employee':'crew.four','name':'Crew Four','reason':'stale_shift'},{'employee':'crew.five','name':'Crew Five','reason':'on_pto'}]}); return
            if not self.shift and data.get('locationTracking') is True:
                at = data.get('deviceCapturedAt') or '2026-09-22T15:00:00.000Z'
                self.shift = {'id':body['id'],'clockInAt':at,'clockInLocation':'shared' if data.get('lastLocation') else 'missing','segments':[{'id':'clock-in:' + body['id'],'kind':'general','jobId':'','jobLabel':'','startedAt':at}]}
            elif 'jobAction' in data:
                action = data['jobAction']; current = next(segment for segment in self.shift['segments'] if not segment.get('endedAt'))
                self.assertEqual(action['expectedSegmentId'], current['id'], 'each move names the segment it ends')
                at = action.get('deviceCapturedAt') or '2026-09-22T15:00:00.000Z'; current['endedAt'] = at
                self.shift['segments'].append({'id':action['requestId'],'kind':action['kind'],'jobId':action['jobId'],'jobLabel':CUSTOMER if action['jobId'] else '','startedAt':at})
            elif data.get('clockOutAt'): self.shift = None
            send({'ok':True,'record':{'id':body['id']}}); return
        if parsed.path == '/api/field-expenses': send({'ok':False,'code':'FIELD_EXPENSES_DISABLED','error':'Job-cost capture is not enabled.'}, 404); return
        if parsed.path != '/api/field-jobs': route.continue_(); return
        if req.method == 'GET':
            if parse_qs(parsed.query).get('view') == ['timer']: send({'ok':True,'jobTime':self.job['jobTime'],'expectedRevision':self.job['expectedRevision']}); return
            send({'ok':True,'job':copy.deepcopy(self.job),'historyCursor':None,'photosAvailable':True,'features':self.features,'timezone':'America/Denver'}); return
        body = req.post_data_json; self.field_posts.append(copy.deepcopy(body)); job = copy.deepcopy(self.job)
        job['expectedRevision'] = f"rev-{len(self.field_posts) + 1}"
        if body['action'] == 'status': job.update(status='in_progress' if body['status'] == 'in_progress' else job['status'], fieldStatus=body['status'], allowedStatuses=NEXT.get(body['status'], []))
        elif body['action'] == 'complete': job.update(status='completed', fieldStatus='completed', canEdit=False, allowedStatuses=[], completedAt=DAY + 'T18:00:00.000Z', completion={'completedAt':DAY + 'T18:00:00.000Z','completedBy':'Crew One','notes':body['notes'],'hasIssues':False,'issueNotes':''})
        self.job = job
        send({'ok':True,'alreadyApplied':False,'job':copy.deepcopy(job),'historyCursor':None,'photosAvailable':True,'features':self.features,'timezone':'America/Denver'})

    # ── Helpers ──
    def time_card(self): return self.page.locator('#employee-job-time')
    def geo(self): return self.page.evaluate('window.__geo')
    def clock_in_posts(self): return [body for body in self.hub_posts if body['data'].get('locationTracking') is True]
    def later_location(self):
        # Anything sent after the clock-in that carries a position, a trail or a location status.
        return [body for body in self.hub_posts if body['data'].get('locationTracking') is not True and any(key in body['data'] for key in ['lastLocation','locationTrail','locationStatus'])]
    def feedback(self): return self.page.locator('#feedback')
    def until(self, check, message):
        # The page shows a queued action at once; the fixture sees it once the outbox has sent it.
        for _ in range(100):
            if check(): return
            self.page.wait_for_timeout(100)
        self.fail(message)
    def moves(self): return [body['data']['jobAction'] for body in self.hub_posts if 'jobAction' in body['data']]
    def status_button(self, name): return self.page.get_by_role('button', name=name, exact=True)
    def assert_phone_layout(self, width):
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'), 'no sideways scroll')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
        small = self.page.evaluate("""[...document.querySelectorAll('#employee-job-time button, #employee-job-time .button, #field-main [data-action="status"]')].filter(el=>el.offsetParent).filter(el=>el.getBoundingClientRect().height<44).map(el=>el.outerHTML.slice(0,80))""")
        self.assertEqual(small, [], 'every tap target is at least 44px tall')
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', self.time_card().inner_text()))
    def screenshot(self, name):
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/name), full_page=True)
    def clock_in(self):
        self.time_card().get_by_role('button', name='Clock in', exact=True).click()

    # ── Tests ──
    def test_status_moves_time_travel_then_work_crew_mates_then_general_with_one_position_at_clock_in(self):
        for width, height in SIZES:
            with self.subTest(size=f'{width}x{height}'):
                page = self.start((width, height))
                status_time = page.locator('#status-time')
                expect(status_time).to_have_text('Your time: not clocked in')
                self.assert_phone_layout(width)
                self.clock_in()
                expect(self.feedback()).to_contain_text('Clocked in. Your location was shared once; nothing tracks it during your shift.')
                expect(self.time_card()).to_contain_text('Location shared once at clock-in.')
                sent = self.clock_in_posts()
                self.assertEqual(len(sent), 1)
                self.assertEqual({key: sent[0]['data'].get(key) for key in ['locationTracking','locationStatus','lastLocation']}, {'locationTracking':True,'locationStatus':'job_page_single_fix','lastLocation':{'lat':40.585123,'lng':-105.084987,'accuracy':7}})
                self.assertEqual(self.geo(), {'reads':[FIRST],'watches':0,'held':[]})
                expect(status_time).to_have_text('Your time: general shift time')
                self.assert_phone_layout(width); self.screenshot(f'crew-time-clocked-in-{width}.png')

                # En route: the status is saved, then the crew member's time moves to travel for this job.
                self.status_button('Mark en route').click()
                expect(status_time).to_have_text(f'Your time: travelling to {CUSTOMER}')
                self.until(lambda: self.moves(), 'the travel move was sent')
                moves = self.moves()
                self.assertEqual([(move['kind'], move['jobId']) for move in moves], [('travel','job-1')])
                self.assertEqual(self.field_posts[-1]['status'], 'dispatched')
                self.assertTrue(UUID.match(moves[0]['requestId']))

                # Arrived: work on this job, and the lead is asked once about crew-mates.
                self.status_button('Mark arrived').click()
                expect(status_time).to_have_text(f'Your time: working on {CUSTOMER}')
                expect(self.feedback()).to_contain_text('Moved to work here: Crew Two. Not moved: Crew Three (on another job), Crew Four (still clocked in from an earlier day), Crew Five (on time off today).', timeout=10000)
                self.assertTrue(any(message.startswith('Move my crew-mates to work too?') for message in self.dialogs), self.dialogs)
                crew = [body for body in self.hub_posts if 'crewJobAction' in body['data']]
                self.assertEqual(len(crew), 1)
                self.assertEqual({key: crew[0]['data']['crewJobAction'][key] for key in ['jobId','kind']}, {'jobId':'job-1','kind':'work'})
                self.assertEqual((crew[0]['id'], crew[0]['expectedUser']), ('job-1', 'Crew.One'))
                self.assertEqual([body['data']['jobAction']['kind'] for body in self.hub_posts if 'jobAction' in body['data']], ['travel','work'])
                self.assert_phone_layout(width); self.screenshot(f'crew-time-working-{width}.png')

                # Start work: already working here, so nothing moves and the lead is not asked again.
                asked = len(self.dialogs)
                self.status_button('Start work').click()
                expect(self.page.get_by_role('button', name='Pause work', exact=True)).to_be_visible()
                self.assertEqual(len(self.dialogs), asked, 'the crew-mate prompt is offered once per job')
                self.assertEqual(len([body for body in self.hub_posts if 'jobAction' in body['data'] or 'crewJobAction' in body['data']]), 3)

                # Complete: asked before ending the job time; OK (the default) moves to general shift time.
                page.locator('#completion-notes').fill('Garage cleared, floor swept, customer walked through the result.')
                page.locator('#completion-issues').select_option('no')
                page.get_by_role('button', name='Review & complete job').click()
                expect(self.time_card()).to_contain_text('General shift time')
                self.until(lambda: self.moves()[-1]['kind'] == 'general', 'the general move was sent after the completion')
                self.assertTrue(any(message.startswith('End my job time?') for message in self.dialogs), self.dialogs)
                self.assertEqual([body['data']['jobAction'] for body in self.hub_posts if 'jobAction' in body['data']][-1]['kind'], 'general')
                self.assertEqual(self.field_posts[-1]['action'], 'complete')
                complete_at = next(index for index, message in enumerate(self.dialogs) if message.startswith('Complete this job?'))
                end_at = next(index for index, message in enumerate(self.dialogs) if message.startswith('End my job time?'))
                self.assertLess(complete_at, end_at)

                # Clock out: still one position read in all, no watch, nothing located after the clock-in.
                self.time_card().get_by_role('button', name='Clock out', exact=True).click()
                expect(self.time_card().get_by_role('button', name='Clock in', exact=True)).to_be_visible()
                self.assertEqual(self.geo(), {'reads':[FIRST],'watches':0,'held':[]}, 'no position read after clock-in')
                self.assertEqual(self.later_location(), [], 'no location left the page after clock-in')
                self.assertEqual(self.errors, [])

    def test_weak_gps_says_getting_your_location_and_retries_once_at_lower_accuracy(self):
        for width, height in SIZES:
            with self.subTest(size=f'{width}x{height}'):
                self.start((width, height), plan=('hold',))
                self.clock_in()
                button = self.time_card().get_by_role('button', name='Getting your location…')
                expect(button).to_be_visible(); expect(button).to_be_disabled()
                self.assert_phone_layout(width); self.screenshot(f'crew-time-locating-{width}.png')
                self.page.evaluate('window.__geo.held[0]()')
                expect(self.time_card()).to_contain_text('Location shared once at clock-in.')
                self.until(lambda: self.clock_in_posts(), 'the clock-in was sent')
                self.assertEqual(len(self.clock_in_posts()), 1)
                for first in ('timeout', 'unavailable'):
                    self.start((width, height), plan=(first, 'success'))
                    self.clock_in()
                    expect(self.time_card()).to_contain_text('Location shared once at clock-in.')
                    self.until(lambda: self.clock_in_posts(), 'the clock-in was sent')
                    self.assertEqual(self.geo()['reads'], [FIRST, RETRY], f'{first}: one retry at lower accuracy, taking a fix up to 5 minutes old')
                    self.assertEqual(self.clock_in_posts()[0]['data']['locationStatus'], 'job_page_single_fix')
                    self.assertEqual(self.errors, [])

    def test_denied_location_or_no_position_starts_no_shift_unless_the_owner_allows_it_and_then_it_is_flagged(self):
        for width, height in SIZES:
            with self.subTest(size=f'{width}x{height}'):
                self.start((width, height), plan=('denied', 'success'), without_fix=True)
                self.clock_in()
                expect(self.feedback()).to_contain_text('Clock-in needs location access. Enable location for this site, then try again.')
                self.assertEqual(self.geo()['reads'], [FIRST], 'a denied permission is never retried')
                self.assertEqual(self.clock_in_posts(), [])
                expect(self.time_card().get_by_role('button', name='Clock in', exact=True)).to_be_enabled()

                self.start((width, height), plan=('unavailable', 'timeout'))
                self.clock_in()
                expect(self.feedback()).to_contain_text('Your phone could not find its location. Move near a window or outside, then try again.')
                self.assertEqual(self.geo()['reads'], [FIRST, RETRY])
                self.assertEqual(self.clock_in_posts(), [], 'EGC_CLOCK_IN_WITHOUT_FIX unset: no shift starts')
                expect(self.time_card().get_by_role('button', name='Clock in', exact=True)).to_be_enabled()
                self.assert_phone_layout(width)

                self.start((width, height), plan=('timeout', 'unavailable'), without_fix=True)
                self.clock_in()
                expect(self.feedback()).to_contain_text('Clocked in without a location. A manager will review this shift.')
                expect(self.time_card()).to_contain_text('No location at clock-in. A manager reviews this shift.')
                sent = self.clock_in_posts()[0]['data']
                self.assertEqual(sent['locationStatus'], 'location_unavailable_at_clock_in'); self.assertNotIn('lastLocation', sent)
                self.assert_phone_layout(width); self.screenshot(f'crew-time-no-location-{width}.png')
                self.time_card().get_by_role('button', name='Start break', exact=True).click()
                expect(self.time_card().get_by_role('button', name='End break', exact=True)).to_be_visible()
                self.assertEqual(len(self.geo()['reads']), 2, 'nothing read after clock-in')
                self.assertEqual(self.geo()['watches'], 0)
                self.assertEqual(self.errors, [])

    def test_a_refused_crew_move_is_reviewed_on_its_own_and_never_holds_the_leads_own_clock(self):
        width, height = SIZES[0]
        self.start((width, height))
        self.crew_refusal = {'ok':False,'code':'EMPLOYEE_TIMECARD_DEVICE_TIME','error':'This crew move waited on the phone too long to apply now. Ask your crew-mates to start their own work time, or a manager to correct it.'}
        self.clock_in()
        expect(self.time_card()).to_contain_text('Location shared once at clock-in.')
        self.status_button('Mark en route').click()
        self.until(lambda: self.moves(), 'the travel move was sent')
        self.status_button('Mark arrived').click()
        card = self.time_card()
        expect(card).to_contain_text('Crew-mates not moved')
        expect(card).to_contain_text('This crew move waited on the phone too long to apply now.')
        expect(card).not_to_contain_text('Time action needs review')
        self.assertEqual([move['kind'] for move in self.moves()], ['travel','work'], 'the lead’s own work move still went')
        for name in ('Start break', 'Clock out', 'End my job time'): expect(card.get_by_role('button', name=name, exact=True)).to_be_enabled()
        outbox = self.page.locator('#outbox-card')
        expect(outbox).to_contain_text('Move my crew-mates to work here')
        expect(outbox).to_contain_text('your own time and job actions do not wait behind it')
        self.assert_phone_layout(width); self.screenshot(f'crew-time-crew-move-refused-{width}.png')
        card.get_by_role('button', name='Start break', exact=True).click()
        self.until(lambda: any('breaks' in body['data'] for body in self.hub_posts), 'the lead’s break was sent past the refused crew move')
        outbox.get_by_role('button', name='Discard this action').click()
        expect(card).not_to_contain_text('Crew-mates not moved')
        expect(outbox).not_to_contain_text('Move my crew-mates to work here')
        self.assertEqual(len([body for body in self.hub_posts if 'crewJobAction' in body['data']]), 1, 'a refused crew move is never sent again on its own')
        self.assertEqual(self.errors, [])

    def test_a_status_reads_the_shift_first_so_a_leads_crew_move_stands(self):
        # A crew-mate (not the lead) on a job the lead has marked arrived.
        self.start(SIZES[1], job=field_job(status='arrived', fieldStatus='arrived', allowedStatuses=NEXT['arrived'], capabilities={'lead':False,'complete':True}))
        self.clock_in()
        status_time = self.page.locator('#status-time')
        expect(self.feedback()).to_contain_text('Clocked in.')
        expect(status_time).to_have_text('Your time: general shift time')
        # The lead moves this crew member to work here; this phone has not read the shift since.
        at = '2026-09-22T15:01:00.000Z'; self.shift['segments'][-1]['endedAt'] = at
        self.shift['segments'].append({'id':'crew:synthetic-lead-move','kind':'work','jobId':'job-1','jobLabel':CUSTOMER,'startedAt':at})
        reads = self.shift_reads
        self.status_button('Start work').click()
        expect(status_time).to_have_text(f'Your time: working on {CUSTOMER}')
        self.until(lambda: self.field_posts and self.field_posts[-1].get('status') == 'in_progress', 'the status was sent')
        self.assertGreater(self.shift_reads, reads, 'the shift was read before the status worked out its time')
        self.page.wait_for_timeout(300)
        self.assertEqual(self.moves(), [], 'no move from the older view; the lead’s move stands')
        self.assertEqual([segment['id'] for segment in self.shift['segments']][-1], 'crew:synthetic-lead-move')
        expect(self.time_card()).not_to_contain_text('Time action needs review')
        self.assertFalse(any('crew-mates' in message for message in self.dialogs), 'only the lead is asked about crew-mates')
        self.assert_phone_layout(SIZES[1][0])
        self.assertEqual(self.errors, [])

    def test_a_viewer_not_on_the_jobs_crew_sets_its_status_without_moving_their_own_time(self):
        # A manager (or anyone the server does not count as assigned) can set a job's status; their own time stays put.
        self.start(SIZES[0], job=field_job(capabilities={'lead':False,'assigned':False,'complete':True}))
        self.clock_in()
        expect(self.feedback()).to_contain_text('Clocked in.')
        expect(self.page.locator('#status-time')).to_have_count(0)
        self.status_button('Mark en route').click()
        expect(self.status_button('Mark arrived')).to_be_visible()
        self.status_button('Mark arrived').click()
        expect(self.status_button('Start work')).to_be_visible()
        self.until(lambda: len(self.field_posts) == 2, 'both statuses were sent')
        self.page.wait_for_timeout(300)
        self.assertEqual([body for body in self.hub_posts if 'jobAction' in body['data'] or 'crewJobAction' in body['data']], [], 'no own time move and no crew move')
        self.assertFalse(any('crew-mates' in message for message in self.dialogs))
        card = self.time_card()
        expect(card).not_to_contain_text('Time action needs review')
        for name in ('Start break', 'Clock out'): expect(card.get_by_role('button', name=name, exact=True)).to_be_enabled()
        self.assert_phone_layout(SIZES[0][0])
        self.assertEqual(self.errors, [])

    def test_a_status_move_the_server_refuses_as_not_allowed_is_dropped_with_a_notice_and_never_blocks_the_clock(self):
        width, height = SIZES[1]
        self.start((width, height), job=field_job(capabilities={'lead':False,'assigned':True,'complete':True}))
        self.time_refusal = {'ok':False,'code':'EMPLOYEE_TIMECARD_INVALID','error':'New job time is limited to your currently assigned active jobs.'}
        self.clock_in()
        expect(self.feedback()).to_contain_text('Clocked in.')
        self.status_button('Mark en route').click()
        card = self.time_card()
        expect(card).to_contain_text('Your time was not moved')
        expect(card).to_contain_text('New job time is limited to your currently assigned active jobs. Your time stays where it was.')
        expect(self.feedback()).to_contain_text('Your time was not moved')
        expect(card).not_to_contain_text('Time action needs review')
        expect(self.page.locator('#outbox-card')).not_to_contain_text('Start my travel time')
        self.assertEqual(self.field_posts[-1]['status'], 'dispatched', 'the status itself was saved')
        expect(self.page.locator('#status-time')).to_have_text('Your time: general shift time')
        self.assert_phone_layout(width); self.screenshot(f'crew-time-status-move-dropped-{width}.png')
        card.get_by_role('button', name='Start break', exact=True).click()
        self.until(lambda: any('breaks' in body['data'] for body in self.hub_posts), 'the break was sent; nothing waited behind the dropped move')
        expect(card).not_to_contain_text('Your time was not moved')
        self.assertEqual(self.errors, [])

    def test_with_the_switch_off_status_changes_move_no_time_and_show_no_time_line(self):
        self.start(SIZES[1], moves=False)
        self.clock_in()
        expect(self.time_card()).to_contain_text('Location shared once at clock-in.')
        expect(self.page.locator('#status-time')).to_have_count(0)
        self.status_button('Mark en route').click()
        expect(self.page.get_by_role('button', name='Mark arrived', exact=True)).to_be_visible()
        self.status_button('Mark arrived').click()
        expect(self.page.get_by_role('button', name='Start work', exact=True)).to_be_visible()
        self.until(lambda: len(self.field_posts) == 2, 'both statuses were sent')
        self.assertEqual([body for body in self.hub_posts if 'jobAction' in body['data'] or 'crewJobAction' in body['data']], [], 'no time moved, no crew-mates asked')
        self.assertFalse(any('crew-mates' in message for message in self.dialogs))
        self.assertEqual(self.geo(), {'reads':[FIRST],'watches':0,'held':[]})
        self.assertEqual(self.errors, [])

if __name__ == '__main__':
    unittest.main()
