/* Public estimator only. Never import authenticated crew or owner pricing. */
export const PUBLIC_LOAD_PRICING = Object.freeze({
  currency: 'USD',
  // Owner-approved public prices in cents for 1/8 ... 8/8 loads, or null.
  // Leave unset until the public schedule and actual truck capacity are approved.
  tierCents: null,
  capacityCubicYards: null,
});
export function estimateLoad(step, config = PUBLIC_LOAD_PRICING) {
  const value = Number(step);
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new RangeError('Choose 1–8 eighths of a truck');
  const tiers = config.tierCents;
  const valid = Array.isArray(tiers) && tiers.length === 8 && tiers.every((price, i) => Number.isSafeInteger(price) && price > 0 && (!i || price >= tiers[i - 1]));
  const capacity = config.capacityCubicYards;
  return { fraction: value / 8, percent: value * 12.5, cents: valid ? tiers[value - 1] : null,
    cubicYards: Number.isFinite(capacity) && capacity > 0 ? capacity * value / 8 : null,
    label: ['⅛ truck', '¼ truck', '⅜ truck', '½ truck', '⅝ truck', '¾ truck', '⅞ truck', 'Full truck'][value - 1] };
}
export function mountEstimator(root, config = PUBLIC_LOAD_PRICING) {
  const slider = root.querySelector('[data-load-slider]');
  const label = root.querySelector('[data-load-label]');
  const price = root.querySelector('[data-load-price]');
  const detail = root.querySelector('[data-load-detail]');
  if (!slider || !label || !price || !detail) return;
  function update() {
    const result = estimateLoad(slider.value, config);
    root.style.setProperty('--load-fill', `${result.percent}%`);
    root.querySelectorAll('[data-load-segment]').forEach(segment => segment.classList.toggle('is-filled', Number(segment.dataset.loadSegment) <= Number(slider.value)));
    root.querySelectorAll('[data-load-step]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.loadStep) === Number(slider.value))));
    label.textContent = `${result.label} · ${result.percent}%`;
    slider.setAttribute('aria-valuetext', `${result.label}, ${result.percent} percent of truck space`);
    price.textContent = result.cents === null ? 'Get an on-site quote' : new Intl.NumberFormat('en-US', { style: 'currency', currency: config.currency || 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(result.cents / 100);
    detail.textContent = result.cents === null ? 'Visual guide only. Your exact price is confirmed at a free walkthrough.' : 'Planning estimate for junk removal only. We confirm contents, weight and access, then agree on the exact price before work begins.';
    if (result.cubicYards !== null) detail.textContent += ` Approximately ${Number(result.cubicYards.toFixed(2))} cubic yards.`;
  }
  slider.addEventListener('input', update);
  root.querySelectorAll('[data-load-step]').forEach(button => button.addEventListener('click', () => { slider.value = button.dataset.loadStep; update(); }));
  update();
  root.querySelector('[data-load-controls]').hidden = false;
}
if (typeof document !== 'undefined') document.querySelectorAll('[data-load-estimator]').forEach(root => mountEstimator(root));
