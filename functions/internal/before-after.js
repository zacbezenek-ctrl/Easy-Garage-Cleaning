import { galleryPreviewAccess, privateGalleryResponse } from '../_lib/gallery-preview-auth.js';
import { renderGalleryPreview } from '../_lib/gallery-preview-view.js';

export async function onRequest({ request, env }) {
 const denied = await galleryPreviewAccess(request,env);
 if (denied) return request.method === 'HEAD' ? new Response(null,denied) : denied;
 return privateGalleryResponse(request.method === 'HEAD' ? null : renderGalleryPreview());
}
