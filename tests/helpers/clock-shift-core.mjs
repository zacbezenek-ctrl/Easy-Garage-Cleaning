// Moves one realm's wall clock `offset` milliseconds. The preload (shift-clock.mjs) applies it to
// the test process and vm-realm.mjs applies it inside every vm realm a test creates, by evaluating
// this function's source there. Keep it self-contained: no imports and no module-scope references.
//
// Shifted: Date.now(), new Date(), Date(), `new (date.constructor)()`, the Date.now property
// descriptor, and Intl.DateTimeFormat#format()/#formatToParts() called without a date.
// Exact: every explicit date, Date.parse, Date.UTC and node:test mock timers.
export function installClockShift(global, offset) {
  const marker = Symbol.for('egc.clockShiftMs'), RealDate = global.Date;
  if (!offset || typeof RealDate !== 'function' || global[marker] !== undefined || RealDate[marker] !== undefined) return false;
  const realNow = RealDate.now.bind(RealDate), now = function now() { return realNow() + offset; };
  const ShiftedDate = new Proxy(RealDate, {
    apply: () => new RealDate(now()).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget === ShiftedDate ? target : newTarget),
    get: (target, key, receiver) => key === 'now' ? now : key === marker ? offset : Reflect.get(target, key, receiver),
    getOwnPropertyDescriptor: (target, key) => {
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'now' && own ? { ...own, value: now } : own;
    },
  });
  Object.defineProperty(RealDate.prototype, 'constructor', { value: ShiftedDate, writable: true, configurable: true, enumerable: false });
  const formatProto = global.Intl && global.Intl.DateTimeFormat && global.Intl.DateTimeFormat.prototype;
  const format = formatProto && Object.getOwnPropertyDescriptor(formatProto, 'format');
  if (format && format.get) {
    const shiftedFormats = new WeakMap();
    Object.defineProperty(formatProto, 'format', { ...format, get() {
      const native = format.get.call(this);
      if (!shiftedFormats.has(native)) shiftedFormats.set(native, date => native(date === undefined ? now() : date));
      return shiftedFormats.get(native);
    } });
  }
  if (formatProto && typeof formatProto.formatToParts === 'function') {
    const formatToParts = formatProto.formatToParts;
    const shifted = { formatToParts(date) { return formatToParts.call(this, date === undefined ? now() : date); } }.formatToParts;
    Object.defineProperty(formatProto, 'formatToParts', { value: shifted, writable: true, configurable: true, enumerable: false });
  }
  Object.defineProperty(global, marker, { value: offset, writable: false, configurable: true, enumerable: false });
  Object.defineProperty(global, 'Date', { value: ShiftedDate, writable: true, configurable: true, enumerable: false });
  return true;
}

// The shift the preload applied to this process, in milliseconds (0 when the clock is real).
// Read from the global rather than from Date, so it survives node:test mock timers swapping Date.
export function clockShiftOffset(global = globalThis) {
  return global[Symbol.for('egc.clockShiftMs')] || 0;
}
