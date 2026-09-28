"""Dispatch month grid, time lanes, desktop drag and phone tap-to-assign against a routed fake /api/dispatch; no provider or customer writes."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-22'
ROSTER = [{'id': 'crew.one', 'name': 'Crew One', 'role': 'crew'}, {'id': 'crew.two', 'name': 'Crew Two', 'role': 'crew'}, {'id': 'lead.one', 'name': 'Lead One', 'role': 'crew_lead'}]
def job(**changes):
    row = {'id': 'job-1', 'revision': 'rev-1', 'type': 'job', 'customerId': 'customer-1', 'customer': 'Synthetic Johnson Garage', 'phone': '(970) 555-0100', 'address': '123 Synthetic Way, Fort Collins, CO',
           'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '10:00', 'status': 'scheduled', 'assignedCrew': ['crew.one', 'lead.one'], 'crewLead': 'lead.one', 'crewId': 'crew-main', 'vehicleId': 'truck-1',
           'crewNeeded': 2, 'travelBufferMinutes': 20, 'serviceType': 'Garage cleanout', 'jobInstructions': 'Synthetic scope', 'requiredEquipment': [], 'materials': [], 'syncStatus': 'not_needed'}
    row.update(changes)
    row['startAt'] = row['date']+'T'+row['time']+':00-06:00' if row.get('date') else None
    row['endAt'] = row['endDate']+'T'+row['endTime']+':00-06:00' if row.get('date') else None
    return row
def segment(id, date, time, end, crew, lead=None):
    return {'id': id, 'date': date, 'time': time, 'endDate': date, 'endTime': end, 'startAt': date+'T'+time+':00-06:00', 'endAt': date+'T'+end+':00-06:00', 'assignedCrew': crew, 'crewLead': lead, 'crewId': None, 'vehicleId': None, 'notes': ''}
def split_job():
    return job(id='job-split', revision='split-rev-1', customer='Synthetic Split Garage', endDate='2026-09-24', endTime='12:00', assignedCrew=['crew.one', 'crew.two'], crewLead='crew.one', crewId=None, vehicleId=None,
               assignmentSegments=[segment('s1', DAY, '08:00', '17:00', ['crew.one'], 'crew.one'), segment('s2', DAY, '11:00', '15:00', ['crew.two']), segment('s3', '2026-09-24', '08:00', '12:00', ['crew.two'])])

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = (b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated EGC dispatch calendar test</title>'
                    b'<link rel="stylesheet" href="/employee-dispatch.css"><link rel="stylesheet" href="/employee-dispatch-calendar.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main>'
                    b'<script src="/employee-dispatch.js"></script><script src="/employee-dispatch-calendar.js"></script><script>EGCDispatch.mount(document.querySelector("#host"))</script></body></html>')
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class DispatchCalendarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.errors = []; self.calls = []; self.gets = []; self.completed = {}; self.fail_once = None; self.lost_once = False; self.segments = None; self.viewer = 'manager.one'
        self.hold_get = False; self.held = None; self.read_failure = False
        self.jobs = [job(), job(id='job-2', revision='rev-2', customer='Synthetic Unassigned Garage', time='13:00', endTime='15:00', assignedCrew=[], crewLead=None, crewId=None, vehicleId=None)]
        self.crews = [{'id': 'crew-main', 'revision': 'crew-rev-1', 'name': 'North Crew', 'memberIds': ['crew.one', 'lead.one'], 'leadId': 'lead.one', 'status': 'active'},
                      {'id': 'crew-south', 'revision': 'crew-rev-2', 'name': 'South Crew', 'memberIds': ['crew.two'], 'leadId': 'crew.two', 'status': 'active'}]
        self.availability = []; self.warnings = []
        self.context = None; self.page = None
    def start(self, width=1360, height=950, mobile=False):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', **({'is_mobile': True, 'has_touch': True, 'device_scale_factor': 2} if mobile else {}))
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        self.page.clock.install(time=DAY + 'T18:00:00Z')
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('**/*', self.route)
        self.page.goto(self.url)
        expect(self.page.get_by_role('button', name='Month', exact=True)).to_be_visible()
    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/dispatch': route.continue_(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if req.method == 'GET':
            params = parse_qs(parsed.query); self.gets.append(params)
            if self.read_failure: self.read_failure = False; send({'ok': False, 'code': 'dispatch_unavailable', 'error': 'Dispatch could not complete this request. Keep your changes and retry.'}, 503); return
            first = params['startDate'][0]; last = params['endDate'][0]
            rows = [row for row in self.jobs if not row.get('date') or (row['date'] < last and (row.get('endDate') or row['date']) >= first)]
            if self.hold_get: self.hold_get = False; self.held = (route, first, last); return
            send({'ok': True, 'viewer': {'id': self.viewer}, 'timeZone': 'America/Denver', 'jobs': rows, 'roster': ROSTER, 'crews': self.crews, 'vehicles': [{'id': 'truck-1', 'revision': 't1', 'name': 'Box Truck', 'status': 'available'}],
                  'availability': self.availability, 'warnings': self.warnings, 'coverage': {'complete': True, 'asOf': DAY+'T18:00:00Z'}, 'startDate': first, 'endDate': last, 'arrivalDefaults': {'enabled': False, 'minutes': 60},
                  **({'segments': self.segments} if self.segments else {})}); return
        body = req.post_data_json; self.calls.append(copy.deepcopy(body))
        if self.fail_once:
            status, code, error, details = self.fail_once; self.fail_once = None
            send({'ok': False, 'code': code, 'error': error, 'details': details}, status); return
        if body['requestId'] in self.completed: send({**self.completed[body['requestId']], 'replayed': True}); return
        row = next(row for row in self.jobs if row['id'] == body['jobId'])
        if body['expectedRevision'] != row['revision']: send({'ok': False, 'code': 'dispatch_revision_conflict', 'error': 'Record changed'}, 409); return
        row.update(copy.deepcopy(body['changes'])); row['revision'] += '-next'
        response = {'ok': True, 'requestId': body['requestId'], 'job': row, 'warnings': [], 'providerSync': 'not_needed'}
        self.completed[body['requestId']] = copy.deepcopy(response)
        if self.lost_once: self.lost_once = False; route.abort('connectionfailed'); return
        send(response)
    def settled(self): expect(self.page.get_by_role('button', name='Refresh', exact=True)).to_be_enabled()
    def mode(self, name): self.page.get_by_role('button', name=name, exact=True).click(); self.settled()
    def lane(self, name): return self.page.locator('.dc-lane').filter(has=self.page.locator('.dc-lane-label strong', has_text=re.compile('^'+re.escape(name)+'$')))
    def item(self, lane, customer): return self.lane(lane).locator('.dc-item').filter(has_text=customer)
    def drag(self, source, lane, minute, grab=6):
        expect(source).to_be_visible(); box = source.bounding_box(); track = self.lane(lane).locator('.dc-track').bounding_box()
        x0 = box['x'] + grab; y0 = box['y'] + box['height'] / 2
        x1 = track['x'] + (minute - 360) / 840 * track['width'] + grab; y1 = track['y'] + 26
        self.page.mouse.move(x0, y0); self.page.mouse.down(); self.page.mouse.move(x0 + 20, y0 + 4, steps=3); self.page.mouse.move(x1, y1, steps=8); self.page.mouse.up()
    def closed(self): expect(self.page.get_by_role('dialog')).to_have_count(0)
    # Waits for the quiet reload a closed dialog starts, so it cannot redraw the lanes under the next drag.
    def reloaded(self): self.page.evaluate('EGCDispatch.refresh()'); self.settled()
    def no_null(self, dialog):
        found = dialog.evaluate("(el)=>{const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),out=[];while(walk.nextNode())if(/^\\s*(null|undefined)\\s*$/.test(walk.currentNode.data))out.push(walk.currentNode.parentElement.className);return out;}")
        self.assertEqual(found, [], 'placeholder text nodes in the dialog')
    def no_overflow(self, width): self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width + 1)

    def test_month_grid_navigates_by_month_and_opens_a_day_in_denver_time(self):
        self.segments = {'enabled': True, 'max': 31}; self.jobs.append(split_job()); self.start(); self.mode('Month')
        expect(self.page.get_by_role('heading', name='September 2026', exact=True)).to_be_visible()
        self.assertEqual((self.gets[-1]['startDate'], self.gets[-1]['endDate']), (['2026-08-30'], ['2026-10-04']))
        cells = self.page.locator('.dc-cell'); expect(cells).to_have_count(35)
        # Asia/Tokyo is already on 23 September; the Hub's day is Denver's.
        today = self.page.locator('.dc-cell.dc-now'); expect(today).to_have_count(1); expect(today).to_have_attribute('aria-label', re.compile(r'^Tuesday, September 22: 4 items, 1 unassigned'))
        chips = today.locator('.dc-chip'); expect(chips).to_have_count(3); expect(today.locator('.dc-more')).to_have_text('+1 more')
        expect(today).to_contain_text('8:00 AM Synthetic Split Garage · Crew One')
        self.assertEqual(self.page.locator('.dc-cell[aria-label^="Wednesday, September 23"] .dc-chip').count(), 0)
        expect(self.page.locator('.dc-cell[aria-label^="Thursday, September 24"] .dc-chip')).to_have_text(['8:00 AM Synthetic Split Garage · Crew Two'])
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'dispatch-calendar-month-desktop.png'), full_page=True)
        self.page.set_viewport_size({'width': 375, 'height': 812}); self.no_overflow(375); self.assertGreaterEqual(today.bounding_box()['height'], 44); self.page.screenshot(path=str(out/'dispatch-calendar-month-phone.png'), full_page=True)
        self.page.set_viewport_size({'width': 1360, 'height': 950})
        self.page.get_by_role('button', name='Next period', exact=True).click(); expect(self.page.get_by_role('heading', name='October 2026', exact=True)).to_be_visible(); self.settled()
        self.assertEqual((self.gets[-1]['startDate'], self.gets[-1]['endDate']), (['2026-09-27'], ['2026-11-01']))
        for _ in range(2): self.page.get_by_role('button', name='Previous period', exact=True).click(); self.settled()
        expect(self.page.get_by_role('heading', name='August 2026', exact=True)).to_be_visible(); expect(cells).to_have_count(42)
        self.assertEqual((self.gets[-1]['startDate'], self.gets[-1]['endDate']), (['2026-07-26'], ['2026-09-06']))
        self.page.get_by_role('button', name='Next period', exact=True).click(); expect(self.page.get_by_role('heading', name='September 2026', exact=True)).to_be_visible(); self.settled()
        self.page.locator('.dc-cell[aria-label^="Thursday, September 24"]').click()
        expect(self.page.get_by_role('button', name='Day', exact=True)).to_have_attribute('aria-pressed', 'true'); expect(self.page.get_by_label('Schedule date', exact=True)).to_have_value('2026-09-24')
        self.assertEqual((self.gets[-1]['startDate'], self.gets[-1]['endDate']), (['2026-09-24'], ['2026-09-25'])); self.assertEqual(self.calls, [])

    def test_month_never_draws_the_previous_range_as_the_month(self):
        self.start(); expect(self.page.get_by_role('heading', name='Synthetic Johnson Garage', exact=True)).to_be_visible()
        self.hold_get = True; self.page.get_by_role('button', name='Month', exact=True).click()
        expect(self.page.locator('.dc-skeleton[aria-busy="true"]')).to_be_visible(); expect(self.page.get_by_role('status').filter(has_text='Loading this month')).to_have_count(1); expect(self.page.locator('.dc-cell')).to_have_count(0)
        route, first, last = self.held; self.held = None; self.assertEqual((first, last), ('2026-08-30', '2026-10-04'))
        route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'code': 'dispatch_unavailable', 'error': 'Dispatch could not complete this request. Keep your changes and retry.'}))
        expect(self.page.get_by_role('alert').filter(has_text='The schedule for this month has not loaded')).to_be_visible(); expect(self.page.locator('.dc-cell')).to_have_count(0)
        self.page.get_by_role('button', name='Retry', exact=True).click(); self.settled(); expect(self.page.locator('.dc-cell')).to_have_count(35); expect(self.page.locator('.dc-skeleton')).to_have_count(0)
        self.read_failure = True; self.mode('Lanes')
        expect(self.page.get_by_role('alert').filter(has_text='The schedule for this date has not loaded')).to_be_visible(); expect(self.page.locator('.dc-item')).to_have_count(0)

    def test_lane_drag_changes_time_and_employee_with_one_confirmed_post(self):
        self.start(); self.mode('Lanes'); self.assertEqual((self.gets[-1]['startDate'], self.gets[-1]['endDate']), ([DAY], ['2026-09-23']))
        expect(self.item('Crew One', 'Synthetic Johnson Garage')).to_have_count(1); expect(self.item('Lead One', 'Synthetic Johnson Garage')).to_have_count(1); expect(self.item('Unassigned', 'Synthetic Unassigned Garage')).to_have_count(1)
        self.drag(self.item('Crew One', 'Synthetic Johnson Garage'), 'Crew Two', 600)
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_contain_text('Confirm schedule change')
        expect(dialog).to_contain_text('Crew One · Tue, Sep 22 · 8:00 AM – 10:00 AM'); expect(dialog).to_contain_text('Crew Two · Tue, Sep 22 · 10:00 AM – 12:00 PM'); expect(dialog).to_contain_text('Crew Two, Lead One · lead Lead One')
        self.no_null(dialog); self.assertEqual(self.calls, [])
        dialog.get_by_role('button', name='Save move', exact=True).click(); self.closed()
        self.assertEqual(len(self.calls), 1); write = self.calls[0]
        self.assertEqual((write['action'], write['jobId'], write['expectedRevision']), ('schedule.update', 'job-1', 'rev-1')); self.assertRegex(write['requestId'], r'^[0-9a-f-]{36}$')
        self.assertEqual(write['changes'], {'date': DAY, 'time': '10:00', 'endDate': DAY, 'endTime': '12:00', 'assignedCrew': ['crew.two', 'lead.one'], 'crewLead': 'lead.one', 'crewId': None})
        expect(self.item('Crew Two', 'Synthetic Johnson Garage')).to_contain_text('10:00 AM – 12:00 PM'); expect(self.page.locator('.dp-notice').first).to_contain_text('Schedule updated.')

    def test_crew_lanes_assign_a_saved_crew_and_keep_the_time(self):
        self.start(); self.mode('Lanes'); expect(self.item('Crew One', 'Synthetic Johnson Garage')).to_have_count(1); gets = len(self.gets)
        self.page.get_by_role('button', name='By crew', exact=True).click()
        expect(self.page.get_by_role('button', name='By crew', exact=True)).to_have_attribute('aria-pressed', 'true'); expect(self.item('North Crew', 'Synthetic Johnson Garage')).to_have_count(1)
        # Switching lane rows redraws the loaded schedule without another read.
        self.assertEqual(len(self.gets), gets); self.drag(self.item('Unassigned', 'Synthetic Unassigned Garage'), 'South Crew', 780)
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_contain_text('South Crew · Tue, Sep 22 · 1:00 PM – 3:00 PM')
        dialog.get_by_role('button', name='Save move', exact=True).click(); self.closed()
        self.assertEqual(len(self.calls), 1); self.assertEqual(self.calls[0]['expectedRevision'], 'rev-2')
        self.assertEqual(self.calls[0]['changes'], {'assignedCrew': ['crew.two'], 'crewLead': 'crew.two', 'crewId': 'crew-south'})
        expect(self.item('South Crew', 'Synthetic Unassigned Garage')).to_have_count(1)

    def test_phone_tap_assign_from_the_unassigned_sheet_with_conflict_hints(self):
        self.jobs.append(job(id='job-3', revision='rev-3', customer='Synthetic Overlap Garage', time='12:00', endTime='14:00', assignedCrew=['crew.one'], crewLead='crew.one', crewId=None))
        self.availability = [{'id': 'off-1', 'revision': 'a1', 'employeeId': 'lead.one', 'date': DAY, 'endDate': DAY, 'allDay': True, 'reason': 'Synthetic appointment', 'status': 'active'}]
        self.start(375, 812, mobile=True); self.mode('Lanes'); self.no_overflow(375)
        lanes = self.page.locator('.dc-lane'); expect(lanes.first).to_contain_text('Unassigned')
        target = self.item('Unassigned', 'Synthetic Unassigned Garage')
        for control in [target, self.page.get_by_role('button', name='By crew', exact=True), self.page.get_by_role('button', name='Lanes', exact=True)]: self.assertGreaterEqual(control.bounding_box()['height'], 44)
        target.tap(); sheet = self.page.get_by_role('dialog'); expect(sheet).to_be_visible()
        box = sheet.bounding_box(); self.assertGreaterEqual(box['y'] + box['height'], 811); self.assertLessEqual(box['width'], 375)
        busy = sheet.get_by_role('button', name=re.compile('^Crew One')); expect(busy).to_contain_text('Busy 12:00 PM – 2:00 PM · Synthetic Overlap Garage'); expect(busy).to_have_class(re.compile('dc-option-warn'))
        expect(sheet.get_by_role('button', name=re.compile('^Lead One'))).to_contain_text('Unavailable all day · Synthetic appointment')
        free = sheet.get_by_role('button', name=re.compile('^Crew Two')); expect(free).to_contain_text('Free on the loaded schedule')
        expect(sheet.get_by_role('link', name='Open job', exact=True)).to_have_attribute('href', '/crew/job.html?jobId=job-2')
        for control in [busy, free, sheet.get_by_role('button', name=re.compile('^South Crew'))]: self.assertGreaterEqual(control.bounding_box()['height'], 44)
        self.no_overflow(375); self.assertLessEqual(sheet.evaluate('(el)=>el.scrollWidth'), sheet.evaluate('(el)=>el.clientWidth') + 1); self.no_null(sheet)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'dispatch-calendar-sheet-phone.png'))
        free.tap(); self.closed()
        self.assertEqual(len(self.calls), 1); write = self.calls[0]
        self.assertEqual((write['action'], write['jobId'], write['expectedRevision']), ('schedule.update', 'job-2', 'rev-2'))
        self.assertEqual(write['changes'], {'assignedCrew': ['crew.two'], 'crewLead': 'crew.two', 'crewId': None})
        expect(self.item('Crew Two', 'Synthetic Unassigned Garage')).to_have_count(1); expect(self.page.locator('.dc-lane').first).not_to_contain_text('Unassigned')
        self.page.screenshot(path=str(out/'dispatch-calendar-lanes-phone.png'), full_page=True)

    def test_a_refresh_during_a_drag_ends_it_and_the_next_drag_confirms_its_own_job(self):
        self.jobs.append(job(id='job-o', revision='rev-o', customer='Synthetic Other Garage', time='15:00', endTime='16:00', assignedCrew=['crew.two'], crewLead='crew.two', crewId=None))
        self.start(); self.mode('Lanes'); gets = len(self.gets)
        box = self.item('Crew One', 'Synthetic Johnson Garage').bounding_box(); x0 = box['x'] + 6; y0 = box['y'] + box['height'] / 2
        self.page.mouse.move(x0, y0); self.page.mouse.down(); self.page.mouse.move(x0 + 60, y0 + 4, steps=4)
        expect(self.page.locator('.dc-dragging')).to_have_count(1); expect(self.page.locator('.dc-preview')).to_have_count(1)
        # The 60-second background refresh redraws the lanes under the pointer.
        self.page.evaluate('EGCDispatch.refresh({quiet:true})'); self.assertEqual(len(self.gets), gets + 1)
        expect(self.page.locator('.dc-status')).to_have_text('The schedule refreshed during the drag, so nothing was moved. Drag the job again.')
        expect(self.page.locator('.dc-dragging')).to_have_count(0); expect(self.page.locator('.dc-preview')).to_have_count(0); expect(self.page.locator('.dc-drop-target')).to_have_count(0)
        self.page.mouse.move(4, 4, steps=4); self.page.mouse.up(); self.closed(); self.assertEqual(self.calls, [])
        # The next click opens that job's own sheet, not a confirm for the abandoned drag.
        self.item('Unassigned', 'Synthetic Unassigned Garage').click(); sheet = self.page.get_by_role('dialog')
        expect(sheet.get_by_role('heading', name='Synthetic Unassigned Garage', exact=True)).to_be_visible(); expect(sheet).not_to_contain_text('Confirm schedule change'); expect(sheet).not_to_contain_text('Synthetic Johnson Garage')
        sheet.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.assertEqual(self.calls, []); self.reloaded()
        self.drag(self.item('Crew Two', 'Synthetic Other Garage'), 'Crew One', 960)
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_contain_text('Confirm schedule change'); expect(dialog).to_contain_text('Synthetic Other Garage'); expect(dialog).not_to_contain_text('Synthetic Johnson Garage')
        expect(dialog).to_contain_text('Crew One · Tue, Sep 22 · 4:00 PM – 5:00 PM'); self.no_null(dialog)
        dialog.get_by_role('button', name='Save move', exact=True).click(); self.closed()
        self.assertEqual(len(self.calls), 1); self.assertEqual((self.calls[0]['jobId'], self.calls[0]['expectedRevision']), ('job-o', 'rev-o'))
        self.assertEqual(self.calls[0]['changes'], {'date': DAY, 'time': '16:00', 'endDate': DAY, 'endTime': '17:00', 'assignedCrew': ['crew.one'], 'crewLead': 'crew.one', 'crewId': None})
        self.assertEqual(self.jobs[0]['time'], '08:00')

    def test_mouse_drag_is_off_on_the_phone_width_agenda(self):
        self.start(600, 900); self.mode('Lanes'); self.lane('Crew One').evaluate("(el)=>el.scrollIntoView({block:'start'})")
        box = self.item('Crew One', 'Synthetic Johnson Garage').bounding_box(); x0 = box['x'] + 6; y0 = box['y'] + box['height'] / 2
        self.assertEqual(self.page.evaluate(f'document.elementFromPoint({x0},{y0})?.closest(".dc-item")?.dataset.dcItem'), 'job-1')
        # The stacked agenda has no time axis, so a mouse drag there cannot mean a time.
        track = self.lane('Crew Two').locator('.dc-track').bounding_box()
        self.page.mouse.move(x0, y0); self.page.mouse.down(); self.page.mouse.move(track['x'] + track['width'] - 12, track['y'] + 12, steps=8)
        expect(self.page.locator('.dc-dragging')).to_have_count(0); expect(self.page.locator('.dc-preview')).to_have_count(0); expect(self.page.locator('.dc-drop-target')).to_have_count(0)
        self.page.mouse.up(); self.closed(); self.assertEqual(self.calls, [])
        self.item('Crew One', 'Synthetic Johnson Garage').click(); sheet = self.page.get_by_role('dialog')
        expect(sheet.get_by_role('heading', name='Synthetic Johnson Garage', exact=True)).to_be_visible(); expect(sheet.get_by_role('button', name=re.compile('^Crew Two'))).to_be_visible()
        sheet.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.reloaded()
        # On the timeline layout the same drag reviews a move.
        self.page.set_viewport_size({'width': 1024, 'height': 900}); self.lane('Unassigned').evaluate("(el)=>el.scrollIntoView({block:'start'})"); self.drag(self.item('Crew One', 'Synthetic Johnson Garage'), 'Crew Two', 600)
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_contain_text('Crew Two · Tue, Sep 22 · 10:00 AM – 12:00 PM')
        dialog.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.assertEqual(self.calls, [])

    def test_sheets_without_saved_crews_or_editing_show_no_placeholder_text(self):
        self.crews = [{**self.crews[1], 'status': 'inactive'}]
        self.jobs.append(job(id='job-done', revision='rev-done', customer='Synthetic Finished Garage', time='16:00', endTime='17:00', status='completed', assignedCrew=['crew.two'], crewLead='crew.two', crewId=None))
        self.start(); self.mode('Lanes')
        self.item('Unassigned', 'Synthetic Unassigned Garage').click(); sheet = self.page.get_by_role('dialog')
        expect(sheet.get_by_role('button', name=re.compile('^Crew Two'))).to_be_visible(); expect(sheet.get_by_role('group', name='Saved crews')).to_have_count(0); self.no_null(sheet)
        sheet.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.reloaded()
        self.page.get_by_label('Filter by status').select_option('completed')
        self.item('Crew Two', 'Synthetic Finished Garage').click(); sheet = self.page.get_by_role('dialog')
        expect(sheet).to_contain_text('Completed and cancelled work keeps its schedule history.'); expect(sheet.get_by_role('button', name='Edit / assign', exact=True)).to_have_count(0)
        expect(sheet.locator('.dp-dialog-foot > *')).to_have_count(2); self.no_null(sheet)
        sheet.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.assertEqual(self.calls, [])

    def test_phone_conflict_is_surfaced_and_another_choice_uses_a_new_request(self):
        self.start(375, 812, mobile=True); self.mode('Lanes'); self.item('Unassigned', 'Synthetic Unassigned Garage').tap(); sheet = self.page.get_by_role('dialog')
        self.fail_once = (409, 'dispatch_conflict', 'Overlap', {'conflicts': [{'code': 'employee_overlap', 'employeeId': 'crew.one', 'message': 'Crew One is assigned to another job from 13:00 to 15:00.'}]})
        sheet.get_by_role('button', name=re.compile('^Crew One')).tap(); expect(sheet.get_by_role('alert')).to_contain_text('Crew One is assigned to another job')
        expect(sheet.get_by_role('button', name=re.compile('^Crew Two'))).to_be_enabled(); self.assertIsNone(self.page.evaluate("sessionStorage.getItem('egc.dispatch.pending.v1.manager.one')"))
        sheet.get_by_role('button', name=re.compile('^Crew Two')).tap(); self.closed()
        self.assertEqual(len(self.calls), 2); self.assertNotEqual(self.calls[0]['requestId'], self.calls[1]['requestId']); self.assertEqual(self.calls[1]['changes']['assignedCrew'], ['crew.two'])

    def test_lost_move_response_is_retried_with_the_same_request_id(self):
        self.start(); self.mode('Lanes'); self.drag(self.item('Crew One', 'Synthetic Johnson Garage'), 'Crew One', 540)
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_contain_text('Crew One · Tue, Sep 22 · 9:00 AM – 11:00 AM')
        self.lost_once = True; dialog.get_by_role('button', name='Save move', exact=True).click()
        retry = dialog.get_by_role('button', name='Retry original save', exact=True); expect(retry).to_be_visible()
        self.assertEqual(self.calls[0]['changes'], {'date': DAY, 'time': '09:00', 'endDate': DAY, 'endTime': '11:00'})
        self.assertIsNotNone(self.page.evaluate("sessionStorage.getItem('egc.dispatch.pending.v1.manager.one')"))
        retry.click(); self.closed(); self.assertEqual(len(self.calls), 2); self.assertEqual(self.calls[0], self.calls[1])
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('egc.dispatch.pending.v1.manager.one')")); self.assertEqual(self.jobs[0]['time'], '09:00')

    def test_lost_tap_assign_survives_reload_and_recovers_the_same_request(self):
        self.start(375, 812, mobile=True); self.mode('Lanes'); self.item('Unassigned', 'Synthetic Unassigned Garage').tap(); sheet = self.page.get_by_role('dialog')
        self.lost_once = True; sheet.get_by_role('button', name=re.compile('^Crew Two')).tap(); expect(sheet.get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        # A different choice cannot replace the unverified request.
        sheet.get_by_role('button', name=re.compile('^Crew One')).tap(); expect(sheet.get_by_role('alert')).to_contain_text('unknown outcome'); self.assertEqual(len(self.calls), 1)
        original = copy.deepcopy(self.calls[0]); self.page.reload(); self.settled(); self.page.get_by_role('button', name='Review unverified save', exact=True).tap()
        recovery = self.page.get_by_role('dialog'); expect(recovery).to_contain_text('Crew Two'); recovery.get_by_role('button', name='Retry original save', exact=True).tap(); self.closed()
        self.assertEqual(self.calls[-1], original); self.assertEqual(len(self.calls), 2); self.assertEqual(self.jobs[1]['assignedCrew'], ['crew.two'])

    def test_segments_render_per_segment_and_a_drag_moves_only_that_segment(self):
        self.jobs = [split_job()]; self.start(); self.mode('Lanes')
        expect(self.item('Crew One', 'Synthetic Split Garage')).to_contain_text('8:00 AM – 5:00 PM'); expect(self.item('Crew Two', 'Synthetic Split Garage')).to_contain_text('11:00 AM – 3:00 PM')
        expect(self.item('Crew Two', 'Synthetic Split Garage')).to_contain_text('Crew segment')
        self.drag(self.item('Crew Two', 'Synthetic Split Garage'), 'Lead One', 600); self.closed()
        expect(self.page.locator('.dc-status')).to_contain_text('Crew segments are turned off'); self.assertEqual(self.calls, [])
        self.segments = {'enabled': True, 'max': 31}; self.page.get_by_role('button', name='Refresh', exact=True).click(); expect(self.page.get_by_role('button', name='Refresh', exact=True)).to_be_enabled()
        self.drag(self.item('Crew Two', 'Synthetic Split Garage'), 'Lead One', 600)
        dialog = self.page.get_by_role('dialog'); expect(dialog).to_contain_text('crew segment'); expect(dialog).to_contain_text('Lead One · Tue, Sep 22 · 10:00 AM – 2:00 PM')
        dialog.get_by_role('button', name='Save move', exact=True).click(); self.closed()
        changes = self.calls[-1]['changes']; self.assertEqual(list(changes), ['assignmentSegments'])
        self.assertEqual(changes['assignmentSegments'], [
            {'id': 's1', 'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '17:00', 'assignedCrew': ['crew.one'], 'crewLead': 'crew.one', 'vehicleId': None, 'notes': ''},
            {'id': 's2', 'date': DAY, 'time': '10:00', 'endDate': DAY, 'endTime': '14:00', 'assignedCrew': ['lead.one'], 'crewLead': None, 'vehicleId': None, 'notes': ''},
            {'id': 's3', 'date': '2026-09-24', 'time': '08:00', 'endDate': '2026-09-24', 'endTime': '12:00', 'assignedCrew': ['crew.two'], 'crewLead': None, 'vehicleId': None, 'notes': ''}])

    def test_availability_shading_company_blocks_and_travel_gaps(self):
        self.jobs.append(job(id='job-4', revision='rev-4', customer='Synthetic Close Garage', address='9 Other St, Loveland, CO', time='10:10', endTime='11:00', assignedCrew=['crew.one'], crewLead='crew.one', crewId=None))
        self.jobs.append({'id': 'block-1', 'revision': 'b1', 'type': 'blocked', 'title': 'Synthetic training', 'date': DAY, 'time': '17:00', 'endDate': DAY, 'endTime': '18:00', 'status': 'scheduled', 'assignedCrew': []})
        self.availability = [{'id': 'off-2', 'revision': 'a2', 'employeeId': 'crew.one', 'date': DAY, 'endDate': DAY, 'allDay': False, 'time': '15:00', 'endTime': '16:30', 'reason': 'Synthetic dentist', 'status': 'active'}]
        self.jobs.append(job(id='job-bad', revision='rev-bad', customer='Synthetic Broken Times', time='11:00', endTime='09:00', assignedCrew=['crew.two'], crewLead='crew.two', crewId=None))
        self.start(); self.mode('Lanes'); crew_one = self.lane('Crew One')
        expect(self.page.get_by_role('alert').filter(has_text='1 job on this date has saved times that need review')).to_be_visible(); expect(self.page.locator('.dc-item').filter(has_text='Synthetic Broken Times')).to_have_count(0)
        expect(crew_one.locator('.dc-shade.dc-unavailable')).to_contain_text('3:00 PM – 4:30 PM · Unavailable · Synthetic dentist')
        expect(crew_one.locator('.dc-shade.dc-blocked')).to_contain_text('Company time block · Synthetic training'); expect(self.lane('Crew Two').locator('.dc-shade.dc-blocked')).to_have_count(1)
        gap = crew_one.locator('.dc-gap'); expect(gap).to_have_count(1); expect(gap).to_have_class(re.compile('dc-gap-short')); expect(gap).to_have_attribute('title', 'Only 10 min between stops · needs 20')
        expect(crew_one.locator('.dc-lane-label small')).to_have_text('2 jobs · 2.8 hr')
        shade = crew_one.locator('.dc-shade.dc-unavailable').bounding_box(); track = crew_one.locator('.dc-track').bounding_box()
        self.assertAlmostEqual(shade['x'] - track['x'], (900 - 360) / 840 * track['width'], delta=3); self.assertAlmostEqual(shade['width'], 90 / 840 * track['width'], delta=3)
        out = ROOT/'test-results'; out.mkdir(exist_ok=True); self.page.screenshot(path=str(out/'dispatch-calendar-lanes-desktop.png'), full_page=True)
        self.page.set_viewport_size({'width': 375, 'height': 812}); expect(crew_one.locator('.dc-gap')).to_contain_text('Only 10 min between stops'); self.no_overflow(375)
        texts = crew_one.locator('.dc-track > *').evaluate_all('(nodes)=>nodes.map(node=>node.className.split(" ")[0])')
        self.assertEqual(texts, ['dc-item', 'dc-gap', 'dc-item', 'dc-shade', 'dc-shade'])

    def test_no_horizontal_overflow_and_untrusted_text_stays_text(self):
        self.segments = {'enabled': True, 'max': 31}; self.jobs += [split_job(), job(id='job-x', revision='rev-x', customer='<img src=x onerror="window.injected=true">', time='18:30', endTime='21:00', assignedCrew=['crew.two'], crewLead='crew.two', crewId=None)]
        self.start()
        for width in [1360, 390, 375, 320]:
            self.page.set_viewport_size({'width': width, 'height': 850})
            self.mode('Month'); expect(self.page.locator('.dc-cell')).to_have_count(35); self.no_overflow(width)
            self.mode('Lanes'); expect(self.lane('Crew Two')).to_be_visible(); self.no_overflow(width)
            self.page.get_by_role('button', name='By crew', exact=True).click(); expect(self.page.get_by_role('button', name='By crew', exact=True)).to_have_attribute('aria-pressed', 'true'); self.no_overflow(width)
            self.page.get_by_role('button', name='By employee', exact=True).click()
        self.item('Crew Two', 'onerror').click(); sheet = self.page.get_by_role('dialog'); expect(sheet).to_be_visible(); self.no_overflow(320)
        self.assertLessEqual(sheet.evaluate('(el)=>el.scrollWidth'), sheet.evaluate('(el)=>el.clientWidth') + 1)
        self.assertEqual(self.page.locator('img').count(), 0); self.assertIsNone(self.page.evaluate('window.injected'))
        sheet.get_by_role('button', name='Back', exact=True).click(); self.closed(); self.assertEqual(self.calls, [])

if __name__ == '__main__': unittest.main(verbosity=2)
