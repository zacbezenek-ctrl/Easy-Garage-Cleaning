// A fake HighLevel (services.leadconnectorhq.com only) that records every request as {method, path, search, headers,
// body} in order, for request-log assertions (GHL-TRACK-1). `fail(call)` may return a status to answer a request with.
export function recordingHighLevel({ fail = () => 0 } = {}) {
  const calls = [], json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const contacts = { 'contact-1': { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid' }, 'contact-new': { id: 'contact-new', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid' } };
  async function fetcher(url, options = {}) {
    const parsed = new URL(String(url));
    if (parsed.hostname !== 'services.leadconnectorhq.com') throw new Error(`External host refused: ${parsed.hostname}`);
    const method = options.method || 'GET', path = parsed.pathname;
    const call = { method, path, search: parsed.search, headers: Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key, String(value)])), body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    const status = fail(call);
    if (status) return json({ message: 'Synthetic HighLevel failure' }, status);
    if (path === '/contacts/upsert') return json({ contact: { id: 'contact-new' } });
    let match = /^\/contacts\/([^/]+)$/.exec(path);
    if (match) return contacts[match[1]] ? json({ contact: contacts[match[1]] }) : json({}, 404);
    if (/^\/contacts\/[^/]+\/tags$/.test(path)) return json({ tags: [] });
    if (/^\/contacts\/[^/]+\/notes$/.test(path)) return json({ note: { id: `note-${calls.length}` } });
    if (/^\/contacts\/[^/]+\/tasks$/.test(path)) return json({ task: { id: `task-${calls.length}` } });
    if (path === '/calendars/events') return json({ events: [] });
    if (path === '/calendars/events/appointments') return json({ id: `appt-${calls.length}` });
    match = /^\/calendars\/events\/appointments\/([^/]+)$/.exec(path);
    if (match && method === 'GET') return json({ appointment: { id: match[1], calendarId: 'cal-walk', title: 'EGC Free Walkthrough', startTime: '2026-09-25T15:00:00.000Z', endTime: '2026-09-25T16:00:00.000Z', address: '1 Synthetic Way' } });
    if (match) return json({ id: match[1] });
    if (path === '/opportunities/search') return json({ opportunities: [], meta: { total: 0 } });
    if (path === '/opportunities/upsert') return json({ opportunity: { id: 'opp-1' } });
    return json({}, 404);
  }
  const writes = () => calls.filter(call => call.method !== 'GET');
  return { calls, fetcher, writes, lines: () => calls.map(call => `${call.method} ${call.path}`), tags: () => calls.filter(call => /\/tags$/.test(call.path)) };
}
