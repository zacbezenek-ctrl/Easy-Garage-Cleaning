import { recordEmailOpen } from '../../_lib/email-tracking.js';

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), c => c.charCodeAt(0));

function pixel() {
  return new Response(GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(GIF.byteLength),
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}

export async function onRequestGet({ request, env, params }) {
  const raw = String(params?.token || '');
  const token = raw.toLowerCase().endsWith('.gif') ? raw.slice(0, -4) : raw;
  try { await recordEmailOpen(env, token, request); } catch {}
  return pixel();
}

export async function onRequestHead() {
  return new Response(null, {
    status: 200,
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' },
  });
}
