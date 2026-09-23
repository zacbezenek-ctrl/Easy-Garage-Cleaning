import { galleryPreviewAccess, privateGalleryResponse } from '../_lib/gallery-preview-auth.js';
import { galleryPreviewAssetPaths } from '../_lib/gallery-preview-data.js';

export async function onRequest(context) {
 const denied = await galleryPreviewAccess(context.request,context.env);
 if (denied) return context.request.method === 'HEAD' ? new Response(null,denied) : denied;
 const path = new URL(context.request.url).pathname;
 if (!galleryPreviewAssetPaths.has(path)) return privateGalleryResponse('Not found',404,'text/plain; charset=utf-8');
 // next() serves the checked-in static asset only after authentication and the exact-path allowlist.
 const asset = await context.next();
 const response = privateGalleryResponse(context.request.method === 'HEAD' ? null : asset.body,asset.status,asset.headers.get('Content-Type') || 'application/octet-stream');
 response.headers.delete('Content-Length');
 return response;
}
