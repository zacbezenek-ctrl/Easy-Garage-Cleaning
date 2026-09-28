/* Server extension modules for the business hub. A module (functions/_lib/business-hub-<name>.js) exports any of
   `actions` {name: (ctx, input, helpers)}, `exporters` {name: (ctx, url, helpers) => Response} and `decorate` [(view, ctx, jobs)].
   Property scope: exporters and decorators receive the member's filtered account, but actions receive the FULL account
   (they change it and call save()). An action that returns account rows must filter them with helpers.scoped(ctx) or
   helpers.canSeeProperty(ctx, propertyId), and resolve a property with helpers.property(ctx, id) (403 outside scope).
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
