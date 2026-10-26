import { scheduleInterval } from './dispatch-time.js';
const text = value => String(value || '').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
const stamp = value => new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
function fold(line) {const rows=[];let current='',bytes=0;for(const char of line){const size=new TextEncoder().encode(char).length;if(bytes+size>73){rows.push(current);current=' ';bytes=1;}current+=char;bytes+=size;}rows.push(current);return rows.join('\r\n');}
export function customerVisitCalendar(job, now) {
  // localInstant rejects both nonexistent spring-forward and ambiguous fall-back
  // wall times. Use UTC events so calendar clients display the same real instant.
  const interval=scheduleInterval(job);
  if(!interval)throw Object.assign(new Error('This visit needs a confirmed start and end time before calendar download.'),{code:'CUSTOMER_VISIT_CALENDAR_UNAVAILABLE',status:409});
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Easy Garage Cleaning//My visits//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-TIMEZONE:America/Denver','BEGIN:VEVENT',`UID:${text(job.jobId)}@easygaragecleaning.com`,`DTSTAMP:${stamp(now)}`,`DTSTART:${stamp(interval.startAt)}`,`DTEND:${stamp(interval.endAt)}`,`SUMMARY:${text(job.service)}`,`LOCATION:${text(job.address)}`,'DESCRIPTION:Times are based on America/Denver. Check My visits for current details.',`STATUS:${job.status==='cancelled'?'CANCELLED':'CONFIRMED'}`,'END:VEVENT','END:VCALENDAR'];
  return lines.map(fold).join('\r\n')+'\r\n';
}
