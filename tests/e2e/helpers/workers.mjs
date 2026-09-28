// EGC_E2E_WORKERS for the Playwright config: an integer count or a percentage
// of CPU cores (default 50%). Playwright rejects a numeric string, so integers
// become numbers; anything else fails with a readable message.
export function e2eWorkers(value=process.env.EGC_E2E_WORKERS){
 const text=String(value??'').trim();
 if(!text)return '50%';
 if(/^[1-9]\d*$/.test(text))return Number(text);
 if(/^(?:100|[1-9]\d?)%$/.test(text))return text;
 throw new Error(`EGC_E2E_WORKERS must be a positive integer or a percentage such as 50%, not ${JSON.stringify(value)}.`);
}
