import { register } from 'node:module';

// Simulated Cloudflare isolates for tests: isolate(name, path) imports a functions/ module (path relative to the repo
// root, e.g. 'functions/api/employee-hub.js') with every functions/ module it reaches loaded fresh for that name.
register(new URL('./isolate-hooks.mjs', import.meta.url));
const ROOT = new URL('../../', import.meta.url);

export const isolate = (name, path) => import(`${new URL(path, ROOT).href}?isolate=${encodeURIComponent(name)}`);
