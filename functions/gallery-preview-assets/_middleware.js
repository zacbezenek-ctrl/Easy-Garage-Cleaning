import { galleryPreviewPairs } from '../_lib/gallery-preview-data.js';

// Expose only the explicitly copied fictional test assets, never Hub or customer data.
const paths = new Set([
 '/gallery-preview-assets/gallery.css', '/gallery-preview-assets/public.css', '/gallery-preview-assets/gallery.js',
 ...galleryPreviewPairs.flatMap(pair => [pair.before,pair.after].map(path => path.replace(/^\/internal-gallery-assets\//, '/gallery-preview-assets/')))
]);
export async function onRequest(context) {
 const {request} = context;
 const headers = {'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow, noarchive, noimageindex','X-Content-Type-Options':'nosniff'};
 if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{...headers,Allow:'GET, HEAD'}});
 const path = new URL(request.url).pathname;
 if (!paths.has(path)) return new Response(request.method === 'HEAD' ? null : 'Not found',{status:404,headers});
 const upstream = await context.next();
 const response = new Response(request.method === 'HEAD' ? null : upstream.body,upstream);
 for (const [name,value] of Object.entries(headers)) response.headers.set(name,value);
 return response;
}
