// The walkthrough price tables crew/gameplan.html now fetches from /api/pricing-config
// (PRICE-SCRUB). Tests that run the page's own recommend()/estimatedJobMinutes() give
// the page exactly what the server serves: the same builder over the shipped catalog.
import { readFileSync } from 'node:fs';
import { walkthroughPricing } from '../../functions/_lib/pricing-config.js';

export const garageCatalog = () => JSON.parse(readFileSync(new URL('../../functions/_data/garage-catalog.json', import.meta.url), 'utf8'));
export const WALKTHROUGH_PRICING = walkthroughPricing(garageCatalog());
// A fresh plain copy per page, as the browser receives it from JSON.
export const servedPricing = () => JSON.parse(JSON.stringify(WALKTHROUGH_PRICING));
