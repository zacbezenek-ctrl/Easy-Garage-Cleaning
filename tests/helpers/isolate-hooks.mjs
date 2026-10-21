// Module resolve hook for helpers/isolates.mjs: a module imported from a functions/ module that carries ?isolate=<name>
// resolves to its own copy of that functions/ module (the same query), so each simulated isolate has its own module
// state (caches, maps) while sharing globalThis (fetch, caches) as Cloudflare isolates share Firestore and the Cache API.
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  const isolate = context.parentURL ? new URL(context.parentURL).searchParams.get('isolate') : null;
  if (!isolate || !resolved.url.startsWith('file:') || !resolved.url.includes('/functions/')) return resolved;
  const url = new URL(resolved.url);
  url.searchParams.set('isolate', isolate);
  return { ...resolved, url: url.href };
}
