/* Server extension modules for the business hub. A module (functions/_lib/business-hub-<name>.js) exports any of
   `actions` {name: (ctx, input, helpers)}, `exporters` {name: (ctx, url, helpers) => Response} and `decorate` [(view, ctx, jobs)].
   Property scope: exporters and decorators receive the member's filtered account, but actions receive the FULL account
   (they change it and call save()). An action that returns account rows must filter them with helpers.scoped(ctx) or
   helpers.canSeeProperty(ctx, propertyId), and resolve a property with helpers.property(ctx, id) (403 outside scope).
   save() persists only the stored account object itself: change ctx.account in place, re-read it with
   helpers.store.read('business_accounts', id) (savable with every store, so tests and production agree), or derive a new
   object with copyStoredAccount(ctx.account) from business-hub-service.js, the only public way to make one. A scoped view
   or any {...spread}/clone is refused with 503, and helpers.store.commit (and save()'s extra writes) refuse any
   business_accounts write that is not a stored account, so a module's own commit cannot write a filtered account either.
   Contents are checked too: never remove an entry from properties, requests, projects, messages or members (mark it
   instead, as unlink sets active:false and revoke sets a status). A write missing any id the account held when it was
   read, for example after Object.assign(ctx.account, helpers.scoped(ctx)) or filtering a copy, is refused with 503 and
   nothing is written. A write is committed as a copy taken once, and a write object with a getter is refused.
   Register it with one import line (import * as name from './business-hub-<name>.js';) and one `name,` entry in MODULES;
   functions/api/business-hub.js does not change. createBusinessHandler still rejects built-in and malformed names. */
import * as scope from './business-hub-scope.js';
const MODULES = [
  scope,
];
export function combineBusinessHubModules(modules) {
  const actions = {}, exporters = {}, decorate = [];
  for (const mod of modules) {
    for (const [kind, target, source] of [['action', actions, mod.actions], ['export', exporters, mod.exporters]]) {
      for (const [name, fn] of Object.entries(source || {})) { if (Object.hasOwn(target, name)) throw new TypeError(`Duplicate business hub ${kind}: ${name}`); target[name] = fn; }
    }
    decorate.push(...(mod.decorate || []));
  }
  return Object.freeze({ actions, exports: exporters, decorate });
}
export const businessHubModules = combineBusinessHubModules(MODULES);
