import { getHubSession, hasBusinessAccess } from './hub-session.js';

export function privateGalleryResponse(body, status = 200, contentType = 'text/html; charset=utf-8') {
 return new Response(body, { status, headers: {
  'Content-Type': contentType,
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex',
  'Vary': 'Cookie',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
 }});
}

// Authentication happens on the server before any preview markup or image is returned.
// No query-string, client-side flag, shared preview password or unsigned role can bypass it.
export async function galleryPreviewAccess(request, env) {
 if (!['GET','HEAD'].includes(request.method)) return privateGalleryResponse('Method not allowed',405,'text/plain; charset=utf-8');
 let session;
 try { session = await getHubSession(request,env); }
 catch { return privateGalleryResponse('Hub sign-in is temporarily unavailable.',503,'text/plain; charset=utf-8'); }
 if (!session) return privateGalleryResponse('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Sign in required</title><body><h1>Sign in required</h1><p>Sign in to the Employee Hub, then reopen this page.</p><a href="/employee">Open Employee Hub</a></body></html>',401);
 if (!hasBusinessAccess(session) && !['owner','manager'].includes(session.role)) return privateGalleryResponse('Owner or manager access required.',403,'text/plain; charset=utf-8');
 return null;
}
