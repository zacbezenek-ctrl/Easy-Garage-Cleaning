// Drop-in replacement for node:vm in tests that run browser code in a fresh realm:
//   import vm from './helpers/vm-realm.mjs';
// A new realm gets its own native Date, which the clock-shift preload (shift-clock.mjs) never
// touches, so front-end code in it would keep reading the real clock under the shifted CI job.
// Realms made here (createContext, runInNewContext, Script#runInNewContext) inherit the test
// process's shift. Without the preload they are plain node:vm realms. A sandbox that brings its
// own Date (the host Date or a fixed clock) keeps it.
import nodeVm from 'node:vm';
import { clockShiftOffset, installClockShift } from './clock-shift-core.mjs';

// runInNewContext takes the context's options under different names than createContext.
const CONTEXT_OPTIONS = { contextName: 'name', contextOrigin: 'origin', contextCodeGeneration: 'codeGeneration', microtaskMode: 'microtaskMode' };
function contextOptions(options) {
  const picked = {};
  if (options && typeof options === 'object') for (const [from, to] of Object.entries(CONTEXT_OPTIONS)) if (options[from] !== undefined) picked[to] = options[from];
  return picked;
}

function inheritClockShift(context) {
  const offset = clockShiftOffset();
  if (offset && !Object.prototype.hasOwnProperty.call(context, 'Date')) nodeVm.runInContext(`(${installClockShift})(globalThis, ${offset});`, context);
  return context;
}

export function createContext(sandbox = {}, options) {
  return inheritClockShift(nodeVm.createContext(sandbox, options));
}

export function runInNewContext(code, sandbox = {}, options) {
  return nodeVm.runInContext(code, createContext(sandbox ?? {}, contextOptions(options)), options);
}

export class Script extends nodeVm.Script {
  runInNewContext(sandbox = {}, options) {
    return this.runInContext(createContext(sandbox ?? {}, contextOptions(options)), options);
  }
}

export const { runInContext, runInThisContext, isContext, compileFunction } = nodeVm;
export default { ...nodeVm, Script, createContext, runInNewContext };
